import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateAiSummaryMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/llm/generate', () => ({
  generateAiSummary: generateAiSummaryMock,
}));

import { POST } from '../app/api/summary/route';
import type { MindMapTree } from '../lib/types/mindmap';

const demoTree: MindMapTree = {
  id: 'tree_demo',
  root: {
    id: 'root_1',
    content: '人工智能发展报告 2024',
    collapsed: false,
    meta: {
      sourceRef: { type: 'text', text: '人工智能发展报告 2024' },
      confidence: 0.95,
      type: 'main',
      createdAt: 1,
      createdBy: 'ai',
    },
    children: [
      {
        id: 'node_1',
        content: '大模型能力持续提升',
        collapsed: false,
        meta: {
          sourceRef: { type: 'text', text: '大模型能力持续提升' },
          confidence: 0.84,
          type: 'detail',
          createdAt: 2,
          createdBy: 'ai',
        },
        children: [],
      },
    ],
  },
  meta: {
    title: '人工智能发展报告 2024',
    sourceType: 'text',
    createdAt: 1,
    updatedAt: 2,
    version: 1,
    truncated: false,
  },
};

describe('POST /api/summary', () => {
  beforeEach(() => {
    generateAiSummaryMock.mockReset();
  });

  it('returns ai summary content and proof metadata', async () => {
    generateAiSummaryMock.mockResolvedValue({
      points: [
        '大模型、多模态与 Agent 持续驱动 AI 技术演进。',
        '行业应用从能力展示转向业务闭环与效率提升。',
        '法规、伦理与安全治理是可持续落地的关键。',
      ],
      provider: 'zhipu',
      model: 'glm-4',
      source: 'llm',
    });

    const req = new Request('http://localhost/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: demoTree }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.points).toHaveLength(3);
    expect(json.points[0]).toContain('大模型');
    expect(json.proof).toEqual({
      source: 'llm',
      provider: 'zhipu',
      model: 'glm-4',
    });
  });

  it('returns 400 when request payload is invalid', async () => {
    const req = new Request('http://localhost/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: { id: 'broken' } }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  it('returns 502 when summary generation fails', async () => {
    generateAiSummaryMock.mockRejectedValue(new Error('summary timeout'));

    const req = new Request('http://localhost/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: demoTree }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toContain('summary timeout');
  });
});
