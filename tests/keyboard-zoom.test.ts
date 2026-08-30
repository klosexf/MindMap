import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ZOOM_KEY_MAX,
  ZOOM_KEY_MIN,
  ZOOM_KEY_STEP_RATIO,
  computeZoomStepTarget,
  getZoomStepDirection,
} from '../lib/utils/g6-viewport';

describe('getZoomStepDirection', () => {
  it('maps + and = to zoom in', () => {
    expect(getZoomStepDirection('+')).toBe('in');
    expect(getZoomStepDirection('=')).toBe('in');
  });

  it('maps - and _ to zoom out', () => {
    expect(getZoomStepDirection('-')).toBe('out');
    expect(getZoomStepDirection('_')).toBe('out');
  });

  it('ignores non-zoom keys', () => {
    expect(getZoomStepDirection('ArrowUp')).toBeNull();
    expect(getZoomStepDirection('Enter')).toBeNull();
    expect(getZoomStepDirection('0')).toBeNull();
    expect(getZoomStepDirection('')).toBeNull();
    expect(getZoomStepDirection('plus')).toBeNull();
  });
});

describe('computeZoomStepTarget', () => {
  it('zooms in by the step ratio', () => {
    expect(computeZoomStepTarget(1, 'in')).toBeCloseTo(ZOOM_KEY_STEP_RATIO);
    expect(computeZoomStepTarget(0.5, 'in')).toBeCloseTo(0.5 * ZOOM_KEY_STEP_RATIO);
  });

  it('zooms out by dividing the step ratio', () => {
    expect(computeZoomStepTarget(1, 'out')).toBeCloseTo(1 / ZOOM_KEY_STEP_RATIO);
    expect(computeZoomStepTarget(ZOOM_KEY_STEP_RATIO, 'out')).toBeCloseTo(1);
  });

  it('clamps the target zoom within the min and max bounds', () => {
    expect(computeZoomStepTarget(ZOOM_KEY_MAX, 'in')).toBe(ZOOM_KEY_MAX);
    expect(computeZoomStepTarget(ZOOM_KEY_MAX * 10, 'in')).toBe(ZOOM_KEY_MAX);
    expect(computeZoomStepTarget(ZOOM_KEY_MIN, 'out')).toBe(ZOOM_KEY_MIN);
    expect(computeZoomStepTarget(ZOOM_KEY_MIN / 10, 'out')).toBe(ZOOM_KEY_MIN);
  });

  it('returns the current zoom unchanged for invalid inputs', () => {
    expect(computeZoomStepTarget(Number.NaN, 'in')).toBeNaN();
    expect(computeZoomStepTarget(0, 'in')).toBe(0);
    expect(computeZoomStepTarget(-1, 'out')).toBe(-1);
  });

  it('keeps zoom steps symmetric so in and out round-trip', () => {
    const zoomedIn = computeZoomStepTarget(1, 'in');
    expect(computeZoomStepTarget(zoomedIn, 'out')).toBeCloseTo(1);
  });

  it('defines zoom bounds consistent with wheel zoom', () => {
    expect(ZOOM_KEY_MIN).toBe(0.1);
    expect(ZOOM_KEY_MAX).toBe(5);
    expect(ZOOM_KEY_STEP_RATIO).toBeGreaterThan(1);
  });
});

describe('keyboard zoom wiring', () => {
  const source = readFileSync(path.join(process.cwd(), 'components/mindmap-editor.tsx'), 'utf8');
  const zoomHandler = source.slice(
    source.indexOf('+/- 键缩放：以视口中心为锚点'),
    source.indexOf('const direction = getArrowPanDirection(event.key)'),
  );

  it('extracts the zoom handler from the component source', () => {
    expect(zoomHandler.length).toBeGreaterThan(0);
  });

  it('recognizes both zoom in and zoom out keys', () => {
    expect(zoomHandler).toMatch(/getZoomStepDirection\(event\.key\)/);
  });

  it('keeps ctrl/cmd/alt combos for browser and system shortcuts', () => {
    expect(zoomHandler).toMatch(/event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey\) return/);
  });

  it('stays inert while a node is selected or text editing', () => {
    expect(zoomHandler).toMatch(/if \(selectedNodeIdRef\.current !== null\) return;/);
    expect(zoomHandler).toMatch(/editingNodeIdRef\.current !== null \|\| isEditableTarget\(event\.target\)/);
  });

  it('prevents default browser page-zoom on the bare keys', () => {
    expect(zoomHandler).toMatch(/event\.preventDefault\(\)/);
  });

  it('throttles key-repeat so holding the key zooms at a moderate pace', () => {
    expect(zoomHandler).toMatch(/lastZoomStepAt < ZOOM_KEY_REPEAT_THROTTLE_MS/);
  });

  it('skips zooming when already at the boundary', () => {
    expect(zoomHandler).toMatch(/Math\.abs\(targetZoom - currentZoom\) < 0\.0001\) return/);
  });

  it('anchors the zoom at the viewport center with a smooth animation', () => {
    expect(zoomHandler).toMatch(/graph\.getSize\(\)/);
    expect(zoomHandler).toMatch(/width \/ 2, height \/ 2/);
    expect(zoomHandler).toMatch(/zoomTo\(targetZoom, \{ duration: ZOOM_KEY_ANIMATION_MS \}/);
  });
});
