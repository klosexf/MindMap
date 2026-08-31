import { describe, expect, it } from 'vitest';

import { isActiveGenerationForTree } from '../store/generation-store';

describe('isActiveGenerationForTree（编辑器加载/卸载决策）', () => {
  it('returns true only for streaming or paused sessions with a matching treeId', () => {
    expect(isActiveGenerationForTree({ treeId: 't1', status: 'streaming' }, 't1')).toBe(true);
    expect(isActiveGenerationForTree({ treeId: 't1', status: 'paused' }, 't1')).toBe(true);
  });

  it('returns false for terminal statuses even when the treeId matches', () => {
    for (const status of ['completed', 'stopped', 'error', 'idle'] as const) {
      expect(isActiveGenerationForTree({ treeId: 't1', status }, 't1')).toBe(false);
    }
  });

  it('returns false when the treeId does not match or the session has no tree', () => {
    expect(isActiveGenerationForTree({ treeId: 't1', status: 'streaming' }, 't2')).toBe(false);
    expect(isActiveGenerationForTree({ treeId: null, status: 'streaming' }, 't1')).toBe(false);
  });
});
