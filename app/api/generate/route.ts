import { NextResponse } from 'next/server';
import { z } from 'zod';

import { generateMindMapStream } from '@/lib/llm/generate';
import { waitForFirstEventWithWarning } from '@/lib/llm/first-event-watchdog';
import { saveMindMap } from '@/lib/storage/mindmap-store';
import { mindMapTreeSchema, sourceReferenceSchema, type MindMapTree } from '@/lib/types/mindmap';

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
    type: z.enum(['text', 'url', 'pdf', 'prompt']),
    title: z.string().optional(),
    sourceUrl: z.string().url().optional(),
    sourceFileName: z.string().optional(),
    ocrUsed: z.boolean().optional(),
  }),
});

const generateRequestSchema = z.object({
  normalizedDocument: normalizedDocSchema,
});

function sseMessage(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function getFirstEventWarningMs(): number {
  const fallback = 20_000;
  const raw = Number(process.env.GENERATE_FIRST_EVENT_WARNING_MS ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export async function POST(req: Request) {
  try {
    const { normalizedDocument } = generateRequestSchema.parse(await req.json());
    const encoder = new TextEncoder();
    let completedTree: MindMapTree | null = null;
    const firstEventWarningMs = getFirstEventWarningMs();
    const requestStartedAt = Date.now();
    const generationAbortController = new AbortController();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const iterator = generateMindMapStream(normalizedDocument, {
            abortSignal: generationAbortController.signal,
          })[Symbol.asyncIterator]();
          let firstDataEventSent = false;

          while (true) {
            const nextPromise = iterator.next();
            const iteration = firstDataEventSent
              ? await nextPromise
              : await waitForFirstEventWithWarning(nextPromise, firstEventWarningMs, async () => {
                  controller.enqueue(
                    encoder.encode(
                      sseMessage('warning', {
                        code: 'first_event_timeout',
                        waitedMs: Date.now() - requestStartedAt,
                        thresholdMs: firstEventWarningMs,
                        message: `首个生成事件等待超过 ${Math.round(firstEventWarningMs / 1000)} 秒，已触发快速降级。`,
                      }),
                    ),
                  );
                  generationAbortController.abort('first_event_timeout');
                });

            if (iteration.done) {
              break;
            }

            firstDataEventSent = true;
            const event = iteration.value;
            if (event.type === 'complete') {
              completedTree = mindMapTreeSchema.parse(event.data.tree);
            }
            controller.enqueue(encoder.encode(sseMessage(event.type, event.data)));
          }

          if (completedTree) {
            await saveMindMap(completedTree);
          }

          controller.close();
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              sseMessage('error', {
                message: error instanceof Error ? error.message : 'Generation failed',
              }),
            ),
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Invalid request',
      },
      { status: 400 },
    );
  }
}
