import { describe, expect, it } from 'vitest';

import type { MindMapTree } from '../lib/types/mindmap';
import { applyTreePatch, countNodes } from '../lib/utils/tree';

function sampleTree(): MindMapTree {
  const now = Date.now();
  return {
    id: 'tree',
    root: {
      id: 'root',
      content: 'Root',
      children: [],
      collapsed: false,
      meta: {
        sourceRef: { type: 'text', text: 'root' },
        createdAt: now,
        createdBy: 'ai',
        type: 'main',
      },
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

describe('applyTreePatch', () => {
  it('supports add/update/toggle/delete', () => {
    const tree = sampleTree();

    const added = applyTreePatch(tree, {
      type: 'add',
      nodeId: 'child1',
      parentId: 'root',
      index: 0,
      node: {
        id: 'child1',
        content: 'Child 1',
        children: [],
        collapsed: false,
        meta: {
          sourceRef: { type: 'text', text: 'child' },
          createdAt: Date.now(),
          createdBy: 'user',
          type: 'detail',
        },
      },
      timestamp: Date.now(),
    });

    expect(countNodes(added.root)).toBe(2);

    const updated = applyTreePatch(added, {
      type: 'update',
      nodeId: 'child1',
      node: { content: 'Child 1 updated' },
      timestamp: Date.now(),
    });

    expect(updated.root.children?.[0].content).toBe('Child 1 updated');

    const toggled = applyTreePatch(updated, {
      type: 'toggleCollapse',
      nodeId: 'child1',
      timestamp: Date.now(),
    });

    expect(toggled.root.children?.[0].collapsed).toBe(true);

    const deleted = applyTreePatch(toggled, {
      type: 'delete',
      nodeId: 'child1',
      timestamp: Date.now(),
    });

    expect(countNodes(deleted.root)).toBe(1);
  });
});
