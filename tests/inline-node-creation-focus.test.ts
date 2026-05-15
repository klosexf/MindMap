import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('inline node creation focus flow', () => {
  it('centers the viewport before opening inline editing for keyboard-created child nodes', () => {
    const source = readFileSync(path.join(process.cwd(), 'components/editor-page.tsx'), 'utf8');

    expect(source).toMatch(
      /if \(event\.key === 'Tab'\)[\s\S]*?addNodeAndEdit\('child',\s*\{\s*centerInViewport:\s*true\s*\}\)/,
    );
  });

  it('centers the viewport before opening inline editing for keyboard-created sibling nodes', () => {
    const source = readFileSync(path.join(process.cwd(), 'components/editor-page.tsx'), 'utf8');

    expect(source).toMatch(
      /if \(event\.key === 'Enter'[\s\S]*?addNodeAndEdit\('sibling',\s*\{\s*centerInViewport:\s*true\s*\}\)/,
    );
  });
});
