export interface GraphViewportState {
  position: [number, number];
  zoom: number;
}

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface GraphViewportLike {
  getPosition: () => ArrayLike<number>;
  getZoom: () => number;
  translateTo: (position: [number, number], animation?: boolean | { duration?: number }) => Promise<void>;
  zoomTo: (zoom: number, animation?: boolean) => Promise<void>;
}

interface GraphNodeViewportLike {
  getElementPosition: (nodeId: string) => ArrayLike<number> | null | undefined;
  getSize: () => ArrayLike<number>;
  getZoom: () => number;
  translateTo: (position: [number, number], animation?: boolean | { duration?: number }) => Promise<void>;
}

interface ViewportLockedEditorRectOptions {
  minWidth: number;
  minHeight: number;
  padding?: number;
  center?: boolean;
}

const VIEWPORT_EPSILON = 0.001;
const DEFAULT_EDITOR_VIEWPORT_PADDING = 16;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
}

export function readGraphViewportState(graph: Pick<GraphViewportLike, 'getPosition' | 'getZoom'>): GraphViewportState | null {
  let position: ArrayLike<number>;
  let zoom: number;
  try {
    position = graph.getPosition();
    zoom = graph.getZoom();
  } catch {
    return null;
  }

  if (!position || position.length < 2) return null;

  const x = position[0];
  const y = position[1];
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom)) return null;

  return {
    position: [x, y],
    zoom,
  };
}

function shouldRestoreScalar(currentValue: number, nextValue: number): boolean {
  return Math.abs(currentValue - nextValue) > VIEWPORT_EPSILON;
}

function shouldRestorePosition(currentPosition: ArrayLike<number>, nextPosition: [number, number]): boolean {
  if (!currentPosition || currentPosition.length < 2) return true;

  return (
    shouldRestoreScalar(currentPosition[0] ?? Number.NaN, nextPosition[0]) ||
    shouldRestoreScalar(currentPosition[1] ?? Number.NaN, nextPosition[1])
  );
}

export async function restoreGraphViewportState(
  graph: GraphViewportLike,
  viewportState: GraphViewportState | null,
): Promise<void> {
  if (!viewportState) return;

  try {
    if (shouldRestoreScalar(graph.getZoom(), viewportState.zoom)) {
      await graph.zoomTo(viewportState.zoom, false);
    }

    if (shouldRestorePosition(graph.getPosition(), viewportState.position)) {
      await graph.translateTo(viewportState.position, false);
    }
  } catch {
    // Best-effort viewport restore should not interrupt editing.
  }
}

export function getViewportCenterPositionForNode(
  graph: Pick<GraphNodeViewportLike, 'getElementPosition' | 'getSize' | 'getZoom'>,
  nodeId: string,
): [number, number] | null {
  let position: ArrayLike<number> | null | undefined;
  let canvasSize: ArrayLike<number>;
  let zoom: number;

  try {
    position = graph.getElementPosition(nodeId);
    canvasSize = graph.getSize();
    zoom = graph.getZoom();
  } catch {
    return null;
  }

  if (!position || position.length < 2 || !canvasSize || canvasSize.length < 2) return null;

  const nodeX = position[0];
  const nodeY = position[1];
  const canvasWidth = canvasSize[0];
  const canvasHeight = canvasSize[1];

  if (!isFiniteNumber(nodeX) || !isFiniteNumber(nodeY) || !isFiniteNumber(canvasWidth) || !isFiniteNumber(canvasHeight) || !isFiniteNumber(zoom)) {
    return null;
  }

  return [canvasWidth / 2 - nodeX * zoom, canvasHeight / 2 - nodeY * zoom];
}

export async function focusGraphViewportOnNode(
  graph: GraphNodeViewportLike,
  nodeId: string,
  duration = 300,
): Promise<void> {
  const targetPosition = getViewportCenterPositionForNode(graph, nodeId);
  if (!targetPosition) return;

  try {
    await graph.translateTo(targetPosition, { duration });
  } catch {
    // Best-effort viewport focus should not interrupt editing.
  }
}

