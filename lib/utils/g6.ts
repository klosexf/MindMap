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
const EDGE_STROKE = '#7A7A70';
const EDGE_LINE_WIDTH = 1.2;
const EDGE_ROUTER_PADDING = 16;
const POLYLINE_EDGE_RADIUS = 4;

type MindMapEdgeType = 'line' | 'polyline';

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

export type PortPlacement = [number, number];

export interface RuntimePort {
  key: string;
  placement: PortPlacement;
  r: number;
  fill: string;
  stroke: string;
  lineWidth: number;
}

interface ParallelLayoutGraphLike {
  getNodeData: () => Array<{
    id?: string;
    data?: { _width?: number; _height?: number };
  }>;
  getEdgeData: () => Array<{ id?: string; source?: string; target?: string }>;
  getElementPosition: (id: string) => ArrayLike<number> | undefined;
  translateElementTo?: (positions: Record<string, [number, number]>, animation?: boolean) => Promise<void>;
  updateNodeData: (updates: Array<{ id: string; style: { port: true; ports: RuntimePort[] } }>) => void;
  updateEdgeData: (
    updates: Array<{
      id: string;
      sourcePort: string;
      targetPort: string;
      type?: 'line' | 'polyline';
      style?: { router: false; radius: number };
    }>,
  ) => void;
  draw: () => Promise<void>;
}

const MIN_STRAIGHT_EDGE_GAP = 32;

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

function createHiddenPort(key: string, placement: PortPlacement): RuntimePort {
  return {
    key,
    placement,
    r: 0,
    fill: 'transparent',
    stroke: 'transparent',
    lineWidth: 0,
  };
}

function collectChildrenByParent(node: MindMapNode, map: Map<string, string[]>): void {
  map.set(
    node.id,
    (node.children || []).map((child) => child.id),
  );
  node.children?.forEach((child) => collectChildrenByParent(child, map));
}

function collectSubtreeIds(node: MindMapNode, map: Map<string, string[]>): string[] {
  const ids = [node.id];
  node.children?.forEach((child) => {
    ids.push(...collectSubtreeIds(child, map));
  });
  map.set(node.id, ids);
  return ids;
}

function readCenterPosition(
  positionsByNodeId: Map<string, [number, number]>,
  graph: ParallelLayoutGraphLike,
  nodeId: string,
): [number, number] | null {
  const cached = positionsByNodeId.get(nodeId);
  if (cached) return cached;

  const position = graph.getElementPosition(nodeId);
  if (!position || position.length < 2) return null;
  const next: [number, number] = [Number(position[0]), Number(position[1])];
  if (!Number.isFinite(next[0]) || !Number.isFinite(next[1])) return null;
  positionsByNodeId.set(nodeId, next);
  return next;
}

function getStraightEdgeGap(
  direction: LayoutDirection,
  parentCenter: [number, number],
  childCenter: [number, number],
  parentSize: { width: number; height: number },
  childSize: { width: number; height: number },
): number {
  switch (direction) {
    case 'RL':
      return parentCenter[0] - parentSize.width / 2 - (childCenter[0] + childSize.width / 2);
    case 'TB':
      return childCenter[1] - childSize.height / 2 - (parentCenter[1] + parentSize.height / 2);
    case 'BT':
      return parentCenter[1] - parentSize.height / 2 - (childCenter[1] + childSize.height / 2);
    case 'LR':
    default:
      return childCenter[0] - childSize.width / 2 - (parentCenter[0] + parentSize.width / 2);
  }
}

function shiftSubtreeAlongDirection(
  direction: LayoutDirection,
  delta: number,
  subtreeIds: string[],
  positionsByNodeId: Map<string, [number, number]>,
): void {
  for (const nodeId of subtreeIds) {
    const position = positionsByNodeId.get(nodeId);
    if (!position) continue;

    switch (direction) {
      case 'RL':
        positionsByNodeId.set(nodeId, [position[0] - delta, position[1]]);
        break;
      case 'TB':
        positionsByNodeId.set(nodeId, [position[0], position[1] + delta]);
        break;
      case 'BT':
        positionsByNodeId.set(nodeId, [position[0], position[1] - delta]);
        break;
      case 'LR':
      default:
        positionsByNodeId.set(nodeId, [position[0] + delta, position[1]]);
        break;
    }
  }
}

