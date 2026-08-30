import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateTreeOptimizationMock = vi.hoisted(() => vi.fn());
const convertMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/llm/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/llm/generate')>();
  return {
    ...actual,
    generateTreeOptimization: generateTreeOptimizationMock,
    convertOptimizedTreeToMindMapTree: convertMock,
  };
});

import { POST } from '../app/api/optimize/route';
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
    id: 'tree-optimize',
    root: makeNode('root', '会议纪要', [
      makeNode('b1', '决议事项'),
      makeNode('b2', '待办事项'),
    ]),
    meta: {
      sourceType: 'text',
      title: '会议纪要',
      createdAt: now,
      updatedAt: now,
      version: 3,
      truncated: false,
    },
  };
}

const optimizedLlmTree = {
  title: '会议纪要（优化）',
  root: { content: '会议纪要', children: [{ content: '决议与待办' }] },
};

const convertedTree = {
  id: 'tree-optimize',
  root: makeNode('new-root', '会议纪要', [makeNode('n1', '决议与待办')]),
  meta: {
    sourceType: 'text',
    title: '会议纪要（优化）',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 4,
    truncated: false,
  },
};

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/optimize', () => {
  beforeEach(() => {
    generateTreeOptimizationMock.mockReset();
    convertMock.mockReset();
  });

  it('optimizes the tree and returns a replaceable tree payload', async () => {
    generateTreeOptimizationMock.mockResolvedValue({
      tree: optimizedLlmTree,
      provider: 'zhipu',
      model: 'glm-4',
      source: 'llm',
    });
    convertMock.mockReturnValue(convertedTree);

    const res = await POST(makeReq({ tree: sampleTree(), mode: 'simplify' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tree.id).toBe('tree-optimize');
    expect(json.tree.root.children[0].content).toBe('决议与待办');
    expect(json.proof).toEqual({ source: 'llm', provider: 'zhipu', model: 'glm-4' });

    expect(generateTreeOptimizationMock.mock.calls[0][1].mode).toBe('simplify');
    const reference = convertMock.mock.calls[0][1];
    expect(reference.id).toBe('tree-optimize');
    expect(reference.meta.title).toBe('会议纪要（优化）');
  });

  it('returns 400 when mode is invalid', async () => {
    const res = await POST(makeReq({ tree: sampleTree(), mode: 'unknown' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  it('returns 502 when optimization fails', async () => {
    generateTreeOptimizationMock.mockRejectedValue(new Error('optimize timeout'));

    const res = await POST(makeReq({ tree: sampleTree(), mode: 'restructure' }));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toContain('optimize timeout');
  });
});
