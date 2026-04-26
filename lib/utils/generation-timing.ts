export interface GenerationTimingMarks {
  startedAt?: number;
  parseStartedAt?: number;
  parseFinishedAt?: number;
  streamStartedAt?: number;
  firstEventAt?: number;
  skeletonAt?: number;
  completedAt?: number;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function buildTimingLines(marks: GenerationTimingMarks, now = Date.now()): string[] {
  const lines: string[] = [];
  const effectiveNow = Number.isFinite(now) ? now : Date.now();
  const hasNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

  if (hasNumber(marks.parseStartedAt)) {
    const parseEnd = marks.parseFinishedAt ?? effectiveNow;
    lines.push(`解析耗时：${formatDurationMs(parseEnd - marks.parseStartedAt)}`);
  }

  if (hasNumber(marks.streamStartedAt)) {
    const firstEventEnd = marks.firstEventAt ?? effectiveNow;
    lines.push(`首包等待：${formatDurationMs(firstEventEnd - marks.streamStartedAt)}`);
  }

  if (hasNumber(marks.streamStartedAt) && hasNumber(marks.skeletonAt)) {
    lines.push(`骨架到达：${formatDurationMs(marks.skeletonAt - marks.streamStartedAt)}`);
  }

  if (hasNumber(marks.startedAt)) {
    const totalEnd = marks.completedAt ?? effectiveNow;
    lines.push(`总耗时：${formatDurationMs(totalEnd - marks.startedAt)}`);
  }

  return lines;
}
