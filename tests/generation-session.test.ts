import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_BATCH_SIZE,
  PLAYBACK_WINDOW_MS,
  __resetGenerationSessionForTest,
  adoptSessionTree,
  computeBatchSize,
  computeDrainWindowMs,
  getActiveGeneration,
  pauseGeneration,
  resumeGeneration,
  startGeneration,
  stopGeneration,
} from '../lib/streaming/generation-session';
import { consumeSSEStream } from '../lib/streaming/sse';
import type { MindMapNode, MindMapTree, NormalizedDocument, TreePatch } from '../lib/types/mindmap';
import { findNode } from '../lib/utils/tree';
import { useGenerationStore } from '../store/generation-store';
import { useMindMapStore } from '../store/mindmap-store';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeNode(id: string, content: string, children: MindMapNode[] = []): MindMapNode {
  return {
    id,
    content,
    collapsed: false,
    children,
    meta: {
      sourceRef: { type: 'text', text: content },
      createdAt: Date.now(),
      createdBy: 'ai',
      type: 'detail',
    },
  };
}

function makeTree(id: string, children: MindMapNode[] = []): MindMapTree {
  const now = Date.now();
  return {
    id,
    root: makeNode('root', 'Root', children),
    meta: {
      sourceType: 'text',
      title: 'demo',
      createdAt: now,
      updatedAt: now,
      version: 1,
      truncated: false,
    },
  };
}

function addPatch(parentId: string, node: MindMapNode): TreePatch {
  return { type: 'add', nodeId: node.id, parentId, index: 0, node, timestamp: Date.now() };
}

const demoDoc: NormalizedDocument = {
  markdown: '# Demo\n\nParagraph one. Paragraph two.',
  chunks: [
    {
      id: 'chunk_1',
      text: 'Paragraph one. Paragraph two.',
      tokenEstimate: 12,
      sourceRef: { type: 'text', text: 'Paragraph one.' },
    },
  ],
  sourceMeta: { type: 'text', title: 'Demo' },
};

interface SSEFetchMock {
  fetchMock: ReturnType<typeof vi.fn>;
  emit: (type: string, data: unknown) => void;
  end: () => void;
  patchCalls: Array<{ url: string; body: { tree?: MindMapTree } }>;
}

