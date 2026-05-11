import { NextResponse } from 'next/server';
import { z } from 'zod';

import { deleteMindMap, getMindMapRecord, patchMindMap, saveMindMap } from '@/lib/storage/mindmap-store';
import { mindMapTreeSchema, normalizedDocumentSchema, treePatchListSchema } from '@/lib/types/mindmap';

export const runtime = 'nodejs';

const patchRequestSchema = z.object({
  patches: treePatchListSchema.optional(),
  tree: mindMapTreeSchema.optional(),
  normalizedDocument: normalizedDocumentSchema.optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, { params }: Params) {
  const { id } = await params;
  const record = await getMindMapRecord(id);

  if (!record) {
    return NextResponse.json({ error: 'Mindmap not found' }, { status: 404 });
  }

  return NextResponse.json({ tree: record.tree, normalizedDocument: record.normalizedDocument });
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const payload = patchRequestSchema.parse(await req.json());

    if (payload.tree) {
      if (payload.tree.id !== id) {
        return NextResponse.json({ error: 'Tree id mismatch' }, { status: 400 });
      }

      const saved = await saveMindMap(payload.tree, payload.normalizedDocument);
      return NextResponse.json({ tree: saved, normalizedDocument: payload.normalizedDocument });
    }

    if (!payload.patches) {
      return NextResponse.json({ error: 'Missing patches or tree payload' }, { status: 400 });
    }

    const updated = await patchMindMap(id, payload.patches);
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

export async function DELETE(_: Request, { params }: Params) {
  const { id } = await params;
  const deleted = await deleteMindMap(id);

  if (!deleted) {
    return NextResponse.json({ error: 'Mindmap not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
