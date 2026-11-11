// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds: every change to a capability. Requests (create, modify, widgets, install), the order they
// run in, the builder's attempts with their live steps, retries and cancels, the owner's review, and
// what a build shows and keeps.
import { type Agent, canSee, requireOwner, requireScope, type Scope } from "../auth.ts";
import { type CodeFile, codeFiles, type CodeText, codeText } from "../code.ts";
import { PlatformError } from "../errors.ts";
import { type BuildFailure, explainFailure, testCounts } from "../failure.ts";
import { bytes, contentHash, decodeVersion, text, versionFiles } from "../files.ts";
import { cellsFromSvg, glyphSvg } from "../glyph.ts";
import type { BundleSummary } from "../bundle.ts";
import { ABI, callableOperations, type CapabilityManifest, DEFAULT_ABI, isConnection, newestByName, offeredOperations, type OperationManifest, opKey, SIDE_EFFECTS, stampSource, type ToolSource } from "../manifest.ts";
import { saneCharge } from "../models.ts";
import { EFFORT, MODEL_NAME } from "../build-models.ts";
import type { BuildPass, Files } from "../ports.ts";
import { isPolish, type Pass, PASS_TRIES, PASSES, POLISH_KEEPS, passRequest } from "../passes.ts";
import { SAMPLE_FILE } from "../bundle.ts";
import type { BuildContext, BuildFeedback, BuildKind, BuildModel, BuildReview, BuildRow, BuildTurn } from "../registry.ts";
import { sha256 } from "../sha256.ts";
import { MAX_SATURATION } from "./presentation.ts";
import { attachmentRefs } from "./attachments.ts";
import type { ApprovedSchedule } from "./schedules.ts";
import { Domain, type Shared } from "./context.ts";
import { type Candidate, reviewShotKey } from "./validation.ts";
import { candidateFiles } from "./submissions.ts";
import { skillText } from "../skill.ts";
import type { PlatformOptions } from "../platform.ts";
import spec from "@hewntools/spec/package.json" with { type: "json" };

export interface BuildView {
  buildId: string;
  capabilityId: string;
  kind: BuildKind;
  status: BuildRow["status"];
  request: Record<string, unknown>;
  requestedBy: string;
  /** The platform builder that implements it (never the requesting agent); "submitted" when a client handed the files over. */
  builder: string;
  /** Builder "submitted": the client that wrote it, by the name the owner knows it by ("Claude Code"). */
  submittedBy?: string;
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
  /**
   * How long the build has spent in each step it reached, in seconds (to a tenth), the current one so
   * far; a step it came back to (a retry's code and tests) adds up. Hewn's own clock, so a page opened
   * part-way shows the same.
   */
  seconds: Partial<Record<BuildStep, number>>;
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
  /** Submitted (builder "submitted"): the client that wrote it, by its name in Hewn. Hewn writes it, never the client. */
  submittedBy?: string;
} & ModelAsk &
  RetryMarks;

/**
 * A candidate handed to Hewn ready-made (`Builds.submit`): a client's, through `capabilities_submit`
 * (builder "submitted"), or an install from a file, a link or Hewn's own tools (builder "bundle", the
 * owner's). No builder runs; the files go through validation as any build's.
 */
export interface SubmitEntry {
  /** The candidate: a tool's files, nothing Hewn never keeps (`candidateFiles` refuses the rest, naming the rule). */
  files: Files;
  /** A change to this tool, on its active version; absent: a new tool. */
  capabilityId?: string;
  /** A new tool's id and name (an install takes them from the name the owner typed). Default: capability.json's. */
  id?: string;
  name?: string;
  builder: "submitted" | "bundle";
  /** Builder "submitted": the client's name in Hewn, for Activity and the build. */
  submittedBy?: string;
  /** What it is or changes, in the requester's words: kept with the build. */
  request: string;
  /** Installs only: where it came from (stamped into capability.json), its sample data to replay once live, the reading kept with it. */
  source?: ToolSource;
  sample?: boolean;
  summary?: BundleSummary;
  /** The version the files were written on: a change while the tool is at another one is refused. */
  baseVersion?: number;
}

