import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateDocumentSummaryMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/llm/generate', () => ({
  generateDocumentSummary: generateDocumentSummaryMock,
}));

import { POST } from '../app/api/summary/route';
import type { NormalizedDocument } from '../lib/types/mindmap';

const demoDoc: NormalizedDocument = {
  markdown: '# 人工智能发展报告 2024\n\n## 第一章\n\n大模型能力持续提升。',
  chunks: [
    {
      id: 'chunk_1',
      text: '## 第一章\n\n大模型能力持续提升。',
      tokenEstimate: 24,
      sourceRef: {
        type: 'pdf',
        page: 1,
        location: 'page:1',
        text: '大模型能力持续提升。',
      },
    },
  ],
  sourceMeta: {
    type: 'pdf',
    title: '人工智能发展报告 2024',
    sourceFileName: 'ai-report-2024.pdf',
  },
};

describe('POST /api/summary', () => {
  beforeEach(() => {
    generateDocumentSummaryMock.mockReset();
  });

  it('returns ai summary content and proof metadata', async () => {
    generateDocumentSummaryMock.mockResolvedValue({
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
      body: JSON.stringify({ normalizedDocument: demoDoc }),
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
    generateDocumentSummaryMock.mockRejectedValue(new Error('summary timeout'));

    const req = new Request('http://localhost/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedDocument: demoDoc }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toContain('summary timeout');
  });
});
