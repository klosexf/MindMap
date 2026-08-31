import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateMindMapJsonPreviewMock = vi.hoisted(() => vi.fn());
const buildHeuristicMindMapTreeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/llm/generate', () => ({
  generateMindMapJsonPreview: generateMindMapJsonPreviewMock,
  buildHeuristicMindMapTree: buildHeuristicMindMapTreeMock,
}));

import { POST } from '../app/api/generate/mindmap-json/route';
import type { NormalizedDocument } from '../lib/types/mindmap';

const demoDoc: NormalizedDocument = {
  markdown: '# Demo PDF\n\n---\n[page:1]\n\n这是测试内容。',
  chunks: [
    {
      id: 'chunk_1',
      text: '# Demo PDF\n\n---\n[page:1]\n\n这是测试内容。',
      tokenEstimate: 16,
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
    buildHeuristicMindMapTreeMock.mockReset();
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

  it('falls back to heuristic json when llm json generation fails', async () => {
    // 注意：route 会把含 timeout/aborted 的错误归一化为通用超时文案，
    // 因此这里用非超时错误验证「原始错误透传 + 兜底树生效」。
    generateMindMapJsonPreviewMock.mockRejectedValue(new Error('LLM json 解析失败'));
    buildHeuristicMindMapTreeMock.mockReturnValue({
      id: 'fallback-tree-id',
      root: {
        id: 'fallback-root',
        content: '候选人画像',
        collapsed: false,
        meta: {
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '这是测试内容。' },
          type: 'main',
          confidence: 0.7,
          createdAt: 1,
          createdBy: 'ai',
        },
        children: [],
      },
      meta: {
        title: '候选人画像',
        sourceType: 'pdf',
        sourceFileName: 'demo.pdf',
        createdAt: 1,
        updatedAt: 1,
        version: 1,
        truncated: false,
      },
    });

    const req = new Request('http://localhost/api/generate/mindmap-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedDocument: demoDoc }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.warning).toContain('LLM json 解析失败');
    expect(json.json?.root?.content).toBe('候选人画像');
    expect(json.proof).toEqual({
      source: 'heuristic-fallback',
      provider: 'local',
      model: 'heuristic-v1',
    });
  });
});
