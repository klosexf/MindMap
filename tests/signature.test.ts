import { describe, expect, it } from 'vitest';

import { buildTreeSignature } from '@/lib/utils/signature';
import { applyTreePatch } from '@/lib/utils/tree';
import type { MindMapTree } from '@/lib/types/mindmap';

const baseTree: MindMapTree = {
  id: 'tree_1',
  root: {
    id: 'root_1',
    content: 'Root Node',
    collapsed: false,
    meta: {
      sourceRef: { type: 'text', text: 'Root Node' },
      confidence: 1,
      type: 'main',
      createdAt: 1,
      createdBy: 'ai',
    },
    children: [
      {
        id: 'node_a',
        content: 'Child A',
        collapsed: false,
        meta: {
          sourceRef: { type: 'text', text: 'Child A' },
          confidence: 1,
          type: 'detail',
          createdAt: 2,
          createdBy: 'ai',
        },
        children: [
          {
            id: 'node_a1',
            content: 'Grandchild A1',
            collapsed: false,
            meta: {
              sourceRef: { type: 'text', text: 'Grandchild A1' },
              confidence: 1,
              type: 'detail',
              createdAt: 3,
              createdBy: 'ai',
            },
            children: [],
          },
        ],
      },
      {
        id: 'node_b',
        content: 'Child B',
        collapsed: false,
        meta: {
          sourceRef: { type: 'text', text: 'Child B' },
          confidence: 1,
          type: 'detail',
          createdAt: 4,
          createdBy: 'ai',
        },
        children: [],
      },
      {
        id: 'node_c',
        content: 'Child C',
        collapsed: false,
        meta: {
          sourceRef: { type: 'text', text: 'Child C' },
          confidence: 1,
          type: 'detail',
          createdAt: 5,
          createdBy: 'ai',
        },
        children: [],
      },
    ],
  },
  meta: {
    title: 'Test Tree',
    sourceType: 'text',
    createdAt: 1,
    updatedAt: 2,
    version: 1,
    truncated: false,
  },
};

describe('buildTreeSignature', () => {
  it('produces same signature for same tree (idempotent)', () => {
    const s1 = buildTreeSignature(baseTree);
    const s2 = buildTreeSignature(baseTree);
    expect(s1).toBe(s2);
  });

  it('signature does NOT change when node is moved to different parent', () => {
    const moved = applyTreePatch(baseTree, {
      type: 'move',
      nodeId: 'node_a1',
      newParentId: 'node_b',
      newIndex: 0,
      timestamp: Date.now(),
    });
    expect(buildTreeSignature(baseTree)).toBe(buildTreeSignature(moved));
  });

  it('signature does NOT change when node position (x,y) is updated', () => {
    const repositioned = applyTreePatch(baseTree, {
      type: 'position',
      nodeId: 'node_a',
      position: { x: 500, y: 300 },
      timestamp: Date.now(),
    });
    expect(buildTreeSignature(baseTree)).toBe(buildTreeSignature(repositioned));
  });

  it('signature does NOT change when node is collapsed/expanded', () => {
    const toggled = applyTreePatch(baseTree, {
      type: 'toggleCollapse',
      nodeId: 'node_a',
      timestamp: Date.now(),
    });
    expect(buildTreeSignature(baseTree)).toBe(buildTreeSignature(toggled));
  });

  it('signature does NOT change after multiple consecutive move operations', () => {
    let tree = baseTree;
    // Move grandchild to node_b
    tree = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'node_a1',
      newParentId: 'node_b',
      newIndex: 0,
      timestamp: Date.now(),
    });
    // Move node_c to be under node_a
    tree = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'node_c',
      newParentId: 'node_a',
      newIndex: 0,
      timestamp: Date.now(),
    });
    // Move node_b (now with grandchild) under node_c's new position
    tree = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'node_b',
      newParentId: 'node_a',
      newIndex: 1,
      timestamp: Date.now(),
    });
    expect(buildTreeSignature(baseTree)).toBe(buildTreeSignature(tree));
  });

  it('signature DOES change when node content is updated', () => {
    const updated = applyTreePatch(baseTree, {
      type: 'update',
      nodeId: 'node_a',
      node: { content: 'Child A - Modified' },
      timestamp: Date.now(),
    });
    expect(buildTreeSignature(baseTree)).not.toBe(buildTreeSignature(updated));
  });

  it('signature DOES change when a new node is added', () => {
    const added = applyTreePatch(baseTree, {
      type: 'add',
      nodeId: 'node_d',
      parentId: 'root_1',
      index: 3,
      node: {
        id: 'node_d',
        content: 'Child D',
        collapsed: false,
        children: [],
        meta: {
          sourceRef: { type: 'text', text: 'Child D' },
          confidence: 1,
          type: 'detail',
          createdAt: Date.now(),
          createdBy: 'user',
        },
      },
      timestamp: Date.now(),
    });
    expect(buildTreeSignature(baseTree)).not.toBe(buildTreeSignature(added));
  });

  it('signature DOES change when a node is deleted', () => {
    const deleted = applyTreePatch(baseTree, {
      type: 'delete',
      nodeId: 'node_c',
      timestamp: Date.now(),
    });
    expect(buildTreeSignature(baseTree)).not.toBe(buildTreeSignature(deleted));
  });

  it('move + edit combination: move does not change, edit does change', () => {
    const moved = applyTreePatch(baseTree, {
      type: 'move',
      nodeId: 'node_c',
      newParentId: 'node_a',
      newIndex: 1,
      timestamp: Date.now(),
    });
    // After move, signature should be same as base
    expect(buildTreeSignature(baseTree)).toBe(buildTreeSignature(moved));

    // After editing content on the moved tree, signature should differ from base
    const movedThenEdited = applyTreePatch(moved, {
      type: 'update',
      nodeId: 'node_c',
      node: { content: 'Child C - Edited after move' },
      timestamp: Date.now(),
    });
    expect(buildTreeSignature(baseTree)).not.toBe(buildTreeSignature(movedThenEdited));
  });

  it('version changes do not affect signature', () => {
    // applyTreePatch always increments version, so let's verify two patches
    // that should produce same signature despite different versions
    const moved1 = applyTreePatch(baseTree, {
      type: 'move',
      nodeId: 'node_c',
      newParentId: 'node_b',
      newIndex: 0,
      timestamp: Date.now(),
    });
    expect(moved1.meta.version).toBe(baseTree.meta.version + 1);
    expect(buildTreeSignature(baseTree)).toBe(buildTreeSignature(moved1));

    const moved2 = applyTreePatch(moved1, {
      type: 'move',
      nodeId: 'node_a1',
      newParentId: 'node_c',
      newIndex: 0,
      timestamp: Date.now(),
    });
    expect(moved2.meta.version).toBe(baseTree.meta.version + 2);
    expect(buildTreeSignature(baseTree)).toBe(buildTreeSignature(moved2));
  });
});
