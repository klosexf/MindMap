import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateMindMapJsonPreviewMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/llm/generate', () => ({
  generateMindMapJsonPreview: generateMindMapJsonPreviewMock,
}));

import { POST } from '../app/api/generate/mindmap-json/route';
import type { NormalizedDocument } from '../lib/types/mindmap';

const demoDoc: NormalizedDocument = {
  markdown: '# Demo PDF\n\n## Page 1\n\n这是测试内容。',
  chunks: [
    {
      id: 'chunk_1',
      text: '## Page 1\n\n这是测试内容。',
      tokenEstimate: 12,
      sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '这是测试内容。' },
    },
  ],
  sourceMeta: {
    type: 'pdf',
    title: 'Demo PDF',
    sourceFileName: 'demo.pdf',
  },
};

describe('POST /api/generate/mindmap-json', () => {
  beforeEach(() => {
    generateMindMapJsonPreviewMock.mockReset();
  });

  it('returns mindmap json and llm proof metadata', async () => {
    generateMindMapJsonPreviewMock.mockResolvedValue({
      tree: {
        title: '候选人画像',
        root: {
          content: '候选人画像',
          children: [{ content: '工作经历', children: [{ content: '10 年产品经验' }] }],
        },
      },
      parsedJson: '{"title":"候选人画像","root":{"content":"候选人画像"}}',
      rawText: '{"title":"候选人画像","root":{"content":"候选人画像"}}',
      provider: 'zhipu',
      model: 'glm-4',
    });

    const req = new Request('http://localhost/api/generate/mindmap-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedDocument: demoDoc }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.json?.title).toBe('候选人画像');
    expect(json.proof).toEqual({
      source: 'llm',
      provider: 'zhipu',
      model: 'glm-4',
    });
  });

  it('returns 502 when llm json generation fails', async () => {
    generateMindMapJsonPreviewMock.mockRejectedValue(new Error('LLM timeout'));

    const req = new Request('http://localhost/api/generate/mindmap-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedDocument: demoDoc }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toContain('LLM timeout');
    expect(json.proof).toEqual({ source: 'llm' });
  });
});
