import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ARROW_PAN_INITIAL_SPEED_RATIO,
  ARROW_PAN_MAX_FRAME_DELTA,
  ARROW_PAN_MAX_SPEED,
  ARROW_PAN_RAMP_DURATION,
  ARROW_PAN_TAIL_SPEED,
  ARROW_PAN_TAP_MIN_STEP,
  clampArrowPanOffset,
  computeArrowPanOffset,
  computeArrowPanTailOffset,
  getArrowPanDirection,
  getArrowPanUnit,
  type ArrowPanDirection,
  type GraphContentBounds,
} from '../lib/utils/g6-viewport';

function directions(...items: ArrowPanDirection[]): Set<ArrowPanDirection> {
  return new Set(items);
}

describe('getArrowPanDirection', () => {
  it('maps arrow keys to pan directions', () => {
    expect(getArrowPanDirection('ArrowUp')).toBe('up');
    expect(getArrowPanDirection('ArrowDown')).toBe('down');
    expect(getArrowPanDirection('ArrowLeft')).toBe('left');
    expect(getArrowPanDirection('ArrowRight')).toBe('right');
  });

  it('ignores non-arrow keys', () => {
    expect(getArrowPanDirection('Enter')).toBeNull();
    expect(getArrowPanDirection('Tab')).toBeNull();
    expect(getArrowPanDirection('a')).toBeNull();
    expect(getArrowPanDirection('')).toBeNull();
  });
});

