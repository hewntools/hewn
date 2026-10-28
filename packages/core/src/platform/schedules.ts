// SPDX-License-Identifier: AGPL-3.0-or-later
// Schedules: an operation on a timetable, proposed by agents or set by the owner (also with a build),
// and running the ones due. Cadences and the store are ../schedules.ts.
import { type Agent, canSee, requireOwner, requireScope, USER, WEB_USER } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { compileSchema, connectOperation, opKey, schemaErrors } from "../manifest.ts";
import type { BuildRow } from "../registry.ts";
import { checkCadence, MAX_FAILURES, nextRun, type Schedule, toCron, parseCron } from "../schedules.ts";
import { resolveOperation, inputMismatch } from "./invocation.ts";
import { Domain, type Shared } from "./context.ts";
import type { PlatformOptions } from "../platform.ts";

export class Schedules extends Domain {
  private onSchedulesChanged: () => void;

  constructor(s: Shared, opts: Pick<PlatformOptions, "onSchedulesChanged">) {
    super(s);
    this.onSchedulesChanged = opts.onSchedulesChanged ?? (() => {});
  }

  /** Schedules of the capabilities this principal can see (all of them for the owner). */
  listSchedules(agent: Agent, capabilityId?: string): Schedule[] {
    requireScope(agent, "discover");
    return this.schedules.list(capabilityId).filter((s) => canSee(agent, s.capabilityId) && this.registry.getCapability(s.capabilityId)?.activeVersion);
  }

  private scheduledOperation(capabilityId: string, operation: string, operationVersion?: number) {
    const m = this.activeManifest(capabilityId);
    const op = resolveOperation(m, operation, operationVersion);
    if (op.name === "connect" && connectOperation(m)) throw new PlatformError("invalid_request", "connect is the owner's sign-in step; it can't be scheduled");
    if (op.sideEffect === "destructive") throw new PlatformError("invalid_request", `${opKey(op.name, op.version)} is destructive; only read and write operations can be scheduled`);
    return op;
  }

  private newSchedule(by: Agent, req: { capabilityId: string; operation: string; operationVersion?: number; input?: unknown; cadence: string; note?: string }, status: "proposed" | "active"): Schedule {
    this.visibleActive(by, req.capabilityId);
    const op = this.scheduledOperation(req.capabilityId, req.operation, req.operationVersion);
    const input = req.input ?? {};
    const checkIn = compileSchema(op.inputSchema);
    if (!checkIn(input)) throw inputMismatch(opKey(op.name, op.version), schemaErrors(checkIn));
    const timezone = this.platform.timezone();
    const cron = checkCadence(req.cadence, timezone);
    const id = `sch-${crypto.randomUUID().slice(0, 8)}`;
    this.schedules.insert({
      id,
      capabilityId: req.capabilityId,
      operation: op.name,
      operationVersion: op.version,
      input,
      cadence: req.cadence.trim(),
      timezone,
      status,
      createdBy: by.id,
      createdAt: new Date().toISOString(),
      nextRunAt: status === "active" ? nextRun(cron, timezone, Date.now()) : null,
      note: req.note?.slice(0, 500) ?? null,
    });
    this.registry.addLifecycleEvent(req.capabilityId, "schedule", `${status === "active" ? "created" : "proposed"} ${id}: ${opKey(op.name, op.version)} ${req.cadence.trim()}`, by.id);
    this.logger(`schedule ${id} ${status} for ${req.capabilityId} ${opKey(op.name, op.version)} (${req.cadence.trim()}) by ${by.id}`);
    this.onSchedulesChanged();
    return this.schedules.get(id)!;
  }

  /** The owner schedules an operation: it is active at once. */
  createSchedule(owner: Agent, req: { capabilityId: string; operation: string; operationVersion?: number; input?: unknown; cadence: string }): Schedule {
    requireOwner(owner);
    return this.newSchedule(owner, req, "active");
  }

