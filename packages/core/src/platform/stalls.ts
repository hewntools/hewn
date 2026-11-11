// SPDX-License-Identifier: AGPL-3.0-or-later
// Stalls: tool code that kept Hewn from responding. Code that never yields can't be stopped from
// inside the host (one thread runs every tool and Hewn itself): the host's watchdog restarts it. To
// say which tool did it, whatever runs tool code (a call, a build's tests) is written down while it
// runs; after a restart for a stall, what's still written down was running then. A tool that was is
// told so in its log and in Activity, and one that does it 3 times within an hour is suspended until
// the owner resumes it. A build whose own code did it fails, and isn't retried.
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { Domain } from "./context.ts";

/** Stalls within STALL_WINDOW_MS that suspend a tool. */
export const STALLS_TO_SUSPEND = 3;
export const STALL_WINDOW_MS = 3600_000;

/** Why a tool can't run until the owner resumes it. */
export interface Suspension {
  at: string;
  reason: string;
}

/** The stalls a tool was running in (within the window), and its suspension. */
type StallRecord = { at: string[]; suspended?: Suspension };

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
   * Once at start, before interrupted builds are retried. `stalledAt`: when the host's watchdog
   * restarted Hewn because it had stopped responding (unset: Hewn ended some other way). What was
   * running then is told so; the rest of what was written down only goes.
   */
  recover(stalledAt?: string): { tools: string[]; suspended: string[]; builds: string[] } {
    const left = this.registry.takeRunningCode();
    const out = { tools: [] as string[], suspended: [] as string[], builds: [] as string[] };
    // A restart of a restart (or the platform started again in the same process) says the same stall again.
    if (!stalledAt || this.registry.getKv<string>(LAST_STALL) === stalledAt) return out;
    this.registry.setKv(LAST_STALL, stalledAt);
    if (!left.length) this.logger(`Hewn stopped responding and was restarted (${stalledAt}); no tool code was running`);
    for (const r of left) {
      const build = BUILD_STATE.exec(r.state)?.[1];
      if (build) {
        this.stalledBuild(build, r.what);
        if (!out.builds.includes(build)) out.builds.push(build);
      } else if (!r.state && this.registry.getCapability(r.capabilityId)) {
        // Its call's entry in the tool's log, as an ended call's would be.
        const ms = Math.max(0, Date.parse(stalledAt) - Date.parse(r.startedAt));
        this.registry.addCapabilityLog(r.capabilityId, r.startedAt, `${r.startedAt} ${r.caller} ${r.what} ERROR stalled: Hewn stopped responding while this ran and was restarted ${ms}ms`, []);
        this.registry.addLifecycleEvent(r.capabilityId, "stalled", r.what, "hewn");
        this.logger(`${r.capabilityId} (${r.what}, called by ${r.caller}) was running when Hewn stopped responding`);
        if (!out.tools.includes(r.capabilityId)) out.tools.push(r.capabilityId);
      }
    }
    // Each tool counts the stall once, however many of its calls were running.
    for (const id of out.tools) if (this.strike(id, stalledAt)) out.suspended.push(id);
    return out;
  }

  /** One more stall for a tool: true when that suspends it. */
  private strike(capabilityId: string, at: string): boolean {
    const rec = this.registry.getKv<StallRecord>(key(capabilityId)) ?? { at: [] };
    const since = Date.parse(at) - STALL_WINDOW_MS;
    rec.at = [...rec.at.filter((t) => Date.parse(t) > since), at];
    const suspend = !rec.suspended && rec.at.length >= STALLS_TO_SUSPEND;
    if (suspend) {
      rec.suspended = { at, reason: `it kept Hewn from responding ${rec.at.length} times within an hour` };
      this.registry.addLifecycleEvent(capabilityId, "suspend", rec.suspended.reason, "hewn");
      this.logger(`${capabilityId} suspended: ${rec.suspended.reason}; its calls, schedules and widgets are refused until the owner resumes it`);
    }
    this.registry.setKv(key(capabilityId), rec);
    return suspend;
  }

  /** A build's own code was running when Hewn stalled: it fails as it is (no retry, which would only do it again). */
  private stalledBuild(buildId: string, what: string) {
    const b = this.registry.getBuild(buildId);
    if (!b || !["building", "validating"].includes(b.status)) return;
    this.registry.updateBuild(buildId, { status: "failed", log: [...b.log, `FAILED: its code kept Hewn from responding (${what === "load" ? "loading it" : `running ${what}`}), so Hewn was restarted; not retried`] });
    this.logger(`build ${buildId} failed: its code kept Hewn from responding (${what})`);
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
    this.registry.setKv(key(capabilityId), { at: [] });
    this.registry.addLifecycleEvent(capabilityId, "resume", "", owner.id);
    this.logger(`${capabilityId} resumed by ${owner.id}`);
  }
}
