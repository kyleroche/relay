/**
 * A per-instance memo for a snapshot several viewers poll at once: one computation is shared by every caller that
 * arrives within `ttlMs` of it starting, including callers that arrive while it is still running (they await the
 * same promise). A computation that rejects is dropped so the next caller retries. The browser still gets
 * `cache-control: no-store`; this is the server not doing the same work N times in the same few seconds.
 *
 * Pure: `test/memo.test.ts` drives it with a fake clock.
 */
export interface Memo<T> {
  (): Promise<T>;
  /** Forget the cached value, so the next call computes. */
  reset(): void;
}

export function memoFor<T>(ttlMs: number, compute: () => Promise<T>, clock: () => number = Date.now): Memo<T> {
  let slot: { at: number; promise: Promise<T> } | undefined;
  const memo = (() => {
    const now = clock();
    if (slot && now - slot.at < ttlMs) return slot.promise;
    const mine = { at: now, promise: compute() };
    slot = mine;
    mine.promise.catch(() => {
      if (slot === mine) slot = undefined;
    });
    return mine.promise;
  }) as Memo<T>;
  memo.reset = () => {
    slot = undefined;
  };
  return memo;
}
