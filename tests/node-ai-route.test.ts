import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamNodeActionTextMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/llm/generate', () => ({
  streamNodeActionText: streamNodeActionTextMock,
}));

import { POST } from '../app/api/node-ai/route';
import type { MindMapNode, MindMapTree } from '../lib/types/mindmap';

function makeNode(id: string, content: string, children: MindMapNode[] = []): MindMapNode {
  const now = Date.now();
  return {
    id,
    content,
    collapsed: false,
    children,
    meta: {
      sourceRef: { type: 'text', text: content },
      createdAt: now,
      createdBy: 'ai',
      type: 'detail',
    },
  };
}

function sampleTree(): MindMapTree {
  const now = Date.now();
  return {
    id: 'tree-node-ai',
    root: makeNode('root', 'AI 产品经理能力模型', [
      makeNode('branch-1', '产品设计', [makeNode('leaf-1', '需求分析')]),
    ]),
    meta: {
      sourceType: 'text',
      title: 'AI 产品经理能力模型',
      createdAt: now,
      updatedAt: now,
      version: 1,
      truncated: false,
    },
  };
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/node-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 解析 SSE 响应文本为事件列表 */
function parseSse(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  return raw
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const eventLine = chunk.split('\n').find((line) => line.startsWith('event: ')) || '';
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: ')) || '{}';
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
      };
    });
}

describe('POST /api/node-ai', () => {
  beforeEach(() => {
    streamNodeActionTextMock.mockReset();
  });

  it('流式返回 delta 事件并以 done 结束，上下文包含主题路径', async () => {
    async function* fakeStream() {
      yield '润色后的';
      yield '文本';
    }
    streamNodeActionTextMock.mockImplementation(fakeStream);

    const res = await POST(makeReq({ tree: sampleTree(), nodeId: 'branch-1', action: 'polish' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const events = parseSse(await res.text());
    expect(events[0]).toEqual({ event: 'delta', data: { text: '润色后的' } });
    expect(events[1]).toEqual({ event: 'delta', data: { text: '文本' } });
    expect(events[events.length - 1].event).toBe('done');

    const input = streamNodeActionTextMock.mock.calls[0][0];
    expect(input.action).toBe('polish');
    expect(input.nodeContent).toBe('产品设计');
    expect(input.pathTitles).toEqual(['AI 产品经理能力模型']);
  });

  it('节点不存在时返回 404', async () => {
    const res = await POST(makeReq({ tree: sampleTree(), nodeId: 'missing', action: 'polish' }));
    expect(res.status).toBe(404);
  });

  it('非法 action 返回 400', async () => {
    const res = await POST(makeReq({ tree: sampleTree(), nodeId: 'branch-1', action: 'translate' }));
    expect(res.status).toBe(400);
  });

  it('流中途抛错时发出 error 事件', async () => {
    async function* failingStream() {
      yield '部分结果';
      throw new Error('LLM 超时');
    }
    streamNodeActionTextMock.mockImplementation(failingStream);

    const res = await POST(makeReq({ tree: sampleTree(), nodeId: 'branch-1', action: 'simplify' }));
    const events = parseSse(await res.text());
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent?.data.message).toBe('LLM 超时');
  });
});
