export interface GraphViewportState {
  position: [number, number];
  zoom: number;
}

interface GraphViewportLike {
  getPosition: () => ArrayLike<number>;
  getZoom: () => number;
  translateTo: (position: [number, number], animation?: boolean) => Promise<void>;
  zoomTo: (zoom: number, animation?: boolean) => Promise<void>;
}

const VIEWPORT_EPSILON = 0.001;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