describe('computeArrowPanOffset', () => {
  it('pans the viewport in the pressed arrow direction (content moves opposite)', () => {
    const held = ARROW_PAN_RAMP_DURATION;

    const [upX, upY] = computeArrowPanOffset(directions('up'), held, 100);
    expect(upX).toBe(0);
    expect(upY).toBeGreaterThan(0);

    const [downX, downY] = computeArrowPanOffset(directions('down'), held, 100);
    expect(downX).toBe(0);
    expect(downY).toBeLessThan(0);

    const [leftX, leftY] = computeArrowPanOffset(directions('left'), held, 100);
    expect(leftX).toBeGreaterThan(0);
    expect(leftY).toBe(0);

    const [rightX, rightY] = computeArrowPanOffset(directions('right'), held, 100);
    expect(rightX).toBeLessThan(0);
    expect(rightY).toBe(0);
  });

  it('starts at the initial speed ratio for a smooth take-off', () => {
    const [dx] = computeArrowPanOffset(directions('right'), 0, 100);
    expect(dx).toBeCloseTo(-ARROW_PAN_MAX_SPEED * ARROW_PAN_INITIAL_SPEED_RATIO * 0.1);
  });

  it('accelerates smoothly and reaches max speed after the ramp duration', () => {
    const expectedHalfRatio = ARROW_PAN_INITIAL_SPEED_RATIO + (1 - ARROW_PAN_INITIAL_SPEED_RATIO) * 0.5;
    const [halfway] = computeArrowPanOffset(directions('right'), ARROW_PAN_RAMP_DURATION / 2, 100);
    expect(halfway).toBeCloseTo(-ARROW_PAN_MAX_SPEED * expectedHalfRatio * 0.1);

    const early = computeArrowPanOffset(directions('right'), 10, 100)[0];
    const middle = computeArrowPanOffset(directions('right'), 100, 100)[0];
    const full = computeArrowPanOffset(directions('right'), ARROW_PAN_RAMP_DURATION, 100)[0];
    const beyond = computeArrowPanOffset(directions('right'), ARROW_PAN_RAMP_DURATION * 10, 100)[0];
    expect(early).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(full);
    expect(beyond).toBeCloseTo(full);

    // 满速：600px/s × 0.1s = 60px（内容向左）
    expect(full).toBeCloseTo(-ARROW_PAN_MAX_SPEED * 0.1);
  });

  it('scales movement with the frame delta for frame-rate independence', () => {
    const fullSpeed = ARROW_PAN_MAX_SPEED;
    const [short] = computeArrowPanOffset(directions('right'), ARROW_PAN_RAMP_DURATION, 16);
    const [long] = computeArrowPanOffset(directions('right'), ARROW_PAN_RAMP_DURATION, 33);
    expect(short).toBeCloseTo(-fullSpeed * 0.016);
    expect(long).toBeCloseTo(-fullSpeed * 0.033);
    expect(long).toBeLessThan(short);
  });

  it('normalizes diagonal movement so combined keys keep the same speed', () => {
    const [dx, dy] = computeArrowPanOffset(directions('up', 'right'), ARROW_PAN_RAMP_DURATION, 100);
    const expected = ARROW_PAN_MAX_SPEED * 0.1;
    expect(dx).toBeCloseTo(-expected * Math.SQRT1_2);
    expect(dy).toBeCloseTo(expected * Math.SQRT1_2);
    expect(Math.hypot(dx, dy)).toBeCloseTo(expected);
  });

  it('supports all four diagonal combinations', () => {
    const held = ARROW_PAN_RAMP_DURATION;
    const [upLeftX, upLeftY] = computeArrowPanOffset(directions('up', 'left'), held, 100);
    expect(upLeftX).toBeGreaterThan(0);
    expect(upLeftY).toBeGreaterThan(0);

    const [downRightX, downRightY] = computeArrowPanOffset(directions('down', 'right'), held, 100);
    expect(downRightX).toBeLessThan(0);
    expect(downRightY).toBeLessThan(0);
  });

  it('cancels movement when opposite keys are held together', () => {
    expect(computeArrowPanOffset(directions('left', 'right'), 500, 100)).toEqual([0, 0]);
    expect(computeArrowPanOffset(directions('up', 'down'), 500, 100)).toEqual([0, 0]);
  });

  it('returns zero offset for empty input or invalid frame deltas', () => {
    expect(computeArrowPanOffset(new Set(), 500, 100)).toEqual([0, 0]);
    expect(computeArrowPanOffset(directions('up'), 500, 0)).toEqual([0, 0]);
    expect(computeArrowPanOffset(directions('up'), 500, -16)).toEqual([0, 0]);
    expect(computeArrowPanOffset(directions('up'), 500, Number.NaN)).toEqual([0, 0]);
    // heldMs 非法时按起步时刻处理（起步速度），不会产生异常位移
    expect(computeArrowPanOffset(directions('up'), Number.NaN, 16)).toEqual([
      0,
      ARROW_PAN_MAX_SPEED * ARROW_PAN_INITIAL_SPEED_RATIO * 0.016,
    ]);
  });

  it('caps single-frame travel after long frame gaps', () => {
    const [dx] = computeArrowPanOffset(directions('right'), ARROW_PAN_RAMP_DURATION, 10_000);
    expect(dx).toBeCloseTo(-ARROW_PAN_MAX_SPEED * (ARROW_PAN_MAX_FRAME_DELTA / 1000));
  });
});

describe('getArrowPanUnit', () => {
  it('returns content-translation units opposite to the pressed arrow direction', () => {
    expect(getArrowPanUnit(directions('up'))).toEqual([0, 1]);
    expect(getArrowPanUnit(directions('down'))).toEqual([0, -1]);
    expect(getArrowPanUnit(directions('left'))).toEqual([1, 0]);
    expect(getArrowPanUnit(directions('right'))).toEqual([-1, 0]);
  });

  it('normalizes diagonal combinations to unit length', () => {
    const [dx, dy] = getArrowPanUnit(directions('up', 'right'));
    expect(Math.hypot(dx, dy)).toBeCloseTo(1);
    expect(dx).toBeLessThan(0);
    expect(dy).toBeGreaterThan(0);
  });

  it('returns zero vector for empty or opposing sets', () => {
    expect(getArrowPanUnit(new Set())).toEqual([0, 0]);
    expect(getArrowPanUnit(directions('left', 'right'))).toEqual([0, 0]);
  });
});

