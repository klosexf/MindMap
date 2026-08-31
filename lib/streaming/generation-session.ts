/**
 * 实时生成会话（模块级单例）。
 *
 * 职责：发起 /api/generate SSE 流并在组件生命周期之外持续消费；
 * 首个 skeleton 事件建立 treeId 会话；node 事件经节拍调度器批量回放到
 * mindmap-store；complete 以服务端终树自愈覆盖。
 *
 * 关键约束（见 docs/superpowers/specs/2026-08-30-realtime-generation-design.md）：
 * - 会话树权威：session.workingTree 是唯一权威副本，store 仅在
 *   store.tree.id === session.treeId 时接收写入（异 id 守卫）。
 * - error 事件为非终态通知，继续消费直至 complete 或流关闭。
 * - 多次 skeleton：首个建立会话，后续为树替换信号（清空播放队列）。
 */

import { consumeSSEStream } from '@/lib/streaming/sse';
import type { MindMapTree, NormalizedDocument, TreePatch } from '@/lib/types/mindmap';
import { applyTreePatch, findNode } from '@/lib/utils/tree';
import { useGenerationStore, type GenerationStatus } from '@/store/generation-store';
import { useMindMapStore } from '@/store/mindmap-store';

/** 节拍回放的合并窗口（毫秒）：每窗口至多一批 patch → 单次 tree 变化 → 单次渲染 */
export const PLAYBACK_WINDOW_MS = 120;
/** 积压加速的批量上限 */
export const MAX_BATCH_SIZE = 8;
/** 触发加速的积压阈值 */
const BACKLOG_THRESHOLD = 20;

/** 依积压量计算本窗口批量：正常 1 个/窗口，积压后线性加速到上限 */
export function computeBatchSize(queueLength: number): number {
  if (queueLength <= BACKLOG_THRESHOLD) return 1;
  const overload = queueLength - BACKLOG_THRESHOLD;
  return Math.min(MAX_BATCH_SIZE, 1 + Math.ceil(overload / 10));
}

/** 终态收尾排空的期望总时长：无论积压多少，逐个排空约 2 秒完成 */
const FINAL_DRAIN_TARGET_MS = 2000;
/** 终态排空单拍节拍上限：小队列放慢到肉眼可感知的逐个生长 */
const FINAL_DRAIN_MAX_MS = 350;

/**
 * 终态（done 后）排空节拍：按队列长度自适应，让「逐个生长」肉眼可见。
 * 小队列放慢（6 节点 ≈ 333ms/个，全程 ~2s）；大队列加速到普通窗口下限
 * （44 节点 = 120ms/个，全程 ~5s），避免大树收尾等待过久。
 */
export function computeDrainWindowMs(queueLength: number): number {
  const ideal = FINAL_DRAIN_TARGET_MS / Math.max(queueLength, 1);
  return Math.min(Math.max(ideal, PLAYBACK_WINDOW_MS), FINAL_DRAIN_MAX_MS);
}

interface SessionRuntime {
  sessionId: string;
  /** 本会话的回放调度窗口（测试可注入） */
  windowMs: number;
  treeId: string | null;
  workingTree: MindMapTree | null;
  queue: TreePatch[];
  paused: boolean;
  /** 流已到 complete / 已停止 / 已终态 */
  done: boolean;
  /** 用户停止或错误终态：调度器不再推进（区别于 done——done 后仍需排空积压） */
  stopped: boolean;
  /** complete 树已到达，回放队列排空后以终树收尾（保证逐个生长观感） */
  pendingCompleteTree: MindMapTree | null;
  abortController: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  /** 会话开始后首包（首个 skeleton）回调句柄 */
  firstSkeleton: {
    resolve: (treeId: string) => void;
    reject: (err: Error) => void;
  } | null;
}

let currentRuntime: SessionRuntime | null = null;
let sessionSeq = 0;

const generationStore = () => useGenerationStore;
const mindmapStore = () => useMindMapStore;

function isTerminalStatus(status: GenerationStatus): boolean {
  return status === 'completed' || status === 'stopped' || status === 'error' || status === 'idle';
}

function clearTimer(rt: SessionRuntime): void {
  if (rt.timer !== null) {
    clearTimeout(rt.timer);
    rt.timer = null;
  }
}

