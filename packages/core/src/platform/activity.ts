// SPDX-License-Identifier: AGPL-3.0-or-later
// Activity: what the owner and their agents are doing, for the idle report a host reads before it
// suspends Hewn (the supervisor's idle.ts). Times only, never what was called or by whom. A host's
// own traffic never reaches here: the surface counts requests, the invocation counts calls.
import type { Registry } from "../registry.ts";

const CHANGED_KEY = "activity:changedAt";

/** A snapshot for the idle report (epoch ms, or null for never since Hewn started). */
export interface ActivityView {
  startedAt: number;
  lastRequestAt: number | null;
  /** Now while a tool call runs. */
  lastCallAt: number | null;
  /** The newest write of any stream. */
  lastStreamAt: number | null;
  /** The newest write of a stream still open (null when none is open). */
  openStreamAt: number | null;
  intakes: number;
  lastIntakeAt: number | null;
  building: boolean;
  lastBuildAt: number | null;
  /** The last change worth a backup (kept across restarts). */
  changedAt: number | null;
  nextAlarmAt: number | null;
}

export class Activity {
  readonly startedAt = Date.now();
  private lastRequestAt: number | null = null;
  private lastCallAt: number | null = null;
  private calls = 0;
  private lastStreamAt: number | null = null;
  private streams = new Map<symbol, number | null>();
  private intakes = 0;
  private lastIntakeAt: number | null = null;
  private lastBuildAt: number | null = null;
  private registry: Registry;

  constructor(registry: Registry) {
    this.registry = registry;
  }

  /** A request from the owner or an agent was answered. */
  request() {
    this.lastRequestAt = Date.now();
  }

  /** A tool call starts; the returned function ends it. */
  call(): () => void {
    this.calls++;
    this.lastCallAt = Date.now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.calls--;
      this.lastCallAt = Date.now();
    };
  }

  /** Something changed that a backup should keep: a write, a promote, a restore, a setting. */
  changed() {
    try {
      this.registry.setKv(CHANGED_KEY, Date.now());
    } catch {
      // never breaks what changed
    }
  }

  /** A response stream opened: `write` on every chunk, `close` when it ends. */
  stream(): { write: () => void; close: () => void } {
    const key = Symbol();
    this.streams.set(key, null);
    return {
      write: () => {
        const now = Date.now();
        this.lastStreamAt = now;
        if (this.streams.has(key)) this.streams.set(key, now);
      },
      close: () => void this.streams.delete(key),
    };
  }

  /** An intake turn starts (the owner talking to it, or a reading); the returned function ends it. */
  intake(): () => void {
    this.intakes++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.intakes--;
      this.lastIntakeAt = Date.now();
    };
  }

  /** A build finished, failed, paused or was cancelled. */
  buildEnded() {
    this.lastBuildAt = Date.now();
  }

  view(o: { building: boolean; nextAlarmAt: number | null }): ActivityView {
    const open = [...this.streams.values()].filter((t): t is number => t !== null);
    return {
      startedAt: this.startedAt,
      lastRequestAt: this.lastRequestAt,
      lastCallAt: this.calls > 0 ? Date.now() : this.lastCallAt,
      lastStreamAt: this.lastStreamAt,
      openStreamAt: open.length ? Math.max(...open) : null,
      intakes: this.intakes,
      lastIntakeAt: this.lastIntakeAt,
      building: o.building,
      lastBuildAt: this.lastBuildAt,
      changedAt: this.registry.getKv<number>(CHANGED_KEY) ?? null,
      nextAlarmAt: o.nextAlarmAt,
    };
  }
}
