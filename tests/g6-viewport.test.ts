import { describe, expect, it, vi } from 'vitest';

import { readGraphViewportState, restoreGraphViewportState } from '../lib/utils/g6-viewport';

describe('g6 viewport helpers', () => {
  it('reads a valid viewport snapshot from the graph', () => {
    const snapshot = readGraphViewportState({
      getPosition: () => [128.5, -42, 0],
      getZoom: () => 1.35,
    });

    expect(snapshot).toEqual({
      position: [128.5, -42],
      zoom: 1.35,
    });
  });

  it('returns null when viewport values are invalid', () => {
    const snapshot = readGraphViewportState({
      getPosition: () => [Number.NaN, 24],
      getZoom: () => 1,
    });

    expect(snapshot).toBeNull();
  });

  it('returns null when reading viewport state throws', () => {
    const snapshot = readGraphViewportState({
      getPosition: () => {
        throw new Error('graph not ready');
      },
      getZoom: () => 1,
    });

    expect(snapshot).toBeNull();
  });

  it('restores zoom before translation when viewport changed', async () => {
    const calls: string[] = [];
    const graph = {
      getPosition: vi.fn(() => [0, 0]),
      getZoom: vi.fn(() => 1),
      zoomTo: vi.fn(async () => {
        calls.push('zoom');
      }),
      translateTo: vi.fn(async () => {
        calls.push('translate');
      }),
    };

    await restoreGraphViewportState(graph, {
      position: [240, -96],
      zoom: 1.5,
    });

    expect(graph.zoomTo).toHaveBeenCalledWith(1.5, false);
    expect(graph.translateTo).toHaveBeenCalledWith([240, -96], false);
    expect(calls).toEqual(['zoom', 'translate']);
  });

  it('skips redundant viewport updates within tolerance', async () => {
    const graph = {
      getPosition: vi.fn(() => [99.9999, -80.0004]),
      getZoom: vi.fn(() => 1.2504),
      zoomTo: vi.fn(async () => {}),
      translateTo: vi.fn(async () => {}),
    };

    await restoreGraphViewportState(graph, {
      position: [100, -80],
      zoom: 1.25,
    });

    expect(graph.zoomTo).not.toHaveBeenCalled();
    expect(graph.translateTo).not.toHaveBeenCalled();
  });

  it('swallows viewport restore errors', async () => {
    const graph = {
      getPosition: vi.fn(() => [0, 0]),
      getZoom: vi.fn(() => 1),
      zoomTo: vi.fn(async () => {
        throw new Error('transform failed');
      }),
      translateTo: vi.fn(async () => {}),
    };

    await expect(
      restoreGraphViewportState(graph, {
        position: [120, -40],
        zoom: 1.25,
      }),
    ).resolves.toBeUndefined();
  });
});
