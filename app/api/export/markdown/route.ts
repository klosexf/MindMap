import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getMindMap } from '@/lib/storage/mindmap-store';
import { mindMapTreeSchema } from '@/lib/types/mindmap';
import { treeToMarkdown } from '@/lib/utils/tree';

export const runtime = 'nodejs';

const bodySchema = z.object({
  id: z.string().optional(),
  tree: mindMapTreeSchema.optional(),
});

export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());

    const tree = body.tree ?? (body.id ? await getMindMap(body.id) : null);
    if (!tree) {
      return NextResponse.json({ error: 'Mindmap not found' }, { status: 404 });
    }

    const markdown = treeToMarkdown(tree.root);
    return NextResponse.json({
      markdown,
      fileName: `${tree.meta.title || 'mindmap'}.md`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Markdown export failed' },
      { status: 400 },
    );
  }
}
