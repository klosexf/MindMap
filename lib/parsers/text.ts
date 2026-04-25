import { chunkMarkdown } from '@/lib/utils/chunk';
import { createSourceRefFallback } from '@/lib/utils/tree';
import type { NormalizedDocument } from '@/lib/types/mindmap';

export function parseTextInput(text: string): NormalizedDocument {
  const markdown = text.trim();
  const sourceRef = createSourceRefFallback({ type: 'text', text: markdown.slice(0, 240) });

  return {
    markdown,
    chunks: chunkMarkdown(markdown, sourceRef),
    sourceMeta: {
      type: 'text',
      title: markdown.split(/\n+/)[0]?.slice(0, 80) || 'Text Input',
    },
  };
}