/** 异 id 守卫：store 当前树是否归属本会话 */
function storeMatchesSession(rt: SessionRuntime): boolean {
  return mindmapStore().getState().tree?.id === rt.treeId;
}

/** 把一批 patch 应用到会话工作树（幂等守卫），返回实际应用数 */
function applyBatchToWorkingTree(rt: SessionRuntime, batch: TreePatch[]): number {
  let applied = 0;
  for (const patch of batch) {
    if (!rt.workingTree) break;
    if (patch.type === 'add' && findNode(rt.workingTree.root, patch.nodeId)) continue;
    rt.workingTree = applyTreePatch(rt.workingTree, patch);
    applied += 1;
  }
  return applied;
}

function applyBatch(rt: SessionRuntime, batch: TreePatch[]): void {
  const applied = applyBatchToWorkingTree(rt, batch);
  if (applied === 0) return;

  // 异 id 守卫：用户正在浏览/编辑别的导图时不碰 store，仅更新工作树
  if (storeMatchesSession(rt)) {
    mindmapStore().getState().applyAiGenerationPatches(batch);
  }

  const store = generationStore().getState();
  store.update({ nodesApplied: store.nodesApplied + applied });
}

/** complete 收尾：以服务端终树自愈覆盖（store 归属本会话时），转入 completed */
function finalizeComplete(rt: SessionRuntime, tree: MindMapTree): void {
  rt.queue = [];
  rt.pendingCompleteTree = null;
  clearTimer(rt);
  rt.workingTree = tree;
  if (storeMatchesSession(rt)) {
    mindmapStore().getState().setTree(tree);
    // partial→final 节点 id 不复用：重置选中态，避免指向已消失的节点
    mindmapStore().getState().setSelectedNode(null);
  }
  generationStore().getState().update({
    status: 'completed',
    phase: 'done',
    lastEventAt: Date.now(),
  });
}

/** 本拍调度延迟：流式期间用会话窗口跟流；终态排空用自适应节拍（逐个生长肉眼可见） */
function nextWindowMs(rt: SessionRuntime, windowMs: number): number {
  if (rt.done && rt.queue.length > 0) return computeDrainWindowMs(rt.queue.length);
  return windowMs;
}

function scheduleTick(rt: SessionRuntime, windowMs: number): void {
  clearTimer(rt);
  rt.timer = setTimeout(() => {
    rt.timer = null;
    const status = generationStore().getState().status;
    if (rt.stopped || rt.paused || status !== 'streaming') return;
    if (rt.queue.length > 0) {
      const size = computeBatchSize(rt.queue.length);
      applyBatch(rt, rt.queue.splice(0, size));
    }
    // 队列排空且 complete 树已到：以终树收尾（自愈覆盖回放内容）
    if (rt.pendingCompleteTree && rt.queue.length === 0) {
      finalizeComplete(rt, rt.pendingCompleteTree);
      return;
    }
    scheduleTick(rt, windowMs);
  }, nextWindowMs(rt, windowMs));
}

