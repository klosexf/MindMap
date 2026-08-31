/**
 * AI 分支扩展（智能生成子主题）流式会话（模块级单例）。
 *
 * 消费 /api/expand SSE：child 事件进入回放队列，逐节点「打字机」式写入
 * mindmap-store（经 applyAiGenerationPatches 直写，不入 undo 历史）；
 * done 事件以服务端权威 children 对账（补齐 / 修正 / 删除）；全部落位后
 * 一次性提交撤销快照（commitHistorySnapshot），整体保持单步可撤销。
 *
 * 与 generation-session 的区别：作用于用户当前浏览的既有树，保留选中态
 * 与 undo 历史线；回放节奏为「每节点打字机」而非「补丁节拍窗口」。
 *
 * 关键约束：
 * - 异树守卫：store 当前树与会话树 id 不一致时跳过写入（用户已切换导图）。
 * - 会话取代：新会话启动时旧会话未完成 → 立即落位剩余队列并结算。
 */

import { consumeSSEStream } from '@/lib/streaming/sse';
import type { MindMapTree, NormalizedDocument, SourceReference, TreePatch } from '@/lib/types/mindmap';
import { createNode, findNode } from '@/lib/utils/tree';
import { useMindMapStore } from '@/store/mindmap-store';

/** 打字机步进间隔（毫秒） */
export const TYPE_TICK_MS = 32;

/**
 * 依内容长度与积压量计算每个 tick 的出字数。
 * 常态约 22 tick（≈700ms）呈现完整子主题；队列积压时逐步加速，
 * 避免流已结束而回放迟迟追不上。
 */
export function computeTypingChunkSize(contentLength: number, backlog: number): number {
  const ticks = backlog >= 6 ? 3 : backlog >= 3 ? 8 : 22;
  return Math.max(1, Math.ceil(contentLength / ticks));
}

interface SessionCallbacks {
  /** 已创建的子主题数量（打字机开始时递增） */
  onProgress?: (appliedCount: number) => void;
  /** 当前打字机节点变化（null = 无进行中的打字） */
  onTypingNode?: (nodeId: string | null) => void;
}

export interface StartBranchExpansionInput {
  tree: MindMapTree;
  nodeId: string;
  normalizedDocument?: NormalizedDocument;
  onProgress?: (appliedCount: number) => void;
  onTypingNode?: (nodeId: string | null) => void;
}

export interface BranchExpansionResult {
  /** 实际创建并保留的子节点数 */
  count: number;
}

interface ExpandRuntime {
  sessionId: string;
  treeId: string;
  parentId: string;
  sourceRef: SourceReference;
  undoSnapshot: { tree: MindMapTree; selectedNodeId: string | null };
  callbacks: SessionCallbacks;
  abortController: AbortController | null;
  /** 待回放的子主题（完整内容） */
  queue: string[];
  /** 正在打字的节点 */
  active: { nodeId: string; content: string; revealed: number } | null;
  /** 已创建节点（对账与撤销计数用） */
  createdNodes: Array<{ nodeId: string; content: string }>;
  appliedCount: number;
  finalChildren: string[] | null;
  streamDone: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (result: BranchExpansionResult) => void;
  reject: (err: Error) => void;
}

let currentRuntime: ExpandRuntime | null = null;
let sessionSeq = 0;

const mindmapStore = () => useMindMapStore;

function sourceRefFromTree(tree: MindMapTree): SourceReference {
  return {
    type: tree.meta.sourceType,
    location: tree.meta.sourceFileName,
    url: tree.meta.sourceUrl,
  } as SourceReference;
}

function clearTimer(rt: ExpandRuntime): void {
  if (rt.timer !== null) {
    clearTimeout(rt.timer);
    rt.timer = null;
  }
}

/** 异树守卫：store 当前树归属本会话才写入 */
function applyPatchesToStore(rt: ExpandRuntime, patches: TreePatch[]): void {
  const store = mindmapStore().getState();
  if (!store.tree || store.tree.id !== rt.treeId || patches.length === 0) return;
  store.applyAiGenerationPatches(patches);
}

/** 在父节点下构建 add 补丁（内容可部分显示，打字机逐步补全）；树已切换返回 null */
function buildChildAddPatch(rt: ExpandRuntime, content: string, visibleContent: string): TreePatch | null {
  const store = mindmapStore().getState();
  const liveTree = store.tree && store.tree.id === rt.treeId ? store.tree : null;
  const parent = liveTree ? findNode(liveTree.root, rt.parentId) : null;
  if (!liveTree || !parent) return null;

  const node = createNode(content, rt.sourceRef, 'ai');
  return {
    type: 'add',
    nodeId: node.id,
    parentId: rt.parentId,
    index: parent.children?.length ?? 0,
    node: { ...node, content: visibleContent },
    timestamp: Date.now(),
  };
}

