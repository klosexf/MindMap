import { NextResponse } from 'next/server';
import { z } from 'zod';

import { parseInput } from '@/lib/parsers';

export const runtime = 'nodejs';

const parseRequestSchema = z.object({
  type: z.enum(['text', 'url', 'pdf', 'prompt']),
  content: z.string().min(1),
  fileName: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const payload = parseRequestSchema.parse(await req.json());
    const normalizedDocument = await parseInput(payload);

    return NextResponse.json({ normalizedDocument });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Parse failed',
      },
      { status: 400 },
    );
  }
}