/** The longest request text a submission keeps. */
const MAX_SUBMIT_REQUEST = 20_000;

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
/** The longest note the owner may give a Polish ("try a bolder look"). */
const MAX_POLISH_NOTE = 2000;

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
  private steps = new Map<string, { capabilityId: string; step: BuildStep; tests?: { passed: number; total: number }; since: number; spent: Partial<Record<BuildStep, number>>; passes?: Pass[] }>();

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
      // An install from a file, or a client's submission, has no builder to run again: the file is installed again, the client submits again.
      if (!b.builder || b.builder === "bundle" || b.builder === "submitted" || (b.request as { autoRetryOf?: string }).autoRetryOf || !this.platform.builderFor()) continue;
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

  /** Any build queued or running (its builder, a pass, a check, the remote builder): not one paused for the owner. */
  busy(): boolean {
    return this.running.size > 0;
  }

  private setStep(buildId: string, capabilityId: string, step: BuildStep, tests?: { passed: number; total: number }) {
    const prev = this.steps.get(buildId);
    const now = Date.now();
    // The time in the step it leaves goes on that step's count; staying in a step (tests counting up) keeps its start.
    const spent = { ...prev?.spent };
    if (prev && prev.step !== step) spent[prev.step] = (spent[prev.step] ?? 0) + (now - prev.since);
    this.steps.set(buildId, { capabilityId, step, tests, since: prev?.step === step ? prev.since : now, spent, ...(prev?.passes ? { passes: prev.passes } : {}) });
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
    const ms: Partial<Record<BuildStep, number>> = { ...s.spent, [s.step]: (s.spent[s.step] ?? 0) + (Date.now() - s.since) };
    const seconds = Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v / 100) / 10]));
    return { step: s.step, ...(s.tests ? { tests: s.tests } : {}), progress: Math.round(progress * 100) / 100, ...(s.passes ? { passes: s.passes } : {}), seconds };
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
    if (ahead) throw new PlatformError("conflict", `a change to ${capabilityId} is on its way (build ${ahead.id}); ${what} once it's done`, { buildId: ahead.id });
    const paused = this.pausedBuild(capabilityId, "change");
    if (paused) throw new PlatformError("conflict", `a change to ${capabilityId} is paused (build ${paused.id}); ${what} once it's continued and done, or stopped`, { buildId: paused.id });
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
   * One create of an id at a time: refused while another is waiting, being built or held for the
   * owner, or paused with its work kept (taking the id over would strand it). Not a widgets build chained after it (create
   * with widgets): that one waits for it.
   */
  private oneCreateAtATime(agent: Agent, id: string) {
    const building = this.registry.unfinishedBuild(id, { kind: "create" });
    if (building) throw new PlatformError("conflict", `'${id}' is already being built${this.buildRef(agent, building)}; wait for it, or cancel it`);
    const held = this.registry.buildsInReview().find((b) => b.capabilityId === id && b.kind === "create");
    if (held) throw new PlatformError("conflict", `'${id}' is built and waits for the owner's approval${this.buildRef(agent, held)}`);
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
    if (noBuilderRuns(builder)) return {};
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
    // No builder runs (an install, a submission): the workspace is the candidate, with nothing for a builder to read.
    const reads = !noBuilderRuns(b.builder!);
    const attached = reads ? await this.d.attachments.attachmentsForBuild(buildId) : { note: "", files: {} };
    await this.workbench.open(buildId, {
      ...(seed ? versionFiles(seed) : {
        "capability.json": bytes(JSON.stringify(skeleton, null, 2) + "\n"),
        "src/index.ts": bytes("// See BRIEF.md for the implementation contract.\nexport const operations = {};\n"),
        "tests/cases.json": bytes("[]\n"),
      }),
      ...(reads
        ? {
            "BUILDER.md": bytes(this.builderText("create", id, `${connection ? 'Build a connection ("kind": "connection"; see "Connections" in `BRIEF.md`).\n\n' : ""}Requirements: ${req.requirements}${scheduledNote(req.schedules, "create")}${attached.note}`, this.registry.buildContext(buildId))),
            ...this.briefFile(),
            ...this.ownersWordsFile(buildId),
            ...this.contractFiles(id),
            ...(connection ? {} : await this.looksFile(id, "create")),
            ...attached.files,
            ...this.agentsFile(buildId),
            ...(await this.designSystemFile()),
          }
        : {}),
    });
    if (this.cancelledWhileOpening(buildId)) return;
    this.buildEvent(buildId, `opened${req.retryOf ? ` (retry of ${req.retryOf})` : ""}, ${b.builder === "submitted" ? `submitted by ${req.submittedBy ?? b.requestedBy}` : `builder: ${b.builder}`}`, `build ${buildId} [create ${id} by ${b.requestedBy}]`);
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

  /**
   * A candidate handed over ready-made (`SubmitEntry`): no builder runs, and the files go through
   * validation as any build's, then promote or wait (the owner's approval, grants) as any build does.
   * A client's (builder "submitted", scope `create` or `modify`), or an install's (builder "bundle",
   * the owner's). A change is written on the tool's active version, so one is refused while another
   * change is on its way, or when the files were written on another version (`baseVersion`).
   */
  async submit(actor: Agent, entry: SubmitEntry): Promise<BuildView> {
    const change = entry.capabilityId !== undefined;
    requireScope(actor, change ? "modify" : "create");
    if (entry.builder === "bundle") requireOwner(actor);
    else if (entry.builder !== "submitted") throw new PlatformError("invalid_request", 'builder must be "submitted" or "bundle"');
    if (entry.builder === "submitted" && (entry.source || entry.sample || entry.summary)) throw new PlatformError("invalid_request", "only an install has a source, sample data to replay, or a reading");
    if (typeof entry.request !== "string" || !entry.request.trim()) throw new PlatformError("invalid_request", "request: what the tool is, or what the change does, in a sentence or two (kept with the build)");
    if (entry.request.length > MAX_SUBMIT_REQUEST) throw new PlatformError("invalid_request", `request: at most ${MAX_SUBMIT_REQUEST.toLocaleString("en")} characters`);
    if (entry.baseVersion !== undefined && (!Number.isInteger(entry.baseVersion) || entry.baseVersion < 1)) throw new PlatformError("invalid_request", "baseVersion must be a version number");
    const files = candidateFiles(entry.files);
    const request = entry.request.trim();
    const submittedBy = entry.builder === "submitted" ? (entry.submittedBy ?? actor.id) : undefined;
    if (change) return this.submitChange(actor, entry.capabilityId!, files, { request, builder: entry.builder, submittedBy, baseVersion: entry.baseVersion, source: entry.source });

    const manifest = manifestIn(files);
    const id = entry.id ?? manifest.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new PlatformError("invalid_request", `capability.json's id: lowercase letters, digits and dashes${typeof manifest.name === "string" && slugify(manifest.name) ? ` ("${slugify(manifest.name)}", from its name)` : ""}`);
    if (RESERVED_IDS.has(id)) throw new PlatformError("invalid_request", `'${id}' is reserved; choose another id`);
    const name = entry.name ?? manifest.name;
    if (typeof name !== "string" || !name.trim()) throw new PlatformError("invalid_request", "capability.json needs a name");
    const existing = this.registry.getCapability(id);
    if (existing?.archivedAt) throw new PlatformError("conflict", `'${id}' exists but is deleted (archived); the owner restores it in Hewn, or pick another id`);
    if (existing?.activeVersion) throw new PlatformError("conflict", entry.builder === "submitted" ? `'${id}' already exists; to change it, submit with capabilityId '${id}' (and its files from capabilities_pack)` : `capability '${id}' already exists`);
    // A create that never promoted keeps its id for a retry; this takes it over, unless one is being built (as a create does).
    if (existing) this.oneCreateAtATime(actor, id);
    const renamed = id !== manifest.id || name !== manifest.name || entry.source;
    const seed = renamed ? { ...files, "capability.json": bytes(JSON.stringify(stampSource({ ...manifest, id, name } as CapabilityManifest, entry.source ?? null), null, 2) + "\n") } : files;
    const req: CreateRequest = {
      name,
      purpose: typeof manifest.purpose === "string" ? manifest.purpose : "",
      requirements: request,
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.sample ? { sample: true } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(submittedBy ? { submittedBy } : {}),
    };
    return this.openCreateBuild(actor, id, req, !existing, entry.builder, seed);
  }

  /** A submitted change to a tool (`submit`): written on its active version, so nothing else may be on its way. */
  private async submitChange(actor: Agent, capabilityId: string, files: Files, o: { request: string; builder: SubmitEntry["builder"]; submittedBy?: string; baseVersion?: number; source?: ToolSource }): Promise<BuildView> {
    const cap = this.visibleActive(actor, capabilityId);
    if (o.baseVersion !== undefined && o.baseVersion !== cap.activeVersion) throw new PlatformError("conflict", `${cap.id} is at v${cap.activeVersion} now and your files are from v${o.baseVersion}: fetch capabilities_pack again and make the change on that`);
    this.noChangeOnItsWay(cap.id, "fetch capabilities_pack again and submit once it's done");
    const request = { capabilityId: cap.id, request: o.request, ...(o.source ? { source: o.source } : {}), ...(o.submittedBy ? { submittedBy: o.submittedBy } : {}) };
    const buildId = newBuildId();
    this.registry.transaction(() => {
      this.registry.insertBuild({ id: buildId, capabilityId: cap.id, kind: "modify", request, requestedBy: actor.id, baseVersion: cap.activeVersion, builder: o.builder });
      this.recordContext(buildId, cap.id);
    });
    await this.workbench.open(buildId, files);
    if (this.cancelledWhileOpening(buildId)) return this.buildView(this.mustBuild(buildId));
    this.buildEvent(buildId, `opened from v${cap.activeVersion}, ${o.submittedBy ? `submitted by ${o.submittedBy}` : `builder: ${o.builder}`}`, `build ${buildId} [modify ${cap.id} by ${actor.id}]`);
    this.setStep(buildId, cap.id, "spec");
    this.startBuilder(buildId, o.builder);
    return this.buildView(this.mustBuild(buildId));
  }

  /**
   * What `capabilities_pack` hands a client: what Hewn's builder finds in its workspace besides the
   * brief, the request and the owner's words. The other tools' contracts and looks (only those
   * `visible` lets the client see) and the design system; for a change (`capabilityId`), the tool's
   * active version's files too.
   */
  async packFiles(capabilityId: string | undefined, visible: (id: string) => boolean): Promise<Files> {
    const cap = capabilityId ? this.registry.getCapability(capabilityId) : undefined;
    const base = cap?.activeVersion ? versionFiles((await this.loadVersion(cap.id, cap.activeVersion, { keep: false })).files) : {};
    const connection = cap?.activeVersion ? isConnection(this.activeManifest(cap.id)) : false;
    const exclude = capabilityId ?? "";
    return { ...base, ...this.contractFiles(exclude, visible), ...(connection ? {} : await this.looksFile(exclude, cap ? "modify" : "create", visible)), ...(await this.designSystemFile()) };
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

  /**
   * Polish: a change that runs the passes (critique, then craft) on a tool already live, filled with its
   * sample data; one without any has its builder write it first (`runBuilder`). Owner only: it costs
   * more than a change, and `realData` (the passes see a copy of the tool's own data instead) is
   * theirs to allow. `note`: what the owner asks of it, if anything ("a bolder look"). It keeps the
   * tool's identity unless the note asks for a new look. `conversation`: the owner's with the intake
   * that asked for it (the Change drawer's Polish), kept with the build as a change's is.
   * `marks`: a retry's, from `retryBuild`.
   */
  async polish(owner: Agent, req: { capabilityId: string; note?: string; realData?: boolean; conversation?: BuildTurn[] } & ModelAsk, marks: RetryMarks = {}): Promise<BuildView> {
    requireOwner(owner);
    const conversation = this.checkConversation(owner, req.conversation) ?? this.retried(marks);
    // A retry's note may carry why the last build failed ("Ask builder to fix"), past the owner's own limit.
    if (req.note !== undefined && (typeof req.note !== "string" || (req.note.length > MAX_POLISH_NOTE && !marks.retryOf))) throw new PlatformError("invalid_request", `note: text of at most ${MAX_POLISH_NOTE} characters`);
    if (req.realData !== undefined && typeof req.realData !== "boolean") throw new PlatformError("invalid_request", "realData must be true or false");
    const cap = this.visibleActive(owner, req.capabilityId);
    const manifest = this.activeManifest(cap.id);
    if (isConnection(manifest)) throw new PlatformError("invalid_request", `${cap.id} is a connection; it has no screen to polish`);
    if (!manifest.ui?.available) throw new PlatformError("invalid_request", `${cap.id} has no screen to polish`);
    const builder = this.requireBuilder();
    if (noBuilderRuns(builder)) throw new PlatformError("conflict", "Polish needs a builder (Settings → builder)");
    const model = this.modelFor(owner, builder, req);
    const dependsOn = this.queueBehind(cap.id, marks);
    const note = req.note?.trim() ?? "";
    // `request` as every change has it (what Versions and Activity show); `note` as the owner wrote it.
    const request = { capabilityId: cap.id, request: note ? `Polish: ${note}` : "Polish", ...(note ? { note } : {}), polish: true, ...(req.realData ? { realData: true } : {}), ...pickAsk(req), ...marks };
    const buildId = newBuildId();
    this.registry.transaction(() => {
      this.registry.insertBuild({ id: buildId, capabilityId: cap.id, kind: "modify", request, requestedBy: owner.id, baseVersion: dependsOn ? null : cap.activeVersion, builder, dependsOn });
      this.registry.setBuildModel(buildId, model);
      this.recordContext(buildId, cap.id, conversation);
      this.takePlace(buildId, marks);
    });
    if (dependsOn) this.waitFor(buildId, cap.id, dependsOn, `build ${buildId} [polish ${cap.id} by ${owner.id}]`, true);
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
    const polish = isPolish(b.request);
    const context = this.registry.buildContext(buildId);
    // A Polish's OWNERS_WORDS.md: the conversations that led to the tool as it is, then its own (or its note, without what "Ask builder to fix" added).
    const history = polish ? this.historyOf(cap.id) : [];
    const polishAsk = { note: String(b.request.note ?? "").split(FIX_MARK)[0].trim(), ...(context?.conversation?.length ? { conversation: context.conversation } : {}) };
    const words = polish ? polishWords(history, polishAsk) : "";
    const requestText = polish
      ? polishRequest({
          note: String(b.request.note ?? ""),
          needsSample: !base.files[SAMPLE_FILE],
          // What validation will fill the screenshots with: the owner's own data only when they allowed it and there is some.
          real: b.request.realData === true && (await this.hasOwnData(cap.id, base.code)),
          ...(words ? { ownersWords: { history: history.length > 0, last: polishAsk.conversation ? ("conversation" as const) : polishAsk.note ? ("note" as const) : undefined } } : {}),
        })
      : b.kind === "widgets"
        ? widgetsRequest(request)
        : `Requested change: ${request}`;
    const ask = `${requestText}${scheduledNote((b.request as { schedules?: ApprovedSchedule[] }).schedules, b.kind)}${attached.note}`;
    // versionFiles: versions stored before builder configuration was dropped may still carry it. A Polish's
    // request says where its owner's words are (BUILDER.md's own note on them is for a single conversation).
    await this.workbench.open(buildId, { ...versionFiles(base.files), "BUILDER.md": bytes(this.builderText(b.kind, cap.id, ask, polish && context ? { ...context, conversation: undefined } : context)), ...this.briefFile(), ...(polish ? (words ? { "OWNERS_WORDS.md": bytes(words) } : {}) : this.ownersWordsFile(buildId)), ...this.contractFiles(cap.id), ...(isConnection(this.activeManifest(cap.id)) ? {} : await this.looksFile(cap.id, b.kind)), ...attached.files, ...this.agentsFile(buildId), ...(await this.designSystemFile()) });
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
    if (old.builder === "submitted") throw new PlatformError("conflict", `${old.request.submittedBy ?? old.requestedBy} wrote this one; it submits its files again instead of retrying`);
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
      const field = old.kind === "create" ? "requirements" : old.request.polish ? "note" : "request";
      req[field] = `${String(req[field] ?? "").split(FIX_MARK)[0].trimEnd()}\n\n${context}`;
    }
    if (old.kind === "modify" && old.request.manifestOnly) throw new PlatformError("conflict", "this was a model replacement; replace the model again instead of retrying");
    return (async () => {
      // A Polish again, with its conversation (`polish` takes it from the build it retries).
      if (old.kind === "modify" && isPolish(old.request)) return this.polish(agent, { capabilityId: old.capabilityId, ...(typeof req.note === "string" ? { note: req.note } : {}), ...(req.realData ? { realData: true } : {}), ...pickAsk(req) }, marks);
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
   * step shows the tests). Never throws: no candidate, and the log says why; `tests`: how its tests went.
   */
  private async validateCandidate(build: BuildRow, submitter: string, opts: { measure?: boolean; pass?: Pass } = {}): Promise<{ candidate?: Candidate; tests?: TestTally; log: string[] }> {
    this.registry.updateBuild(build.id, { status: "validating" });
    const log: string[] = [];
    const step = this.stepLog(build, submitter, log);
    step("validating candidate");
    let tests: TestTally | undefined;
    try {
      const candidate = await this.d.validation.validate(build, step, {
        ...(opts.measure ? { measure: true } : {}),
        onTests: (passed, total) => ((tests = { passed, total }), this.setStep(build.id, build.capabilityId, opts.pass ?? "tests", tests)),
      });
      return { candidate, ...(tests !== undefined ? { tests } : {}), log };
    } catch (e) {
      step(`FAILED: ${(e as Error).message}`);
      return { log };
    }
  }

  /** Promote a validated candidate (its `tests`, as they went), or hold it for the owner's review. Never throws: the log says what failed. */
  private async promoteCandidate(build: BuildRow, submitter: string, { candidate, tests }: PassCandidate): Promise<{ version?: number; review?: BuildReview; log: string[] }> {
    this.registry.updateBuild(build.id, { status: "validating" });
    const log: string[] = [];
    const step = this.stepLog(build, submitter, log);
    try {
      const r = await this.d.validation.promote(build, candidate, step);
      if ("review" in r) {
        step(`passed; waiting for the owner's review before it goes live (${reviewReason(r.review, build.kind)})`);
        return { review: r.review, log };
      }
      step(`promoted: implementation v${r.version} is now active`);
      this.d.schedules.applyApprovedSchedules(build, step);
      await this.d.sharing.afterInstall(build, step);
      // The tests of the version that went live (not those of a pass that fell back).
      this.setStep(build.id, build.capabilityId, this.platform.readiness(build.capabilityId).ready ? "done" : "auth", tests ?? this.steps.get(build.id)?.tests);
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
        this.platform.activity.buildEnded();
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
    // No builder runs: the same files again would fail the same way.
    const max = noBuilderRuns(builder) ? 1 : Math.max(1, this.platform.maxBuildAttempts());
    // The first build of the chain this one retries, so a host can count the chain as one build.
    let retryOf: string | undefined;
    for (let id = build.request.retryOf; typeof id === "string"; id = this.registry.getBuild(id)?.request.retryOf) retryOf = id;
    // The clock runs from the first attempt: a retry after a failed validation doesn't start it over.
    const run: BuilderRun = { build, builder, signal, history: [], tag: `build ${buildId} [${build.kind} ${build.capabilityId}, requested by ${build.requestedBy}]`, ...(retryOf ? { retryOf } : {}), started: Date.now(), runs: 0 };
    const passes = this.passesFor(build, builder);
    this.planPasses(buildId, passes);
    const submitter = `builder ${builder}`;
    let feedback: string | undefined;
    // A Polish of a tool with sample data has nothing to build first: the live version, checked as it
    // is today, goes straight to the passes (one that fails the checks goes to the builder to fix).
    if (isPolish(build.request) && (await this.workbench.file(buildId, SAMPLE_FILE))) {
      this.assertSubmittable(build);
      const label = `v${build.baseVersion}`;
      const v = await this.validateCandidate(build, "Hewn", { measure: passes[0] === "craft" });
      run.history.push(...v.log.map((l) => `${label}: ${l}`));
      if (!v.candidate) feedback = v.log.join("\n");
      else {
        const failure = await this.passesThenPromote(run, { candidate: v.candidate, label, ...(v.tests ? { tests: v.tests } : {}) }, passes);
        if (failure === undefined) return;
        feedback = failure.join("\n");
      }
    }
    for (let attempt = 1; attempt <= max; attempt++) {
      const label = `attempt ${attempt}`;
      const r = await this.runOnce(run, { label, n: attempt, max, feedback });
      // Cancelled: cancelBuild already recorded it; just stop.
      if (r === "cancelled") return;
      if (r === "again") continue;
      // Retrying can't help, or isn't Hewn's to decide (paused): the build ends here.
      if (r !== "done") return this.endRun(run, r);
      this.assertSubmittable(build);
      const v = await this.validateCandidate(build, submitter, { measure: passes[0] === "craft" });
      run.history.push(...v.log.map((l) => `${label}: ${l}`));
      if (!v.candidate) {
        feedback = v.log.join("\n");
        continue;
      }
      const failure = await this.passesThenPromote(run, { candidate: v.candidate, label, ...(v.tests ? { tests: v.tests } : {}) }, passes);
      if (failure === undefined) return;
      feedback = failure.join("\n");
    }
    this.note(run, `FAILED: no valid candidate after ${max} attempts`);
    this.registry.updateBuild(buildId, { status: "failed", log: run.history });
  }

  /**
   * A validated candidate through the build's passes, then promoted (or held for the owner's review).
   * Undefined once the build has ended (promoted, in review, cancelled, or ended by a pass); else the
   * promotion's log, for another attempt to fix.
   */
  private async passesThenPromote(run: BuilderRun, built: PassCandidate, passes: Pass[]): Promise<string[] | undefined> {
    const { build } = run;
    const best = passes.length ? await this.runPasses(run, built, passes) : built;
    if (best === "cancelled") return undefined;
    // A pass that doesn't end in a valid candidate ends the build as an attempt would (owner, 2026-11-01).
    if ("end" in best) return void this.endRun(run, best);
    const { version, review, log } = await this.promoteCandidate(build, `builder ${run.builder}`, best);
    run.history.push(...log.map((l) => `${best.label}: ${l}`));
    if (review) {
      this.registry.updateBuild(build.id, { status: "review", review, log: run.history });
      this.logger(`${run.tag} waits for the owner's review (${reviewReason(review, build.kind)})`);
      return undefined;
    }
    if (version) {
      this.registry.updateBuild(build.id, { status: "promoted", resultVersion: version, log: run.history });
      return undefined;
    }
    return log;
  }

  /** The build ends here, failed (or paused by the builder's host, its work kept), saying why. */
  private endRun(run: BuilderRun, r: RunEnd) {
    this.note(run, r.paused ? `PAUSED: ${r.end}` : `FAILED: ${r.end}`);
    this.registry.updateBuild(run.build.id, { status: "failed", log: run.history });
  }

  /** A line in a run's history, and on the platform log and the build's transcript. */
  private note(run: BuilderRun, line: string) {
    run.history.push(line);
    this.buildEvent(run.build.id, line, run.tag);
  }

  /**
   * Run the builder once: one of the build's attempts, or a pass's (`pass`). `label` starts its lines
   * in the log ("attempt 2", "critique pass"); `n` of `max` is its place among its kind's tries. The
   * outcome: it finished ("done"); it failed and another try may help ("again"); the build was
   * cancelled; or it can't go on (`end` says why: a model that can't run, the host declined or paused
   * it, the builder unavailable), which ends the build, or a pass. `paused`: the host paused it, its work kept.
   */
  private async runOnce(run: BuilderRun, o: { label: string; n: number; max: number; feedback?: string; pass?: BuildPass }): Promise<"done" | "again" | "cancelled" | RunEnd> {
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
      if ((e as { modelUnavailable?: boolean }).modelUnavailable) return { end: `model unavailable: ${(e as Error).message}` };
      // The builder's host paused it part-way (e.g. it has used a build's allowance), its work kept:
      // not for Hewn to retry, the owner's to Continue (a retry picks the work up) or Stop.
      if ((e as { paused?: boolean }).paused) return { end: (e as Error).message, paused: true };
      // The builder's host declined it (e.g. over the month's builds): say why, don't retry.
      if ((e as { refused?: boolean }).refused) return { end: `refused: ${(e as Error).message}` };
      const msg = `${o.label}: builder ${builder} failed: ${(e as Error).message}`;
      run.history.push(msg);
      this.buildEvent(buildId, msg, tag);
      // Retrying can't help (e.g. not logged in); stop now with a clear next step.
      if ((e as { unavailable?: boolean }).unavailable) return { end: `builder ${builder} is unavailable. Fix it, then retry this build.` };
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

  /**
   * The passes a build runs once its candidate validates: a new tool's (not a connection's or an
   * install's), as the owner set them; a Polish's, both always (they're what the owner asked for).
   */
  private passesFor(build: BuildRow, builder: string): Pass[] {
    if (noBuilderRuns(builder)) return [];
    if (build.kind === "modify" && isPolish(build.request)) return [...PASSES];
    if (build.kind !== "create" || (build.request as CreateRequest).kind === "connection") return [];
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
   * it; resumes the builder's session with what the pass asks; and validates what it leaves. The last
   * pass's candidate is the one promoted. A pass that ends without a valid one (after its tries, or
   * paused, declined, its builder gone) ends the build as an attempt would, saying why. Nothing
   * to look at (the UI wasn't rendered): no passes, and a Polish (that's all it is) ends there.
   */
  private async runPasses(run: BuilderRun, first: PassCandidate, passes: Pass[]): Promise<PassCandidate | "cancelled" | RunEnd> {
    const polish = isPolish(run.build.request);
    if (!first.candidate.shots?.length) {
      if (polish) return { end: "nothing to polish: Hewn couldn't render the tool's screen to show the builder (the log says why)" };
      this.planPasses(run.build.id, []);
      return first;
    }
    const ownersWords = !!(await this.workbench.file(run.build.id, "OWNERS_WORDS.md"));
    const otherTools = !!(await this.workbench.file(run.build.id, "OTHER_TOOLS.md"));
    let current = first;
    for (const [i, pass] of passes.entries()) {
      const shots = Object.fromEntries((current.candidate.shots ?? []).map((s) => [`screenshots/${s.name}.png`, s.png]));
      await this.workbench.writeFolder(run.build.id, "screenshots", shots);
      const request = passRequest(pass, { files: Object.keys(shots), sampled: !!current.candidate.sampled, real: !!current.candidate.real, defects: current.candidate.defects ?? [], ownersWords, otherTools, polish });
      const next = await this.runPass(run, pass, request, passes[i + 1] === "craft");
      if (next === "cancelled" || "end" in next) return next;
      current = next;
    }
    return current;
  }

  /** One pass: up to PASS_TRIES runs of the builder until what it leaves validates; else why it couldn't. */
  private async runPass(run: BuilderRun, pass: Pass, request: string, measure: boolean): Promise<PassCandidate | "cancelled" | RunEnd> {
    const max = Math.min(PASS_TRIES, Math.max(1, this.platform.maxBuildAttempts()));
    let feedback: string | undefined;
    for (let n = 1; n <= max; n++) {
      const label = n === 1 ? `${pass} pass` : `${pass} pass, try ${n}`;
      const r = await this.runOnce(run, { label, n, max, feedback, pass: { name: pass, request } });
      if (r === "cancelled") return "cancelled";
      if (r === "again") continue;
      if (r !== "done") return r;
      this.assertSubmittable(run.build);
      const v = await this.validateCandidate(run.build, `builder ${run.builder}`, { pass, measure });
      run.history.push(...v.log.map((l) => `${label}: ${l}`));
      if (v.candidate) return { candidate: v.candidate, label, ...(v.tests ? { tests: v.tests } : {}) };
      feedback = v.log.join("\n");
    }
    return { end: `no valid candidate after ${max} ${max === 1 ? "try" : "tries"} of the ${pass} pass` };
  }

  /** Builds waiting for the owner's review (owner only). */
  buildsInReview(owner: Agent): BuildView[] {
    requireOwner(owner);
    return this.registry.buildsInReview().map((b) => this.buildView(b));
  }

  /**
   * The owner lets an agent's change, or new tool, go live: exactly the candidate that passed
   * validation. If the capability changed meanwhile, the build fails (retry it to build on the new version).
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
      const moved = build.baseVersion === null ? !cap || !!cap.activeVersion || !!cap.archivedAt : !cap?.activeVersion || !!cap.archivedAt || cap.activeVersion !== build.baseVersion;
      if (moved) throw new Error("the capability changed since this build was checked; retry it to build on the current version");
      const v = await this.loadCandidate(build.review.contentHash);
      const manifest = JSON.parse(text(v.files["capability.json"])) as CapabilityManifest;
      step(`approved by ${owner.id}`);
      const version = await this.d.validation.promoteVersion(build, manifest, v.files, { hash: build.review.contentHash, js: v.bundle }, step);
      await this.dropReviewShots(build);
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

  /** The owner turns an agent's change (or new tool) down: nothing changes. */
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
    await this.dropReviewShots(build);
    await this.keepTranscript(buildId);
    this.buildEnded(buildId);
    return this.buildView(this.mustBuild(buildId));
  }

  /** The review card's renders go once the owner has decided. */
  private async dropReviewShots(build: BuildRow) {
    for (const name of build.review?.shots ?? []) await this.blobs.delete(reviewShotKey(build.id, name)).catch(() => {});
  }

  /** A held build, for the owner's review card; else not found. */
  private heldBuild(owner: Agent, buildId: string): BuildRow & { review: BuildReview } {
    requireOwner(owner);
    const b = this.mustBuild(buildId);
    if (b.status !== "review" || !b.review) throw new PlatformError("not_found", `build ${buildId} isn't waiting for your review`);
    return b as BuildRow & { review: BuildReview };
  }

  /** The files a held build was built on: none for a new tool. */
  private async heldBase(b: BuildRow): Promise<Files | null> {
    return b.baseVersion === null ? null : (await this.loadVersion(b.capabilityId, b.baseVersion, { keep: false })).files;
  }

  /** The review card's diff: a held build's files against the version it was built on (a new tool's, as they are), or one file of them (`path`). Owner only. */
  async reviewCode(owner: Agent, buildId: string): Promise<{ version: number; base: number | null; files: CodeFile[] }> {
    const b = this.heldBuild(owner, buildId);
    const [candidate, base] = await Promise.all([this.loadCandidate(b.review.contentHash), this.heldBase(b)]);
    return { version: (b.baseVersion ?? 0) + 1, base: b.baseVersion, files: codeFiles(candidate.files, base) };
  }

  async reviewFile(owner: Agent, buildId: string, path: string): Promise<CodeText> {
    const b = this.heldBuild(owner, buildId);
    const [candidate, base] = await Promise.all([this.loadCandidate(b.review.contentHash), this.heldBase(b)]);
    return codeText(path, candidate.files, base);
  }

  /** One of the review card's four renders (`REVIEW_SHOTS`). Owner only. */
  async reviewShot(owner: Agent, buildId: string, name: string): Promise<Uint8Array> {
    const b = this.heldBuild(owner, buildId);
    const png = b.review.shots?.includes(name) ? await this.blobs.get(reviewShotKey(b.id, name)) : undefined;
    if (!png) throw new PlatformError("not_found", `build ${buildId} has no ${name} render`);
    return png;
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

  /** The Agent Skill "build a Hewn tool": this Hewn's brief for a client that writes a tool itself (`skillText`). */
  skill(): string {
    return skillText(this.brief);
  }

  /**
   * The owner's other capabilities a build may compose with, from their active manifests; for a change,
   * with the operations the tool calls on each today (an older version than the newest, perhaps).
   */
  private callees(exclude: string, visible: (id: string) => boolean = () => true): Callee[] {
    const own = this.registry.getCapability(exclude)?.activeVersion ? (this.activeManifest(exclude).requires?.capabilities ?? []) : [];
    return this.registry
      .listActiveCapabilities()
      .filter((c) => c.id !== exclude && visible(c.id))
      .map((c) => ({ id: c.id, manifest: this.activeManifest(c.id), calls: own.filter((d) => d.id === c.id).flatMap((d) => d.operations) }));
  }

  /** BUILDER.md's end: the owner's other capabilities by name (`catalogNote`); what they offer is in files of their own. */
  private catalogForBuilder(exclude: string): string {
    return catalogNote(this.callees(exclude));
  }

  /**
   * CONTRACTS.md and .hewn-contracts/<id>.md for a workspace: what each other capability offers
   * (`contractsIndex`), and its contract in full (`contractText`). Files of their own, as a builder
   * may not read BUILDER.md to its end (OpenCode reads 50 KB of a file), and the owner's contracts
   * together can run to hundreds of KB. None without other capabilities. Never part of a version
   * (`isWorkspaceOnly`; the folder is a dot-folder, `isBuilderConfig`, so it never shadows one of a tool's own).
   */
  private contractFiles(exclude: string, visible?: (id: string) => boolean): Files {
    const callees = this.callees(exclude, visible);
    if (!callees.length) return {};
    return { "CONTRACTS.md": bytes(contractsIndex(callees)), ...Object.fromEntries(callees.map((c) => [`${CONTRACTS_DIR}/${c.id}.md`, bytes(contractText(c))])) };
  }

  /**
   * OTHER_TOOLS.md for a workspace: the other tools' looks (`othersLooks`), in a file of its own, as a
   * builder may not read BUILDER.md to its end (OpenCode reads 50 KB of a file). None when there are
   * no other tools; the callers leave it out of a connection's build (no UI). Never part of a version (`isWorkspaceOnly`).
   */
  private async looksFile(exclude: string, kind: BuildKind, visible?: (id: string) => boolean): Promise<Files> {
    const looks = await this.othersLooks(exclude, kind, visible);
    return looks ? { "OTHER_TOOLS.md": bytes(looks) } : {};
  }

  /**
   * The owner's other tools as a build is told them, to look clearly different from: each one's hue
   * (and saturation) on Home and the look its builder recorded in `ui/look.json`, cut short: the
   * workspace's OTHER_TOOLS.md. Connections (no UI) are left out;
   * a version that can't be read is listed without its look. Empty when there are none.
   */
  async othersLooks(exclude: string, kind: BuildKind = "create", visible: (id: string) => boolean = () => true): Promise<string> {
    const caps = this.registry.listActiveCapabilities().filter((c) => c.id !== exclude && visible(c.id) && !isConnection(this.activeManifest(c.id)));
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
   * request and the brief are, and the owner's instructions the build runs with. Never part of a version (`isBuilderConfig`).
   */
  private agentsFile(buildId: string): Files {
    const instructions = this.registry.buildContext(buildId)?.instructions;
    return {
      "AGENTS.md": bytes(`# Building for Hewn\n\nRead \`BUILDER.md\` first (the request and the owner's other tools), then \`BRIEF.md\`, all of it, before you write anything: it is the implementation contract, how to build for Hewn. Change files only inside this directory; when the candidate is complete, stop. The platform validates it.\n${instructions ? `\n${instructions}` : ""}`),
    };
  }

  /**
   * PLATFORM_UI.css for a workspace: the design system to read (served to UIs as /_platform/ui.css),
   * without the comments it doesn't mark to keep, so a builder reads all of it (OpenCode reads 51,200
   * bytes of a file).
   */
  private async designSystemFile(): Promise<Files> {
    const css = await this.designSystem?.().catch(() => undefined);
    return css ? { "PLATFORM_UI.css": bytes(cssWithoutComments(css)) } : {};
  }

  /**
   * OWNERS_WORDS.md for a workspace: the owner's conversation (`ownersWords`), in a file of its own, as
   * a long one would push the rest past what a builder reads of BUILDER.md (OpenCode reads 50 KB of a
   * file). None for a build without one (an agent's). Never part of a version (`isWorkspaceOnly`).
   */
  private ownersWordsFile(buildId: string): Files {
    const words = ownersWords(this.registry.buildContext(buildId)?.conversation);
    return words ? { "OWNERS_WORDS.md": bytes(words) } : {};
  }

  /** BRIEF.md for a workspace: the brief (`briefText`). Never part of a version (`isWorkspaceOnly`). */
  private briefFile(): Files {
    return { "BRIEF.md": bytes(briefText(this.brief)) };
  }

  /**
   * The conversations that led to a tool as it is: from its active version's build back through the
   * version each was built on to its create, the builds that kept one (the owner's, since Hewn keeps
   * them), oldest first, each named by its kind, version and day. A change undone by a restore isn't on the way back.
   */
  private historyOf(capabilityId: string): OwnersConversation[] {
    const history: OwnersConversation[] = [];
    const seen = new Set<number>();
    for (let v = this.registry.getCapability(capabilityId)?.activeVersion ?? null; v !== null && !seen.has(v); ) {
      seen.add(v);
      const row = this.registry.getVersion(capabilityId, v);
      const b = row && this.registry.getBuild(row.buildId);
      if (!b) break;
      const turns = this.registry.buildContext(b.id)?.conversation;
      const what = b.kind === "create" ? "The tool as first asked for" : b.kind === "widgets" ? "Its widgets" : isPolish(b.request) ? "A Polish" : "A change";
      // The same conversation on two builds in a row (a create's widgets build carries the create's): once, under the earlier.
      if (turns?.length && JSON.stringify(turns) === JSON.stringify(history[0]?.turns)) history.shift();
      if (turns?.length) history.unshift({ heading: `${what} (v${v}, ${b.createdAt.slice(0, 10)})`, turns });
      v = b.baseVersion;
    }
    return history;
  }

  /**
   * BUILDER.md: the request, first saying to read BRIEF.md whole before writing anything; where the
   * owner's own words are and how they count, the owner's instructions (as the build recorded them,
   * `build_context`), the other capabilities' names, and the order to read the brief again.
   */
  private builderText(kind: BuildKind, id: string, request: string, context?: BuildContext): string {
    const instructions = context?.instructions;
    const parts = [`# Build: ${kind} \`${id}\``, READ_BRIEF, `${request}${ownersWordsNote(context?.conversation)}`, instructions, this.catalogForBuilder(id), READ_BRIEF_NOW];
    return shortLines(`${parts.flatMap((p) => p?.trim() || []).join("\n\n")}\n`);
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
    if (b.builder === "submitted" && typeof b.request.submittedBy === "string") view.submittedBy = b.request.submittedBy;
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
      view.instructions = `The ${b.kind === "create" ? "new tool" : "change"} passed validation and waits for the owner's review in Hewn before it goes live (${reviewReason(b.review, b.kind)}). Tell the owner; once they approve, it is promoted. Call builds_get later to see the outcome.`;
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

/** A candidate's capability.json, as far as a submission needs it before validation reads it whole. */
function manifestIn(files: Files): Partial<CapabilityManifest> {
  if (!files["capability.json"]) throw new PlatformError("invalid_request", "capability.json is missing");
  try {
    const m = JSON.parse(text(files["capability.json"]));
    if (m && typeof m === "object" && !Array.isArray(m)) return m;
  } catch {
    // said below
  }
  throw new PlatformError("invalid_request", "capability.json isn't a JSON object");
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

/** Why a run of the builder ends its build: `end`, the reason; `paused`, the builder's host paused it with its work kept. */
type RunEnd = { end: string; paused?: true };

/** How a candidate's tests went. */
type TestTally = { passed: number; total: number };

/** A validated candidate on its way through the passes (and to promotion): what made it ("attempt 1", "critique pass") and how its tests went. */
interface PassCandidate {
  candidate: Candidate;
  label: string;
  tests?: TestTally;
}

const fmtDuration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);

/** Ids that would collide with platform origins (e.g. http://hewn.localhost). */
export const RESERVED_IDS = new Set(["hewn", "www", "api", "platform"]);

/** No builder runs: the workspace is the candidate as given (an owner's edit, a client's submission), or it's installed from a file or a directory. */
const noBuilderRuns = (builder: string) => builder === "keep" || builder === "bundle" || builder === "submitted" || builder.startsWith("copy:");

/** The scope a kind of build needs: a widgets build changes an existing capability. */
const scopeOf = (kind: BuildKind): Scope => (kind === "create" ? "create" : "modify");

/** Paused by the builder's host, its work kept: failed for waits and agents, the owner's to Continue or Stop. */
const isPaused = (b: BuildRow) => b.status === "failed" && !!explainFailure(b.log).paused;

/**
 * The most of the owner's conversation OWNERS_WORDS.md carries, in UTF-8 bytes (the turns, the blank
 * lines between them and what says turns were left out), so the file stays within one 50 KB read;
 * and, in characters, of each turn and a drafted change's first line.
 */
const MAX_OWNERS_WORDS = 40_000;
const OWNERS_TURN_CHARS = 4000;
const DRAFTED_CHANGE_CHARS = 200;
/** The longest line Hewn writes in a builder's workspace: a reader cuts longer ones short (OpenCode at 2,000 characters). */
export const LINE_CHARS = 1000;

/** `s` cut to at most `n` characters, never between the two halves of one (an emoji, say). */
const cutAt = (s: string, n: number) => s.slice(0, /[\uD800-\uDBFF]/.test(s.charAt(n - 1)) ? n - 1 : n);

/**
 * A line as lines of at most `max` characters: split at a space, the further ones after `indent`;
 * with no space in the second half, cut anywhere, the rest carrying on with nothing added.
 */
function wrapped(line: string, max: number, indent = ""): string[] {
  const lines: string[] = [];
  let rest = line;
  let next = "";
  while (next.length + rest.length > max) {
    const width = max - next.length;
    const space = rest.lastIndexOf(" ", width);
    const at = space > width / 2 ? space : cutAt(rest, width).length;
    lines.push(next + rest.slice(0, at));
    rest = rest.slice(at === space ? at + 1 : at);
    next = at === space ? indent : "";
  }
  return [...lines, next + rest];
}

/**
 * `text` with each line longer than `LINE_CHARS` wrapped, its further lines indented as its text is (a
 * list item's under its text; none past half a line).
 */
export function shortLines(text: string): string {
  const indent = (line: string) => " ".repeat(/^\s*(?:[-*] )?/.exec(line)![0].length);
  return text
    .split("\n")
    .flatMap((line) => (line.length > LINE_CHARS ? wrapped(line, LINE_CHARS, indent(line).length < LINE_CHARS / 2 ? indent(line) : "") : [line]))
    .join("\n");
}

/** The heading a change's brief starts with ("CHANGES", "**Changes:**", "## Changes"), and a list marker after it. */
const CHANGES_HEADING = /^[#*\s]*changes[*\s]*?(?::[* \t]*|(?=\n))\s*(?:(?:[-*•]|\d+[.)])\s+)?/i;

/** How the owner's words count, as BUILDER.md and OWNERS_WORDS.md say it; `request`: where the request is. */
const ownersRule = (request: string) =>
  `${request} is the plan; where it is silent, vague, or differs from what the owner said, follow the owner's words, and their latest word where they changed their mind. Take their details and taste seriously. Their words apply within the owner's instructions (if any) and the contract: the contract has the last word. The conversation may also cover other builds (a connection, other ideas) and choices the owner made on the proposal: use it only for this build's request, never to add to its scope.`;

/**
 * BUILDER.md's "THE OWNER'S OWN WORDS", after the request: that the conversation that led to the build
 * is in OWNERS_WORDS.md, to read before planning, and how it counts. Empty when there's none (an
 * agent's build).
 */
function ownersWordsNote(conversation: BuildTurn[] | undefined): string {
  if (!conversation?.length) return "";
  return `\n\nTHE OWNER'S OWN WORDS: their conversation with the intake is in \`OWNERS_WORDS.md\` in your workspace, oldest first. Read all of it before you plan (in parts, if your reader cuts it short). ${ownersRule("The request above")}`;
}

/**
 * OWNERS_WORDS.md: the conversation that led to the build (the owner's builds only), oldest first,
 * with how it counts (`ownersRule`). A long one keeps its first turn, the owner's latest and the
 * latest that fit in `MAX_OWNERS_WORDS` bytes, and says where turns were left out. An empty string
 * when there's none (an agent's build).
 */
export function ownersWords(conversation: BuildTurn[] | undefined): string {
  if (!conversation?.length) return "";
  return ownersFile(`Their conversation with the intake, oldest first. ${ownersRule("The request in \`BUILDER.md\`")}`, [{ turns: conversation }]);
}

/** One conversation in OWNERS_WORDS.md, under a heading when the file holds several (a Polish's). */
export interface OwnersConversation {
  heading?: string;
  turns: BuildTurn[];
}

/**
 * A Polish's OWNERS_WORDS.md: the conversations that led to the tool as it is (`history`: its create's,
 * its changes', each under its build), oldest first, then this Polish's own: the owner's conversation
 * that asked for it (the Change drawer's), else their note, as their latest word. Empty when there's
 * no conversation in it (built from an agent's request, or before Hewn kept them, and a Polish asked
 * for without one): a note alone is in BUILDER.md.
 */
export function polishWords(history: OwnersConversation[], asked: { note?: string; conversation?: BuildTurn[] }): string {
  const parts = history.filter((c) => c.turns.length);
  if (!parts.length && !asked.conversation?.length) return "";
  const last = asked.conversation?.length
    ? [{ heading: "This Polish: the conversation that asked for it", turns: asked.conversation }]
    : asked.note
      ? [{ heading: "This Polish: what the owner asked of it", turns: [{ role: "user" as const, content: asked.note }] }]
      : [];
  const intro = parts.length
    ? `Their conversations with the intake that led to this tool as it is, oldest first, each under a heading (a line starting "## ") naming the build it led to${last.length ? ", and last what they asked of this Polish" : ""}.`
    : `Their conversation with the intake that asked for this Polish (none led to the tool itself).`;
  return ownersFile(`${intro} ${ownersRule("The request in \`BUILDER.md\` (this Polish)")}`, [...parts, ...last]);
}

/**
 * OWNERS_WORDS.md: `intro`, then the conversations, oldest first. A long one keeps every heading, the
 * first turn, the owner's latest and the latest that fit in `MAX_OWNERS_WORDS` bytes, and says where
 * turns were left out.
 */
function ownersFile(intro: string, conversations: OwnersConversation[]): string {
  const items = conversations.flatMap((c) => [
    ...(c.heading ? [{ text: `## ${c.heading}`, heading: true, owner: false }] : []),
    ...c.turns.map((t) => ({ text: `${t.role === "user" ? "OWNER" : "INTAKE"}: ${turnText(t)}`, heading: false, owner: t.role === "user" })),
  ]);
  const size = items.map((it) => bytes(it.text).length);
  let keep = new Set(items.keys());
  if (bytes(items.map((it) => it.text).join("\n\n")).length > MAX_OWNERS_WORDS) {
    // Each kept item and mark costs its size and a blank line; a gap may open before each heading and on either side of the owner's latest.
    const headings = [...items.keys()].filter((i) => items[i].heading);
    keep = new Set([...headings, items.findIndex((it) => !it.heading), items.findLastIndex((it) => it.owner)].filter((i) => i >= 0));
    let room = MAX_OWNERS_WORDS - (headings.length + 2) * (bytes(leftOut(items.length)).length + 2) - [...keep].reduce((n, i) => n + size[i] + 2, 0);
    for (let i = items.length - 1; i >= 0; i--) {
      if (keep.has(i)) continue;
      if (size[i] + 2 > room) break;
      keep.add(i);
      room -= size[i] + 2;
    }
  }
  const kept: string[] = [];
  let gap = 0;
  items.forEach((it, i) => {
    if (!keep.has(i)) return void gap++;
    if (gap) kept.push(leftOut(gap));
    kept.push(it.text);
    gap = 0;
  });
  if (gap) kept.push(leftOut(gap));
  return shortLines(`# THE OWNER'S OWN WORDS\n\n${intro} Each turn starts with who said it, its further lines indented; only OWNER turns are the owner's.\n\n${kept.join("\n\n")}\n`);
}

/** Where OWNERS_WORDS.md leaves turns of the owner's conversation out. */
const leftOut = (n: number) => `(${n} turn${n === 1 ? "" : "s"} left out)`;

/**
 * A turn as the builder reads it, cut short, its long lines wrapped and its further lines indented so
 * nothing in it passes for a turn of its own. A draft or ideas the intake offered come down to their
 * name and purpose, a drafted change (it has no name) to the first line of what it changes: the
 * request above is the one agreed.
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
  if (text.length > OWNERS_TURN_CHARS) text = `${cutAt(text, OWNERS_TURN_CHARS)}…`;
  // Room for who said it ("INTAKE: ", the longer) or the indent.
  return `${text}${attached}`
    .split("\n")
    .flatMap((line) => wrapped(line, LINE_CHARS - "INTAKE: ".length))
    .join("\n  ");
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
  s = oneLine(s, LOOK_CHARS);
  return !s || s === '""' || s === "{}" ? undefined : s;
}

/** `s` on one line, its whitespace collapsed, cut at `max` characters with "…". */
const oneLine = (s: string, max: number) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${cutAt(line, max - 1)}…` : line;
};

/**
 * The other tools' looks, OTHER_TOOLS.md: on the owner's Home already, so a new tool must look
 * clearly different from each (and keep its hue clear of theirs when its subject has no colour of its
 * own), with the hues taken listed in order; a change keeps its own look. Empty when there are none.
 */
export function looksNote(tools: ToolLook[], kind: BuildKind = "create"): string {
  if (!tools.length) return "";
  const shade = (t: ToolLook) => (t.hue === null ? "" : `, hue ${t.hue}${t.saturation === null ? "" : `, saturation ${t.saturation}%`}`);
  const lines = tools.map((t) => `- **${t.name}** (\`${t.id}\`)${shade(t)}: ${t.look ?? "no look recorded"}`);
  const rule =
    kind === "create"
      ? "This one must look clearly different from each of them: tell it apart by its concept, layout, type and signature visual. Its colour comes from its subject when the subject has one; when it hasn't, its hue stays at least 40° from each of theirs, or, when no hue is, takes the middle of the widest gap below."
      : "This tool keeps its own look; whatever is new in it, and a new look when the request asks for one, must still look clearly different from each of them.";
  // The hues taken, in order round the circle, and the widest gap between them (a free hue on a crowded Home).
  const hues = [...new Set(tools.flatMap((t) => (t.hue === null ? [] : [t.hue])))].sort((a, b) => a - b);
  const gap = widestGap(hues);
  const free = gap ? ` The widest gap: ${gap.from} to ${gap.to} (${gap.size}°), its middle ${gap.middle}.` : "";
  return shortLines(`# The owner's other tools' looks\n\nOn the owner's Home already, each with its icon's hue and the look its builder recorded in \`ui/look.json\` (cut short when long). ${rule}\n\n${lines.join("\n")}\n${hues.length ? `\nHues on Home (0–359, round a circle): ${hues.join(", ")}.${free}\n` : ""}`);
}

/**
 * The widest gap round the hue circle between `hues` (sorted, distinct): where it starts and ends,
 * how wide, and its middle. When two are as wide: the one from the last hue round to the first, else
 * the lower one.
 */
export function widestGap(hues: number[]): { from: number; to: number; size: number; middle: number } | undefined {
  if (!hues.length) return undefined;
  let best = { from: hues.at(-1)!, to: hues[0], size: hues[0] + 360 - hues.at(-1)! };
  for (let i = 1; i < hues.length; i++) if (hues[i] - hues[i - 1] > best.size) best = { from: hues[i - 1], to: hues[i], size: hues[i] - hues[i - 1] };
  return { ...best, middle: Math.round(best.from + best.size / 2) % 360 };
}

/** One of the owner's other capabilities as a build is told it: its active manifest, and the operations ("name@N") the tool being changed calls on it today. */
export interface Callee {
  id: string;
  manifest: CapabilityManifest;
  calls: string[];
}

/** How much of a capability's purpose CONTRACTS.md shows (`.hewn-contracts/<id>.md` has all of it). */
export const INDEX_PURPOSE_CHARS = 200;

/** The workspace folder with each other capability's contract in full: a dot-folder, which no version can hold. */
export const CONTRACTS_DIR = ".hewn-contracts";

/**
 * BUILDER.md's end: the owner's other capabilities by name, and where to read what they offer. A
 * line per capability at most, so BUILDER.md stays small however many there are and however big
 * their schemas. Empty when there are none.
 */
export function catalogNote(callees: Callee[]): string {
  if (!callees.length) return "";
  return `\n## The owner's other capabilities\n\nYou can compose with these via ctx.call (see "Calling other capabilities" in \`BRIEF.md\`): ${callees.map((c) => `${c.manifest.name} (\`${c.id}\`)`).join(", ")}. \`CONTRACTS.md\` in your workspace lists the operations each one offers, and \`${CONTRACTS_DIR}/<id>.md\` has each one's full contract. You see only their public contracts and recorded looks, never their data or code.\n`;
}

/**
 * CONTRACTS.md: the owner's other capabilities, each one's purpose, cut short, and the operations it
 * offers by side effect, names only. The full contracts are `contractText`s.
 */
export function contractsIndex(callees: Callee[]): string {
  const entry = ({ id, manifest: m, calls }: Callee) => {
    const ops = callableOperations(m, calls);
    const bySideEffect = SIDE_EFFECTS.flatMap((s) => {
      const named = ops.filter((o) => o.sideEffect === s).map((o) => `\`${opKey(o.name, o.version)}\``);
      return named.length ? [`${s}: ${named.join(", ")}`] : [];
    });
    return `- **${m.name}** (\`${id}\`): ${oneLine(m.purpose, INDEX_PURPOSE_CHARS)}\n  ${bySideEffect.join(" · ") || "nothing to call"}`;
  };
  return shortLines(`# The owner's other capabilities (public contracts you may call)\n\nYou can compose with these via ctx.call (see "Calling other capabilities" in \`BRIEF.md\`). Each is listed with the operations you may call (the newest version of each), by side effect. Its full contract, with each operation's description and its input and output schemas, is in \`${CONTRACTS_DIR}/<id>.md\`: read it before you call one.\n\n${callees.map(entry).join("\n")}\n`);
}

/** .hewn-contracts/<id>.md: one capability's contract in full, the operations `callableOperations` gives. */
export function contractText({ id, manifest: m, calls }: Callee): string {
  const newest = newestByName(offeredOperations(m));
  const op = (o: OperationManifest) => {
    const key = opKey(o.name, o.version);
    const top = newest.get(o.name);
    const notes = [
      o.sideEffect,
      ...(calls.includes(key) ? ["this tool calls it today"] : []),
      ...(o.deprecated ? [`deprecated${o.deprecated.replacement ? `: use ${o.deprecated.replacement}` : ""}`] : []),
      ...(top && top !== o ? [`the newest is ${opKey(top.name, top.version)}`] : []),
    ];
    return `## \`${key}\` (${notes.join("; ")})\n\n${o.description}\n\ninput: ${schemaText(o.inputSchema)}\noutput: ${schemaText(o.outputSchema)}`;
  };
  const ops = callableOperations(m, calls);
  return shortLines(`# ${m.name} (\`${id}\`)\n\n${m.purpose}\n\nThe operations you may call: the newest version of each${calls.length ? ", and the ones this tool calls today" : ""}. Call one with \`ctx.call("${id}", "<name>@<version>", input)\`, declared in \`requires.capabilities\` (see "Calling other capabilities" in \`BRIEF.md\`).\n\n${ops.length ? ops.map(op).join("\n\n") : "Nothing to call."}\n`);
}

/**
 * BUILDER.md's request for a Polish: what it's for, what its screenshots show (`real`: a copy of the
 * owner's own data), the sample data to write first when the tool has none, what it keeps, what the
 * owner asked of it (`note`), if anything, and what OWNERS_WORDS.md holds (`ownersWords`, when there is
 * one: the conversations that led to the tool, if any, and last this Polish's conversation or note).
 */
const polishRequest = ({ note, needsSample, real, ownersWords }: { note: string; needsSample: boolean; real: boolean; ownersWords?: { history: boolean; last?: "conversation" | "note" } }) =>
  `This is a **Polish**: the tool works and is live; this build lifts its design, not what it does. Hewn shows you screenshots of it filled with ${real ? "a copy of the owner's own data (they allowed it)" : "its sample data"} for two passes: a design review (the five biggest problems, fixed), then a craft pass (what's broken, cramped or cut off, fixed).

${needsSample ? `First, before the passes: the tool has no sample data. Write ${SAMPLE_FILE} (see "${SAMPLE_FILE}" in \`BRIEF.md\`) with made-up entries that show what it does, change nothing else, and stop. Hewn validates it, then shows you the screenshots.\n\n` : ""}${POLISH_KEEPS} In the passes, change only ui/: the operations, state and tests stay as they are.${note ? `\n\nWhat the owner asks of this Polish: ${note}` : ""}${ownersWords ? `\n\nTHE OWNER'S OWN WORDS: ${ownersWords.history ? `their conversations with the intake that led to this tool as it is are in \`OWNERS_WORDS.md\` in your workspace, oldest first${ownersWords.last === "conversation" ? ", with the one that asked for this Polish last" : ownersWords.last === "note" ? ", with this Polish's note last" : ""}` : "their conversation with the intake that asked for this Polish is in `OWNERS_WORDS.md` in your workspace"}. Read all of it before the passes (in parts, if your reader cuts it short): the screen should still be what they asked for, and feel the way they wanted. It says how their words count.` : ""}`;

/** A schema as a contract file shows it: on one line when it fits after "output: " (the longer label), else over several. */
const schemaText = (schema: unknown) => {
  const line = JSON.stringify(schema);
  return line.length <= LINE_CHARS - "output: ".length ? line : JSON.stringify(schema, null, 1);
};

/**
 * CSS without its comments and the blank lines they leave, but for those marked to keep (`/*! … *\/`:
 * in ui.css, its header and how to use a component); every rule as it is. A comment becomes a space,
 * as it parts what's either side of it. No string in ui.css holds a comment's marks.
 */
export function cssWithoutComments(css: string): string {
  return css
    .replace(/\/\*(?!!)[^]*?\*\//g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
}


/** What BUILDER.md says first, and last: the brief is in BRIEF.md, to read whole before writing anything. */
const READ_BRIEF =
  "**Read `BRIEF.md` in your workspace, all of it, before you write anything** (in parts, if your reader cuts it short): it is the implementation contract, how to build for Hewn. This file is the request.";
const READ_BRIEF_NOW = "Now read `BRIEF.md`, all of it, before you write anything.";

/**
 * BRIEF.md: the brief (spec/builder-brief.md, or a bench arm's), how to build for Hewn, in a file of
 * its own, so BUILDER.md stays the request and a builder reads each whole (OpenCode reads 51,200 bytes
 * of a file; a test keeps the brief well under that).
 */
export function briefText(brief: string): string {
  const submit = "When the candidate is complete, stop. The platform validates it automatically. If validation fails, you are run again with the failure log.";
  return shortLines(`# How to build for Hewn\n\nThe request is in \`BUILDER.md\`; this is how to build it. Read all of it before you write anything.\n\n${brief.replace("{{SUBMIT}}", submit).replaceAll("{{ABI}}", ABI)}`);
}

/** BUILDER.md's request for a widgets build. */
const widgetsRequest = (request: string) =>
  `This is a **widgets build**: the capability works; add widgets to it (see "Widgets (ABI 2.3)" in \`BRIEF.md\`).

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

const reviewReason = (r: BuildReview, kind: BuildKind) =>
  kind === "create"
    ? "the agent's new tools wait for the owner's approval"
    : [r.approval === "wait" && "the agent's changes wait for the owner's approval", r.connection && "it changes a connection", r.newOperations.length && `it adds ${r.newOperations.map((o) => `${o.key} (${o.sideEffect})`).join(", ")}`].filter(Boolean).join("; ");
