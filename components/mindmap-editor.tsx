'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Graph } from '@antv/g6';

import type { LayoutDirection, MindMapTree, MindMapNode, NodePosition } from '@/lib/types/mindmap';
import {
  applyParallelStraightEdgeLayout,
  EDGE_VISUAL_TOKENS,
  getBranchColor,
  getEdgeRenderStyle,
  getEdgeRenderType,
  getLayoutConfig,
  getNodeFontMetrics,
  getNodeSize,
  NODE_RADIUS_TOKENS,
  NOTE_ICON_SRC,
  NOTE_ICON_TOKENS,
  NODE_VISUAL_TOKENS,
  toG6GraphData,
} from '@/lib/utils/g6';
import {
  ARROW_PAN_TAP_MIN_STEP,
  clampArrowPanOffset,
  computeArrowPanOffset,
  computeArrowPanTailOffset,
  computeZoomStepTarget,
  focusGraphViewportOnNode,
  getArrowPanDirection,
  getArrowPanUnit,
  getZoomStepDirection,
  getViewportLockedEditorRect,
  readGraphViewportState,
  restoreGraphViewportState,
  type ArrowPanDirection,
  type GraphContentBounds,
} from '@/lib/utils/g6-viewport';
import {
  countNodes,
  findClosestRectByBorderProximity,
  findParentInfo,
  getNodeDepth,
  inferDropModeFromPoint,
  resolveDropMoveTarget,
  type DropMoveMode,
  type DropSiblingPlacement,
} from '@/lib/utils/tree';
import { createLayerRenderer, selectRenderMode } from '@/lib/utils/renderer';

/** +/- 键按住连续缩放时，相邻两步的最小间隔（毫秒） */
const ZOOM_KEY_REPEAT_THROTTLE_MS = 150;
/** 单步缩放的平滑动画时长（毫秒） */
const ZOOM_KEY_ANIMATION_MS = 200;

export interface MindMapEditorRef {
  exportPngDataUrl: () => Promise<string | null>;
  startEditingNode: (nodeId: string, options?: StartEditingOptions) => void;
  /** 平滑把画布视口聚焦到指定节点（演示模式逐步展开时使用）。 */
  focusNode: (nodeId: string) => Promise<void>;
}

