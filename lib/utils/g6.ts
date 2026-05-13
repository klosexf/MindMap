import { treeToGraphData } from '@antv/g6';
import type { EdgeData, GraphData, NodeData } from '@antv/g6';

import type { LayoutDirection, MindMapNode, MindMapTree } from '@/lib/types/mindmap';

interface HierarchyNode {
  id: string;
  content: string;
  collapsed: boolean;
  position?: {
    x: number;
    y: number;
  };
  children: HierarchyNode[];
}

function toHierarchyNode(node: MindMapNode): HierarchyNode {
  return {
    id: node.id,
    content: node.content,
    collapsed: node.collapsed ?? false,
    position: node.position,
    children: (node.children || []).map((child) => toHierarchyNode(child)),
  };
}

function collectChildCounts(node: HierarchyNode, counts: Map<string, number>): void {
  counts.set(node.id, node.children.length);
  node.children.forEach((child) => collectChildCounts(child, counts));
}

const _canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const MAX_NODE_WIDTH = 420;

function measureTextWidth(text: string, fontSize: number, fontWeight: number): number {
  if (!_canvas) return text.length * fontSize * 0.6;
  const ctx = _canvas.getContext('2d');
  if (!ctx) return text.length * fontSize * 0.6;
  ctx.font = `${fontWeight} ${fontSize}px system-ui, sans-serif`;
  return ctx.measureText(text).width;
}

function wrapTextByWidth(text: string, maxWidth: number, fontSize: number, fontWeight: number): string[] {
  const rows: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    const value = paragraph.length > 0 ? paragraph : ' ';
    let line = '';

    for (const char of value) {
      const next = line + char;
      if (line.length === 0 || measureTextWidth(next, fontSize, fontWeight) <= maxWidth) {
        line = next;
        continue;
      }

      rows.push(line);
      line = char;
    }

    rows.push(line || ' ');
  }

  return rows.length > 0 ? rows : [' '];
}

interface NodeSize {
  width: number;
  height: number;
}

interface PortConfig {
  incoming: { key: string; placement: [number, number] };
  outgoing: { key: string; placement: [number, number] };
}

function getPortConfig(direction: LayoutDirection): PortConfig {
  switch (direction) {
    case 'RL':
      return {
        incoming: { key: 'right-center', placement: [1, 0.5] },
        outgoing: { key: 'left-center', placement: [0, 0.5] },
      };
    case 'TB':
      return {
        incoming: { key: 'top-center', placement: [0.5, 0] },
        outgoing: { key: 'bottom-center', placement: [0.5, 1] },
      };
    case 'BT':
      return {
        incoming: { key: 'bottom-center', placement: [0.5, 1] },
        outgoing: { key: 'top-center', placement: [0.5, 0] },
      };
    case 'LR':
    default:
      return {
        incoming: { key: 'left-center', placement: [0, 0.5] },
        outgoing: { key: 'right-center', placement: [1, 0.5] },
      };
  }
}

export function getNodeSize(nodeId: string, label: string, rootId: string): NodeSize {
  const text = label || '';
  const isRoot = nodeId === rootId;
  const fontSize = isRoot ? 14 : 12;
  const fontWeight = isRoot ? 600 : 500;
  const lineHeight = fontSize * 1.6;
  const horizontalPadding = 24;
  const verticalPadding = 16;
  const minNodeWidth = isRoot ? 180 : 120;
  const minNodeHeight = isRoot ? 44 : 36;
  const singleLineWidth = measureTextWidth(text || ' ', fontSize, fontWeight);
  const preferredWidth = singleLineWidth + horizontalPadding;
  const nodeWidth = Math.max(Math.min(preferredWidth, MAX_NODE_WIDTH), minNodeWidth);
  const labelMaxWidth = Math.max(nodeWidth - horizontalPadding, 1);
  const wrappedLines = wrapTextByWidth(text || ' ', labelMaxWidth, fontSize, fontWeight);
  const contentHeight = wrappedLines.length * lineHeight;
  const nodeHeight = Math.max(contentHeight + verticalPadding, minNodeHeight);

  return { width: nodeWidth, height: nodeHeight };
}

export function toG6GraphData(tree: MindMapTree, direction: LayoutDirection = 'LR'): GraphData {
  const hierarchy = toHierarchyNode(tree.root);
  const portConfig = getPortConfig(direction);
  const childCounts = new Map<string, number>();
  collectChildCounts(hierarchy, childCounts);
  const graph = treeToGraphData(hierarchy, {
    getNodeData: (node, depth) => {
      const data = node as {
        id: string;
        content?: string;
        collapsed?: boolean;
        position?: { x: number; y: number };
        children?: string[];
      };
      const size = getNodeSize(data.id, data.content || '', tree.root.id);
      const nodeData: NodeData = {
        id: data.id,
        depth,
        children: data.children,
        data: {
          label: data.content || '',
          collapsed: Boolean(data.collapsed),
          _width: size.width,
          _height: size.height,
        },
        style: {
          collapsed: Boolean(data.collapsed),
          port: true,
          ports: [
            {
              ...portConfig.incoming,
              r: 0,
              fill: 'transparent',
              stroke: 'transparent',
              lineWidth: 0,
            },
            {
              ...portConfig.outgoing,
              r: 0,
              fill: 'transparent',
              stroke: 'transparent',
              lineWidth: 0,
            },
          ],
          ...(data.position ? { x: data.position.x, y: data.position.y } : {}),
        },
      };
      return nodeData;
    },
  });

  graph.edges = (graph.edges || []).map((edge) => ({
    ...(edge as EdgeData),
    sourcePort: portConfig.outgoing.key,
    targetPort: portConfig.incoming.key,
    ...(childCounts.get(String((edge as EdgeData).source)) === 1
      ? {
          style: {
            router: false,
            radius: 0,
          },
        }
      : {}),
  }));

  return graph;
}

export function getG6LayoutDirection(direction: LayoutDirection): 'LR' | 'RL' | 'TB' | 'BT' {
  return direction;
}

export interface LayoutConfig {
  [key: string]: any;
  type: 'mindmap' | 'compactBox';
  direction: 'LR' | 'RL' | 'TB' | 'BT';
  getHeight: (d?: any) => number;
  getWidth: (d?: any) => number;
  getVGap: (d?: any) => number;
  getHGap: (d?: any) => number;
}

export function getLayoutConfig(direction: LayoutDirection): LayoutConfig {
  const getSize = (d: any) => {
    // G6's treeLayout nests node data under d.data when passing to @antv/hierarchy
    const nodeData = d?.data || d;
    const width = nodeData?._width || 160;
    const height = nodeData?._height || 36;
    return { width, height };
  };

  if (direction === 'TB' || direction === 'BT') {
    return {
      type: 'compactBox',
      direction,
      getHeight: (d) => getSize(d).height,
      getWidth: (d) => getSize(d).width,
      getVGap: () => 60,
      getHGap: () => 16,
    };
  }

  return {
    type: 'mindmap',
    direction,
    getHeight: (d) => getSize(d).height,
    getWidth: (d) => getSize(d).width,
    getVGap: () => 16,
    getHGap: () => 60,
  };
}
