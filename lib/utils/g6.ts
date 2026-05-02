import { treeToGraphData } from '@antv/g6';
import type { GraphData, NodeData } from '@antv/g6';

import type { LayoutDirection, MindMapNode, MindMapTree } from '@/lib/types/mindmap';

interface HierarchyNode {
  id: string;
  content: string;
  collapsed: boolean;
  children: HierarchyNode[];
}

function toHierarchyNode(node: MindMapNode): HierarchyNode {
  return {
    id: node.id,
    content: node.content,
    collapsed: node.collapsed ?? false,
    children: (node.children || []).map((child) => toHierarchyNode(child)),
  };
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

export function toG6GraphData(tree: MindMapTree): GraphData {
  const hierarchy = toHierarchyNode(tree.root);
  const graph = treeToGraphData(hierarchy, {
    getNodeData: (node, depth) => {
      const data = node as { id: string; content?: string; collapsed?: boolean; children?: string[] };
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
        },
      };
      return nodeData;
    },
  });

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
