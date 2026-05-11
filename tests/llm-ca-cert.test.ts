import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const createOpenAISpy = vi.fn();
const generateTextSpy = vi.fn();

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: createOpenAISpy,
}));

vi.mock('ai', () => ({
  generateText: generateTextSpy,
  streamObject: vi.fn(),
}));

function makeDoc() {
  return {
    markdown: '# Demo\n\nBody',
    chunks: [
      {
        id: 'chunk_1',
        text: 'Body',
        tokenEstimate: 2,
        sourceRef: { type: 'text' as const, text: 'Body' },
      },
    ],
    sourceMeta: {
      type: 'text' as const,
      title: 'Demo',
    },
  };
}

describe('LLM CA cert handling', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it('applies custom CA-backed fetch for DeepSeek providers', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mindmap-llm-ca-'));
    const certPath = path.join(tempDir, 'ca.pem');
    writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', 'utf8');

    try {
      process.env.LLM_PROVIDER = 'deepseek';
      process.env.LLM_MODEL = 'deepseek-v4-flash';
      process.env.DEEPSEEK_API_KEY = 'sk-test';
      process.env.LLM_CA_CERT_PATH = certPath;

      createOpenAISpy.mockImplementation((config: Record<string, unknown>) => {
        const provider = ((model: string) => ({ kind: 'responses', model })) as unknown as {
          (model: string): unknown;
          chat: (model: string) => unknown;
        };
        provider.chat = (model: string) => ({ kind: 'chat', model, config });
        return provider;
      });

      generateTextSpy.mockResolvedValue({
        text: '# Demo\n\n- Point one\n- Point two',
      });

      const { generateMarkdownPreview } = await import('../lib/llm/generate');
      await generateMarkdownPreview(makeDoc());

      expect(createOpenAISpy).toHaveBeenCalledTimes(1);
      expect(createOpenAISpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          name: 'deepseek',
          baseURL: 'https://api.deepseek.com',
          fetch: expect.any(Function),
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses a dedicated system prompt for markdown summaries instead of the mindmap-generation system', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.OPENAI_API_KEY = 'sk-test';

    createOpenAISpy.mockImplementation(() => {
      const provider = ((model: string) => ({ kind: 'responses', model })) as unknown as {
        (model: string): unknown;
        chat: (model: string) => unknown;
      };
      provider.chat = (model: string) => ({ kind: 'chat', model });
      return provider;
    });

    generateTextSpy.mockResolvedValue({
      text: '# Demo\n\n## 中心思想\n\n- Point one',
    });

    const { generateMarkdownPreview } = await import('../lib/llm/generate');
    await generateMarkdownPreview(makeDoc());

    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    expect(generateTextSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        system: expect.stringContaining('Markdown'),
      }),
    );
    expect(String(generateTextSpy.mock.calls[0]?.[0]?.system || '')).not.toContain('组织为思维导图结构');
  });

  it('uses a dedicated system prompt for document summaries instead of the mindmap-generation system', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.OPENAI_API_KEY = 'sk-test';

    createOpenAISpy.mockImplementation(() => {
      const provider = ((model: string) => ({ kind: 'responses', model })) as unknown as {
        (model: string): unknown;
        chat: (model: string) => unknown;
      };
      provider.chat = (model: string) => ({ kind: 'chat', model });
      return provider;
    });

    generateTextSpy.mockResolvedValue({
      text: '{"points":["Point one","Point two"]}',
    });

    const { generateDocumentSummary } = await import('../lib/llm/generate');
    await generateDocumentSummary(makeDoc());

    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    expect(generateTextSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        system: expect.stringContaining('文档事实总结'),
      }),
    );
    expect(String(generateTextSpy.mock.calls[0]?.[0]?.system || '')).not.toContain('组织为思维导图结构');
  });

  it('preserves leading years and counts in document summary points while still normalizing real list markers', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.OPENAI_API_KEY = 'sk-test';

    createOpenAISpy.mockImplementation(() => {
      const provider = ((model: string) => ({ kind: 'responses', model })) as unknown as {
        (model: string): unknown;
        chat: (model: string) => unknown;
      };
      provider.chat = (model: string) => ({ kind: 'chat', model });
      return provider;
    });

    generateTextSpy.mockResolvedValue({
      text: '{"points":["1993年7月4日出生","6年互联网产品经理经验","2019年6月-2024年11月担任产品经理","1. 负责产品全生命周期管理"]}',
    });

    const { generateDocumentSummary } = await import('../lib/llm/generate');
    const result = await generateDocumentSummary(makeDoc());

    expect(result.points).toEqual([
      '1993年7月4日出生',
      '6年互联网产品经理经验',
      '2019年6月-2024年11月担任产品经理',
      '负责产品全生命周期管理',
    ]);
  });
});
