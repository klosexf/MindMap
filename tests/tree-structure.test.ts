import { describe, expect, it } from 'vitest';

import type { MindMapTree } from '../lib/types/mindmap';
import {
  applyTreePatch,
  findClosestRectByBorderProximity,
  findParentInfo,
  inferDropModeFromPoint,
  isDescendant,
  removeNode,
  resolveDropMoveTarget,
} from '../lib/utils/tree';

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

  it('moves a subtree into a nested target branch and preserves descendants', () => {
    const tree = sampleTree();

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'a',
      newParentId: 'b',
      newIndex: 0,
      timestamp: Date.now(),
    });

    const branchB = moved.root.children?.find((c) => c.id === 'b');
    expect(branchB?.children?.[0]?.id).toBe('a');
    expect(branchB?.children?.[0]?.children?.map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(moved.root.children?.map((c) => c.id)).toEqual(['b', 'c', 'd']);
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

describe('findParentInfo', () => {
  it('returns parent id and index for direct child', () => {
    const tree = sampleTree();
    expect(findParentInfo(tree.root, 'c')).toEqual({ parentId: 'root', index: 2 });
  });

  it('returns parent id and index for nested child', () => {
    const tree = sampleTree();
    expect(findParentInfo(tree.root, 'a2')).toEqual({ parentId: 'a', index: 1 });
  });

  it('returns null for root and unknown node', () => {
    const tree = sampleTree();
    expect(findParentInfo(tree.root, 'root')).toBeNull();
    expect(findParentInfo(tree.root, 'missing')).toBeNull();
  });
});

describe('resolveDropMoveTarget', () => {
  it('resolves child mode to append under target node', () => {
    const tree = sampleTree();
    expect(resolveDropMoveTarget(tree.root, 'b', 'a', 'child')).toEqual({
      newParentId: 'a',
      newIndex: 2,
    });
  });

  it('resolves child mode for nested cross-branch drops', () => {
    const tree = sampleTree();
    expect(resolveDropMoveTarget(tree.root, 'd', 'a1', 'child')).toEqual({
      newParentId: 'a1',
      newIndex: 0,
    });
  });

  it('resolves sibling mode after target with same parent index adjustment', () => {
    const tree = sampleTree();
    const target = resolveDropMoveTarget(tree.root, 'a', 'c', 'sibling');
    expect(target).toEqual({ newParentId: 'root', newIndex: 2 });

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'a',
      newParentId: target!.newParentId,
      newIndex: target!.newIndex,
      timestamp: Date.now(),
    });

    expect(moved.root.children?.map((n) => n.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('resolves sibling mode for move from later index to earlier target', () => {
    const tree = sampleTree();
    const target = resolveDropMoveTarget(tree.root, 'd', 'b', 'sibling');
    expect(target).toEqual({ newParentId: 'root', newIndex: 2 });

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'd',
      newParentId: target!.newParentId,
      newIndex: target!.newIndex,
      timestamp: Date.now(),
    });

    expect(moved.root.children?.map((n) => n.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('supports sibling insertion before target', () => {
    const tree = sampleTree();
    const target = resolveDropMoveTarget(tree.root, 'd', 'b', 'sibling', 'before');
    expect(target).toEqual({ newParentId: 'root', newIndex: 1 });

    const moved = applyTreePatch(tree, {
      type: 'move',
      nodeId: 'd',
      newParentId: target!.newParentId,
      newIndex: target!.newIndex,
      timestamp: Date.now(),
    });

    expect(moved.root.children?.map((n) => n.id)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('rejects invalid sibling/child moves', () => {
    const tree = sampleTree();
    expect(resolveDropMoveTarget(tree.root, 'a', 'a1', 'child')).toBeNull();
    expect(resolveDropMoveTarget(tree.root, 'a', 'a1', 'sibling')).toBeNull();
    expect(resolveDropMoveTarget(tree.root, 'b', 'root', 'sibling')).toBeNull();
    expect(resolveDropMoveTarget(tree.root, 'b', 'b', 'child')).toBeNull();
  });
});

describe('inferDropModeFromPoint', () => {
  const rect = { left: 100, top: 100, width: 200, height: 80 };

  it('treats center area as child mode', () => {
    expect(inferDropModeFromPoint({ x: 200, y: 140 }, rect)).toBe('child');
  });

  it('treats direct drops inside most of a node body as child mode', () => {
    expect(inferDropModeFromPoint({ x: 140, y: 140 }, rect)).toBe('child');
    expect(inferDropModeFromPoint({ x: 260, y: 140 }, rect)).toBe('child');
  });

  it('treats side areas as sibling mode', () => {
    expect(inferDropModeFromPoint({ x: 110, y: 140 }, rect)).toBe('sibling');
    expect(inferDropModeFromPoint({ x: 290, y: 140 }, rect)).toBe('sibling');
  });

  it('uses top and bottom edge bands for sibling mode in vertical layouts', () => {
    expect(inferDropModeFromPoint({ x: 200, y: 110 }, rect, 'TB')).toBe('sibling');
    expect(inferDropModeFromPoint({ x: 200, y: 140 }, rect, 'TB')).toBe('child');
    expect(inferDropModeFromPoint({ x: 200, y: 170 }, rect, 'TB')).toBe('sibling');
  });
});

describe('findClosestRectByBorderProximity', () => {
  const draggingRect = { left: 100, top: 100, width: 120, height: 56 };

  it('selects a target when the dragged node border is within the proximity threshold', () => {
    expect(
      findClosestRectByBorderProximity(draggingRect, [
        { id: 'target', rect: { left: 244, top: 104, width: 120, height: 56 } },
      ], 36),
    ).toEqual({ id: 'target', distance: 24 });
  });

  it('does not select a target when every border is outside the proximity threshold', () => {
    expect(
      findClosestRectByBorderProximity(draggingRect, [
        { id: 'target', rect: { left: 270, top: 104, width: 120, height: 56 } },
      ], 36),
    ).toBeNull();
  });

  it('chooses the nearest border match in dense layouts', () => {
    expect(
      findClosestRectByBorderProximity(draggingRect, [
        { id: 'far', rect: { left: 252, top: 100, width: 120, height: 56 } },
        { id: 'near', rect: { left: 242, top: 98, width: 120, height: 56 } },
      ], 36),
    ).toEqual({ id: 'near', distance: 22 });
  });

  it('uses diagonal border distance instead of center distance', () => {
    const match = findClosestRectByBorderProximity(draggingRect, [
      { id: 'diagonal', rect: { left: 238, top: 174, width: 120, height: 56 } },
    ], 36);

    expect(match?.id).toBe('diagonal');
    expect(match?.distance).toBeCloseTo(Math.sqrt(18 ** 2 + 18 ** 2), 5);
  });
});
