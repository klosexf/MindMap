import { describe, expect, it } from 'vitest';

import { generateMindMapStream } from '../lib/llm/generate';
import type { MindMapTree, NormalizedDocument } from '../lib/types/mindmap';

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

  it('uses document chunks as fallback branches when no LLM key is configured', async () => {
    const doc: NormalizedDocument = {
      markdown: [
        '# Demo PDF',
        '',
        '## Page 1',
        '',
        'Authentication flow changes. Users receive progress reminders.',
        '',
        '## Page 2',
        '',
        'Enterprise certification changes. Signing QR codes are simplified.',
      ].join('\n'),
      chunks: [
        {
          id: 'page_1',
          text: '## Page 1\n\nAuthentication flow changes. Users receive progress reminders.',
          tokenEstimate: 18,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: 'Authentication flow changes.' },
        },
        {
          id: 'page_2',
          text: '## Page 2\n\nEnterprise certification changes. Signing QR codes are simplified.',
          tokenEstimate: 18,
          sourceRef: { type: 'pdf', page: 2, location: 'page:2', text: 'Enterprise certification changes.' },
        },
      ],
      sourceMeta: {
        type: 'pdf',
        title: 'Demo PDF',
        sourceFileName: 'demo.pdf',
      },
    };

    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = '';

    let completeTree: MindMapTree | null = null;
    for await (const event of generateMindMapStream(doc)) {
      if (event.type === 'complete') {
        completeTree = event.data.tree;
      }
    }

    process.env.OPENAI_API_KEY = original;

    const branchTitles = completeTree?.root.children?.map((child) => child.content);
    expect(branchTitles).toEqual(['Page 1', 'Page 2']);
    expect(completeTree?.root.children?.[0].children?.[0].content).toContain('Authentication flow changes');
    expect(completeTree?.root.children?.[1].meta.sourceRef.page).toBe(2);
  });
});
