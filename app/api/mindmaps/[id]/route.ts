import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getMindMap, patchMindMap, saveMindMap } from '@/lib/storage/mindmap-store';
import { mindMapTreeSchema, treePatchListSchema } from '@/lib/types/mindmap';

export const runtime = 'nodejs';

const patchRequestSchema = z.object({
  patches: treePatchListSchema.optional(),
  tree: mindMapTreeSchema.optional(),
});

interface Params {
  params: { id: string };
}

export async function GET(_: Request, { params }: Params) {
  const tree = await getMindMap(params.id);

  if (!tree) {
    return NextResponse.json({ error: 'Mindmap not found' }, { status: 404 });
  }

  return NextResponse.json({ tree });
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const payload = patchRequestSchema.parse(await req.json());

    if (payload.tree) {
      if (payload.tree.id !== params.id) {
        return NextResponse.json({ error: 'Tree id mismatch' }, { status: 400 });
      }

      const saved = await saveMindMap(payload.tree);
      return NextResponse.json({ tree: saved });
    }

    if (!payload.patches) {
      return NextResponse.json({ error: 'Missing patches or tree payload' }, { status: 400 });
    }

    const updated = await patchMindMap(params.id, payload.patches);
    return NextResponse.json({ tree: updated });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Patch failed',
      },
      { status: 400 },
    );
  }
}
