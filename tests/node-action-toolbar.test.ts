import { describe, expect, it } from 'vitest';

import { computeToolbarPosition } from '../components/node-action-toolbar';

const TOOLBAR_WIDTH = 176;
const TOOLBAR_HEIGHT = 56;
const EDGE_GAP = 8;

describe('computeToolbarPosition', () => {
  const vw = 1440;
  const vh = 900;

  it('默认出现在节点右下方：右缘与节点右缘对齐，位于节点下方', () => {
    const pos = computeToolbarPosition({ left: 200, top: 300, width: 120, height: 40 }, vw, vh);
    expect(pos.left).toBe(200 + 120 - TOOLBAR_WIDTH);
    expect(pos.top).toBe(300 + 40 + 8);
  });

  it('右缘对齐越出左缘时钳制到视口内', () => {
    // 节点很靠左，右对齐会让工具栏左缘 < 0
    const pos = computeToolbarPosition({ left: 10, top: 300, width: 120, height: 40 }, vw, vh);
    expect(pos.left).toBe(EDGE_GAP);
    expect(pos.top).toBe(300 + 40 + 8);
  });

  it('右缘越出视口右缘时钳制到视口内', () => {
    const pos = computeToolbarPosition({ left: 1350, top: 300, width: 120, height: 40 }, vw, vh);
    expect(pos.left).toBe(vw - EDGE_GAP - TOOLBAR_WIDTH);
  });

  it('下方放不下时翻转到节点上方，仍右对齐', () => {
    // 节点贴近视口底部
    const pos = computeToolbarPosition({ left: 200, top: vh - 30, width: 120, height: 40 }, vw, vh);
    expect(pos.top).toBe(vh - 30 - 8 - TOOLBAR_HEIGHT);
    expect(pos.left).toBe(200 + 120 - TOOLBAR_WIDTH);
  });

  it('上下都放不下时钳制在视口内', () => {
    // 超小视口：下方越界，翻到上方后 top 为负，钳制到顶部 EDGE_GAP
    const pos = computeToolbarPosition({ left: 200, top: 60, width: 120, height: 8 }, vw, 100);
    expect(pos.top).toBe(EDGE_GAP);
  });

  it('顶部越界钳制不为负', () => {
    // 节点顶部在视口外，下方也放不下时钳制到 EDGE_GAP
    const pos = computeToolbarPosition({ left: 200, top: -80, width: 120, height: 40 }, 400, vh);
    expect(pos.top).toBeGreaterThanOrEqual(EDGE_GAP);
  });

  it('超小视口下不会产生负坐标', () => {
    const pos = computeToolbarPosition({ left: 0, top: 0, width: 400, height: 40 }, 320, 480);
    expect(pos.left).toBeGreaterThanOrEqual(EDGE_GAP);
    expect(pos.top).toBeGreaterThanOrEqual(EDGE_GAP);
  });
});
