import { describe, expect, it } from 'vitest';

import { generateMindMapStream } from '../lib/llm/generate';
import type { NormalizedDocument } from '../lib/types/mindmap';

describe('generateMindMapStream', () => {
  it('emits skeleton and complete events in fallback mode', async () => {
    const doc: NormalizedDocument = {
      markdown: '# Title\n\nParagraph one. Paragraph two. Paragraph three.',
      chunks: [
        {
          id: 'chunk_1',
          text: 'Paragraph one. Paragraph two.',
          tokenEstimate: 20,
          sourceRef: { type: 'text', text: 'Paragraph one.' },
        },
      ],
      sourceMeta: {
        type: 'text',
        title: 'Demo Title',
      },
    };

    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = '';

    const events = [] as string[];

    for await (const event of generateMindMapStream(doc)) {
      events.push(event.type);
    }

    process.env.OPENAI_API_KEY = original;

    expect(events[0]).toBe('skeleton');
    expect(events.includes('complete')).toBe(true);
  });
});