export type ArrowPanDirection = 'up' | 'down' | 'left' | 'right';

export type ZoomStepDirection = 'in' | 'out';

export interface GraphContentBounds {
  min: [number, number];
  max: [number, number];
}

export interface ArrowPanViewportContext {
  /** 画布原点在视口坐标系下的位置（graph.getPosition()） */
  position: ArrayLike<number>;
  zoom: number;
  /** 画布尺寸 [宽, 高]（graph.getSize()） */
  canvasSize: ArrayLike<number>;
  /** 图内容整体包围盒（画布坐标系，不含视口变换） */
  contentBounds: GraphContentBounds | null;
}

/** 方向键拖动画布的最大速度（视口像素 / 秒） */
export const ARROW_PAN_MAX_SPEED = 600;
/** 起步速度占最大速度的比例，避免按下瞬间起跳 */
export const ARROW_PAN_INITIAL_SPEED_RATIO = 0.25;
/** 从起步速度平滑加速到最大速度的时长（毫秒） */
export const ARROW_PAN_RAMP_DURATION = 200;
/** 轻点一下方向键时，画布至少滑行的距离（视口像素） */
export const ARROW_PAN_TAP_MIN_STEP = 50;
/** 轻点后收尾滑行的速度（视口像素 / 秒） */
export const ARROW_PAN_TAIL_SPEED = 420;
/** 边界检查：内容至少保留在视口内的像素宽度 */
export const ARROW_PAN_MIN_VISIBLE_MARGIN = 60;
/** 单帧最大时长（毫秒），防止后台标签页恢复时产生跳变 */
export const ARROW_PAN_MAX_FRAME_DELTA = 100;

const ARROW_KEY_DIRECTIONS: Record<string, ArrowPanDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

export function getArrowPanDirection(key: string): ArrowPanDirection | null {
  return ARROW_KEY_DIRECTIONS[key] ?? null;
}

/**
 * 由当前按下的方向集合计算归一化的画布内容平移单位向量。
 * 方向键语义为"视口向按键方向平移"（与滚轮/滚动条一致），
 * 因此内容向按键的反方向移动：上键内容向下移（dy > 0），下键向上移（dy < 0），
 * 左键向右移（dx > 0），右键向左移（dx < 0）。
 * 斜向（|unit| = √2）归一化为单位向量，保证任意组合的移动速率一致；
 * 无任何方向时返回 [0, 0]。
 */
export function getArrowPanUnit(activeDirections: ReadonlySet<ArrowPanDirection>): [number, number] {
  let unitX = 0;
  let unitY = 0;
  if (activeDirections.has('left')) unitX += 1;
  if (activeDirections.has('right')) unitX -= 1;
  if (activeDirections.has('up')) unitY += 1;
  if (activeDirections.has('down')) unitY -= 1;

  const unitLength = Math.hypot(unitX, unitY);
  if (unitLength > 1) {
    unitX /= unitLength;
    unitY /= unitLength;
  }
  return [unitX, unitY];
}

/**
 * 计算一帧内方向键拖动画布的位移量（视口像素）。
 * 方向键指向哪边，视口就向哪边平移，画布内容向反方向移动：
 * 上键内容向下移（dy > 0），下键向上移（dy < 0），
 * 左键向右移（dx > 0），右键向左移（dx < 0）。
 * 速度从起步比例在 ARROW_PAN_RAMP_DURATION 内平滑加速到最大值，
 * 斜向组合时归一化，保证任意方向的移动速率一致。
 */