  /** Agents may propose a schedule; it runs only once the owner enables it. */
  proposeSchedule(agent: Agent, req: { capabilityId: string; operation: string; operationVersion?: number; input?: unknown; cadence: string; note?: string }): Schedule {
    requireScope(agent, "invoke");
    return this.newSchedule(agent, req, "proposed");
  }

  /** Owner: enable (a proposal, or a paused schedule), pause, or change cadence/input. */
  updateSchedule(owner: Agent, id: string, change: { status?: "active" | "paused"; cadence?: string; input?: unknown }): Schedule {
    requireOwner(owner);
    const s = this.schedules.get(id);
    if (!s) throw new PlatformError("not_found", `no schedule '${id}'`);
    const cadence = change.cadence?.trim() ?? s.cadence;
    const timezone = this.platform.timezone();
    const cron = checkCadence(cadence, timezone);
    const status = change.status ?? s.status;
    if (change.input !== undefined) {
      const op = this.scheduledOperation(s.capabilityId, s.operation, s.operationVersion);
      const checkIn = compileSchema(op.inputSchema);
      if (!checkIn(change.input)) throw new PlatformError("invalid_input", "input does not match the operation's inputSchema", schemaErrors(checkIn));
    }
    this.schedules.update(id, {
      cadence,
      timezone,
      status,
      ...(change.input !== undefined ? { input: change.input } : {}),
      ...(status === "active" ? { nextRunAt: nextRun(cron, timezone, Date.now()), failures: 0, pausedReason: null } : { nextRunAt: null }),
    });
    if (change.status && change.status !== s.status) this.registry.addLifecycleEvent(s.capabilityId, "schedule", `${change.status === "active" ? (s.status === "proposed" ? "enabled" : "resumed") : "paused"} ${id}`, owner.id);
    this.onSchedulesChanged();
    return this.schedules.get(id)!;
  }

  deleteSchedule(owner: Agent, id: string) {
    requireOwner(owner);
    const s = this.schedules.get(id);
    if (!s) throw new PlatformError("not_found", `no schedule '${id}'`);
    this.schedules.delete(id);
    this.registry.addLifecycleEvent(s.capabilityId, "schedule", `deleted ${id}`, owner.id);
    this.onSchedulesChanged();
  }

  /** When the next active schedule is due (epoch ms), for the host's timer. */
  nextScheduleAt(): number | null {
    return this.schedules.nextAt();
  }

  /**
   * Run every active schedule that is due. Each runs as `schedule:<id>`: the one operation, on
   * the one capability. A missed time (host was off) runs once, then the next is computed from now.
   * Repeated failures pause the schedule.
   */
  async runDueSchedules(now = Date.now()): Promise<{ id: string; ok: boolean }[]> {
    const ran: { id: string; ok: boolean }[] = [];
    for (const s of this.schedules.due(now)) {
      const cron = parseCron(toCron(s.cadence));
      // Claim the slot first, so a slow run can't be started twice.
      this.schedules.update(s.id, { nextRunAt: nextRun(cron, s.timezone, Math.max(now, Date.now())) });
      const outcome = await this.runOnce(s);
      const ok = outcome === "ok";
      const failures = ok ? 0 : s.failures + 1;
      const pause = failures >= MAX_FAILURES;
      this.schedules.update(s.id, {
        lastRunAt: new Date().toISOString(),
        lastOutcome: outcome,
        failures,
        ...(pause ? { status: "paused" as const, nextRunAt: null, pausedReason: `paused after ${failures} failures in a row; last: ${outcome}` } : {}),
      });
      if (pause) {
        this.registry.addLifecycleEvent(s.capabilityId, "schedule", `paused ${s.id} after ${failures} failures`, `schedule:${s.id}`);
        this.logger(`schedule ${s.id} paused after ${failures} failures: ${outcome}`);
      }
      ran.push({ id: s.id, ok });
    }
    if (ran.length) this.onSchedulesChanged();
    return ran;
  }

