'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Graph } from '@antv/g6';

import type { LayoutDirection, MindMapTree, MindMapNode, NodePosition } from '@/lib/types/mindmap';
import {
  applyParallelStraightEdgeLayout,
  getEdgeRenderStyle,
  getEdgeRenderType,
  getLayoutConfig,
  getNodeSize,
  toG6GraphData,
} from '@/lib/utils/g6';
import { focusGraphViewportOnNode, getViewportLockedEditorRect, readGraphViewportState, restoreGraphViewportState } from '@/lib/utils/g6-viewport';
import {
  countNodes,
  findClosestRectByBorderProximity,
  findParentInfo,
  inferDropModeFromPoint,
  resolveDropMoveTarget,
  type DropMoveMode,
  type DropSiblingPlacement,
} from '@/lib/utils/tree';
import { createLayerRenderer, selectRenderMode } from '@/lib/utils/renderer';

export interface MindMapEditorRef {
  exportPngDataUrl: () => Promise<string | null>;
  startEditingNode: (nodeId: string, options?: StartEditingOptions) => void;
}

interface MindMapEditorProps {
  tree: MindMapTree;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onUpdateNodeContent: (id: string, content: string) => void;
  layoutDirection: LayoutDirection;
  onMoveNode: (nodeId: string, newParentId: string, index: number) => void;
  onUpdateNodePosition: (nodeId: string, position: NodePosition) => void;
  onEditEnd?: (nodeId: string, committed: boolean, finalText: string, originalText: string) => void;
  onEnterWithoutText?: () => void;
}

interface StartEditingOptions {
  centerInViewport?: boolean;
}

interface NodeTextMetrics {
  width: number;
  height: number;
  labelMaxWidth: number;
  lineCount: number;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
}

interface NodeClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DropPreview {
  targetNodeId: string;
  mode: DropMoveMode;
  siblingPlacement: DropSiblingPlacement;
  moveTarget: {
    newParentId: string;
    newIndex: number;
  };
}

function isPointInRect(point: { x: number; y: number }, rect: NodeClientRect): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

const TRANSIENT_DRAG_STATES = ['dragging', 'drop-child', 'drop-sibling-before', 'drop-sibling-after'] as const;

function getNodeTextMetrics(datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }, rootId: string): NodeTextMetrics {
  const size = getNodeSize(datum.id || '', datum.data?.label || '', rootId);
  const isRoot = datum.id === rootId;
  const fontSize = isRoot ? 14 : 12;
  const fontWeight = isRoot ? 600 : 500;
  const lineHeight = fontSize * 1.6;
  const horizontalPadding = 24;
  const labelMaxWidth = Math.max(size.width - horizontalPadding, 1);
  const lineCount = Math.round((size.height - 16) / lineHeight);

  return {
    width: size.width,
    height: size.height,
    labelMaxWidth,
    lineCount: Math.max(lineCount, 1),
    fontSize,
    fontWeight,
    lineHeight,
  };
}

function collectPersistedNodePositions(node: MindMapNode, positions: Record<string, [number, number]>): void {
  if (node.position) {
    positions[node.id] = [node.position.x, node.position.y];
  }

  node.children?.forEach((child) => collectPersistedNodePositions(child, positions));
}

async function applyPersistedNodePositions(graph: Graph, root: MindMapNode): Promise<void> {
  const positions: Record<string, [number, number]> = {};
  collectPersistedNodePositions(root, positions);
  if (Object.keys(positions).length === 0) return;

  await graph.translateElementTo(positions, false);
}

