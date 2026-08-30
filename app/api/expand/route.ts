import { NextResponse } from 'next/server';
import { z } from 'zod';

import { generateBranchExpansion } from '@/lib/llm/generate';
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

  try {
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

    const result = await generateBranchExpansion({
      focusContent: node.content,
      pathTitles,
      siblingTitles,
      existingChildren: (node.children || []).map((child) => child.content),
      documentMarkdown: normalizedDocument?.markdown,
    });

    return NextResponse.json({
      children: result.children,
      proof: {
        source: result.source,
        provider: result.provider,
        model: result.model,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 扩展失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
