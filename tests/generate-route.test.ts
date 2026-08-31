import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateMindMapStreamMock = vi.hoisted(() => vi.fn());
const buildHeuristicMindMapTreeMock = vi.hoisted(() => vi.fn());
const saveMindMapMock = vi.hoisted(() => vi.fn());
const waitForFirstEventWithWarningMock = vi.hoisted(() => vi.fn());
const { MockFirstEventTimeoutError } = vi.hoisted(() => ({
  MockFirstEventTimeoutError: class MockFirstEventTimeoutError extends Error {},
}));

vi.mock('@/lib/llm/generate', () => ({
  generateMindMapStream: generateMindMapStreamMock,
  buildHeuristicMindMapTree: buildHeuristicMindMapTreeMock,
}));

vi.mock('@/lib/storage/mindmap-store', () => ({
  saveMindMap: saveMindMapMock,
}));

vi.mock('@/lib/llm/first-event-watchdog', () => ({
  FirstEventTimeoutError: MockFirstEventTimeoutError,
  waitForFirstEventWithWarning: waitForFirstEventWithWarningMock,
}));

import { POST } from '../app/api/generate/route';
import { consumeSSEStream } from '../lib/streaming/sse';
import type { MindMapNode, MindMapTree, NormalizedDocument, TreePatch } from '../lib/types/mindmap';

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

function streamOf(events: Array<{ type: string; data: unknown }>) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

async function collectEvents(response: Response) {
  const events: Array<{ type: string; data: any }> = [];
  for await (const event of consumeSSEStream(response)) events.push(event);
  return events;
}

function makeRequest(): Request {
  return new Request('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ normalizedDocument: demoDoc }),
  });
}

beforeEach(() => {
  generateMindMapStreamMock.mockReset();
  buildHeuristicMindMapTreeMock.mockReset();
  saveMindMapMock.mockReset();
  waitForFirstEventWithWarningMock.mockReset();
  waitForFirstEventWithWarningMock.mockImplementation((promise: Promise<unknown>) => promise);
  saveMindMapMock.mockResolvedValue(undefined);
});

describe('POST /api/generate', () => {
  it('saves the first skeleton with doc before pushing it, then saves the complete tree', async () => {
    const skeletonTree = makeTree('tree-1', [makeNode('c1', '骨架分支')]);
    const finalTree = makeTree('tree-1', [makeNode('f1', '终态分支一'), makeNode('f2', '终态分支二')]);
    generateMindMapStreamMock.mockReturnValue(
      streamOf([
        { type: 'skeleton', data: { tree: skeletonTree } },
        { type: 'node', data: { patch: addPatch('root', makeNode('f1', '终态分支一')) } },
        { type: 'complete', data: { tree: finalTree } },
      ]),
    );

    const res = await POST(makeRequest());
    const events = await collectEvents(res);

    // 首个 skeleton 先落盘（携带 doc）再推送：客户端 skeleton 即跳转后 GET 必不 404
    expect(saveMindMapMock).toHaveBeenNthCalledWith(1, skeletonTree, demoDoc);
    expect(saveMindMapMock).toHaveBeenNthCalledWith(2, finalTree);
    expect(events.map((e) => e.type)).toEqual(['skeleton', 'node', 'complete']);
    expect(events[0].data.tree.id).toBe('tree-1');
    expect(events[2].data.tree.root.children).toHaveLength(2);
  });

  it('still pushes the skeleton when the first save fails, and keeps complete behavior', async () => {
    const skeletonTree = makeTree('tree-1');
    const finalTree = makeTree('tree-1', [makeNode('f1', '终态分支')]);
    saveMindMapMock.mockRejectedValueOnce(new Error('disk full'));
    generateMindMapStreamMock.mockReturnValue(
      streamOf([
        { type: 'skeleton', data: { tree: skeletonTree } },
        { type: 'complete', data: { tree: finalTree } },
      ]),
    );

    const res = await POST(makeRequest());
    const events = await collectEvents(res);

    const types = events.map((e) => e.type);
    expect(types).toContain('skeleton');
    expect(types).toContain('complete');
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].data.message).toContain('导图保存失败');
    expect(saveMindMapMock).toHaveBeenNthCalledWith(1, skeletonTree, demoDoc);
    expect(saveMindMapMock).toHaveBeenNthCalledWith(2, finalTree);
  });

  it('does not push complete when the final save fails', async () => {
    const skeletonTree = makeTree('tree-1');
    const finalTree = makeTree('tree-1', [makeNode('f1', '终态分支')]);
    saveMindMapMock
      .mockResolvedValueOnce(undefined) // skeleton 保存成功
      .mockRejectedValueOnce(new Error('disk full')); // complete 保存失败
    generateMindMapStreamMock.mockReturnValue(
      streamOf([
        { type: 'skeleton', data: { tree: skeletonTree } },
        { type: 'complete', data: { tree: finalTree } },
      ]),
    );

    const res = await POST(makeRequest());
    const events = await collectEvents(res);

    expect(events.map((e) => e.type)).toEqual(['skeleton', 'error']);
    expect(events[1].data.message).toContain('导图保存失败');
  });

  it('FET fallback: saves the heuristic tree with doc, then emits rootOnly skeleton + progressive nodes + complete', async () => {
    const fallbackTree = makeTree('tree-fet', [makeNode('h1', '降级分支')]);
    buildHeuristicMindMapTreeMock.mockReturnValue(fallbackTree);
    generateMindMapStreamMock.mockImplementation(() =>
      (async function* () {
        throw new MockFirstEventTimeoutError('first event timeout');
      })(),
    );

    const res = await POST(makeRequest());
    const events = await collectEvents(res);

    // 先保存（带 doc）再推送；skeleton 仅含根（rootOnly），节点经 node 事件逐个回放
    expect(buildHeuristicMindMapTreeMock).toHaveBeenCalledWith(demoDoc);
    expect(saveMindMapMock).toHaveBeenCalledTimes(1);
    expect(saveMindMapMock).toHaveBeenCalledWith(fallbackTree, demoDoc);
    expect(events.map((e) => e.type)).toEqual(['skeleton', 'node', 'complete']);
    expect(events[0].data.tree.id).toBe('tree-fet');
    expect(events[0].data.tree.root.children).toHaveLength(0);
    expect(events[1].data.patch.nodeId).toBe('h1');
    expect(events[1].data.patch.parentId).toBe('root');
    expect(events[2].data.tree.id).toBe('tree-fet');
    expect(events[2].data.tree.root.children).toHaveLength(1);
  });

  it('FET fallback only emits error when the save fails (no skeleton, no jump)', async () => {
    const fallbackTree = makeTree('tree-fet');
    buildHeuristicMindMapTreeMock.mockReturnValue(fallbackTree);
    saveMindMapMock.mockRejectedValue(new Error('disk full'));
    generateMindMapStreamMock.mockImplementation(() =>
      (async function* () {
        throw new MockFirstEventTimeoutError('first event timeout');
      })(),
    );

    const res = await POST(makeRequest());
    const events = await collectEvents(res);

    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0].data.message).toContain('导图保存失败');
  });

  it('returns 400 for an invalid request body', async () => {
    const req = new Request('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedDocument: { markdown: '' } }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(generateMindMapStreamMock).not.toHaveBeenCalled();
  });
});