async function ensureParentChildSpacing(
  graph: ParallelLayoutGraphLike,
  root: MindMapNode,
  nodeById: Map<string, { id?: string; data?: { _width?: number; _height?: number } }>,
  direction: LayoutDirection,
): Promise<Map<string, [number, number]>> {
  const positionsByNodeId = new Map<string, [number, number]>();
  for (const nodeId of nodeById.keys()) {
    readCenterPosition(positionsByNodeId, graph, nodeId);
  }

  const subtreeIdsByRootId = new Map<string, string[]>();
  collectSubtreeIds(root, subtreeIdsByRootId);

  const translatedPositions: Record<string, [number, number]> = {};

  for (const [parentId, subtreeIds] of subtreeIdsByRootId.entries()) {
    const parentNode = root.id === parentId ? root : undefined;
    const childIds = parentNode?.children?.map((child) => child.id)
      ?? (() => {
        const stack = [root];
        while (stack.length > 0) {
          const node = stack.pop()!;
          if (node.id === parentId) return (node.children || []).map((child) => child.id);
          node.children?.forEach((child) => stack.push(child));
        }
        return [];
      })();

    const parentPosition = positionsByNodeId.get(parentId);
    const parentData = nodeById.get(parentId);
    if (!parentPosition || !parentData || childIds.length === 0) continue;

    const parentSize = {
      width: Number(parentData.data?._width) || 160,
      height: Number(parentData.data?._height) || 36,
    };

    let delta = 0;
    for (const childId of childIds) {
      const childPosition = positionsByNodeId.get(childId);
      const childData = nodeById.get(childId);
      if (!childPosition || !childData) continue;

      const childSize = {
        width: Number(childData.data?._width) || 160,
        height: Number(childData.data?._height) || 36,
      };

      const currentGap = getStraightEdgeGap(direction, parentPosition, childPosition, parentSize, childSize);
      if (currentGap < MIN_STRAIGHT_EDGE_GAP) {
        delta = Math.max(delta, MIN_STRAIGHT_EDGE_GAP - currentGap);
      }
    }

    if (delta <= 0) continue;

    for (const childId of childIds) {
      const childSubtreeIds = subtreeIdsByRootId.get(childId);
      if (!childSubtreeIds?.length) continue;

      shiftSubtreeAlongDirection(direction, delta, childSubtreeIds, positionsByNodeId);

      for (const nodeId of childSubtreeIds) {
        const nextPosition = positionsByNodeId.get(nodeId);
        if (nextPosition) translatedPositions[nodeId] = nextPosition;
      }
    }
  }

  if (graph.translateElementTo && Object.keys(translatedPositions).length > 0) {
    await graph.translateElementTo(translatedPositions, false);
  }

  return positionsByNodeId;
}

function ensurePort(portMap: Map<string, RuntimePort>, key: string, placement: PortPlacement): void {
  portMap.set(key, createHiddenPort(key, placement));
}

function orderedPorts(
  portMap: Map<string, RuntimePort>,
  incomingKey: string,
  outgoingKey: string,
): RuntimePort[] {
  const incoming = portMap.get(incomingKey);
  const outgoing = portMap.get(outgoingKey);
  const extras = Array.from(portMap.values())
    .filter((port) => port.key !== incomingKey && port.key !== outgoingKey)
    .sort((a, b) => a.key.localeCompare(b.key));

  return [...(incoming ? [incoming] : []), ...(outgoing ? [outgoing] : []), ...extras];
}

function getSingleChildPlacements(
  direction: LayoutDirection,
  parentPosition: ArrayLike<number>,
  childPosition: ArrayLike<number>,
  parentSize: { width: number; height: number },
  childSize: { width: number; height: number },
  incoming: PortConfig['incoming'],
  outgoing: PortConfig['outgoing'],
): {
  parentOutgoing: PortPlacement;
  childIncoming: PortPlacement;
} {
  if (direction === 'LR' || direction === 'RL') {
    const sharedY = (parentPosition[1] + childPosition[1]) / 2;
    return {
      parentOutgoing: [outgoing.placement[0], 0.5 + (sharedY - parentPosition[1]) / parentSize.height],
      childIncoming: [incoming.placement[0], 0.5 + (sharedY - childPosition[1]) / childSize.height],
    };
  }

  const sharedX = (parentPosition[0] + childPosition[0]) / 2;
  return {
    parentOutgoing: [0.5 + (sharedX - parentPosition[0]) / parentSize.width, outgoing.placement[1]],
    childIncoming: [0.5 + (sharedX - childPosition[0]) / childSize.width, incoming.placement[1]],
  };
}

function isAxisAlignedWithParent(
  direction: LayoutDirection,
  parentPosition: ArrayLike<number>,
  childPosition: ArrayLike<number>,
): boolean {
  const epsilon = 0.5;
  if (direction === 'LR' || direction === 'RL') {
    return Math.abs(parentPosition[1] - childPosition[1]) <= epsilon;
  }

  return Math.abs(parentPosition[0] - childPosition[0]) <= epsilon;
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

export function getEdgeRenderType(edge: Pick<EdgeData, 'type'>): MindMapEdgeType {
  return edge.type === 'line' ? 'line' : 'polyline';
}

export function getEdgeRenderStyle(edge: Pick<EdgeData, 'type'>) {
  if (getEdgeRenderType(edge) === 'line') {
    return {
      lineWidth: EDGE_LINE_WIDTH,
      stroke: EDGE_STROKE,
      radius: 0,
      router: false as const,
    };
  }

  return {
    lineWidth: EDGE_LINE_WIDTH,
    stroke: EDGE_STROKE,
    radius: POLYLINE_EDGE_RADIUS,
    router: {
      type: 'orth' as const,
      padding: EDGE_ROUTER_PADDING,
    },
  };
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
          type: 'line',
          style: getEdgeRenderStyle({ type: 'line' }),
        }
      : {}),
  }));

  return graph;
}

