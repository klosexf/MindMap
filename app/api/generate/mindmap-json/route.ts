import { NextResponse } from 'next/server';
import { z } from 'zod';

import { buildHeuristicMindMapTree, generateMindMapJsonPreview } from '@/lib/llm/generate';
import { sourceReferenceSchema } from '@/lib/types/mindmap';

export const runtime = 'nodejs';

function getJsonDebugTimeoutMs(): number {
  const fallback = 35_000;
  const raw = Number(process.env.LLM_JSON_DEBUG_TIMEOUT_MS ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

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
    parseWarning: z.string().optional(),
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
    const abortController = new AbortController();
    const timeoutMs = getJsonDebugTimeoutMs();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort('mindmap_json_debug_timeout');
    }, timeoutMs);

    try {
      const result = await generateMindMapJsonPreview(parseResult.data.normalizedDocument, {
        abortSignal: abortController.signal,
      });

      return NextResponse.json({
        json: result.tree,
        parsedJson: result.parsedJson,
        rawText: result.rawText,
        proof: {
          source: 'llm',
          provider: result.provider,
          model: result.model,
        },
      });
    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : 'LLM mindmap json generation failed';
      const message = timedOut
        ? `JSON 预览等待超过 ${Math.round(timeoutMs / 1000)} 秒，已降级为本地启发式结果。`
        : /timeout/i.test(baseMessage) || /aborted/i.test(baseMessage)
          ? `${baseMessage}。JSON 预览等待超过 ${Math.round(timeoutMs / 1000)} 秒，已降级为本地启发式结果。`
          : baseMessage;
      const fallbackTree = buildHeuristicMindMapTree(parseResult.data.normalizedDocument);

      return NextResponse.json(
        {
          json: fallbackTree,
          parsedJson: JSON.stringify(fallbackTree),
          rawText: '',
          warning: message,
          proof: {
            source: 'heuristic-fallback',
            provider: 'local',
            model: 'heuristic-v1',
          },
        },
        { status: 200 },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Mindmap json generation failed',
        proof: { source: 'route' },
      },
      { status: 500 },
    );
  }
}
