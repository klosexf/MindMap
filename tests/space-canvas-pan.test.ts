import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('space + drag canvas panning wiring', () => {
  const source = readFileSync(path.join(process.cwd(), 'components/mindmap-editor.tsx'), 'utf8');
  const panEffect = source.slice(source.indexOf('按住空格键 + 鼠标左键拖动'));

  it('extracts the space pan effect from the component source', () => {
    expect(panEffect.length).toBeGreaterThan(0);
  });

  it('activates on the space key only without ctrl/meta/alt modifiers', () => {
    expect(panEffect).toMatch(/event\.code !== 'Space' && event\.key !== ' '/);
    expect(panEffect).toMatch(/event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey\) return/);
  });

  it('keeps space inert while editing text or focusing form elements', () => {
    expect(panEffect).toMatch(/editingNodeIdRef\.current !== null \|\| isEditableTarget\(event\.target\)/);
    expect(panEffect).toMatch(/tag === 'input' \|\| tag === 'textarea' \|\| tag === 'select'/);
  });

  it('prevents default only after the editing guards pass', () => {
    const editingGuardIndex = panEffect.indexOf('editingNodeIdRef.current !== null || isEditableTarget(event.target)');
    const preventIndex = panEffect.indexOf('event.preventDefault();');
    expect(editingGuardIndex).toBeGreaterThan(-1);
    expect(preventIndex).toBeGreaterThan(editingGuardIndex);
  });

  it('intercepts pointerdown in the capture phase to block native text selection', () => {
    expect(panEffect).toMatch(/addEventListener\('pointerdown', onPointerDown, true\)/);
    expect(panEffect).toMatch(/event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);/);
  });

  it('pans only with the primary mouse button while space is held', () => {
    expect(panEffect).toMatch(/if \(!spaceHeld \|\| event\.button !== 0\) return;/);
  });

  it('translates the canvas by the pointer delta', () => {
    expect(panEffect).toMatch(/graph\.translateBy\(\[dx, dy\], false\)/);
  });

  it('stops panning on keyup, pointer release and window blur', () => {
    expect(panEffect).toMatch(/const onKeyUp[\s\S]*?spaceHeld = false/);
    expect(panEffect).toMatch(/const onBlur = \(\) => \{[\s\S]*?spaceHeld = false/);
    expect(panEffect).toMatch(/addEventListener\('pointercancel', onPointerUp\)/);
  });

  it('shows grab / grabbing cursors while space is held', () => {
    expect(panEffect).toMatch(/panning \? 'grabbing' : 'grab'/);
  });

  it('disables native text selection on the graph layers as a fallback', () => {
    const css = readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8');
    expect(css).toMatch(/\.mindmap-canvas svg[\s\S]{0,80}user-select:\s*none/);
    expect(css).toMatch(/\.mindmap-canvas canvas[\s\S]{0,80}user-select:\s*none/);
  });
});
