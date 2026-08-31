import { NextResponse } from 'next/server';
import { z } from 'zod';

import { streamNodeActionText } from '@/lib/llm/generate';
import { mindMapTreeSchema } from '@/lib/types/mindmap';
import { findNode, findParentInfo } from '@/lib/utils/tree';

export const runtime = 'nodejs';

const requestSchema = z.object({
  tree: mindMapTreeSchema,
  nodeId: z.string().min(1),
  action: z.enum(['polish', 'expand', 'simplify', 'questions']),
});

function sseMessage(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  const parseResult = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.issues[0]?.message || 'Invalid request' },
      { status: 400 },
    );
  }

  const { tree, nodeId, action } = parseResult.data;

  const node = findNode(tree.root, nodeId);
  if (!node) {
    return NextResponse.json({ error: '节点不存在' }, { status: 404 });
  }

  // 从根到该节点的主题路径（不含自身），为 AI 提供上下文
  const pathTitles: string[] = [];
  let currentId: string | undefined = nodeId;
  while (currentId) {
    const parentInfo = findParentInfo(tree.root, currentId);
    if (!parentInfo) break;
    const parent = findNode(tree.root, parentInfo.parentId);
    if (!parent) break;
    pathTitles.unshift(parent.content);
    currentId = parentInfo.parentId;
  }

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  // 客户端断开时中止上游 LLM 请求
  req.signal?.addEventListener('abort', () => abortController.abort(), { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const delta of streamNodeActionText(
          {
            action,
            nodeContent: node.content,
            pathTitles,
            documentMarkdown: undefined,
          },
          { abortSignal: abortController.signal },
        )) {
          controller.enqueue(encoder.encode(sseMessage('delta', { text: delta })));
        }
        controller.enqueue(encoder.encode(sseMessage('done', {})));
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            sseMessage('error', {
              message: error instanceof Error ? error.message : 'AI 处理失败',
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
