import { NextResponse } from 'next/server';

import { listMindMaps } from '@/lib/storage/mindmap-store';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const summaries = await listMindMaps();
    return NextResponse.json({ mindmaps: summaries });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list mindmaps' },
      { status: 500 },
    );
  }
}
