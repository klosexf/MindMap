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
});
