import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TYPE_TICK_MS,
  __resetBranchExpansionSessionForTest,
  computeTypingChunkSize,
  startBranchExpansion,
} from '../lib/streaming/branch-expansion-session';
import type { MindMapNode, MindMapTree } from '../lib/types/mindmap';
import { findNode } from '../lib/utils/tree';
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

function makeTree(id: string): MindMapTree {
  const now = Date.now();
  return {
    id,
    root: makeNode('root', 'Root', [makeNode('target', '目标节点')]),
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

interface SSEFetchMock {
  fetchMock: ReturnType<typeof vi.fn>;
  emit: (type: string, data: unknown) => void;
  end: () => void;
  requestBodies: Array<Record<string, unknown>>;
}

/** fetch mock：POST /api/expand 返回可手动推送的 SSE 流 */
function createSSEFetchMock(): SSEFetchMock {
  const requestBodies: Array<Record<string, unknown>> = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe('/api/expand');
    requestBodies.push(JSON.parse(String(init?.body)));
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
    requestBodies,
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

let mock: SSEFetchMock;

beforeEach(() => {
  mock = createSSEFetchMock();
  vi.stubGlobal('fetch', mock.fetchMock);
  __resetBranchExpansionSessionForTest();
  resetMindMapStore();
});

afterEach(() => {
  __resetBranchExpansionSessionForTest();
  vi.unstubAllGlobals();
  resetMindMapStore();
});

describe('computeTypingChunkSize', () => {
  it('reveals ~22 ticks worth of content with no backlog (常态打字机)', () => {
    expect(computeTypingChunkSize(22, 0)).toBe(1);
    expect(computeTypingChunkSize(44, 0)).toBe(2);
  });

  it('accelerates with queue backlog', () => {
    expect(computeTypingChunkSize(24, 3)).toBe(3); // 8 ticks
    expect(computeTypingChunkSize(24, 6)).toBe(8); // 3 ticks
  });

  it('never returns 0 for non-empty content', () => {
    expect(computeTypingChunkSize(1, 0)).toBe(1);
    expect(computeTypingChunkSize(0, 10)).toBe(1);
  });
});

describe('branch expansion session', () => {
  it('replays children with typing animation, reconciles with done, and commits a single undo snapshot', async () => {
    const tree = makeTree('tree-1');
    useMindMapStore.getState().setTree(tree);

    const typingNodes: Array<string | null> = [];
    const progressCounts: number[] = [];
    const promise = startBranchExpansion({
      tree,
      nodeId: 'target',
      onProgress: (count) => progressCounts.push(count),
      onTypingNode: (nodeId) => typingNodes.push(nodeId),
    });

    // 请求体：发送树 + 目标节点
    await delay(10);
    expect(mock.requestBodies[0]).toMatchObject({ nodeId: 'target' });

    mock.emit('child', { content: '需求调研' });
    mock.emit('child', { content: '竞品分析' });
    // 打字机进行中：首个子主题已创建，内容为完整内容的前缀（逐步揭示）
    await delay(2 * TYPE_TICK_MS + 20);
    const targetPartial = findNode(useMindMapStore.getState().tree!.root, 'target')!;
    expect(targetPartial.children).toHaveLength(1);
    expect('需求调研'.startsWith(targetPartial.children![0].content)).toBe(true);
    expect(typingNodes).toContain(targetPartial.children![0].id);
    expect(progressCounts[0]).toBe(1);

    mock.emit('done', { children: ['需求调研', '竞品分析'] });
    const result = await promise;

    expect(result.count).toBe(2);
    const store = useMindMapStore.getState();
    const target = findNode(store.tree!.root, 'target')!;
    expect(target.children).toHaveLength(2);
    expect(target.children!.map((child) => child.content)).toEqual(['需求调研', '竞品分析']);

    // 单步撤销：undo 一次回到扩展前
    expect(store.canUndo).toBe(true);
    expect(store.past).toHaveLength(1);
    store.undo();
    expect(findNode(useMindMapStore.getState().tree!.root, 'target')!.children).toHaveLength(0);
    // 打字机高亮已清除
    expect(typingNodes[typingNodes.length - 1]).toBeNull();
  });

  it('reconciles content mismatches and deletes over-emitted nodes on done', async () => {
    const tree = makeTree('tree-1');
    useMindMapStore.getState().setTree(tree);

    const promise = startBranchExpansion({ tree, nodeId: 'target' });
    await delay(10);

    mock.emit('child', { content: '需求调研' });
    mock.emit('child', { content: '多余子题' });
    // 终态：数量少于已推送（超发裁剪）+ 内容以服务端为准
    mock.emit('done', { children: ['需求调研与用户访谈'] });

    const result = await promise;
    // done 到达时首个 tick 尚未触发（事件在微任务中连续处理）：
    // 超发的第二项被裁剪，仅回放 1 个子题
    expect(result.count).toBe(1);

    const target = findNode(useMindMapStore.getState().tree!.root, 'target')!;
    expect(target.children).toHaveLength(1);
    expect(target.children![0].content).toBe('需求调研与用户访谈');
  });

  it('rejects on SSE error but keeps already replayed nodes undoable', async () => {
    const tree = makeTree('tree-1');
    useMindMapStore.getState().setTree(tree);

    const promise = startBranchExpansion({ tree, nodeId: 'target' });
    await delay(10);

    mock.emit('child', { content: '已回放子题' });
    await delay(4 * TYPE_TICK_MS + 100);
    mock.emit('error', { message: 'LLM 网络中断' });

    await expect(promise).rejects.toThrow('LLM 网络中断');

    const store = useMindMapStore.getState();
    const target = findNode(store.tree!.root, 'target')!;
    expect(target.children).toHaveLength(1);
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(findNode(useMindMapStore.getState().tree!.root, 'target')!.children).toHaveLength(0);
  });

  it('flushes the previous session immediately when a new expansion starts', async () => {
    const tree = makeTree('tree-1');
    useMindMapStore.getState().setTree(tree);

    const first = startBranchExpansion({ tree, nodeId: 'target' });
    await delay(10);
    mock.emit('child', { content: '打字中子题' });
    await delay(TYPE_TICK_MS); // 打字到一半

    // 新会话启动：旧会话剩余内容立即一次性落位并结算
    const second = startBranchExpansion({ tree, nodeId: 'target' });
    const firstResult = await first;
    expect(firstResult.count).toBe(1);
    const target = findNode(useMindMapStore.getState().tree!.root, 'target')!;
    expect(target.children![0].content).toBe('打字中子题'); // 完整内容，非半截

    // 新会话正常走完
    await delay(10);
    mock.emit('child', { content: '第二次子题' });
    mock.emit('done', { children: ['第二次子题'] });
    const secondResult = await second;
    expect(secondResult.count).toBe(1);
    const targetAfter = findNode(useMindMapStore.getState().tree!.root, 'target')!;
    expect(targetAfter.children!.map((child) => child.content)).toEqual(['打字中子题', '第二次子题']);
  });

  it('skips store writes when the user has switched to another tree', async () => {
    const tree = makeTree('tree-1');
    useMindMapStore.getState().setTree(tree);

    const promise = startBranchExpansion({ tree, nodeId: 'target' });
    await delay(10);

    // 用户切换到另一棵树
    useMindMapStore.getState().setTree(makeTree('tree-2'));

    mock.emit('child', { content: '异树子题' });
    mock.emit('done', { children: ['异树子题'] });
    const result = await promise;

    expect(result.count).toBe(0);
    const otherTree = findNode(useMindMapStore.getState().tree!.root, 'target')!;
    expect(otherTree.children).toHaveLength(0);
    expect(useMindMapStore.getState().canUndo).toBe(false); // 无快照提交
  });

  it('rejects when the fetch fails before the stream starts', async () => {
    const tree = makeTree('tree-1');
    useMindMapStore.getState().setTree(tree);

    const fetchError = new Error('AI 扩展请求失败');
    mock.fetchMock.mockRejectedValueOnce(fetchError);

    await expect(startBranchExpansion({ tree, nodeId: 'target' })).rejects.toThrow('AI 扩展请求失败');
    expect(useMindMapStore.getState().canUndo).toBe(false);
  });
});