interface MindMapEditorProps {
  tree: MindMapTree;
  selectedNodeId: string | null;
  /** 实时生成回放中：行内编辑锁定 + 视口恢复降频 + render 在途守卫加速 */
  generating?: boolean;
  /** AI 分支扩展打字机节点：新节点以「生成中」高亮呈现（null = 清除） */
  aiTypingNodeId?: string | null;
  onSelectNode: (id: string | null) => void;
  onUpdateNodeContent: (id: string, content: string) => void;
  layoutDirection: LayoutDirection;
  onMoveNode: (nodeId: string, newParentId: string, index: number) => void;
  onUpdateNodePosition: (nodeId: string, position: NodePosition) => void;
  onEditEnd?: (nodeId: string, committed: boolean, finalText: string, originalText: string) => void;
  onEnterWithoutText?: () => void;
  /** 选中节点变化或其屏幕位置移动（平移/缩放/布局）时上报，rect 为 null 表示暂时隐藏悬浮操作框 */
  onSelectionChange?: (nodeId: string | null, rect: NodeClientRect | null) => void;
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

export interface NodeClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 从 G6 图实例读取节点的屏幕（client）矩形 */
export function readNodeClientRectWithGraph(graph: Graph, nodeId: string): NodeClientRect | null {
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

function isRightMouseButtonEvent(event: { button?: number; originalEvent?: { button?: number }; srcEvent?: { button?: number } } | null | undefined): boolean {
  return event?.button === 2 || event?.originalEvent?.button === 2 || event?.srcEvent?.button === 2;
}

const TRANSIENT_DRAG_STATES = ['dragging', 'drop-child', 'drop-sibling-before', 'drop-sibling-after'] as const;

function getNodeTextMetrics(datum: { id?: string; data?: { label?: string; _width?: number; _height?: number; _depth?: number; _hasNote?: boolean } }, rootId: string): NodeTextMetrics {
  const depth = typeof datum.data?._depth === 'number' ? datum.data._depth : undefined;
  const size = getNodeSize(datum.id || '', datum.data?.label || '', rootId, depth);
  const { fontSize, fontWeight } = getNodeFontMetrics(datum.id || '', rootId, depth);
  const lineHeight = fontSize * NODE_VISUAL_TOKENS.lineHeightMultiplier;
  const horizontalPadding = NODE_VISUAL_TOKENS.horizontalPadding;
  const labelMaxWidth = Math.max(size.width - horizontalPadding, 1);
  const lineCount = Math.round((size.height - NODE_VISUAL_TOKENS.verticalPadding) / lineHeight);
  // 有笔记的节点加宽以容纳右侧文档图标（与 toG6GraphData 的 _width 保持一致）
  const hasNote = Boolean(datum.data?._hasNote);

  return {
    width: size.width + (hasNote ? NOTE_ICON_TOKENS.reserveWidth : 0),
    height: size.height,
    labelMaxWidth,
    lineCount: Math.max(lineCount, 1),
    fontSize,
    fontWeight,
    lineHeight,
  };
}

/**
 * 暖调手作视觉方案：按节点层级返回填充/描边/文字色。
 * 根 = 陶土橙实心；一级分支 = 分支色实心（同分支同色）；
 * 二级 = 白底圆片；细节层（3 层及以下）= 无框纯文字。
 */
interface NodeDepthVisuals {
  fill: string;
  stroke: string;
  lineWidth: number;
  radius: number;
  labelFill: string;
}

function getNodeDepthVisuals(depth: number, branchIndex: number): NodeDepthVisuals {
  if (depth <= 0) {
    return {
      fill: NODE_VISUAL_TOKENS.rootFill,
      stroke: 'transparent',
      lineWidth: 0,
      radius: NODE_RADIUS_TOKENS.root,
      labelFill: NODE_VISUAL_TOKENS.rootText,
    };
  }
  if (depth === 1) {
    return {
      fill: getBranchColor(branchIndex),
      stroke: 'rgba(90, 50, 25, 0.18)',
      lineWidth: 1,
      radius: NODE_RADIUS_TOKENS.level1,
      labelFill: '#FFFDF8',
    };
  }
  if (depth === 2) {
    return {
      fill: NODE_VISUAL_TOKENS.fill,
      stroke: NODE_VISUAL_TOKENS.stroke,
      lineWidth: NODE_VISUAL_TOKENS.lineWidth,
      radius: NODE_RADIUS_TOKENS.level2,
      labelFill: NODE_VISUAL_TOKENS.level2Text,
    };
  }
  return {
    fill: 'transparent',
    stroke: 'transparent',
    lineWidth: 0,
    radius: NODE_RADIUS_TOKENS.detail,
    labelFill: NODE_VISUAL_TOKENS.detailText,
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
  { tree, selectedNodeId, generating = false, aiTypingNodeId = null, onSelectNode, onUpdateNodeContent, layoutDirection, onMoveNode, onUpdateNodePosition, onEditEnd, onEnterWithoutText, onSelectionChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const nodeCount = useMemo(() => countNodes(tree.root), [tree]);
  const renderMode = useMemo(() => selectRenderMode(nodeCount), [nodeCount]);

  // 节点 id → 一级分支序号（根为 -1，一级分支取下标，后代继承）。
  // 用于节点填充与连线着色：同一分支共享同一暖色。
  const branchIndexByNodeId = useMemo(() => {
    const map = new Map<string, number>();
    const walk = (node: MindMapNode, branchIndex: number) => {
      map.set(node.id, branchIndex);
      (node.children || []).forEach((child, index) => walk(child, branchIndex >= 0 ? branchIndex : index));
    };
    walk(tree.root, -1);
    return map;
  }, [tree]);
  // 同步维护 ref：Graph 配置里的样式回调只注册一次，经 ref 读取最新映射，
  // 避免把 branchIndexByNodeId 加进建图 effect 的依赖导致整图重建。
  const branchIndexByNodeIdRef = useRef(branchIndexByNodeId);
  branchIndexByNodeIdRef.current = branchIndexByNodeId;

  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editRect, setEditRect] = useState<DOMRect | null>(null);
  const [dynamicEditorHeight, setDynamicEditorHeight] = useState<number | null>(null);

  // 行内编辑器跟随被编辑节点的字体层级（根节点 = 大字号加粗，一级分支/二级/细节逐级缩小）
  const editingFontMetrics = useMemo(
    () =>
      editingNodeId
        ? getNodeFontMetrics(
            editingNodeId,
            tree.root.id,
            getNodeDepth(tree.root, editingNodeId) ?? undefined,
          )
        : null,
    [editingNodeId, tree],
  );

  const originalEditValueRef = useRef('');
  const draggingNodeIdRef = useRef<string | null>(null);
  const dropPreviewRef = useRef<DropPreview | null>(null);
  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  const editingNodeIdRef = useRef<string | null>(null);
  const treeRef = useRef(tree);
  const layoutDirectionRef = useRef(layoutDirection);
  const onSelectNodeRef = useRef(onSelectNode);
  const onMoveNodeRef = useRef(onMoveNode);
  const onUpdateNodePositionRef = useRef(onUpdateNodePosition);
  const skipNextLayoutRef = useRef(false);
  const focusNodeIdOnNextRenderRef = useRef<string | null>(null);
  const viewportBeforeCommitRef = useRef<ReturnType<typeof readGraphViewportState>>(null);

  // 生成期渲染控制：
  // - render 在途守卫：上一轮 render 未完成时跳过本轮全量渲染，保留最新树补渲染
  // - 视口降频：生成期仅首个 tick 恢复一次视口，避免与用户拖拽产生周期性回弹
  const generatingRef = useRef(generating);
  const renderInFlightRef = useRef(false);
  const pendingTreeRef = useRef<MindMapTree | null>(null);
  const generationViewportRestoredRef = useRef(false);
  const [renderTick, setRenderTick] = useState(0);
  const aiTypingNodeIdRef = useRef<string | null>(aiTypingNodeId);

  useEffect(() => {
    aiTypingNodeIdRef.current = aiTypingNodeId;
  }, [aiTypingNodeId]);

  // AI 分支扩展打字机节点高亮：在目标节点上挂 'ai-typing' 状态并清理其余节点。
  // setData+render 会重建元素导致状态丢失，渲染完成后的补挂由渲染 effect 调用本函数兜底。
  const syncAiTypingState = useCallback(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;
    const target = aiTypingNodeIdRef.current;
    const nodeData = graph.getNodeData() as Array<{ id?: string }>;

    for (const node of nodeData) {
      const nodeId = node?.id;
      if (!nodeId) continue;
      const states = graph.getElementState(nodeId);
      const hasTyping = states?.includes('ai-typing');
      if (nodeId === target && !hasTyping) {
        graph.setElementState(nodeId, [...(states ?? []), 'ai-typing']).catch(() => {});
      } else if (nodeId !== target && hasTyping) {
        graph.setElementState(nodeId, (states ?? []).filter((state) => state !== 'ai-typing')).catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    syncAiTypingState();
  }, [aiTypingNodeId, syncAiTypingState]);

  useEffect(() => {
    generatingRef.current = generating;
    if (generating) {
      generationViewportRestoredRef.current = false;
    }
  }, [generating]);

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
      setDynamicEditorHeight(null);
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
    setDynamicEditorHeight(null);
    originalEditValueRef.current = '';
    if (nodeId) onEditEnd?.(nodeId, false, currentValue, originalText);
  }, [editingNodeId, editValue, onEditEnd]);

  /** Compute the screen position of a node and open the inline editor */
  const startEditingNode = useCallback(
    (nodeId: string, options?: StartEditingOptions) => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      if (!graph || graph.destroyed) return;
      // 实时生成回放中内容编辑锁定
      if (generatingRef.current) return;

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
    focusNode: async (nodeId: string) => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      if (!graph || graph.destroyed) return;
      await focusGraphViewportOnNode(graph, nodeId);
    },
  }));

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  useEffect(() => {
    editingNodeIdRef.current = editingNodeId;
  }, [editingNodeId]);

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

  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

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
          size: (datum: { data?: { label?: string; _width?: number; _height?: number; _depth?: number }; id?: string }) => {
            const metrics = getNodeTextMetrics(datum, treeRef.current.root.id);
            return [metrics.width, metrics.height];
          },
          radius: (datum: { data?: { _depth?: number } }) =>
            getNodeDepthVisuals(datum.data?._depth ?? 1, -1).radius,
          fill: (datum: { data?: { _depth?: number; _branchIndex?: number } }) =>
            getNodeDepthVisuals(datum.data?._depth ?? 1, datum.data?._branchIndex ?? -1).fill,
          stroke: (datum: { data?: { _depth?: number; _branchIndex?: number } }) =>
            getNodeDepthVisuals(datum.data?._depth ?? 1, datum.data?._branchIndex ?? -1).stroke,
          lineWidth: (datum: { data?: { _depth?: number; _branchIndex?: number } }) =>
            getNodeDepthVisuals(datum.data?._depth ?? 1, datum.data?._branchIndex ?? -1).lineWidth,
          label: true,
          labelPlacement: 'left',
          labelTextAlign: 'left',
          labelTextBaseline: 'middle',
          // 左对齐后从节点左边缘缩进半个水平内边距，保持左右各 18px 视觉留白
          labelOffsetX: NODE_VISUAL_TOKENS.horizontalPadding / 2,
          labelText: (datum: { data?: { label?: string } }) => datum.data?.label || '',
          labelFill: (datum: { data?: { _depth?: number; _branchIndex?: number } }) =>
            getNodeDepthVisuals(datum.data?._depth ?? 1, datum.data?._branchIndex ?? -1).labelFill,
          labelFontSize: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number; _depth?: number } }) =>
            getNodeTextMetrics(datum, treeRef.current.root.id).fontSize,
          labelFontWeight: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number; _depth?: number } }) =>
            getNodeTextMetrics(datum, treeRef.current.root.id).fontWeight,
          labelWordWrap: true,
          labelMaxWidth: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number; _depth?: number } }) => {
            const metrics = getNodeTextMetrics(datum, treeRef.current.root.id);
            return metrics.labelMaxWidth;
          },
          labelMaxLines: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number; _depth?: number } }) => {
            const metrics = getNodeTextMetrics(datum, treeRef.current.root.id);
            return metrics.lineCount;
          },
          labelTextOverflow: 'clip',
          labelLineHeight: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number; _depth?: number } }) =>
            getNodeTextMetrics(datum, treeRef.current.root.id).lineHeight,
          // 有笔记的节点在文本右侧显示便签图标（节点宽度已在 size/_width 中预留空间）。
          // G6 v5.1 节点 icon 无 placement 支持，固定居中；通过 iconX/iconY（相对节点中心，
          // 定位图标中心点）将图标放到右缘预留区内。
          icon: (datum: { data?: { _hasNote?: boolean } }) => Boolean(datum.data?._hasNote),
          iconSrc: NOTE_ICON_SRC,
          iconWidth: NOTE_ICON_TOKENS.iconWidth,
          iconHeight: NOTE_ICON_TOKENS.iconHeight,
          iconY: 0,
          iconX: (datum: { data?: { label?: string; _width?: number; _height?: number; _depth?: number; _hasNote?: boolean } }) => {
            const width = getNodeTextMetrics(datum, treeRef.current.root.id).width;
            return width / 2 - NOTE_ICON_TOKENS.reserveWidth / 2;
          },
        },
        state: {
          selected: {
            stroke: EDGE_VISUAL_TOKENS.stroke,
            lineWidth: 2.2,
            // 覆盖 G6 主题 selected 状态默认的 labelFontSize:12 / labelFontWeight:'bold'，
            // 避免选中（含加载时自动选中根节点）把根节点的大字号加粗标题压扁。
            labelFontSize: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number; _depth?: number } }) =>
              getNodeTextMetrics(datum, treeRef.current.root.id).fontSize,
            labelFontWeight: (datum: { id?: string; data?: { label?: string; _width?: number; _height?: number; _depth?: number } }) =>
              getNodeTextMetrics(datum, treeRef.current.root.id).fontWeight,
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
          'ai-typing': {
            // AI 分支扩展打字机节点：紫色描边 + 浅紫底，与选中态（暖灰）、
            // 拖放态（蓝/橙）明确区分，标示「内容来自 AI 且正在生成」。
            stroke: '#7C3AED',
            lineWidth: 2.2,
            fill: '#F5F3FF',
          },
        },
      },
      edge: {
        type: (datum) => getEdgeRenderType(datum),
        style: (datum) => {
          const baseStyle = getEdgeRenderStyle(datum);
          // 连线继承目标节点（子节点）所属一级分支的暖色：根→分支用分支色，分支内保持同色
          const edgeData = datum as { source?: string; target?: string };
          const branchIndex = branchIndexByNodeIdRef.current.get(String(edgeData.target ?? ''))
            ?? branchIndexByNodeIdRef.current.get(String(edgeData.source ?? ''))
            ?? -1;
          return { ...baseStyle, stroke: getBranchColor(branchIndex) };
        },
      },
      behaviors: [
        'drag-canvas',
        'click-select',
        {
          type: 'drag-element',
          key: 'drag-element',
          hideEdge: 'none',
          shadow: false,
          enable: (
            event: {
              targetType?: string;
              target?: { id?: string };
              button?: number;
              originalEvent?: { button?: number };
              srcEvent?: { button?: number };
            },
          ) =>
            event.targetType === 'node' &&
            event.target?.id !== treeRef.current.root.id &&
            isRightMouseButtonEvent(event),
        },
      ],
      animation: false,
    });

    const suppressCanvasContextMenu = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('.node-inline-editor')) return;
      event.preventDefault();
    };

    container.addEventListener('contextmenu', suppressCanvasContextMenu);

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

    const readNodeClientRect = (nodeId: string): NodeClientRect | null =>
      readNodeClientRectWithGraph(graph, nodeId);

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

    // 点击画布空白处取消节点选中，让方向键画布拖动等无选中交互可以激活
    graph.on('canvas:click', () => {
      onSelectNodeRef.current(null);
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
      container.removeEventListener('contextmenu', suppressCanvasContextMenu);
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
    // Mouse wheels emit large discrete deltaY values (~100-120 per notch),
    // while trackpad gestures emit small continuous ones. A lower sensitivity
    // keeps each wheel notch at ~15% zoom instead of ~45%.
    const WHEEL_SENSITIVITY = 0.0015;

    const onWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();

        // graph.zoomTo() expects the zoom anchor (origin) in viewport coordinates.
        // getCanvasByClient returns canvas/world coordinates, which would anchor the
        // zoom at the wrong point and shift content out of view. Convert to viewport
        // coordinates before passing it as the origin.
        const canvasPoint = graph.getCanvasByClient([e.clientX, e.clientY]);
        const viewportPoint = graph.getViewportByCanvas(canvasPoint);
        const currentZoom = graph.getZoom();
        const sensitivity = Math.abs(e.deltaY) >= 50 ? WHEEL_SENSITIVITY : PINCH_SENSITIVITY;
        const scaleDelta = Math.exp(-e.deltaY * sensitivity);
        let newZoom = currentZoom * scaleDelta;

        if (newZoom < ZOOM_MIN) newZoom = ZOOM_MIN;
        if (newZoom > ZOOM_MAX) newZoom = ZOOM_MAX;

        if (Math.abs(newZoom - currentZoom) < 0.0001) return;

        graph.zoomTo(newZoom, false, viewportPoint);
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

  // 无节点选中时，方向键平滑拖动整个画布（视口向按键方向平移，与滚轮/滚动条语义一致）
  // 轻点一下 = 平滑滑行一个最小步距；按住不放 = 连续平移；快速连按 = 步距累加
  useEffect(() => {
    interface ArrowPanSession {
      startedAt: number;
      lastFrameAt: number;
      rafId: number;
      contentBounds: GraphContentBounds | null;
      /** 本次会话累计位移（视口像素） */
      movedDistance: number;
      /** 松开按键后需要滑行到的目标距离；null 表示无收尾滑行 */
      tailTarget: number | null;
      /** 最近一次按住方向的单位向量，收尾滑行沿用 */
      lastUnit: [number, number];
      /** 收尾滑行连续无位移的帧数，用于边界钳制场景下的兜底退出 */
      idleTailFrames: number;
    }

    const activeDirections = new Set<ArrowPanDirection>();
    let session: ArrowPanSession | null = null;
    /** 上一次 +/- 键缩放生效时刻，用于按住时的重复节流 */
    let lastZoomStepAt = 0;

    const getAliveGraph = () => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      return graph && !graph.destroyed ? graph : null;
    };

    const readContentBounds = (graph: Graph): GraphContentBounds | null => {
      try {
        const bounds = graph.getCanvas().getBounds() as { min?: ArrayLike<number>; max?: ArrayLike<number> } | null;
        const minX = Number(bounds?.min?.[0]);
        const minY = Number(bounds?.min?.[1]);
        const maxX = Number(bounds?.max?.[0]);
        const maxY = Number(bounds?.max?.[1]);
        // 空画布的 AABB 会是 ±Infinity，统一按无内容处理（不平移限制）
        if (![minX, minY, maxX, maxY].every((value) => Number.isFinite(value))) {
          return null;
        }
        if (maxX < minX || maxY < minY) return null;
        return { min: [minX, minY], max: [maxX, maxY] };
      } catch {
        return null;
      }
    };

    const stopPan = () => {
      if (session) {
        cancelAnimationFrame(session.rafId);
        session = null;
      }
      activeDirections.clear();
    };

    const step = (now: number) => {
      const graph = getAliveGraph();
      const held = activeDirections.size > 0;
      const tailActive = session?.tailTarget !== null && session !== null && session.movedDistance < session.tailTarget - 0.5;
      // 会话期间出现选中节点 / 进入编辑 / 画布销毁 / 既未按住也无收尾滑行时停止
      if (
        !graph ||
        !session ||
        (!held && !tailActive) ||
        selectedNodeIdRef.current !== null ||
        editingNodeIdRef.current !== null
      ) {
        stopPan();
        return;
      }

      const frameDeltaMs = now - session.lastFrameAt;
      let offset: [number, number];
      if (held) {
        session.lastUnit = getArrowPanUnit(activeDirections);
        offset = computeArrowPanOffset(activeDirections, now - session.startedAt, frameDeltaMs);
      } else {
        offset = computeArrowPanTailOffset(
          session.lastUnit,
          (session.tailTarget ?? 0) - session.movedDistance,
          frameDeltaMs,
        );
      }
      session.lastFrameAt = now;

      if (offset[0] !== 0 || offset[1] !== 0) {
        let nextOffset: [number, number] = [0, 0];
        try {
          nextOffset = clampArrowPanOffset(offset, {
            position: graph.getPosition(),
            zoom: graph.getZoom(),
            canvasSize: graph.getSize(),
            contentBounds: session.contentBounds,
          });
        } catch {
          nextOffset = [0, 0];
        }

        if (nextOffset[0] !== 0 || nextOffset[1] !== 0) {
          graph.translateBy(nextOffset, false);
          session.movedDistance += Math.hypot(nextOffset[0], nextOffset[1]);
          session.idleTailFrames = 0;
        } else if (!held) {
          // 收尾滑行被边界钳制为 0（如已到画布边缘）：兜底退出，避免空转
          session.idleTailFrames += 1;
          if (session.idleTailFrames > 5) {
            stopPan();
            return;
          }
        }
      } else if (!held) {
        // 收尾滑行无剩余距离：由 tailActive 条件在下一帧退出
        session.idleTailFrames += 1;
        if (session.idleTailFrames > 5) {
          stopPan();
          return;
        }
      }

      session.rafId = requestAnimationFrame(step);
    };

    const isEditableTarget = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element || typeof element.tagName !== 'string') return false;
      const tag = element.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // +/- 键缩放：以视口中心为锚点，每按一步 ×1.2，按住时依赖系统按键重复连续缩放
      const zoomDirection = getZoomStepDirection(event.key);
      if (zoomDirection) {
        // Ctrl/Cmd/Alt 组合保留给浏览器 / 系统快捷键；
        // Shift 允许（主键盘的 + 依赖 Shift+=）
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // 与方向键拖动相同的激活守卫
        if (selectedNodeIdRef.current !== null) return;
        if (editingNodeIdRef.current !== null || isEditableTarget(event.target)) return;
        const graph = getAliveGraph();
        if (!graph) return;

        event.preventDefault();
        // 按键重复触发过快时节流，保证按住时缩放速度适中
        const now = performance.now();
        if (now - lastZoomStepAt < ZOOM_KEY_REPEAT_THROTTLE_MS) return;
        lastZoomStepAt = now;

        const currentZoom = graph.getZoom();
        const targetZoom = computeZoomStepTarget(currentZoom, zoomDirection);
        if (Math.abs(targetZoom - currentZoom) < 0.0001) return;

        const [width, height] = graph.getSize();
        graph.zoomTo(targetZoom, { duration: ZOOM_KEY_ANIMATION_MS }, [width / 2, height / 2]);
        return;
      }

      const direction = getArrowPanDirection(event.key);
      if (!direction) return;
      // 修饰键组合保留给浏览器 / 系统快捷键
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      // 仅在无节点选中时激活；有选中时方向键保持原有行为
      if (selectedNodeIdRef.current !== null) return;
      // 行内编辑或焦点在表单元素内时，方向键维持文本编辑行为
      if (editingNodeIdRef.current !== null || isEditableTarget(event.target)) return;
      if (!getAliveGraph()) return;

      event.preventDefault();

      // 忽略按键自动重复触发
      if (activeDirections.has(direction)) return;

      const wasIdle = activeDirections.size === 0;
      activeDirections.add(direction);
      // 立即记录方向单位向量：轻点时按键可能在第一帧渲染前就松开，
      // 收尾滑行需要依赖这里记录的方向
      const unit = getArrowPanUnit(activeDirections);

      if (!session) {
        const graph = getAliveGraph();
        const now = performance.now();
        session = {
          startedAt: now,
          lastFrameAt: now,
          rafId: requestAnimationFrame(step),
          contentBounds: graph ? readContentBounds(graph) : null,
          movedDistance: 0,
          tailTarget: null,
          lastUnit: unit,
          idleTailFrames: 0,
        };
      } else {
        session.lastUnit = unit;
        session.idleTailFrames = 0;
        if (wasIdle) {
          // 收尾滑行途中再次按下：在当前进度上追加一个轻点步距，快速连按可持续移动
          session.tailTarget = Math.max(session.tailTarget ?? 0, session.movedDistance + ARROW_PAN_TAP_MIN_STEP);
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const direction = getArrowPanDirection(event.key);
      if (!direction || !activeDirections.has(direction)) return;
      activeDirections.delete(direction);

      if (activeDirections.size === 0 && session) {
        if (session.movedDistance >= ARROW_PAN_TAP_MIN_STEP) {
          // 已移动超过轻点步距（长按场景），松开立即停止
          stopPan();
        } else {
          // 轻点场景：继续滑行到最小步距，由 step 循环收尾
          session.tailTarget = ARROW_PAN_TAP_MIN_STEP;
        }
      }
    };

    // 切走窗口 / 失焦时按键不会再触发 keyup，必须立即停止
    const onBlur = () => stopPan();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      stopPan();
    };
  }, [renderMode]);

  // 按住空格键 + 鼠标左键拖动：从任意位置（含节点上方）平移画布。
  // 在捕获阶段拦截 pointerdown 并 preventDefault，阻止浏览器对
  // SVG 节点文字启动原生选区；stopPropagation 避免与 G6 的
  // drag-canvas / click-select 等行为叠加响应。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let spaceHeld = false;
    let panning = false;
    let activePointerId: number | null = null;
    let lastX = 0;
    let lastY = 0;

    const getAliveGraph = () => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      return graph && !graph.destroyed ? graph : null;
    };

    const isEditableTarget = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element || typeof element.tagName !== 'string') return false;
      const tag = element.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
    };

    const applyCursor = () => {
      container.style.cursor = spaceHeld ? (panning ? 'grabbing' : 'grab') : '';
    };

    const stopPan = () => {
      panning = false;
      activePointerId = null;
      applyCursor();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') return;
      // 修饰键组合保留给浏览器 / 系统快捷键
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // 行内编辑或焦点在表单元素内时，空格维持文本输入行为
      if (editingNodeIdRef.current !== null || isEditableTarget(event.target)) return;
      if (!getAliveGraph()) return;

      event.preventDefault();
      spaceHeld = true;
      applyCursor();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') return;
      spaceHeld = false;
      stopPan();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!spaceHeld || event.button !== 0) return;
      if (!getAliveGraph()) return;

      // preventDefault 取消后续的 mousedown，从根源上阻止文字选区；
      // stopPropagation 阻止事件到达 G6，避免与 drag-canvas / click-select 叠加。
      event.preventDefault();
      event.stopPropagation();

      try {
        container.setPointerCapture(event.pointerId);
      } catch {
        // 指针捕获失败不影响拖动
      }

      panning = true;
      activePointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      applyCursor();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!panning || activePointerId !== event.pointerId) return;

      const graph = getAliveGraph();
      if (!graph) {
        stopPan();
        return;
      }

      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;

      if (dx !== 0 || dy !== 0) {
        graph.translateBy([dx, dy], false);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!panning || activePointerId !== event.pointerId) return;
      stopPan();
    };

    // 切走窗口 / 失焦时按键不会再触发 keyup，必须立即停止
    const onBlur = () => {
      spaceHeld = false;
      stopPan();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    container.addEventListener('pointerdown', onPointerDown, true);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      container.removeEventListener('pointerdown', onPointerDown, true);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      spaceHeld = false;
      stopPan();
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

    // render 在途守卫：上一轮 render 尚未完成时跳过本轮全量渲染，
    // 仅保留最新树；render 完成后由 renderTick 补渲染（积压时靠合并窗口自然追赶）。
    if (renderInFlightRef.current) {
      pendingTreeRef.current = tree;
      // eslint-disable-next-line no-console -- 临时调试日志（验证逐个生长渲染后移除）
      console.log('[render] skip (in-flight), pending nodes=', countNodes(tree.root));
      return;
    }
    renderInFlightRef.current = true;
    // eslint-disable-next-line no-console -- 临时调试日志（验证逐个生长渲染后移除）
    console.log('[render] start nodes=', countNodes(tree.root), 't=', Math.round(performance.now()));

    const focusNodeId = focusNodeIdOnNextRenderRef.current;
    focusNodeIdOnNextRenderRef.current = null;

    const savedViewport = viewportBeforeCommitRef.current;
    viewportBeforeCommitRef.current = null;
    const viewportState = savedViewport ?? readGraphViewportState(graph);
    graph.setData(toG6GraphData(tree, layoutDirectionRef.current));
    graph
      .render()
      .then(async () => {
        // Structural/content changes need an explicit layout pass.
        // `render()` alone is not sufficient to reliably recompute node
        // positions after reparenting, resizing, or other non-position edits.
        await graph.layout();
        await applyPersistedNodePositions(graph, tree.root);
        await applyParallelStraightEdgeLayout(graph as any, tree.root, layoutDirectionRef.current);

        if (focusNodeId) {
          await focusGraphViewportOnNode(graph, focusNodeId);
        } else {
          // 生成期视口降频：仅首个 tick 恢复一次视口；后续 tick 跳过
          // restore，避免 G6 render 重置视口与用户拖拽产生周期性回弹。
          const skipViewportRestore =
            generatingRef.current && generationViewportRestoredRef.current;
          if (!skipViewportRestore) {
            await restoreGraphViewportState(graph, viewportState);
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await restoreGraphViewportState(graph, viewportState);
          }
          if (generatingRef.current) {
            generationViewportRestoredRef.current = true;
          }
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

        // render 重建元素后补挂打字机高亮（元素级状态不跨 setData 存活）
        syncAiTypingState();
      })
      .catch(() => {})
      .finally(() => {
        renderInFlightRef.current = false;
        // eslint-disable-next-line no-console -- 临时调试日志（验证逐个生长渲染后移除）
        console.log('[render] done t=', Math.round(performance.now()), 'hasPending=', !!pendingTreeRef.current);
        if (pendingTreeRef.current) {
          pendingTreeRef.current = null;
          setRenderTick((tick) => tick + 1);
        }
      });
  }, [tree, renderTick, syncAiTypingState]);

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

  // 悬浮操作框跟随：rAF 循环上报选中节点的屏幕矩形，
  // 覆盖画布平移/缩放/布局变化；行内编辑与拖拽期间抑制（rect 报 null）
  useEffect(() => {
    if (!selectedNodeId) {
      onSelectionChangeRef.current?.(null, null);
      return;
    }

    let rafId = 0;
    let last: NodeClientRect | null = null;

    const sameRect = (a: NodeClientRect | null, b: NodeClientRect | null) => {
      if (a === b) return true;
      if (!a || !b) return false;
      return (
        Math.abs(a.left - b.left) < 0.5 &&
        Math.abs(a.top - b.top) < 0.5 &&
        Math.abs(a.width - b.width) < 0.5 &&
        Math.abs(a.height - b.height) < 0.5
      );
    };

    const tick = () => {
      const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
      const suppressed = editingNodeIdRef.current !== null || draggingNodeIdRef.current !== null;

      let rect: NodeClientRect | null = null;
      if (graph && !graph.destroyed && !suppressed) {
        rect = readNodeClientRectWithGraph(graph, selectedNodeId);
      }

      if (!sameRect(rect, last)) {
        last = rect;
        onSelectionChangeRef.current?.(selectedNodeId, rect);
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [selectedNodeId, renderMode]);

  useEffect(() => {
    if (!editingNodeId || !editRect) return;

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
  }, [editingNodeId, editRect]);

  useLayoutEffect(() => {
    if (!editingNodeId || !editRect) {
      setDynamicEditorHeight(null);
      return;
    }

    const container = containerRef.current;
    const textarea = textareaRef.current;
    if (!container || !textarea) return;

    const viewportRect = container.getBoundingClientRect();
    const maxHeight = Math.max(viewportRect.bottom - editRect.top - 16, NODE_VISUAL_TOKENS.minNodeHeight);
    textarea.style.height = 'auto';

    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight + 4, editRect.height, NODE_VISUAL_TOKENS.minNodeHeight),
      maxHeight,
    );

    textarea.style.height = `${nextHeight}px`;
    setDynamicEditorHeight(nextHeight);
  }, [editingNodeId, editRect, editValue]);

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
            height: dynamicEditorHeight ?? editRect.height,
            zIndex: 1000,
            border: `2px solid ${EDGE_VISUAL_TOKENS.stroke}`,
            borderRadius: NODE_VISUAL_TOKENS.radius,
            padding: '10px 18px',
            fontSize: editingFontMetrics?.fontSize ?? NODE_VISUAL_TOKENS.fontSize,
            fontWeight: editingFontMetrics?.fontWeight ?? NODE_VISUAL_TOKENS.fontWeight,
            lineHeight: NODE_VISUAL_TOKENS.lineHeightMultiplier,
            resize: 'none',
            outline: 'none',
            background: NODE_VISUAL_TOKENS.fill,
            color: NODE_VISUAL_TOKENS.text,
            fontFamily: 'system-ui, sans-serif',
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
            overflow: 'hidden',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }}
        />
      )}
    </div>
  );
});