export const MindMapEditor = forwardRef<MindMapEditorRef, MindMapEditorProps>(function MindMapEditor(
  { tree, selectedNodeId, onSelectNode, onUpdateNodeContent, layoutDirection, onMoveNode, onUpdateNodePosition, onEditEnd, onEnterWithoutText },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const nodeCount = useMemo(() => countNodes(tree.root), [tree]);
  const renderMode = useMemo(() => selectRenderMode(nodeCount), [nodeCount]);

  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editRect, setEditRect] = useState<DOMRect | null>(null);

  const originalEditValueRef = useRef('');
  const draggingNodeIdRef = useRef<string | null>(null);
  const dropPreviewRef = useRef<DropPreview | null>(null);
  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  const treeRef = useRef(tree);
  const layoutDirectionRef = useRef(layoutDirection);
  const onSelectNodeRef = useRef(onSelectNode);
  const onMoveNodeRef = useRef(onMoveNode);
  const onUpdateNodePositionRef = useRef(onUpdateNodePosition);
  const skipNextLayoutRef = useRef(false);
  const focusNodeIdOnNextRenderRef = useRef<string | null>(null);
  const viewportBeforeCommitRef = useRef<ReturnType<typeof readGraphViewportState>>(null);

  const commitEdit = useCallback(
    (value: string) => {
      const nodeId = editingNodeId;
      const originalText = originalEditValueRef.current;
      if (nodeId && value.trim()) {
        const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
        if (graph && !graph.destroyed) {
          viewportBeforeCommitRef.current = readGraphViewportState(graph);
        }
        onUpdateNodeContent(nodeId, value.trim());
      }
      setEditingNodeId(null);
      setEditValue('');
      setEditRect(null);
      originalEditValueRef.current = '';
      if (nodeId) onEditEnd?.(nodeId, true, value, originalText);
    },
    [editingNodeId, onUpdateNodeContent, onEditEnd],
  );

  const cancelEdit = useCallback(() => {
    const nodeId = editingNodeId;
    const originalText = originalEditValueRef.current;
    const currentValue = editValue;
    setEditingNodeId(null);
    setEditValue('');
    setEditRect(null);
    originalEditValueRef.current = '';
    if (nodeId) onEditEnd?.(nodeId, false, currentValue, originalText);
  }, [editingNodeId, editValue, onEditEnd]);

  /** Compute the screen position of a node and open the inline editor */
  const startEditingNode = useCallback(
    (nodeId: string, options?: StartEditingOptions) => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      if (!graph || graph.destroyed) return;

      const tryOpen = (retriesLeft: number) => {
        const g = graphRef.current as (Graph & { destroyed?: boolean }) | null;
        if (!g || g.destroyed) return;

        const nodeData = g.getNodeData(nodeId);
        if (!nodeData) {
          if (retriesLeft > 0) {
            requestAnimationFrame(() => tryOpen(retriesLeft - 1));
          }
          return;
        }

        const openInlineEditor = () => {
          const container = containerRef.current;
          if (!container) return;

          const label = (nodeData.data?.label as string) || '';
          setEditValue(label);
          originalEditValueRef.current = label;
          setEditingNodeId(nodeId);

          const canvasEl = container.querySelector('canvas') || container.querySelector('svg');
          if (!canvasEl) return;

          let rect: DOMRect | null = null;

          // --- Strategy 1: use G6's coordinate API ---
          try {
            const bounds = g.getElementRenderBounds(nodeId);
            if (bounds) {
              const minX = Math.min(bounds.min[0], bounds.max[0]);
              const minY = Math.min(bounds.min[1], bounds.max[1]);
              const maxX = Math.max(bounds.min[0], bounds.max[0]);
              const maxY = Math.max(bounds.min[1], bounds.max[1]);
              const w = maxX - minX;
              const h = maxY - minY;

              const topLeft = g.getClientByCanvas([minX, minY]);
              const bottomRight = g.getClientByCanvas([maxX, maxY]);

              if (topLeft && bottomRight) {
                const [tlX, tlY] = Array.isArray(topLeft) ? topLeft : [0, 0];
                const [brX, brY] = Array.isArray(bottomRight) ? bottomRight : [0, 0];
                rect = new DOMRect(
                  tlX,
                  tlY,
                  brX - tlX || w,
                  brY - tlY || h,
                );
              }
            }
          } catch {
            // Strategy 1 failed
          }

          // --- Strategy 2: find the node's SVG group element ---
          if (!rect) {
            const svgEl = container.querySelector('svg');
            if (svgEl) {
              const selectors = [
                `[id="${nodeId}"]`,
                `g[id="${nodeId}"]`,
              ];
              for (const sel of selectors) {
                try {
                  const el = svgEl.querySelector(sel);
                  if (el) {
                    rect = el.getBoundingClientRect();
                    break;
                  }
                } catch {
                  // invalid selector, skip
                }
              }
            }
          }

          // --- Strategy 3: fallback to canvas center ---
          if (!rect) {
            const canvasRect = canvasEl.getBoundingClientRect();
            rect = new DOMRect(
              canvasRect.left + canvasRect.width / 2 - 120,
              canvasRect.top + canvasRect.height / 2 - 22,
              240,
              44,
            );
          }

          const viewportRect = container.getBoundingClientRect();
          const lockedRect = getViewportLockedEditorRect(rect, viewportRect, {
            minWidth: 180,
            minHeight: 44,
            center: options?.centerInViewport,
          });

          setEditRect(new DOMRect(lockedRect.left, lockedRect.top, lockedRect.width, lockedRect.height));
        };

        const openAfterViewportFocus = async () => {
          if (options?.centerInViewport) {
            await focusGraphViewportOnNode(g, nodeId);
          }

          requestAnimationFrame(openInlineEditor);
        };

        void openAfterViewportFocus();
      };

      tryOpen(15);
    },
    [],
  );

  useImperativeHandle(ref, () => ({
    exportPngDataUrl: async () => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      if (!graph || graph.destroyed) return null;
      return graph.toDataURL({ mode: 'overall', type: 'image/png', encoderOptions: 1 });
    },
    startEditingNode,
  }));

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  useEffect(() => {
    layoutDirectionRef.current = layoutDirection;
  }, [layoutDirection]);

  useEffect(() => {
    onSelectNodeRef.current = onSelectNode;
  }, [onSelectNode]);

  useEffect(() => {
    onMoveNodeRef.current = onMoveNode;
  }, [onMoveNode]);

  useEffect(() => {
    onUpdateNodePositionRef.current = onUpdateNodePosition;
  }, [onUpdateNodePosition]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const graph = new Graph({
      container,
      autoResize: true,
      zoomRange: [0.1, 5],
      data: toG6GraphData(treeRef.current, layoutDirectionRef.current),
      layout: getLayoutConfig(layoutDirectionRef.current),
      renderer: createLayerRenderer(renderMode),
      node: {
        type: 'rect',
        style: {
          size: (datum: { data?: { label?: string; _width?: number; _height?: number }; id?: string }) => {
            const metrics = getNodeTextMetrics(datum, treeRef.current.root.id);
            return [metrics.width, metrics.height];
          },
          radius: 12,
          fill: (datum: { id?: string }) => (datum.id === treeRef.current.root.id ? '#F5F5F2' : '#FFFFFFFE'),
          stroke: (datum: { id?: string }) => (datum.id === treeRef.current.root.id ? '#1A1A1A' : '#E6E6DC'),
          lineWidth: (datum: { id?: string }) => (datum.id === treeRef.current.root.id ? 2 : 1),
          label: true,
          labelPlacement: 'center',
          labelTextAlign: 'center',
          labelTextBaseline: 'middle',
          labelText: (datum: { data?: { label?: string } }) => datum.data?.label || '',
          labelFill: '#1A1A1A',
          labelFontSize: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) =>
            getNodeTextMetrics(datum, treeRef.current.root.id).fontSize,
          labelFontWeight: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) =>
            getNodeTextMetrics(datum, treeRef.current.root.id).fontWeight,
          labelWordWrap: true,
          labelMaxWidth: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) => {
            const metrics = getNodeTextMetrics(datum, treeRef.current.root.id);
            return metrics.labelMaxWidth;
          },
          labelMaxLines: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) => {
            const metrics = getNodeTextMetrics(datum, treeRef.current.root.id);
            return metrics.lineCount;
          },
          labelTextOverflow: 'clip',
          labelLineHeight: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) =>
            getNodeTextMetrics(datum, treeRef.current.root.id).lineHeight,
        },
        state: {
          selected: {
            stroke: '#1A1A1A',
            lineWidth: 2.4,
          },
          dragging: {
            // Position-only: neutral gray — "just repositioning, no relationship change"
            // Note: shadowBlur is intentionally removed to avoid SVG filter clipping
            // the left border during drag operations (G6 v5 SVG renderer + filterUnits=userSpaceOnUse)
            opacity: 0.88,
            stroke: '#8B8B83',
            lineWidth: 2,
            fill: '#F9F9F6',
          },
          'drop-child': {
            // Hierarchy change: blue — "will become a child of this node"
            // Keep this state filter-free: SVG shadow filters can clip the node stroke
            // while the dragged node overlaps the target during reparent preview.
            stroke: '#2563EB',
            lineWidth: 3,
            fill: '#EFF6FF',
          },
          'drop-sibling-before': {
            // Peer reorder before: keep it filter-free so no SVG shadow
            // can linger on the node after the structural move completes.
            stroke: '#D97706',
            lineWidth: 2.6,
            fill: '#FFF7ED',
          },
          'drop-sibling-after': {
            // Peer reorder after: keep it filter-free for the same reason.
            stroke: '#D97706',
            lineWidth: 2.6,
            fill: '#FFF7ED',
          },
        },
      },
      edge: {
        type: (datum) => getEdgeRenderType(datum),
        style: (datum) => getEdgeRenderStyle(datum),
      },
      behaviors: [
        'drag-canvas',
        'click-select',
        {
          type: 'drag-element',
          key: 'drag-element',
          hideEdge: 'none',
          shadow: false,
          enable: (event: { targetType?: string; target?: { id?: string } }) =>
            event.targetType === 'node' && event.target?.id !== treeRef.current.root.id,
        },
      ],
      animation: false,
    });

    const DROP_CHILD_STATE = 'drop-child';
    const DROP_SIBLING_BEFORE_STATE = 'drop-sibling-before';
    const DROP_SIBLING_AFTER_STATE = 'drop-sibling-after';
    const DROP_STATES = [DROP_CHILD_STATE, DROP_SIBLING_BEFORE_STATE, DROP_SIBLING_AFTER_STATE] as const;

    const setNodeState = (nodeId: string, state: string, enabled: boolean) => {
      const currentStates = graph.getElementState(nodeId);
      if (!currentStates) return;
      const nextStates = new Set(currentStates);
      if (enabled) nextStates.add(state);
      else nextStates.delete(state);
      graph.setElementState(nodeId, Array.from(nextStates)).catch(() => {});
    };

    const clearDropStates = (nodeId: string) => {
      const currentStates = graph.getElementState(nodeId);
      if (!currentStates) return;
      const nextStates = currentStates.filter((state) => !DROP_STATES.includes(state as (typeof DROP_STATES)[number]));
      graph.setElementState(nodeId, nextStates).catch(() => {});
    };

    const clearTransientDragStates = () => {
      const updates: Record<string, string[]> = {};
      const nodeData = graph.getNodeData() as Array<{ id?: string }>;

      for (const node of nodeData) {
        const nodeId = node?.id;
        if (!nodeId) continue;

        const currentStates = graph.getElementState(nodeId);
        if (!currentStates?.length) continue;

        const nextStates = currentStates.filter(
          (state) => !TRANSIENT_DRAG_STATES.includes(state as (typeof TRANSIENT_DRAG_STATES)[number]),
        );

        if (nextStates.length !== currentStates.length) {
          updates[nodeId] = nextStates;
        }
      }

      if (Object.keys(updates).length > 0) {
        graph.setElementState(updates).catch(() => {});
      }
    };

    const ensureNodesAboveEdges = () => {
      const zIndexById: Record<string, number> = {};
      const edgeData = graph.getEdgeData() as Array<{ id?: string }>;
      const nodeData = graph.getNodeData() as Array<{ id?: string }>;

      for (const edge of edgeData) {
        const edgeId = edge?.id;
        if (edgeId) zIndexById[edgeId] = 0;
      }

      for (const node of nodeData) {
        const nodeId = node?.id;
        if (nodeId) zIndexById[nodeId] = 10;
      }

      if (Object.keys(zIndexById).length > 0) {
        graph.setElementZIndex(zIndexById).catch(() => {});
      }
    };

    const readNodeClientRect = (nodeId: string): NodeClientRect | null => {
      try {
        const bounds = graph.getElementRenderBounds(nodeId);
        if (!bounds) return null;

        const minX = Math.min(bounds.min[0], bounds.max[0]);
        const minY = Math.min(bounds.min[1], bounds.max[1]);
        const maxX = Math.max(bounds.min[0], bounds.max[0]);
        const maxY = Math.max(bounds.min[1], bounds.max[1]);

        const topLeft = graph.getClientByCanvas([minX, minY]);
        const bottomRight = graph.getClientByCanvas([maxX, maxY]);
        if (!Array.isArray(topLeft) || !Array.isArray(bottomRight)) return null;

        return {
          left: topLeft[0],
          top: topLeft[1],
          width: bottomRight[0] - topLeft[0],
          height: bottomRight[1] - topLeft[1],
        };
      } catch {
        return null;
      }
    };

    const readNodeCanvasPosition = (nodeId: string): NodePosition | null => {
      try {
        const position = graph.getElementPosition(nodeId);
        if (!Array.isArray(position)) return null;
        const [x, y] = position;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y };
      } catch {
        return null;
      }
    };

    const readClientPoint = (evt: any): { x: number; y: number } | null => {
      const canvasX = evt?.canvasX ?? evt?.canvas?.x;
      const canvasY = evt?.canvasY ?? evt?.canvas?.y;
      if (typeof canvasX === 'number' && typeof canvasY === 'number') {
        const clientPos = graph.getClientByCanvas([canvasX, canvasY]);
        if (Array.isArray(clientPos)) {
          return { x: clientPos[0], y: clientPos[1] };
        }
      }

      if (typeof evt?.clientX === 'number' && typeof evt?.clientY === 'number') {
        return { x: evt.clientX, y: evt.clientY };
      }

      if (typeof evt?.x === 'number' && typeof evt?.y === 'number') {
        return { x: evt.x, y: evt.y };
      }

      return null;
    };

    const resolveDropTargetNodeId = (evt: any, draggingNodeId: string): string | null => {
      const fromEvent = evt?.dropTarget?.id;
      if (typeof fromEvent === 'string' && fromEvent) {
        const hit = graph.getNodeData(fromEvent as string) as { id?: string } | undefined;
        if (hit?.id && hit.id !== draggingNodeId) {
          return hit.id;
        }
      }

      const point = readClientPoint(evt);
      if (!point) return null;

      const nodeData = graph.getNodeData() as Array<{ id?: string }>;
      let best: { id: string; area: number } | null = null;

      for (const node of nodeData) {
        const nodeId = node?.id;
        if (!nodeId || nodeId === draggingNodeId) continue;

        const rect = readNodeClientRect(nodeId);
        if (!rect) continue;
        if (!isPointInRect(point, rect)) continue;

        const area = rect.width * rect.height;
        if (!best || area < best.area) {
          best = { id: nodeId, area };
        }
      }

      return best?.id ?? null;
    };

    const inferSiblingPlacementFromPoint = (point: { x: number; y: number }, targetRect: NodeClientRect): DropSiblingPlacement => {
      const direction = layoutDirectionRef.current;
      if (direction === 'TB' || direction === 'BT') {
        return point.x < targetRect.left + targetRect.width / 2 ? 'before' : 'after';
      }
      return point.y < targetRect.top + targetRect.height / 2 ? 'before' : 'after';
    };

    const buildDropPreviewForTarget = (
      draggingNodeId: string,
      targetNodeId: string,
      point: { x: number; y: number } | null,
    ): DropPreview | null => {
      if (!draggingNodeId || !targetNodeId || draggingNodeId === targetNodeId) return null;
      if (draggingNodeId === treeRef.current.root.id) return null;

      const targetRect = readNodeClientRect(targetNodeId);
      let mode: DropMoveMode = 'child';
      if (targetRect && point) {
        mode = inferDropModeFromPoint(point, targetRect, layoutDirectionRef.current);
      }

      let siblingPlacement: DropSiblingPlacement = 'after';
      if (mode === 'sibling' && targetRect && point) {
        siblingPlacement = inferSiblingPlacementFromPoint(point, targetRect);
      }

      let moveTarget = resolveDropMoveTarget(treeRef.current.root, draggingNodeId, targetNodeId, mode, siblingPlacement);
      if (!moveTarget && mode === 'sibling') {
        mode = 'child';
        siblingPlacement = 'after';
        moveTarget = resolveDropMoveTarget(treeRef.current.root, draggingNodeId, targetNodeId, mode, siblingPlacement);
      }
      if (!moveTarget) return null;

      return {
        targetNodeId,
        mode,
        siblingPlacement,
        moveTarget,
      };
    };

    const buildDropPreviewFromDraggedNode = (draggingNodeId: string): DropPreview | null => {
      const draggingRect = readNodeClientRect(draggingNodeId);
      if (!draggingRect) return null;

      const draggingCenter = {
        x: draggingRect.left + draggingRect.width / 2,
        y: draggingRect.top + draggingRect.height / 2,
      };

      const nodeData = graph.getNodeData() as Array<{ id?: string }>;

      // Phase 1: exact hit — dragging center is inside a target node
      for (const node of nodeData) {
        const nodeId = node?.id;
        if (!nodeId || nodeId === draggingNodeId) continue;
        const rect = readNodeClientRect(nodeId);
        if (!rect) continue;
        if (isPointInRect(draggingCenter, rect)) {
          return buildDropPreviewForTarget(draggingNodeId, nodeId, draggingCenter);
        }
      }

      // Phase 2: overlap-based detection — require ≥30% area overlap
      // between the dragged node and a candidate target. This prevents
      // accidental reparenting when nodes are merely near each other.
      const draggedArea = draggingRect.width * draggingRect.height;
      let bestOverlap: { id: string; ratio: number } | null = null;

      for (const node of nodeData) {
        const nodeId = node?.id;
        if (!nodeId || nodeId === draggingNodeId) continue;
        const rect = readNodeClientRect(nodeId);
        if (!rect) continue;

        const overlapLeft = Math.max(draggingRect.left, rect.left);
        const overlapRight = Math.min(
          draggingRect.left + draggingRect.width,
          rect.left + rect.width,
        );
        const overlapTop = Math.max(draggingRect.top, rect.top);
        const overlapBottom = Math.min(
          draggingRect.top + draggingRect.height,
          rect.top + rect.height,
        );

        const overlapW = overlapRight - overlapLeft;
        const overlapH = overlapBottom - overlapTop;
        if (overlapW <= 0 || overlapH <= 0) continue;

        const overlapArea = overlapW * overlapH;
        const targetArea = rect.width * rect.height;
        const ratio = overlapArea / Math.min(draggedArea, targetArea);

        if (ratio >= 0.3 && (!bestOverlap || ratio > bestOverlap.ratio)) {
          bestOverlap = { id: nodeId, ratio };
        }
      }

      if (bestOverlap) {
        return buildDropPreviewForTarget(draggingNodeId, bestOverlap.id, draggingCenter);
      }

      const currentParent = findParentInfo(treeRef.current.root, draggingNodeId);
      const proximityCandidates: Array<{ id: string; rect: NodeClientRect }> = [];

      for (const node of nodeData) {
        const nodeId = node?.id;
        if (!nodeId || nodeId === draggingNodeId || nodeId === currentParent?.parentId) continue;
        const rect = readNodeClientRect(nodeId);
        if (!rect) continue;
        proximityCandidates.push({ id: nodeId, rect });
      }

      const closestByBorder = findClosestRectByBorderProximity(draggingRect, proximityCandidates);
      if (closestByBorder) {
        return buildDropPreviewForTarget(draggingNodeId, closestByBorder.id, null);
      }

      return null; // Pure position move — no reparenting target
    };

    const clearDropPreview = () => {
      const previousPreview = dropPreviewRef.current;
      if (!previousPreview) return;
      clearDropStates(previousPreview.targetNodeId);
      dropPreviewRef.current = null;
    };

    const applyDropPreview = (nextPreview: DropPreview) => {
      const previousPreview = dropPreviewRef.current;
      if (
        previousPreview &&
        previousPreview.targetNodeId === nextPreview.targetNodeId &&
        previousPreview.mode === nextPreview.mode &&
        previousPreview.siblingPlacement === nextPreview.siblingPlacement &&
        previousPreview.moveTarget.newParentId === nextPreview.moveTarget.newParentId &&
        previousPreview.moveTarget.newIndex === nextPreview.moveTarget.newIndex
      ) {
        return;
      }

      if (previousPreview && previousPreview.targetNodeId !== nextPreview.targetNodeId) {
        clearDropStates(previousPreview.targetNodeId);
      }

      clearDropStates(nextPreview.targetNodeId);
      const previewState =
        nextPreview.mode === 'child'
          ? DROP_CHILD_STATE
          : nextPreview.siblingPlacement === 'before'
            ? DROP_SIBLING_BEFORE_STATE
            : DROP_SIBLING_AFTER_STATE;
      setNodeState(nextPreview.targetNodeId, previewState, true);
      dropPreviewRef.current = nextPreview;
    };

    const updateDropPreview = (evt: any) => {
      const draggingNodeId = draggingNodeIdRef.current;
      const targetNodeId = draggingNodeId
        ? resolveDropTargetNodeId(evt, draggingNodeId)
        : null;

      if (!draggingNodeId) {
        clearDropPreview();
        return;
      }

      if (!targetNodeId) {
        const proximityPreview = buildDropPreviewFromDraggedNode(draggingNodeId);
        if (!proximityPreview) {
          clearDropPreview();
          return;
        }

        applyDropPreview(proximityPreview);
        return;
      }

      const nextPreview = buildDropPreviewForTarget(draggingNodeId, targetNodeId, readClientPoint(evt));
      if (!nextPreview) {
        clearDropPreview();
        return;
      }

      applyDropPreview(nextPreview);
    };

    graph.on('node:click', (evt: any) => {
      onSelectNodeRef.current(evt?.target?.id ?? null);
    });

    graph.on('node:dblclick', (evt: any) => {
      const nodeId = evt?.target?.id ?? null;
      if (nodeId) {
        onSelectNodeRef.current(nodeId);
        startEditingNode(nodeId);
      }
    });

    graph.on('node:dragstart', (evt: any) => {
      const draggedNodeId = evt?.target?.id as string | undefined;
      if (!draggedNodeId) return;
      draggingNodeIdRef.current = draggedNodeId;
      setNodeState(draggedNodeId, 'dragging', true);
      clearDropPreview();
    });

    graph.on('node:drag', (evt: any) => {
      updateDropPreview(evt);
    });

    graph.on('node:dragover', (evt: any) => {
      const dragNodeId = draggingNodeIdRef.current;
      const dropNodeId = evt?.target?.id as string | undefined;
      if (!dragNodeId || !dropNodeId || dropNodeId === dragNodeId) return;
      updateDropPreview({
        ...evt,
        dropTarget: { id: dropNodeId },
      });
    });

    graph.on('node:dragend', (evt: any) => {
      const draggedNodeId = (draggingNodeIdRef.current ?? evt?.target?.id) as string | undefined;
      let preview = dropPreviewRef.current;
      clearDropPreview();
      const finalPosition = draggedNodeId ? readNodeCanvasPosition(draggedNodeId) : null;

      if (draggedNodeId) {
        setNodeState(draggedNodeId, 'dragging', false);
      }

      draggingNodeIdRef.current = null;

      if (!preview && draggedNodeId) {
        preview = buildDropPreviewFromDraggedNode(draggedNodeId);
      }

      if (!draggedNodeId) {
        clearTransientDragStates();
        ensureNodesAboveEdges();
        return;
      }

      if (preview) {
        // Structural change: reparent the node, then focus viewport on it after render
        focusNodeIdOnNextRenderRef.current = draggedNodeId;
        onMoveNodeRef.current(draggedNodeId, preview.moveTarget.newParentId, preview.moveTarget.newIndex);
      } else if (finalPosition) {
        // Position-only drag: skip full render, just persist position in place
        skipNextLayoutRef.current = true;
        onUpdateNodePositionRef.current(draggedNodeId, finalPosition);
      }

      clearTransientDragStates();
      ensureNodesAboveEdges();
    });

    graphRef.current = graph;

    return () => {
      draggingNodeIdRef.current = null;
      dropPreviewRef.current = null;
      try {
        graph.destroy();
      } catch {
        // ignore
      }
      graphRef.current = null;
    };
  }, [renderMode, startEditingNode]);

  // Custom trackpad two-finger pan and pinch-to-zoom via native wheel events
  useEffect(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;

    const container = containerRef.current;
    if (!container) return;

    const ZOOM_MIN = 0.1;
    const ZOOM_MAX = 5;
    const PINCH_SENSITIVITY = 0.005;

    const onWheel = (e: WheelEvent) => {
      if (e.metaKey) return;

      if (e.ctrlKey) {
        e.preventDefault();

        const canvasPoint = graph.getCanvasByClient([e.clientX, e.clientY]);
        const currentZoom = graph.getZoom();
        const scaleDelta = Math.exp(-e.deltaY * PINCH_SENSITIVITY);
        let newZoom = currentZoom * scaleDelta;

        if (newZoom < ZOOM_MIN) newZoom = ZOOM_MIN;
        if (newZoom > ZOOM_MAX) newZoom = ZOOM_MAX;

        if (Math.abs(newZoom - currentZoom) < 0.0001) return;

        graph.zoomTo(newZoom, false, canvasPoint);
      } else {
        e.preventDefault();
        graph.translateBy([e.deltaX, e.deltaY], false);
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel);
    };
  }, [renderMode]);

  // Update graph data when tree changes
  useEffect(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;

    // Position-only updates (e.g. after a node drag with no reparenting)
    // should not trigger a full setData+render cycle, because G6's render()
    // resets the canvas viewport and the async restore races with G6 internals.
    // Instead we only re-apply the persisted positions directly.
    if (skipNextLayoutRef.current) {
      skipNextLayoutRef.current = false;
      applyPersistedNodePositions(graph, tree.root)
        .then(() => applyParallelStraightEdgeLayout(graph as any, tree.root, layoutDirectionRef.current))
        .catch(() => {});
      return;
    }

    const focusNodeId = focusNodeIdOnNextRenderRef.current;
    focusNodeIdOnNextRenderRef.current = null;

    const savedViewport = viewportBeforeCommitRef.current;
    viewportBeforeCommitRef.current = null;
    const viewportState = savedViewport ?? readGraphViewportState(graph);
    graph.setData(toG6GraphData(tree, layoutDirectionRef.current));
    graph
      .render()
      .then(async () => {
        await applyPersistedNodePositions(graph, tree.root);
        await applyParallelStraightEdgeLayout(graph as any, tree.root, layoutDirectionRef.current);

        if (focusNodeId) {
          await focusGraphViewportOnNode(graph, focusNodeId);
        } else {
          await restoreGraphViewportState(graph, viewportState);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await restoreGraphViewportState(graph, viewportState);
        }

        const nodeData = graph.getNodeData() as Array<{ id?: string }>;
        const edgeData = graph.getEdgeData() as Array<{ id?: string }>;
        const zIndexById: Record<string, number> = {};

        for (const edge of edgeData) {
          if (edge?.id) zIndexById[edge.id] = 0;
        }

        for (const node of nodeData) {
          if (!node?.id) continue;
          zIndexById[node.id] = 10;

          const currentStates = graph.getElementState(node.id);
          if (!currentStates?.length) continue;

          const nextStates = currentStates.filter(
            (state) => !TRANSIENT_DRAG_STATES.includes(state as (typeof TRANSIENT_DRAG_STATES)[number]),
          );
          if (nextStates.length !== currentStates.length) {
            graph.setElementState(node.id, nextStates).catch(() => {});
          }
        }

        if (Object.keys(zIndexById).length > 0) {
          graph.setElementZIndex(zIndexById).catch(() => {});
        }
      })
      .catch(() => {});
  }, [tree]);

  // Update layout when direction changes
  useEffect(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;

    const applyLayout = async () => {
      try {
        const viewportState = readGraphViewportState(graph);
        graph.setLayout(getLayoutConfig(layoutDirection));
        await graph.layout();
        await applyPersistedNodePositions(graph, treeRef.current.root);
        await applyParallelStraightEdgeLayout(graph as any, treeRef.current.root, layoutDirection);
        await restoreGraphViewportState(graph, viewportState);
      } catch {
        // ignore layout errors during rapid switching
      }
    };

    applyLayout();
  }, [layoutDirection]);

  // Highlight selected node
  useEffect(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;

    if (selectedNodeId) {
      graph.setElementState(selectedNodeId, ['selected']).catch(() => {});
    }
  }, [selectedNodeId]);

  useEffect(() => {
    if (!editingNodeId || !editRect) return;

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
  }, [editingNodeId, editRect]);

  return (
    <div ref={containerRef} className="mindmap-canvas">
      {editingNodeId && editRect && (
        <textarea
          ref={textareaRef}
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (editValue.trim()) {
                commitEdit(editValue);
              } else {
                cancelEdit();
                onEnterWithoutText?.();
              }
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            }
          }}
          onBlur={() => commitEdit(editValue)}
          className="node-inline-editor"
          style={{
            position: 'fixed',
            left: editRect.left,
            top: editRect.top,
            width: editRect.width,
            height: editRect.height,
            zIndex: 1000,
            border: '2px solid #1A1A1A',
            borderRadius: 12,
            padding: '8px 12px',
            fontSize: 14,
            lineHeight: 1.5,
            resize: 'none',
            outline: 'none',
            background: '#FFFFFFFE',
            color: '#1A1A1A',
            fontFamily: 'system-ui, sans-serif',
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
          }}
        />
      )}
    </div>
  );
});