export function computeArrowPanOffset(
  activeDirections: ReadonlySet<ArrowPanDirection>,
  heldMs: number,
  frameDeltaMs: number,
): [number, number] {
  if (activeDirections.size === 0 || !Number.isFinite(frameDeltaMs) || frameDeltaMs <= 0) {
    return [0, 0];
  }

  const [unitX, unitY] = getArrowPanUnit(activeDirections);
  if (unitX === 0 && unitY === 0) return [0, 0];

  const rampProgress =
    Number.isFinite(heldMs) && heldMs > 0 ? Math.min(heldMs / ARROW_PAN_RAMP_DURATION, 1) : 0;
  const speedRatio = ARROW_PAN_INITIAL_SPEED_RATIO + (1 - ARROW_PAN_INITIAL_SPEED_RATIO) * rampProgress;
  const speed = ARROW_PAN_MAX_SPEED * speedRatio;
  const dtSeconds = Math.min(frameDeltaMs, ARROW_PAN_MAX_FRAME_DELTA) / 1000;

  return [unitX * speed * dtSeconds, unitY * speed * dtSeconds];
}

/**
 * 计算轻点方向键后收尾滑行的单帧位移（视口像素）。
 * 按键已松开但累计位移未达到轻点最小步距时，以固定速度沿原方向继续滑行，
 * 最后一帧不超过剩余距离，保证精确停在目标步距上。
 */
export function computeArrowPanTailOffset(
  unit: ArrayLike<number>,
  remainingDistance: number,
  frameDeltaMs: number,
): [number, number] {
  const unitX = Number(unit?.[0]);
  const unitY = Number(unit?.[1]);
  if (!Number.isFinite(unitX) || !Number.isFinite(unitY) || (unitX === 0 && unitY === 0)) {
    return [0, 0];
  }
  if (!Number.isFinite(remainingDistance) || remainingDistance <= 0) return [0, 0];
  if (!Number.isFinite(frameDeltaMs) || frameDeltaMs <= 0) return [0, 0];

  const dtSeconds = Math.min(frameDeltaMs, ARROW_PAN_MAX_FRAME_DELTA) / 1000;
  const magnitude = Math.min(ARROW_PAN_TAIL_SPEED * dtSeconds, remainingDistance);
  return [unitX * magnitude, unitY * magnitude];
}

/** +/- 键缩放的最小比例（与滚轮缩放限制一致） */
export const ZOOM_KEY_MIN = 0.1;
/** +/- 键缩放的最大比例（与滚轮缩放限制一致） */
export const ZOOM_KEY_MAX = 5;
/** 每按一次 +/- 键的缩放倍率（乘法步进） */
export const ZOOM_KEY_STEP_RATIO = 1.2;

const ZOOM_IN_KEYS = new Set(['+', '=']);
const ZOOM_OUT_KEYS = new Set(['-', '_']);

/**
 * 识别键盘缩放键：+ / = 触发放大，- / _ 触发缩小。
 * 其余按键返回 null。小键盘的 + / - 同样以 '+' / '-' 命中。
 */
export function getZoomStepDirection(key: string): ZoomStepDirection | null {
  if (ZOOM_IN_KEYS.has(key)) return 'in';
  if (ZOOM_OUT_KEYS.has(key)) return 'out';
  return null;
}

/**
 * 计算按一次 +/- 键后的目标缩放比例。
 * 放大乘以 ZOOM_KEY_STEP_RATIO，缩小除以它，结果钳制在
 * [ZOOM_KEY_MIN, ZOOM_KEY_MAX]；已到达边界时返回当前值，
 * 调用方据此跳过缩放，避免触发无意义的动画。
 */
export function computeZoomStepTarget(currentZoom: number, direction: ZoomStepDirection): number {
  if (!Number.isFinite(currentZoom) || currentZoom <= 0) return currentZoom;

  const raw =
    direction === 'in' ? currentZoom * ZOOM_KEY_STEP_RATIO : currentZoom / ZOOM_KEY_STEP_RATIO;
  return Math.min(Math.max(raw, ZOOM_KEY_MIN), ZOOM_KEY_MAX);
}

