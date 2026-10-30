// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds: every change to a capability. Requests (create, modify, widgets, install), the order they
// run in, the builder's attempts with their live steps, retries and cancels, the owner's review, and
// what a build shows and keeps.
import { type Agent, canSee, requireOwner, requireScope, type Scope } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { type BuildFailure, explainFailure, testCounts } from "../failure.ts";
import { bytes, contentHash, decodeVersion, text, versionFiles } from "../files.ts";
import { cellsFromSvg, glyphSvg } from "../glyph.ts";
import type { BundleSummary } from "../bundle.ts";
import { ABI, type CapabilityManifest, DEFAULT_ABI, isConnection, type ToolSource } from "../manifest.ts";
import { saneCharge } from "../models.ts";
import { EFFORT, MODEL_NAME } from "../build-models.ts";
import type { BuildPass, Files } from "../ports.ts";
import { type Pass, PASS_TRIES, passRequest } from "../passes.ts";
import type { BuildContext, BuildFeedback, BuildKind, BuildModel, BuildReview, BuildRow, BuildTurn } from "../registry.ts";
import { sha256 } from "../sha256.ts";
import { MAX_SATURATION } from "./presentation.ts";
import { attachmentRefs } from "./attachments.ts";
import type { ApprovedSchedule } from "./schedules.ts";
import { Domain, type Shared } from "./context.ts";
import type { Candidate } from "./validation.ts";
import type { PlatformOptions } from "../platform.ts";
import spec from "@hewntools/spec/package.json" with { type: "json" };

export interface BuildView {
  buildId: string;
  capabilityId: string;
  kind: BuildKind;
  status: BuildRow["status"];
  request: Record<string, unknown>;
  requestedBy: string;
  /** The platform builder that implements it (never the requesting agent). */
  builder: string;
  log: string[];
  createdAt: string;
  /** Last status change (when it finished, for a finished build). */
  updatedAt: string;
  /** Liveness of a platform builder while it works. No transcript content (that would leak source). */
  progress?: BuildProgress;
  /** The version it produced, once promoted. */
  resultVersion?: number;
  /** A screenshot of its UI from validation exists (GET /api/builds/:id/screenshot). */
  screenshot?: boolean;
  /** Where the build is in its pipeline, while in flight. */
  step?: BuildStepState;
  /** Test cases of the latest validation. */
  tests?: { passed: number; total: number };
  /** Plain-language reason, when failed. */
  failure?: BuildFailure;
  /** The build this one waits for (status "waiting" until it promotes). */
  dependsOn?: string;
  /** Waiting its turn behind an earlier change to the same capability (starts when that one ends, however it ends). */
  queued?: boolean;
  /** Paused, and continued since: the build that carries it on (Continue and Stop are done with). */
  continuedAs?: string;
  /** Status "review": what the change would add; it goes live once the owner approves it. */
  review?: BuildReview;
  /** What it runs on: the model and effort (as asked for or set), and the model it ran on. */
  model?: BuildModel;
  /** What the builder's host charged for it, all attempts ("12 points"). Absent: no charge (a builder on the owner's own account). */
  charge?: { amount: number; unit: string };
  instructions?: string;
}

export interface BuildProgress {
  attempt: number;
  maxAttempts: number;
  elapsedSeconds: number;
  /** Latest builder action, one line (e.g. "→ Edit src/index.ts"). */
  lastActivity: string | null;
  secondsSinceActivity: number | null;
}

/**
 * Pipeline steps as the owner sees them: (waiting for another build →) spec agreed → writing code →
 * running tests → (a new tool's passes: reviewing the design → fixing details →) your authorization.
 */
export type BuildStep = "waiting" | "spec" | "code" | "tests" | Pass | "auth" | "done";

export interface BuildStepState {
  step: BuildStep;
  /** Of the latest validation: a pass's step has its own. */
  tests?: { passed: number; total: number };
  /** 0–1, from real milestones only: spec 0.1, code 0.1 (no measure), tests 0.5→0.9 by cases run, the passes 0.9, auth 0.95. */
  progress: number;
  /** The passes this build runs after its tests, in order (steps of their own). Absent: none. */
  passes?: Pass[];
}

type CreateRequest = {
  name: string;
  purpose: string;
  requirements: string;
  kind?: "capability" | "connection";
  /** The build it waited for. */
  after?: string;
  schedules?: ApprovedSchedule[];
  /** Installed from a file (or the hub; builder "bundle" only): where it came from, kept as the capability's record once it promotes. */
  source?: ToolSource;
  /** Replay its sample data once it's live (builder "bundle" only). */
  sample?: boolean;
  /** What the intake read in it before it was installed (Hewn's, or the owner's builder's). */
  summary?: BundleSummary;
} & ModelAsk &
  RetryMarks;

/** What only Hewn writes on a build's request, never its requester: the build it retries. */
type RetryMarks = { retryOf?: string; autoRetryOf?: string };

/** Builds that run at once (per Hewn, so per owner); more wait their turn. */
export const MAX_RUNNING_BUILDS = 5;

/** What a build may be asked to run on: a model name as the builder's CLI takes it, and an effort. */
export type ModelAsk = {
  /** An alias ("fable"), a full name, or "default" for the builder's own default. */
  model?: string;
  effort?: string;
};

const pickAsk = (o: ModelAsk): ModelAsk => ({ ...(o.model !== undefined ? { model: o.model } : {}), ...(o.effort !== undefined ? { effort: o.effort } : {}) });

/** The most turns a conversation kept with a build may have, and the longest turn. */
const MAX_TURNS = 200;
const MAX_TURN_CHARS = 50_000;
/** The longest note with the owner's answer to "Got what you asked for?". */
const MAX_FEEDBACK_NOTE = 1000;

/** One build in the feedback report (`hewn feedback`): what it ran on, how it ended, what the owner said, and the signs in the record. */
export interface BuildReportRow {
  buildId: string;
  capabilityId: string;
  kind: BuildKind;
  status: BuildRow["status"];
  createdAt: string;
  builder: string;
  model?: string;
  effort?: string;
  ranModel?: string;
  /** Which brief it ran on (a short hash). */
  brief?: string;
  attempts: number;
  /** Why it failed, when it did. */
  failure?: string;
  feedback?: BuildFeedback;
  /** What the record says: this build failed and a retry of it went live; another change to the tool within a day of this one going live; a restore to an earlier version within a week; the tool deleted within a day. */
  signals: { fixed: boolean; changedSoon: boolean; restored: boolean; deletedSoon: boolean };
}
/** The feedback report: the window it covers (days, as clamped) and the builds in it, newest first. */
export interface BuildReport {
  days: number;
  builds: BuildReportRow[];
}

/** The longest structured reply kept with an intake turn (as JSON). */
const MAX_REPLY_CHARS = 100_000;

export class Builds extends Domain {
  private buildModelFor: (builder: string) => { model?: string; effort?: string };
  private agentBuildModels?: (builder: string) => string[];
  private modelEfforts?: (builder: string, model: string) => Promise<string[] | undefined>;
  private slots = { busy: 0, queue: [] as (() => void)[] };
  private brief: string;
  /** Which brief builds run on, recorded with each build: the spec's version and a short hash of the brief's text. */
  private briefId: string;
  private designSystem?: () => Promise<string | undefined>;
  private running = new Map<string, Promise<void>>();
  /** Abort handles of in-flight builds (cancel). */
  private aborts = new Map<string, AbortController>();
  private progress = new Map<
    string,
    { attempt: number; maxAttempts: number; startedAt: number; lastActivity?: string; lastActivityAt?: number }
  >();
  /** Pipeline step of each in-flight build (see BuildStep). */
  private steps = new Map<string, { capabilityId: string; step: BuildStep; tests?: { passed: number; total: number }; since: number; passes?: Pass[] }>();

  constructor(s: Shared, opts: Pick<PlatformOptions, "brief" | "designSystem" | "buildModel" | "agentBuildModels" | "modelEfforts">) {
    super(s);
    this.brief = opts.brief;
    this.briefId = `${spec.version}+${sha256(opts.brief).slice(0, 12)}`;
    this.designSystem = opts.designSystem;
    this.buildModelFor = opts.buildModel ?? (() => ({}));
    this.agentBuildModels = opts.agentBuildModels;
    this.modelEfforts = opts.modelEfforts;
  }

  /**
   * Call once at start: builds left mid-flight by a previous process are failed, and started
   * again once (not a retry that was itself interrupted). The retry runs as the original
   * requester, with only the scope that request needed.
   */
  async recoverInterruptedBuilds(): Promise<string[]> {
    const retried: string[] = [];
    for (const id of this.registry.failInterruptedBuilds()) {
      this.logger(`build ${id} marked failed: interrupted by restart`);
      const b = this.mustBuild(id);
      // An install from a file has no builder to run again: the owner installs the file again.
      if (!b.builder || b.builder === "bundle" || (b.request as { autoRetryOf?: string }).autoRetryOf || !this.platform.builderFor()) continue;
      const owner = b.requestedBy === "web" || b.requestedBy === "user";
      const requester: Agent = { id: b.requestedBy, kind: owner ? "user" : "agent", scopes: new Set([scopeOf(b.kind)]), capabilities: "*" };
      try {
        const next = await this.retryBuild(requester, id, { auto: true });
        retried.push(next.buildId);
        this.logger(`build ${id} retried after restart as ${next.buildId}`);
      } catch (e) {
        this.logger(`build ${id} not retried: ${(e as Error).message}`);
      }
    }
    await this.resumeWaitingBuilds();
    return retried;
  }

  /** Waiting builds whose dependency ended (or was retried) while Hewn was down: start, fail or re-point them. */
  private async resumeWaitingBuilds() {
    for (const b of this.registry.waitingBuilds()) {
      const dep = this.currentBuild(b.dependsOn!);
      if (dep.id !== b.dependsOn) this.registry.updateBuild(b.id, { dependsOn: dep.id });
      this.setStep(b.id, b.capabilityId, "waiting");
      if (["promoted", "failed", "cancelled", "review"].includes(dep.status)) await this.releaseDependents(dep.id);
    }
  }

  /** Log a build event to the platform log and the build's transcript (what `hewn watch` follows). */
  private buildEvent(buildId: string, message: string, tag: string) {
    this.logger(`${tag} ${message}`);
    this.events.emit(buildId, `[platform] ${message}`);
    // The transcript is best-effort.
    this.workbench.note(buildId, `${new Date().toTimeString().slice(0, 8)} [platform] ${message}`).catch(() => {});
  }

