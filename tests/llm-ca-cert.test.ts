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
});