function handleEvent(rt: SessionRuntime, eventType: string, data: any, windowMs: number): void {
  const genStore = generationStore().getState();
  const now = Date.now();

  if (eventType === 'warning') {
    genStore.update({ warning: data?.message ?? '生成首包等待较久，系统仍在处理中。', lastEventAt: now });
    return;
  }

  if (eventType === 'error') {
    // 非终态通知：记录并继续消费（error 后通常跟 complete 降级）
    genStore.update({ errorMessage: data?.message || '生成阶段出现错误', lastEventAt: now });
    return;
  }

  if (eventType === 'skeleton') {
    const tree = data?.tree as MindMapTree | undefined;
    if (!tree) return;

    if (!rt.treeId) {
      // 首个 skeleton：建立会话身份，通知表单跳转
      rt.treeId = tree.id;
      rt.workingTree = tree;
      generationStore().getState().setSession({
        sessionId: rt.sessionId,
        treeId: tree.id,
        startedAt: rt.startedAt,
      });
      scheduleTick(rt, windowMs);
      rt.firstSkeleton?.resolve(tree.id);
      rt.firstSkeleton = null;
      return;
    }

    // 后续 skeleton：树替换信号。清空基于旧树的待放 patch，重置计数。
    rt.queue = [];
    rt.workingTree = tree;
    generationStore().getState().update({
      phase: 'skeleton',
      nodesReceived: 0,
      nodesApplied: 0,
      lastEventAt: now,
    });
    if (storeMatchesSession(rt)) {
      mindmapStore().getState().setTree(tree);
      mindmapStore().getState().setSelectedNode(null);
    }
    return;
  }

  if (eventType === 'node') {
    const patch = data?.patch as TreePatch | undefined;
    if (!patch) return;
    const store = generationStore().getState();
    store.update({
      phase: 'nodes',
      nodesReceived: store.nodesReceived + 1,
      lastEventAt: now,
    });
    rt.queue.push(patch);
    return;
  }

  if (eventType === 'complete') {
    const tree = data?.tree as MindMapTree | undefined;
    if (!tree) return;
    // 完整性自愈：最终以服务端终树覆盖。若回放队列仍有积压（非流式
    // provider 一口气下发 node+complete），先按节拍排空队列——保留
    // 「节点逐个生长」观感——再以终树收尾。
    rt.done = true;
    if (rt.queue.length > 0 && rt.treeId) {
      // 关键：延迟落地时不提前覆盖工作树——排空的 add patch 若在终树上
      // 执行，会全部命中幂等守卫而静默跳过，store 在排空期间零更新，
      // 画布只能瞬间跳变而非逐个生长。工作树保持回放态，终树由
      // finalizeComplete / finalizeStop 落地。
      rt.pendingCompleteTree = tree;
      if (!rt.paused) {
        scheduleTick(rt, rt.windowMs);
      }
      return;
    }
    rt.workingTree = tree;
    finalizeComplete(rt, tree);
  }
}

