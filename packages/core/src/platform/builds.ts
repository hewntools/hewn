// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds: every change to a capability. Requests (create, modify, widgets, install), the order they
// run in, the builder's attempts with their live steps, retries and cancels, the owner's review, and
// what a build shows and keeps.
import { type Agent, canSee, requireOwner, requireScope, type Scope } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { type BuildFailure, explainFailure, testCounts } from "../failure.ts";
import { bytes, contentHash, decodeVersion, text, versionFiles } from "../files.ts";
import { cellsFromSvg, glyphSvg } from "../glyph.ts";
import { ABI, type CapabilityManifest, DEFAULT_ABI, isConnection, type ToolSource } from "../manifest.ts";
import { saneCharge } from "../models.ts";
import { EFFORT, MODEL_NAME } from "../build-models.ts";
import type { Files } from "../ports.ts";
import type { BuildContext, BuildFeedback, BuildKind, BuildModel, BuildReview, BuildRow, BuildTurn } from "../registry.ts";
import { sha256 } from "../sha256.ts";
import { MAX_SATURATION } from "./presentation.ts";
import { attachmentRefs } from "./attachments.ts";
import type { ApprovedSchedule } from "./schedules.ts";
import { Domain, type Shared } from "./context.ts";
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

/** Pipeline steps as the owner sees them: (waiting for another build →) spec agreed → writing code → running tests → your authorization. */
export type BuildStep = "waiting" | "spec" | "code" | "tests" | "auth" | "done";

export interface BuildStepState {
  step: BuildStep;
  tests?: { passed: number; total: number };
  /** 0–1, from real milestones only: spec 0.1, code 0.1 (no measure), tests 0.5→0.9 by cases run, auth 0.95. */
  progress: number;
}

