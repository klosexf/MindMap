import { NextResponse } from 'next/server';
import { z } from 'zod';

import { streamBranchExpansion } from '@/lib/llm/generate';
import {
  mindMapTreeSchema,
  normalizedDocumentSchema,
} from '@/lib/types/mindmap';
import { findNode, findParentInfo } from '@/lib/utils/tree';

export const runtime = 'nodejs';

const requestSchema = z.object({
  tree: mindMapTreeSchema,
  nodeId: z.string().min(1),
  normalizedDocument: normalizedDocumentSchema.optional(),
});

function sseMessage(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  const parseResult = requestSchema.safeParse(await req.json());
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.issues[0]?.message || 'Invalid request' },
      { status: 400 },
    );
  }

  const { tree, nodeId, normalizedDocument } = parseResult.data;

  const node = findNode(tree.root, nodeId);
  if (!node) {
    return NextResponse.json({ error: '节点不存在' }, { status: 404 });
  }

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

  const parentInfo = findParentInfo(tree.root, nodeId);
  const siblingTitles = parentInfo
    ? (findNode(tree.root, parentInfo.parentId)?.children || [])
        .filter((sibling) => sibling.id !== nodeId)
        .map((sibling) => sibling.content)
    : [];

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  // 客户端断开时中止上游 LLM 请求
  req.signal?.addEventListener('abort', () => abortController.abort(), { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamBranchExpansion(
          {
            focusContent: node.content,
            pathTitles,
            siblingTitles,
            existingChildren: (node.children || []).map((child) => child.content),
            documentMarkdown: normalizedDocument?.markdown,
          },
          { abortSignal: abortController.signal },
        )) {
          if (event.type === 'child') {
            controller.enqueue(encoder.encode(sseMessage('child', { content: event.content })));
          } else if (event.type === 'done') {
            controller.enqueue(
              encoder.encode(sseMessage('done', { children: event.children, proof: event.proof })),
            );
          }
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            sseMessage('error', {
              message: error instanceof Error ? error.message : 'AI 扩展失败',
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