describe('computeArrowPanTailOffset', () => {
  it('glides along the last direction at the tail speed', () => {
    const [dx, dy] = computeArrowPanTailOffset([1, 0], 500, 100);
    expect(dx).toBeCloseTo(ARROW_PAN_TAIL_SPEED * 0.1);
    expect(dy).toBe(0);
  });

  it('never exceeds the remaining distance on the final frame', () => {
    const [dx] = computeArrowPanTailOffset([1, 0], 5, 100);
    expect(dx).toBeCloseTo(5);
  });

  it('returns zero for missing unit, non-positive remaining, or invalid deltas', () => {
    expect(computeArrowPanTailOffset([0, 0], 100, 16)).toEqual([0, 0]);
    expect(computeArrowPanTailOffset([1, 0], 0, 16)).toEqual([0, 0]);
    expect(computeArrowPanTailOffset([1, 0], -10, 16)).toEqual([0, 0]);
    expect(computeArrowPanTailOffset([1, 0], 100, 0)).toEqual([0, 0]);
    expect(computeArrowPanTailOffset([1, 0], 100, Number.NaN)).toEqual([0, 0]);
  });

  it('caps single-frame travel after long frame gaps', () => {
    const [dx] = computeArrowPanTailOffset([1, 0], 10_000, 10_000);
    expect(dx).toBeCloseTo(ARROW_PAN_TAIL_SPEED * (ARROW_PAN_MAX_FRAME_DELTA / 1000));
  });

  it('defines a sensible tap minimum step', () => {
    expect(ARROW_PAN_TAP_MIN_STEP).toBeGreaterThan(20);
    expect(ARROW_PAN_TAP_MIN_STEP).toBeLessThan(120);
  });
});

