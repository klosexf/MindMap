import { describe, expect, it } from 'vitest';

import { mindMapTreeSchema } from '../lib/types/mindmap';

describe('mindMapTreeSchema', () => {
  it('accepts valid tree with sourceRef on every node', () => {
    const now = Date.now();
    const parsed = mindMapTreeSchema.parse({
      id: 'tree_1',
      root: {
        id: 'root',
        content: 'Root',
        children: [
          {
            id: 'child_1',
            content: 'Child',
            children: [],
            meta: {
              sourceRef: { type: 'text', text: 'sample' },
              createdAt: now,
              createdBy: 'ai',
              type: 'detail',
            },
          },
        ],
        meta: {
          sourceRef: { type: 'text', text: 'sample' },
          createdAt: now,
          createdBy: 'ai',
          type: 'main',
        },
      },
      meta: {
        title: 'demo',
        sourceType: 'text',
        createdAt: now,
        updatedAt: now,
        version: 1,
        truncated: false,
      },
    });

    expect(parsed.root.children?.[0].meta.sourceRef.type).toBe('text');
  });

  it('rejects nodes without sourceRef', () => {
    const now = Date.now();
    const result = mindMapTreeSchema.safeParse({
      id: 'tree_2',
      root: {
        id: 'root',
        content: 'Root',
        children: [],
        meta: {
          createdAt: now,
          createdBy: 'ai',
          type: 'main',
        },
      },
      meta: {
        sourceType: 'text',
        createdAt: now,
        updatedAt: now,
        version: 1,
        truncated: false,
      },
    });

    expect(result.success).toBe(false);
  });
});
