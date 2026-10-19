// SPDX-License-Identifier: AGPL-3.0-or-later
// One deadline per call chain (the outermost call's). Code time counts against it; time spent
// waiting on the model port is added back, up to MODEL_WAIT_MS per chain, so a slow
// generation doesn't eat the code's 30 s, and a slow provider can't hold a chain open for long.

/** Model waiting a chain may add back to its deadline, in total. */
export const MODEL_WAIT_MS = 120_000;

export class Deadline {
  /** Epoch ms by which the chain must finish, not counting a model wait in progress. */
  at: number;
  /** Model waiting this chain may still add back. */
  modelLeftMs: number;
  private waiting = 0;
  private since = 0;

  constructor(at: number, modelLeftMs = MODEL_WAIT_MS) {
    this.at = at;
    this.modelLeftMs = modelLeftMs;
  }

  /** A model call starts: the clock pauses (overlapping calls pause it once). */
  beginWait(now = Date.now()) {
    if (this.waiting++ === 0) this.since = now;
  }

  /** A model call ended: the paused time is added back, capped by what the chain has left. */
  endWait(now = Date.now()) {
    if (this.waiting === 0 || --this.waiting > 0) return;
    const add = Math.min(now - this.since, this.modelLeftMs);
    this.modelLeftMs -= add;
    this.at += add;
  }

  /** Ms until the chain expires, counting a model wait in progress as paused (up to the allowance). */
  remaining(now = Date.now()) {
    const paused = this.waiting ? Math.min(now - this.since, this.modelLeftMs) : 0;
    return this.at + paused - now;
  }

  /** The longest one model call may take: the code's remaining time plus the unspent allowance. */
  modelBudget(now = Date.now()) {
    return Math.max(0, this.at - now + this.modelLeftMs);
  }
}

export const deadlineOf = (d: Deadline | number | undefined, fallbackMs: number): Deadline =>
  d instanceof Deadline ? d : new Deadline(d ?? Date.now() + fallbackMs);

/**
 * A promise that rejects with `error()` once the deadline passes. It re-checks when it fires, so a
 * deadline extended in the meantime keeps the call alive. `clear()` stops it.
 */
export function deadlineTimer(d: Deadline, error: () => Error): { expired: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const expired = new Promise<never>((_, reject) => {
    const arm = () => {
      if (stopped) return;
      const ms = d.remaining();
      if (ms <= 0) return reject(error());
      timer = setTimeout(arm, ms);
    };
    arm();
  });
  return {
    expired,
    clear: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
