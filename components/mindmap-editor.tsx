'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Graph } from '@antv/g6';

import type { LayoutDirection, MindMapTree } from '@/lib/types/mindmap';
import { getLayoutConfig, getNodeSize, toG6GraphData } from '@/lib/utils/g6';
import { countNodes } from '@/lib/utils/tree';
import { createLayerRenderer, selectRenderMode } from '@/lib/utils/renderer';

export interface MindMapEditorRef {
  exportPngDataUrl: () => Promise<string | null>;
  startEditingNode: (nodeId: string) => void;
}

interface MindMapEditorProps {
  tree: MindMapTree;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onUpdateNodeContent: (id: string, content: string) => void;
  layoutDirection: LayoutDirection;
  onMoveNode: (nodeId: string, newParentId: string, index: number) => void;
  onEditEnd?: (nodeId: string, committed: boolean, finalText: string, originalText: string) => void;
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

export const MindMapEditor = forwardRef<MindMapEditorRef, MindMapEditorProps>(function MindMapEditor(
  { tree, selectedNodeId, onSelectNode, onUpdateNodeContent, layoutDirection, onMoveNode, onEditEnd },
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

  const commitEdit = useCallback(
    (value: string) => {
      const nodeId = editingNodeId;
      const originalText = originalEditValueRef.current;
      if (nodeId && value.trim()) {
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
    (nodeId: string) => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      if (!graph || graph.destroyed) return;

      const nodeData = graph.getNodeData(nodeId);
      if (!nodeData) return;

      const label = (nodeData.data?.label as string) || '';
      setEditValue(label);
      originalEditValueRef.current = label;
      setEditingNodeId(nodeId);

      // Strategy 1: getElementRenderBounds + getClientByCanvas
      // Strategy 2: find SVG DOM element by node ID
      // Strategy 3: fallback to canvas center
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;

        const canvasEl = container.querySelector('canvas') || container.querySelector('svg');
        if (!canvasEl) return;

        let rect: DOMRect | null = null;

        // --- Strategy 1: use G6's coordinate API ---
        try {
          const bounds = graph.getElementRenderBounds(nodeId);
          if (bounds) {
            const minX = Math.min(bounds.min[0], bounds.max[0]);
            const minY = Math.min(bounds.min[1], bounds.max[1]);
            const maxX = Math.max(bounds.min[0], bounds.max[0]);
            const maxY = Math.max(bounds.min[1], bounds.max[1]);
            const w = maxX - minX;
            const h = maxY - minY;

            // Convert canvas (graph) coords to browser client coords
            const topLeft = graph.getClientByCanvas([minX, minY]);
            const bottomRight = graph.getClientByCanvas([maxX, maxY]);

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
            // G6 SVG renderer assigns node IDs as element IDs
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

        // Ensure minimum dimensions for comfortable editing
        const minW = 180;
        const minH = 44;
        if (rect.width < minW || rect.height < minH) {
          rect = new DOMRect(
            rect.left - (minW - rect.width) / 2,
            rect.top - (minH - rect.height) / 2,
            Math.max(rect.width, minW),
            Math.max(rect.height, minH),
          );
        }

        setEditRect(rect);
      });
    },
    [tree.root.id],
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
    const container = containerRef.current;
    if (!container) return;

    const graph = new Graph({
      container,
      autoResize: true,
      data: toG6GraphData(tree),
      layout: getLayoutConfig(layoutDirection),
      renderer: createLayerRenderer(renderMode),
      node: {
        type: 'rect',
        style: {
          size: (datum: { data?: { label?: string; _width?: number; _height?: number }; id?: string }) => {
            const metrics = getNodeTextMetrics(datum, tree.root.id);
            return [metrics.width, metrics.height];
          },
          radius: 12,
          fill: (datum: { id?: string }) => (datum.id === tree.root.id ? '#F5F5F2' : '#FFFFFFFE'),
          stroke: (datum: { id?: string }) => (datum.id === tree.root.id ? '#1A1A1A' : '#E6E6DC'),
          lineWidth: (datum: { id?: string }) => (datum.id === tree.root.id ? 2 : 1),
          label: true,
          labelPlacement: 'center',
          labelTextAlign: 'center',
          labelTextBaseline: 'middle',
          labelText: (datum: { data?: { label?: string } }) => datum.data?.label || '',
          labelFill: '#1A1A1A',
          labelFontSize: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) =>
            getNodeTextMetrics(datum, tree.root.id).fontSize,
          labelFontWeight: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) =>
            getNodeTextMetrics(datum, tree.root.id).fontWeight,
          labelWordWrap: true,
          labelMaxWidth: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) => {
            const metrics = getNodeTextMetrics(datum, tree.root.id);
            return metrics.labelMaxWidth;
          },
          labelMaxLines: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) => {
            const metrics = getNodeTextMetrics(datum, tree.root.id);
            return metrics.lineCount;
          },
          labelTextOverflow: 'clip',
          labelLineHeight: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number } }) =>
            getNodeTextMetrics(datum, tree.root.id).lineHeight,
        },
      },
      edge: {
        type: 'polyline',
        style: {
          lineWidth: 1.2,
          stroke: '#7A7A70',
          radius: 14,
        },
      },
      behaviors: ['drag-canvas', 'zoom-canvas', 'click-select', 'drag-node'],
      animation: false,
    });

    graph.on('node:click', (evt: any) => {
      onSelectNode(evt?.target?.id ?? null);
    });

    graph.on('node:dblclick', (evt: any) => {
      const nodeId = evt?.target?.id ?? null;
      if (nodeId) {
        onSelectNode(nodeId);
        startEditingNode(nodeId);
      }
    });

    graph.on('node:dragend', (evt: any) => {
      const draggedNodeId = evt?.target?.id;
      const dropTargetId = evt?.dropTarget?.id;

      if (
        draggedNodeId &&
        dropTargetId &&
        draggedNodeId !== dropTargetId &&
        draggedNodeId !== tree.root.id
      ) {
        onMoveNode(draggedNodeId, dropTargetId, 0);
      }
    });

    graphRef.current = graph;

    return () => {
      try {
        graph.destroy();
      } catch {
        // ignore
      }
      graphRef.current = null;
    };
  }, [onSelectNode, renderMode, tree, startEditingNode, layoutDirection, onMoveNode]);

  // Update graph data when tree changes
  useEffect(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;

    graph.setData(toG6GraphData(tree));
    graph.render().catch(() => {});
  }, [tree]);

  // Update layout when direction changes
  useEffect(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;

    const applyLayout = async () => {
      try {
        graph.setLayout(getLayoutConfig(layoutDirection));
        await graph.layout();
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
              commitEdit(editValue);
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
