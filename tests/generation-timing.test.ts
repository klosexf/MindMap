import { describe, expect, it } from 'vitest';

import { buildTimingLines, formatDurationMs } from '@/lib/utils/generation-timing';

describe('generation timing helpers', () => {
  it('formats milliseconds as seconds with one decimal place', () => {
    expect(formatDurationMs(450)).toBe('0.5s');
    expect(formatDurationMs(12499)).toBe('12.5s');
  });

  it('builds stage timing lines for in-progress generation', () => {
    const lines = buildTimingLines(
      {
        startedAt: 1_000,
        parseStartedAt: 1_200,
        parseFinishedAt: 4_000,
        streamStartedAt: 4_050,
      },
      9_050,
    );

    expect(lines).toContain('解析耗时：2.8s');
    expect(lines).toContain('首包等待：5.0s');
    expect(lines).toContain('总耗时：8.1s');
  });

  it('uses final timestamps when generation is completed', () => {
    const lines = buildTimingLines({
      startedAt: 0,
      parseStartedAt: 200,
      parseFinishedAt: 2_200,
      streamStartedAt: 2_300,
      firstEventAt: 4_000,
      skeletonAt: 4_000,
      completedAt: 7_500,
    });

    expect(lines).toContain('解析耗时：2.0s');
    expect(lines).toContain('首包等待：1.7s');
    expect(lines).toContain('骨架到达：1.7s');
    expect(lines).toContain('总耗时：7.5s');
  });
});
