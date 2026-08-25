// src/utils/raf-throttle.ts

export interface ThrottledScheduler {
  /** Request a run. Repeated calls within the same frame/cooldown coalesce into one. */
  schedule(): void;
  /** Drop any pending run. */
  cancel(): void;
}

/**
 * Coalesces repeated calls into at most one invocation per animation frame,
 * with an optional minimum interval between invocations. A call made during
 * the cooldown still produces a trailing invocation, so the final state of a
 * gesture is never dropped.
 */
export function createThrottledScheduler(fn: () => void, minIntervalMs = 0): ThrottledScheduler {
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastRun = 0;

  const run = () => {
    rafId = null;
    timerId = null;
    lastRun = performance.now();
    fn();
  };

  return {
    schedule() {
      if (rafId !== null || timerId !== null) return;
      const wait = minIntervalMs - (performance.now() - lastRun);
      if (wait <= 0) {
        rafId = requestAnimationFrame(run);
      } else {
        timerId = setTimeout(() => {
          timerId = null;
          rafId = requestAnimationFrame(run);
        }, wait);
      }
    },
    cancel() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (timerId !== null) clearTimeout(timerId);
      rafId = null;
      timerId = null;
    },
  };
}
