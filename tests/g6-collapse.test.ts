import { describe, expect, it } from 'vitest';

import { toG6GraphData } from '../lib/utils/g6';
import type { MindMapNode, MindMapTree } from '../lib/types/mindmap';

function makeNode(id: string, content: string, children: MindMapNode[] = [], collapsed = false): MindMapNode {
  return {
    id,
    content,
    collapsed,
    children,
    meta: {
      sourceRef: { type: 'text', text: content },
      createdAt: 1,
      createdBy: 'user',
      type: 'detail',
    },
  };
}

function sampleTree(): MindMapTree {
  return {
    id: 'tree',
    root: makeNode('root', 'Root', [
      makeNode('a', 'A', [makeNode('a1', 'A1'), makeNode('a2', 'A2')], true),
      makeNode('b', 'B', [makeNode('b1', 'B1')]),
    ]),
    meta: {
      sourceType: 'text',
      title: 'demo',
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      truncated: false,
    },
  };
}

describe('toG6GraphData collapse pruning & badge', () => {
  it('removes nodes and edges under a collapsed subtree', () => {
    const graph = toG6GraphData(sampleTree(), 'LR');

    const nodeIds = (graph.nodes || []).map((node) => node.id);
    expect(nodeIds).toEqual(['root', 'a', 'b', 'b1']);

    const edgePairs = (graph.edges || []).map((edge) => `${edge.source}->${edge.target}`);
    expect(edgePairs).toEqual(['root->a', 'root->b', 'b->b1']);
  });

  it('adds a badge with the hidden child count on the collapsed node', () => {
    const graph = toG6GraphData(sampleTree(), 'LR');

    const nodeA = (graph.nodes || []).find((node) => node.id === 'a') as {
      style?: { badges?: Array<{ text?: string; placement?: string }> };
      data?: { collapsed?: boolean; collapsedChildCount?: number };
    };

    expect(nodeA?.data?.collapsed).toBe(true);
    expect(nodeA?.data?.collapsedChildCount).toBe(2);
    expect(nodeA?.style?.badges).toHaveLength(1);
    expect(nodeA?.style?.badges?.[0]?.text).toBe('2');
    expect(nodeA?.style?.badges?.[0]?.placement).toBe('right');
  });

  it('adds no badge on expanded nodes or childless collapsed nodes', () => {
    const tree = sampleTree();
    const childless = makeNode('c', 'C', [], true);
    tree.root.children?.push(childless);

    const graph = toG6GraphData(tree, 'LR');

    for (const node of graph.nodes || []) {
      const style = (node as { style?: { badges?: unknown[] } }).style;
      if (node.id === 'a') continue;
      expect(style?.badges ?? []).toHaveLength(0);
    }
  });

  it('places the badge on the layout-direction side', () => {
    const graph = toG6GraphData(sampleTree(), 'RL');
    const nodeA = (graph.nodes || []).find((node) => node.id === 'a') as {
      style?: { badges?: Array<{ placement?: string }> };
    };

    expect(nodeA?.style?.badges?.[0]?.placement).toBe('left');
  });

  it('keeps the full tree intact (pruning must not mutate the input tree)', () => {
    const tree = sampleTree();
    toG6GraphData(tree, 'LR');

    const nodeA = tree.root.children?.[0];
    expect(nodeA?.children).toHaveLength(2);
  });
});
