import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamBranchExpansionMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/llm/generate', () => ({
  streamBranchExpansion: streamBranchExpansionMock,
}));

import { POST } from '../app/api/expand/route';
import type { MindMapNode, MindMapTree, NormalizedDocument } from '../lib/types/mindmap';

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
    id: 'tree-expand',
    root: makeNode('root', 'AI 产品经理能力模型', [
      makeNode('branch-1', '产品设计', [makeNode('leaf-1', '需求分析')]),
      makeNode('branch-2', '数据分析'),
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

const demoDoc: NormalizedDocument = {
  markdown: 'AI 产品经理需要掌握需求分析、数据驱动决策与跨团队协作。',
  chunks: [
    {
      id: 'chunk_1',
      text: 'AI 产品经理需要掌握需求分析、数据驱动决策与跨团队协作。',
      tokenEstimate: 24,
      sourceRef: { type: 'text', text: 'AI 产品经理需要掌握需求分析。' },
    },
  ],
  sourceMeta: { type: 'text', title: 'AI 产品经理' },
};

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/expand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface SSEEvent {
  type: string;
  data: any;
}

function parseSSE(text: string): SSEEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) throw new Error(`bad SSE block: ${block}`);
      return {
        type: eventLine.replace('event: ', '').trim(),
        data: JSON.parse(dataLine.replace('data: ', '')),
      };
    });
}

describe('POST /api/expand (SSE)', () => {
  beforeEach(() => {
    streamBranchExpansionMock.mockReset();
  });

  it('streams child/done events and passes path/sibling context to the LLM', async () => {
    const children = ['用户调研方法', '竞品分析框架', '需求优先级排序'];
    streamBranchExpansionMock.mockImplementation(async function* () {
      for (const content of children) {
        yield { type: 'child', content };
      }
      yield {
        type: 'done',
        children,
        proof: { provider: 'zhipu', model: 'glm-4', source: 'llm' },
      };
    });

    const res = await POST(makeReq({ tree: sampleTree(), nodeId: 'branch-1', normalizedDocument: demoDoc }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const events = parseSSE(await res.text());
    expect(events.map((e) => e.type)).toEqual(['child', 'child', 'child', 'done']);
    expect(events[0].data).toEqual({ content: '用户调研方法' });
    expect(events[3].data.children).toEqual(children);
    expect(events[3].data.proof.source).toBe('llm');

    const input = streamBranchExpansionMock.mock.calls[0][0];
    expect(input.focusContent).toBe('产品设计');
    expect(input.pathTitles).toEqual(['AI 产品经理能力模型']);
    expect(input.siblingTitles).toEqual(['数据分析']);
    expect(input.existingChildren).toEqual(['需求分析']);
    expect(input.documentMarkdown).toBe(demoDoc.markdown);
  });

  it('emits an error event (not a 502) when expansion fails', async () => {
    streamBranchExpansionMock.mockImplementation(async function* () {
      throw new Error('expand timeout');
    });

    const res = await POST(makeReq({ tree: sampleTree(), nodeId: 'branch-1' }));

    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].data.message).toContain('expand timeout');
  });

  it('returns 404 when the node does not exist', async () => {
    const res = await POST(makeReq({ tree: sampleTree(), nodeId: 'missing' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain('节点不存在');
  });

  it('returns 400 when the payload is invalid', async () => {
    const res = await POST(makeReq({ nodeId: 'branch-1' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeTruthy();
  });
});
