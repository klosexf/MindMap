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
  snapViewportToNode,
  type ArrowPanDirection,
  type GraphContentBounds,
  type GraphViewportState,
} from '@/lib/utils/g6-viewport';
import {
  collectDescendantIds,
  countNodes,
  findClosestRectByBorderProximity,
  findNode,
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
  /**
   * 请求在「下一次全量渲染完成后」把视口聚焦到指定节点。
   * 与 focusNode 的区别：树数据即将变化时，立即聚焦会被随后的
   * setData+render 布局重算抵消；本方法把聚焦挂到渲染管线尾部，
   * 保证节点按新布局居中（AI 应用内容后保持视觉焦点时使用）。
   */
  focusNodeAfterRender: (nodeId: string) => void;
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
  /** 拖动整棵子树后的批量位置持久化（一次提交，撤销栈仅一条记录）；缺省时逐节点回退到 onUpdateNodePosition */
  onUpdateNodePositions?: (updates: Array<{ id: string; position: NodePosition }>) => void;
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

/** 矩形朝向另一矩形的锚点（对应边的中点），用于拖放连接线预览的端点贴合节点边缘 */
function getRectAnchorToward(rect: NodeClientRect, other: NodeClientRect): { x: number; y: number } {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const ocx = other.left + other.width / 2;
  const ocy = other.top + other.height / 2;
  // 比较归一化后的水平/垂直距离，选更主要的方向决定用左右边还是上下边
  if (Math.abs(ocx - cx) * rect.height >= Math.abs(ocy - cy) * rect.width) {
    return { x: ocx > cx ? rect.left + rect.width : rect.left, y: cy };
  }
  return { x: cx, y: ocy > cy ? rect.top + rect.height : rect.top };
}

/** 目标节点 → 被拖节点的虚线连接预览路径（child 模式：「将成为它的子节点」） */
function buildDropConnectorPath(from: NodeClientRect, to: NodeClientRect): string {
  const a = getRectAnchorToward(from, to);
  const b = getRectAnchorToward(to, from);
  const horizontal =
    Math.abs(b.x - a.x) * (from.height + to.height) >= Math.abs(b.y - a.y) * (from.width + to.width);
  if (horizontal) {
    const midX = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`;
  }
  const midY = (a.y + b.y) / 2;
  return `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
}

function isRightMouseButtonEvent(event: { button?: number; originalEvent?: { button?: number }; srcEvent?: { button?: number } } | null | undefined): boolean {
  return event?.button === 2 || event?.originalEvent?.button === 2 || event?.srcEvent?.button === 2;
}

const TRANSIENT_DRAG_STATES = ['dragging', 'drop-child', 'drop-sibling-before', 'drop-sibling-after'] as const;

// 结构性拖放后悬浮框沉降窗口（rAF 帧判定，见上报循环）：
// - MIN：dragend 到渲染真正启动之间的空窗（React 提交 → effect 触发），保持抑制
// - STABLE_FRAMES：承载 reparent 的渲染已完成后，节点 rect 再连续稳定这么多帧
//   才判定「落位完成」（覆盖 FLIP/聚焦动画尾段的亚阈值位移）
// - MAX：兜底上限，渲染管线异常时到时强制解除抑制
const DRAG_SETTLE_MIN_MS = 120;
const DRAG_SETTLE_STABLE_FRAMES = 8;
const DRAG_SETTLE_MAX_MS = 2500;

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

/**
 * 拖拽 reparent 的全量渲染会重建全部元素并依次执行 render→layout→并行边重算
 * （约 1~2s），期间画布会暴露中间态：节点停在过期位置、连线退化为长斜线、
 * 叶子节点短暂丢失卡片底。冻结帧用旧画面快照盖住画布，管线完成（FLIP Invert
 * 到位）后再揭示并播放 FLIP 动画，全程无中间态闪现。
 * 返回解冻函数（幂等，可安全重复调用）。
 */
function freezeGraphCanvasForDrag(container: HTMLElement): () => void {
  // G6 SVG 渲染器会在容器里创建多个 <svg> 图层（主画布 / 背景 / 插件层等），
  // 每层都有 #g-svg-camera。节点与连线内容在元素最多的主层里，
  // 必须冻结主层——取第一个带 camera 的层会命中空图层，等于没冻结。
  const sourceSvg = Array.from(container.querySelectorAll('svg'))
    .filter((svg) => svg.querySelector('#g-svg-camera'))
    .sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)[0];
  if (!sourceSvg) return () => {};

  const snapshot = sourceSvg.cloneNode(true) as SVGElement;
  snapshot.setAttribute('aria-hidden', 'true');
  snapshot.classList.add('mindmap-canvas-freeze');
  if (!snapshot.getAttribute('width')) {
    snapshot.style.width = '100%';
    snapshot.style.height = '100%';
  }
  sourceSvg.style.visibility = 'hidden';
  container.appendChild(snapshot);

  let done = false;
  return () => {
    if (done) return;
    done = true;
    snapshot.remove();
    sourceSvg.style.visibility = '';
  };
}

async function applyPersistedNodePositions(graph: Graph, root: MindMapNode): Promise<void> {
  const positions: Record<string, [number, number]> = {};
  collectPersistedNodePositions(root, positions);
  if (Object.keys(positions).length === 0) return;

  await graph.translateElementTo(positions, false);
}

/** 生成期用户主动滚动/拖拽视口后，暂停镜头跟随的时长（毫秒） */
const GENERATION_FOLLOW_PAUSE_MS = 5000;
/** 终树渲染完成到收尾运镜的延迟（毫秒）：等补渲染管线收尾 */
const GENERATION_FINALE_DELAY_MS = 600;
/** 生成结束后收尾运镜的超时兜底（毫秒）：终树渲染完成会提前触发 */
const GENERATION_FINALE_FALLBACK_MS = 3000;
/** 运镜执行后的刷新窗口（毫秒）：窗口内树被再次渲染则重算运镜目标 */
const GENERATION_FINALE_REFRESH_MS = 4000;
/** 收尾运镜将全图纳入视口的四周留白（像素） */
const GENERATION_FINALE_PADDING = 80;

function collectNodeIds(node: MindMapNode, ids: Set<string>): void {
  ids.add(node.id);
  node.children?.forEach((child) => collectNodeIds(child, ids));
}

interface CanvasBounds {
  min: [number, number];
  max: [number, number];
}

/** 收集树中所有已渲染节点的画布包围盒（AABB），用于收尾运镜计算内容范围 */
function collectNodeCanvasBounds(graph: Graph, node: MindMapNode, out: Array<CanvasBounds>): void {
  try {
    const bounds = graph.getElementRenderBounds(node.id);
    const min = bounds?.min;
    const max = bounds?.max;
    if (
      min &&
      max &&
      Number.isFinite(min[0]) &&
      Number.isFinite(min[1]) &&
      Number.isFinite(max[0]) &&
      Number.isFinite(max[1])
    ) {
      out.push({ min: [min[0], min[1]], max: [max[0], max[1]] });
    }
  } catch {
    // 节点尚未渲染（不应发生），跳过
  }
  node.children?.forEach((child) => collectNodeCanvasBounds(graph, child, out));
}

function readGraphContentBounds(graph: Graph): GraphContentBounds | null {
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
}

export const MindMapEditor = forwardRef<MindMapEditorRef, MindMapEditorProps>(function MindMapEditor(
  { tree, selectedNodeId, generating = false, aiTypingNodeId = null, onSelectNode, onUpdateNodeContent, layoutDirection, onMoveNode, onUpdateNodePosition, onUpdateNodePositions, onEditEnd, onEnterWithoutText, onSelectionChange },
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
  // 拖拽时跟随移动的子树节点 id（仅当前已渲染的；选中节点由 drag-element 行为自身移动，需排除避免双重位移）
  const dragSubtreeIdsRef = useRef<string[]>([]);
  // 上一次 drag 事件中被拖节点的画布坐标：与当前坐标求差得到子树跟随位移增量
  const lastDragCanvasPosRef = useRef<NodePosition | null>(null);
  // 结构性拖放（reparent）前的全图节点位置快照：render 完成后做 FLIP 动画的起始位置
  const positionsBeforeMoveRef = useRef<Map<string, NodePosition> | null>(null);
  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  const editingNodeIdRef = useRef<string | null>(null);
  const treeRef = useRef(tree);
  const layoutDirectionRef = useRef(layoutDirection);
  const onSelectNodeRef = useRef(onSelectNode);
  const onMoveNodeRef = useRef(onMoveNode);
  const onUpdateNodePositionRef = useRef(onUpdateNodePosition);
  const onUpdateNodePositionsRef = useRef(onUpdateNodePositions);
  const dropConnectorPathRef = useRef<SVGPathElement | null>(null);
  // 拖拽过程可视化：起始位置幽灵框 + 跟随光标的轨迹引导线（视口坐标 overlay）
  const dragGhostRectRef = useRef<SVGRectElement | null>(null);
  const dragTrailPathRef = useRef<SVGPathElement | null>(null);
  const dragStartClientRectRef = useRef<NodeClientRect | null>(null);
  const skipNextLayoutRef = useRef(false);
  const focusNodeIdOnNextRenderRef = useRef<string | null>(null);
  const viewportBeforeCommitRef = useRef<ReturnType<typeof readGraphViewportState>>(null);
  // 每个 Graph 实例的首轮渲染标记：G6 默认相机不定位内容，大图打开时根节点
  // 会落在视口外（实测在屏幕左侧外），首轮渲染完成后需把根节点居中。
  const initialViewportDoneRef = useRef(false);

  // 生成期渲染控制：
  // - render 在途守卫：上一轮 render 未完成时跳过本轮全量渲染，保留最新树补渲染
  // - 冻结帧：生成期每拍全量渲染前冻结旧画面，管线（render→layout→并行边）
  //   完成后再揭示，杜绝斜线连线/裸文本节点等中间态闪现
  // - 镜头跟随：每拍 diff 出新增的最后一个节点，视口瞬时对准（snapViewportToNode），
  //   用户 5 秒内主动滚动/拖拽视口则暂停跟随
  const generatingRef = useRef(generating);
  const renderInFlightRef = useRef(false);
  const pendingTreeRef = useRef<MindMapTree | null>(null);
  const knownNodeIdsRef = useRef<Set<string> | null>(null);
  const lastUserViewportInteractionAtRef = useRef(0);
  const prevGeneratingRef = useRef(generating);
  // 生成刚结束的首次渲染（终树落地）仍按生成期渲染处理：冻结帧防中间态。
  // 终树 setTree 与 generating=false 在同一次 commit 中到达，渲染 effect
  // 执行时 generatingRef 已为 false，需要该标记兜住最后一次全量渲染。
  const freezeNextRenderRef = useRef(false);
  // 收尾运镜待执行标记：等终树渲染真正完成后触发，避免与渲染管线竞态
  const pendingGenerationFinaleRef = useRef(false);
  // 收尾运镜的沉降定时器：每次渲染完成都会重置，渲染安静后才执行运镜
  const generationFinaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 收尾运镜已确定的目标视口：运镜执行后若还有在途渲染，其视口
  // 恢复必须改用运镜目标，否则会把运镜成果整体回滚到渲染前的旧视角。
  const generationFinaleViewportRef = useRef<GraphViewportState | null>(null);
  // 收尾运镜最近一次执行时间：运镜后短期内树仍可能被终树覆盖渲染改变
  // 布局（自愈覆盖/净化重排），需要重算运镜目标保持全图可见。
  const generationFinaleRanAtRef = useRef(0);
  const [renderTick, setRenderTick] = useState(0);
  const aiTypingNodeIdRef = useRef<string | null>(aiTypingNodeId);
  // 结构性拖放（reparent）后的悬浮框沉降窗口：dragend 到「重渲染 + FLIP 滑入
  // 新布局 + 视口聚焦」全部完成前，保持抑制工具栏 rect 上报。否则工具栏会在
  // 释放点立即重现，再随 FLIP/运镜一路漂到新位置（用户看到的「先偏移后回归」）。
  const dragSettlingRef = useRef(false);
  // 沉降窗口开始时间：渲染启动前存在数帧空窗（React 提交 → effect 触发渲染），
  // 需度过最短沉降时间后才允许按「连续静默帧」解除抑制，避免空窗期误判结束。
  const dragSettlingStartRef = useRef(0);
  // 承载本次 reparent 的渲染是否已完成：空窗期内节点 rect 在「释放点」同样稳定，
  // 仅靠稳定帧数无法区分「释放点静止」与「落位后静止」。渲染未完成前一律抑制，
  // 杜绝工具栏先在释放点出现、再随重布局漂移的竞态（大图提交慢时必现）。
  const dragSettleRenderDoneRef = useRef(false);
  // 当前在途渲染是否就是承载 reparent 的那轮（渲染入口消费快照时置位，finally 结算）
  const dragSettleReparentRenderRef = useRef(false);

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

  // 选中节点高亮：把 'selected' 状态挂到当前选中元素上。
  // 既服务于 selectedNodeId 变化，也供全量渲染完成后补挂
  // （元素级状态不跨 setData 存活，重渲染会把高亮冲掉）。
  const syncSelectedState = useCallback(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;

    const nodeId = selectedNodeIdRef.current;
    if (nodeId) {
      graph.setElementState(nodeId, ['selected']).catch(() => {});
    }
  }, []);

  useEffect(() => {
    generatingRef.current = generating;
  }, [generating]);

  // 生成完成收尾运镜：等终树渲染真正完成后，镜头拉远把整棵导图纳入
  // 视口，作为「看着长大」的收束。若结束后迟迟没有树变化（如用户主动
  // 停止且无新渲染），用超时兜底触发。
  const runGenerationFinale = useCallback(() => {
    const graph = graphRef.current as (Graph & { destroyed?: boolean }) | null;
    if (!graph || graph.destroyed) return;

    // 包围盒用节点渲染 AABB 计算：SVG 渲染器下 canvas.getBounds()
    // 返回画布视口矩形而非内容 AABB，G6 内置 fitView/fitCenter 会据此
    // 算出 scale=1 的空操作，不能用于收尾运镜。
    const boundsList: Array<CanvasBounds> = [];
    collectNodeCanvasBounds(graph, treeRef.current.root, boundsList);
    const size = graph.getSize();
    const viewportWidth = Number(size?.[0]);
    const viewportHeight = Number(size?.[1]);
    if (
      boundsList.length === 0 ||
      !Number.isFinite(viewportWidth) ||
      viewportWidth <= 0 ||
      !Number.isFinite(viewportHeight) ||
      viewportHeight <= 0
    ) {
      return;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const bounds of boundsList) {
      if (bounds.min[0] < minX) minX = bounds.min[0];
      if (bounds.min[1] < minY) minY = bounds.min[1];
      if (bounds.max[0] > maxX) maxX = bounds.max[0];
      if (bounds.max[1] > maxY) maxY = bounds.max[1];
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const fitZoom = Math.min(
      (viewportWidth - GENERATION_FINALE_PADDING * 2) / Math.max(contentWidth, 1),
      (viewportHeight - GENERATION_FINALE_PADDING * 2) / Math.max(contentHeight, 1),
    );
    // 小树不因收尾运镜放大画面（封顶 1），并夹在合法缩放范围内
    const targetZoom = Math.min(Math.max(Math.min(fitZoom, 1), 0.1), 5);

    // 居中交给 G6 内置 focusElement：它内部完成 viewport↔canvas 坐标换算，
    // 并把所有节点渲染包围盒的中心对齐到画布中心。此前手工按
    // 「视口中心 - 内容中心 × 缩放」算 translateTo 目标，与 G6 相机的
    // 绝对平移语义（基于正交投影矩阵的相机位置）不一致，导致全图飞出视口。
    const nodeIds = new Set<string>();
    collectNodeIds(treeRef.current.root, nodeIds);

    // 先记录运镜缩放目标（位置待居中后回读）：之后任何在途/后续渲染的
    // 视口恢复都改用该目标，防止渲染管线用渲染前捕获的旧视角回滚运镜成果
    const provisional = readGraphViewportState(graph);
    generationFinaleViewportRef.current = {
      position: provisional ? [provisional.position[0], provisional.position[1]] : [0, 0],
      zoom: targetZoom,
    };
    generationFinaleRanAtRef.current = Date.now();

    void (async () => {
      try {
        // 缩放必须瞬时：focusElement 用的是相对平移，按当前缩放换算位移量，
        // 若缩放仍在动画中，逐帧变化的缩放会让居中断点不可控。
        if (Math.abs(graph.getZoom() - targetZoom) > 0.001) {
          await graph.zoomTo(targetZoom, false);
        }
        await graph.focusElement(Array.from(nodeIds), { duration: 400 });
        // 回读居中后的真实相机状态，供后续/在途渲染精确恢复
        const finalState = readGraphViewportState(graph);
        if (finalState) {
          generationFinaleViewportRef.current = finalState;
        }
      } catch {
        // Best-effort 收尾运镜，失败不影响后续编辑
      }
    })();
  }, []);

  const runGenerationFinaleRef = useRef(runGenerationFinale);
  useEffect(() => {
    runGenerationFinaleRef.current = runGenerationFinale;
  }, [runGenerationFinale]);

  useEffect(() => {
    const wasGenerating = prevGeneratingRef.current;
    prevGeneratingRef.current = generating;
    if (generating) {
      // 重新开始生成：取消尚未执行的收尾运镜，并解除旧运镜目标视口锁定
      pendingGenerationFinaleRef.current = false;
      generationFinaleViewportRef.current = null;
      if (generationFinaleTimerRef.current) {
        clearTimeout(generationFinaleTimerRef.current);
        generationFinaleTimerRef.current = null;
      }
      return;
    }
    if (!wasGenerating) return;

    // 生成结束：终树渲染仍冻结（防中间态），渲染完成后触发收尾运镜
    freezeNextRenderRef.current = true;
    pendingGenerationFinaleRef.current = true;

    const fallbackTimer = setTimeout(() => {
      if (!pendingGenerationFinaleRef.current) return;
      pendingGenerationFinaleRef.current = false;
      runGenerationFinale();
    }, GENERATION_FINALE_FALLBACK_MS);
    return () => clearTimeout(fallbackTimer);
  }, [generating, runGenerationFinale]);

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
    focusNodeAfterRender: (nodeId: string) => {
      // 与拖拽 reparent 复用同一条管线：渲染 effect 在 setData+render+layout
      // 全部完成后消费此标记并把节点居中，避免聚焦被布局重算抵消。
      focusNodeIdOnNextRenderRef.current = nodeId;
      // 悬浮框沉降（与拖拽 reparent 同一机制）：内容拓展改变节点尺寸导致
      // 布局重排，加上居中平移动画会持续移动节点的屏幕位置，悬浮框若跟随
      // 实时 rect 上报就会先漂移再回归。这里抑制 rect 上报，直到承载聚焦
      // 的渲染（dragSettleReparentRenderRef 标记消费）与动画落位（连续稳定
      // 帧）全部完成，悬浮框直接出现在最终位置，杜绝中间态漂移。
      dragSettlingRef.current = true;
      dragSettlingStartRef.current = Date.now();
      dragSettleRenderDoneRef.current = false;
      dragSettleReparentRenderRef.current = true;
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
    onUpdateNodePositionsRef.current = onUpdateNodePositions;
  }, [onUpdateNodePositions]);

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
          // 显式声明 lineDash/opacity 基线值：'dragging' 态会覆盖这两个属性，
          // 若基线缺省，状态移除时 G6 无法 diff 出变化，虚线/半透明会残留在节点上
          // （即「拖拽完成后节点仍显示拖动态」的根因）。
          lineDash: [],
          opacity: 1,
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
            // 半透明 + 虚线描边 = 「正在被拖动」的移动中态：按下即生效，
            // 整棵被拖子树同时应用，拖拽过程一眼可辨。
            opacity: 0.55,
            stroke: '#8B8B83',
            lineWidth: 2,
            fill: '#F9F9F6',
            lineDash: [6, 4],
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
          // 悬停不显示 grab（本应用仅右键可拖，grab 会误导左键尝试），拖动中切换 grabbing 提供过程反馈
          cursor: {
            default: 'default',
            grab: 'default',
            grabbing: 'grabbing',
          },
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
      // 仅 translate 阶段存在主题动画（render/draw/state 阶段主题均无配置，保持瞬时），
      // 用于松手 reparent 后的 FLIP 位移动画：节点从旧位置平滑滑到新布局位置。
      animation: { duration: 300 },
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

    /** 全图节点画布坐标快照：reparent 前捕获，渲染后作为 FLIP 动画起点 */
    const captureAllNodeCanvasPositions = (): Map<string, NodePosition> => {
      const map = new Map<string, NodePosition>();
      const nodeData = graph.getNodeData() as Array<{ id?: string }>;
      for (const node of nodeData) {
        const nodeId = node?.id;
        if (!nodeId) continue;
        const position = readNodeCanvasPosition(nodeId);
        if (position) map.set(nodeId, position);
      }
      return map;
    };

    /**
     * 子树跟随：drag-element 行为只移动被拖节点本身，
     * 这里按被拖节点的位移增量同步平移其全部后代，让整棵子树一起跟走。
     */
    const syncSubtreeDrag = () => {
      const draggingNodeId = draggingNodeIdRef.current;
      const subtreeIds = dragSubtreeIdsRef.current;
      if (!draggingNodeId || subtreeIds.length === 0) return;

      const current = readNodeCanvasPosition(draggingNodeId);
      const previous = lastDragCanvasPosRef.current;
      lastDragCanvasPosRef.current = current;
      if (!current || !previous) return;

      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

      const offsets: Record<string, [number, number]> = {};
      for (const nodeId of subtreeIds) {
        offsets[nodeId] = [dx, dy];
      }
      graph.translateElementBy(offsets, false).catch(() => {});
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

    /**
     * child 模式虚线连接预览：在「被拖节点 ↔ 目标父节点」之间画一条
     * 视口坐标的贝塞尔虚线（覆盖在画布上层、不拦截指针），
     * 让用户在松手前就能看到将要建立的父子关系。
     */
    const updateDropConnector = () => {
      const path = dropConnectorPathRef.current;
      if (!path) return;

      const preview = dropPreviewRef.current;
      const draggingNodeId = draggingNodeIdRef.current;
      if (!preview || preview.mode !== 'child' || !draggingNodeId) {
        path.setAttribute('d', '');
        return;
      }

      const from = readNodeClientRect(draggingNodeId);
      const to = readNodeClientRect(preview.targetNodeId);
      if (!from || !to) {
        path.setAttribute('d', '');
        return;
      }

      path.setAttribute('d', buildDropConnectorPath(from, to));
    };

    /**
     * 拖拽过程可视化：
     * - 起始位置幽灵框：在被拖节点「出发位置」留一个虚线空框，标记移动来源；
     * - 轨迹引导线：从出发位置中心到当前节点中心画一条柔和贝塞尔，跟随光标，
     *   让用户一眼感知节点正在被拖动、以及它相对原位的移动方向与距离。
     * 二者均绘制在视口坐标 overlay 上（不拦截指针），与 dragging 半透明态配合。
     */
    const updateDragVisuals = () => {
      const ghost = dragGhostRectRef.current;
      const trail = dragTrailPathRef.current;
      const start = dragStartClientRectRef.current;
      const draggingNodeId = draggingNodeIdRef.current;
      if (!ghost || !trail || !start || !draggingNodeId) return;

      const current = readNodeClientRect(draggingNodeId);
      if (!current) return;

      // 位移过小（尚未真正拖起）时不显示，避免单击选中闪现幽灵/轨迹
      const movedFar =
        Math.abs(current.left - start.left) > 4 || Math.abs(current.top - start.top) > 4;
      if (!movedFar) {
        ghost.style.display = 'none';
        trail.setAttribute('d', '');
        return;
      }

      ghost.style.display = '';
      ghost.setAttribute('x', String(start.left));
      ghost.setAttribute('y', String(start.top));
      ghost.setAttribute('width', String(start.width));
      ghost.setAttribute('height', String(start.height));

      trail.setAttribute('d', buildDropConnectorPath(start, current));
    };

    const clearDragVisuals = () => {
      dragStartClientRectRef.current = null;
      const ghost = dragGhostRectRef.current;
      const trail = dragTrailPathRef.current;
      if (ghost) {
        ghost.style.display = 'none';
        ghost.setAttribute('width', '0');
        ghost.setAttribute('height', '0');
      }
      if (trail) trail.setAttribute('d', '');
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
      // 新拖拽开始：清掉上一次可能未走完的沉降窗口（如上次渲染异常中断）
      dragSettlingRef.current = false;
      clearDropPreview();
      updateDropConnector();
      // 收集后代 id：拖动时整棵子树跟随移动（被拖节点自身由 drag-element 行为负责）
      const draggedNode = findNode(treeRef.current.root, draggedNodeId);
      dragSubtreeIdsRef.current = draggedNode ? collectDescendantIds(draggedNode) : [];
      // 拖拽即时反馈：被拖节点及其整棵子树同时挂 'dragging' 态，
      // 让「按下即拖动」的过程一眼可辨，而非只在出现放置目标预览时才有状态。
      const draggingStateUpdates: Record<string, string[]> = {};
      const draggedCurrent = graph.getElementState(draggedNodeId);
      draggingStateUpdates[draggedNodeId] = Array.from(new Set([...(draggedCurrent ?? []), 'dragging']));
      for (const nodeId of dragSubtreeIdsRef.current) {
        const current = graph.getElementState(nodeId);
        draggingStateUpdates[nodeId] = Array.from(new Set([...(current ?? []), 'dragging']));
      }
      graph.setElementState(draggingStateUpdates).catch(() => {});
      lastDragCanvasPosRef.current = readNodeCanvasPosition(draggedNodeId);
      // 记录出发位置：拖拽期间以幽灵框 + 轨迹线可视化移动过程
      dragStartClientRectRef.current = readNodeClientRect(draggedNodeId);
    });

    graph.on('node:drag', (evt: any) => {
      syncSubtreeDrag();
      updateDropPreview(evt);
      updateDropConnector();
      updateDragVisuals();
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

      const subtreeIds = dragSubtreeIdsRef.current;
      dragSubtreeIdsRef.current = [];
      lastDragCanvasPosRef.current = null;
      updateDropConnector();
      clearDragVisuals();

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
        // Structural change: reparent the node, then focus viewport on it after render.
        // 先拍下全图坐标快照，渲染出新布局后做 FLIP 动画平滑滑入新位置。
        positionsBeforeMoveRef.current = captureAllNodeCanvasPositions();
        focusNodeIdOnNextRenderRef.current = draggedNodeId;
        // 悬浮框沉降：从此刻起到「重渲染 + FLIP + 视口聚焦」完成前，
        // 工具栏保持抑制，结束后直接出现在最终位置，不跟中间态漂移。
        // 解除条件由 rAF 上报循环按「渲染不在途 + 节点 rect 连续静默」判定。
        dragSettlingRef.current = true;
        dragSettlingStartRef.current = Date.now();
        dragSettleRenderDoneRef.current = false;
        dragSettleReparentRenderRef.current = false;
        onMoveNodeRef.current(draggedNodeId, preview.moveTarget.newParentId, preview.moveTarget.newIndex);
      } else if (finalPosition || subtreeIds.length > 0) {
        // Position-only drag: skip full render, persist positions in place.
        // 整棵子树被拖动时批量持久化（一次提交，撤销栈只留一条记录）。
        const updates: Array<{ id: string; position: NodePosition }> = [];
        if (finalPosition) {
          updates.push({ id: draggedNodeId, position: finalPosition });
        }
        for (const nodeId of subtreeIds) {
          const position = readNodeCanvasPosition(nodeId);
          if (position) {
            updates.push({ id: nodeId, position });
          }
        }

        if (updates.length > 0) {
          skipNextLayoutRef.current = true;
          if (onUpdateNodePositionsRef.current) {
            onUpdateNodePositionsRef.current(updates);
          } else if (finalPosition) {
            onUpdateNodePositionRef.current(draggedNodeId, finalPosition);
          }
        }
      }

      clearTransientDragStates();
      ensureNodesAboveEdges();
    });

    graphRef.current = graph;
    initialViewportDoneRef.current = false;

    return () => {
      container.removeEventListener('contextmenu', suppressCanvasContextMenu);
      draggingNodeIdRef.current = null;
      dropPreviewRef.current = null;
      dragSubtreeIdsRef.current = [];
      lastDragCanvasPosRef.current = null;
      positionsBeforeMoveRef.current = null;
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
      // 用户主动操作视口：暂停生成期镜头跟随一段时间，并解除收尾运镜
      // 目标视口的锁定（后续渲染恢复改为跟随用户视角）
      lastUserViewportInteractionAtRef.current = Date.now();
      generationFinaleViewportRef.current = null;
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

    // 右键/中键拖拽画布也是主动视口操作（滚轮已在 onWheel 内标记），
    // 同样暂停生成期镜头跟随
    const onViewportPointerDown = (e: PointerEvent) => {
      if (e.button === 1 || e.button === 2) {
        lastUserViewportInteractionAtRef.current = Date.now();
        generationFinaleViewportRef.current = null;
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('pointerdown', onViewportPointerDown);
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('pointerdown', onViewportPointerDown);
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

    const readContentBounds = readGraphContentBounds;

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
      return;
    }
    renderInFlightRef.current = true;

    const focusNodeId = focusNodeIdOnNextRenderRef.current;
    focusNodeIdOnNextRenderRef.current = null;
    const isFirstRenderOfGraph = !initialViewportDoneRef.current;
    initialViewportDoneRef.current = true;

    // 拖拽 reparent 快照必须在「本渲染」入口消费：若留到 render 完成后再读，
    // dragend 落在上一轮渲染在途期间时，快照会被那轮无关渲染提前清空，
    // 导致真正承载 reparent 结果的本轮渲染失去冻结帧、暴露中间态。
    const dragPositionsBeforeMove = positionsBeforeMoveRef.current;
    positionsBeforeMoveRef.current = null;
    if (dragPositionsBeforeMove) {
      // 本轮渲染承载 reparent：沉降窗口须等这轮渲染（含 FLIP/聚焦）完成后才允许解除
      dragSettleReparentRenderRef.current = true;
    }

    const savedViewport = viewportBeforeCommitRef.current;
    viewportBeforeCommitRef.current = null;
    const viewportState = savedViewport ?? readGraphViewportState(graph);

    // 生成跟随目标：diff 上一拍已渲染的节点 id 集合，取本拍新增的最后一个
    // （按树遍历序，即最新回放的节点）。非生成期的树变化不触发跟随。
    const nextNodeIds = new Set<string>();
    collectNodeIds(tree.root, nextNodeIds);
    let followNodeId: string | null = null;
    if (generatingRef.current && knownNodeIdsRef.current) {
      for (const nodeId of nextNodeIds) {
        if (!knownNodeIdsRef.current.has(nodeId)) followNodeId = nodeId;
      }
    }
    knownNodeIdsRef.current = nextNodeIds;

    // 生成刚结束的终树渲染同样冻结（generatingRef 已翻 false，用标记兜住）
    if (freezeNextRenderRef.current) freezeNextRenderRef.current = false;

    // 全量渲染冻结帧：除首轮外，任何 setData+render（拖拽 reparent、生成回放、
    // 刷新后的二次渲染、内容/结构编辑等）都先冻结旧画面，盖住 render→layout
    // 管线的中间态（斜线连线/裸文本节点），管线完成后再揭示，呈现为「整图一步
    // 就位」。此前仅拖拽/生成冻结，刷新时的第二轮全量渲染（数据回填/会话领养/
    // 版本差异触发）既无 loading 隐藏也无冻结帧，中间态直接暴露——即用户看到的
    // 「刷新抽搐」。首轮容器里尚无旧帧可冻，单独走 mindmap-canvas-loading 隐藏。
    let unfreezeDragRender: (() => void) | null =
      !isFirstRenderOfGraph && containerRef.current ? freezeGraphCanvasForDrag(containerRef.current) : null;
    // 首轮加载渲染：G6 的 SVG 图层在 render() 时才创建，容器里没有旧帧可冻结
    // （冻结帧取不到源图层会静默跳过，中间态照旧暴露）。改为管线期间整体隐藏
    // 画布图层（露出容器奶油底色），管线完成且根节点居中后一次揭示。
    let hideFirstRender: (() => void) | null = null;
    if (isFirstRenderOfGraph && containerRef.current) {
      const canvasContainer = containerRef.current;
      canvasContainer.classList.add('mindmap-canvas-loading');
      let hidden = true;
      hideFirstRender = () => {
        if (!hidden) return;
        hidden = false;
        canvasContainer.classList.remove('mindmap-canvas-loading');
      };
    }
    const revealCanvas = () => {
      unfreezeDragRender?.();
      unfreezeDragRender = null;
      hideFirstRender?.();
      hideFirstRender = null;
    };
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
        } else if (isFirstRenderOfGraph) {
          // 首轮渲染：不恢复 G6 默认相机（它停在任意位置，根节点在视口外），
          // 直接把根节点居中，保证打开导图必见根节点。
          await focusGraphViewportOnNode(graph, tree.root.id, 0);
        } else {
          // 每拍都恢复到本拍开始时的视口（G6 render 会重置视口；恢复的
          // 正是用户当前视角或上次跟随后的位置，不存在周期性回弹）。
          // 收尾运镜执行后（含本渲染在途期间才执行的），恢复改用运镜
          // 目标视口——否则在途渲染会把运镜成果回滚到渲染前的旧视角。
          const finaleViewport = generationFinaleViewportRef.current;
          const restoreTarget = finaleViewport ?? viewportState;
          await restoreGraphViewportState(graph, restoreTarget);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await restoreGraphViewportState(graph, restoreTarget);
          // 生成期镜头跟随：视口恢复后若本拍有新增节点、且用户近期未主动
          // 操作视口，则瞬时对准最新节点。必须在揭示冻结帧之前完成——
          // 帧交换后即为目标画面；刻意不用动画，避免运行中的视口动画与
          // 下一拍的视口恢复相互竞态。
          if (
            generatingRef.current &&
            followNodeId &&
            Date.now() - lastUserViewportInteractionAtRef.current > GENERATION_FOLLOW_PAUSE_MS
          ) {
            snapViewportToNode(graph, followNodeId);
          }
        }

        // FLIP：reparent 拖放后，把位置发生变化的节点先瞬间放回拖放前的
        // 旧坐标，再动画滑到新布局坐标，替代「整图跳变」的生硬观感。
        if (dragPositionsBeforeMove && dragPositionsBeforeMove.size > 0) {
          const startPositions: Record<string, [number, number]> = {};
          const endPositions: Record<string, [number, number]> = {};

          for (const [nodeId, before] of dragPositionsBeforeMove) {
            let after: { x: number; y: number } | null = null;
            try {
              const position = graph.getElementPosition(nodeId);
              if (Array.isArray(position)) {
                const [x, y] = position;
                if (Number.isFinite(x) && Number.isFinite(y)) after = { x, y };
              }
            } catch {
              after = null;
            }
            if (!after) continue;
            if (Math.abs(after.x - before.x) < 0.5 && Math.abs(after.y - before.y) < 0.5) continue;
            startPositions[nodeId] = [before.x, before.y];
            endPositions[nodeId] = [after.x, after.y];
          }

          if (Object.keys(startPositions).length > 0) {
            // 先瞬时回到旧位置（FLIP 的 First/Last 已记录，此处 Invert）
            await graph.translateElementTo(startPositions, false);
            // 再动画播放到新位置（Play，时长来自 graph.animation 配置）
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            // 冻结帧在此揭示：真实画布此刻与冻结快照逐像素一致（都在旧位置），
            // 揭示后无缝衔接 FLIP 动画滑向新布局。
            revealCanvas();
            await graph.translateElementTo(endPositions, true);
          }
        }

        // 无 FLIP（如快照为空）时直接揭示，避免画布被永久冻结
        revealCanvas();

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
        // 同理补挂选中高亮：AI 应用内容等触发重渲染后，当前选中节点
        // 的边框强调不丢失（选中态变化 effect 只在 selectedNodeId 变更时跑，
        // 覆盖不了「id 不变但元素被重建」的场景）。
        syncSelectedState();
      })
      .catch(() => {})
      .finally(() => {
        renderInFlightRef.current = false;
        if (dragSettleReparentRenderRef.current) {
          dragSettleReparentRenderRef.current = false;
          dragSettleRenderDoneRef.current = true;
        }
        // 渲染异常时兜底解冻，防止画布停留在冻结帧
        revealCanvas();

        // 生成结束后的收尾运镜用「沉降」触发：每次渲染完成都重置定时器，
        // 直到渲染管线安静（终树及其补渲染全部落定）才执行运镜——若在
        // 途渲染的视口恢复晚于运镜执行，会把运镜成果整体抵消掉。
        // 运镜执行后短时间内若树再次渲染（如服务端终树自愈覆盖后重排），
        // 也重新沉降一次运镜，按新布局重算目标保持全图可见。
        const finaleNeedsRefresh =
          generationFinaleViewportRef.current !== null &&
          Date.now() - generationFinaleRanAtRef.current < GENERATION_FINALE_REFRESH_MS;
        if ((pendingGenerationFinaleRef.current || finaleNeedsRefresh) && !generatingRef.current) {
          if (generationFinaleTimerRef.current) {
            clearTimeout(generationFinaleTimerRef.current);
          }
          const armSettleTimer = () => {
            generationFinaleTimerRef.current = setTimeout(() => {
              generationFinaleTimerRef.current = null;
              if (!pendingGenerationFinaleRef.current) return;
              if (renderInFlightRef.current) {
                // 渲染仍在途：推迟运镜，等渲染管线安静后再执行，
                // 避免运镜动画与在途渲染的视口恢复相互竞态
                armSettleTimer();
                return;
              }
              pendingGenerationFinaleRef.current = false;
              runGenerationFinaleRef.current();
            }, GENERATION_FINALE_DELAY_MS);
          };
          pendingGenerationFinaleRef.current = true;
          armSettleTimer();
        }

        if (pendingTreeRef.current) {
          pendingTreeRef.current = null;
          setRenderTick((tick) => tick + 1);
        }
      });
  }, [tree, renderTick, syncAiTypingState, syncSelectedState]);

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
    syncSelectedState();
  }, [selectedNodeId, syncSelectedState]);

  // 悬浮操作框跟随：rAF 循环上报选中节点的屏幕矩形，
  // 覆盖画布平移/缩放/布局变化；行内编辑与拖拽期间抑制（rect 报 null）
  useEffect(() => {
    if (!selectedNodeId) {
      onSelectionChangeRef.current?.(null, null);
      return;
    }

    let rafId = 0;
    let last: NodeClientRect | null = null;
    // 沉降期跟踪：节点实时 rect 的历史值与连续稳定帧数
    let settleLast: NodeClientRect | null = null;
    let stableFrames = 0;

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
      let suppressed = editingNodeIdRef.current !== null || draggingNodeIdRef.current !== null;

      // 结构性拖放沉降：dragend 之后继续抑制工具栏，直到「重渲染 + FLIP 滑入
      // + 视口聚焦」全部结束（渲染不在途且节点位置连续多帧稳定），
      // 工具栏随后直接出现在最终位置，杜绝中间态漂移。
      if (dragSettlingRef.current && !suppressed) {
        const elapsed = Date.now() - dragSettlingStartRef.current;
        const liveRect = graph && !graph.destroyed ? readNodeClientRectWithGraph(graph, selectedNodeId) : null;

        if (elapsed < DRAG_SETTLE_MIN_MS || renderInFlightRef.current || !liveRect || !dragSettleRenderDoneRef.current) {
          // 渲染启动前的空窗 / 渲染在途 / 承载 reparent 的渲染未完成 / 节点暂不可见：
          // 继续抑制并重置稳定计数
          suppressed = true;
          settleLast = liveRect;
          stableFrames = 0;
        } else {
          if (sameRect(liveRect, settleLast)) stableFrames += 1;
          else stableFrames = 0;
          settleLast = liveRect;

          if (stableFrames < DRAG_SETTLE_STABLE_FRAMES && elapsed < DRAG_SETTLE_MAX_MS) {
            suppressed = true;
          } else {
            dragSettlingRef.current = false;
            settleLast = null;
            stableFrames = 0;
          }
        }
      }

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
      {/* 拖放 child 模式连接预览：视口坐标虚线，浮于画布上方、不拦截指针 */}
      <svg
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          zIndex: 500,
        }}
      >
        <rect
          ref={dragGhostRectRef}
          style={{ display: 'none' }}
          fill="rgba(139,139,131,0.06)"
          stroke="#B0B0A6"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          rx={10}
          x={0}
          y={0}
          width={0}
          height={0}
        />
        <path
          ref={dragTrailPathRef}
          fill="none"
          stroke="#8B8B83"
          strokeWidth={1.5}
          strokeDasharray="2 6"
          strokeLinecap="round"
          opacity={0.5}
          d=""
        />
        <path
          ref={dropConnectorPathRef}
          fill="none"
          stroke="#2563EB"
          strokeWidth={2}
          strokeDasharray="7 5"
          strokeLinecap="round"
          opacity={0.85}
          d=""
        />
      </svg>
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