type CreateRequest = {
  name: string;
  purpose: string;
  requirements: string;
  kind?: "capability" | "connection";
  /** The build it waited for. */
  after?: string;
  retryOf?: string;
  /** Installed from a file (or the hub): where it came from, kept as the capability's record once it promotes. */
  source?: ToolSource;
  /** Replay its sample data once it's live. */
  sample?: boolean;
} & ModelAsk;

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
  private steps = new Map<string, { capabilityId: string; step: BuildStep; tests?: { passed: number; total: number }; since: number }>();

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
      if (!b.builder || (b.request as { autoRetryOf?: string }).autoRetryOf || !this.platform.builderFor()) continue;
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
    this.steps.set(buildId, { capabilityId, step, tests, since: Date.now() });
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
      auth: 0.95,
      done: 1,
    }[s.step];
    return { step: s.step, ...(s.tests ? { tests: s.tests } : {}), progress: Math.round(progress * 100) / 100 };
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
   * end ("capability changed since this build started"), so it waits until that one is done.
   */
  noChangeOnItsWay(capabilityId: string, what: string) {
    const ahead = this.registry.unfinishedBuild(capabilityId);
    if (ahead) throw new PlatformError("conflict", `a change to ${capabilityId} is on its way (build ${ahead.id}); ${what} once it's done`);
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
    const { widgets, conversation: turns, ...rest } = req;
    const conversation = this.checkConversation(agent, turns);
    this.d.schedules.checkApprovedSchedules(agent, req.schedules);
    if (widgets && req.kind === "connection") throw new PlatformError("invalid_request", "a connection has no widgets");
    const b = await this.createBuild(agent, rest, conversation);
    if (!widgets) return b;
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
    if (existing) throw new PlatformError("conflict", `capability '${id}' already exists`);
    if (req.kind !== undefined && req.kind !== "capability" && req.kind !== "connection") throw new PlatformError("invalid_request", 'kind must be "capability" or "connection"');
    const dependsOn = this.dependency(agent, req.after);
    const { after: _after, ...request } = req;
    return this.openCreateBuild(agent, id, { ...request, ...(dependsOn ? { after: dependsOn } : {}) }, true, undefined, undefined, dependsOn, conversation);
  }

  /** The build a new one should wait for (`after`, following retries), or undefined to start now. */
  private dependency(agent: Agent, after?: string): string | undefined {
    if (!after) return undefined;
    requireScope(agent, "create", "modify");
    this.visibleBuild(agent, after);
    const dep = this.currentBuild(after);
    if (dep.status === "promoted") return undefined;
    if (dep.status === "failed" || dep.status === "cancelled") throw new PlatformError("conflict", `build ${dep.id} (${dep.kind} ${dep.capabilityId}), which this would wait for, ${dep.status}; retry it first`);
    return dep.id;
  }

  /**
   * The build to queue a change behind: the newest unfinished one of the same capability, so two
   * changes never run at once (the second would fail at the end: "capability changed since this
   * build started"). A change waiting for the owner's review doesn't hold others up. Not for an
   * automatic retry: it takes the place of the build it retries, and what queued behind that one
   * waits for it.
   */
  private queueBehind(capabilityId: string, req: object): string | undefined {
    if ("autoRetryOf" in req) return undefined;
    return this.registry.unfinishedBuild(capabilityId)?.id;
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
   * waits for the owner's review.
   */
  private async releaseDependents(buildId: string) {
    const dep = this.registry.getBuild(buildId);
    if (!dep) return;
    for (const listed of this.registry.waitingBuilds(buildId)) {
      // Re-read: an earlier start awaited, and this one may have been cancelled meanwhile.
      const b = this.mustBuild(listed.id);
      if (b.status !== "waiting") continue;
      // Waiting for the owner's review: what needs it keeps waiting (approve or reject releases it).
      if (dep.status === "review" && !this.queued(b)) continue;
      if (dep.status !== "promoted" && !this.queued(b)) {
        this.failBuild(b.id, `build ${buildId}, which it waited for, ${dep.status}; retry that one, then this one`);
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

  /** A create build for `id` (newly reserved, or retrying a create that never promoted). */
  private async openCreateBuild(agent: Agent, id: string, req: CreateRequest, reserve: boolean, builderOverride?: string, seed?: Files, dependsOn?: string, conversation?: BuildTurn[]): Promise<BuildView> {
    const builder = builderOverride ?? this.requireBuilder();
    const model = this.modelFor(agent, builder, req);
    const buildId = newBuildId();
    this.registry.transaction(() => {
      if (reserve) this.registry.insertCapability({ id, name: req.name, purpose: req.purpose, createdBy: agent.id });
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
    this.buildEvent(buildId, queued ? `waiting for build ${dependsOn}, the change to ${capabilityId} before it; starts when it ends` : `waiting for build ${dependsOn} (${dep.kind} ${dep.capabilityId}); starts when it promotes`, tag);
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
      "BUILDER.md": bytes(this.brief_("create", id, `${connection ? 'Build a connection ("kind": "connection"; see "Connections" below).\n\n' : ""}Requirements: ${req.requirements}${attached.note}`, this.registry.buildContext(buildId)?.instructions)),
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
  async install(owner: Agent, req: { name: string; purpose: string; builder: string; id?: string; seed?: Files; requirements?: string; source?: ToolSource; sample?: boolean }): Promise<BuildView> {
    requireOwner(owner);
    const id = req.id ?? slugify(req.name);
    const existing = this.registry.getCapability(id);
    if (existing?.activeVersion || existing?.archivedAt) throw new PlatformError("conflict", `capability '${id}' already exists`);
    const request: CreateRequest = { name: req.name, purpose: req.purpose, requirements: req.requirements ?? `install (${req.builder})`, ...(req.source ? { source: req.source } : {}), ...(req.sample ? { sample: true } : {}) };
    return this.openCreateBuild(owner, id, request, !existing, req.builder, req.seed);
  }

  /** `after`: a build to wait for first (e.g. adding the operation this change needs to a connection). */
  async modify(agent: Agent, req: { capabilityId: string; request: string; after?: string; schedules?: ApprovedSchedule[]; conversation?: BuildTurn[] } & ModelAsk): Promise<BuildView> {
    requireScope(agent, "modify");
    await this.checkEffort(agent, req);
    this.d.schedules.checkApprovedSchedules(agent, req.schedules);
    const conversation = this.checkConversation(agent, req.conversation);
    const cap = this.visibleActive(agent, req.capabilityId);
    const builder = this.requireBuilder();
    const model = this.modelFor(agent, builder, req);
    const after = this.dependency(agent, req.after);
    const dependsOn = after ?? this.queueBehind(cap.id, req);
    const { after: _after, conversation: _turns, ...rest } = req;
    const request = { ...rest, ...(after ? { after } : {}) };
    const buildId = newBuildId();
    this.registry.transaction(() => {
      this.registry.insertBuild({ id: buildId, capabilityId: cap.id, kind: "modify", request, requestedBy: agent.id, baseVersion: dependsOn ? null : cap.activeVersion, builder, dependsOn });
      this.registry.setBuildModel(buildId, model);
      this.recordContext(buildId, cap.id, conversation);
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
  async addWidgets(agent: Agent, req: { capabilityId: string; request?: string; after?: string; conversation?: BuildTurn[] } & ModelAsk): Promise<BuildView> {
    requireScope(agent, "modify");
    await this.checkEffort(agent, req);
    const conversation = this.checkConversation(agent, req.conversation);
    const after = this.dependency(agent, req.after);
    const cap = after ? this.registry.getCapability(req.capabilityId) : this.visibleActive(agent, req.capabilityId);
    if (!cap || cap.archivedAt || !canSee(agent, cap.id)) throw new PlatformError("not_found", `no capability ${req.capabilityId}`);
    if (cap.activeVersion && isConnection(this.activeManifest(cap.id))) throw new PlatformError("invalid_request", `${cap.id} is a connection; connections have no widgets`);
    const builder = this.requireBuilder();
    const model = this.modelFor(agent, builder, req);
    const dependsOn = after ?? this.queueBehind(cap.id, req);
    const { after: _after, conversation: _turns, ...rest } = req;
    const request = { ...rest, capabilityId: cap.id, request: rest.request?.trim() ?? "", ...(after ? { after } : {}) };
    const buildId = newBuildId();
    this.registry.transaction(() => {
      this.registry.insertBuild({ id: buildId, capabilityId: cap.id, kind: "widgets", request, requestedBy: agent.id, baseVersion: dependsOn ? null : cap.activeVersion, builder, dependsOn });
      this.registry.setBuildModel(buildId, model);
      this.recordContext(buildId, cap.id, conversation);
    });
    if (dependsOn) this.waitFor(buildId, cap.id, dependsOn, `build ${buildId} [widgets ${cap.id} by ${agent.id}]`, !after);
    else await this.startModify(buildId);
    return this.buildView(this.registry.getBuild(buildId)!);
  }

  /** Open a modify (or widgets) build's workspace from the active version (at start time) and start its builder. */
  private async startModify(buildId: string) {
    const b = this.mustBuild(buildId);
    // Another change to this capability started while this one waited for its `after`: its turn comes after that one.
    const ahead = this.registry.unfinishedBuild(b.capabilityId, { running: true, except: buildId });
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
    const ask = `${b.kind === "widgets" ? widgetsRequest(request) : `Requested change: ${request}`}${attached.note}`;
    // versionFiles: versions stored before builder configuration was dropped may still carry it.
    await this.workbench.open(buildId, { ...versionFiles(base.files), "BUILDER.md": bytes(this.brief_(b.kind, cap.id, ask, this.registry.buildContext(buildId)?.instructions)), ...attached.files, ...this.agentsFile(buildId), ...(await this.designSystemFile()) });
    if (this.cancelledWhileOpening(buildId)) return;
    this.buildEvent(buildId, `opened from v${cap.activeVersion}, builder: ${b.builder}`, `build ${buildId} [${b.kind} ${cap.id} by ${b.requestedBy}]`);
    this.setStep(buildId, cap.id, "spec");
    this.startBuilder(buildId, b.builder!);
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
    const req: Record<string, any> = { ...old.request, retryOf: old.id };
    delete req.autoRetryOf;
    // An automatic retry (after a restart) runs on what was asked; an agent's own retry is checked
    // again, so a model the owner has unticked since isn't used.
    if (opts.auto) this.trustedAsks.add(req);
    if (opts.auto) req.autoRetryOf = old.id;
    if (opts.fix) {
      // "Ask builder to fix": the same request plus why the last build failed.
      const f = explainFailure(old.log);
      const context = `${FIX_MARK}\nThe previous build failed: ${f.title}. ${f.detail}\nIts validation log ended with:\n${old.log.slice(-8).join("\n")}`;
      const field = old.kind === "create" ? "requirements" : "request";
      req[field] = `${String(req[field] ?? "").split(FIX_MARK)[0].trimEnd()}\n\n${context}`;
    }
    if (old.kind === "modify" && old.request.manifestOnly) throw new PlatformError("conflict", "this was a model replacement; replace the model again instead of retrying");
    const next = await (async () => {
      if (old.kind === "modify") return this.modify(agent, req as { capabilityId: string; request: string; after?: string });
      if (old.kind === "widgets") return this.addWidgets(agent, req as { capabilityId: string; request?: string; after?: string });
      const cap = this.registry.getCapability(old.capabilityId);
      if (cap?.activeVersion) throw new PlatformError("conflict", `${old.capabilityId} has been created since; request a modification instead`);
      // An install retries with the same copy builder.
      const builder = old.builder?.startsWith("copy:") ? old.builder : undefined;
      const dependsOn = this.dependency(agent, req.after);
      if (!dependsOn) delete req.after;
      else req.after = dependsOn;
      return this.openCreateBuild(agent, old.capabilityId, req as CreateRequest, !cap, builder, undefined, dependsOn);
    })();
    // The conversation that led to the first try goes with the retry.
    const conversation = this.registry.buildContext(old.id)?.conversation;
    if (conversation) this.registry.setBuildContext(next.buildId, { conversation });
    return next;
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
    if (build.status !== "building" && build.status !== "open" && build.status !== "waiting" && build.status !== "review") throw new PlatformError("conflict", `build is already ${build.status}`);
    const line = `CANCELLED by ${agent.id}`;
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

  /** A build the agent may see: of a capability it can see, or one it requested. Else not found. */
  private visibleBuild(agent: Agent, buildId: string): BuildRow {
    const b = this.registry.getBuild(buildId);
    if (!b || (!canSee(agent, b.capabilityId) && b.requestedBy !== agent.id)) throw new PlatformError("not_found", `no build '${buildId}'`);
    return b;
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

  /** Validate the workspace candidate and promote it if everything passes. Never throws. */
  private async validate(build: BuildRow, submitter: string): Promise<{ version?: number; review?: BuildReview; log: string[] }> {
    this.registry.updateBuild(build.id, { status: "validating" });
    const log: string[] = [];
    const step = (message: string) => {
      log.push(message);
      this.buildEvent(build.id, message, `build ${build.id} [${build.kind} ${build.capabilityId}, submitted by ${submitter}]`);
    };
    step("validating candidate");
    try {
      const r = await this.d.validation.validateAndPromote(build, step, (passed, total) => this.setStep(build.id, build.capabilityId, "tests", { passed, total }));
      if ("review" in r) {
        step(`passed; waiting for the owner's review before it goes live (${reviewReason(r.review)})`);
        return { review: r.review, log };
      }
      const version = r.version;
      step(`promoted: implementation v${version} is now active`);
      this.d.schedules.applyApprovedSchedules(build, step);
      await this.d.sharing.afterInstall(build, step);
      this.setStep(build.id, build.capabilityId, this.platform.readiness(build.capabilityId).ready ? "done" : "auth", this.steps.get(build.id)?.tests);
      return { version, log };
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
        const log = [...this.mustBuild(buildId).log, `FAILED: ${(e as Error).message}`];
        this.registry.updateBuild(buildId, { status: "failed", log });
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

  /** Builder writes, platform validates; retry with feedback. */
  private async runBuilder(buildId: string, builder: string, signal: AbortSignal) {
    const build = this.mustBuild(buildId);
    const max = Math.max(1, this.platform.maxBuildAttempts());
    const history: string[] = [];
    let feedback: string | undefined;
    const tag = `build ${buildId} [${build.kind} ${build.capabilityId}, requested by ${build.requestedBy}]`;

    // Cancelled: cancelBuild already recorded it; just stop.
    const cancelled = () => signal.aborted;
    // The clock runs from the first attempt: a retry after a failed validation doesn't start it over.
    const buildStarted = Date.now();
    for (let attempt = 1; attempt <= max; attempt++) {
      if (cancelled()) return;
      this.registry.updateBuild(buildId, { status: "building", log: history });
      const started = Date.now();
      const live: { attempt: number; maxAttempts: number; startedAt: number; lastActivity?: string; lastActivityAt?: number } = { attempt, maxAttempts: max, startedAt: buildStarted };
      this.progress.set(buildId, live);
      this.setStep(buildId, build.capabilityId, "code");
      this.buildEvent(buildId, `builder ${builder} working (attempt ${attempt}/${max})`, tag);
      const heartbeat = setInterval(() => {
        const p = this.progressOf(buildId);
        if (!p) return;
        const last = p.lastActivity ? `last: ${p.lastActivity} (${p.secondsSinceActivity}s ago)` : "no activity yet";
        this.logger(`${tag} ${builder} ${fmtDuration(p.elapsedSeconds)} · ${last}`);
      }, this.platform.heartbeatMs);
      (heartbeat as { unref?: () => void }).unref?.();
      try {
        const asked = this.registry.buildModel(buildId);
        await this.workbench.build(
          { buildId, capabilityId: build.capabilityId, kind: build.kind, builder, attempt, feedback, ...(asked?.model ? { model: asked.model } : {}), ...(asked?.effort ? { effort: asked.effort } : {}) },
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
          },
        );
      } catch (e) {
        if (cancelled()) return;
        if ((e as { interrupted?: boolean }).interrupted) {
          // Lost the builder's machine side (Hewn restarting?). Don't burn the next attempts on it at
          // once: if this process goes away meanwhile, the build is still "building" and the restart
          // retries it; if it's still here after a while, it counts as one failed attempt.
          this.buildEvent(buildId, `attempt ${attempt}: lost the connection to the builder (${(e as Error).message}); waiting before going on`, tag);
          await new Promise((ok) => setTimeout(ok, this.platform.interruptWaitMs));
          if (cancelled()) return;
        }
        if ((e as { modelUnavailable?: boolean }).modelUnavailable) {
          // The model asked for can't run (retired, misspelled, not on this account): nothing is built.
          const line = `FAILED: model unavailable: ${(e as Error).message}`;
          history.push(line);
          this.buildEvent(buildId, line, tag);
          this.registry.updateBuild(buildId, { status: "failed", log: history });
          return;
        }
        if ((e as { refused?: boolean }).refused) {
          // The builder's host declined it (e.g. over the month's builds): say why, don't retry.
          const line = `FAILED: refused: ${(e as Error).message}`;
          history.push(line);
          this.buildEvent(buildId, line, tag);
          this.registry.updateBuild(buildId, { status: "failed", log: history });
          return;
        }
        const msg = `attempt ${attempt}: builder ${builder} failed: ${(e as Error).message}`;
        history.push(msg);
        this.buildEvent(buildId, msg, tag);
        if ((e as { unavailable?: boolean }).unavailable) {
          // Retrying can't help (e.g. not logged in); fail now with a clear next step.
          history.push(`FAILED: builder ${builder} is unavailable. Fix it, then retry this build.`);
          this.buildEvent(buildId, `FAILED: builder ${builder} is unavailable. Fix it, then retry this build.`, tag);
          this.registry.updateBuild(buildId, { status: "failed", log: history });
          return;
        }
        continue;
      } finally {
        clearInterval(heartbeat);
      }
      if (cancelled()) return;
      history.push(`attempt ${attempt}: builder ${builder} finished in ${Math.round((Date.now() - started) / 1000)}s`);
      this.assertSubmittable(build);
      const { version, review, log } = await this.validate(build, `builder ${builder}`);
      history.push(...log.map((l) => `attempt ${attempt}: ${l}`));
      if (review) {
        this.registry.updateBuild(buildId, { status: "review", review, log: history });
        this.logger(`${tag} waits for the owner's review (${reviewReason(review)})`);
        return;
      }
      if (version) {
        this.registry.updateBuild(buildId, { status: "promoted", resultVersion: version, log: history });
        return;
      }
      feedback = log.join("\n");
    }
    history.push(`FAILED: no valid candidate after ${max} attempts`);
    this.buildEvent(buildId, `FAILED: no valid candidate after ${max} attempts`, tag);
    this.registry.updateBuild(buildId, { status: "failed", log: history });
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

  /** BUILDER.md: the request, the owner's instructions as the build recorded them (`build_context`), the brief, the catalog. */
  private brief_(kind: BuildKind, id: string, request: string, instructions = ""): string {
    const submit = "When the candidate is complete, stop. The platform validates it automatically. If validation fails, you are run again with the failure log.";
    return `# Build: ${kind} \`${id}\`\n\n${request}\n\n${instructions ? `${instructions}\n` : ""}${this.brief.replace("{{SUBMIT}}", submit).replaceAll("{{ABI}}", ABI)}${this.catalogForBuilder(id)}`;
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
    if (b.log.some((l) => l.includes("(screenshot attached)"))) view.screenshot = true;
    const step = this.stepState(b.id);
    if (step && (b.status === "waiting" || b.status === "open" || b.status === "building" || b.status === "validating")) view.step = step;
    const tests = testCounts(b.log);
    if (tests) view.tests = tests;
    if (b.status === "failed") view.failure = explainFailure(b.log);
    const model = this.registry.buildModel(b.id);
    if (model && Object.keys(model).length) view.model = model;
    const charge = this.registry.buildCharge(b.id);
    if (charge) view.charge = charge;
    if (b.status === "waiting" && this.queued(b)) {
      view.queued = true;
      view.instructions = `This change waits for build ${b.dependsOn}, the change to the same capability before it, and starts on its own once that one ends, from the version it leaves. Call builds_wait to follow it.`;
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

const fmtDuration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);

/** Ids that would collide with platform origins (e.g. http://hewn.localhost). */
export const RESERVED_IDS = new Set(["hewn", "www", "api", "platform"]);

/** The scope a kind of build needs: a widgets build changes an existing capability. */
const scopeOf = (kind: BuildKind): Scope => (kind === "create" ? "create" : "modify");

/** BUILDER.md's request for a widgets build. */
const widgetsRequest = (request: string) =>
  `This is a **widgets build**: the capability works; add widgets to it (see "Widgets (ABI 2.3)" below).

${request ? `What the owner wants to see: ${request}` : "Propose 1–3 widgets from the capability's data: what the owner would want to see at a glance on Home (a count due, today's numbers, the top few items, a week's trend). Fewer, better widgets beat many."}

Change only what widgets need, and nothing else (validation enforces this):
- add \`"widgets"\` to capability.json and raise \`"abi"\` to at least "2.3";
- add a new **read** operation per widget (\`widget_<name>@1\`) and its code in src/index.ts;
- add a test case per widget operation to tests/cases.json (seed data with existing operations first).
Don't change existing operations, \`requires\`, migrations or the UI. Existing widgets may be changed or removed.`;

/** Separates an owner's request from the failure context "Ask builder to fix" appends. */
const FIX_MARK = "--- Fix request ---";

const reviewReason = (r: BuildReview) =>
  [r.connection && "it changes a connection", r.newOperations.length && `it adds ${r.newOperations.map((o) => `${o.key} (${o.sideEffect})`).join(", ")}`].filter(Boolean).join("; ");
