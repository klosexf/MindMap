import { describe, expect, it } from 'vitest';

import type { MindMapTree } from '../lib/types/mindmap';
import { toG6GraphData } from '../lib/utils/g6';

function sampleTree(): MindMapTree {
  const now = Date.now();
  return {
    id: 'tree',
    root: {
      id: 'root',
      content: 'Root',
      children: [
        {
          id: 'child',
          content: 'Dragged child',
          position: { x: 412.75, y: -96.5 },
          children: [],
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'child' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail',
          },
        },
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

function branchingTree(): MindMapTree {
  const now = Date.now();
  return {
    id: 'tree-branching',
    root: {
      id: 'root',
      content: 'Root',
      children: [
        {
          id: 'solo',
          content: 'Solo child',
          children: [
            {
              id: 'grandchild',
              content: 'Grandchild',
              children: [],
              collapsed: false,
              meta: {
                sourceRef: { type: 'text', text: 'grandchild' },
                createdAt: now,
                createdBy: 'user',
                type: 'detail',
              },
            },
          ],
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'solo' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail',
          },
        },
        {
          id: 'sibling-a',
          content: 'Sibling A',
          children: [],
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'sibling-a' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail',
          },
        },
        {
          id: 'sibling-b',
          content: 'Sibling B',
          children: [],
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'sibling-b' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail',
          },
        },
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
      title: 'branching',
      createdAt: now,
      updatedAt: now,
      version: 1,
      truncated: false,
    },
  };
}

describe('toG6GraphData node positions', () => {
  it('maps persisted node positions into G6 style coordinates', () => {
    const graphData = toG6GraphData(sampleTree());
    const child = graphData.nodes?.find((node) => node.id === 'child');

    expect(child?.style).toMatchObject({
      x: 412.75,
      y: -96.5,
    });
  });

  it('assigns a shared parent source port for sibling edges in LR layout', () => {
    const graphData = toG6GraphData(sampleTree(), 'LR');
    const root = graphData.nodes?.find((node) => node.id === 'root');
    const edge = graphData.edges?.find((item) => item.source === 'root' && item.target === 'child');

    expect(root?.style).toMatchObject({
      port: true,
      ports: expect.arrayContaining([
        expect.objectContaining({
          key: 'right-center',
          placement: [1, 0.5],
        }),
      ]),
    });

    expect(edge).toMatchObject({
      sourcePort: 'right-center',
      targetPort: 'left-center',
    });
  });

  it('draws edges as straight lines when a parent has exactly one child', () => {
    const graphData = toG6GraphData(sampleTree(), 'LR');
    const edge = graphData.edges?.find((item) => item.source === 'root' && item.target === 'child');

    expect(edge?.style).toMatchObject({
      router: false,
      radius: 0,
    });
  });

  it('keeps branching parents on orthogonal connectors while preserving straight single-child links', () => {
    const graphData = toG6GraphData(branchingTree(), 'LR');
    const straightEdge = graphData.edges?.find((item) => item.source === 'solo' && item.target === 'grandchild');
    const branchedEdge = graphData.edges?.find((item) => item.source === 'root' && item.target === 'solo');

    expect(straightEdge?.style).toMatchObject({
      router: false,
      radius: 0,
    });
    expect(branchedEdge?.style).toBeUndefined();
  });
});
