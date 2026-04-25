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
          size: [164, 40],
          radius: 12,
          fill: (datum: { id?: string }) => (datum.id === tree.root.id ? '#F5F5F2' : '#FFFFFFFE'),
          stroke: (datum: { id?: string }) => (datum.id === tree.root.id ? '#1A1A1A' : '#E6E6DC'),
          lineWidth: (datum: { id?: string }) => (datum.id === tree.root.id ? 2 : 1),
          label: true,
          labelText: (datum: { data?: { label?: string } }) => datum.data?.label || '',
          labelFill: '#1A1A1A',
          labelFontSize: (datum: { id?: string }) => (datum.id === tree.root.id ? 14 : 12),
          labelFontWeight: (datum: { id?: string }) => (datum.id === tree.root.id ? 600 : 500),
          labelWordWrap: true,
          labelMaxWidth: 140,
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