describe('clampArrowPanOffset', () => {
  // 内容包围盒 1000×800，画布 800×600，zoom=1 时：
  // x 允许范围 [60-1000, 800-60] = [-940, 740]，y 允许范围 [-740, 540]
  const CONTENT: GraphContentBounds = { min: [0, 0], max: [1000, 800] };

  function clampOffset(
    offset: [number, number],
    position: [number, number],
    options?: {
      zoom?: number;
      canvasSize?: [number, number];
      contentBounds?: GraphContentBounds | null;
    },
  ): [number, number] {
    return clampArrowPanOffset(offset, {
      position,
      zoom: options?.zoom ?? 1,
      canvasSize: options?.canvasSize ?? [800, 600],
      contentBounds: options?.contentBounds === undefined ? CONTENT : options.contentBounds,
    });
  }

  it('keeps normal movement inside the allowed range untouched', () => {
    expect(clampOffset([10, -20], [0, 0])).toEqual([10, -20]);
    expect(clampOffset([-100, 100], [-500, 300])).toEqual([-100, 100]);
  });

  it('stops the canvas at the right-edge boundary', () => {
    expect(clampOffset([10, 0], [740, 0])).toEqual([0, 0]);
    // 部分越界只放行到边界，无跳变
    expect(clampOffset([20, 0], [735, 0])).toEqual([5, 0]);
  });

  it('stops the canvas at the left-edge boundary', () => {
    expect(clampOffset([-10, 0], [-940, 0])).toEqual([0, 0]);
    expect(clampOffset([-20, 0], [-930, 0])).toEqual([-10, 0]);
  });

  it('stops the canvas at the top and bottom boundaries', () => {
    // y 允许范围 [-740, 540]
    expect(clampOffset([0, -10], [0, -740])).toEqual([0, 0]);
    expect(clampOffset([0, -10], [0, -735])).toEqual([0, -5]);
    expect(clampOffset([0, 10], [0, 540])).toEqual([0, 0]);
    expect(clampOffset([0, 20], [0, 535])).toEqual([0, 5]);
  });

  it('clamps both axes independently', () => {
    expect(clampOffset([10, 30], [0, 520])).toEqual([10, 20]);
  });

  it('blocks outward movement but allows inward movement when already beyond the boundary', () => {
    // pos=1000：内容已完全在视口右侧之外（鼠标拖拽画布本就无边界）
    expect(clampOffset([10, 0], [1000, 0])).toEqual([0, 0]);
    expect(clampOffset([-60, 0], [1000, 0])).toEqual([-60, 0]);
    // pos=-2000：内容已完全在视口左侧之外
    expect(clampOffset([-10, 0], [-2000, 0])).toEqual([0, 0]);
    expect(clampOffset([60, 0], [-2000, 0])).toEqual([60, 0]);
  });

  it('never applies a larger movement than requested', () => {
    const [dx] = clampOffset([-5000, 0], [1000, 0]);
    expect(dx).toBeGreaterThanOrEqual(-5000);
    expect(dx).toBeLessThanOrEqual(0);
    expect(Math.abs(dx)).toBeLessThanOrEqual(5000);
  });

  it('accounts for zoom when computing boundaries', () => {
    // zoom=2：内容宽 2000，x 允许范围 [60-2000, 800-60] = [-1940, 740]
    expect(clampOffset([10, 0], [740, 0], { zoom: 2 })).toEqual([0, 0]);
    expect(clampOffset([10, 0], [0, 0], { zoom: 2 })).toEqual([10, 0]);
  });

  it('keeps tiny content fully inside the viewport when it is smaller than the margin', () => {
    // 内容宽 30 < 边距 60：minOverlap=30，x 允许范围 [30-30, 800-30] = [0, 770]
    expect(clampOffset([-10, 0], [0, 0], { contentBounds: { min: [0, 0], max: [30, 800] } })).toEqual([0, 0]);
    expect(clampOffset([-100, 0], [100, 0], { contentBounds: { min: [0, 0], max: [30, 800] } })).toEqual([-100, 0]);
    expect(clampOffset([10, 0], [100, 0], { contentBounds: { min: [0, 0], max: [30, 800] } })).toEqual([10, 0]);
  });

  it('does not clamp when viewport context is missing or invalid', () => {
    expect(
      clampArrowPanOffset([30, -40], {
        position: [0, 0],
        zoom: 1,
        canvasSize: [800, 600],
        contentBounds: null,
      }),
    ).toEqual([30, -40]);

    expect(
      clampArrowPanOffset([30, -40], {
        position: [Number.NaN, 0],
        zoom: 1,
        canvasSize: [800, 600],
        contentBounds: CONTENT,
      }),
    ).toEqual([30, -40]);

    expect(
      clampArrowPanOffset([30, -40], {
        position: [0, 0],
        zoom: Number.NaN,
        canvasSize: [800, 600],
        contentBounds: CONTENT,
      }),
    ).toEqual([30, -40]);

    expect(
      clampArrowPanOffset([30, -40], {
        position: [0, 0],
        zoom: 1,
        canvasSize: [800, 600],
        contentBounds: { min: [Number.NaN, 0], max: [1000, 800] },
      }),
    ).toEqual([30, -40]);
  });

  it('skips degenerate content bounds without clamping', () => {
    expect(clampOffset([50, 50], [0, 0], { contentBounds: { min: [10, 10], max: [10, 10] } })).toEqual([50, 50]);
    expect(clampOffset([50, 50], [0, 0], { contentBounds: { min: [20, 20], max: [10, 10] } })).toEqual([50, 50]);
  });

  it('skips clamping when the viewport is smaller than the visibility margins', () => {
    // 视口宽 40、内容宽 50：该轴上下界交叉，放弃限制避免画布被锁死
    expect(
      clampOffset([10, 0], [0, 0], {
        canvasSize: [40, 600],
        contentBounds: { min: [0, 0], max: [50, 800] },
      }),
    ).toEqual([10, 0]);
  });
});