  /**
   * Follow a build live: `onEvent` receives each builder activity line and platform step.
   * Resolves with the build view when it is promoted or failed, or when `timeoutMs` / `signal` ends the wait.
   */
  async waitForBuild(
    agent: Agent,
    buildId: string,
    opts: { timeoutMs: number; onEvent?: (line: string) => void; onStep?: (step: BuildStepState) => void; signal?: AbortSignal },
  ): Promise<BuildView & { waitTimedOut?: boolean }> {
    const view = this.getBuild(agent, buildId);
    if (!this.running.has(buildId) && view.status !== "waiting") return view;
    const onEvent = opts.onEvent ?? (() => {});
    const onStep = opts.onStep ?? (() => {});
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.events.off(buildId, onEvent);
        this.events.off(`${buildId}:step`, onStep);
        this.events.off(`${buildId}:done`, finish);
        opts.signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(() => ((timedOut = true), finish()), opts.timeoutMs);
      this.events.on(buildId, onEvent);
      this.events.on(`${buildId}:step`, onStep);
      this.events.once(`${buildId}:done`, finish);
      opts.signal?.addEventListener("abort", finish);
    });
    const final = this.getBuild(agent, buildId);
    return timedOut ? { ...final, waitTimedOut: true } : final;
  }

  /** Resolves when every in-flight build has finished. */
  async drain(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  /** Resolves when a build has finished (promoted, failed or cancelled). */
  async settle(buildId: string): Promise<BuildView> {
    // Waiting, or started and still opening its workspace (its builder not running yet).
    const before = (s: BuildRow["status"]) => s === "waiting" || s === "open";
    while (before(this.mustBuild(buildId).status) && !this.running.has(buildId)) await new Promise((r) => this.events.once(`${buildId}:state`, r));
    await this.running.get(buildId);
    return this.buildView(this.mustBuild(buildId));
  }

  isRunning(buildId: string): boolean {
    return this.running.has(buildId);
  }

  private setStep(buildId: string, capabilityId: string, step: BuildStep, tests?: { passed: number; total: number }) {
    const passes = this.steps.get(buildId)?.passes;
    this.steps.set(buildId, { capabilityId, step, tests, since: Date.now(), ...(passes ? { passes } : {}) });
    this.events.emit(`${buildId}:step`, this.stepState(buildId));
  }

  stepState(buildId: string): BuildStepState | undefined {
    const s = this.steps.get(buildId);
    if (!s) return undefined;
    const progress = {
      waiting: 0,
      spec: 0.1,
      // No honest measure of how far the code is: it stays at the spec mark until tests start.
      code: 0.1,
      tests: 0.5 + 0.4 * (s.tests && s.tests.total ? s.tests.passed / s.tests.total : 0),
      // Tested already; no honest measure of how far a pass is.
      critique: 0.9,
      craft: 0.9,
      auth: 0.95,
      done: 1,
    }[s.step];
    return { step: s.step, ...(s.tests ? { tests: s.tests } : {}), progress: Math.round(progress * 100) / 100, ...(s.passes ? { passes: s.passes } : {}) };
  }

  /**
   * The icon an in-flight build has written so far (builders write it first), re-rendered from its
   * cells so nothing else from the workspace is ever served; plus its hue and saturation if
   * capability.json has them.
   */
  async buildGlyph(buildId: string): Promise<{ svg: string; hue: number | null; saturation: number | null } | undefined> {
    const svg = await this.workbench.file(buildId, "ui/icon.svg").catch(() => undefined);
    if (!svg) return undefined;
    const cells = cellsFromSvg(text(svg));
    if (!cells) return undefined;
    let hue: number | null = null;
    let saturation: number | null = null;
    try {
      const m = JSON.parse(text(await this.workbench.file(buildId, "capability.json")));
      if (Number.isInteger(m.hue) && m.hue >= 0 && m.hue <= 359) hue = m.hue;
      if (Number.isInteger(m.saturation) && m.saturation >= 0 && m.saturation <= MAX_SATURATION) saturation = m.saturation;
    } catch {
      // not written yet
    }
    return { svg: glyphSvg(cells), hue, saturation };
  }

  /** In-flight builds, by capability (Home shows these as building tiles). */
  /** Builds in progress. `connection`: a new connection being created (it has no manifest yet). */
  activeBuilds(): { buildId: string; capabilityId: string; kind: BuildKind; name: string; purpose: string; connection: boolean; state: BuildStepState }[] {
    const out = [];
    for (const [buildId, s] of this.steps) {
      const b = this.registry.getBuild(buildId);
      if (!b || !(this.running.has(buildId) || b.status === "validating" || b.status === "waiting")) continue;
      const req = b.request as { name?: string; purpose?: string; kind?: string };
      out.push({ buildId, capabilityId: s.capabilityId, kind: b.kind, name: req.name ?? s.capabilityId, purpose: req.purpose ?? "", connection: b.kind === "create" && req.kind === "connection", state: this.stepState(buildId)! });
    }
    return out;
  }

  /**
   * A manifest-only change makes a new version at once: a change on its way would then fail at the
   * end ("capability changed since this build started"), so it waits until that one is done. So does
   * a paused change (its Continue carries on from work kept before it) until it's continued and done, or stopped.
   */
  noChangeOnItsWay(capabilityId: string, what: string) {
    const ahead = this.registry.unfinishedBuild(capabilityId);
    if (ahead) throw new PlatformError("conflict", `a change to ${capabilityId} is on its way (build ${ahead.id}); ${what} once it's done`);
    const paused = this.pausedBuild(capabilityId, "change");
    if (paused) throw new PlatformError("conflict", `a change to ${capabilityId} is paused (build ${paused.id}); ${what} once it's continued and done, or stopped`);
  }

  /**
   * Platform-internal: a new version with the active version's files and an edited manifest, run
   * through the normal validation and promotion, with no builder ("keep"). Never a way to change code.
   */
  async manifestOnlyModify(owner: Agent, capabilityId: string, edit: (m: CapabilityManifest) => void, request: string): Promise<BuildView> {
    const cap = this.registry.getCapability(capabilityId);
    if (!cap?.activeVersion || cap.archivedAt) throw new PlatformError("not_found", `${capabilityId} is not active`);
    const base = await this.loadVersion(cap.id, cap.activeVersion);
    const manifest = JSON.parse(text(base.files["capability.json"])) as CapabilityManifest;
    edit(manifest);
    const buildId = newBuildId();
    this.registry.insertBuild({ id: buildId, capabilityId, kind: "modify", request: { capabilityId, request, manifestOnly: true }, requestedBy: owner.id, baseVersion: cap.activeVersion, builder: "keep" });
    await this.workbench.open(buildId, { ...base.files, "capability.json": bytes(JSON.stringify(manifest, null, 2) + "\n") });
    this.buildEvent(buildId, `opened from v${cap.activeVersion}: manifest only (${request})`, `build ${buildId} [modify ${capabilityId} by ${owner.id}]`);
    this.setStep(buildId, capabilityId, "spec");
    this.startBuilder(buildId, "keep");
    return this.buildView(this.registry.getBuild(buildId)!);
  }

  /**
   * Platform-internal: a new version with the active version's files and `changes` (path →
   * contents), through the normal validation and promotion, no builder ("keep"). The owner's own
   * edit to a file that isn't code: sample data, written by hand.
   */
  async filesOnlyModify(owner: Agent, capabilityId: string, changes: Files, request: string): Promise<BuildView> {
    requireOwner(owner);
    const cap = this.registry.getCapability(capabilityId);
    if (!cap?.activeVersion || cap.archivedAt) throw new PlatformError("not_found", `${capabilityId} is not active`);
    this.noChangeOnItsWay(capabilityId, "write the sample data");
    const base = await this.loadVersion(cap.id, cap.activeVersion);
    const buildId = newBuildId();
    this.registry.insertBuild({ id: buildId, capabilityId, kind: "modify", request: { capabilityId, request, filesOnly: Object.keys(changes) }, requestedBy: owner.id, baseVersion: cap.activeVersion, builder: "keep" });
    await this.workbench.open(buildId, { ...base.files, ...changes });
    this.buildEvent(buildId, `opened from v${cap.activeVersion}: ${Object.keys(changes).join(", ")} (${request})`, `build ${buildId} [modify ${capabilityId} by ${owner.id}]`);
    this.setStep(buildId, capabilityId, "spec");
    this.startBuilder(buildId, "keep");
    return this.buildView(this.registry.getBuild(buildId)!);
  }

  // ---------- creation / modification ----------

  /**
   * `kind: "connection"` builds a connection (see the builder brief). `after`: a build to wait
   * for, e.g. the connection this capability will call; it starts once that one promotes.
   * `schedules`: the owner's approved schedules, set up once the build promotes (owner only).
   */
  async create(agent: Agent, req: { name: string; purpose: string; requirements: string; kind?: "capability" | "connection"; after?: string; widgets?: boolean; schedules?: ApprovedSchedule[]; conversation?: BuildTurn[] } & ModelAsk): Promise<BuildView & { widgetsBuildId?: string }> {
    await this.checkEffort(agent, req);
    const conversation = this.checkConversation(agent, req.conversation);
    this.d.schedules.checkApprovedSchedules(agent, req.schedules);
    if (req.widgets && req.kind === "connection") throw new PlatformError("invalid_request", "a connection has no widgets");
    const b = await this.createBuild(agent, req, conversation);
    if (!req.widgets) return b;
    // Widgets are their own build, chained after this one: a broken widget never blocks the capability.
    const w = await this.addWidgets(agent, { capabilityId: b.capabilityId, after: b.buildId, ...pickAsk(req), ...(conversation ? { conversation } : {}) });
    return { ...b, widgetsBuildId: w.buildId };
  }

  /** What a new build records: the brief it runs on, the owner's instructions as they are now, and the conversation (if the web client sent one). */
  private contextFor(capabilityId: string, conversation?: BuildTurn[]): BuildContext {
    const instructions = this.d.instructions.instructionsForBuild(capabilityId);
    return { brief: this.briefId, ...(instructions ? { instructions } : {}), ...(conversation ? { conversation } : {}) };
  }

  /** Record what a new build ran with, and keep the attachments its conversation carried. */
  private recordContext(buildId: string, capabilityId: string, conversation?: BuildTurn[]) {
    this.registry.setBuildContext(buildId, this.contextFor(capabilityId, conversation));
    if (conversation) this.registry.claimAttachments(attachmentRefs(conversation), buildId);
  }

  /**
   * The conversation the owner had with the intake, kept with the build (the web client sends it):
   * the owner's only; an agent's build carries its request instead. A turn's attachments are refs
   * into the owner's attachments; what they are comes from the store, not the client.
   */
  private checkConversation(agent: Agent, c: unknown): BuildTurn[] | undefined {
    if (c === undefined) return undefined;
    requireOwner(agent);
    if (!Array.isArray(c) || c.length > MAX_TURNS) throw new PlatformError("invalid_request", `conversation: a list of at most ${MAX_TURNS} turns`);
    return c.map((t) => {
      if (!t || (t.role !== "user" && t.role !== "intake") || typeof t.content !== "string" || t.content.length > MAX_TURN_CHARS) {
        throw new PlatformError("invalid_request", `each turn of the conversation needs a role ("user" or "intake") and content of at most ${MAX_TURN_CHARS} characters`);
      }
      const attachments = t.attachments === undefined ? undefined : this.d.attachments.resolveAttachments(t.attachments);
      // An intake turn may carry its structured reply, for showing the proposal as it was; kept as is, within reason.
      const reply = t.role === "intake" && t.reply && typeof t.reply === "object" && JSON.stringify(t.reply).length <= MAX_REPLY_CHARS ? t.reply : undefined;
      return { role: t.role, content: t.content, ...(attachments?.length ? { attachments } : {}), ...(reply ? { reply } : {}) };
    });
  }

  private async createBuild(agent: Agent, req: { name: string; purpose: string; requirements: string; kind?: "capability" | "connection"; after?: string; schedules?: ApprovedSchedule[] } & ModelAsk, conversation?: BuildTurn[]): Promise<BuildView> {
    requireScope(agent, "create");
    const id = slugify(req.name);
    if (!id) throw new PlatformError("invalid_request", "name must contain letters or digits");
    if (RESERVED_IDS.has(id)) throw new PlatformError("invalid_request", `'${id}' is reserved; choose another name`);
    const existing = this.registry.getCapability(id);
    if (existing?.archivedAt) throw new PlatformError("conflict", `'${id}' exists but is deleted (archived); the owner restores it in Hewn (Settings › Data › Deleted tools), or pick another id`);
    if (existing?.activeVersion) throw new PlatformError("conflict", `capability '${id}' already exists`);
    // A create that never promoted (it failed or was cancelled) keeps its id for a retry; a new
    // create of the same name takes it over instead (as `hewn install` does), unless one is being built.
    if (existing) this.oneCreateAtATime(agent, id);
    if (req.kind !== undefined && req.kind !== "capability" && req.kind !== "connection") throw new PlatformError("invalid_request", 'kind must be "capability" or "connection"');
    const dependsOn = this.dependency(agent, req.after);
    // What a create asks for, and nothing else: an agent's arguments arrive as it sent them, and
    // where a tool came from (`source`) or its sample data are Hewn's to write, on an install.
    const request: CreateRequest = {
      name: req.name,
      purpose: req.purpose,
      requirements: req.requirements,
      ...(req.kind !== undefined ? { kind: req.kind } : {}),
      ...(req.schedules !== undefined ? { schedules: req.schedules } : {}),
      ...pickAsk(req),
      ...(dependsOn ? { after: dependsOn } : {}),
    };
    return this.openCreateBuild(agent, id, request, !existing, undefined, undefined, dependsOn, conversation);
  }

  /**
   * One create of an id at a time: refused while another is waiting or being built, or paused with
   * its work kept (taking the id over would strand it). Not a widgets build chained after it (create
   * with widgets): that one waits for it.
   */
  private oneCreateAtATime(agent: Agent, id: string) {
    const building = this.registry.unfinishedBuild(id, { kind: "create" });
    if (building) throw new PlatformError("conflict", `'${id}' is already being built${this.buildRef(agent, building)}; wait for it, or cancel it`);
    const paused = this.pausedBuild(id, "create");
    if (paused) throw this.pausedFirst(agent, `'${id}'`, paused);
  }

  /** " (build …)" in a message to `agent`, if it may see that build; else nothing. */
  private buildRef(agent: Agent, b: BuildRow): string {
    return this.sees(agent, b) ? ` (build ${b.id})` : "";
  }

  /**
   * A paused build of the capability that nobody has continued or stopped: its create, or a change
   * (modify or widgets). It keeps its place, its work kept for the owner's Continue.
   */
  private pausedBuild(capabilityId: string, kind: "create" | "change"): BuildRow | undefined {
    return this.registry.failedBuilds(capabilityId, kind === "create" ? ["create"] : ["modify", "widgets"]).find((b) => isPaused(b) && !this.registry.retryOf(b.id));
  }

  /** Refused while `b` is paused: the owner continues or stops it in Hewn first. */
  private pausedFirst(agent: Agent, what: string, b: BuildRow): PlatformError {
    return new PlatformError("conflict", `${what} is paused${this.buildRef(agent, b)}: ${agent.kind === "user" ? "Continue or Stop it in Hewn first" : "the owner continues or stops it in Hewn first"}`);
  }

  /** The build a new one should wait for (`after`, following retries), or undefined to start now. */
  private dependency(agent: Agent, after?: string): string | undefined {
    if (!after) return undefined;
    requireScope(agent, "create", "modify");
    this.visibleBuild(agent, after);
    const dep = this.currentBuild(after);
    if (dep.status === "promoted") return undefined;
    if ((dep.status === "failed" || dep.status === "cancelled") && dep.kind === "create") {
      // A new create of the same name took its id over (createBuild): that one stands in for it, live
      // or on its way (waited for only by who may see it: its id is in the waiting build).
      if (this.registry.getCapability(dep.capabilityId)?.activeVersion) return undefined;
      const next = this.registry.unfinishedBuild(dep.capabilityId, { kind: "create" });
      if (next && this.sees(agent, next)) return next.id;
    }
    if (isPaused(dep)) throw new PlatformError("conflict", `build ${dep.id} (${dep.kind} ${dep.capabilityId}), which this would wait for, is paused; ${agent.kind === "user" ? "Continue it in Hewn" : "the owner continues it in Hewn"} first`);
    if (dep.status === "failed" || dep.status === "cancelled") throw new PlatformError("conflict", `build ${dep.id} (${dep.kind} ${dep.capabilityId}), which this would wait for, ${dep.status}; retry it first`);
    return dep.id;
  }

  /**
   * The build to queue a change behind: the newest unfinished one of the same capability, so two
   * changes never run at once (the second would fail at the end: "capability changed since this
   * build started"), or else a paused change nobody has continued or stopped (its Continue would
   * carry on from work kept before this one). A change waiting for the owner's review doesn't hold
   * others up. Not for an automatic retry, or the Continue of a paused build: it takes the place of
   * the build it retries, and what queued behind that one waits for it (`takePlace`).
   */
  private queueBehind(capabilityId: string, marks: RetryMarks): string | undefined {
    if (marks.autoRetryOf || this.continues(marks)) return undefined;
    return (this.registry.unfinishedBuild(capabilityId) ?? this.pausedBuild(capabilityId, "change"))?.id;
  }

  /** The paused build a retry continues (the owner's Continue), if it does. */
  private continues(marks: RetryMarks): string | undefined {
    return marks.retryOf && isPaused(this.mustBuild(marks.retryOf)) ? marks.retryOf : undefined;
  }

  /**
   * A Continue takes the paused build's place: what queued behind it waits for the new build now,
   * as after a restart (`resumeWaitingBuilds`). Called before the new build starts.
   */
  private takePlace(buildId: string, marks: RetryMarks) {
    const paused = this.continues(marks);
    if (paused) for (const w of this.registry.waitingBuilds(paused)) this.registry.updateBuild(w.id, { dependsOn: buildId });
  }

  /**
   * Changes to a capability on their way (queued or building), oldest first: a new
   * change lands after them, so whoever drafts it (the intake, an agent) builds on them.
   */
  changesComing(agent: Agent, capabilityId: string): { buildId: string; kind: BuildKind; status: BuildRow["status"]; request: string }[] {
    requireScope(agent, "modify");
    this.visibleActive(agent, capabilityId);
    return this.registry.pendingChanges(capabilityId).map((b) => ({ buildId: b.id, kind: b.kind, status: b.status, request: String(b.request.request ?? "") }));
  }

  /** Waiting its turn behind an earlier change to the same capability, not for a build it needs (`after`). */
  private queued(b: BuildRow): boolean {
    if (b.status !== "waiting" || !b.dependsOn) return false;
    const after = (b.request as { after?: string }).after;
    return !after || this.currentBuild(after).id !== b.dependsOn;
  }

  /** A build, or its newest retry if it was retried. */
  private currentBuild(buildId: string): BuildRow {
    let b = this.mustBuild(buildId);
    for (let next = this.registry.retryOf(b.id); next; next = this.registry.retryOf(b.id)) b = this.mustBuild(next);
    return b;
  }

  /**
   * A build ended: builds waiting for it start if it promoted, and fail otherwise (they can be
   * retried once it has been). A change queued behind it starts either way, and already when it
   * waits for the owner's review; not while it is paused (Stop releases it, a Continue takes it over).
   */
  private async releaseDependents(buildId: string) {
    const dep = this.registry.getBuild(buildId);
    if (!dep) return;
    const paused = isPaused(dep);
    for (const listed of this.registry.waitingBuilds(buildId)) {
      // Re-read: an earlier start awaited, and this one may have been cancelled meanwhile.
      const b = this.mustBuild(listed.id);
      if (b.status !== "waiting") continue;
      // Waiting for the owner's review: what needs it keeps waiting (approve or reject releases it).
      if (dep.status === "review" && !this.queued(b)) continue;
      // Paused: the change queued behind it keeps its turn.
      if (paused && this.queued(b)) continue;
      if (dep.status !== "promoted" && !this.queued(b)) {
        this.failBuild(b.id, `build ${buildId}, which it waited for, ${paused ? "paused; continue that one, then retry this one" : `${dep.status}; retry that one, then this one`}`);
        continue;
      }
      try {
        if (b.kind === "create") await this.startCreate(b.id);
        else await this.startModify(b.id);
      } catch (e) {
        this.failBuild(b.id, `couldn't start: ${(e as Error).message}`);
      }
    }
  }

  /** Fail a build that isn't running (a waiting one), and whatever waits for it. */
  private failBuild(buildId: string, message: string) {
    const b = this.mustBuild(buildId);
    this.registry.updateBuild(buildId, { status: "failed", log: [...b.log, `FAILED: ${message}`] });
    this.buildEvent(buildId, `FAILED: ${message}`, `build ${buildId} [${b.kind} ${b.capabilityId}]`);
    this.steps.delete(buildId);
    this.events.emit(`${buildId}:state`);
    this.events.emit(`${buildId}:done`);
    this.events.emit("changed");
    void this.releaseDependents(buildId);
  }

  /** Requests whose model was already accepted once (automatic retries): not checked against the agent's list again. */
  private trustedAsks = new WeakSet<object>();

  /**
   * The model and effort a new build runs with. Nothing asked: the owner's setting for this builder.
   * The owner may ask for any model; an agent only for one the owner ticked (Settings › AI), and
   * a name it may not use is an error listing the ones it may, never a quiet default.
   */
  private modelFor(agent: Agent, builder: string, ask: ModelAsk): { model?: string; effort?: string } {
    if (builder === "keep" || builder === "bundle" || builder.startsWith("copy:")) return {};
    const { model, effort } = ask;
    if (model === undefined && effort === undefined) return this.buildModelFor(builder);
    if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new PlatformError("invalid_request", "model must be a model name, like fable or claude-fable-5-1, or default");
    if (effort !== undefined && (typeof effort !== "string" || !EFFORT.test(effort))) throw new PlatformError("invalid_request", "effort must be a level such as low, medium or high");
    if (agent.kind !== "user" && model !== undefined && !this.trustedAsks.has(ask)) {
      const allowed = this.agentModelChoices(builder);
      if (!allowed.includes(model)) throw new PlatformError("invalid_request", `the owner doesn't let agents ask for '${model}' on this Hewn; you may ask for: ${allowed.join(", ")}`);
    }
    const chosen = model ?? this.buildModelFor(builder).model;
    return { ...(chosen && chosen !== "default" ? { model: chosen } : {}), ...(effort ? { effort } : {}) };
  }

  /**
   * An agent's effort, against the levels its model takes (the builder's model list, when the host
   * can read it): one it doesn't take is an error naming them. Before anything is reserved, so the
   * wait for the list can't let a second request in between. The owner's own asks aren't limited.
   */
  private async checkEffort(agent: Agent, ask: ModelAsk) {
    const builder = this.platform.builderFor();
    if (agent.kind === "user" || !this.modelEfforts || !builder || typeof ask.effort !== "string" || !EFFORT.test(ask.effort)) return;
    const model = typeof ask.model === "string" ? ask.model : this.buildModelFor(builder).model ?? "default";
    const levels = await this.modelEfforts(builder, model).catch(() => undefined);
    if (levels?.length && !levels.includes(ask.effort)) throw new PlatformError("invalid_request", `${model} doesn't take effort '${ask.effort}'; it takes: ${levels.join(", ")}`);
  }

  /** Model names agents may pass for builds by `builder` (default: the current builder). Always includes "default". */
  agentModelChoices(builder = this.platform.builderFor()): string[] {
    if (!builder) return ["default"];
    const allowed = this.agentBuildModels?.(builder) ?? [];
    return ["default", ...allowed.filter((m) => m !== "default")];
  }

  private requireBuilder(): string {
    const builder = this.platform.builderFor();
    if (!builder) throw new PlatformError("conflict", "no builder is configured (Settings → builder)");
    return builder;
  }

  /**
   * A create build for `id`: newly reserved, or reserved by a create that never promoted (a retry of
   * it, or a new create of the same name), which then shows this one's name and purpose.
   */
  private async openCreateBuild(agent: Agent, id: string, req: CreateRequest, reserve: boolean, builderOverride?: string, seed?: Files, dependsOn?: string, conversation?: BuildTurn[]): Promise<BuildView> {
    const builder = builderOverride ?? this.requireBuilder();
    const model = this.modelFor(agent, builder, req);
    const buildId = newBuildId();
    this.registry.transaction(() => {
      const reservation = { id, name: req.name, purpose: req.purpose, createdBy: agent.id };
      if (reserve) this.registry.insertCapability(reservation);
      else this.registry.takeOverCapability(reservation);
      this.registry.insertBuild({ id: buildId, capabilityId: id, kind: "create", request: req, requestedBy: agent.id, baseVersion: null, builder, dependsOn });
      this.registry.setBuildModel(buildId, model);
      this.recordContext(buildId, id, conversation);
    });
    if (dependsOn) this.waitFor(buildId, id, dependsOn, `build ${buildId} [create ${id} by ${agent.id}]`);
    else await this.startCreate(buildId, seed);
    return this.buildView(this.registry.getBuild(buildId)!);
  }

  private waitFor(buildId: string, capabilityId: string, dependsOn: string, tag: string, queued = false) {
    const dep = this.mustBuild(dependsOn);
    const when = isPaused(dep) ? ", which is paused; starts once it's continued and ends, or stopped" : "; starts when it ends";
    this.buildEvent(buildId, queued ? `waiting for build ${dependsOn}, the change to ${capabilityId} before it${when}` : `waiting for build ${dependsOn} (${dep.kind} ${dep.capabilityId}); starts when it promotes`, tag);
    this.setStep(buildId, capabilityId, "waiting");
  }

  /** Open a create build's workspace (skeleton, or seeded files) and start its builder. */
  private async startCreate(buildId: string, seed?: Files) {
    const b = this.mustBuild(buildId);
    // Started: no longer waiting (as in startModify).
    this.registry.updateBuild(buildId, { status: "open" });
    const req = b.request as unknown as CreateRequest;
    const id = b.capabilityId;
    const connection = req.kind === "connection";
    // kind is an ABI 2.1 field.
    const skeleton: CapabilityManifest = { id, name: req.name, purpose: req.purpose, abi: connection ? "2.1" : DEFAULT_ABI, ...(connection ? { kind: "connection" as const } : {}), operations: [] };
    const attached = await this.d.attachments.attachmentsForBuild(buildId);
    await this.workbench.open(buildId, {
      ...(seed ? versionFiles(seed) : {
        "capability.json": bytes(JSON.stringify(skeleton, null, 2) + "\n"),
        "src/index.ts": bytes("// See BUILDER.md for the implementation contract.\nexport const operations = {};\n"),
        "tests/cases.json": bytes("[]\n"),
      }),
      "BUILDER.md": bytes(this.brief_("create", id, `${connection ? 'Build a connection ("kind": "connection"; see "Connections" below).\n\n' : ""}Requirements: ${req.requirements}${scheduledNote(req.schedules, "create")}${attached.note}`, this.registry.buildContext(buildId))),
      ...(connection ? {} : await this.looksFile(id, "create")),
      ...attached.files,
      ...this.agentsFile(buildId),
      ...(await this.designSystemFile()),
    });
    if (this.cancelledWhileOpening(buildId)) return;
    this.buildEvent(buildId, `opened${req.retryOf ? ` (retry of ${req.retryOf})` : ""}, builder: ${b.builder}`, `build ${buildId} [create ${id} by ${b.requestedBy}]`);
    this.setStep(buildId, id, "spec");
    this.startBuilder(buildId, b.builder!);
  }

  /**
   * Install a capability from a directory the host knows how to copy (`hewn install <dir>`):
   * a create build whose builder copies the files in, then the normal validation. Owner only.
   */
  async install(owner: Agent, req: { name: string; purpose: string; builder: string; id?: string; seed?: Files; requirements?: string; source?: ToolSource; sample?: boolean; summary?: BundleSummary }): Promise<BuildView> {
    requireOwner(owner);
    const id = req.id ?? slugify(req.name);
    const existing = this.registry.getCapability(id);
    if (existing?.activeVersion || existing?.archivedAt) throw new PlatformError("conflict", `capability '${id}' already exists`);
    // Takes over an id a create never promoted (as createBuild does), unless one is being built.
    if (existing) this.oneCreateAtATime(owner, id);
    const request: CreateRequest = { name: req.name, purpose: req.purpose, requirements: req.requirements ?? `install (${req.builder})`, ...(req.source ? { source: req.source } : {}), ...(req.sample ? { sample: true } : {}), ...(req.summary ? { summary: req.summary } : {}) };
    return this.openCreateBuild(owner, id, request, !existing, req.builder, req.seed);
  }

  /** `after`: a build to wait for first (e.g. adding the operation this change needs to a connection). `marks`: a retry's, from `retryBuild`. */
  async modify(agent: Agent, req: { capabilityId: string; request: string; after?: string; schedules?: ApprovedSchedule[]; conversation?: BuildTurn[] } & ModelAsk, marks: RetryMarks = {}): Promise<BuildView> {
    requireScope(agent, "modify");
    await this.checkEffort(agent, req);
    this.d.schedules.checkApprovedSchedules(agent, req.schedules);
    const conversation = this.checkConversation(agent, req.conversation) ?? this.retried(marks);
    const cap = this.visibleActive(agent, req.capabilityId);
    const builder = this.requireBuilder();
    const model = this.modelFor(agent, builder, req);
    const after = this.dependency(agent, req.after);
    const dependsOn = after ?? this.queueBehind(cap.id, marks);
    // What a change asks for, and nothing else (as in createBuild).
    const request = { capabilityId: cap.id, request: req.request, ...(req.schedules !== undefined ? { schedules: req.schedules } : {}), ...pickAsk(req), ...(after ? { after } : {}), ...marks };
    const buildId = newBuildId();
    this.registry.transaction(() => {
      this.registry.insertBuild({ id: buildId, capabilityId: cap.id, kind: "modify", request, requestedBy: agent.id, baseVersion: dependsOn ? null : cap.activeVersion, builder, dependsOn });
      this.registry.setBuildModel(buildId, model);
      this.recordContext(buildId, cap.id, conversation);
      this.takePlace(buildId, marks);
    });
    if (dependsOn) this.waitFor(buildId, cap.id, dependsOn, `build ${buildId} [modify ${cap.id} by ${agent.id}]`, !after);
    else await this.startModify(buildId);
    return this.buildView(this.registry.getBuild(buildId)!);
  }

  /**
   * A widgets build: a follow-up that adds or changes only widgets (their read operations, the
   * `widgets` declaration and tests), never the capability's own operations, data or UI. `request`
   * says what to show; without one the builder proposes 1–3 widgets from the capability's data.
   * `after`: the build to wait for (e.g. the create build of the capability itself).
   */
  async addWidgets(agent: Agent, req: { capabilityId: string; request?: string; after?: string; conversation?: BuildTurn[] } & ModelAsk, marks: RetryMarks = {}): Promise<BuildView> {
    requireScope(agent, "modify");
    await this.checkEffort(agent, req);
    const conversation = this.checkConversation(agent, req.conversation) ?? this.retried(marks);
    const after = this.dependency(agent, req.after);
    const cap = after ? this.registry.getCapability(req.capabilityId) : this.visibleActive(agent, req.capabilityId);
    if (!cap || cap.archivedAt || !canSee(agent, cap.id)) throw new PlatformError("not_found", `no capability ${req.capabilityId}`);
    if (cap.activeVersion && isConnection(this.activeManifest(cap.id))) throw new PlatformError("invalid_request", `${cap.id} is a connection; connections have no widgets`);
    const builder = this.requireBuilder();
    const model = this.modelFor(agent, builder, req);
    const dependsOn = after ?? this.queueBehind(cap.id, marks);
    const request = { capabilityId: cap.id, request: req.request?.trim() ?? "", ...pickAsk(req), ...(after ? { after } : {}), ...marks };
    const buildId = newBuildId();
    this.registry.transaction(() => {
      this.registry.insertBuild({ id: buildId, capabilityId: cap.id, kind: "widgets", request, requestedBy: agent.id, baseVersion: dependsOn ? null : cap.activeVersion, builder, dependsOn });
      this.registry.setBuildModel(buildId, model);
      this.recordContext(buildId, cap.id, conversation);
      this.takePlace(buildId, marks);
    });
    if (dependsOn) this.waitFor(buildId, cap.id, dependsOn, `build ${buildId} [widgets ${cap.id} by ${agent.id}]`, !after);
    else await this.startModify(buildId);
    return this.buildView(this.registry.getBuild(buildId)!);
  }

  /** Open a modify (or widgets) build's workspace from the active version (at start time) and start its builder. */
  private async startModify(buildId: string) {
    const b = this.mustBuild(buildId);
    // Another change to this capability started (or paused) while this one waited for its `after`: its turn comes after that one.
    const ahead = this.registry.unfinishedBuild(b.capabilityId, { running: true, except: buildId }) ?? this.pausedBuild(b.capabilityId, "change");
    if (ahead) {
      this.registry.updateBuild(buildId, { status: "waiting", dependsOn: ahead.id });
      this.waitFor(buildId, b.capabilityId, ahead.id, `build ${buildId} [${b.kind} ${b.capabilityId} by ${b.requestedBy}]`, true);
      this.events.emit(`${buildId}:state`);
      this.events.emit("changed");
      return;
    }
    // Started: no longer waiting, so a second release skips it and the next change's turn waits for it.
    this.registry.updateBuild(buildId, { status: "open" });
    const cap = this.registry.getCapability(b.capabilityId);
    if (!cap?.activeVersion || cap.archivedAt) throw new PlatformError("not_found", `${b.capabilityId} is no longer active`);
    const base = await this.loadVersion(cap.id, cap.activeVersion);
    this.registry.updateBuild(buildId, { baseVersion: cap.activeVersion });
    const request = (b.request as { request?: string }).request ?? "";
    const attached = await this.d.attachments.attachmentsForBuild(buildId);
    const ask = `${b.kind === "widgets" ? widgetsRequest(request) : `Requested change: ${request}`}${scheduledNote((b.request as { schedules?: ApprovedSchedule[] }).schedules, b.kind)}${attached.note}`;
    // versionFiles: versions stored before builder configuration was dropped may still carry it.
    await this.workbench.open(buildId, { ...versionFiles(base.files), "BUILDER.md": bytes(this.brief_(b.kind, cap.id, ask, this.registry.buildContext(buildId))), ...(isConnection(this.activeManifest(cap.id)) ? {} : await this.looksFile(cap.id, b.kind)), ...attached.files, ...this.agentsFile(buildId), ...(await this.designSystemFile()) });
    if (this.cancelledWhileOpening(buildId)) return;
    this.buildEvent(buildId, `opened from v${cap.activeVersion}, builder: ${b.builder}`, `build ${buildId} [${b.kind} ${cap.id} by ${b.requestedBy}]`);
    this.setStep(buildId, cap.id, "spec");
    this.startBuilder(buildId, b.builder!);
  }

  /**
   * The conversation that led to the build a retry retries (checked when it came), recorded with the
   * retry before its workspace opens: BUILDER.md quotes it and its attachments are found through it.
   */
  private retried(marks: RetryMarks): BuildTurn[] | undefined {
    return marks.retryOf ? this.registry.buildContext(marks.retryOf)?.conversation : undefined;
  }

  /** Cancelled while its workspace was being opened (nothing to abort yet): don't start it. */
  private cancelledWhileOpening(buildId: string): boolean {
    if (this.mustBuild(buildId).status !== "cancelled") return false;
    this.workbench.remove(buildId).catch(() => {});
    return true;
  }

  /**
   * Re-run a failed build with the same request (e.g. after the builder's login expired),
   * from the capability's current state. Returns the new build.
   */
  async retryBuild(agent: Agent, buildId: string, opts: { fix?: boolean; auto?: boolean } = {}): Promise<BuildView> {
    const old = this.visibleBuild(agent, buildId);
    requireScope(agent, scopeOf(old.kind));
    if (old.status !== "failed" && old.status !== "cancelled") throw new PlatformError("conflict", `only failed or cancelled builds can be retried (this one is ${old.status})`);
    if (opts.fix && old.status !== "failed") throw new PlatformError("conflict", "only failed builds can be fixed; retry it instead");
    // Retried already (by hand, or by Hewn after a restart): one retry at a time, or two builds of the same request run at once.
    if (this.registry.retryOf(old.id)) {
      const cur = this.currentBuild(old.id);
      const ended = cur.status === "failed" || cur.status === "cancelled";
      throw new PlatformError("conflict", `build ${old.id} was already retried as ${cur.id}${ended ? `, which ${cur.status}; retry ${cur.id} instead` : ` (${cur.status}); wait for that one`}`);
    }
    // Paused by the builder's host: going on spends more of the owner's allowance, so it's theirs to decide.
    if (isPaused(old) && agent.kind !== "user") throw new PlatformError("forbidden", "the owner continues a paused build in Hewn");
    // No builder ran, so none can run again: an install from a file is installed again, the owner's own edit saved again.
    if (old.builder === "bundle") throw new PlatformError("conflict", "this was an install from a file; install the file again instead of retrying");
    if (old.request.filesOnly) throw new PlatformError("conflict", "this saved files you wrote; save them again instead of retrying");
    const req: Record<string, any> = { ...old.request };
    delete req.retryOf;
    delete req.autoRetryOf;
    const marks: RetryMarks = { retryOf: old.id, ...(opts.auto ? { autoRetryOf: old.id } : {}) };
    // An automatic retry (after a restart) runs on what was asked; an agent's own retry is checked
    // again, so a model the owner has unticked since isn't used.
    if (opts.auto) this.trustedAsks.add(req);
    if (opts.fix) {
      // "Ask builder to fix": the same request plus why the last build failed.
      const f = explainFailure(old.log);
      const context = `${FIX_MARK}\nThe previous build failed: ${f.title}. ${f.detail}\nIts validation log ended with:\n${old.log.slice(-8).join("\n")}`;
      const field = old.kind === "create" ? "requirements" : "request";
      req[field] = `${String(req[field] ?? "").split(FIX_MARK)[0].trimEnd()}\n\n${context}`;
    }
    if (old.kind === "modify" && old.request.manifestOnly) throw new PlatformError("conflict", "this was a model replacement; replace the model again instead of retrying");
    return (async () => {
      if (old.kind === "modify") return this.modify(agent, req as { capabilityId: string; request: string; after?: string }, marks);
      if (old.kind === "widgets") return this.addWidgets(agent, req as { capabilityId: string; request?: string; after?: string }, marks);
      const cap = this.registry.getCapability(old.capabilityId);
      if (cap?.activeVersion) throw new PlatformError("conflict", `${old.capabilityId} has been created since; request a modification instead`);
      // A new create of the same name took the id over (createBuild) and is still being built. Not a
      // widgets build chained after this one (create with widgets): that one follows the retry.
      const building = this.registry.unfinishedBuild(old.capabilityId, { kind: "create" });
      if (building) throw new PlatformError("conflict", `'${old.capabilityId}' is being built again${this.buildRef(agent, building)}; wait for it`);
      // Or took it over and paused, its work kept: retrying this one would strand it (unless this is its Continue).
      const paused = this.pausedBuild(old.capabilityId, "create");
      if (paused && paused.id !== old.id) throw this.pausedFirst(agent, `'${old.capabilityId}'`, paused);
      // An install retries with the same copy builder.
      const builder = old.builder?.startsWith("copy:") ? old.builder : undefined;
      const dependsOn = this.dependency(agent, req.after);
      if (!dependsOn) delete req.after;
      else req.after = dependsOn;
      Object.assign(req, marks);
      return this.openCreateBuild(agent, old.capabilityId, req as CreateRequest, !cap, builder, undefined, dependsOn, this.retried(marks));
    })();
  }

  /**
   * Stop a build: the builder is stopped and nothing is promoted. Allowed for the owner and the
   * agent that requested it. A candidate already being validated finishes first.
   */
  cancelBuild(agent: Agent, buildId: string): BuildView {
    const build = this.mustBuild(buildId);
    requireScope(agent, scopeOf(build.kind));
    if (agent.kind !== "user" && agent.id !== build.requestedBy) throw new PlatformError("forbidden", `only the owner or ${build.requestedBy} can cancel this build`);
    if (build.status === "validating") throw new PlatformError("conflict", "the candidate is being validated; it finishes in a moment");
    // Paused (its host kept the work for a Continue): Stop ends it, unless it was continued.
    const paused = isPaused(build);
    const continued = paused ? this.registry.retryOf(build.id) : undefined;
    if (continued) throw new PlatformError("conflict", `build ${buildId} was continued as ${continued}`);
    if (!paused && build.status !== "building" && build.status !== "open" && build.status !== "waiting" && build.status !== "review") throw new PlatformError("conflict", `build is already ${build.status}`);
    const line = paused ? `CANCELLED by ${agent.id} (stopped while paused)` : `CANCELLED by ${agent.id}`;
    this.registry.updateBuild(buildId, { status: "cancelled", log: [...build.log, line] });
    this.buildEvent(buildId, line, `build ${buildId} [${build.kind} ${build.capabilityId}]`);
    this.aborts.get(buildId)?.abort();
    if (!this.running.has(buildId)) {
      // Not running (waiting): nothing else will announce the end.
      this.steps.delete(buildId);
      this.events.emit(`${buildId}:state`);
      this.events.emit(`${buildId}:done`);
      void this.releaseDependents(buildId);
    }
    return this.buildView(this.mustBuild(buildId));
  }

  getBuild(agent: Agent, buildId: string): BuildView {
    requireScope(agent, "create", "modify");
    return this.buildView(this.visibleBuild(agent, buildId));
  }

  /** What led to a build (the owner's conversation with the intake, the instructions, the brief) and what the owner said of it once live. Owner only. */
  buildContext(owner: Agent, buildId: string): BuildContext & { feedback?: BuildFeedback } {
    requireOwner(owner);
    this.mustBuild(buildId);
    const feedback = this.registry.buildFeedback(buildId);
    return { ...(this.registry.buildContext(buildId) ?? {}), ...(feedback ? { feedback } : {}) };
  }

  /**
   * "Got what you asked for?" on a build that went live: yes, no (with a note on what's off), or
   * skip. Owner only. It stays in the owner's database; nothing leaves the machine.
   */
  setBuildFeedback(owner: Agent, buildId: string, f: { score?: unknown; note?: unknown }): BuildFeedback {
    requireOwner(owner);
    const b = this.mustBuild(buildId);
    if (b.status !== "promoted") throw new PlatformError("conflict", `build ${buildId} isn't live (it is ${b.status}); the question is for builds that went live`);
    if (f.score !== "yes" && f.score !== "no" && f.score !== "skip") throw new PlatformError("invalid_request", 'score must be "yes", "no" or "skip"');
    if (f.note !== undefined && (typeof f.note !== "string" || f.note.length > MAX_FEEDBACK_NOTE)) throw new PlatformError("invalid_request", `note: text of at most ${MAX_FEEDBACK_NOTE} characters`);
    const note = typeof f.note === "string" ? f.note.trim() : "";
    this.registry.setBuildFeedback(buildId, { score: f.score, ...(note ? { note } : {}) });
    this.logger(`build ${buildId}: the owner says ${f.score}`);
    return this.registry.buildFeedback(buildId)!;
  }

  /**
   * How recent builds worked out, newest first: what each ran on, how many attempts, how it ended,
   * the owner's answer, and the signs in the record (a failed build whose retry went live, another
   * change within a day of going live, a restore within a week, the tool deleted within a day). For
   * the owner (`hewn feedback`); a host reads it the same way, in the machine. Nothing is sent anywhere.
   */
  buildReport(owner: Agent, opts: { days?: number } = {}): BuildReport {
    requireOwner(owner);
    const days = Math.min(365, Math.max(1, Number(opts.days) || 30));
    const builds = this.registry.buildsSince(new Date(Date.now() - days * 86400_000).toISOString());
    const rollbacks = this.registry.lifecycleEvents(2000).filter((e) => e.action === "rollback");
    const within = (from: string, to: string, hours: number) => {
      const d = Date.parse(to) - Date.parse(from);
      return d >= 0 && d <= hours * 3600_000;
    };
    const rows = builds.map((b) => {
      const attempts = Math.max(1, ...b.log.map((l) => Number(/^attempt (\d+): builder/.exec(l)?.[1] ?? 0)));
      const later = builds.filter((x) => x.capabilityId === b.capabilityId && x.id !== b.id && x.createdAt > b.createdAt);
      const retry = (x: BuildRow) => x.request.retryOf === b.id || x.request.autoRetryOf === b.id;
      const live = b.status === "promoted";
      return {
        buildId: b.id,
        capabilityId: b.capabilityId,
        kind: b.kind,
        status: b.status,
        createdAt: b.createdAt,
        builder: b.builder ?? "agent",
        ...(b.model ? { model: b.model } : {}),
        ...(b.effort ? { effort: b.effort } : {}),
        ...(b.ranModel ? { ranModel: b.ranModel } : {}),
        ...(b.brief ? { brief: b.brief } : {}),
        attempts,
        ...(b.status === "failed" ? { failure: explainFailure(b.log).title } : {}),
        ...(b.feedback ? { feedback: b.feedback } : {}),
        signals: {
          fixed: later.some((x) => retry(x) && x.status === "promoted"),
          changedSoon: live && later.some((x) => !retry(x) && !x.request.retryOf && !x.request.autoRetryOf && within(b.updatedAt, x.createdAt, 24)),
          restored: live && b.resultVersion !== null && rollbacks.some((e) => e.capabilityId === b.capabilityId && e.detail.startsWith(`v${b.resultVersion} →`) && within(b.updatedAt, e.at, 7 * 24)),
          deletedSoon: live && !!b.archivedAt && within(b.updatedAt, b.archivedAt, 24),
        },
      };
    });
    return { days, builds: rows };
  }

  /** The builder's transcript: kept with the build once it ended, the workbench's while it runs. Owner only (it shows source). */
  async buildTranscript(owner: Agent, buildId: string): Promise<string | undefined> {
    requireOwner(owner);
    this.mustBuild(buildId);
    const kept = await this.blobs.get(`transcripts/${buildId}.log`);
    return kept ? text(kept) : await this.workbench.transcript(buildId);
  }

  /** The transcript goes with the build for the capability's life (the workbench's copy goes with cleanup). Best-effort. */
  private async keepTranscript(buildId: string) {
    try {
      const t = await this.workbench.transcript(buildId);
      if (t) await this.blobs.put(`transcripts/${buildId}.log`, t);
    } catch {
      // A build is no less built without its transcript kept.
    }
  }

  /** A build the agent may see (see `sees`). Else not found. */
  private visibleBuild(agent: Agent, buildId: string): BuildRow {
    const b = this.registry.getBuild(buildId);
    if (!b || !this.sees(agent, b)) throw new PlatformError("not_found", `no build '${buildId}'`);
    return b;
  }

  /** An agent may see a build of a capability it can see, or one it requested. */
  private sees(agent: Agent, b: BuildRow): boolean {
    return canSee(agent, b.capabilityId) || b.requestedBy === agent.id;
  }

  private assertSubmittable(build: BuildRow) {
    const current = this.mustBuild(build.id);
    if (current.status === "promoted") throw new PlatformError("conflict", "build already promoted");
    if (current.status === "cancelled") throw new PlatformError("conflict", "build was cancelled; retry it to start again");
    if (current.status === "validating") throw new PlatformError("conflict", "build is already being validated");
    const cap = this.registry.getCapability(build.capabilityId)!;
    if (cap.activeVersion !== build.baseVersion) {
      throw new PlatformError("conflict", "capability changed since this build started; request a new modification");
    }
  }

  /** A build's log, line by line: kept in `log`, and on the platform log and the build's transcript. */
  private stepLog(build: BuildRow, submitter: string, log: string[]) {
    return (message: string) => {
      log.push(message);
      this.buildEvent(build.id, message, `build ${build.id} [${build.kind} ${build.capabilityId}, submitted by ${submitter}]`);
    };
  }

  /**
   * Check the workspace's candidate as validation does, without promoting it (`promoteCandidate`
   * does). `measure`: also measure what a craft pass should fix; `pass`: the pass it comes from (its
   * step shows the tests). Never throws: no candidate, and the log says why; `tests`: how many passed.
   */
  private async validateCandidate(build: BuildRow, submitter: string, opts: { measure?: boolean; pass?: Pass } = {}): Promise<{ candidate?: Candidate; tests?: number; log: string[] }> {
    this.registry.updateBuild(build.id, { status: "validating" });
    const log: string[] = [];
    const step = this.stepLog(build, submitter, log);
    step("validating candidate");
    let tests: number | undefined;
    try {
      const candidate = await this.d.validation.validate(build, step, {
        ...(opts.measure ? { measure: true } : {}),
        onTests: (passed, total) => ((tests = passed), this.setStep(build.id, build.capabilityId, opts.pass ?? "tests", { passed, total })),
      });
      return { candidate, ...(tests !== undefined ? { tests } : {}), log };
    } catch (e) {
      step(`FAILED: ${(e as Error).message}`);
      return { log };
    }
  }

  /** Promote a validated candidate, or hold it for the owner's review. Never throws: the log says what failed. */
  private async promoteCandidate(build: BuildRow, submitter: string, candidate: Candidate): Promise<{ version?: number; review?: BuildReview; log: string[] }> {
    this.registry.updateBuild(build.id, { status: "validating" });
    const log: string[] = [];
    const step = this.stepLog(build, submitter, log);
    try {
      const r = await this.d.validation.promote(build, candidate, step);
      if ("review" in r) {
        step(`passed; waiting for the owner's review before it goes live (${reviewReason(r.review)})`);
        return { review: r.review, log };
      }
      step(`promoted: implementation v${r.version} is now active`);
      this.d.schedules.applyApprovedSchedules(build, step);
      await this.d.sharing.afterInstall(build, step);
      this.setStep(build.id, build.capabilityId, this.platform.readiness(build.capabilityId).ready ? "done" : "auth", this.steps.get(build.id)?.tests);
      return { version: r.version, log };
    } catch (e) {
      step(`FAILED: ${(e as Error).message}`);
      return { log };
    }
  }

  private startBuilder(buildId: string, builder: string) {
    const abort = new AbortController();
    this.aborts.set(buildId, abort);
    let release = () => {};
    const run = this.takeSlot(buildId, abort.signal)
      .then((r) => ((release = r), abort.signal.aborted ? undefined : this.runBuilder(buildId, builder, abort.signal)))
      .catch((e) => {
        if (abort.signal.aborted) return;
        this.logger(`build ${buildId} crashed: ${(e as Error).message}`);
        // Gone (its capability purged meanwhile): nothing left to mark failed.
        const b = this.registry.getBuild(buildId);
        if (b) this.registry.updateBuild(buildId, { status: "failed", log: [...b.log, `FAILED: ${(e as Error).message}`] });
      })
      .finally(async () => {
        await this.keepTranscript(buildId);
        release();
        this.running.delete(buildId);
        this.aborts.delete(buildId);
        this.progress.delete(buildId);
        this.steps.delete(buildId);
        this.events.emit(`${buildId}:done`);
        this.events.emit("changed");
        void this.releaseDependents(buildId);
      });
    this.running.set(buildId, run);
    this.events.emit(`${buildId}:state`);
  }

  /**
   * Wait for one of the `maxRunningBuilds` places (in the order builds asked). Resolves with the
   * function that gives it back; a build cancelled while it waits leaves the queue.
   */
  private takeSlot(buildId: string, signal: AbortSignal): Promise<() => void> {
    const once = () => {
      let given = false;
      return () => {
        if (given) return;
        given = true;
        const next = this.slots.queue.shift();
        if (next) next();
        else this.slots.busy--;
      };
    };
    if (this.slots.busy < this.platform.maxRunningBuilds) {
      this.slots.busy++;
      return Promise.resolve(once());
    }
    const b = this.mustBuild(buildId);
    this.buildEvent(buildId, `queued: ${this.slots.busy} builds are running; it starts when one finishes`, `build ${buildId} [${b.kind} ${b.capabilityId}]`);
    return new Promise((resolve) => {
      const go = () => {
        signal.removeEventListener("abort", leave);
        resolve(once());
      };
      const leave = () => {
        const i = this.slots.queue.indexOf(go);
        if (i >= 0) this.slots.queue.splice(i, 1);
        resolve(() => {});
      };
      this.slots.queue.push(go);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  /**
   * Builder writes, platform validates; retry with feedback. A new tool's candidate then goes through
   * its passes (`runPasses`) before it's promoted.
   */
  private async runBuilder(buildId: string, builder: string, signal: AbortSignal) {
    const build = this.mustBuild(buildId);
    const max = Math.max(1, this.platform.maxBuildAttempts());
    // The first build of the chain this one retries, so a host can count the chain as one build.
    let retryOf: string | undefined;
    for (let id = build.request.retryOf; typeof id === "string"; id = this.registry.getBuild(id)?.request.retryOf) retryOf = id;
    // The clock runs from the first attempt: a retry after a failed validation doesn't start it over.
    const run: BuilderRun = { build, builder, signal, history: [], tag: `build ${buildId} [${build.kind} ${build.capabilityId}, requested by ${build.requestedBy}]`, ...(retryOf ? { retryOf } : {}), started: Date.now(), runs: 0 };
    const passes = this.passesFor(build, builder);
    this.planPasses(buildId, passes);
    const submitter = `builder ${builder}`;
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= max; attempt++) {
      const label = `attempt ${attempt}`;
      const r = await this.runOnce(run, { label, n: attempt, max, feedback });
      // Cancelled: cancelBuild already recorded it; just stop.
      if (r === "cancelled") return;
      if (r === "again") continue;
      if (r !== "done") {
        // Retrying can't help, or isn't Hewn's to decide (paused): the build ends here.
        const line = r.why === "paused" ? `PAUSED: ${r.end}` : `FAILED: ${r.end}`;
        run.history.push(line);
        this.buildEvent(buildId, line, run.tag);
        this.registry.updateBuild(buildId, { status: "failed", log: run.history });
        return;
      }
      this.assertSubmittable(build);
      const v = await this.validateCandidate(build, submitter, { measure: passes[0] === "craft" });
      run.history.push(...v.log.map((l) => `${label}: ${l}`));
      if (!v.candidate) {
        feedback = v.log.join("\n");
        continue;
      }
      const best = passes.length ? await this.runPasses(run, { candidate: v.candidate, label, tests: v.tests }, passes) : { candidate: v.candidate, label };
      if (!best) return;
      const { version, review, log } = await this.promoteCandidate(build, submitter, best.candidate);
      run.history.push(...log.map((l) => `${best.label}: ${l}`));
      if (review) {
        this.registry.updateBuild(buildId, { status: "review", review, log: run.history });
        this.logger(`${run.tag} waits for the owner's review (${reviewReason(review)})`);
        return;
      }
      if (version) {
        this.registry.updateBuild(buildId, { status: "promoted", resultVersion: version, log: run.history });
        return;
      }
      feedback = log.join("\n");
    }
    run.history.push(`FAILED: no valid candidate after ${max} attempts`);
    this.buildEvent(buildId, `FAILED: no valid candidate after ${max} attempts`, run.tag);
    this.registry.updateBuild(buildId, { status: "failed", log: run.history });
  }

  /**
   * Run the builder once: one of the build's attempts, or a pass's (`pass`). `label` starts its lines
   * in the log ("attempt 2", "critique pass"); `n` of `max` is its place among its kind's tries. The
   * outcome: it finished ("done"); it failed and another try may help ("again"); the build was
   * cancelled; or it can't go on (`end` says why: a model that can't run, the host declined or paused
   * it, the builder unavailable), which ends the build, or a pass.
   */
  private async runOnce(run: BuilderRun, o: { label: string; n: number; max: number; feedback?: string; pass?: BuildPass }): Promise<"done" | "again" | "cancelled" | { end: string; why: "model" | "paused" | "refused" | "unavailable" }> {
    const { build, builder, signal, tag } = run;
    const buildId = build.id;
    if (signal.aborted) return "cancelled";
    // Every run of the builder is a new attempt for it, a pass's too: the session it resumes is the build's.
    const attempt = ++run.runs;
    this.registry.updateBuild(buildId, { status: "building", log: run.history });
    const started = Date.now();
    const live: { attempt: number; maxAttempts: number; startedAt: number; lastActivity?: string; lastActivityAt?: number } = { attempt: o.n, maxAttempts: o.max, startedAt: run.started };
    this.progress.set(buildId, live);
    this.setStep(buildId, build.capabilityId, o.pass?.name ?? "code");
    this.buildEvent(buildId, `builder ${builder} working${o.pass ? ` on the ${o.pass.name} pass` : ""} (${o.pass ? "try" : "attempt"} ${o.n}/${o.max})`, tag);
    const heartbeat = setInterval(() => {
      const p = this.progressOf(buildId);
      if (!p) return;
      const last = p.lastActivity ? `last: ${p.lastActivity} (${p.secondsSinceActivity}s ago)` : "no activity yet";
      this.logger(`${tag} ${builder} ${fmtDuration(p.elapsedSeconds)} · ${last}`);
    }, this.platform.heartbeatMs);
    (heartbeat as { unref?: () => void }).unref?.();
    // The builder checking its work as it goes (its `check` tool): validation's steps, without promoting.
    const checks = this.d.validation.checksFor(build, signal, (line) => ((live.lastActivity = line), (live.lastActivityAt = Date.now()), this.events.emit(buildId, line)));
    try {
      const asked = this.registry.buildModel(buildId);
      await this.workbench.build(
        { buildId, capabilityId: build.capabilityId, kind: build.kind, builder, attempt, ...(run.retryOf ? { retryOf: run.retryOf } : {}), feedback: o.feedback, ...(asked?.model ? { model: asked.model } : {}), ...(asked?.effort ? { effort: asked.effort } : {}), ...(o.pass ? { pass: o.pass } : {}) },
        {
          signal,
          onActivity: (line) => {
            live.lastActivity = line;
            live.lastActivityAt = Date.now();
            this.events.emit(buildId, line);
          },
          onModel: (ran) => this.registry.setRanModel(buildId, ran),
          onCharge: (c) => {
            // The only check on a value from the builder's host: a sane amount and a short unit, else ignored.
            if (!saneCharge(c)) return;
            this.registry.addBuildCharge(buildId, c);
            this.registry.addHostCharge("build", c, build.capabilityId);
          },
          onCheck: checks.run,
        },
      );
    } catch (e) {
      if (signal.aborted) return "cancelled";
      if ((e as { interrupted?: boolean }).interrupted) {
        // Lost the builder's machine side (Hewn restarting?). Don't burn the next attempts on it at
        // once: if this process goes away meanwhile, the build is still "building" and the restart
        // retries it; if it's still here after a while, it counts as one failed attempt.
        this.buildEvent(buildId, `${o.label}: lost the connection to the builder (${(e as Error).message}); waiting before going on`, tag);
        await new Promise((ok) => setTimeout(ok, this.platform.interruptWaitMs));
        if (signal.aborted) return "cancelled";
      }
      // The model asked for can't run (retired, misspelled, not on this account): nothing is built.
      if ((e as { modelUnavailable?: boolean }).modelUnavailable) return { end: `model unavailable: ${(e as Error).message}`, why: "model" };
      // The builder's host paused it part-way (e.g. it has used a build's allowance), its work kept:
      // not for Hewn to retry, the owner's to Continue (a retry picks the work up) or Stop.
      if ((e as { paused?: boolean }).paused) return { end: (e as Error).message, why: "paused" };
      // The builder's host declined it (e.g. over the month's builds): say why, don't retry.
      if ((e as { refused?: boolean }).refused) return { end: `refused: ${(e as Error).message}`, why: "refused" };
      const msg = `${o.label}: builder ${builder} failed: ${(e as Error).message}`;
      run.history.push(msg);
      this.buildEvent(buildId, msg, tag);
      // Retrying can't help (e.g. not logged in); stop now with a clear next step.
      if ((e as { unavailable?: boolean }).unavailable) return { end: `builder ${builder} is unavailable. Fix it, then retry this build.`, why: "unavailable" };
      return "again";
    } finally {
      clearInterval(heartbeat);
      // A check still running (the builder stopped mid-call) finishes before anything else validates.
      await checks.settled();
    }
    if (signal.aborted) return "cancelled";
    run.history.push(`${o.label}: builder ${builder} finished in ${Math.round((Date.now() - started) / 1000)}s`);
    return "done";
  }

  /** The passes a build runs once its candidate validates: a new tool's (not a connection's or an install's), as the owner set them. */
  private passesFor(build: BuildRow, builder: string): Pass[] {
    if (build.kind !== "create" || (build.request as CreateRequest).kind === "connection") return [];
    if (builder === "keep" || builder === "bundle" || builder.startsWith("copy:")) return [];
    return this.platform.buildPasses();
  }

  /** The passes a build will run, which its steps show (none: not shown). */
  private planPasses(buildId: string, passes: Pass[]) {
    const s = this.steps.get(buildId);
    if (!s) return;
    s.passes = passes.length ? passes : undefined;
    this.events.emit(`${buildId}:step`, this.stepState(buildId));
  }

  /**
   * The passes on a validated candidate, in order. Each shows the builder screenshots of the candidate
   * before it (the whole page, in parts a model can read) and, for the craft pass, what was measured on
   * it; resumes the builder's session with what the pass asks; and validates what it leaves. A pass that
   * ends without a valid candidate (after its tries, or paused, declined, its builder gone) leaves the
   * candidate before it, and the passes after it don't run: never worse than without them. Nothing to
   * look at (the UI wasn't rendered): no passes. Undefined: cancelled. Not tied to a new tool: a change
   * build can run them too.
   */
  private async runPasses(run: BuilderRun, first: PassCandidate, passes: Pass[]): Promise<PassCandidate | undefined> {
    if (!first.candidate.shots?.length) {
      this.planPasses(run.build.id, []);
      return first;
    }
    const ownersWords = !!this.registry.buildContext(run.build.id)?.conversation?.length;
    const otherTools = !!(await this.workbench.file(run.build.id, "OTHER_TOOLS.md"));
    let current = first;
    for (const [i, pass] of passes.entries()) {
      const shots = Object.fromEntries((current.candidate.shots ?? []).map((s) => [`screenshots/${s.name}.png`, s.png]));
      await this.workbench.writeFolder(run.build.id, "screenshots", shots);
      const request = passRequest(pass, { files: Object.keys(shots), sampled: !!current.candidate.sampled, defects: current.candidate.defects ?? [], ownersWords, otherTools });
      const next = await this.runPass(run, pass, request, passes[i + 1] === "craft");
      if (next === "cancelled") return undefined;
      if (!next) {
        const line = `${pass} pass: kept the candidate from before it${current.tests !== undefined ? ` (${current.tests} test cases passed)` : ""}`;
        run.history.push(line);
        this.buildEvent(run.build.id, line, run.tag);
        break;
      }
      current = next;
    }
    return current;
  }

  /** One pass: up to PASS_TRIES runs of the builder until what it leaves validates. Undefined: it didn't (the log says why). */
  private async runPass(run: BuilderRun, pass: Pass, request: string, measure: boolean): Promise<PassCandidate | "cancelled" | undefined> {
    const max = Math.min(PASS_TRIES, Math.max(1, this.platform.maxBuildAttempts()));
    let feedback: string | undefined;
    for (let n = 1; n <= max; n++) {
      const label = n === 1 ? `${pass} pass` : `${pass} pass, try ${n}`;
      const r = await this.runOnce(run, { label, n, max, feedback, pass: { name: pass, request } });
      if (r === "cancelled") return "cancelled";
      if (r === "again") continue;
      if (r !== "done") {
        const line = `${label}: stopped (${r.why === "paused" ? `paused: ${r.end}` : r.end})`;
        run.history.push(line);
        this.buildEvent(run.build.id, line, run.tag);
        return undefined;
      }
      this.assertSubmittable(run.build);
      const v = await this.validateCandidate(run.build, `builder ${run.builder}`, { pass, measure });
      run.history.push(...v.log.map((l) => `${label}: ${l}`));
      if (v.candidate) return { candidate: v.candidate, label, ...(v.tests !== undefined ? { tests: v.tests } : {}) };
      feedback = v.log.join("\n");
    }
    const line = `${pass} pass: no valid candidate after ${max} ${max === 1 ? "try" : "tries"}`;
    run.history.push(line);
    this.buildEvent(run.build.id, line, run.tag);
    return undefined;
  }

  /** Builds waiting for the owner's review (owner only). */
  buildsInReview(owner: Agent): BuildView[] {
    requireOwner(owner);
    return this.registry.buildsInReview().map((b) => this.buildView(b));
  }

  /**
   * The owner lets an agent's change go live: exactly the candidate that passed validation. If the
   * capability changed meanwhile, the build fails (retry it to build on the new version).
   */
  async approveBuild(owner: Agent, buildId: string): Promise<BuildView> {
    requireOwner(owner);
    const build = this.mustBuild(buildId);
    if (build.status !== "review" || !build.review) throw new PlatformError("conflict", `build ${buildId} isn't waiting for review (it is ${build.status})`);
    const cap = this.registry.getCapability(build.capabilityId);
    const log = [...build.log];
    const step = (message: string) => (log.push(message), this.buildEvent(buildId, message, `build ${buildId} [${build.kind} ${build.capabilityId}, approved by ${owner.id}]`));
    this.registry.addAuthorityEvent({ actor: owner.id, action: "build_approved", subject: build.requestedBy, capabilityId: build.capabilityId, detail: buildId });
    try {
      if (!cap?.activeVersion || cap.archivedAt || cap.activeVersion !== build.baseVersion) throw new Error("the capability changed since this build was checked; retry it to build on the current version");
      const v = await this.loadCandidate(build.review.contentHash);
      const manifest = JSON.parse(text(v.files["capability.json"])) as CapabilityManifest;
      step(`approved by ${owner.id}`);
      const version = await this.d.validation.promoteVersion(build, manifest, v.files, { hash: build.review.contentHash, js: v.bundle }, step);
      step(`promoted: implementation v${version} is now active`);
      this.d.schedules.applyApprovedSchedules(build, step);
      this.registry.updateBuild(buildId, { status: "promoted", resultVersion: version, review: null, log });
    } catch (e) {
      step(`FAILED: ${(e as Error).message}`);
      this.registry.updateBuild(buildId, { status: "failed", review: null, log });
    }
    await this.keepTranscript(buildId);
    this.buildEnded(buildId);
    return this.buildView(this.mustBuild(buildId));
  }

  /** The owner turns an agent's change down: nothing changes. */
  async rejectBuild(owner: Agent, buildId: string): Promise<BuildView> {
    requireOwner(owner);
    const build = this.mustBuild(buildId);
    if (build.status !== "review" || !build.review) throw new PlatformError("conflict", `build ${buildId} isn't waiting for review (it is ${build.status})`);
    const line = `REJECTED by ${owner.id}: the change didn't go live`;
    this.registry.updateBuild(buildId, { status: "cancelled", review: null, log: [...build.log, line] });
    this.buildEvent(buildId, line, `build ${buildId} [${build.kind} ${build.capabilityId}]`);
    this.registry.addAuthorityEvent({ actor: owner.id, action: "build_rejected", subject: build.requestedBy, capabilityId: build.capabilityId, detail: buildId });
    if (!this.registry.versionWithHash(build.review.contentHash)) {
      this.loaded.delete(build.review.contentHash);
      await this.blobs.delete(`versions/${build.review.contentHash}.json`);
    }
    await this.keepTranscript(buildId);
    this.buildEnded(buildId);
    return this.buildView(this.mustBuild(buildId));
  }

  /** A frozen candidate, checked against its hash. */
  private async loadCandidate(hash: string): Promise<{ files: Files; bundle: string }> {
    const raw = await this.blobs.get(`versions/${hash}.json`);
    if (!raw) throw new Error("the candidate is missing from storage");
    const v = decodeVersion(raw);
    if (contentHash(v.files, v.bundle) !== hash) throw new Error("the candidate failed its integrity check");
    return v;
  }

  /** A build ended outside its builder run (a review decided): tell followers, release dependents. */
  private buildEnded(buildId: string) {
    this.steps.delete(buildId);
    this.events.emit(`${buildId}:state`);
    this.events.emit(`${buildId}:done`);
    this.events.emit("changed");
    void this.releaseDependents(buildId);
  }

  // ---------- helpers ----------

  /** Public manifests of the owner's other capabilities: what a builder may compose with. */
  private catalogForBuilder(exclude: string): string {
    const caps = this.registry.listActiveCapabilities().filter((c) => c.id !== exclude);
    if (!caps.length) return "";
    const lines = caps.map((c) => {
      const m = this.activeManifest(c.id);
      const ops = m.operations.map((o) => `  - \`${o.name}@${o.version}\` (${o.sideEffect}): ${o.description}\n    input: ${JSON.stringify(o.inputSchema)}\n    output: ${JSON.stringify(o.outputSchema)}`);
      return `### ${m.name} (\`${c.id}\`)\n${m.purpose}\n${ops.join("\n")}`;
    });
    return `\n## The owner's other capabilities (public contracts you may call)\n\nYou can compose with these via ctx.call (see "Calling other capabilities"). You see only their public contracts, never their data or code.\n\n${lines.join("\n\n")}\n`;
  }

  /**
   * OTHER_TOOLS.md for a workspace: the other tools' looks (`othersLooks`), in a file of its own, as a
   * builder may not read BUILDER.md to its end (OpenCode reads 50 KB of a file). None when there are
   * no other tools; a connection's build (no UI) gets none. Never part of a version (`isWorkspaceOnly`).
   */
  private async looksFile(exclude: string, kind: BuildKind): Promise<Files> {
    const looks = await this.othersLooks(exclude, kind);
    return looks ? { "OTHER_TOOLS.md": bytes(looks) } : {};
  }

  /**
   * The owner's other tools as a build is told them, to look clearly different from: each one's hue
   * (and saturation) on Home and the look its builder recorded in `ui/look.json`, cut short. The
   * workspace's OTHER_TOOLS.md, and what a design pass is told too. Connections (no UI) are left out;
   * a version that can't be read is listed without its look. Empty when there are none.
   */
  async othersLooks(exclude: string, kind: BuildKind = "create"): Promise<string> {
    const caps = this.registry.listActiveCapabilities().filter((c) => c.id !== exclude && !isConnection(this.activeManifest(c.id)));
    const tools = await Promise.all(
      caps.map(async (c): Promise<ToolLook> => {
        const raw = await this.loadVersion(c.id, c.activeVersion!, { keep: false }).then((v) => v.files["ui/look.json"], () => undefined);
        const look = raw && lookText(text(raw));
        return { id: c.id, name: c.displayName ?? this.activeManifest(c.id).name, hue: this.d.presentation.hueOf(c.id), saturation: this.d.presentation.saturationOf(c.id), ...(look ? { look } : {}) };
      }),
    );
    return looksNote(tools, kind);
  }

  /**
   * AGENTS.md for a workspace, for builders that read it on their own (Codex, OpenCode): where the
   * brief is, and the owner's instructions the build runs with. Never part of a version (`isBuilderConfig`).
   */
  private agentsFile(buildId: string): Files {
    const instructions = this.registry.buildContext(buildId)?.instructions;
    return {
      "AGENTS.md": bytes(`# Building for Hewn\n\nRead \`BUILDER.md\` first: the request, the implementation contract and the owner's other tools. Change files only inside this directory; when the candidate is complete, stop. The platform validates it.\n${instructions ? `\n${instructions}` : ""}`),
    };
  }

  /** PLATFORM_UI.css for a workspace: the design system to read (served to UIs as /_platform/ui.css). */
  private async designSystemFile(): Promise<Files> {
    const css = await this.designSystem?.().catch(() => undefined);
    return css ? { "PLATFORM_UI.css": bytes(css) } : {};
  }

  /** BUILDER.md: the request, the owner's own words and instructions as the build recorded them (`build_context`), the brief, the catalog. */
  private brief_(kind: BuildKind, id: string, request: string, context?: BuildContext): string {
    const submit = "When the candidate is complete, stop. The platform validates it automatically. If validation fails, you are run again with the failure log.";
    const instructions = context?.instructions;
    return `# Build: ${kind} \`${id}\`\n\n${request}${ownersWords(context?.conversation)}\n\n${instructions ? `${instructions}\n` : ""}${this.brief.replace("{{SUBMIT}}", submit).replaceAll("{{ABI}}", ABI)}${this.catalogForBuilder(id)}`;
  }

  private progressOf(buildId: string): BuildProgress | undefined {
    const p = this.progress.get(buildId);
    if (!p) return undefined;
    const now = Date.now();
    return {
      attempt: p.attempt,
      maxAttempts: p.maxAttempts,
      elapsedSeconds: Math.round((now - p.startedAt) / 1000),
      lastActivity: p.lastActivity ? p.lastActivity.slice(0, 120) : null,
      secondsSinceActivity: p.lastActivityAt ? Math.round((now - p.lastActivityAt) / 1000) : null,
    };
  }

  private buildView(b: BuildRow): BuildView {
    const view: BuildView = {
      buildId: b.id,
      capabilityId: b.capabilityId,
      kind: b.kind,
      status: b.status,
      request: b.request,
      requestedBy: b.requestedBy,
      builder: b.builder ?? "agent",
      log: b.log,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
    if (b.resultVersion) view.resultVersion = b.resultVersion;
    if (b.dependsOn) view.dependsOn = b.dependsOn;
    // Builds made on a 0.4.9 pre-release logged "(screenshot with the sample data)", and their logs keep it.
    if (b.log.some((l) => /\(screenshot (attached|with the sample data)/.test(l))) view.screenshot = true;
    const step = this.stepState(b.id);
    if (step && (b.status === "waiting" || b.status === "open" || b.status === "building" || b.status === "validating")) view.step = step;
    const tests = testCounts(b.log);
    if (tests) view.tests = tests;
    if (b.status === "failed") view.failure = explainFailure(b.log);
    if (view.failure?.paused) {
      const next = this.registry.retryOf(b.id);
      if (next) view.continuedAs = next;
      view.instructions = next
        ? `The owner continued this build as build ${next}. Call builds_wait on that one to follow it.`
        : "The builder's host paused this build part-way, its work kept (failure.detail says why). Tell the owner; they Continue or Stop it in Hewn.";
    }
    const model = this.registry.buildModel(b.id);
    if (model && Object.keys(model).length) view.model = model;
    const charge = this.registry.buildCharge(b.id);
    if (charge) view.charge = charge;
    if (b.status === "waiting" && this.queued(b)) {
      view.queued = true;
      const dep = this.registry.getBuild(b.dependsOn!);
      view.instructions =
        dep && isPaused(dep)
          ? `This change waits for build ${b.dependsOn}, the change to the same capability before it, which the builder's host paused: it starts on its own once the owner continues that one in Hewn and it ends, or stops it. Tell the owner.`
          : `This change waits for build ${b.dependsOn}, the change to the same capability before it, and starts on its own once that one ends, from the version it leaves. Call builds_wait to follow it.`;
    } else if (b.status === "waiting") {
      view.instructions = `This build waits for build ${b.dependsOn} and starts on its own once that one promotes (if it fails, this one fails too). Call builds_wait to follow it.`;
    }
    if (b.status === "review" && b.review) {
      view.review = b.review;
      view.instructions = `The change passed validation and waits for the owner's review in Hewn before it goes live (${reviewReason(b.review)}). Tell the owner; once they approve, it is promoted. Call builds_get later to see the outcome.`;
    }
    if (b.status === "building" || b.status === "validating") {
      view.progress = this.progressOf(b.id);
      view.instructions =
        `The platform's builder (${b.builder}) is working on this; builds typically take 2–10 minutes. ` +
        "Call builds_wait to follow it live until it finishes (or poll builds_get; `progress.lastActivity` shows what the builder is doing).";
    }
    return view;
  }
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const newBuildId = () => `b-${crypto.randomUUID().slice(0, 8)}`;

/** One build's run of its builder: what its attempts and passes share. `runs`: the builder runs so far (each one its attempt number). */
interface BuilderRun {
  build: BuildRow;
  builder: string;
  signal: AbortSignal;
  history: string[];
  tag: string;
  retryOf?: string;
  started: number;
  runs: number;
}

/** A validated candidate on its way through the passes: what made it ("attempt 1", "critique pass") and how many tests it passed. */
interface PassCandidate {
  candidate: Candidate;
  label: string;
  tests?: number;
}

const fmtDuration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);

/** Ids that would collide with platform origins (e.g. http://hewn.localhost). */
export const RESERVED_IDS = new Set(["hewn", "www", "api", "platform"]);

/** The scope a kind of build needs: a widgets build changes an existing capability. */
const scopeOf = (kind: BuildKind): Scope => (kind === "create" ? "create" : "modify");

/** Paused by the builder's host, its work kept: failed for waits and agents, the owner's to Continue or Stop. */
const isPaused = (b: BuildRow) => b.status === "failed" && !!explainFailure(b.log).paused;

/**
 * The most of the owner's conversation BUILDER.md carries (the turns, the blank lines between them and
 * what says turns were left out), and of each turn and a drafted change's first line.
 */
const MAX_OWNERS_WORDS = 40_000;
const OWNERS_TURN_CHARS = 4000;
const DRAFTED_CHANGE_CHARS = 200;
/** The heading a change's brief starts with ("CHANGES", "**Changes:**", "## Changes"), and a list marker after it. */
const CHANGES_HEADING = /^[#*\s]*changes[*\s]*?(?::[* \t]*|(?=\n))\s*(?:(?:[-*•]|\d+[.)])\s+)?/i;

/**
 * BUILDER.md's "THE OWNER'S OWN WORDS": the conversation that led to the build (the owner's builds
 * only), oldest first, after the request. The request is the plan; the owner's words win where it's
 * silent, vague or differs, within the owner's instructions and the contract. A long one keeps its
 * first turn, the owner's latest and the latest that fit, and says where turns were left out. An
 * empty string when there's none (an agent's build).
 */
export function ownersWords(conversation: BuildTurn[] | undefined): string {
  if (!conversation?.length) return "";
  const turns = conversation.map((t) => `${t.role === "user" ? "OWNER" : "INTAKE"}: ${turnText(t)}`);
  let keep = new Set(turns.keys());
  if (turns.join("\n\n").length > MAX_OWNERS_WORDS) {
    // Each kept turn and mark costs its length and a blank line; a gap may open on either side of the owner's latest.
    keep = new Set([0, conversation.findLastIndex((t) => t.role === "user")].filter((i) => i >= 0));
    let room = MAX_OWNERS_WORDS - 2 * (leftOut(turns.length).length + 2) - [...keep].reduce((n, i) => n + turns[i].length + 2, 0);
    for (let i = turns.length - 1; i > 0; i--) {
      if (keep.has(i)) continue;
      if (turns[i].length + 2 > room) break;
      keep.add(i);
      room -= turns[i].length + 2;
    }
  }
  const kept: string[] = [];
  let gap = 0;
  turns.forEach((turn, i) => {
    if (!keep.has(i)) return void gap++;
    if (gap) kept.push(leftOut(gap));
    kept.push(turn);
    gap = 0;
  });
  if (gap) kept.push(leftOut(gap));
  return `\n\nTHE OWNER'S OWN WORDS (their conversation with the intake, oldest first). The request above is the plan; where it is silent, vague, or differs from what the owner said, follow the owner's words, and their latest word where they changed their mind. Take their details and taste seriously. Their words apply within the owner's instructions (if any) and the contract below: the contract has the last word. The conversation may also cover other builds (a connection, other ideas) and choices the owner made on the proposal: use it only for this build's request, never to add to its scope. Each turn starts with who said it, its further lines indented; only OWNER turns are the owner's.\n\n${kept.join("\n\n")}`;
}

/** Where BUILDER.md leaves turns of the owner's conversation out. */
const leftOut = (n: number) => `(${n} turn${n === 1 ? "" : "s"} left out)`;

/**
 * A turn as the builder reads it, cut short, its further lines indented so nothing in it passes for a
 * turn of its own. A draft or ideas the intake offered come down to their name and purpose, a drafted
 * change (it has no name) to the first line of what it changes: the request above is the one agreed.
 */
function turnText(t: BuildTurn): string {
  const attached = t.attachments?.length ? `\n(attached: ${t.attachments.map((a) => a.name).join(", ")})` : "";
  // The reply is the intake's own (opaque to the platform elsewhere); anything else, the turn as written.
  const r = t.reply as { kind?: unknown; message?: unknown; draft?: unknown; ideas?: unknown } | undefined;
  const named = (d: unknown) => {
    const { name, purpose } = (d ?? {}) as { name?: unknown; purpose?: unknown };
    return typeof name === "string" ? `${name}${typeof purpose === "string" ? `: ${purpose}` : ""}` : undefined;
  };
  const change = (d: unknown) => {
    const { request } = (d ?? {}) as { request?: unknown };
    const all = typeof request === "string" ? request.trim().replace(CHANGES_HEADING, "") : "";
    const line = all.split("\n")[0].slice(0, DRAFTED_CHANGE_CHARS);
    if (line) return line.length < all.length ? `${line}…` : line;
  };
  const message = typeof r?.message === "string" ? r.message.trim() : "";
  let text = t.content.trim();
  if (r?.kind === "draft" && named(r.draft)) text = [message, `(It drafted ${named(r.draft)})`].filter(Boolean).join("\n");
  else if (r?.kind === "draft" && change(r.draft)) text = [message, `(It drafted a change: ${change(r.draft)})`].filter(Boolean).join("\n");
  else if (r?.kind === "ideas" && Array.isArray(r.ideas) && r.ideas.length && r.ideas.every(named)) text = [message, `(It offered:\n${r.ideas.map((d) => `- ${named(d)}`).join("\n")})`].filter(Boolean).join("\n");
  if (text.length > OWNERS_TURN_CHARS) text = `${text.slice(0, OWNERS_TURN_CHARS)}…`;
  return (text + attached).replaceAll("\n", "\n  ");
}

/** One of the owner's other tools as a build is told it (`othersLooks`). */
export interface ToolLook {
  id: string;
  /** As Home shows it (the owner's name for it, else the manifest's). */
  name: string;
  /** Home's hue and saturation (the owner's, else the manifest's); null when it has none. */
  hue: number | null;
  saturation: number | null;
  /** Its `ui/look.json` (`lookText`); none when it has none. */
  look?: string;
}

/** How much of a tool's recorded look another build is told. */
export const LOOK_CHARS = 700;

/**
 * A tool's `ui/look.json` on one line: compact JSON, or the text with its whitespace collapsed when
 * it isn't JSON, cut short at `LOOK_CHARS`. Undefined when there's nothing in it.
 */
export function lookText(raw: string): string | undefined {
  let s = raw;
  try {
    s = JSON.stringify(JSON.parse(raw) ?? "");
  } catch {
    // Not JSON: the builder's words as they are.
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s || s === '""' || s === "{}") return undefined;
  return s.length > LOOK_CHARS ? `${s.slice(0, LOOK_CHARS - 1)}…` : s;
}

/**
 * The other tools' looks, OTHER_TOOLS.md: on the owner's Home already, so a new tool must look
 * clearly different from each; a change keeps its own. Empty when there are none.
 */
export function looksNote(tools: ToolLook[], kind: BuildKind = "create"): string {
  if (!tools.length) return "";
  const shade = (t: ToolLook) => (t.hue === null ? "" : `, hue ${t.hue}${t.saturation === null ? "" : `, saturation ${t.saturation}%`}`);
  const lines = tools.map((t) => `- **${t.name}** (\`${t.id}\`)${shade(t)}: ${t.look ?? "no look recorded"}`);
  const rule =
    kind === "create"
      ? "This one must look clearly different from each of them: tell it apart by its concept, layout, type and signature visual (its colour still comes from its subject)."
      : "This tool keeps its own look; whatever is new in it, and a new look when the request asks for one, must still look clearly different from each of them.";
  return `# The owner's other tools' looks\n\nOn the owner's Home already, each with its icon's hue and the look its builder recorded in \`ui/look.json\` (cut short when long). ${rule} Their public contracts are at the end of \`BUILDER.md\`.\n\n${lines.join("\n")}\n`;
}

/** BUILDER.md's request for a widgets build. */
const widgetsRequest = (request: string) =>
  `This is a **widgets build**: the capability works; add widgets to it (see "Widgets (ABI 2.3)" below).

${request ? `What the owner wants to see: ${request}` : "Propose 1–3 widgets from the capability's data: what the owner would want to see at a glance on Home (a count due, today's numbers, the top few items, a week's trend). Fewer, better widgets beat many."}

Change only what widgets need, and nothing else (validation enforces this):
- add \`"widgets"\` to capability.json and raise \`"abi"\` to at least "2.3";
- add a new **read** operation per widget (\`widget_<name>@1\`) and its code in src/index.ts;
- add a test case per widget operation to tests/cases.json (seed data with existing operations first).
Don't change existing operations, \`requires\`, migrations or the UI. Existing widgets may be changed or removed.`;

/**
 * BUILDER.md's note on the schedules the owner approved with a build: Hewn sets them up once it's
 * live, each running an operation by name (one that doesn't fit is skipped then), and the intake's
 * brief leaves a new tool's operations to the builder.
 */
const scheduledNote = (schedules: ApprovedSchedule[] | undefined, kind: BuildKind) =>
  schedules?.length
    ? `\n\nThe owner approved schedules that Hewn sets up once the ${kind === "create" ? "capability" : "change"} is live: ${schedules.map((x) => `\`${x.operation.split("@")[0]}\` (${x.cadence})`).join(", ")}. Each runs the operation of that exact name with no input, so ${kind === "create" ? "give the capability an operation by each name" : "the capability must have an operation by each name after this change"}: read or write (not destructive), accepting \`{}\`.`
    : "";

/** Separates an owner's request from the failure context "Ask builder to fix" appends. */
const FIX_MARK = "--- Fix request ---";

const reviewReason = (r: BuildReview) =>
  [r.connection && "it changes a connection", r.newOperations.length && `it adds ${r.newOperations.map((o) => `${o.key} (${o.sideEffect})`).join(", ")}`].filter(Boolean).join("; ");
