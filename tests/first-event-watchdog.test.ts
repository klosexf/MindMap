import { describe, expect, it, vi } from 'vitest';

import { waitForFirstEventWithWarning } from '@/lib/llm/first-event-watchdog';

describe('waitForFirstEventWithWarning', () => {
  it('does not call warning callback when first event arrives in time', async () => {
    const onWarning = vi.fn();
    const result = await waitForFirstEventWithWarning(
      Promise.resolve({ done: false, value: 'ok' }),
      20_000,
      onWarning,
    );

    expect(result).toEqual({ done: false, value: 'ok' });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('calls warning callback once when first event exceeds timeout', async () => {
    vi.useFakeTimers();
    try {
      const onWarning = vi.fn();
      const nextPromise = new Promise<IteratorResult<string>>((resolve) => {
        setTimeout(() => resolve({ done: false, value: 'late' }), 25_000);
      });

      const pending = waitForFirstEventWithWarning(nextPromise, 20_000, onWarning);

      await vi.advanceTimersByTimeAsync(19_999);
      expect(onWarning).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onWarning).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({ done: false, value: 'late' });
    } finally {
      vi.useRealTimers();
    }
  });
});