describe('arrow-key canvas panning wiring', () => {
  const source = readFileSync(path.join(process.cwd(), 'components/mindmap-editor.tsx'), 'utf8');
  const panEffect = source.slice(source.indexOf('无节点选中时，方向键平滑拖动整个画布'));

  it('extracts the arrow pan effect from the component source', () => {
    expect(panEffect.length).toBeGreaterThan(0);
  });

  it('activates only when no node is selected', () => {
    expect(panEffect).toMatch(/if \(selectedNodeIdRef\.current !== null\) return;/);
  });

  it('prevents default only after the selection and editing guards pass', () => {
    const selectionGuardIndex = panEffect.indexOf('if (selectedNodeIdRef.current !== null) return;');
    const editingGuardIndex = panEffect.indexOf('editingNodeIdRef.current !== null || isEditableTarget(event.target)');
    const preventIndex = panEffect.indexOf('event.preventDefault();');
    expect(selectionGuardIndex).toBeGreaterThan(-1);
    expect(editingGuardIndex).toBeGreaterThan(-1);
    expect(preventIndex).toBeGreaterThan(selectionGuardIndex);
    expect(preventIndex).toBeGreaterThan(editingGuardIndex);
  });

  it('keeps arrow keys inert while editing text or focusing form elements', () => {
    expect(panEffect).toMatch(/editingNodeIdRef\.current !== null \|\| isEditableTarget\(event\.target\)/);
    expect(panEffect).toMatch(/tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select'/);
  });

  it('ignores arrow keys combined with modifier keys', () => {
    expect(panEffect).toMatch(/event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey \|\| event\.shiftKey\) return/);
  });

  it('ignores OS key repeat via the active direction set', () => {
    expect(panEffect).toMatch(/if \(activeDirections\.has\(direction\)\) return;/);
  });

  it('stops the pan loop on keyup and window blur', () => {
    expect(panEffect).toMatch(/const onKeyUp[\s\S]*?activeDirections\.delete\(direction\)/);
    expect(panEffect).toMatch(/const onBlur = \(\) => stopPan\(\)/);
    expect(panEffect).toMatch(/cancelAnimationFrame\(session\.rafId\)/);
  });

  it('keeps gliding to the tap minimum step after a quick key tap', () => {
    expect(panEffect).toMatch(/session\.tailTarget = ARROW_PAN_TAP_MIN_STEP/);
    expect(panEffect).toMatch(/computeArrowPanTailOffset\(/);
  });

  it('stops immediately on keyup when the hold already moved past the tap step', () => {
    expect(panEffect).toMatch(/session\.movedDistance >= ARROW_PAN_TAP_MIN_STEP[\s\S]*?stopPan\(\)/);
  });

  it('extends the glide target when the key is pressed again mid-glide', () => {
    expect(panEffect).toMatch(/session\.movedDistance \+ ARROW_PAN_TAP_MIN_STEP/);
  });

  it('stops the pan loop mid-session when a node gets selected or editing starts', () => {
    expect(panEffect).toMatch(
      /\(!held && !tailActive\) \|\|\s*\n\s*selectedNodeIdRef\.current !== null \|\|\s*\n\s*editingNodeIdRef\.current !== null/,
    );
  });

  it('applies boundary clamping before translating the canvas', () => {
    expect(panEffect).toMatch(/clampArrowPanOffset\(offset,[\s\S]*?graph\.translateBy\(nextOffset, false\)/);
  });

  it('runs the pan loop on requestAnimationFrame for smooth continuous movement', () => {
    expect(panEffect).toMatch(/rafId: requestAnimationFrame\(step\)/);
    expect(panEffect).toMatch(/session\.rafId = requestAnimationFrame\(step\)/);
  });

  it('clears the node selection when clicking blank canvas so panning can activate', () => {
    expect(source).toMatch(
      /graph\.on\('canvas:click'[\s\S]*?onSelectNodeRef\.current\(null\)/,
    );
  });
});
