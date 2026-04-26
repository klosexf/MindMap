export async function waitForFirstEventWithWarning<T>(
  nextPromise: Promise<IteratorResult<T>>,
  warningAfterMs: number,
  onWarning: () => void | Promise<void>,
): Promise<IteratorResult<T>> {
  if (!Number.isFinite(warningAfterMs) || warningAfterMs <= 0) {
    return nextPromise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutRace = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), warningAfterMs);
  });
  const nextRace = nextPromise.then((value) => ({ kind: 'next' as const, value }));

  const result = await Promise.race([nextRace, timeoutRace]);
  if (timer) {
    clearTimeout(timer);
  }

  if (result.kind === 'timeout') {
    await onWarning();
    return nextPromise;
  }

  return result.value;
}
