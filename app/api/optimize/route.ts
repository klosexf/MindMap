import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  convertOptimizedTreeToMindMapTree,
  generateTreeOptimization,
  type TreeOptimizeMode,
} from '@/lib/llm/generate';
import { mindMapTreeSchema, normalizedDocumentSchema } from '@/lib/types/mindmap';

export const runtime = 'nodejs';

const requestSchema = z.object({
  tree: mindMapTreeSchema,
  mode: z.enum(['simplify', 'restructure']),
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

  const { tree, mode, normalizedDocument } = parseResult.data;

  try {
    const result = await generateTreeOptimization(tree, {
      mode: mode as TreeOptimizeMode,
      documentMarkdown: normalizedDocument?.markdown,
    });

    const optimizedTree = convertOptimizedTreeToMindMapTree(result.tree, {
      ...tree,
      meta: {
        ...tree.meta,
        title: result.tree.title || tree.meta.title,
      },
    });

    return NextResponse.json({
      tree: optimizedTree,
      proof: {
        source: result.source,
        provider: result.provider,
        model: result.model,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 优化失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
