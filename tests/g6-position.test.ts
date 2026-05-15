import { describe, expect, it } from 'vitest';

import type { MindMapTree } from '../lib/types/mindmap';
import {
  applyParallelStraightEdgeLayout,
  getEdgeRenderStyle,
  getEdgeRenderType,
  toG6GraphData,
} from '../lib/utils/g6';

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
    expect(edge?.type).toBe('line');
  });

  it('resolves runtime edge rendering by edge datum type so straight links do not inherit orthogonal routing', () => {
    expect(
      getEdgeRenderType({
        type: 'line',
      }),
    ).toBe('line');
    expect(
      getEdgeRenderStyle({
        type: 'line',
      }),
    ).toEqual({
      lineWidth: 1.2,
      stroke: '#7A7A70',
      radius: 0,
      router: false,
    });

    expect(
      getEdgeRenderType({
        type: 'polyline',
      }),
    ).toBe('polyline');
    expect(
      getEdgeRenderStyle({
        type: 'polyline',
      }),
    ).toEqual({
      lineWidth: 1.2,
      stroke: '#7A7A70',
      radius: 4,
      router: {
        type: 'orth',
        padding: 16,
      },
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
    expect(straightEdge?.type).toBe('line');
    expect(branchedEdge?.type).not.toBe('line');
    expect(branchedEdge?.style).toBeUndefined();
  });

  it('pins single-child LR edges to a shared Y coordinate so the segment stays perfectly horizontal', async () => {
    const nodeUpdates: Array<{ id: string; style: { port: true; ports: Array<{ key: string; placement: [number, number] }> } }> = [];
    const edgeUpdates: Array<{
      id: string;
      sourcePort: string;
      targetPort: string;
      style: { router: false; radius: number };
    }> = [];

    const graph = {
      getNodeData: () => [
        {
          id: 'root',
          data: { _width: 200, _height: 40 },
        },
        {
          id: 'child',
          data: { _width: 120, _height: 30 },
        },
      ],
      getEdgeData: () => [
        {
          id: 'edge-root-child',
          source: 'root',
          target: 'child',
        },
      ],
      getElementPosition: (id: string) => {
        if (id === 'root') return [0, 0];
        if (id === 'child') return [240, 30];
        return undefined;
      },
      updateNodeData: (updates: typeof nodeUpdates) => {
        nodeUpdates.push(...updates);
      },
      updateEdgeData: (updates: typeof edgeUpdates) => {
        edgeUpdates.push(...updates);
      },
      draw: async () => undefined,
    };

    await applyParallelStraightEdgeLayout(graph as any, sampleTree().root, 'LR');

    expect(nodeUpdates).toMatchObject([
      {
        id: 'root',
        style: {
          port: true,
          ports: [
            { key: 'left-center', placement: [0, 0.5] },
            { key: 'right-center', placement: [1, 0.5] },
          ],
        },
      },
      {
        id: 'child',
        style: {
          port: true,
          ports: [
            { key: 'left-center', placement: [0, -0.5] },
            { key: 'right-center', placement: [1, 0.5] },
          ],
        },
      },
    ]);
    expect(edgeUpdates).toEqual([
      {
        id: 'edge-root-child',
        type: 'line',
        sourcePort: 'right-center',
        targetPort: 'left-center',
        style: { router: false, radius: 0 },
      },
    ]);
  });

  it('pins single-child TB edges to a shared X coordinate so the segment stays perfectly vertical', async () => {
    const nodeUpdates: Array<{ id: string; style: { port: true; ports: Array<{ key: string; placement: [number, number] }> } }> = [];

    const graph = {
      getNodeData: () => [
        {
          id: 'root',
          data: { _width: 180, _height: 60 },
        },
        {
          id: 'child',
          data: { _width: 100, _height: 40 },
        },
      ],
      getEdgeData: () => [
        {
          id: 'edge-root-child',
          source: 'root',
          target: 'child',
        },
      ],
      getElementPosition: (id: string) => {
        if (id === 'root') return [0, 0];
        if (id === 'child') return [30, 180];
        return undefined;
      },
      updateNodeData: (updates: typeof nodeUpdates) => {
        nodeUpdates.push(...updates);
      },
      updateEdgeData: () => undefined,
      draw: async () => undefined,
    };

    await applyParallelStraightEdgeLayout(graph as any, sampleTree().root, 'TB');

    expect(nodeUpdates).toMatchObject([
      {
        id: 'root',
        style: {
          port: true,
          ports: [
            { key: 'top-center', placement: [0.5, 0] },
            { key: 'bottom-center', placement: [0.5, 1] },
          ],
        },
      },
      {
        id: 'child',
        style: {
          port: true,
          ports: [
            { key: 'top-center', placement: [0.2, 0] },
            { key: 'bottom-center', placement: [0.5, 1] },
          ],
        },
      },
    ]);
  });

  it('pushes a single-child subtree outward when parent and child boxes are too close for a straight LR edge', async () => {
    const translated: Array<Record<string, [number, number]>> = [];

    const graph = {
      getNodeData: () => [
        {
          id: 'parent',
          data: { _width: 132, _height: 44 },
        },
        {
          id: 'child',
          data: { _width: 420, _height: 68 },
        },
      ],
      getEdgeData: () => [
        {
          id: 'edge-parent-child',
          source: 'parent',
          target: 'child',
        },
      ],
      getElementPosition: (id: string) => {
        if (id === 'parent') return [715, 719.4];
        if (id === 'child') return [969.2, 710.2];
        return undefined;
      },
      translateElementTo: async (positions: Record<string, [number, number]>) => {
        translated.push(positions);
      },
      updateNodeData: () => undefined,
      updateEdgeData: () => undefined,
      draw: async () => undefined,
    };

    const root = {
      id: 'parent',
      content: '会员收入月均增长15',
      collapsed: false,
      children: [
        {
          id: 'child',
          content: '擅长设计营销组合玩法会员体系、积分生态、三方支付链路，曾推动产品增长 2000 万＋，单项目会员收入月均增长 15',
          collapsed: false,
          children: [],
          meta: {
            sourceRef: { type: 'text', text: 'child' },
            createdAt: Date.now(),
            createdBy: 'user',
            type: 'detail' as const,
          },
        },
      ],
      meta: {
        sourceRef: { type: 'text', text: 'parent' },
        createdAt: Date.now(),
        createdBy: 'user',
        type: 'detail' as const,
      },
    };

    await applyParallelStraightEdgeLayout(graph as any, root as any, 'LR');

    expect(translated).toEqual([
      {
        child: [1023, 710.2],
      },
    ]);
  });

  it('pushes branching child subtrees outward when orthogonal LR edges do not have enough horizontal gap', async () => {
    const translated: Array<Record<string, [number, number]>> = [];

    const graph = {
      getNodeData: () => [
        {
          id: 'parent',
          data: { _width: 200, _height: 40 },
        },
        {
          id: 'child-a',
          data: { _width: 100, _height: 36 },
        },
        {
          id: 'child-b',
          data: { _width: 100, _height: 36 },
        },
        {
          id: 'child-c',
          data: { _width: 100, _height: 36 },
        },
      ],
      getEdgeData: () => [
        { id: 'edge-parent-a', source: 'parent', target: 'child-a' },
        { id: 'edge-parent-b', source: 'parent', target: 'child-b' },
        { id: 'edge-parent-c', source: 'parent', target: 'child-c' },
      ],
      getElementPosition: (id: string) => {
        if (id === 'parent') return [0, 0];
        if (id === 'child-a') return [179, -80];
        if (id === 'child-b') return [179, 0];
        if (id === 'child-c') return [179, 80];
        return undefined;
      },
      translateElementTo: async (positions: Record<string, [number, number]>) => {
        translated.push(positions);
      },
      updateNodeData: () => undefined,
      updateEdgeData: () => undefined,
      draw: async () => undefined,
    };

    const now = Date.now();
    const root = {
      id: 'parent',
      content: 'Parent',
      collapsed: false,
      children: [
        {
          id: 'child-a',
          content: 'Child A',
          children: [],
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'child-a' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail' as const,
          },
        },
        {
          id: 'child-b',
          content: 'Child B',
          children: [],
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'child-b' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail' as const,
          },
        },
        {
          id: 'child-c',
          content: 'Child C',
          children: [],
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'child-c' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail' as const,
          },
        },
      ],
      meta: {
        sourceRef: { type: 'text', text: 'parent' },
        createdAt: now,
        createdBy: 'user',
        type: 'detail' as const,
      },
    };

    await applyParallelStraightEdgeLayout(graph as any, root as any, 'LR');

    expect(translated).toEqual([
      {
        'child-a': [182, -80],
        'child-b': [182, 0],
        'child-c': [182, 80],
      },
    ]);
  });

  it('renders the centered branch child as a straight line to avoid orthogonal U-turns in LR layout', async () => {
    const edgeUpdates: Array<{
      id: string;
      type?: 'line' | 'polyline';
      sourcePort: string;
      targetPort: string;
      style?: { router: false; radius: number };
    }> = [];

    const graph = {
      getNodeData: () => [
        { id: 'parent', data: { _width: 200, _height: 40 } },
        { id: 'child-a', data: { _width: 100, _height: 36 } },
        { id: 'child-b', data: { _width: 100, _height: 36 } },
        { id: 'child-c', data: { _width: 100, _height: 36 } },
      ],
      getEdgeData: () => [
        { id: 'edge-parent-a', source: 'parent', target: 'child-a' },
        { id: 'edge-parent-b', source: 'parent', target: 'child-b' },
        { id: 'edge-parent-c', source: 'parent', target: 'child-c' },
      ],
      getElementPosition: (id: string) => {
        if (id === 'parent') return [0, 0];
        if (id === 'child-a') return [220, -80];
        if (id === 'child-b') return [220, 0];
        if (id === 'child-c') return [220, 80];
        return undefined;
      },
      updateNodeData: () => undefined,
      updateEdgeData: (updates: typeof edgeUpdates) => {
        edgeUpdates.push(...updates);
      },
      draw: async () => undefined,
    };

    const now = Date.now();
    const root = {
      id: 'parent',
      content: 'Parent',
      collapsed: false,
      children: [
        {
          id: 'child-a',
          content: 'Child A',
          children: [],
          collapsed: false,
          meta: { sourceRef: { type: 'text', text: 'child-a' }, createdAt: now, createdBy: 'user', type: 'detail' as const },
        },
        {
          id: 'child-b',
          content: 'Child B',
          children: [],
          collapsed: false,
          meta: { sourceRef: { type: 'text', text: 'child-b' }, createdAt: now, createdBy: 'user', type: 'detail' as const },
        },
        {
          id: 'child-c',
          content: 'Child C',
          children: [],
          collapsed: false,
          meta: { sourceRef: { type: 'text', text: 'child-c' }, createdAt: now, createdBy: 'user', type: 'detail' as const },
        },
      ],
      meta: {
        sourceRef: { type: 'text', text: 'parent' },
        createdAt: now,
        createdBy: 'user',
        type: 'detail' as const,
      },
    };

    await applyParallelStraightEdgeLayout(graph as any, root as any, 'LR');

    expect(edgeUpdates).toEqual([
      {
        id: 'edge-parent-a',
        type: 'polyline',
        sourcePort: 'right-center',
        targetPort: 'left-center',
      },
      {
        id: 'edge-parent-b',
        type: 'line',
        sourcePort: 'right-center',
        targetPort: 'left-center',
        style: { router: false, radius: 0 },
      },
      {
        id: 'edge-parent-c',
        type: 'polyline',
        sourcePort: 'right-center',
        targetPort: 'left-center',
      },
    ]);
  });

  it('uses one shared parent source port for branching edges so all children originate from the same anchor', async () => {
    const nodeUpdates: Array<{ id: string; style: { port: true; ports: Array<{ key: string; placement: [number, number] }> } }> = [];
    const edgeUpdates: Array<{
      id: string;
      type?: 'line' | 'polyline';
      sourcePort: string;
      targetPort: string;
      style?: { router: false; radius: number };
    }> = [];

    const graph = {
      getNodeData: () => [
        { id: 'parent', data: { _width: 200, _height: 40 } },
        { id: 'child-a', data: { _width: 100, _height: 36 } },
        { id: 'child-b', data: { _width: 100, _height: 36 } },
      ],
      getEdgeData: () => [
        { id: 'edge-parent-a', source: 'parent', target: 'child-a' },
        { id: 'edge-parent-b', source: 'parent', target: 'child-b' },
      ],
      getElementPosition: (id: string) => {
        if (id === 'parent') return [0, 0];
        if (id === 'child-a') return [220, -80];
        if (id === 'child-b') return [220, 80];
        return undefined;
      },
      updateNodeData: (updates: typeof nodeUpdates) => {
        nodeUpdates.push(...updates);
      },
      updateEdgeData: (updates: typeof edgeUpdates) => {
        edgeUpdates.push(...updates);
      },
      draw: async () => undefined,
    };

    const now = Date.now();
    const root = {
      id: 'parent',
      content: 'Parent',
      collapsed: false,
      children: [
        {
          id: 'child-a',
          content: 'Child A',
          children: [],
          collapsed: false,
          meta: { sourceRef: { type: 'text', text: 'child-a' }, createdAt: now, createdBy: 'user', type: 'detail' as const },
        },
        {
          id: 'child-b',
          content: 'Child B',
          children: [],
          collapsed: false,
          meta: { sourceRef: { type: 'text', text: 'child-b' }, createdAt: now, createdBy: 'user', type: 'detail' as const },
        },
      ],
      meta: {
        sourceRef: { type: 'text', text: 'parent' },
        createdAt: now,
        createdBy: 'user',
        type: 'detail' as const,
      },
    };

    await applyParallelStraightEdgeLayout(graph as any, root as any, 'LR');

    expect(edgeUpdates).toEqual([
      {
        id: 'edge-parent-a',
        type: 'polyline',
        sourcePort: 'right-center',
        targetPort: 'left-center',
      },
      {
        id: 'edge-parent-b',
        type: 'polyline',
        sourcePort: 'right-center',
        targetPort: 'left-center',
      },
    ]);

    expect(nodeUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'parent',
          style: expect.objectContaining({
            port: true,
            ports: expect.arrayContaining([
              expect.objectContaining({ key: 'left-center', placement: [0, 0.5] }),
              expect.objectContaining({ key: 'right-center', placement: [1, 0.5] }),
            ]),
          }),
        }),
      ]),
    );
  });
});
