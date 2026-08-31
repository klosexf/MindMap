import { afterEach, describe, expect, it } from 'vitest';

import { buildHeuristicMindMapTree, describeGenerationFailure, generateMindMapStream } from '../lib/llm/generate';
import type { MindMapTree, NormalizedDocument } from '../lib/types/mindmap';

const demoDoc: NormalizedDocument = {
  markdown: '# Demo\n\nParagraph one. Paragraph two. Paragraph three.',
  chunks: [
    {
      id: 'chunk_1',
      text: 'Paragraph one.',
      tokenEstimate: 6,
      sourceRef: { type: 'text', text: 'Paragraph one.' },
    },
    {
      id: 'chunk_2',
      text: 'Paragraph two. Paragraph three.',
      tokenEstimate: 8,
      sourceRef: { type: 'text', text: 'Paragraph two.' },
    },
  ],
  sourceMeta: { type: 'text', title: 'Demo' },
};

describe('buildHeuristicMindMapTree baseTreeId', () => {
  it('reuses the passed baseTreeId when provided', () => {
    const tree = buildHeuristicMindMapTree(demoDoc, 'fixed-session-id');
    expect(tree.id).toBe('fixed-session-id');
  });

  it('generates a fresh id per call when baseTreeId is omitted', () => {
    const a = buildHeuristicMindMapTree(demoDoc);
    const b = buildHeuristicMindMapTree(demoDoc);
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe('fixed-session-id');
    expect(a.id).not.toBe(b.id);
  });
});

describe('describeGenerationFailure (降级文案归一)', () => {
  it.each([
    ['The operation was aborted due to timeout.', 'AI 响应超时，'],
    ['Request timed out after 30000ms', 'AI 响应超时，'],
    ['fetch failed: ECONNREFUSED 127.0.0.1:443', '网络连接异常，'],
    ['401 Unauthorized: invalid api key', 'AI 服务鉴权失败，'],
    ['429 Too Many Requests: rate limit exceeded', 'AI 服务繁忙，'],
  ])('%s → 归一为友好文案', (message, expected) => {
    expect(describeGenerationFailure(new Error(message))).toBe(expected);
  });

  it('未识别的失败归一为通用文案', () => {
    expect(describeGenerationFailure(new Error('some unexpected failure'))).toBe('AI 生成出现异常，');
  });
});

describe('generateMindMapStream session id (无 key 启发式路径)', () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (typeof originalProvider === 'string') {
      process.env.LLM_PROVIDER = originalProvider;
    } else {
      delete process.env.LLM_PROVIDER;
    }
    if (typeof originalKey === 'string') {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('emits skeleton and complete trees sharing one session id', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = '';

    const trees: MindMapTree[] = [];
    for await (const event of generateMindMapStream(demoDoc)) {
      if (event.type === 'skeleton' || event.type === 'complete') {
        trees.push(event.data.tree);
      }
    }

    expect(trees.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(trees.map((tree) => tree.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });
});