function ensureTicking(rt: ExpandRuntime): void {
  if (rt.settled || rt.timer !== null) return;
  rt.timer = setTimeout(() => {
    rt.timer = null;
    tick(rt);
  }, TYPE_TICK_MS);
}

/** 打字机回放步进：推进当前节点出字 / 开启下一个子主题节点 */
function tick(rt: ExpandRuntime): void {
  if (rt.settled) return;

  if (rt.active) {
    const chunk = computeTypingChunkSize(rt.active.content.length, rt.queue.length);
    const revealed = Math.min(rt.active.revealed + chunk, rt.active.content.length);
    if (revealed !== rt.active.revealed) {
      rt.active.revealed = revealed;
      applyPatchesToStore(rt, [
        {
          type: 'update',
          nodeId: rt.active.nodeId,
          node: { content: rt.active.content.slice(0, revealed) },
          timestamp: Date.now(),
        },
      ]);
    }
    if (revealed >= rt.active.content.length) {
      rt.active = null;
      rt.callbacks.onTypingNode?.(null);
    }
  }

  if (!rt.active && rt.queue.length > 0) {
    const content = (rt.queue.shift() as string).trim().slice(0, 120);
    if (content) {
      const chunk = computeTypingChunkSize(content.length, rt.queue.length);
      const patch = buildChildAddPatch(rt, content, content.slice(0, chunk));
      if (patch) {
        applyPatchesToStore(rt, [patch]);
        rt.createdNodes.push({ nodeId: patch.nodeId, content });
        rt.appliedCount += 1;
        rt.callbacks.onProgress?.(rt.appliedCount);
        rt.active = { nodeId: patch.nodeId, content, revealed: chunk };
        rt.callbacks.onTypingNode?.(patch.nodeId);
      }
    } else {
      // 空内容丢弃后继续处理后续队列
      ensureTicking(rt);
      return;
    }
  }

  if (rt.active || rt.queue.length > 0) {
    ensureTicking(rt);
    return;
  }

  if (rt.streamDone) {
    finalize(rt);
  }
  // 流未结束且暂无待放内容：等待下一个 SSE 事件触发 ensureTicking
}

/** 终态：与服务端权威 children 对账后提交撤销快照并结算 Promise */
function finalize(rt: ExpandRuntime, error?: Error): void {
  if (rt.settled) return;
  rt.settled = true;
  clearTimer(rt);
  // 仅失败路径中止连接：正常完成后 abort 会令浏览器记一条 ERR_ABORTED 噪音
  if (error) rt.abortController?.abort();

  const final = rt.finalChildren;
  if (final) {
    const patches: TreePatch[] = [];
    for (let i = 0; i < rt.createdNodes.length; i += 1) {
      const created = rt.createdNodes[i];
      const target = final[i];
      if (target === undefined) {
        // 增量提取超发（终态解析被裁剪）：删除多余节点
        patches.push({ type: 'delete', nodeId: created.nodeId, timestamp: Date.now() });
      } else if (created.content !== target) {
        // 增量提取的原文与服务端终态（trim/截断/兜底）不一致：以服务端为准
        patches.push({ type: 'update', nodeId: created.nodeId, node: { content: target }, timestamp: Date.now() });
      }
    }
    applyPatchesToStore(rt, patches);
  }

  rt.active = null;
  rt.callbacks.onTypingNode?.(null);

  const store = mindmapStore().getState();
  if (rt.appliedCount > 0) {
    store.commitHistorySnapshot(rt.undoSnapshot);
  }

  if (currentRuntime === rt) {
    currentRuntime = null;
  }

  if (error) {
    rt.reject(error);
  } else {
    rt.resolve({ count: rt.appliedCount });
  }
}

/** 旧会话立即结算：剩余队列一次性落位（完整内容），不做对账 */
function flushActiveExpansion(): void {
  const rt = currentRuntime;
  if (!rt || rt.settled) return;

  const patches: TreePatch[] = [];
  if (rt.active && rt.active.revealed < rt.active.content.length) {
    patches.push({
      type: 'update',
      nodeId: rt.active.nodeId,
      node: { content: rt.active.content },
      timestamp: Date.now(),
    });
    rt.active = null;
  }
  for (const content of rt.queue) {
    const cleaned = content.trim().slice(0, 120);
    if (!cleaned) continue;
    const patch = buildChildAddPatch(rt, cleaned, cleaned);
    if (patch) {
      patches.push(patch);
      rt.createdNodes.push({ nodeId: patch.nodeId, content: cleaned });
      rt.appliedCount += 1;
    }
  }
  rt.queue = [];
  applyPatchesToStore(rt, patches);
  rt.streamDone = true;
  // 旧会话的 SSE 读取循环仍可能挂起在 reader.read() 上，abort 促其退出
  rt.abortController?.abort();
  finalize(rt);
}