function clampAxisPanOffset(
  position: number,
  offset: number,
  contentMin: number,
  contentMax: number,
  zoom: number,
  viewportSize: number,
): number {
  const contentLength = (contentMax - contentMin) * zoom;
  if (!(contentLength > 0)) return offset;

  // 内容至少保留 minOverlap 像素在视口内，防止把画布完全拖出视野
  const minOverlap = Math.min(ARROW_PAN_MIN_VISIBLE_MARGIN, contentLength);
  const lower = minOverlap - contentMax * zoom;
  const upper = viewportSize - minOverlap - contentMin * zoom;
  // 视口过小的退化场景，放弃该轴限制
  if (lower > upper) return offset;

  const next = position + offset;
  let clampedNext: number;
  if (position >= lower && position <= upper) {
    clampedNext = clamp(next, lower, upper);
  } else {
    // 已越过边界（例如鼠标拖拽本就无边界）：只阻止继续外移，
    // 允许朝有效区间移动，且位移量不会超过请求值，因此不会产生回弹跳变
    clampedNext = clamp(next, Math.min(lower, position), Math.max(upper, position));
  }
  return clampedNext - position;
}

/**
 * 对方向键拖动画布的单帧位移做边界钳制：
 * 保证图内容包围盒与视口始终保留最小可见重叠。
 * 视口信息缺失或非法时退化为不做限制。
 */
export function clampArrowPanOffset(
  offset: ArrayLike<number>,
  context: ArrowPanViewportContext,
): [number, number] {
  const rawX = Number(offset?.[0]);
  const rawY = Number(offset?.[1]);
  const fallback: [number, number] = [
    Number.isFinite(rawX) ? rawX : 0,
    Number.isFinite(rawY) ? rawY : 0,
  ];

  const { position, zoom, canvasSize, contentBounds } = context;
  if (
    !contentBounds ||
    !position ||
    position.length < 2 ||
    !canvasSize ||
    canvasSize.length < 2 ||
    !isFiniteNumber(position[0]) ||
    !isFiniteNumber(position[1]) ||
    !isFiniteNumber(canvasSize[0]) ||
    !isFiniteNumber(canvasSize[1]) ||
    !isFiniteNumber(zoom)
  ) {
    return fallback;
  }

  const [minX, minY] = contentBounds.min;
  const [maxX, maxY] = contentBounds.max;
  if (!isFiniteNumber(minX) || !isFiniteNumber(minY) || !isFiniteNumber(maxX) || !isFiniteNumber(maxY)) {
    return fallback;
  }

  const dx = clampAxisPanOffset(position[0], fallback[0], minX, maxX, zoom, canvasSize[0]);
  const dy = clampAxisPanOffset(position[1], fallback[1], minY, maxY, zoom, canvasSize[1]);
  return [dx, dy];
}

export function getViewportLockedEditorRect(
  rect: RectLike,
  viewportRect: RectLike,
  options: ViewportLockedEditorRectOptions,
): RectLike {
  const padding = options.padding ?? DEFAULT_EDITOR_VIEWPORT_PADDING;
  const maxWidth = Math.max(viewportRect.width - padding * 2, 1);
  const maxHeight = Math.max(viewportRect.height - padding * 2, 1);
  const width = Math.min(Math.max(rect.width, options.minWidth), maxWidth);
  const height = Math.min(Math.max(rect.height, options.minHeight), maxHeight);

  const baseLeft = options.center
    ? viewportRect.left + (viewportRect.width - width) / 2
    : rect.left - (width - rect.width) / 2;
  const baseTop = options.center
    ? viewportRect.top + (viewportRect.height - height) / 2
    : rect.top - (height - rect.height) / 2;

  return {
    left: clamp(baseLeft, viewportRect.left + padding, viewportRect.left + viewportRect.width - padding - width),
    top: clamp(baseTop, viewportRect.top + padding, viewportRect.top + viewportRect.height - padding - height),
    width,
    height,
  };
}
