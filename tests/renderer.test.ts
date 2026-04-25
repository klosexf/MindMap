import { describe, expect, it } from 'vitest';

import { selectRenderMode } from '../lib/utils/renderer';

describe('selectRenderMode', () => {
  it('uses svg for <= 800 nodes', () => {
    expect(selectRenderMode(500)).toBe('svg');
    expect(selectRenderMode(800)).toBe('svg');
  });

  it('uses canvas for > 800 nodes', () => {
    expect(selectRenderMode(1000)).toBe('canvas');
    expect(selectRenderMode(2000)).toBe('canvas');
  });
});