/** fetch mock：POST /api/generate 返回可手动推送的 SSE 流；PATCH 记录调用 */
function createSSEFetchMock(): SSEFetchMock {
  const patchCalls: Array<{ url: string; body: { tree?: MindMapTree } }> = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === 'PATCH') {
      patchCalls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return {
    fetchMock,
    emit: (type, data) => {
      const controller = controllers[controllers.length - 1];
      controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    end: () => {
      controllers[controllers.length - 1].close();
    },
    patchCalls,
  };
}

function resetMindMapStore(): void {
  useMindMapStore.setState({
    tree: null,
    selectedNodeId: null,
    pending: false,
    layoutDirection: 'LR',
    past: [],
    future: [],
    canUndo: false,
    canRedo: false,
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}

async function collectEvents(response: Response) {
  const events: Array<{ type: string; data: any }> = [];
  for await (const event of consumeSSEStream(response)) events.push(event);
  return events;
}

let mock: SSEFetchMock;

beforeEach(() => {
  mock = createSSEFetchMock();
  vi.stubGlobal('fetch', mock.fetchMock);
  __resetGenerationSessionForTest();
  resetMindMapStore();
});

afterEach(() => {
  __resetGenerationSessionForTest();
  vi.unstubAllGlobals();
  resetMindMapStore();
});

describe('consumeSSEStream', () => {
  it('parses events split across chunk boundaries (分片)', async () => {
    const response = sseResponse(['event: node\nda', 'ta: {"patch":1}\n\n']);
    const events = await collectEvents(response);
    expect(events).toEqual([{ type: 'node', data: { patch: 1 } }]);
  });

  it('parses multiple events arriving in one chunk (粘包)', async () => {
    const response = sseResponse(['event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\n']);
    const events = await collectEvents(response);
    expect(events.map((e) => e.type)).toEqual(['a', 'b']);
    expect(events[1].data).toEqual({ y: 2 });
  });

  it('skips frames with invalid JSON without breaking the stream (坏 JSON)', async () => {
    const response = sseResponse(['event: node\ndata: {broken\n\n', 'event: node\ndata: {"ok":true}\n\n']);
    const events = await collectEvents(response);
    expect(events).toEqual([{ type: 'node', data: { ok: true } }]);
  });
});

describe('computeBatchSize', () => {
  it('returns 1 per window at or below the backlog threshold', () => {
    expect(computeBatchSize(0)).toBe(1);
    expect(computeBatchSize(1)).toBe(1);
    expect(computeBatchSize(20)).toBe(1);
  });

  it('accelerates linearly with backlog and caps at MAX_BATCH_SIZE', () => {
    expect(computeBatchSize(21)).toBe(2);
    expect(computeBatchSize(30)).toBe(2);
    expect(computeBatchSize(31)).toBe(3);
    expect(computeBatchSize(51)).toBe(5);
    expect(computeBatchSize(81)).toBe(MAX_BATCH_SIZE);
    expect(computeBatchSize(500)).toBe(MAX_BATCH_SIZE);
  });
});

describe('computeDrainWindowMs（终态排空自适应节拍）', () => {
  it('小队列放慢到可感知节拍（上限 350ms），总时长约 2s', () => {
    expect(computeDrainWindowMs(1)).toBe(350);
    expect(computeDrainWindowMs(2)).toBe(350);
    expect(computeDrainWindowMs(6)).toBeCloseTo(2000 / 6, 0);
  });

  it('大队列压缩到普通窗口下限，避免大树收尾等待过久', () => {
    expect(computeDrainWindowMs(16)).toBeCloseTo(2000 / 16, 0);
    expect(computeDrainWindowMs(44)).toBe(PLAYBACK_WINDOW_MS);
    expect(computeDrainWindowMs(500)).toBe(PLAYBACK_WINDOW_MS);
  });
});

describe('generation session', () => {
  it('first skeleton establishes the session and resolves firstSkeleton', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await expect(handle.firstSkeleton).resolves.toBe('tree-1');

    const gen = useGenerationStore.getState();
    expect(gen.treeId).toBe('tree-1');
    expect(gen.status).toBe('streaming');
    expect(getActiveGeneration()?.treeId).toBe('tree-1');
    expect(adoptSessionTree('tree-1')?.id).toBe('tree-1');

    mock.emit('complete', { tree: makeTree('tree-1') });
    await delay(30);
    expect(useGenerationStore.getState().status).toBe('completed');
  });

  it('replays node patches to the store and self-heals with the final tree on complete', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;
    // 模拟编辑器领养会话树
    useMindMapStore.getState().setTree(tree);

    mock.emit('node', { patch: addPatch('root', makeNode('n1', '分支一')) });
    mock.emit('node', { patch: addPatch('root', makeNode('n2', '分支二')) });
    await delay(150);

    const store = useMindMapStore.getState();
    expect(findNode(store.tree!.root, 'n1')).toBeTruthy();
    expect(findNode(store.tree!.root, 'n2')).toBeTruthy();
    expect(useGenerationStore.getState().nodesApplied).toBe(2);

    const finalTree = makeTree('tree-1', [makeNode('f1', '终态分支')]);
    mock.emit('complete', { tree: finalTree });
    await delay(30);

    expect(useGenerationStore.getState().status).toBe('completed');
    const finalStore = useMindMapStore.getState();
    expect(finalStore.tree!.root.children?.map((c) => c.id)).toEqual(['f1']);
    expect(finalStore.selectedNodeId).toBeNull();
  });

  it('pauses playback, buffers events, and drains the queue on resume', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;
    useMindMapStore.getState().setTree(tree);

    pauseGeneration();
    expect(useGenerationStore.getState().status).toBe('paused');

    mock.emit('node', { patch: addPatch('root', makeNode('n1', '分支一')) });
    mock.emit('node', { patch: addPatch('root', makeNode('n2', '分支二')) });
    mock.emit('node', { patch: addPatch('root', makeNode('n3', '分支三')) });
    await delay(80);

    // 暂停期：事件入队但不回放
    expect(useGenerationStore.getState().nodesReceived).toBe(3);
    expect(useGenerationStore.getState().nodesApplied).toBe(0);
    expect(useMindMapStore.getState().tree!.root.children).toHaveLength(0);

    resumeGeneration();
    expect(useGenerationStore.getState().status).toBe('streaming');
    await delay(200);

    expect(useGenerationStore.getState().nodesApplied).toBe(3);
    expect(useMindMapStore.getState().tree!.root.children).toHaveLength(3);

    mock.emit('complete', { tree: makeTree('tree-1') });
    await delay(30);
    expect(useGenerationStore.getState().status).toBe('completed');
  });

  it('self-heals with the final tree when complete arrives while paused', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;
    useMindMapStore.getState().setTree(tree);

    pauseGeneration();
    mock.emit('node', { patch: addPatch('root', makeNode('n1', '排队节点')) });

    const finalTree = makeTree('tree-1', [makeNode('f1', '终态分支')]);
    mock.emit('complete', { tree: finalTree });
    await delay(30);

    // 暂停中 complete 到达且队列积压：等待回放排空，保持 paused 不立即收尾
    expect(useGenerationStore.getState().status).toBe('paused');

    resumeGeneration();
    // 终态排空节拍放慢（1 节点 ≈ 350ms）：等待逐个回放 + 终树收尾
    await delay(600);

    const gen = useGenerationStore.getState();
    expect(gen.status).toBe('completed');
    // 排队节点先逐个回放，终树最终自愈覆盖
    expect(useMindMapStore.getState().tree!.root.children?.map((c) => c.id)).toEqual(['f1']);
  });

  it('drains the backlog node-by-node before applying the final tree when node+complete arrive together (非流式路径)', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 20 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;
    useMindMapStore.getState().setTree(tree);

    // 模拟非流式 provider：node 事件与 complete 一口气到达
    mock.emit('node', { patch: addPatch('root', makeNode('n1', '分支一')) });
    mock.emit('node', { patch: addPatch('root', makeNode('n2', '分支二')) });
    mock.emit('node', { patch: addPatch('root', makeNode('n3', '分支三')) });
    mock.emit('complete', { tree: makeTree('tree-1', [makeNode('f1', '终态分支')]) });
    await delay(30);

    // 未到一个调度周期排空：仍在 streaming，节点逐个回放中（而非瞬间全树）
    expect(useGenerationStore.getState().status).toBe('streaming');
    expect(useGenerationStore.getState().nodesApplied).toBeLessThan(3);

    // 终态排空节拍：3 节点 × ~350ms ≈ 1.05s + 收尾拍
    await delay(1500);
    expect(useGenerationStore.getState().status).toBe('completed');
    // 回归守卫：排空期间 patch 必须真正应用到 store（若 complete 提前
    // 覆盖工作树，幂等守卫会跳过一切，nodesApplied 恒为 0）
    expect(useGenerationStore.getState().nodesApplied).toBe(3);
    // 终树自愈覆盖
    expect(useMindMapStore.getState().tree!.root.children?.map((c) => c.id)).toEqual(['f1']);
  });

  it('treats error events as non-terminal and completes after an error→complete sequence', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;
    useMindMapStore.getState().setTree(tree);

    mock.emit('error', { message: 'LLM 降级，切换启发式' });
    mock.emit('node', { patch: addPatch('root', makeNode('n1', '分支一')) });
    await delay(80);

    // error 非终态：回放继续
    expect(useGenerationStore.getState().status).toBe('streaming');
    expect(useGenerationStore.getState().errorMessage).toBe('LLM 降级，切换启发式');
    expect(findNode(useMindMapStore.getState().tree!.root, 'n1')).toBeTruthy();

    mock.emit('complete', { tree: makeTree('tree-1') });
    await delay(30);
    expect(useGenerationStore.getState().status).toBe('completed');
  });

  it('records warning events without changing status', async () => {
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('warning', { message: '首包等待较久' });
    await delay(20);

    const gen = useGenerationStore.getState();
    expect(gen.warning).toBe('首包等待较久');
    expect(gen.status).toBe('idle'); // skeleton 未到，会话尚未建立

    mock.emit('skeleton', { tree: makeTree('tree-1') });
    await handle.firstSkeleton;
    mock.emit('complete', { tree: makeTree('tree-1') });
    await delay(30);
  });

  it('only the first skeleton establishes identity; later skeletons swap the tree and clear the queue', async () => {
    const treeV1 = makeTree('tree-1', [makeNode('c1', '旧分支')]);
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree: treeV1 });
    await expect(handle.firstSkeleton).resolves.toBe('tree-1');
    useMindMapStore.getState().setTree(treeV1);

    // 暂停让 node patch 停留在队列中
    pauseGeneration();
    mock.emit('node', { patch: addPatch('root', makeNode('n1', '旧树节点')) });
    await delay(30);
    expect(useGenerationStore.getState().nodesReceived).toBe(1);

    // 第二个 skeleton：树替换信号（同会话 id），清空旧树待放 patch 并重置计数
    const treeV2 = makeTree('tree-1', [makeNode('s1', '新骨架分支')]);
    mock.emit('skeleton', { tree: treeV2 });
    await delay(30);

    const gen = useGenerationStore.getState();
    expect(gen.nodesReceived).toBe(0);
    expect(gen.nodesApplied).toBe(0);
    // store 已被替换为 V2 骨架
    expect(useMindMapStore.getState().tree!.root.children?.map((c) => c.id)).toEqual(['s1']);

    const finalTree = makeTree('tree-1', [makeNode('f1', '终态分支')]);
    mock.emit('complete', { tree: finalTree });
    await delay(30);

    expect(useGenerationStore.getState().status).toBe('completed');
    // 旧树排队节点 n1 从未出现
    expect(useMindMapStore.getState().tree!.root.children?.map((c) => c.id)).toEqual(['f1']);
  });

  it('does not touch the store when it shows a different tree (异 id 守卫)', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;

    // 用户正在浏览另一张导图
    const otherTree = makeTree('other-tree');
    useMindMapStore.getState().setTree(otherTree);

    mock.emit('node', { patch: addPatch('root', makeNode('n1', '分支一')) });
    await delay(80);

    const store = useMindMapStore.getState();
    expect(store.tree!.id).toBe('other-tree');
    expect(findNode(store.tree!.root, 'n1')).toBeUndefined();
    // 工作树仍然更新（nodesApplied 计数推进），可通过领养取回
    expect(useGenerationStore.getState().nodesApplied).toBe(1);
    expect(findNode(adoptSessionTree('tree-1')!.root, 'n1')).toBeTruthy();

    mock.emit('complete', { tree: makeTree('tree-1') });
    await delay(30);
    // complete 也不覆盖别的导图
    expect(useMindMapStore.getState().tree!.id).toBe('other-tree');
  });

  it('skips add patches for node ids already present (启发式幂等)', async () => {
    const existing = makeNode('c1', '骨架已含节点');
    const tree = makeTree('tree-1', [existing]);
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;
    useMindMapStore.getState().setTree(tree);

    const before = useMindMapStore.getState().tree;
    mock.emit('node', { patch: addPatch('root', makeNode('c1', '重复节点')) });
    await delay(80);

    const gen = useGenerationStore.getState();
    expect(gen.nodesReceived).toBe(1);
    expect(gen.nodesApplied).toBe(0);
    const after = useMindMapStore.getState().tree;
    expect(after).toBe(before);
    expect(after!.root.children).toHaveLength(1);
    expect(after!.root.children![0].content).toBe('骨架已含节点');

    mock.emit('complete', { tree: makeTree('tree-1') });
    await delay(30);
  });

  it('stop saves the partial tree via PATCH and marks the session stopped', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;
    useMindMapStore.getState().setTree(tree);

    mock.emit('node', { patch: addPatch('root', makeNode('n1', '已回放节点')) });
    await delay(80);

    await stopGeneration();

    expect(useGenerationStore.getState().status).toBe('stopped');
    expect(mock.patchCalls).toHaveLength(1);
    expect(mock.patchCalls[0].url).toContain('/api/mindmaps/tree-1');
    expect(mock.patchCalls[0].body.tree!.id).toBe('tree-1');
    expect(findNode(mock.patchCalls[0].body.tree!.root, 'n1')).toBeTruthy();
  });

  it('marks the session as error and keeps replayed content when the stream closes without complete', async () => {
    const tree = makeTree('tree-1');
    const handle = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree });
    await handle.firstSkeleton;
    useMindMapStore.getState().setTree(tree);

    mock.emit('node', { patch: addPatch('root', makeNode('n1', '已回放节点')) });
    await delay(80);

    mock.end();
    await delay(50);

    expect(useGenerationStore.getState().status).toBe('error');
    // 已回放内容保留在 store
    expect(findNode(useMindMapStore.getState().tree!.root, 'n1')).toBeTruthy();
    // error 终态同样保存部分树
    expect(mock.patchCalls).toHaveLength(1);
    expect(findNode(mock.patchCalls[0].body.tree!.root, 'n1')).toBeTruthy();
  });

  it('finalizes the previous session as stopped when a new generation replaces it', async () => {
    const treeA = makeTree('tree-a');
    const handleA = startGeneration(demoDoc, { playbackWindowMs: 10 });
    mock.emit('skeleton', { tree: treeA });
    await handleA.firstSkeleton;

    const treeB = makeTree('tree-b');
    const handleB = startGeneration(demoDoc, { playbackWindowMs: 10 });
    await delay(50);

    // 旧会话按「停止」语义收尾：保存部分树
    expect(mock.patchCalls).toHaveLength(1);
    expect(mock.patchCalls[0].url).toContain('/api/mindmaps/tree-a');

    // 新会话正常建立
    mock.emit('skeleton', { tree: treeB });
    await expect(handleB.firstSkeleton).resolves.toBe('tree-b');
    expect(getActiveGeneration()?.treeId).toBe('tree-b');
    expect(useGenerationStore.getState().status).toBe('streaming');

    mock.emit('complete', { tree: makeTree('tree-b') });
    await delay(30);
    expect(useGenerationStore.getState().status).toBe('completed');
  });
});
