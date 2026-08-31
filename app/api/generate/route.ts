import { NextResponse } from 'next/server';
import { z } from 'zod';

import { buildHeuristicMindMapTree, generateMindMapStream } from '@/lib/llm/generate';
import { FirstEventTimeoutError, waitForFirstEventWithWarning } from '@/lib/llm/first-event-watchdog';
import { saveMindMap } from '@/lib/storage/mindmap-store';
import { mindMapTreeSchema, sourceReferenceSchema, type MindMapTree } from '@/lib/types/mindmap';
import { progressiveTreePatches, rootOnlyTree } from '@/lib/utils/tree';

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
          // 首个 skeleton 先落盘再推送：客户端 skeleton 即跳转后 GET 必不 404
          let skeletonSaved = false;

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
            if (event.type === 'skeleton' && !skeletonSaved) {
              skeletonSaved = true;
              // 保存失败时仍推送骨架（生成继续，complete 时会再次尝试保存）
              try {
                await saveMindMap(event.data.tree, normalizedDocument);
              } catch (saveErr) {
                controller.enqueue(
                  encoder.encode(
                    sseMessage('error', {
                      message: saveErr instanceof Error ? `导图保存失败: ${saveErr.message}` : '导图保存失败',
                    }),
                  ),
                );
              }
              controller.enqueue(encoder.encode(sseMessage(event.type, event.data)));
              continue;
            }
            if (event.type === 'complete') {
              completedTree = mindMapTreeSchema.parse(event.data.tree);
              // 先保存再发送 complete 事件，确保客户端跳转时文件已存在
              try {
                await saveMindMap(completedTree);
                controller.enqueue(encoder.encode(sseMessage(event.type, event.data)));
              } catch (saveErr) {
                controller.enqueue(
                  encoder.encode(
                    sseMessage('error', {
                      message: saveErr instanceof Error ? `导图保存失败: ${saveErr.message}` : '导图保存失败',
                    }),
                  ),
                );
              }
              continue;
            }
            controller.enqueue(encoder.encode(sseMessage(event.type, event.data)));
          }

          controller.close();
        } catch (error) {
          if (error instanceof FirstEventTimeoutError) {
            const fallback = buildHeuristicMindMapTree(normalizedDocument);
            completedTree = fallback;
            // 先保存再推送 skeleton：客户端 skeleton 即跳转后 GET 必不 404；
            // 保存失败则只发 error（不发 skeleton/complete，客户端不跳转）。
            // skeleton 仅含根节点（rootOnly），其余节点经 node 事件逐个回放，
            // 与 generateMindMapStream 的实时生成语义保持一致
            try {
              await saveMindMap(fallback, normalizedDocument);
              controller.enqueue(encoder.encode(sseMessage('skeleton', { tree: rootOnlyTree(fallback) })));
              for (const { patch, node } of progressiveTreePatches(fallback)) {
                controller.enqueue(encoder.encode(sseMessage('node', { patch, node })));
              }
              controller.enqueue(encoder.encode(sseMessage('complete', { tree: fallback })));
            } catch (saveErr) {
              controller.enqueue(
                encoder.encode(
                  sseMessage('error', {
                    message: saveErr instanceof Error ? `导图保存失败: ${saveErr.message}` : '导图保存失败',
                  }),
                ),
              );
            }
          } else {
            controller.enqueue(
              encoder.encode(
                sseMessage('error', {
                  message: error instanceof Error ? error.message : 'Generation failed',
                }),
              ),
            );

            if (completedTree) {
              try {
                await saveMindMap(completedTree);
                controller.enqueue(encoder.encode(sseMessage('complete', { tree: completedTree })));
              } catch (saveErr) {
                controller.enqueue(
                  encoder.encode(
                    sseMessage('error', {
                      message: saveErr instanceof Error ? `导图保存失败: ${saveErr.message}` : '导图保存失败',
                    }),
                  ),
                );
              }
            }
          }

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
