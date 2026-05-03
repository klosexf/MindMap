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

  it('accepts persisted node positions for drag placement', () => {
    const now = Date.now();
    const parsed = mindMapTreeSchema.parse({
      id: 'tree_position',
      root: {
        id: 'root',
        content: 'Root',
        children: [
          {
            id: 'child_position',
            content: 'Child',
            position: { x: 180.25, y: -40.5 },
            children: [],
            meta: {
              sourceRef: { type: 'text', text: 'sample' },
              createdAt: now,
              createdBy: 'user',
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

    expect(parsed.root.children?.[0].position).toEqual({ x: 180.25, y: -40.5 });
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
