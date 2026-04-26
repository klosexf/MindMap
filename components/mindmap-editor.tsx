'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Graph } from '@antv/g6';

import type { MindMapTree } from '@/lib/types/mindmap';
import { toG6GraphData } from '@/lib/utils/g6';
import { countNodes } from '@/lib/utils/tree';
import { createLayerRenderer, selectRenderMode } from '@/lib/utils/renderer';

export interface MindMapEditorRef {
  exportPngDataUrl: () => Promise<string | null>;
}

interface MindMapEditorProps {
  tree: MindMapTree;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
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

interface NodeTextMetrics {
  width: number;
  height: number;
  labelMaxWidth: number;
  lineCount: number;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
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

function getNodeTextMetrics(datum: { id?: string; data?: { label?: string } }, rootId: string): NodeTextMetrics {
  const text = datum.data?.label || '';
  const isRoot = datum.id === rootId;
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

  return {
    width: nodeWidth,
    height: nodeHeight,
    labelMaxWidth,
    lineCount: wrappedLines.length,
    fontSize,
    fontWeight,
    lineHeight,
  };
}

export const MindMapEditor = forwardRef<MindMapEditorRef, MindMapEditorProps>(function MindMapEditor(
  { tree, selectedNodeId, onSelectNode },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const nodeCount = useMemo(() => countNodes(tree.root), [tree]);
  const renderMode = useMemo(() => selectRenderMode(nodeCount), [nodeCount]);

  useImperativeHandle(ref, () => ({
    exportPngDataUrl: async () => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      if (!graph || graph.destroyed) return null;
      return graph.toDataURL({ mode: 'overall', type: 'image/png', encoderOptions: 1 });
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const graph = new Graph({
      container,
      autoResize: true,
      data: toG6GraphData(tree),
      layout: {
        type: 'mindmap',
        direction: 'H',
        getHeight: () => 36,
        getWidth: () => 160,
        getVGap: () => 16,
        getHGap: () => 60,
      },
      renderer: createLayerRenderer(renderMode),
      node: {
        type: 'rect',
        style: {
          size: (datum: { data?: { label?: string }; id?: string }) => {
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
          labelFontSize: (datum: { id?: string; data?: { label?: string } }) =>
            getNodeTextMetrics(datum, tree.root.id).fontSize,
          labelFontWeight: (datum: { id?: string; data?: { label?: string } }) =>
            getNodeTextMetrics(datum, tree.root.id).fontWeight,
          labelWordWrap: true,
          labelMaxWidth: (datum: { id?: string; data?: { label?: string } }) => {
            const metrics = getNodeTextMetrics(datum, tree.root.id);
            return metrics.labelMaxWidth;
          },
          labelMaxLines: (datum: { id?: string; data?: { label?: string } }) => {
            const metrics = getNodeTextMetrics(datum, tree.root.id);
            return metrics.lineCount;
          },
          labelTextOverflow: 'clip',
          labelLineHeight: (datum: { id?: string; data?: { label?: string } }) =>
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
      behaviors: ['drag-canvas', 'zoom-canvas', 'click-select'],
      animation: false,
    });

    graph.on('node:click', (evt: any) => {
      onSelectNode(evt?.target?.id ?? null);
    });

    graph.render();
    graph.fitView();
    graphRef.current = graph;

    return () => {
      const current = graph as Graph & { destroyed?: boolean };
      if (!current.destroyed) {
        current.destroy();
      }
      graphRef.current = null;
    };
  }, [onSelectNode, renderMode, tree]);

  useEffect(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed || !selectedNodeId) return;

    graph.focusElement(selectedNodeId, true);
  }, [selectedNodeId]);

  return (
    <div className="editor-wrap">
      <div className="editor-meta">
        <span>节点数: {nodeCount}</span>
        <span>渲染模式: {renderMode.toUpperCase()}</span>
      </div>
      <div ref={containerRef} className="editor-canvas" />
    </div>
  );
});
