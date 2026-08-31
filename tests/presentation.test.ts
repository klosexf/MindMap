import { describe, expect, it } from 'vitest';

import type { MindMapNode, MindMapTree } from '../lib/types/mindmap';
import { buildPresentationSteps, collapseAllForPresentation } from '../lib/utils/presentation';

function makeNode(id: string, children: MindMapNode[] = [], collapsed = false): MindMapNode {
  return {
    id,
    content: id,
    children,
    collapsed,
    meta: {
      sourceRef: { type: 'text', text: id },
      createdAt: 1,
      createdBy: 'user',
      type: 'detail',
    },
  };
}

function sampleTree(): MindMapTree {
  // root
  // ├── a (含 a1/a2)
  // │   └── a1 (含 a1-1)
  // └── b (叶)
  return {
    id: 'tree',
    root: makeNode('root', [
      makeNode('a', [makeNode('a1', [makeNode('a1-1')]), makeNode('a2')]),
      makeNode('b'),
    ]),
    meta: {
      title: 'demo',
      sourceType: 'text',
      createdAt: 1,
      updatedAt: 1,
      version: 3,
      truncated: false,
    },
  };
}

describe('collapseAllForPresentation', () => {
  it('collapses every node with children, leaves untouched elsewhere', () => {
    const tree = sampleTree();
    const collapsed = collapseAllForPresentation(tree);

    const byId = new Map<string, MindMapNode>();
    const walk = (node: MindMapNode) => {
      byId.set(node.id, node);
      node.children?.forEach(walk);
    };
    walk(collapsed.root);

    expect(byId.get('root')?.collapsed).toBe(true);
    expect(byId.get('a')?.collapsed).toBe(true);
    expect(byId.get('a1')?.collapsed).toBe(true);
    // 叶子节点不参与折叠
    expect(byId.get('a2')?.collapsed).toBe(false);
    expect(byId.get('a1-1')?.collapsed).toBe(false);
    expect(byId.get('b')?.collapsed).toBe(false);
  });

  it('does not mutate the input tree', () => {
    const tree = sampleTree();
    collapseAllForPresentation(tree);

    const original = tree.root.children?.[0];
    expect(original?.collapsed).toBe(false);
    expect(original?.children?.[0]?.collapsed).toBe(false);
  });

  it('keeps tree id and meta (version) intact so exit can restore the snapshot', () => {
    const tree = sampleTree();
    const collapsed = collapseAllForPresentation(tree);

    expect(collapsed.id).toBe(tree.id);
    expect(collapsed.meta.version).toBe(tree.meta.version);
  });
});

describe('buildPresentationSteps', () => {
  it('returns DFS preorder of branch nodes including the root, excluding leaves', () => {
    const tree = sampleTree();
    const steps = buildPresentationSteps(tree.root);

    // 前序：root → a → a1；b 与叶子不出现
    expect(steps).toEqual(['root', 'a', 'a1']);
  });

  it('returns only the root for a single-node map', () => {
    const steps = buildPresentationSteps(makeNode('root'));

    expect(steps).toEqual([]);
  });

  it('walks sibling branches one after another (DFS preorder, leaves excluded)', () => {
    // root
    // ├── b1（先深挖 b1 的整棵子树）
    // │   ├── b1-1（含 b1-1-1）
    // │   └── b1-2（叶）
    // └── b2（再进入 b2 分支）
    //     └── b2-1（叶）
    const root = makeNode('root', [
      makeNode('b1', [makeNode('b1-1', [makeNode('b1-1-1')]), makeNode('b1-2')]),
      makeNode('b2', [makeNode('b2-1')]),
    ]);
    const steps = buildPresentationSteps(root);

    expect(steps).toEqual(['root', 'b1', 'b1-1', 'b2']);
  });
});
