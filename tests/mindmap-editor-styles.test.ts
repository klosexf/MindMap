import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('mindmap drag preview styles', () => {
  const SHADOW_PROP_PATTERN = /\bshadow(?:Color|Blur|Offset[XY])\s*:/;

  function readStateBlock(source: string, stateName: string): string {
    const escapedStateName = stateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockPattern = new RegExp(`['"]?${escapedStateName}['"]?:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`, 'm');
    const match = source.match(blockPattern);
    expect(match?.[1]).toBeTruthy();
    return match?.[1] ?? '';
  }

  it('does not apply SVG shadow filters to transient drag states', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'components/mindmap-editor.tsx'),
      'utf8',
    );

    const draggingState = readStateBlock(source, 'dragging');
    const dropChildState = readStateBlock(source, 'drop-child');
    const dropSiblingBeforeState = readStateBlock(source, 'drop-sibling-before');
    const dropSiblingAfterState = readStateBlock(source, 'drop-sibling-after');

    expect(draggingState).not.toMatch(SHADOW_PROP_PATTERN);
    expect(dropChildState).not.toMatch(SHADOW_PROP_PATTERN);
    expect(dropSiblingBeforeState).not.toMatch(SHADOW_PROP_PATTERN);
    expect(dropSiblingAfterState).not.toMatch(SHADOW_PROP_PATTERN);
  });

  it('uses a small polyline corner radius so connectors stay close to right angles', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'lib/utils/g6.ts'),
      'utf8',
    );

    expect(source).toMatch(/polylineRadius:\s*10/);
  });

  it('enables orthogonal polyline routing so edge segments stay horizontal or vertical', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'lib/utils/g6.ts'),
      'utf8',
    );

    expect(source).toMatch(/type:\s*'orth'\s+as const/);
  });

  it('styles nodes via per-depth visuals so each hierarchy level has its own treatment', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'components/mindmap-editor.tsx'),
      'utf8',
    );

    // 暖调手作方案：fill/stroke/radius/labelFill 全部走 getNodeDepthVisuals 回调
    expect(source).toMatch(/function getNodeDepthVisuals\(depth: number, branchIndex: number\)/);
    for (const prop of ['fill', 'stroke', 'lineWidth', 'radius', 'labelFill']) {
      expect(source).toMatch(new RegExp(`${prop}: \\(datum[\\s\\S]{0,160}?getNodeDepthVisuals\\(`));
    }
    // 一级分支与连线共享同一分支色
    expect(source).toMatch(/branchIndexByNodeId/);
    expect(source).toMatch(/stroke: getBranchColor\(branchIndex\)/);
  });

  it('drives label font size and weight from per-node metrics so the root title is emphasized', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'components/mindmap-editor.tsx'),
      'utf8',
    );

    expect(source).toMatch(/getNodeFontMetrics\(datum\.id \|\| '', rootId, depth\)/);
    expect(source).toMatch(/labelFontSize:/);
    expect(source).toMatch(/labelFontWeight:/);
    expect(source).toMatch(/fontSize: editingFontMetrics\?\.fontSize \?\? NODE_VISUAL_TOKENS\.fontSize/);
    expect(source).toMatch(/fontWeight: editingFontMetrics\?\.fontWeight \?\? NODE_VISUAL_TOKENS\.fontWeight/);
  });

  it('limits node dragging to the right mouse button and suppresses the canvas context menu', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'components/mindmap-editor.tsx'),
      'utf8',
    );

    expect(source).toMatch(/isRightMouseButtonEvent\(event\)/);
    expect(source).toMatch(/event\?\.button\s*===\s*2/);
    expect(source).toMatch(/addEventListener\(\s*'contextmenu'/);
    expect(source).toMatch(/preventDefault\(\)/);
  });

  it('expands the inline editor downward based on the remaining viewport height', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'components/mindmap-editor.tsx'),
      'utf8',
    );

    expect(source).toMatch(/viewportRect\.bottom\s*-\s*editRect\.top\s*-\s*16/);
    expect(source).not.toMatch(/const maxHeight = viewportRect\.height - 32/);
  });

  it('wraps inline editor text without enabling internal scrolling', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'components/mindmap-editor.tsx'),
      'utf8',
    );

    expect(source).not.toMatch(/overflowY:\s*'auto'/);
    expect(source).not.toMatch(/overflowX:\s*'hidden'/);
    expect(source).toMatch(/overflow:\s*'hidden'/);
    expect(source).toMatch(/overflowWrap:\s*'anywhere'/);
    expect(source).toMatch(/wordBreak:\s*'break-word'/);
  });

  it('sizes the inline editor from the textarea scrollHeight after real browser layout', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'components/mindmap-editor.tsx'),
      'utf8',
    );

    expect(source).toMatch(/textareaRef\.current/);
    expect(source).toMatch(/scrollHeight/);
    expect(source).toMatch(/style\.height\s*=\s*'auto'/);
  });

  it('keeps the stylesheet fallback aligned with the no-scroll wrapping behavior', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'app/globals.css'),
      'utf8',
    );

    expect(source).not.toMatch(/\.node-inline-editor\s*\{[\s\S]*overflow-y:\s*auto/);
    expect(source).toMatch(/\.node-inline-editor\s*\{[\s\S]*overflow:\s*hidden/);
    expect(source).toMatch(/\.node-inline-editor\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
    expect(source).toMatch(/\.node-inline-editor\s*\{[\s\S]*word-break:\s*break-word/);
  });
});
