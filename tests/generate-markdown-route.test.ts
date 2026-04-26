import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateMarkdownPreviewMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/llm/generate', () => ({
  generateMarkdownPreview: generateMarkdownPreviewMock,
}));

import { POST } from '../app/api/generate/markdown/route';
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

describe('POST /api/generate/markdown', () => {
  beforeEach(() => {
    generateMarkdownPreviewMock.mockReset();
  });

  it('returns markdown analysis and llm proof metadata', async () => {
    generateMarkdownPreviewMock.mockResolvedValue({
      title: '候选人画像',
      markdown: '# 候选人画像\n\n## 核心经历\n\n- 10 年产品经验',
      provider: 'zhipu',
      model: 'glm-4',
    });

    const req = new Request('http://localhost/api/generate/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedDocument: demoDoc }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.markdown).toContain('10 年产品经验');
    expect(json.proof).toEqual({
      source: 'llm',
      provider: 'zhipu',
      model: 'glm-4',
    });
  });

  it('returns 502 when llm generation fails', async () => {
    generateMarkdownPreviewMock.mockRejectedValue(new Error('LLM timeout'));

    const req = new Request('http://localhost/api/generate/markdown', {
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
