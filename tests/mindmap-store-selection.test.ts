import { afterEach, describe, expect, it } from 'vitest';

import type { MindMapTree } from '../lib/types/mindmap';
import { useMindMapStore } from '../store/mindmap-store';

function sampleTree(): MindMapTree {
  const now = Date.now();
  return {
    id: 'tree',
    root: {
      id: 'root',
      content: 'Root',
      collapsed: false,
      meta: {
        sourceRef: { type: 'text', text: 'root' },
        createdAt: now,
        createdBy: 'ai',
        type: 'main',
      },
      children: [
        {
          id: 'parent',
          content: 'Parent',
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'parent' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail',
          },
          children: [
            {
              id: 'child',
              content: '',
              collapsed: false,
              meta: {
                sourceRef: { type: 'text', text: 'child' },
                createdAt: now,
                createdBy: 'user',
                type: 'detail',
              },
              children: [],
            },
          ],
        },
      ],
    },
    meta: {
      sourceType: 'text',
      title: 'demo',
      createdAt: now,
      updatedAt: now,
      version: 1,
      truncated: false,
    },
  };
}

afterEach(() => {
  useMindMapStore.setState({
    tree: null,
    selectedNodeId: null,
    pending: false,
    layoutDirection: 'LR',
  });
});

describe('mindmap store selection fallback', () => {
  it('keeps selection on the deleted node parent instead of jumping back to root', () => {
    useMindMapStore.setState({
      tree: sampleTree(),
      selectedNodeId: 'child',
      pending: false,
      layoutDirection: 'LR',
    });

    useMindMapStore.getState().deleteNode('child');

    expect(useMindMapStore.getState().selectedNodeId).toBe('parent');
  });
});