export async function applyParallelStraightEdgeLayout(
  graph: ParallelLayoutGraphLike,
  root: MindMapNode,
  direction: LayoutDirection,
): Promise<void> {
  const childrenByParent = new Map<string, string[]>();
  collectChildrenByParent(root, childrenByParent);

  const nodeData = graph.getNodeData();
  const edgeData = graph.getEdgeData();
  const nodeById = new Map(nodeData.filter((node) => node.id).map((node) => [node.id as string, node]));
  const edgeByPair = new Map(
    edgeData
      .filter((edge) => edge.id && edge.source && edge.target)
      .map((edge) => [`${edge.source}::${edge.target}`, edge.id as string]),
  );
  const positionsByNodeId = await ensureParentChildSpacing(graph, root, nodeById, direction);

  const { incoming, outgoing } = getPortConfig(direction);
  const portsByNodeId = new Map<string, Map<string, RuntimePort>>();
  const edgeUpdates: Array<{
    id: string;
    sourcePort: string;
    targetPort: string;
    type?: 'line' | 'polyline';
    style?: { router: false; radius: number };
  }> = [];

  for (const node of nodeData) {
    if (!node.id) continue;
    const portMap = new Map<string, RuntimePort>();
    ensurePort(portMap, incoming.key, incoming.placement);
    ensurePort(portMap, outgoing.key, outgoing.placement);
    portsByNodeId.set(node.id, portMap);
  }

  for (const [parentId, childIds] of childrenByParent.entries()) {
    const parent = nodeById.get(parentId);
    if (!parent?.id) continue;

    const parentPosition = positionsByNodeId.get(parentId);
    if (!parentPosition) continue;

    const parentSize = {
      width: Number(parent.data?._width) || 160,
      height: Number(parent.data?._height) || 36,
    };
    const parentPorts = portsByNodeId.get(parentId);
    if (!parentPorts) continue;

    if (childIds.length === 1) {
      const childId = childIds[0];
      const child = nodeById.get(childId);
      const childPorts = portsByNodeId.get(childId);
      const edgeId = edgeByPair.get(`${parentId}::${childId}`);
      if (!child?.id || !childPorts || !edgeId) continue;

      const childPosition = positionsByNodeId.get(childId);
      if (!childPosition) continue;

      const childSize = {
        width: Number(child.data?._width) || 160,
        height: Number(child.data?._height) || 36,
      };

      const { parentOutgoing, childIncoming } = getSingleChildPlacements(
        direction,
        parentPosition,
        childPosition,
        parentSize,
        childSize,
        incoming,
        outgoing,
      );

      ensurePort(parentPorts, outgoing.key, parentOutgoing);
      ensurePort(childPorts, incoming.key, childIncoming);
      edgeUpdates.push({
        id: edgeId,
        type: 'line',
        sourcePort: outgoing.key,
        targetPort: incoming.key,
        style: {
          router: false,
          radius: 0,
        },
      });
      continue;
    }

    for (const childId of childIds) {
      const edgeId = edgeByPair.get(`${parentId}::${childId}`);
      if (!edgeId) continue;

      const childPosition = positionsByNodeId.get(childId);
      if (!childPosition) continue;

      if (isAxisAlignedWithParent(direction, parentPosition, childPosition)) {
        edgeUpdates.push({
          id: edgeId,
          type: 'line',
          sourcePort: outgoing.key,
          targetPort: incoming.key,
          style: {
            router: false,
            radius: 0,
          },
        });
        continue;
      }

      edgeUpdates.push({
        id: edgeId,
        type: 'polyline',
        sourcePort: outgoing.key,
        targetPort: incoming.key,
      });
    }
  }

  const nodeUpdates = Array.from(portsByNodeId.entries()).map(([id, portMap]) => ({
    id,
    style: {
      port: true as const,
      ports: orderedPorts(portMap, incoming.key, outgoing.key),
    },
  }));

  if (nodeUpdates.length > 0) {
    graph.updateNodeData(nodeUpdates);
  }
  if (edgeUpdates.length > 0) {
    graph.updateEdgeData(edgeUpdates);
  }

  if (nodeUpdates.length > 0 || edgeUpdates.length > 0) {
    await graph.draw();
  }
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
