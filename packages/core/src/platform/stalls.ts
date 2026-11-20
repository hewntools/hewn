// SPDX-License-Identifier: AGPL-3.0-or-later
// Stalls: tool code that kept Hewn's tools from responding. Code that never yields can't be stopped
// from inside the host (one thread runs every tool): the host's watchdog restarts the tools. To say
// which tool did it, whatever runs tool code (a call, a build's tests) is written down while it runs;
// when the tools stop responding, what's written down is running then. A tool whose code may have held
// them (the host rules out what was waiting, when it can) is told so in its log and in Activity, and one
// that does it 3 times within an hour is suspended until the owner resumes it. A build whose own code
// did it fails, and isn't retried.
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { Domain } from "./context.ts";

/** The rule: a call may not work longer than this without a pause. The host's watchdog restarts the tools after it. */
export const STALL_MS = 10_000;
/** Stalls within STALL_WINDOW_MS that suspend a tool. */
export const STALLS_TO_SUSPEND = 3;
export const STALL_WINDOW_MS = 3600_000;

/** Why a tool can't run until the owner resumes it. */
export interface Suspension {
  at: string;
  reason: string;
}

/** A stall a tool was in: when, and which of its operations was running. */
type Stall = { at: string; what?: string };
/**
 * The stalls a tool was in (within the window), and its suspension. Records written before 0.4.12 have `at` only
 * (the times): read as stalls without `what`.
 */
type StallRecord = { stalls?: Stall[]; at?: string[]; suspended?: Suspension };
const stallsOf = (rec: StallRecord): Stall[] => rec.stalls ?? (rec.at ?? []).map((at) => ({ at }));

/** What a call was doing when the tools stopped responding, as far as the host can see. */
export type Doing = "running" | "waiting on a fetch" | "waiting on Hewn" | "queued";

/**
 * The host's word on a piece of tool code that was running when the tools stopped responding: what it was doing, and
 * whether it may be what held them (`caused`; every one is, when the host can't tell).
 */
export type StallRole = (running: { capabilityId: string; state: string }) => { caused: boolean; doing: Doing };

/** The last stall told (not under `stalls:`, where a tool's id could be "last"). */
const LAST_STALL = "stall:last";
const key = (capabilityId: string) => `stalls:${capabilityId}`;
/** The build a scratch state is for ("test:<build>", "sample:<build>" …). */
const BUILD_STATE = /^(?:test|visual|dryrun|sample|real):(.+)$/;

export class Stalls extends Domain {
  /** Run tool code, written down while it runs. `state`: "" for the tool's own data, else the scratch state's name. */
  async running<T>(c: { capabilityId: string; state: string; what: string; caller: string }, run: () => Promise<T>): Promise<T> {
    let id: string | undefined;
    try {
      id = this.registry.codeStarted(c);
    } catch {
      // never stops the code from running
    }
    try {
      return await run();
    } finally {
      if (id)
        try {
          this.registry.codeEnded(id);
        } catch {
          // as above
        }
    }
  }

  /**
   * `stalledAt`: when the host's watchdog found the tools not responding, before it restarts them; what is
   * running is told so, or only what `caused` says may have held them (the rest was waiting, and fails as it
   * goes). Unset: once at start, before interrupted builds are retried; what was written down only goes.
   */
  recover(stalledAt?: string, role?: StallRole): { tools: string[]; suspended: string[]; builds: string[] } {
    const left = this.registry.takeRunningCode();
    const out = { tools: [] as string[], suspended: [] as string[], builds: [] as string[] };
    // A restart of a restart (or the platform started again in the same process) says the same stall again.
    if (!stalledAt || this.registry.getKv<string>(LAST_STALL) === stalledAt) return out;
    this.registry.setKv(LAST_STALL, stalledAt);
    if (!left.length) this.logger(`Hewn's tools stopped responding and were restarted (${stalledAt}); no tool code was running`);
    // Each tool counts the stall once, however many of its calls were running: what of it is named.
    const struck = new Map<string, string>();
    for (const r of left) {
      const part = role?.(r);
      // Activity names every tool there, with what it was doing ("spin@1 — waiting on a fetch"), so a pattern can be seen.
      const detail = part && part.doing !== "running" ? `${r.what} — ${part.doing}` : r.what;
      if (part && !part.caused) {
        this.logger(`${r.capabilityId} (${r.what}, called by ${r.caller}) was ${part.doing} when Hewn's tools stopped responding: not the cause`);
        if (!r.state && this.registry.getCapability(r.capabilityId)) this.registry.addLifecycleEvent(r.capabilityId, "held-up", detail, "hewn");
        continue;
      }
      const build = BUILD_STATE.exec(r.state)?.[1];
      if (build) {
        this.stalledBuild(build, r.what, r.caller);
        if (!out.builds.includes(build)) out.builds.push(build);
      } else if (!r.state && this.registry.getCapability(r.capabilityId)) {
        // Its call's entry in the tool's log, as an ended call's would be.
        const ms = Math.max(0, Date.parse(stalledAt) - Date.parse(r.startedAt));
        this.registry.addCapabilityLog(r.capabilityId, r.startedAt, `${r.startedAt} ${r.caller} ${r.what} ERROR stalled: Hewn's tools stopped responding while this ran and were restarted ${ms}ms`, []);
        this.registry.addLifecycleEvent(r.capabilityId, "stalled", detail, "hewn");
        this.logger(`${r.capabilityId} (${r.what}, called by ${r.caller}) was running when Hewn's tools stopped responding`);
        if (!out.tools.includes(r.capabilityId)) out.tools.push(r.capabilityId);
        if (!struck.has(r.capabilityId)) struck.set(r.capabilityId, r.what);
      }
    }
    for (const [id, what] of struck) if (this.strike(id, stalledAt, what)) out.suspended.push(id);
    return out;
  }