async function runSession(rt: ExpandRuntime, input: StartBranchExpansionInput): Promise<void> {
  rt.abortController = new AbortController();

  let response: Response;
  try {
    response = await fetch('/api/expand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tree: input.tree,
        nodeId: rt.parentId,
        normalizedDocument: input.normalizedDocument,
      }),
      signal: rt.abortController.signal,
    });
  } catch (err) {
    finalize(rt, err instanceof Error ? err : new Error('AI 扩展请求失败'));
    return;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    finalize(rt, new Error(body.error || `AI 扩展失败 (HTTP ${response.status})`));
    return;
  }

  try {
    for await (const event of consumeSSEStream(response)) {
      if (rt.settled) break;

      if (event.type === 'child' && typeof event.data?.content === 'string') {
        rt.queue.push(event.data.content);
        ensureTicking(rt);
      } else if (event.type === 'done') {
        rt.streamDone = true;
        const children = Array.isArray(event.data?.children)
          ? (event.data.children as unknown[]).filter((item): item is string => typeof item === 'string')
          : [];
        rt.finalChildren = children;
        // SSE 未逐个推送的差额（对象格式输出 / 启发式兜底）补进队列回放；
        // 超发部分裁掉，避免创建后又被对账删除
        const totalPlanned = rt.createdNodes.length + rt.queue.length;
        if (totalPlanned > children.length) {
          rt.queue = rt.queue.slice(0, Math.max(0, children.length - rt.createdNodes.length));
        } else if (totalPlanned < children.length) {
          for (let i = totalPlanned; i < children.length; i += 1) {
            rt.queue.push(children[i]);
          }
        }
        ensureTicking(rt);
      } else if (event.type === 'error') {
        // 已回放内容保留（快照可撤销）；未回放丢弃，错误上抛提示
        rt.queue = [];
        rt.streamDone = true;
        finalize(rt, new Error(event.data?.message || 'AI 扩展失败'));
        return;
      }
    }
    // 流关闭
    if (!rt.settled) {
      rt.streamDone = true;
      ensureTicking(rt);
    }
  } catch (err) {
    if (rt.settled) return; // flush/replace 触发的 abort
    rt.queue = [];
    finalize(rt, err instanceof Error ? err : new Error('AI 扩展流读取失败'));
  }
}

/**
 * 启动一次分支扩展流式会话。
 * 返回的 Promise 在全部子主题打字机落位 + 对账 + 撤销快照提交后 resolve；
 * 失败（网络 / SSE error）时 reject，已回放内容保留且单步可撤销。
 * 若已有活跃会话，先立即结算旧会话（剩余内容一次性落位）。
 */
export function startBranchExpansion(input: StartBranchExpansionInput): Promise<BranchExpansionResult> {
  flushActiveExpansion();

  sessionSeq += 1;
  const store = mindmapStore().getState();
  const rt: ExpandRuntime = {
    sessionId: `expand-${Date.now()}-${sessionSeq}`,
    treeId: input.tree.id,
    parentId: input.nodeId,
    sourceRef: sourceRefFromTree(input.tree),
    undoSnapshot: {
      tree: store.tree && store.tree.id === input.tree.id ? store.tree : input.tree,
      selectedNodeId: store.selectedNodeId,
    },
    callbacks: {
      onProgress: input.onProgress,
      onTypingNode: input.onTypingNode,
    },
    abortController: null,
    queue: [],
    active: null,
    createdNodes: [],
    appliedCount: 0,
    finalChildren: null,
    streamDone: false,
    settled: false,
    timer: null,
    resolve: () => {},
    reject: () => {},
  };
  currentRuntime = rt;

  const promise = new Promise<BranchExpansionResult>((resolve, reject) => {
    rt.resolve = resolve;
    rt.reject = reject;
  });

  void runSession(rt, input);
  return promise;
}

/** 测试专用：重置模块单例状态 */
export function __resetBranchExpansionSessionForTest(): void {
  if (currentRuntime) {
    clearTimer(currentRuntime);
    currentRuntime.abortController?.abort();
  }
  currentRuntime = null;
}
