import { describe, expect, it } from 'vitest';

import { NODE_VISUAL_TOKENS, getNodeFontMetrics, getNodeFontMetricsByDepth, getNodeSize } from '../lib/utils/g6';

describe('node style levels by depth', () => {
  it('scales font size and weight down level by level', () => {
    const root = getNodeFontMetricsByDepth(0);
    const level1 = getNodeFontMetricsByDepth(1);
    const level2 = getNodeFontMetricsByDepth(2);
    const detail = getNodeFontMetricsByDepth(3);
    const deeper = getNodeFontMetricsByDepth(7);

    expect(root.fontSize).toBe(NODE_VISUAL_TOKENS.rootFontSize);
    expect(root.fontWeight).toBe(NODE_VISUAL_TOKENS.rootFontWeight);

    expect(root.fontSize).toBeGreaterThan(level1.fontSize);
    expect(level1.fontSize).toBeGreaterThan(level2.fontSize);
    expect(level2.fontSize).toBeGreaterThan(detail.fontSize);
    expect(root.fontWeight).toBeGreaterThan(level1.fontWeight);
    expect(level1.fontWeight).toBeGreaterThan(level2.fontWeight);
    expect(level2.fontWeight).toBeGreaterThan(detail.fontWeight);

    expect(deeper.fontSize).toBe(detail.fontSize);
    expect(deeper.fontWeight).toBe(detail.fontWeight);
  });

  it('keeps level-2 metrics equal to the historical default so old maps look unchanged', () => {
    const level2 = getNodeFontMetricsByDepth(2);

    expect(level2.fontSize).toBe(NODE_VISUAL_TOKENS.fontSize);
    expect(level2.fontWeight).toBe(NODE_VISUAL_TOKENS.fontWeight);
  });

  it('still lets the root id win over depth and falls back to defaults without depth', () => {
    const rootById = getNodeFontMetrics('root', 'root', 3);
    const childWithDepth = getNodeFontMetrics('child', 'root', 1);
    const childWithoutDepth = getNodeFontMetrics('child', 'root');

    expect(rootById.fontSize).toBe(NODE_VISUAL_TOKENS.rootFontSize);
    expect(childWithDepth.fontSize).toBe(NODE_VISUAL_TOKENS.level1FontSize);
    expect(childWithoutDepth.fontSize).toBe(NODE_VISUAL_TOKENS.fontSize);
  });

  it('sizes boxes according to the level font so labels keep fitting', () => {
    const text = '积分生态与数字消费营销体系';
    const level1 = getNodeSize('n1', text, 'root', 1);
    const detail = getNodeSize('n2', text, 'root', 4);

    expect(level1.width).toBeGreaterThan(detail.width);
  });
});