  /** One more stall for a tool (`what` of it was running): true when that suspends it. */
  private strike(capabilityId: string, at: string, what: string): boolean {
    const old = this.registry.getKv<StallRecord>(key(capabilityId)) ?? {};
    const since = Date.parse(at) - STALL_WINDOW_MS;
    const stalls = [...stallsOf(old).filter((s) => Date.parse(s.at) > since), { at, what }];
    const rec: StallRecord = { stalls, ...(old.suspended ? { suspended: old.suspended } : {}) };
    const suspend = !rec.suspended && stalls.length >= STALLS_TO_SUSPEND;
    if (suspend) {
      // Which stalls: the owner can see whether it was the same code each time.
      const which = stalls.map((s) => `${s.what ? `${s.what} at ` : ""}${this.clock(s.at)}`).join(", ");
      rec.suspended = { at, reason: `it kept Hewn's tools from responding ${stalls.length} times within an hour (${which})` };
      this.registry.addLifecycleEvent(capabilityId, "suspend", rec.suspended.reason, "hewn");
      this.logger(`${capabilityId} suspended: ${rec.suspended.reason}; its calls, schedules and widgets are refused until the owner resumes it`);
    }
    this.registry.setKv(key(capabilityId), rec);
    return suspend;
  }

  /** "14:05", in the owner's time zone. */
  private clock(iso: string): string {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: this.platform.timezone(), hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    } catch {
      return iso.slice(11, 16);
    }
  }

  /**
   * A build's own code was running when Hewn stalled: it fails as it is (no retry, which would only do it again), naming
   * the operation and, where validation said it (`caller` "on test '…'", "in the visual check"), what it was running on.
   */
  private stalledBuild(buildId: string, what: string, caller: string) {
    const b = this.registry.getBuild(buildId);
    if (!b || !["building", "validating"].includes(b.status)) return;
    const rule = `worked for more than ${STALL_MS / 1000} seconds without a pause`;
    const where = /^(on|in) /.test(caller) ? `, ${caller}` : "";
    const line = what === "load" ? `its code ${rule} while loading` : `${what} ${rule}${where}`;
    this.registry.updateBuild(buildId, { status: "failed", log: [...b.log, `FAILED: ${line}, so Hewn's tools were restarted; not retried`] });
    this.logger(`build ${buildId} failed: its code kept Hewn's tools from responding (${what})`);
    // What's left of its run (the rest of its tests, another attempt) stops here.
    this.d.builds.stopStalled(buildId);
  }

  /** Set while the tool is suspended. */
  suspension(capabilityId: string): Suspension | undefined {
    return this.registry.getKv<StallRecord>(key(capabilityId))?.suspended;
  }

  /** The owner lets a suspended tool run again; its count of stalls starts over. */
  resume(owner: Agent, capabilityId: string) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    if (!this.suspension(capabilityId)) throw new PlatformError("conflict", `${capabilityId} isn't suspended`);
    this.registry.setKv(key(capabilityId), { stalls: [] });
    this.registry.addLifecycleEvent(capabilityId, "resume", "", owner.id);
    this.logger(`${capabilityId} resumed by ${owner.id}`);
  }
}