async function finalizeStop(rt: SessionRuntime, status: GenerationStatus, note?: string): Promise<void> {
  rt.done = true;
  rt.stopped = true;
  clearTimer(rt);
  rt.abortController?.abort();

  // complete 已到但排空未完：保存终树（完整结果）；否则保存当前部分回放树
  const treeToSave = rt.pendingCompleteTree ?? rt.workingTree;
  rt.pendingCompleteTree = null;
  rt.queue = [];

  // 保存部分树（treeId 尚未建立则无从保存）
  if (rt.treeId && treeToSave) {
    try {
      await fetch(`/api/mindmaps/${rt.treeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree: treeToSave }),
      });
    } catch {
      // 保存失败不阻断状态流转；已落盘的骨架版本仍在
    }
  }

  if (currentRuntime === rt) {
    generationStore().getState().update({ status, ...(note ? { errorMessage: note } : {}) });
  }
}

async function runSession(rt: SessionRuntime, doc: NormalizedDocument, windowMs: number): Promise<void> {
  rt.abortController = new AbortController();

  let response: Response;
  try {
    response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedDocument: doc }),
      signal: rt.abortController.signal,
    });
  } catch (err) {
    if (rt.done) return; // 主动停止触发的 abort
    rt.firstSkeleton?.reject(err instanceof Error ? err : new Error('生成请求失败'));
    rt.firstSkeleton = null;
    await finalizeStop(rt, 'error');
    return;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = (body as { error?: string }).error || `生成接口调用失败 (HTTP ${response.status})`;
    rt.firstSkeleton?.reject(new Error(message));
    rt.firstSkeleton = null;
    await finalizeStop(rt, 'error', message);
    return;
  }

  try {
    for await (const event of consumeSSEStream(response)) {
      if (rt.done) break;
      handleEvent(rt, event.type, event.data, windowMs);
    }
    // 流关闭且未见 complete → error 终态（保留已回放内容）
    if (!rt.done && currentRuntime === rt) {
      rt.firstSkeleton?.reject(new Error('生成流意外中断，未收到完整导图数据'));
      rt.firstSkeleton = null;
      await finalizeStop(rt, 'error');
    }
  } catch (err) {
    if (rt.done) return; // stop 触发的 abort
    rt.firstSkeleton?.reject(err instanceof Error ? err : new Error('生成流读取失败'));
    rt.firstSkeleton = null;
    await finalizeStop(rt, 'error');
  }
}

export interface StartGenerationOptions {
  /** 调度窗口（测试注入用），默认 PLAYBACK_WINDOW_MS */
  playbackWindowMs?: number;
}

export interface StartGenerationHandle {
  /** 首个 skeleton 到达时 resolve(treeId)；在此之前失败则 reject */
  firstSkeleton: Promise<string>;
}

/**
 * 启动一次实时生成会话。若已有活跃会话，先按「停止」语义收尾旧会话
 * （abort + 保存部分树）再开新会话。
 */
export function startGeneration(doc: NormalizedDocument, options: StartGenerationOptions = {}): StartGenerationHandle {
  const windowMs = options.playbackWindowMs ?? PLAYBACK_WINDOW_MS;

  if (currentRuntime && !isTerminalStatus(generationStore().getState().status)) {
    // 会话取代：与「停止」相同的收尾，异步执行不阻塞新会话启动
    void finalizeStop(currentRuntime, 'stopped');
  }

  sessionSeq += 1;
  const rt: SessionRuntime = {
    sessionId: `gen-${Date.now()}-${sessionSeq}`,
    windowMs,
    treeId: null,
    workingTree: null,
    queue: [],
    paused: false,
    done: false,
    stopped: false,
    pendingCompleteTree: null,
    abortController: null,
    timer: null,
    startedAt: Date.now(),
    firstSkeleton: null,
  };
  currentRuntime = rt;

  generationStore().getState().reset();

  const firstSkeleton = new Promise<string>((resolve, reject) => {
    rt.firstSkeleton = { resolve, reject };
  });

  void runSession(rt, doc, windowMs);

  return { firstSkeleton };
}

/** 暂停：停止回放，事件继续入队（连接不断）；complete 已到但积压未排空时也可暂停 */
export function pauseGeneration(): void {
  const rt = currentRuntime;
  if (!rt || rt.stopped) return;
  if (rt.done && !rt.pendingCompleteTree) return; // 已完整收尾
  rt.paused = true;
  generationStore().getState().update({ status: 'paused' });
}

/** 恢复：继续调度回放（积压由 computeBatchSize 自然加速排空，complete 积压同样排空后收尾） */
export function resumeGeneration(): void {
  const rt = currentRuntime;
  if (!rt || rt.stopped || !rt.paused) return;
  rt.paused = false;
  generationStore().getState().update({ status: 'streaming' });
  scheduleTick(rt, rt.windowMs);
}

/** 硬停止：断开 SSE 流并保存当前部分树（complete 已到时工作树即终树，保存完整结果） */
export async function stopGeneration(): Promise<void> {
  const rt = currentRuntime;
  if (!rt || rt.stopped || (rt.done && !rt.pendingCompleteTree)) return;
  rt.firstSkeleton?.reject(new Error('已停止生成'));
  rt.firstSkeleton = null;
  await finalizeStop(rt, 'stopped');
}

/** 当前活跃会话信息（供 UI 判断是否处于生成中） */
export function getActiveGeneration(): { sessionId: string; treeId: string; status: GenerationStatus } | null {
  const rt = currentRuntime;
  if (!rt || !rt.treeId) return null;
  const status = generationStore().getState().status;
  return { sessionId: rt.sessionId, treeId: rt.treeId, status };
}

/**
 * EditorPage 领养会话工作树：活跃会话（非终态）且 id 匹配时返回全量工作树，
 * 调用方以此 setTree 跳过 loadTree（避免服务端骨架覆盖已回放节点）。
 */
export function adoptSessionTree(treeId: string): MindMapTree | null {
  const rt = currentRuntime;
  if (!rt || rt.treeId !== treeId || !rt.workingTree) return null;
  const status = generationStore().getState().status;
  if (status !== 'streaming' && status !== 'paused') return null;
  return rt.workingTree;
}

/** 测试专用：重置模块单例状态 */
export function __resetGenerationSessionForTest(): void {
  if (currentRuntime) {
    clearTimer(currentRuntime);
    currentRuntime.abortController?.abort();
  }
  currentRuntime = null;
  generationStore().getState().reset();
}
