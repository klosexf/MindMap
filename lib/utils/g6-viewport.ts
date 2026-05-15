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