  /** One run of a schedule, as itself (`schedule:<id>`: the one operation, on the one capability): "ok" or what went wrong. */
  private async runOnce(s: Schedule): Promise<string> {
    const principal: Agent = { id: `schedule:${s.id}`, kind: "schedule", scopes: new Set(["invoke"]), capabilities: new Set([s.capabilityId]) };
    try {
      this.scheduledOperation(s.capabilityId, s.operation, s.operationVersion);
      await this.platform.invoke(principal, { capabilityId: s.capabilityId, operation: s.operation, operationVersion: s.operationVersion, input: s.input });
      return "ok";
    } catch (e) {
      const err = e as PlatformError;
      return `${err.code ?? "error"}: ${err.message}`.slice(0, 300);
    }
  }

  /**
   * Run one schedule now (owner only): Try again after a failure, or check a fix. It runs as the
   * schedule does and its last run is this one; a success clears its failures, a failure doesn't
   * count toward pausing it (only its own runs do). Its next time stays as it was. One paused after
   * failing stays paused (the owner resumes it), but a success clears why: it's paused, no more.
   */
  async runScheduleNow(owner: Agent, id: string): Promise<{ ok: boolean; outcome: string }> {
    requireOwner(owner);
    const s = this.schedules.get(id);
    if (!s) throw new PlatformError("not_found", `no schedule '${id}'`);
    if (s.status === "proposed") throw new PlatformError("invalid_request", "enable the schedule before running it");
    const outcome = await this.runOnce(s);
    const ok = outcome === "ok";
    this.schedules.update(s.id, { lastRunAt: new Date().toISOString(), lastOutcome: outcome, ...(ok ? { failures: 0, pausedReason: null } : {}) });
    this.logger(`schedule ${s.id} run now by ${owner.id}: ${outcome}`);
    this.onSchedulesChanged();
    return { ok, outcome };
  }

  /**
   * Schedules the owner approved with a build (on the intake's card): the owner's own, so only the
   * owner may attach them; agents propose schedules instead. Checked now, created on promotion.
   */
  checkApprovedSchedules(agent: Agent, schedules: unknown) {
    if (schedules === undefined) return;
    requireOwner(agent);
    if (!Array.isArray(schedules) || schedules.length > MAX_APPROVED_SCHEDULES) throw new PlatformError("invalid_request", `schedules: a list of at most ${MAX_APPROVED_SCHEDULES}`);
    for (const x of schedules) {
      if (!x || typeof x.operation !== "string" || !x.operation || typeof x.cadence !== "string") throw new PlatformError("invalid_request", "each schedule needs an operation and a cadence");
      checkCadence(x.cadence, this.platform.timezone());
    }
  }

  /** After a promotion: set up the schedules the owner approved with the build. One that no longer fits is skipped, never failing the build. */
  applyApprovedSchedules(build: BuildRow, step: (message: string) => void) {
    const schedules = (build.request as { schedules?: ApprovedSchedule[] }).schedules ?? [];
    const owner = build.requestedBy === USER.id ? USER : build.requestedBy === WEB_USER.id ? WEB_USER : undefined;
    if (!schedules.length || !owner) return;
    const existing = this.listSchedules(owner, build.capabilityId);
    for (const x of schedules) {
      const name = x.operation.split("@")[0];
      if (existing.some((e) => e.operation === name && e.cadence === x.cadence.trim() && e.status !== "proposed")) continue;
      try {
        const sch = this.createSchedule(owner, { capabilityId: build.capabilityId, operation: name, cadence: x.cadence });
        step(`schedule ${sch.id} set: ${name} ${sch.cadence}`);
      } catch (e) {
        step(`schedule skipped (${name} ${x.cadence}): ${(e as Error).message}`);
      }
    }
  }
}

/** A schedule the owner approved together with a build: an operation (name) and a cadence. */
export interface ApprovedSchedule {
  operation: string;
  cadence: string;
}
const MAX_APPROVED_SCHEDULES = 5;
