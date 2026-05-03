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

describe('toG6GraphData node positions', () => {
  it('maps persisted node positions into G6 style coordinates', () => {
    const graphData = toG6GraphData(sampleTree());
    const child = graphData.nodes?.find((node) => node.id === 'child');

    expect(child?.style).toMatchObject({
      x: 412.75,
      y: -96.5,
    });
  });
});
