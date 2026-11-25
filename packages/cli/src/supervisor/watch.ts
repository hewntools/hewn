// SPDX-License-Identifier: AGPL-3.0-or-later
// The watchdog's loop: a health check every `intervalMs`, and `onStall` once a process hasn't answered for longer
// than it's allowed. With `backoff`, each restart doubles the time the next stall is allowed (up to 2 minutes), until
// the process has answered for a minute without a break: a restart doesn't help a process that gets no CPU (a
// throttled shared CPU), and each one costs CPU it doesn't have.

/** How long a process must answer without a break before its restarts are forgotten, and the most a stall is allowed. */
export const BACKOFF_WINDOW_MS = 60_000;
export const BACKOFF_MAX_MS = 120_000;

/** How long a process may go without answering after `strikes` restarts it hasn't yet answered a minute since. */
export const allowedStall = (stallMs: number, strikes: number) => Math.min(BACKOFF_MAX_MS, stallMs * 2 ** strikes);

export function watchHealth(o: {
  intervalMs: number;
  stallMs: number;
  check: (timeoutMs: number) => Promise<boolean>;
  /**
   * Called with how long it went without an answer, how long the next stall may last before it's called again, and
   * whether it was restarted before (and hasn't answered for a minute since).
   */
  onStall: (seconds: number, nextAllowedMs: number, again: boolean) => Promise<void> | void;
  backoff?: boolean;
  /** While false, a silence isn't counted (the process is starting: it hasn't answered since it started). */
  ready?: () => boolean;
  now?: () => number;
}): ReturnType<typeof setInterval> {
  const now = o.now ?? Date.now;
  let lastOk = now();
  /** Restarts since it last answered for a minute without a break; and since when it has answered without a break. */
  let strikes = 0;
  let okSince = now();
  let failing = false;
  let checking = false;
  const t = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      // A ping that timed out may have been this process's own pause (a long synchronous step, a laptop
      // waking), not workerd's: one more, with a fresh timeout, before it counts.
      if ((await o.check(o.intervalMs)) || (await o.check(o.intervalMs))) {
        if (failing) okSince = now();
        failing = false;
        lastOk = now();
        if (strikes && now() - okSince >= BACKOFF_WINDOW_MS) strikes = 0;
      } else if (o.ready && !o.ready()) {
        lastOk = now();
      } else {
        failing = true;
        const allowed = o.backoff ? allowedStall(o.stallMs, strikes) : o.stallMs;
        if (now() - lastOk > allowed) {
          const seconds = Math.round((now() - lastOk) / 1000);
          const again = strikes > 0;
          if (o.backoff) strikes++;
          lastOk = now() + 5000;
          await o.onStall(seconds, o.backoff ? allowedStall(o.stallMs, strikes) : o.stallMs, again);
        }
      }
    } finally {
      checking = false;
    }
  }, o.intervalMs);
  t.unref();
  return t;
}
