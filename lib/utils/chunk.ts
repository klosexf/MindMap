import { nanoid } from 'nanoid';
import type { ParsedChunk, SourceReference } from '@/lib/types/mindmap';

const TARGET_MIN_TOKENS = 800;
const TARGET_MAX_TOKENS = 1200;
const OVERLAP_RATIO = 0.1;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function chunkMarkdown(markdown: string, sourceRef: SourceReference): ParsedChunk[] {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return [
      {
        id: nanoid(),
        text: markdown.trim(),
        tokenEstimate: estimateTokens(markdown),
        sourceRef,
      },
    ];
  }

  const chunks: ParsedChunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  function flushChunk(): void {
    if (!current.length) return;

    const text = current.join('\n\n').trim();
    if (!text) return;

    chunks.push({
      id: nanoid(),
      text,
      tokenEstimate: estimateTokens(text),
      sourceRef,
    });

    const overlapTokensTarget = Math.floor(currentTokens * OVERLAP_RATIO);
    if (overlapTokensTarget <= 0) {
      current = [];
      currentTokens = 0;
      return;
    }

    const overlap: string[] = [];
    let overlapTokens = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const p = current[i];
      overlap.unshift(p);
      overlapTokens += estimateTokens(p);
      if (overlapTokens >= overlapTokensTarget) break;
    }

    current = overlap;
    currentTokens = overlapTokens;
  }

  for (const paragraph of paragraphs) {
    const tokens = estimateTokens(paragraph);

    if (currentTokens + tokens > TARGET_MAX_TOKENS && currentTokens >= TARGET_MIN_TOKENS) {
      flushChunk();
    }

    current.push(paragraph);
    currentTokens += tokens;

    if (currentTokens >= TARGET_MAX_TOKENS) {
      flushChunk();
    }
  }

  flushChunk();

  return chunks;
}
