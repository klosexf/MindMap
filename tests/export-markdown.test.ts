import { describe, expect, it } from 'vitest';

import type { MindMapNode } from '../lib/types/mindmap';
import { treeToMarkdown } from '../lib/utils/tree';

describe('treeToMarkdown', () => {
  it('exports hierarchical markdown', () => {
    const root: MindMapNode = {
      id: 'root',
      content: 'Root Topic',
      meta: {
        sourceRef: { type: 'text', text: 'root' },
        createdAt: Date.now(),
        createdBy: 'ai',
        type: 'main',
      },
      children: [
        {
          id: 'c1',
          content: 'Child A',
          meta: {
            sourceRef: { type: 'text', text: 'a' },
            createdAt: Date.now(),
            createdBy: 'ai',
            type: 'detail',
          },
          children: [],
        },
      ],
    };

    const markdown = treeToMarkdown(root);
    expect(markdown).toContain('# Root Topic');
    expect(markdown).toContain('- Child A');
  });
});
