import { NextResponse } from 'next/server';
import { z } from 'zod';

import { generateMarkdownPreview } from '@/lib/llm/generate';
import { sourceReferenceSchema } from '@/lib/types/mindmap';

export const runtime = 'nodejs';

const normalizedDocSchema = z.object({
  markdown: z.string().min(1),
  chunks: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        tokenEstimate: z.number().int().positive(),
        sourceRef: sourceReferenceSchema,
      }),
    )
    .min(1),
  sourceMeta: z.object({
    type: z.enum(['text', 'url', 'pdf', 'prompt', 'wechat']),
    title: z.string().optional(),
    sourceUrl: z.string().url().optional(),
    sourceFileName: z.string().optional(),
    ocrUsed: z.boolean().optional(),
  }),
});

const requestSchema = z.object({
  normalizedDocument: normalizedDocSchema,
});

export async function POST(req: Request) {
  const parseResult = requestSchema.safeParse(await req.json());
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: parseResult.error.issues[0]?.message || 'Invalid request',
      },
      { status: 400 },
    );
  }

  try {
    const result = await generateMarkdownPreview(parseResult.data.normalizedDocument);
    return NextResponse.json({
      title: result.title,
      markdown: result.markdown,
      proof: {
        source: 'llm',
        provider: result.provider,
        model: result.model,
      },
    });
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : 'LLM markdown generation failed';
    const message =
      /timeout/i.test(baseMessage) || /aborted/i.test(baseMessage)
        ? `${baseMessage}。可在 .env 设置 LLM_MARKDOWN_TIMEOUT=90（或更高）后重试。`
        : baseMessage;

    return NextResponse.json(
      {
        error: message,
        proof: { source: 'llm' },
      },
      { status: 502 },
    );
  }
}
