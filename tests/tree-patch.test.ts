import { describe, expect, it } from 'vitest';

import type { MindMapTree } from '../lib/types/mindmap';
import { applyTreePatch, clearNodePositions, countNodes, findNode } from '../lib/utils/tree';

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

  it('stores node position patches without changing node content or children', () => {
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

    const positioned = applyTreePatch(added, {
      type: 'position',
      nodeId: 'child1',
      position: { x: 320.5, y: -140.25 },
      timestamp: Date.now(),
    });

    expect(positioned.root.children?.[0]).toMatchObject({
      id: 'child1',
      content: 'Child 1',
      position: { x: 320.5, y: -140.25 },
      children: [],
    });
    expect(positioned.meta.version).toBe(added.meta.version + 1);
    expect(positioned.root.children?.[0].meta.editedBy).toBe('user');
  });

  it('move patch clears position on the moved node so layout can recalculate', () => {
    const tree = sampleTree();

    let built = tree;
    built = applyTreePatch(built, {
      type: 'add',
      nodeId: 'parentA',
      parentId: 'root',
      index: 0,
      node: { id: 'parentA', content: 'Parent A', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });
    built = applyTreePatch(built, {
      type: 'add',
      nodeId: 'parentB',
      parentId: 'root',
      index: 1,
      node: { id: 'parentB', content: 'Parent B', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });
    built = applyTreePatch(built, {
      type: 'add',
      nodeId: 'childA1',
      parentId: 'parentA',
      index: 0,
      node: { id: 'childA1', content: 'Child A1', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });

    // Set a position on childA1 before moving (simulating a previous position-only drag)
    built = applyTreePatch(built, {
      type: 'position',
      nodeId: 'childA1',
      position: { x: 100, y: 200 },
      timestamp: Date.now(),
    });
    expect(findNode(built.root, 'childA1')?.position).toEqual({ x: 100, y: 200 });

    // Move childA1 from parentA to parentB
    const moved = applyTreePatch(built, {
      type: 'move',
      nodeId: 'childA1',
      newParentId: 'parentB',
      newIndex: 0,
      timestamp: Date.now(),
    });

    // The moved node's position should be cleared
    const movedNode = findNode(moved.root, 'childA1');
    expect(movedNode?.position).toBeUndefined();

    // The node should now be under parentB
    const parentB = findNode(moved.root, 'parentB');
    expect(parentB?.children?.length).toBe(1);
    expect(parentB?.children?.[0].id).toBe('childA1');

    // Parent A should no longer have childA1
    const parentA = findNode(moved.root, 'parentA');
    expect(parentA?.children?.length).toBe(0);

    // Position of unaffected sibling (parentB) should remain unchanged
    // (parentB had no position set, so it remains undefined)
  });

  it('move patch recursively clears positions in the moved subtree', () => {
    const tree = sampleTree();

    let built = tree;
    built = applyTreePatch(built, {
      type: 'add',
      nodeId: 'parentA',
      parentId: 'root',
      index: 0,
      node: { id: 'parentA', content: 'Parent A', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });
    built = applyTreePatch(built, {
      type: 'add',
      nodeId: 'parentB',
      parentId: 'root',
      index: 1,
      node: { id: 'parentB', content: 'Parent B', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });
    built = applyTreePatch(built, {
      type: 'add',
      nodeId: 'node1',
      parentId: 'parentA',
      index: 0,
      node: { id: 'node1', content: 'Node 1', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });
    built = applyTreePatch(built, {
      type: 'add',
      nodeId: 'node1child',
      parentId: 'node1',
      index: 0,
      node: { id: 'node1child', content: 'Node 1 child', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });
    built = applyTreePatch(built, {
      type: 'add',
      nodeId: 'node1grandchild',
      parentId: 'node1child',
      index: 0,
      node: { id: 'node1grandchild', content: 'Grandchild', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });

    // Set positions across the subtree
    built = applyTreePatch(built, { type: 'position', nodeId: 'node1', position: { x: 10, y: 20 }, timestamp: Date.now() });
    built = applyTreePatch(built, { type: 'position', nodeId: 'node1child', position: { x: 30, y: 40 }, timestamp: Date.now() });
    built = applyTreePatch(built, { type: 'position', nodeId: 'node1grandchild', position: { x: 50, y: 60 }, timestamp: Date.now() });

    // Move the entire subtree from parentA to parentB
    const moved = applyTreePatch(built, {
      type: 'move',
      nodeId: 'node1',
      newParentId: 'parentB',
      newIndex: 0,
      timestamp: Date.now(),
    });

    // All positions in the moved subtree should be cleared
    expect(findNode(moved.root, 'node1')?.position).toBeUndefined();
    expect(findNode(moved.root, 'node1child')?.position).toBeUndefined();
    expect(findNode(moved.root, 'node1grandchild')?.position).toBeUndefined();

    // The subtree structure should be intact
    const node1 = findNode(moved.root, 'node1');
    expect(node1?.children?.length).toBe(1);
    expect(node1?.children?.[0].id).toBe('node1child');
    expect(node1?.children?.[0].children?.[0].id).toBe('node1grandchild');

    // Node should be under parentB now
    const parentB = findNode(moved.root, 'parentB');
    expect(parentB?.children?.[0].id).toBe('node1');
  });

  it('position patch still works independently (not affected by move fix)', () => {
    const tree = sampleTree();

    let built = applyTreePatch(tree, {
      type: 'add',
      nodeId: 'node1',
      parentId: 'root',
      index: 0,
      node: { id: 'node1', content: 'Node', children: [], collapsed: false, meta: { sourceRef: { type: 'text' }, createdAt: Date.now(), createdBy: 'user', type: 'detail' } },
      timestamp: Date.now(),
    });

    // Apply position
    built = applyTreePatch(built, {
      type: 'position',
      nodeId: 'node1',
      position: { x: 50, y: 100 },
      timestamp: Date.now(),
    });

    expect(findNode(built.root, 'node1')?.position).toEqual({ x: 50, y: 100 });

    // Update position again
    built = applyTreePatch(built, {
      type: 'position',
      nodeId: 'node1',
      position: { x: 150, y: 250 },
      timestamp: Date.now(),
    });

    expect(findNode(built.root, 'node1')?.position).toEqual({ x: 150, y: 250 });

    // Content and children should remain unchanged
    const node = findNode(built.root, 'node1');
    expect(node?.content).toBe('Node');
    expect(node?.children).toEqual([]);
  });

  it('clearNodePositions removes position from node and all descendants', () => {
    const node = {
      id: 'n1',
      content: 'Test',
      position: { x: 10, y: 20 },
      children: [
        {
          id: 'n2',
          content: 'Child',
          position: { x: 30, y: 40 },
          children: [
            {
              id: 'n3',
              content: 'Grandchild',
              position: { x: 50, y: 60 },
              children: [],
              collapsed: false,
              meta: { sourceRef: { type: 'text' as const }, createdAt: Date.now(), createdBy: 'user' as const, type: 'detail' as const },
            },
          ],
          collapsed: false,
          meta: { sourceRef: { type: 'text' as const }, createdAt: Date.now(), createdBy: 'user' as const, type: 'detail' as const },
        },
      ],
      collapsed: false,
      meta: { sourceRef: { type: 'text' as const }, createdAt: Date.now(), createdBy: 'user' as const, type: 'detail' as const },
    };

    clearNodePositions(node);

    expect(node.position).toBeUndefined();
    expect(node.children[0].position).toBeUndefined();
    expect(node.children[0].children[0].position).toBeUndefined();

    // Content and structure should be preserved
    expect(node.content).toBe('Test');
    expect(node.children.length).toBe(1);
    expect(node.children[0].content).toBe('Child');
    expect(node.children[0].children.length).toBe(1);
  });
});
