import { describe, expect, it } from 'vitest';

import { getViewportCenterPositionForNode, getViewportLockedEditorRect } from '../lib/utils/g6-viewport';

describe('getViewportCenterPositionForNode', () => {
  it('returns the translation needed to center a node in the visible canvas', () => {
    const graph = {
      getElementPosition: () => [320, 180],
      getSize: () => [1200, 800],
      getZoom: () => 1.5,
    };

    expect(getViewportCenterPositionForNode(graph, 'node-1')).toEqual([120, 130]);
  });

  it('returns null when the node position is unavailable', () => {
    const graph = {
      getElementPosition: () => null,
      getSize: () => [1200, 800],
      getZoom: () => 1,
    };

    expect(getViewportCenterPositionForNode(graph, 'node-1')).toBeNull();
  });

  it('keeps the inline editor centered inside the visible viewport', () => {
    expect(
      getViewportLockedEditorRect(
        { left: 40, top: 30, width: 120, height: 36 },
        { left: 0, top: 0, width: 1280, height: 800 },
        { minWidth: 180, minHeight: 44, center: true },
      ),
    ).toEqual({
      left: 550,
      top: 378,
      width: 180,
      height: 44,
    });
  });

  it('clamps the inline editor inside a narrow viewport', () => {
    expect(
      getViewportLockedEditorRect(
        { left: 340, top: 500, width: 120, height: 36 },
        { left: 0, top: 0, width: 375, height: 667 },
        { minWidth: 180, minHeight: 44, center: true },
      ),
    ).toEqual({
      left: 97.5,
      top: 311.5,
      width: 180,
      height: 44,
    });
  });

  it('keeps the inline editor centered on tablet-sized viewports', () => {
    expect(
      getViewportLockedEditorRect(
        { left: 520, top: 640, width: 140, height: 40 },
        { left: 0, top: 0, width: 768, height: 1024 },
        { minWidth: 180, minHeight: 44, center: true },
      ),
    ).toEqual({
      left: 294,
      top: 490,
      width: 180,
      height: 44,
    });
  });
});
