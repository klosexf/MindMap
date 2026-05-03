import { NextResponse } from 'next/server';
import { z } from 'zod';

import { generateAiSummary } from '@/lib/llm/generate';
import { mindMapTreeSchema } from '@/lib/types/mindmap';

export const runtime = 'nodejs';

const requestSchema = z.object({
  tree: mindMapTreeSchema,
});

export async function POST(req: Request) {
  const parseResult = requestSchema.safeParse(await req.json());
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: parseResult.error.issues[0]?.message || 'Invalid request',
      },
      { status: 400 },
    );
  }

  try {
    const result = await generateAiSummary(parseResult.data.tree);
    return NextResponse.json({
      points: result.points,
      proof: {
        source: result.source,
        provider: result.provider,
        model: result.model,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'summary generation failed';
    return NextResponse.json(
      {
        error: message,
      },
      { status: 502 },
    );
  }
}
