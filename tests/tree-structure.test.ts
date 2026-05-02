import { describe, expect, it } from 'vitest';

import type { MindMapTree } from '../lib/types/mindmap';
import { applyTreePatch, balanceChildren, isDescendant, removeNode } from '../lib/utils/tree';

function makeNode(id: string, content: string, children: MindMapTree['root']['children'] = []) {
  const now = Date.now();
  return {
    id,
    content,
    children,
    collapsed: false,
    meta: {
      sourceRef: { type: 'text' as const, text: id },
      createdAt: now,
      createdBy: 'ai' as const,
      type: 'detail' as const,
    },
  };
}

function sampleTree(): MindMapTree {
  const now = Date.now();
  return {
    id: 'tree',
    root: {
      id: 'root',
      content: 'Root',
      children: [
        makeNode('a', 'A', [makeNode('a1', 'A1'), makeNode('a2', 'A2')]),
        makeNode('b', 'B'),
        makeNode('c', 'C'),
        makeNode('d', 'D'),
      ],
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

describe('applyTreePatch move', () => {
  it('moves a node to a new parent', () => {
    const tree = sampleTree();

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'b',
      newParentId: 'a',
      newIndex: 0,
      timestamp: Date.now(),
    });

    const aNode = moved.root.children?.find((c) => c.id === 'a');
    expect(aNode?.children?.map((c) => c.id)).toEqual(['b', 'a1', 'a2']);
    expect(moved.root.children?.map((c) => c.id)).toEqual(['a', 'c', 'd']);
  });

  it('refuses to move node to itself', () => {
    const tree = sampleTree();

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'a',
      newParentId: 'a',
      newIndex: 0,
      timestamp: Date.now(),
    });

    expect(moved.root.children?.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses to move root node', () => {
    const tree = sampleTree();

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'root',
      newParentId: 'a',
      newIndex: 0,
      timestamp: Date.now(),
    });

    expect(moved.root.id).toBe('root');
  });

  it('refuses to move node to its own descendant', () => {
    const tree = sampleTree();

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'a',
      newParentId: 'a1',
      newIndex: 0,
      timestamp: Date.now(),
    });

    expect(moved.root.children?.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moves node to end when newIndex exceeds children length', () => {
    const tree = sampleTree();

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'b',
      newParentId: 'a',
      newIndex: 999,
      timestamp: Date.now(),
    });

    const aNode = moved.root.children?.find((c) => c.id === 'a');
    expect(aNode?.children?.map((c) => c.id)).toEqual(['a1', 'a2', 'b']);
  });
});

describe('isDescendant', () => {
  it('returns true for direct child', () => {
    const tree = sampleTree();
    expect(isDescendant(tree.root, 'a', 'a1')).toBe(true);
  });

  it('returns true for nested descendant', () => {
    const tree = sampleTree();
    expect(isDescendant(tree.root, 'root', 'a1')).toBe(true);
  });

  it('returns false for non-descendant', () => {
    const tree = sampleTree();
    expect(isDescendant(tree.root, 'b', 'a1')).toBe(false);
  });

  it('returns false for same node', () => {
    const tree = sampleTree();
    expect(isDescendant(tree.root, 'a', 'a')).toBe(false);
  });
});

describe('removeNode', () => {
  it('removes a direct child', () => {
    const tree = sampleTree();
    const removed = removeNode(tree.root, 'b');
    expect(removed?.id).toBe('b');
    expect(tree.root.children?.map((c) => c.id)).toEqual(['a', 'c', 'd']);
  });

  it('removes a nested child', () => {
    const tree = sampleTree();
    const removed = removeNode(tree.root, 'a1');
    expect(removed?.id).toBe('a1');
    const aNode = tree.root.children?.find((c) => c.id === 'a');
    expect(aNode?.children?.map((c) => c.id)).toEqual(['a2']);
  });

  it('returns null for non-existent node', () => {
    const tree = sampleTree();
    const removed = removeNode(tree.root, 'nonexistent');
    expect(removed).toBeNull();
  });
});

describe('balanceChildren', () => {
  it('balances even number of children', () => {
    const tree = sampleTree();
    const balanced = balanceChildren(tree);

    expect(balanced.root.children?.map((c) => c.id)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('balances odd number of children', () => {
    const now = Date.now();
    const tree: MindMapTree = {
      id: 'tree',
      root: {
        id: 'root',
        content: 'Root',
        children: [makeNode('a', 'A'), makeNode('b', 'B'), makeNode('c', 'C')],
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

    const balanced = balanceChildren(tree);
    expect(balanced.root.children?.map((c) => c.id)).toEqual(['a', 'c', 'b']);
  });

  it('handles single child', () => {
    const now = Date.now();
    const tree: MindMapTree = {
      id: 'tree',
      root: {
        id: 'root',
        content: 'Root',
        children: [makeNode('a', 'A')],
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

    const balanced = balanceChildren(tree);
    expect(balanced.root.children?.map((c) => c.id)).toEqual(['a']);
  });

  it('handles empty children', () => {
    const now = Date.now();
    const tree: MindMapTree = {
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

    const balanced = balanceChildren(tree);
    expect(balanced.root.children).toEqual([]);
  });

  it('does not mutate original tree', () => {
    const tree = sampleTree();
    const originalIds = tree.root.children?.map((c) => c.id);
    balanceChildren(tree);
    expect(tree.root.children?.map((c) => c.id)).toEqual(originalIds);
  });
});
