import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * AI「内容拓展 → 应用到节点」后的视觉焦点保持：
 * 1) 应用即选中目标节点（重渲染完成后补挂 selected 高亮）；
 * 2) 聚焦挂到下一次全量渲染尾部，节点按新布局居中。
 */
describe('AI apply-to-node focus flow', () => {
  const editorPage = readFileSync(path.join(process.cwd(), 'components/editor-page.tsx'), 'utf8');
  const editorCanvas = readFileSync(path.join(process.cwd(), 'components/mindmap-editor.tsx'), 'utf8');

  it('handleApplyAiText selects the node and requests post-render centering', () => {
    const handler = editorPage.match(
      /const handleApplyAiText = useCallback\(\s*\(nodeId: string, text: string\) => \{[\s\S]*?\},\s*\[[\s\S]*?\],\s*\);/,
    );
    expect(handler).not.toBeNull();
    const body = handler![0];
    expect(body).toMatch(/updateNodeContent\(nodeId, text\)/);
    expect(body).toMatch(/setSelectedNode\(nodeId\)/);
    expect(body).toMatch(/editorRef\.current\?\.focusNodeAfterRender\(nodeId\)/);
  });

  it('exposes focusNodeAfterRender which arms the render-tail focus pipeline', () => {
    expect(editorCanvas).toMatch(/focusNodeAfterRender:\s*\(nodeId: string\) => \{[\s\S]*?focusNodeIdOnNextRenderRef\.current = nodeId;/);
  });

  it('arms the toolbar settle window so the floating box does not drift during apply', () => {
    // 聚焦请求同时开启沉降窗口：抑制悬浮框 rect 上报，直到承载聚焦的渲染
    // 与居中动画落位后才在最终位置重现（与拖拽 reparent 同一机制）
    const method = editorCanvas.match(/focusNodeAfterRender:\s*\(nodeId: string\) => \{[\s\S]*?\n    \},/);
    expect(method).not.toBeNull();
    expect(method![0]).toMatch(/dragSettlingRef\.current = true;/);
    expect(method![0]).toMatch(/dragSettleRenderDoneRef\.current = false;/);
    expect(method![0]).toMatch(/dragSettleReparentRenderRef\.current = true;/);
  });

  it('re-applies the selected highlight after each full render', () => {
    // 渲染完成回调里补挂选中态（元素级状态不跨 setData 存活）
    expect(editorCanvas).toMatch(/syncAiTypingState\(\);[\s\S]*?syncSelectedState\(\);/);
    // syncSelectedState 把 'selected' 挂到当前选中节点
    expect(editorCanvas).toMatch(
      /const syncSelectedState = useCallback\(\(\) => \{[\s\S]*?graph\.setElementState\(nodeId, \['selected'\]\)/,
    );
  });
});
