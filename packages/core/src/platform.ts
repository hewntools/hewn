// SPDX-License-Identifier: AGPL-3.0-or-later
// Platform: the one object every surface calls. A facade: each method hands its call to one of the
// domains in ./platform/ (builds, models, grants …; context.ts says what they share).
import { AgentStore, type AgentDetails, type PendingRequest } from "./agents.ts";
import { type Agent, canSee, requireOwner, requireScope, type Scope, USER, WEB_USER } from "./auth.ts";
import { PlatformError } from "./errors.ts";
import { type BuildFailure, explainFailure, testCounts } from "./failure.ts";
import { bytes, contentHash, decodeVersion, encodeVersion, text, versionFiles } from "./files.ts";
import { type Cells, cellsFromSvg, glyphSvg } from "./glyph.ts";
import { type Deadline, deadlineOf } from "./deadline.ts";
import {
  ABI,
  abiAtLeast,
  type CapabilityManifest,
  compileSchema,
  connectOperation,
  DEFAULT_ABI,
  contractBreaks,
  isConnection,
  MODEL_PROVIDERS,
  MODEL_TIERS,
  modelGrant,
  type ModelProvider,
  type ModelRequirement,
  type ModelTier,
  type OperationManifest,
  opKey,
  refreshMs,
  schemaErrors,
  validateManifest,
  WIDGET_SIZES,
  type WidgetManifest,
  type WidgetSize,
  widgetOf,
} from "./manifest.ts";
import { viewErrors, widgetsBuildProblems, type WidgetOutput } from "./widgets.ts";
import {
  buildCall,
  CATALOG_URL,
  type CatalogEntry,
  costOf,
  estimateInputTokens,
  type GenerateRequest,
  type HostGenerateResult,
  type HostModels,
  inspectRequest,
  type ModelHandler,
  type ModelMessage,
  type ModelPrice,
  type ModelSettings,
  listModelsCall,
  normalizeModelSettings,
  parseCatalog,
  parseModelList,
  PROVIDER_LABEL,
  type ProviderModel,
  suggestTiers,
  type TierModels,
  parseReply,
  providerError,
  providerOf,
  resolveModel,
  saneCharge,
  cutOffMessage,
  structured,
} from "./models.ts";
import { EFFORT, MODEL_NAME } from "./build-models.ts";
import { migrationProblems, migrationsOf } from "./migrations.ts";
import type { Blobs, CallHandler, CapabilityRuntime, CodeRef, ExecutionTarget, Files, SecretStore, Sql, StateRef, Workbench } from "./ports.ts";
import { type AttachmentRef, type BuildContext, type BuildFeedback, type BuildKind, type BuildModel, type BuildReview, type BuildRow, type BuildTurn, type Confirmation, type GrantKind, Registry } from "./registry.ts";
import { randomToken, sha256 } from "./sha256.ts";
import type { AssertionResponse, RegistrationResponse } from "./webauthn.ts";
import { checkCadence, MAX_FAILURES, nextRun, type Schedule, ScheduleStore, toCron, parseCron } from "./schedules.ts";
import type { TestCase } from "@hewntools/spec/cases.ts";
import { Discovery, type CapabilitySummary } from "./platform/discovery.ts";
import { Presentation, MAX_SATURATION } from "./platform/presentation.ts";
import { Data } from "./platform/data.ts";
import { Sessions } from "./platform/sessions.ts";
import { Attachments, type AttachmentWithData, attachmentRefs } from "./platform/attachments.ts";
import { Instructions, type Instruction } from "./platform/instructions.ts";
import { Grants, type Readiness, resolveHosts, wantedGrants } from "./platform/grants.ts";
import { Connections, type ConnectionHealth } from "./platform/connections.ts";
import { Events, type Shared, type Domains, type LoadedVersion } from "./platform/context.ts";
import spec from "@hewntools/spec/package.json" with { type: "json" };

// What the domains define, importable from here as before.
export { type CapabilitySummary } from "./platform/discovery.ts";
export { MAX_SATURATION } from "./platform/presentation.ts";
export { type Readiness, hostOf, resolveHosts } from "./platform/grants.ts";
export { WEB_SESSION_MS, normalizePublicUrl } from "./platform/sessions.ts";
export { type ConnectionHealth, HEALTH_DEADLINE_MS, HEALTH_CACHE_MS } from "./platform/connections.ts";
export { ATTACHMENT_LIMITS, type AttachmentWithData, attachmentRefs } from "./platform/attachments.ts";
export { type InstructionScope, type Instruction } from "./platform/instructions.ts";

export interface InvokeRequest {
  capabilityId: string;
  operation: string;
  /** Contract version. Defaults to the highest available. */
  operationVersion?: number;
  input?: unknown;
}

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
} & ModelAsk;

export interface PlatformOptions {
  /** Platform metadata (registry, agents in the workerd host). */
  sql: Sql;
  /** Versions, owner icons, screenshots. */
  blobs: Blobs;
  runtime: CapabilityRuntime;
  /** Where workspaces live and builders run. */
  workbench: Workbench;
  /** In-memory unless the host provides a real store. */
  secrets?: SecretStore;
  /** The builder brief (spec/builder-brief.md), with a {{SUBMIT}} slot. */
  brief: string;
  /** The design system (platform-ui/ui.css): copied into each workspace for the builder to read. */
  designSystem?: () => Promise<string | undefined>;
  /** Platform lifecycle events (build steps, promotions). Silent by default. */
  logger?: (message: string) => void;
  /** Builder for new builds, resolved per build (e.g. "claude", "codex"). */
  builder?: () => string | undefined;
  /** The owner's model and effort for builds by this builder (Settings › AI). Unset: the builder's default. */
  buildModel?: (builder: string) => { model?: string; effort?: string };
  /** Model names an agent may ask a build by this builder to use (the owner ticks them; "default" is the builder's default). */
  agentBuildModels?: (builder: string) => string[];
  /** The effort levels a model takes on this builder (its model list). Undefined or empty: not known, so not checked. */
  modelEfforts?: (builder: string, model: string) => Promise<string[] | undefined>;
  /** Builds that may run at once (the rest wait their turn). Default 5. */
  maxRunningBuilds?: number;
  maxBuildAttempts?: () => number;
  /** The owner's timezone (IANA name) for schedules. Default UTC. */
  timezone?: () => string;
  /** Called when the next schedule time may have changed (the host re-arms its timer). */
  onSchedulesChanged?: () => void;
  /** Days to keep capability call logs (owner setting, read at each cleanup). 0 = forever. Default 14. */
  logRetentionDays?: () => number;
  /** How long an agent's destructive call waits for the owner's confirmation before it returns "awaiting_confirmation". */
  confirmWaitMs?: number;
  /** HTTP for the model port (provider calls, the model catalog). Absent: models can't run on this host. */
  modelFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Hosted (HEWN_HOSTED): the host runs tools' model calls on its own keys. Then no provider or key
   * is needed, the host decides what a tier runs on, and it charges in its own unit (no USD caps).
   */
  hostModels?: HostModels;
}

/** Where the owner's model provider API keys live in the secret store. */
export const MODEL_KEYS = "hewn:models";

/** Secrets kept in memory (tests, and until the host provides a store). */
export class MemorySecretStore implements SecretStore {
  private values = new Map<string, string>();
  get(capabilityId: string, name: string) {
    return this.values.get(`${capabilityId}/${name}`);
  }
  set(capabilityId: string, name: string, value: string) {
    this.values.set(`${capabilityId}/${name}`, value);
  }
  delete(capabilityId: string, name: string) {
    this.values.delete(`${capabilityId}/${name}`);
  }
}

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

/** Capability call logs older than this are pruned (owner setting; 0 keeps them forever). */
export const LOG_RETENTION_DAYS = 14;

/**
 * An operation's input as the failure record keeps it: values under names that look like
 * credentials (password, token, secret, key …) are masked. Stored secrets are redacted separately.
 */
export const maskInput = (v: unknown, depth = 0): unknown => {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => maskInput(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, /pass(word)?|token|secret|api[-_]?key|private|credential|auth/i.test(k) ? "[hidden]" : maskInput(x, depth + 1)]));
};

export class Platform {
  registry: Registry;
  blobs: Blobs;
  runtime: CapabilityRuntime;
  workbench: Workbench;
  agentStore: AgentStore;
  logger: (message: string) => void;
  builderFor: () => string | undefined;
  private buildModelFor: (builder: string) => { model?: string; effort?: string };
  private agentBuildModels?: (builder: string) => string[];
  private modelEfforts?: (builder: string, model: string) => Promise<string[] | undefined>;
  /** Builds that may run at once; the rest wait their turn. */
  maxRunningBuilds: number;
  private slots = { busy: 0, queue: [] as (() => void)[] };
  maxBuildAttempts: () => number;
  secrets: SecretStore;
  schedules: ScheduleStore;
  timezone: () => string;
  private onSchedulesChanged: () => void;
  confirmWaitMs: number;
  logRetentionDays: () => number;
  modelFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Hosted: the host runs tools' model calls (PlatformOptions.hostModels). */
  hostModels?: HostModels;
  private catalogIndex?: { fetchedAt: string; byId: Map<string, CatalogEntry> };
  private providerLists = new Map<string, { raw: string | undefined; list: ReturnType<Platform["providerList"]> }>();
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
  /** Verified, decoded versions by content hash (immutable, so safe to keep). */
  private loaded = new Map<string, { files: Files; bundle: string }>();
  /** Heartbeat interval for builder liveness logging. */
  heartbeatMs = 10_000;
  /** How long a build waits after losing its builder connection before counting the attempt. */
  interruptWaitMs = 10_000;
  /** Per-build live events: `${buildId}` → line; `${buildId}:done` → final view. */
  private events = new Events();
  /** The domains (platform/) the methods below hand their calls to. */
  private d: Domains;

  constructor(opts: PlatformOptions) {
    this.registry = new Registry(opts.sql);
    this.blobs = opts.blobs;
    this.runtime = opts.runtime;
    this.workbench = opts.workbench;
    this.agentStore = new AgentStore(opts.sql);
    this.agentStore.onChange = () => this.events.emit("changed");
    this.brief = opts.brief;
    this.briefId = `${spec.version}+${sha256(opts.brief).slice(0, 12)}`;
    this.designSystem = opts.designSystem;
    // Everything worth a log line may change what agents see (catalog, readiness): open MCP
    // sessions re-check their tool lists (debounced, and only notified when it differs).
    const log = opts.logger ?? (() => {});
    this.logger = (m) => (log(m), this.events.emit("changed"));
    this.builderFor = opts.builder ?? (() => undefined);
    this.buildModelFor = opts.buildModel ?? (() => ({}));
    this.agentBuildModels = opts.agentBuildModels;
    this.modelEfforts = opts.modelEfforts;
    this.maxRunningBuilds = opts.maxRunningBuilds ?? MAX_RUNNING_BUILDS;
    this.maxBuildAttempts = opts.maxBuildAttempts ?? (() => 3);
    this.secrets = opts.secrets ?? new MemorySecretStore();
    this.schedules = new ScheduleStore(opts.sql);
    this.timezone = opts.timezone ?? (() => "UTC");
    this.onSchedulesChanged = opts.onSchedulesChanged ?? (() => {});
    this.confirmWaitMs = opts.confirmWaitMs ?? 60_000;
    this.logRetentionDays = opts.logRetentionDays ?? (() => LOG_RETENTION_DAYS);
    this.modelFetch = opts.modelFetch;
    this.hostModels = opts.hostModels;
    // The domains share the facade, the ports and the event bus, and reach each other through `d`.
    const d = (this.d = {} as Domains);
    const s: Shared = { platform: this, events: this.events, loaded: this.loaded, d };
    d.attachments = new Attachments(s);
    d.connections = new Connections(s);
    d.data = new Data(s);
    d.discovery = new Discovery(s);
    d.grants = new Grants(s);
    d.instructions = new Instructions(s);
    d.presentation = new Presentation(s);
    d.sessions = new Sessions(s);
  }

  close() {
    this.registry.close();
  }

  /** Called when something agents can see may have changed. Returns an unsubscribe. */
  onChange(fn: () => void): () => void {
    this.events.on("changed", fn);
    return () => this.events.off("changed", fn);
  }

  // ---------- discovery (platform/discovery.ts) ----------

  list(agent: Agent, filter?: { name?: string; operation?: string; tag?: string }): CapabilitySummary[] { return this.d.discovery.list(agent, filter); }
  get(agent: Agent, capabilityId: string): CapabilityManifest & { status: Readiness } { return this.d.discovery.get(agent, capabilityId); }
  // The lookups every domain shares (platform/context.ts).
  loadVersion(capabilityId: string, version: number): Promise<LoadedVersion> { return this.d.discovery.loadVersion(capabilityId, version); }
  activeManifest(capabilityId: string): CapabilityManifest { return this.d.discovery.activeManifest(capabilityId); }

  // ---------- owner presentation (platform/presentation.ts) ----------

  rename(owner: Agent, capabilityId: string, name: string) { return this.d.presentation.rename(owner, capabilityId, name); }
  setIcon(owner: Agent, capabilityId: string, icon: { glyph: Cells } | { type: string; data: Uint8Array } | null) { return this.d.presentation.setIcon(owner, capabilityId, icon); }
  setHue(owner: Agent, capabilityId: string, hue: number | null) { return this.d.presentation.setHue(owner, capabilityId, hue); }
  hueOf(capabilityId: string): number | null { return this.d.presentation.hueOf(capabilityId); }
  setSaturation(owner: Agent, capabilityId: string, saturation: number | null) { return this.d.presentation.setSaturation(owner, capabilityId, saturation); }
  saturationOf(capabilityId: string): number | null { return this.d.presentation.saturationOf(capabilityId); }
  icon(capabilityId: string): Promise<{ data: Uint8Array; type: string; glyph: boolean } | undefined> { return this.d.presentation.icon(capabilityId); }

  // ---------- data: archive, restore, rollback, purge, export, import (platform/data.ts) ----------

  archive(owner: Agent, capabilityId: string) { return this.d.data.archive(owner, capabilityId); }
  rollback(owner: Agent, capabilityId: string, version?: number): Promise<{ from: number; to: number }> { return this.d.data.rollback(owner, capabilityId, version); }
  purge(owner: Agent, capabilityId: string, confirm: string) { return this.d.data.purge(owner, capabilityId, confirm); }
  exportData(owner: Agent, capabilityId: string): Promise<{ capability: string; version: number; exportedAt: string; source: "operation" | "state"; data: unknown }> { return this.d.data.exportData(owner, capabilityId); }
  importData(owner: Agent, capabilityId: string, tables: Record<string, Record<string, unknown>[]>): Promise<{ rows: number }> { return this.d.data.importData(owner, capabilityId, tables); }
  archived(owner: Agent): { id: string; name: string; archivedAt: string }[] { return this.d.data.archived(owner); }
  restore(owner: Agent, capabilityId: string) { return this.d.data.restore(owner, capabilityId); }

  // ---------- grants, secrets, config, agents, confirmations (platform/grants.ts) ----------

  readiness(capabilityId: string): Readiness { return this.d.grants.readiness(capabilityId); }
  usedBy(capabilityId: string): { id: string; name: string; operations: string[] }[] { return this.d.grants.usedBy(capabilityId); }
  authorization(capabilityId: string) { return this.d.grants.authorization(capabilityId); }
  requestAccess(agent: Agent, capabilityId: string, note: string) { return this.d.grants.requestAccess(agent, capabilityId, note); }
  approveGrants(owner: Agent, capabilityId: string): string[] { return this.d.grants.approveGrants(owner, capabilityId); }
  approveGrant(owner: Agent, capabilityId: string, grant: string) { return this.d.grants.approveGrant(owner, capabilityId, grant); }
  revokeGrant(owner: Agent, capabilityId: string, grant: string) { return this.d.grants.revokeGrant(owner, capabilityId, grant); }
  deleteSecret(owner: Agent, capabilityId: string, name: string) { return this.d.grants.deleteSecret(owner, capabilityId, name); }
  agents(owner: Agent): AgentDetails[] { return this.d.grants.agents(owner); }
  updateAgent(owner: Agent, id: string, change: { scopes?: Scope[]; capabilities?: "*" | string[] } | "revoke") { return this.d.grants.updateAgent(owner, id, change); }
  pendingAgents(owner: Agent): PendingRequest[] { return this.d.grants.pendingAgents(owner); }
  decideAgent(owner: Agent, requestId: string, d: { approve: false } | { approve: true; name?: string; scopes?: Scope[]; capabilities?: "*" | string[] }): { agentId?: string } { return this.d.grants.decideAgent(owner, requestId, d); }
  unreadableSecrets(owner: Agent): { capabilityId: string; name: string }[] { return this.d.grants.unreadableSecrets(owner); }
  setSecret(owner: Agent, capabilityId: string, name: string, value: string) { return this.d.grants.setSecret(owner, capabilityId, name, value); }
  setConfig(owner: Agent, capabilityId: string, name: string, value: string) { return this.d.grants.setConfig(owner, capabilityId, name, value); }
  confirmations(owner: Agent): Confirmation[] { return this.d.grants.confirmations(owner); }
  decideConfirmation(owner: Agent, id: string, approve: boolean) { return this.d.grants.decideConfirmation(owner, id, approve); }

  // ---------- tool UIs, web sessions, the public URL, passkeys (platform/sessions.ts) ----------

  createUiTicket(capabilityId: string): string { return this.d.sessions.createUiTicket(capabilityId); }
  redeemUiTicket(ticket: string, capabilityId: string): string | undefined { return this.d.sessions.redeemUiTicket(ticket, capabilityId); }
  uiAgent(session: string | undefined, capabilityId: string): Agent | undefined { return this.d.sessions.uiAgent(session, capabilityId); }
  createWebTicket(owner: Agent): string { return this.d.sessions.createWebTicket(owner); }
  redeemWebTicket(ticket: string, userAgent?: string): string | undefined { return this.d.sessions.redeemWebTicket(ticket, userAgent); }
  webPrincipal(session: string | undefined): Agent | undefined { return this.d.sessions.webPrincipal(session); }
  webSessions(owner: Agent, currentSession?: string) { return this.d.sessions.webSessions(owner, currentSession); }
  revokeWebSession(owner: Agent, id: string) { return this.d.sessions.revokeWebSession(owner, id); }
  signOut(session: string) { return this.d.sessions.signOut(session); }
  publicUrl(): string | undefined { return this.d.sessions.publicUrl(); }
  setPublicUrl(owner: Agent, url: string | null): { url: string | null; passkeysElsewhere: number } { return this.d.sessions.setPublicUrl(owner, url); }
  passkeyChallenge(kind: "create" | "get"): string { return this.d.sessions.passkeyChallenge(kind); }
  passkeyCreateOptions(owner: Agent, rpId: string) { return this.d.sessions.passkeyCreateOptions(owner, rpId); }
  addPasskey(owner: Agent, site: { origin: string; rpId: string }, body: { challenge: string; response: RegistrationResponse; name?: string }) { return this.d.sessions.addPasskey(owner, site, body); }
  hasPasskeys(rpId: string): boolean { return this.d.sessions.hasPasskeys(rpId); }
  passkeyGetOptions(rpId: string) { return this.d.sessions.passkeyGetOptions(rpId); }
  passkeySignIn(site: { origin: string; rpId: string }, body: { challenge: string; response: AssertionResponse }, userAgent?: string): Promise<string> { return this.d.sessions.passkeySignIn(site, body, userAgent); }
  passkeys(owner: Agent) { return this.d.sessions.passkeys(owner); }
  removePasskey(owner: Agent, id: string) { return this.d.sessions.removePasskey(owner, id); }
  uiFile(capabilityId: string, path: string): Promise<{ path: string; data: Uint8Array } | undefined> { return this.d.sessions.uiFile(capabilityId, path); }
  uiKey(capabilityId: string): string | undefined { return this.d.sessions.uiKey(capabilityId); }

  // ---------- Accounts: connections and their health (platform/connections.ts) ----------

  connect(owner: Agent, capabilityId: string, input: Record<string, unknown>) { return this.d.connections.connect(owner, capabilityId, input); }
  connectionHealth(owner: Agent, capabilityId: string, o?: { cached?: boolean }): Promise<ConnectionHealth> { return this.d.connections.connectionHealth(owner, capabilityId, o); }
  accounts(owner: Agent) { return this.d.connections.accounts(owner); }

  // ---------- attachments (platform/attachments.ts) ----------

  addAttachment(owner: Agent, a: { session?: unknown; kind?: unknown; name?: unknown; mediaType?: unknown; data?: unknown }): Promise<AttachmentRef> { return this.d.attachments.addAttachment(owner, a); }
  attachmentBytes(owner: Agent, ref: string): Promise<{ meta: AttachmentRef; bytes: Uint8Array }> { return this.d.attachments.attachmentBytes(owner, ref); }
  attachmentsWithData(owner: Agent, refs: unknown): Promise<AttachmentWithData[]> { return this.d.attachments.attachmentsWithData(owner, refs); }

  // ---------- instructions (platform/instructions.ts) ----------

  instructions(owner: Agent, capabilityId?: string): string[] { return this.d.instructions.instructions(owner, capabilityId); }
  setInstructions(owner: Agent, capabilityId: string | undefined, lines: unknown): string[] { return this.d.instructions.setInstructions(owner, capabilityId, lines); }
  applyIntakeMemory(owner: Agent, capabilityId: string | undefined, remember: unknown, forget: unknown): { remember: Instruction[]; forget: Instruction[] } { return this.d.instructions.applyIntakeMemory(owner, capabilityId, remember, forget); }

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
      if (!b.builder || (b.request as { autoRetryOf?: string }).autoRetryOf || !this.builderFor()) continue;
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
    while (this.mustBuild(buildId).status === "waiting" && !this.running.has(buildId)) await new Promise((r) => this.events.once(`${buildId}:state`, r));
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

  // ---------- the public URL and passkeys ----------

  /**
   * Aggregates for a host's metrics endpoint (HEWN_METRICS_PORT): counts and sums only, never what's in
   * the tools. Calls come from the call logs, so they reach back as far as those are kept (14 days by default).
   */
  metrics(owner: Agent) {
    requireOwner(owner);
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const snap = this.registry.metricsSnapshot(iso(86_400_000), iso(7 * 86_400_000), new Date(now).toISOString().slice(0, 7));
    // A call-log entry: "<iso> <caller[ → caller…]> <operation> <ok | ERROR …> <n>ms". The first caller is the origin.
    const parse = (e: string) => {
      const rest = e.slice(e.indexOf(" ") + 1);
      return { agent: rest.split(" ")[0] || "unknown", ok: !/ ERROR /.test(` ${rest} `) };
    };
    const tally = (entries: string[]) => {
      const byAgent: Record<string, { ok: number; error: number }> = {};
      for (const e of entries) {
        const { agent, ok } = parse(e);
        const t = (byAgent[agent] ??= { ok: 0, error: 0 });
        ok ? t.ok++ : t.error++;
      }
      return byAgent;
    };
    const agents = this.agentStore.list();
    const weekAgo = iso(7 * 86_400_000);
    const schedules = this.listSchedules(owner);
    return {
      tools: { active: snap.tools.active ?? 0, archived: snap.tools.archived ?? 0, unversioned: snap.tools.unversioned ?? 0 },
      builds: Object.fromEntries(snap.builds.map((b) => [b.status, b.n])),
      buildSeconds7d: { count: snap.buildTime.n, sum: Math.round(snap.buildTime.seconds ?? 0) },
      calls24h: tally(snap.calls24h),
      calls7d: tally(snap.calls7d),
      model: { month: new Date(now).toISOString().slice(0, 7), usd: snap.model.usd ?? 0, inputTokens: snap.model.input ?? 0, outputTokens: snap.model.output ?? 0, calls: snap.model.calls },
      agents: { connected: agents.length, active7d: agents.filter((a) => a.lastUsedAt && a.lastUsedAt >= weekAgo).length },
      schedules: schedules.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {}),
      schedulesFailing: schedules.filter((x) => (x.failures ?? 0) > 0).length,
    };
  }

  // ---------- models: the owner's providers, tiers, budget; the port capabilities call ----------

  /** The owner's model settings (provider, tiers, caps, price overrides). */
  modelSettings_(): ModelSettings {
    return normalizeModelSettings(this.registry.getKv<Record<string, any>>("models.settings"));
  }

  /** The catalog by model id. Readiness asks often: the large list is parsed again only when a refresh replaced it. */
  private catalog(): Map<string, CatalogEntry> {
    const at = this.registry.getKv<string>("models.catalogAt");
    if (!at) return new Map();
    if (this.catalogIndex?.fetchedAt !== at) {
      const stored = this.registry.getKv<{ entries: CatalogEntry[] }>("models.catalog");
      this.catalogIndex = { fetchedAt: at, byId: new Map((stored?.entries ?? []).map((e) => [e.id, e])) };
    }
    return this.catalogIndex.byId;
  }

  /** What a provider's key last listed (and so whether it works). Parsed once per write: lists can be long (OpenRouter). */
  private providerList(p: ModelProvider): { checkedAt: string; ok: boolean; error?: string; models: ProviderModel[]; byId: Map<string, ProviderModel> } | undefined {
    const raw = this.registry.getKvRaw(`models.provider.${p}`);
    const hit = this.providerLists.get(p);
    if (hit && hit.raw === raw) return hit.list;
    const v = raw ? (JSON.parse(raw) as { checkedAt: string; ok: boolean; error?: string; models: ProviderModel[] } | null) : null;
    const list = v ? { ...v, byId: new Map(v.models.map((m) => [m.id, m])) } : undefined;
    this.providerLists.set(p, { raw, list });
    return list;
  }

  private priceOf(model: string, settings = this.modelSettings_()): ModelPrice | undefined {
    return settings.prices[model] ?? this.catalog().get(model)?.price;
  }

  /** Price and image support of "<provider>/<model-id>": the provider's own word first, then the catalog. */
  private modelInfo(model: string): { price?: ModelPrice; images?: boolean } {
    const p = providerOf(model)!;
    const id = model.slice(p.length + 1);
    const own = this.providerList(p)?.byId.get(id)?.images;
    const entry = this.catalog().get(model);
    return { price: this.priceOf(model), images: own ?? (entry ? entry.input.includes("image") : undefined) };
  }

  /** Why a model requirement can't run right now, or undefined if it can. */
  modelProblem(r: ModelRequirement): string | undefined {
    // Hosted: the host runs it, or says why not when it's called.
    if (this.hostModels) return undefined;
    const resolved = resolveModel(r, this.modelSettings_());
    if ("problem" in resolved) return resolved.problem;
    const provider = providerOf(resolved.model);
    if (!provider) return `${resolved.model} names no known provider (anthropic, openai, openrouter)`;
    if (!this.modelFetch) return "this Hewn host can't reach model providers";
    if (this.secrets.get(MODEL_KEYS, provider) === undefined) return `no ${PROVIDER_LABEL[provider]} API key is set (Settings › AI › Models)`;
    const retired = r.model ? this.retiredModel(r.model) : undefined;
    if (retired) return `${r.model} is no longer available${retired.successor ? `; replace it with ${retired.successor}` : "; choose a replacement"} (Settings › AI › Models)`;
    const info = this.modelInfo(resolved.model);
    if (r.input?.includes("image") && info.images === false) return `${resolved.model} doesn't take images`;
    if (!info.price) return `no price is known for ${resolved.model} (the model catalog doesn't list it; set a price under Settings › AI › Models)`;
    return undefined;
  }

  /** Settings › AI › Models: what the owner sees (key presence only, never values). */
  models(owner: Agent) {
    requireOwner(owner);
    const settings = this.modelSettings_();
    const stored = this.registry.getKv<{ fetchedAt: string; error?: string }>("models.catalog");
    const active = this.registry.listActiveCapabilities().map((c) => ({ id: c.id, name: c.displayName ?? c.name, model: this.activeManifest(c.id).requires?.model }));
    const providers = MODEL_PROVIDERS.map((p) => {
      const list = this.providerList(p);
      const keySet = this.secrets.get(MODEL_KEYS, p) !== undefined;
      const models = (list?.models ?? []).map((m) => ({ ...m, ...this.modelInfo(`${p}/${m.id}`) })).sort((a, b) => (a.price?.output ?? Infinity) - (b.price?.output ?? Infinity));
      const suggested = keySet && list?.ok ? suggestTiers(p, list.models, (id) => this.modelInfo(`${p}/${id}`)) : { tiers: {}, by: "family" as const };
      return { id: p, label: PROVIDER_LABEL[p], keySet, check: list ? { ok: list.ok, at: list.checkedAt, error: list.error ?? null } : null, models, tiers: settings.tiers[p] ?? {}, suggested };
    });
    return {
      provider: settings.provider ?? null,
      tierNames: MODEL_TIERS,
      providers,
      /** Capabilities on each tier (they follow the active provider). */
      usage: Object.fromEntries(MODEL_TIERS.map((t) => [t, active.filter((c) => c.model?.tier === t).map((c) => ({ id: c.id, name: c.name }))])),
      /** Capabilities that pin one model: they use its provider whatever is active. */
      pinned: active.filter((c) => c.model?.model).map((c) => ({ id: c.id, name: c.name, model: c.model!.model!, problem: this.modelProblem(c.model!) ?? null, retired: this.retiredModel(c.model!.model!) ?? null })),
      monthlyCapUsd: settings.monthlyCapUsd,
      capabilityCapsUsd: settings.capabilityCapsUsd,
      capabilityCapsHost: settings.capabilityCapsHost,
      // Hosted: each capped tool's use this month, in the cap's unit.
      hostCapUse: this.hostModels ? Object.fromEntries(Object.keys(settings.capabilityCapsHost).map((id) => [id, this.hostCapUse(id)])) : {},
      prices: settings.prices,
      catalog: { fetchedAt: stored?.fetchedAt || null, error: stored?.error ?? null },
      spend: this.modelSpend(owner),
      // Hosted: the host runs tools' model calls; what it charged this month, per unit, as given.
      host: this.hostModels ? { charges: this.hostCharges(owner) } : null,
    };
  }

  /**
   * Change model settings (owner only): the active provider (it must have a key; its tiers start
   * from the suggestion), a provider's tiers (ids within that provider; null clears one), caps, prices.
   */
  setModelSettings(owner: Agent, change: { provider?: string; tiers?: Record<string, Record<string, string | null>>; monthlyCapUsd?: unknown; capabilityCapsUsd?: Record<string, unknown>; capabilityCapsHost?: Record<string, unknown>; prices?: Record<string, unknown> }) {
    requireOwner(owner);
    const next = this.modelSettings_();
    const usd = (v: unknown, what: string) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) throw new PlatformError("invalid_request", `${what} must be a number of USD from 0 to 100000`);
      return v;
    };
    const provider = (p: string) => {
      if (!(MODEL_PROVIDERS as readonly string[]).includes(p)) throw new PlatformError("invalid_request", `unknown provider ${p} (anthropic, openai, openrouter)`);
      return p as ModelProvider;
    };
    if (change.tiers !== undefined) {
      for (const [p, tiers] of Object.entries(change.tiers ?? {})) {
        const pr = provider(p);
        const cur: TierModels = { ...(next.tiers[pr] ?? {}) };
        for (const [tier, id] of Object.entries(tiers ?? {})) {
          if (!(MODEL_TIERS as readonly string[]).includes(tier)) throw new PlatformError("invalid_request", `unknown tier ${tier}`);
          if (id === null || id === "") delete cur[tier as ModelTier];
          else if (typeof id !== "string" || !/^[A-Za-z0-9._:\/-]+$/.test(id) || id.startsWith(`${pr}/`)) throw new PlatformError("invalid_request", `${tier}: expected a ${PROVIDER_LABEL[pr]} model id (without "${pr}/")`);
          else cur[tier as ModelTier] = id;
        }
        next.tiers[pr] = cur;
      }
    }
    if (change.provider !== undefined) {
      const pr = provider(change.provider);
      if (this.secrets.get(MODEL_KEYS, pr) === undefined) throw new PlatformError("invalid_request", `set the ${PROVIDER_LABEL[pr]} API key first`);
      next.provider = pr;
      if (!Object.keys(next.tiers[pr] ?? {}).length) next.tiers[pr] = this.suggestedTiers(pr);
    }
    if (change.monthlyCapUsd !== undefined) next.monthlyCapUsd = usd(change.monthlyCapUsd, "the monthly cap");
    if (change.capabilityCapsHost !== undefined)
      next.capabilityCapsHost = Object.fromEntries(
        Object.entries(change.capabilityCapsHost ?? {}).map(([id, v]) => {
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000) throw new PlatformError("invalid_request", `${id}'s cap must be a number from 0 to 1000000`);
          return [id, v];
        }),
      );
    if (change.capabilityCapsUsd !== undefined) next.capabilityCapsUsd = Object.fromEntries(Object.entries(change.capabilityCapsUsd ?? {}).map(([id, v]) => [id, usd(v, `${id}'s cap`)]));
    if (change.prices !== undefined) {
      next.prices = Object.fromEntries(
        Object.entries(change.prices ?? {}).map(([model, p]) => {
          if (!providerOf(model)) throw new PlatformError("invalid_request", `price for ${model}: expected "<provider>/<model-id>"`);
          const perM = (x: unknown) => usd(x, `${model}'s price per million tokens`) / 1_000_000;
          return [model, { input: perM((p as { input?: unknown })?.input), output: perM((p as { output?: unknown })?.output) }];
        }),
      );
    }
    this.saveModelSettings(owner, next);
    return this.models(owner);
  }

  private saveModelSettings(owner: Agent, next: ModelSettings) {
    this.registry.setKv("models.settings", next);
    const tiers = next.provider ? Object.entries(next.tiers[next.provider] ?? {}).map(([t, m]) => `${t}=${m}`).join(", ") : "";
    this.registry.addAuthorityEvent({ actor: owner.id, action: "models_set", subject: "models", detail: `${next.provider ? `${PROVIDER_LABEL[next.provider]}: ${tiers || "no tiers"}` : "no provider"}; cap $${next.monthlyCapUsd}/month` });
    this.logger(`model settings changed by ${owner.id}`);
  }

  private suggestedTiers(p: ModelProvider): TierModels {
    const list = this.providerList(p);
    return list?.ok ? suggestTiers(p, list.models, (id) => this.modelInfo(`${p}/${id}`)).tiers : {};
  }

  /**
   * Set a provider's API key (owner only; stored like secrets, never shown). The key is checked
   * with the provider's free models list first; a refused key isn't stored. With no provider
   * active yet, this one becomes active with its suggested tiers.
   */
  async setModelKey(owner: Agent, provider: string, key: string | null) {
    requireOwner(owner);
    if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) throw new PlatformError("invalid_request", `unknown provider ${provider} (anthropic, openai, openrouter)`);
    const p = provider as ModelProvider;
    if (key === null) {
      this.secrets.delete(MODEL_KEYS, p);
      this.registry.setKv(`models.provider.${p}`, null);
      const s = this.modelSettings_();
      if (s.provider === p) {
        delete s.provider;
        this.saveModelSettings(owner, s);
      }
      this.registry.addAuthorityEvent({ actor: owner.id, action: "model_key_removed", subject: p });
      this.logger(`${p} model key removed by ${owner.id}`);
      return this.models(owner);
    }
    const clean = key.trim();
    if (clean.length < 8 || clean.length > 500 || /\s/.test(clean)) throw new PlatformError("invalid_request", "that doesn't look like an API key");
    const checked = await this.listProviderModels(p, clean);
    if (!checked.ok && checked.refused) throw new PlatformError("invalid_request", `${PROVIDER_LABEL[p]} refused that key: ${checked.error}`);
    this.secrets.set(MODEL_KEYS, p, clean);
    this.registry.setKv(`models.provider.${p}`, { checkedAt: new Date().toISOString(), ok: checked.ok, ...(checked.ok ? {} : { error: checked.error }), models: checked.models });
    this.registry.addAuthorityEvent({ actor: owner.id, action: "model_key_set", subject: p });
    this.logger(`${p} model key set by ${owner.id}`);
    this.noteRetiredModels();
    const s = this.modelSettings_();
    if (!s.provider) {
      s.provider = p;
      if (!Object.keys(s.tiers[p] ?? {}).length) s.tiers[p] = this.suggestedTiers(p);
      this.saveModelSettings(owner, s);
    }
    return this.models(owner);
  }

  /**
   * A pinned model that is gone: the provider's own list (which the key can use) no longer has it,
   * or for OpenRouter, the catalog doesn't. Unknown (no list yet) is not retired. Returns the
   * suggested successor (the newest model of the same Claude family), if any.
   */
  retiredModel(model: string): { successor?: string } | undefined {
    const p = providerOf(model);
    if (!p) return undefined;
    const id = model.slice(p.length + 1);
    let ids: string[] | undefined;
    if (p === "openrouter") {
      const stored = this.registry.getKv<{ error?: string }>("models.catalog");
      if (!this.catalog().size || stored?.error) return undefined;
      ids = [...this.catalog().keys()].filter((k) => k.startsWith("openrouter/")).map((k) => k.slice("openrouter/".length));
    } else {
      const list = this.providerList(p);
      if (!list?.ok || !list.models.length) return undefined;
      ids = list.models.map((m) => m.id);
    }
    if (ids.includes(id)) return undefined;
    const family = /claude-(haiku|sonnet|opus|fable)/.exec(id)?.[0];
    const models = p === "openrouter" ? [...this.catalog().values()].filter((e) => e.id.startsWith("openrouter/")).map((e) => ({ id: e.id.slice(11), created: e.created })) : this.providerList(p)!.models;
    const successor = family ? models.filter((m) => m.id.includes(family) && !/-\d{8}$/.test(m.id) && !m.id.includes(":")).sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]?.id : undefined;
    return successor ? { successor: `${p}/${successor}` } : {};
  }

  /**
   * Change the model a capability uses (owner only): another tier, or one pinned model. A new
   * version whose manifest says so, same code, no builder; the new model grant comes with it (the
   * owner chose it). Also how a retired pinned model is replaced.
   */
  async setCapabilityModel(owner: Agent, capabilityId: string, to: { tier?: string; model?: string }): Promise<BuildView> {
    requireOwner(owner);
    const cur = this.activeManifest(capabilityId).requires?.model;
    if (!cur) throw new PlatformError("invalid_request", `${capabilityId} doesn't use a model (that takes a change by the builder)`);
    if ((to.tier === undefined) === (to.model === undefined)) throw new PlatformError("invalid_request", 'give either "tier" or "model"');
    let next: ModelRequirement;
    if (to.tier !== undefined) {
      if (!(MODEL_TIERS as readonly string[]).includes(to.tier)) throw new PlatformError("invalid_request", `unknown tier ${to.tier} (${MODEL_TIERS.join(", ")})`);
      next = { tier: to.tier as ModelTier, ...(cur.input ? { input: cur.input } : {}) };
    } else {
      const model = to.model!;
      const p = providerOf(model);
      if (!p || !/^[a-z]+\/[A-Za-z0-9._:\/-]+$/.test(model)) throw new PlatformError("invalid_request", `expected "<provider>/<model-id>" (anthropic, openai or openrouter), not ${model}`);
      const list = p === "openrouter" ? undefined : this.providerList(p);
      if (list?.ok && !list.byId.has(model.slice(p.length + 1))) throw new PlatformError("invalid_request", `${PROVIDER_LABEL[p]} doesn't list ${model} for your key`);
      next = { model, ...(cur.input ? { input: cur.input } : {}) };
    }
    if (modelGrant(next) === modelGrant(cur)) throw new PlatformError("invalid_request", `${capabilityId} already uses ${next.tier ? `the ${next.tier} tier` : next.model}`);
    const grant = modelGrant(next);
    this.registry.approveGrant(capabilityId, "model", grant.slice("model:".length), owner.id);
    this.registry.addGrantEvent(capabilityId, "approve", grant, owner.id);
    const what = next.tier ? `the ${next.tier} tier` : next.model;
    return this.manifestOnlyModify(owner, capabilityId, (m) => (m.requires!.model = next), `use ${what} instead of ${cur.tier ? `the ${cur.tier} tier` : cur.model}`);
  }

  /** A retired (or any) pinned model replaced by another pinned model. */
  replacePinnedModel(owner: Agent, capabilityId: string, model: string): Promise<BuildView> {
    if (!this.activeManifest(capabilityId).requires?.model?.model) throw new PlatformError("invalid_request", `${capabilityId} doesn't pin a model`);
    return this.setCapabilityModel(owner, capabilityId, { model });
  }

  /**
   * Platform-internal: a new version with the active version's files and an edited manifest, run
   * through the normal validation and promotion, with no builder ("keep"). Never a way to change code.
   */
  private async manifestOnlyModify(owner: Agent, capabilityId: string, edit: (m: CapabilityManifest) => void, request: string): Promise<BuildView> {
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

  /** Once per retired pinned model: an authority event, so Activity says why a capability stopped. */
  private noteRetiredModels() {
    for (const c of this.registry.listActiveCapabilities()) {
      const pinned = this.activeManifest(c.id).requires?.model?.model;
      const r = pinned ? this.retiredModel(pinned) : undefined;
      const flag = `models.retiredNoted.${c.id}.${pinned}`;
      if (!r || this.registry.getKv<boolean>(flag)) continue;
      this.registry.setKv(flag, true);
      this.registry.addAuthorityEvent({ actor: "platform", action: "model_retired", subject: pinned!, capabilityId: c.id, detail: r.successor ? `suggested: ${r.successor}` : "" });
      this.logger(`${c.id}: pinned model ${pinned} is no longer available${r.successor ? ` (suggested: ${r.successor})` : ""}`);
    }
  }

  /** Check a provider's stored key again (and refresh what it can use). */
  async checkModelProvider(owner: Agent, provider: string) {
    requireOwner(owner);
    const p = provider as ModelProvider;
    const key = this.secrets.get(MODEL_KEYS, p);
    if (key === undefined) throw new PlatformError("invalid_request", `no ${PROVIDER_LABEL[p] ?? provider} key is set`);
    const checked = await this.listProviderModels(p, key);
    const prev = this.providerList(p);
    this.registry.setKv(`models.provider.${p}`, { checkedAt: new Date().toISOString(), ok: checked.ok, ...(checked.ok ? {} : { error: checked.error }), models: checked.ok ? checked.models : (prev?.models ?? []) });
    this.noteRetiredModels();
    return this.models(owner);
  }

  /** List the models a key can use (this is also the key check). Never throws for network or provider trouble. */
  private async listProviderModels(p: ModelProvider, key: string): Promise<{ ok: true; models: ProviderModel[] } | { ok: false; refused: boolean; error: string; models: ProviderModel[] }> {
    if (!this.modelFetch) return { ok: false, refused: false, error: "this Hewn host can't reach model providers", models: [] };
    if (p === "openrouter" && !this.catalog().size) await this.refreshModelCatalog();
    const models: ProviderModel[] = [];
    let after: string | undefined;
    try {
      for (let page = 0; page < 20; page++) {
        const call = listModelsCall(p, key, after);
        const res = await this.modelFetch(call.url, { ...call.init, signal: AbortSignal.timeout(15_000) });
        const body = await res.text();
        if (!res.ok) {
          const err = providerError(p, res.status, body);
          return { ok: false, refused: res.status === 401 || res.status === 403, error: err.message.replace(/^model provider \w+: /, ""), models: [] };
        }
        const parsed = parseModelList(p, JSON.parse(body), this.catalog());
        models.push(...parsed.models);
        if (!parsed.next) break;
        after = parsed.next;
      }
      return { ok: true, models };
    } catch (e) {
      return { ok: false, refused: false, error: `couldn't reach ${PROVIDER_LABEL[p]}: ${(e as Error).message}`, models: [] };
    }
  }

  /** Refresh the model catalog (prices, context, input kinds) from OpenRouter's public list. A failure keeps the last good copy. */
  async refreshModelCatalog(): Promise<{ models: number } | { error: string }> {
    if (!this.modelFetch) return { error: "no network for models on this host" };
    const stored = this.registry.getKv<{ fetchedAt: string; entries: CatalogEntry[]; error?: string }>("models.catalog");
    try {
      const res = await this.modelFetch(CATALOG_URL, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entries = parseCatalog(await res.json());
      if (!entries.length) throw new Error("the list was empty");
      const fetchedAt = new Date().toISOString();
      this.registry.setKv("models.catalog", { fetchedAt, entries });
      this.registry.setKv("models.catalogAt", fetchedAt);
      this.noteRetiredModels();
      this.events.emit("changed");
      return { models: entries.length };
    } catch (e) {
      const error = `model catalog refresh failed: ${(e as Error).message}`;
      this.registry.setKv("models.catalog", { fetchedAt: stored?.fetchedAt ?? "", entries: stored?.entries ?? [], error });
      this.logger(error);
      return { error };
    }
  }

  /** What the host charged this month (builds, the intake, model calls), per unit: amounts as given, summed as decimals. */
  hostCharges(owner: Agent, month = new Date().toISOString().slice(0, 7)) {
    requireOwner(owner);
    const rows = this.registry.hostCharges(month);
    const units = [...new Set(rows.map((r) => r.unit))];
    return { month, totals: units.map((unit) => ({ unit, amount: Math.round(rows.filter((r) => r.unit === unit).reduce((n, r) => n + r.amount, 0) * 100) / 100 })), rows, byCapability: this.registry.hostChargesByCapability(month) };
  }

  /**
   * What a tool's model calls were charged this month, against its hosted cap: in the unit its latest
   * charge used (a cap has no unit of its own; a host keeps one), rounded to the hundredth.
   */
  hostCapUse(capabilityId: string, month = new Date().toISOString().slice(0, 7)): { spent: number; unit: string } {
    const used = this.registry.hostChargesByCapability(month).filter((x) => x.capabilityId === capabilityId);
    const unit = this.registry.latestHostChargeUnit(capabilityId) ?? used[0]?.unit ?? "Credits";
    return { spent: Math.round(used.filter((x) => x.unit === unit).reduce((n, x) => n + x.amount, 0) * 100) / 100, unit };
  }

  /** Record a charge the host made for something Hewn didn't run itself (an intake turn). */
  recordHostCharge(owner: Agent, kind: "intake", c: unknown) {
    requireOwner(owner);
    if (saneCharge(c)) this.registry.addHostCharge(kind, c);
  }

  /** This month's model spend (owner only). */
  modelSpend(owner: Agent, month = new Date().toISOString().slice(0, 7)) {
    requireOwner(owner);
    const rows = this.registry.modelSpend(month);
    return { month, totalUsd: rows.reduce((n, r) => n + r.costUsd, 0), capUsd: this.modelSettings_().monthlyCapUsd, rows };
  }

  /** ctx.model.generate for one call chain: checks, reserves budget, calls the provider, settles. */
  private modelHandler(capabilityId: string, requirement: ModelRequirement, deadline: Deadline, caller: string): ModelHandler {
    if (this.hostModels) return this.hostModelHandler(this.hostModels, capabilityId, requirement, deadline, caller);
    return async (raw: GenerateRequest) => {
      const problem = this.modelProblem(requirement);
      if (problem) throw new PlatformError("not_ready", `${capabilityId} can't use a model: ${problem}`);
      const r = inspectRequest(raw, requirement.input?.includes("image") ?? false);
      const settings = this.modelSettings_();
      const model = (resolveModel(requirement, settings) as { model: string }).model;
      const provider = providerOf(model)!;
      const price = this.priceOf(model)!;
      const key = this.secrets.get(MODEL_KEYS, provider)!;
      const budgetMs = deadline.modelBudget();
      if (budgetMs < 1000) throw new PlatformError("operation_failed", "no time left in this call chain for a model call (an async operation suits long work)");

      const month = new Date().toISOString().slice(0, 7);
      const reserve = costOf(price, estimateInputTokens(r), r.maxTokens);
      const id = `m-${randomToken().slice(0, 16)}`;
      const caps = { total: settings.monthlyCapUsd, capability: settings.capabilityCapsUsd[capabilityId] };
      const held = this.registry.reserveModelSpend({ id, capabilityId, model, month, usd: reserve, caller }, caps);
      if (!held.ok) {
        throw new PlatformError(
          "operation_failed",
          `model budget: this call could cost up to $${reserve.toFixed(4)}, and ${held.scope === "all" ? `all tools together have spent $${held.spent.toFixed(2)} of the $${held.cap.toFixed(2)} monthly budget` : `${capabilityId} has spent $${held.spent.toFixed(2)} of its $${held.cap.toFixed(2)} this month`} (raise it under Settings › AI › Models)`,
          { model: { budget: true } },
        );
      }
      const modelId = model.slice(provider.length + 1);
      const call = buildCall(provider, modelId, key, r);
      let reply: ReturnType<typeof parseReply> | undefined;
      deadline.beginWait();
      try {
        for (let attempt = 0; ; attempt++) {
          const res = await this.modelFetch!(call.url, { ...call.init, signal: AbortSignal.timeout(Math.max(1000, deadline.modelBudget())) });
          const body = await res.text();
          if (res.ok) {
            reply = parseReply(provider, JSON.parse(body));
            break;
          }
          const err = providerError(provider, res.status, body);
          const retryable = (err.details as { model: { retryable: boolean } }).model.retryable;
          if (!retryable || attempt >= 1 || deadline.modelBudget() < 5000) throw err;
          await new Promise((ok) => setTimeout(ok, 1000));
        }
      } catch (e) {
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        const err = e instanceof PlatformError ? e : new PlatformError("operation_failed", timedOut ? `model provider ${provider}: no reply in time` : `model provider ${provider}: ${(e as Error).message}`);
        // A failed request isn't billed by the providers; nothing is spent.
        this.registry.settleModelSpend(id, { costUsd: 0, inputTokens: 0, outputTokens: 0, error: err.message.slice(0, 300) });
        throw err;
      } finally {
        deadline.endWait();
      }
      const cost = reply.cost ?? costOf(price, reply.inputTokens, reply.outputTokens);
      // Billed all the same; half a reply is no reply.
      this.registry.settleModelSpend(id, { costUsd: cost, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, ...(reply.cutOff ? { error: cutOffMessage(r.maxTokens) } : {}) });
      this.warnNearCap(capabilityId, month, settings);
      if (reply.cutOff) throw new PlatformError("operation_failed", cutOffMessage(r.maxTokens), { model: { stop: "max_tokens" } });
      const json = r.schema ? structured(reply.text, r.schema) : undefined;
      return { text: reply.text, ...(json !== undefined ? { json } : {}), usage: { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens }, cost, model };
    };
  }

  /**
   * Hosted: ctx.model.generate goes to the host. The request is checked here as for a provider; the
   * host picks the model and charges in its own unit. The call is logged (Activity) at $0.
   */
  private hostModelHandler(host: HostModels, capabilityId: string, requirement: ModelRequirement, deadline: Deadline, caller: string): ModelHandler {
    return async (raw: GenerateRequest) => {
      const r = inspectRequest(raw, requirement.input?.includes("image") ?? false);
      if (deadline.modelBudget() < 1000) throw new PlatformError("operation_failed", "no time left in this call chain for a model call (an async operation suits long work)");
      // The tool's own cap, in the host's unit: checked before the call (a call's charge is known only
      // after, so calls running at once may each pass it; the month's total is the host's to enforce).
      const cap = this.modelSettings_().capabilityCapsHost[capabilityId];
      if (cap !== undefined) {
        const { spent, unit } = this.hostCapUse(capabilityId);
        if (spent >= cap) throw new PlatformError("operation_failed", `model budget: ${capabilityId} has used ${spent} of its ${cap} ${unit} this month (raise it in the tool's model settings)`, { model: { budget: true } });
      }
      const id = `m-${randomToken().slice(0, 16)}`;
      const asked = requirement.model ?? `tier:${requirement.tier ?? "standard"}`;
      this.registry.reserveModelSpend({ id, capabilityId, model: asked, month: new Date().toISOString().slice(0, 7), usd: 0, caller }, { total: Infinity });
      const recordCharge = (c: unknown) => saneCharge(c) && this.registry.addHostCharge("model", c, capabilityId);
      const messages: ModelMessage[] = raw.messages ?? [{ role: "user", content: raw.prompt! }];
      let reply: HostGenerateResult;
      deadline.beginWait();
      try {
        reply = await host(
          { capabilityId, ...(requirement.model ? { model: requirement.model } : { tier: requirement.tier ?? "standard" }), ...(raw.system !== undefined ? { system: raw.system } : {}), messages, ...(r.schema ? { schema: r.schema } : {}), maxTokens: r.maxTokens },
          AbortSignal.timeout(Math.max(1000, deadline.modelBudget())),
        );
      } catch (e) {
        recordCharge((e as { charge?: unknown }).charge);
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        const cutOff = (e as { stop?: string }).stop === "max_tokens";
        // A refusal, or a reply cut off at the tool's limit, is worded for the owner: kept as is.
        const message = timedOut ? "the model: no reply in time" : cutOff ? cutOffMessage(r.maxTokens) : (e as { refused?: boolean }).refused ? (e as Error).message : `the model: ${(e as Error).message}`;
        this.registry.settleModelSpend(id, { costUsd: 0, inputTokens: 0, outputTokens: 0, error: message.slice(0, 300) });
        throw new PlatformError("operation_failed", message, cutOff ? { model: { stop: "max_tokens" } } : undefined);
      } finally {
        deadline.endWait();
      }
      recordCharge(reply.charge);
      const usage = { inputTokens: Number(reply.usage?.inputTokens) || 0, outputTokens: Number(reply.usage?.outputTokens) || 0 };
      this.registry.settleModelSpend(id, { costUsd: 0, ...usage });
      const text = String(reply.text ?? "");
      const json = r.schema ? structured(text, r.schema) : undefined;
      return { text, ...(json !== undefined ? { json } : {}), usage, cost: 0, model: String(reply.model ?? asked) };
    };
  }

  /** Once a month per cap: an authority event when spend passes 80 % of it. */
  private warnNearCap(capabilityId: string, month: string, settings: ModelSettings) {
    const rows = this.registry.modelSpend(month);
    const checks: [string, number, number][] = [["all", rows.reduce((n, r) => n + r.costUsd, 0), settings.monthlyCapUsd]];
    const own = settings.capabilityCapsUsd[capabilityId];
    if (own !== undefined) checks.push([capabilityId, rows.filter((r) => r.capabilityId === capabilityId).reduce((n, r) => n + r.costUsd, 0), own]);
    for (const [scope, spent, cap] of checks) {
      const flag = `models.warned.${month}.${scope}`;
      if (cap > 0 && spent >= 0.8 * cap && !this.registry.getKv<boolean>(flag)) {
        this.registry.setKv(flag, true);
        this.registry.addAuthorityEvent({ actor: "platform", action: "model_budget_80", subject: scope, ...(scope === "all" ? {} : { capabilityId }), detail: `$${spent.toFixed(2)} of $${cap.toFixed(2)} this month` });
        this.logger(`model spend for ${scope} passed 80% of its cap ($${spent.toFixed(2)} of $${cap.toFixed(2)})`);
      }
    }
  }

  // ---------- invocation ----------

  /**
   * `record: false`: not written to the call log (Accounts' health checks, which run on every visit).
   * `readOnly`: a widget's call. Its own state may only be read, and the whole chain may run read
   * operations only, without a model (`readChain`, passed on to the operations it calls).
   * `origin`: who started the call chain (passed on to the operations it calls): an agent's
   * destructive call waits for the owner however many capabilities it goes through.
   */
  async invoke(
    agent: Agent,
    req: InvokeRequest,
    trace: string[] = [agent.id],
    within: Deadline | number = Date.now() + CALL_DEADLINE_MS,
    { record = true, readOnly = false, readChain = readOnly, origin = agent }: { record?: boolean; readOnly?: boolean; readChain?: boolean; origin?: Agent } = {},
  ) {
    const deadline = deadlineOf(within, CALL_DEADLINE_MS);
    requireScope(agent, "invoke");
    const cap = this.visibleActive(agent, req.capabilityId);
    // trace = [origin caller, ...capabilities on the call path]
    if (trace.slice(1).includes(cap.id)) throw new PlatformError("forbidden", `call cycle: ${[...trace, cap.id].join(" → ")}`);
    if (trace.length > MAX_CALL_DEPTH) throw new PlatformError("forbidden", `call depth exceeds ${MAX_CALL_DEPTH}: ${[...trace, cap.id].join(" → ")}`);
    if (deadline.remaining() <= 0) throw new PlatformError("operation_failed", `call chain deadline exceeded: ${[...trace, cap.id].join(" → ")}`);
    const status = this.readiness(cap.id);
    const signIn = connectOperation(this.activeManifest(cap.id));
    const isSignIn = !!signIn && req.operation === "connect";
    if (isSignIn && agent.kind !== "user") throw new PlatformError("forbidden", `connect is ${cap.id}'s sign-in step: only the owner runs it, under Accounts in Hewn`);
    // The sign-in step fills the secrets, so it runs without them (everything else must be in place).
    const missingOnlySecrets = !status.ready && !status.unsupportedAbi && !status.pendingGrants.length && !status.missingConfig.length && !status.missingDependencies.length;
    if (!status.ready && !(isSignIn && missingOnlySecrets)) throw new PlatformError("not_ready", `${cap.id} is not ready`, status);
    const version = await this.loadVersion(cap.id, cap.activeVersion!);
    const manifest = version.row.manifest;
    if (origin.kind === "agent" || readChain) {
      const op = resolveOperation(manifest, req.operation, req.operationVersion);
      if (readChain && op.sideEffect !== "read") throw new PlatformError("forbidden", `widgets are read-only: ${cap.id}/${opKey(op.name, op.version)} is a ${op.sideEffect} operation`);
      if (op.sideEffect === "destructive" && origin.kind === "agent") await this.d.grants.confirmDestructive(origin, cap.id, opKey(op.name, op.version), req.input ?? {}, trace.slice(1));
    }
    // Only what is declared, granted and stored reaches the capability.
    const declared = manifest.requires?.secrets?.map((s) => s.name) ?? [];
    const secrets = Object.fromEntries(declared.flatMap((n) => (this.secrets.get(cap.id, n) === undefined ? [] : [[n, this.secrets.get(cap.id, n)!]])));
    const config = this.registry.config(cap.id);
    const target: ExecutionTarget = {
      capabilityId: cap.id,
      code: version.code,
      state: { capabilityId: cap.id },
      hosts: resolveHosts(manifest, config),
      secrets,
      config: Object.fromEntries((manifest.config ?? []).filter((c) => config[c.name] !== undefined).map((c) => [c.name, config[c.name]])),
      caller: { kind: agent.kind, id: agent.kind === "capability" ? agent.id.replace(/^capability:/, "") : agent.id },
      deadline,
      ...(readOnly ? { readOnly: true } : {}),
    };
    const declaredCalls = manifest.requires?.capabilities ?? [];
    // A destructive call further down the chain waiting for the owner: reported as such to whoever
    // started the chain, not as this operation's failure.
    let held: PlatformError | undefined;
    const onCall = async (c: { capabilityId: string; operation: string; input: unknown }) => {
      const dep = declaredCalls.find((d) => d.id === c.capabilityId && d.operations.includes(c.operation));
      if (!dep) throw new PlatformError("forbidden", `${cap.id} did not declare ${c.capabilityId}/${c.operation} in requires.capabilities`);
      if (!this.registry.grants(cap.id).has(`capability:${c.capabilityId}/${c.operation}`)) {
        throw new PlatformError("forbidden", `${cap.id} is not granted ${c.capabilityId}/${c.operation}`);
      }
      const [name, v] = c.operation.split("@");
      const principal: Agent = { id: `capability:${cap.id}`, kind: "capability", scopes: new Set(["invoke"]), capabilities: new Set([c.capabilityId]) };
      try {
        const r = await this.invoke(principal, { capabilityId: c.capabilityId, operation: name, operationVersion: Number(v), input: c.input }, [...trace, cap.id], deadline, { readChain, origin });
        return r.result;
      } catch (e) {
        if (e instanceof PlatformError && e.code === "awaiting_confirmation") held = e;
        throw e;
      }
    };
    const model = manifest.requires?.model;
    // Widgets never call a model: background refreshes would quietly drain the budget.
    const onModel = model && abiAtLeast(manifest, "2.2") && !readChain ? this.modelHandler(cap.id, model, deadline, trace[0]) : undefined;
    const started = Date.now();
    // A backstop for code that hands out its credentials: no stored secret leaves in a result, an
    // error or a log line.
    const secretValues = Object.values(secrets).flatMap(secretNeedles);
    const leaks = (s: string) => secretValues.some((v) => s.includes(v));
    const redact = (s: string) => secretValues.reduce((acc, v) => acc.split(v).join("[secret]"), s);
    let executed: Awaited<ReturnType<Platform["execute"]>>;
    try {
      executed = await this.execute(manifest, target, req, onCall, onModel);
    } catch (e) {
      if (held) throw held;
      const err = e as PlatformError;
      if (err instanceof Error && leaks(err.message)) err.message = redact(err.message);
      const logs = ((err.details as { logs?: string[] } | undefined)?.logs ?? []).map(redact);
      // The sign-in step handles credentials: neither its message nor its console lines are kept.
      if (!record) {
        // nothing kept
      } else if (isSignIn) this.capabilityLog(cap.id, trace.join(" → "), req, started, `ERROR ${err.code ?? "internal"}: (sign-in failed; details aren't kept)`, []);
      else {
        this.capabilityLog(cap.id, trace.join(" → "), req, started, `ERROR ${err.code ?? "internal"}: ${err.message}`, logs);
        this.noteFailure(cap.id, { caller: trace[0], operation: req.operationVersion ? `${req.operation}@${req.operationVersion}` : req.operation, error: err.message, input: redact(JSON.stringify(maskInput(req.input ?? {})) ?? "{}"), logs });
      }
      if (err.details && typeof err.details === "object" && "logs" in err.details) {
        const { logs: _omit, ...rest } = err.details as Record<string, unknown>;
        err.details = Object.keys(rest).length ? rest : undefined; // capability logs are for the user, not agents
      }
      throw e;
    }
    const { secretUpdates, logs: rawLogs, ...rest } = executed;
    for (const [name, value] of Object.entries(secretUpdates)) {
      if (declared.includes(name) && typeof value === "string") {
        this.secrets.set(cap.id, name, value);
        this.logger(`secret ${name} refreshed by ${cap.id}`);
        secretValues.push(...secretNeedles(value));
      } else {
        this.logger(`ignored secret update '${name}' from ${cap.id}: not declared`);
      }
    }
    const logs = rawLogs.map(redact);
    if (leaks(JSON.stringify(rest.result ?? null))) {
      const message = `${cap.id}/${rest.operation} returned one of its stored secrets; the result was withheld`;
      if (record) this.capabilityLog(cap.id, trace.join(" → "), req, started, `ERROR forbidden: ${message}`, isSignIn ? [] : logs);
      // A result carrying a stored secret is the tool's bug: worth asking the builder to fix.
      if (record && !isSignIn) this.noteFailure(cap.id, { caller: trace[0], operation: req.operationVersion ? `${req.operation}@${req.operationVersion}` : req.operation, error: message, input: redact(JSON.stringify(maskInput(req.input ?? {})) ?? "{}"), logs });
      this.logger(message);
      throw new PlatformError("forbidden", message);
    }
    const used = resolveOperation(manifest, req.operation, req.operationVersion);
    const out = used.deprecated ? { ...rest, deprecated: `${rest.operation} is deprecated${used.deprecated.replacement ? `; use ${used.deprecated.replacement}` : ""}${used.deprecated.note ? ` (${used.deprecated.note})` : ""}` } : rest;
    if (record) this.capabilityLog(cap.id, trace.join(" → "), req, started, "ok", isSignIn ? [] : logs);
    return out;
  }

  /** Contract-enforcing call: resolve operation, validate input, run, validate output. */
  private async execute(manifest: CapabilityManifest, target: ExecutionTarget, req: InvokeRequest, onCall?: CallHandler, onModel?: ModelHandler) {
    const op = resolveOperation(manifest, req.operation, req.operationVersion);
    const key = opKey(op.name, op.version);
    const input = req.input ?? {};
    const checkIn = compileSchema(op.inputSchema);
    if (!checkIn(input)) throw inputMismatch(key, schemaErrors(checkIn));
    const { output: result, secretUpdates, logs } = await this.runtime.invoke(target, key, input, onCall, onModel);
    const checkOut = compileSchema(op.outputSchema);
    if (!checkOut(result)) {
      throw new PlatformError("invalid_output", `implementation returned output violating ${key} outputSchema`, schemaErrors(checkOut));
    }
    return { capabilityId: manifest.id, operation: key, result, secretUpdates, logs };
  }

  // ---------- widgets (ABI 2.3) ----------

  /**
   * Run a widget: its read operation, read-only, without a model, and its output checked against
   * the template it names. The owner's widgets (Home) run as the widget's own identity
   * (`widget:<capability>/<name>`, that one operation only); an agent's run under its own grants.
   * The view is cached per widget and input, so Home can draw the last one at once.
   */
  async widget(agent: Agent, capabilityId: string, name: string, input: Record<string, unknown> = {}): Promise<WidgetResult> {
    requireScope(agent, "invoke");
    this.visibleActive(agent, capabilityId);
    const manifest = this.activeManifest(capabilityId);
    const w = widgetOf(manifest, name);
    if (!w || !abiAtLeast(manifest, "2.3")) throw new PlatformError("not_found", `${capabilityId} has no widget ${name}`);
    const [op, v] = w.operation.split("@");
    const principal: Agent = agent.kind === "user" ? { id: `widget:${capabilityId}/${name}`, kind: "widget", scopes: new Set(["invoke"]), capabilities: new Set([capabilityId]) } : agent;
    const key = widgetKey(capabilityId, name, input);
    try {
      const r = await this.invoke(principal, { capabilityId, operation: op, operationVersion: Number(v), input }, [principal.id], Date.now() + WIDGET_DEADLINE_MS, { readOnly: true });
      const problems = viewErrors(r.result);
      if (problems.length) throw new PlatformError("invalid_output", `widget ${name} returned something no template can draw`, problems);
      this.registry.putWidgetView(key, capabilityId, r.result);
      return { capabilityId, widget: name, title: w.title, view: r.result as WidgetOutput, at: new Date().toISOString() };
    } catch (e) {
      this.registry.putWidgetError(key, capabilityId, (e as Error).message);
      throw e;
    }
  }

  /** The widget's last view for this input (and the last refresh's error, if it failed). */
  cachedWidget(owner: Agent, capabilityId: string, name: string, input: Record<string, unknown> = {}) {
    requireOwner(owner);
    return this.registry.widgetCache(widgetKey(capabilityId, name, input));
  }

  /** Every visible capability's widgets, for the "Add widget" gallery and agents' discovery. */
  widgetGallery(agent: Agent): { capabilityId: string; name: string; widgets: (WidgetManifest & { inputSchema: Record<string, unknown> })[] }[] {
    return this.list(agent)
      .map((c) => {
        const m = this.activeManifest(c.id);
        if (!abiAtLeast(m, "2.3")) return { capabilityId: c.id, name: c.name, widgets: [] };
        return { capabilityId: c.id, name: c.name, widgets: (m.widgets ?? []).map((w) => ({ ...w, inputSchema: m.operations.find((o) => opKey(o.name, o.version) === w.operation)?.inputSchema ?? {} })) };
      })
      .filter((c) => c.widgets.length);
  }

  /**
   * Home: an ordered layout of capability icons and placed widgets. Icons the layout doesn't name
   * (new capabilities, or no layout yet) are left for the client to append; widgets whose
   * capability is gone are dropped, and those whose widget is gone are kept as `missing`.
   */
  homeLayout(owner: Agent): HomeEntryView[] {
    requireOwner(owner);
    const visible = new Set(this.list(owner).filter((c) => c.kind !== "connection").map((c) => c.id));
    const out: HomeEntryView[] = [];
    for (const e of this.registry.getKv<HomeEntry[]>(HOME_LAYOUT) ?? []) {
      if (!visible.has(e.id)) continue;
      if (e.type === "icon") {
        out.push(e);
        continue;
      }
      const m = this.activeManifest(e.id);
      const w = abiAtLeast(m, "2.3") ? widgetOf(m, e.widget) : undefined;
      const cached = this.registry.widgetCache(widgetKey(e.id, e.widget, e.input ?? {}));
      out.push({
        ...e,
        ...(w ? { title: w.title, sizes: w.sizes, refreshMs: refreshMs(w), ...(w.open ? { open: w.open } : {}) } : { missing: true }),
        // A widget that no longer offers the placed size (a change made it large-only) shows at its biggest.
        ...(w && !w.sizes.includes(e.size) ? { size: [...WIDGET_SIZES].reverse().find((s) => w.sizes.includes(s))! } : {}),
        view: cached?.view ?? null,
        at: cached?.at ?? null,
        error: cached?.error ?? null,
      });
    }
    return out;
  }

  setHomeLayout(owner: Agent, entries: unknown): HomeEntryView[] {
    requireOwner(owner);
    if (!Array.isArray(entries) || entries.length > 200) throw new PlatformError("invalid_request", "send { entries: [...] } (at most 200)");
    const visible = new Set(this.list(owner).map((c) => c.id));
    const keys = new Set<string>();
    const clean: HomeEntry[] = [];
    // Widgets already placed, by key: one whose options a later version no longer takes still saves
    // (it shows its error until the owner sets new options), so it can't block moving everything else.
    const placed = new Map((this.registry.getKv<HomeEntry[]>(HOME_LAYOUT) ?? []).flatMap((e) => (e.type === "widget" ? [[e.key, e] as const] : [])));
    for (const raw of entries as Record<string, unknown>[]) {
      const id = String(raw?.id ?? "");
      if (!visible.has(id)) continue; // gone since the page loaded
      if (raw.type === "icon") {
        // hidden: off Home (Edit Home's ×); it still shows in search, and keeps its place.
        if (!clean.some((e) => e.type === "icon" && e.id === id)) clean.push({ type: "icon", id, ...(raw.hidden === true ? { hidden: true as const } : {}) });
        continue;
      }
      if (raw.type !== "widget") throw new PlatformError("invalid_request", 'each entry is { type: "icon", id, hidden? } or { type: "widget", key, id, widget, size, input? }');
      const key = String(raw.key ?? "");
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || keys.has(key)) throw new PlatformError("invalid_request", "each placed widget needs its own key");
      keys.add(key);
      const widget = String(raw.widget ?? "");
      const m = this.activeManifest(id);
      const w = widgetOf(m, widget);
      const size = String(raw.size ?? "");
      const input = raw.input === undefined ? undefined : raw.input;
      if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) throw new PlatformError("invalid_request", `widget ${id}/${widget}: input must be an object`);
      if (w) {
        if (!(w.sizes as string[]).includes(size)) throw new PlatformError("invalid_request", `widget ${id}/${widget} comes in ${w.sizes.join(", ")}, not ${size}`);
        const op = m.operations.find((o) => opKey(o.name, o.version) === w.operation)!;
        const check = compileSchema(op.inputSchema);
        const prev = placed.get(key);
        // Compared as JSON: what the client sends back is what it was given, in the same key order.
        const unchanged = prev?.id === id && prev.widget === widget && JSON.stringify(prev.input ?? {}) === JSON.stringify(input ?? {});
        if (!unchanged && !check(input ?? {})) throw new PlatformError("invalid_request", `widget ${id}/${widget}: input doesn't match ${w.operation}`, schemaErrors(check));
      } else if (!(WIDGET_SIZES as readonly string[]).includes(size)) throw new PlatformError("invalid_request", `unknown size ${size}`);
      // A widget that no longer exists may stay where it is (shown as missing) but can't be placed anew.
      else if (!this.homeLayout(owner).some((e) => e.type === "widget" && e.key === key)) throw new PlatformError("not_found", `${id} has no widget ${widget}`);
      clean.push({ type: "widget", key, id, widget, size: size as WidgetSize, ...(input ? { input: input as Record<string, unknown> } : {}) });
    }
    this.registry.setKv(HOME_LAYOUT, clean);
    // Icons keep their place in the capability order too (search, agents' lists).
    this.registry.setHomeOrder(clean.filter((e) => e.type === "icon").map((e) => e.id));
    return this.homeLayout(owner);
  }

  /**
   * Put one widget on Home, at the end. Without a stored layout yet, the icons are placed first in
   * Home's current order, so the widget lands after them (next to "New").
   */
  placeWidget(owner: Agent, entry: { id: string; widget: string; size: string; input?: Record<string, unknown> }): HomeEntryView[] {
    requireOwner(owner);
    const stored = this.registry.getKv<HomeEntry[]>(HOME_LAYOUT);
    const order = (id: string) => this.registry.getCapability(id)?.homeOrder ?? Number.MAX_SAFE_INTEGER;
    const created = (id: string) => this.registry.getCapability(id)?.createdAt ?? "";
    const icons = this.list(owner)
      .filter((c) => c.kind !== "connection")
      .sort((a, b) => order(a.id) - order(b.id) || created(a.id).localeCompare(created(b.id)))
      .map((c) => ({ type: "icon" as const, id: c.id }));
    const base: HomeEntry[] = stored ?? icons;
    // Icons the layout doesn't name yet keep their place before the new widget.
    const missing = icons.filter((i) => !base.some((e) => e.type === "icon" && e.id === i.id));
    return this.setHomeLayout(owner, [...base, ...missing, { type: "widget", key: randomToken(6), ...entry }]);
  }

  /**
   * Delete a widget: a new version without it (manifest only, no builder; its operation stays, an
   * ordinary read), and it leaves Home now.
   */
  async removeWidget(owner: Agent, capabilityId: string, name: string): Promise<BuildView> {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    const w = widgetOf(this.activeManifest(capabilityId), name);
    if (!w) throw new PlatformError("not_found", `${capabilityId} has no widget ${name}`);
    const b = await this.manifestOnlyModify(owner, capabilityId, (m) => { const rest = (m.widgets ?? []).filter((x) => x.name !== name); if (rest.length) m.widgets = rest; else delete m.widgets; }, `delete the "${w.title}" widget`);
    const layout = this.registry.getKv<HomeEntry[]>(HOME_LAYOUT);
    if (layout) this.registry.setKv(HOME_LAYOUT, layout.filter((e) => !(e.type === "widget" && e.id === capabilityId && e.widget === name)));
    return b;
  }

  /** Run a placed widget (Home's refresh). Failures come back as values: Home keeps the last view. */
  async refreshHomeWidget(owner: Agent, key: string): Promise<{ view: unknown; at: string | null; error: string | null }> {
    const entry = this.homeLayout(owner).find((e) => e.type === "widget" && e.key === key) as Extract<HomeEntryView, { type: "widget" }> | undefined;
    if (!entry) throw new PlatformError("not_found", "no such widget on Home");
    try {
      const r = await this.widget(owner, entry.id, entry.widget, entry.input ?? {});
      return { view: r.view, at: r.at, error: null };
    } catch (e) {
      const c = this.registry.widgetCache(widgetKey(entry.id, entry.widget, entry.input ?? {}));
      return { view: c?.view ?? null, at: c?.at ?? null, error: (e as Error).message };
    }
  }

  /** Per-capability call log (user-facing). Records who/what/outcome, never inputs or outputs. */
  private capabilityLog(id: string, caller: string, req: InvokeRequest, started: number, outcome: string, lines: string[]) {
    try {
      const now = new Date();
      const op = req.operationVersion ? `${req.operation}@${req.operationVersion}` : req.operation;
      this.registry.addCapabilityLog(id, now.toISOString(), `${now.toISOString()} ${caller} ${op} ${outcome} ${now.getTime() - started}ms`, lines);
    } catch {
      // logging must never break a call
    }
  }

  /**
   * The tool's last failed calls (newest first, at most 10), for "Ask builder to fix this": what ran,
   * who started it, the error, the input and the last console lines. Owner only; never secrets (the
   * sign-in step isn't kept, and stored secrets are redacted as in the log).
   */
  private noteFailure(id: string, f: { caller: string; operation: string; error: string; input: string; logs: string[] }) {
    try {
      const key = `failures:${id}`;
      const entry = { at: new Date().toISOString(), caller: f.caller, operation: f.operation, error: f.error.slice(0, 1000), input: f.input.slice(0, 2000), logs: f.logs.slice(-10).map((l) => l.slice(0, 300)) };
      // Kept no longer than the call log (Settings › Data › Keep call logs; 0 = forever).
      const days = this.logRetentionDays();
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : "";
      this.registry.setKv(key, [entry, ...(this.registry.getKv<(typeof entry)[]>(key) ?? [])].filter((x) => x.at >= since).slice(0, 10));
    } catch {
      // never breaks a call
    }
  }

  recentFailures(owner: Agent, capabilityId: string) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    return this.registry.getKv<{ at: string; caller: string; operation: string; error: string; input: string; logs: string[] }[]>(`failures:${capabilityId}`) ?? [];
  }

  /** The last `n` lines of a capability's call log. */
  logLines(capabilityId: string, n: number): string[] {
    return this.registry.capabilityLogLines(capabilityId, n);
  }

  // ---------- housekeeping ----------

  /**
   * Remove what abandoned builds leave behind: workspaces of finished builds (after a day, so a
   * failure can still be looked at), transcripts (after 30 days), and capability ids that never got
   * a version (after 7 days with no build running). Also: capability call logs after the owner's
   * retention (14 days by default), and
   * confirmations after a day. Call at start and daily.
   */
  async cleanup(now = Date.now()): Promise<{ workspaces: number; transcripts: number; releasedIds: string[]; logs: number }> {
    const iso = (days: number) => new Date(now - days * 86400_000).toISOString();
    let workspaces = 0;
    let transcripts = 0;
    for (const b of this.registry.finishedBuildsBefore(iso(1))) {
      if (this.running.has(b.id)) continue;
      await this.workbench.remove(b.id).catch(() => {});
      workspaces++;
    }
    // Attachments of conversations that never led to a build.
    for (const ref of this.registry.staleAttachments(iso(1))) {
      await this.blobs.delete(`attachments/${ref}`);
      this.registry.deleteAttachment(ref);
    }
    for (const b of this.registry.finishedBuildsBefore(iso(30))) {
      // Kept with the build before the workbench's copy goes (builds from before 0.4.6 are kept now too).
      const key = `transcripts/${b.id}.log`;
      const left = await this.workbench.transcript(b.id).catch(() => undefined);
      if (left && !(await this.blobs.get(key))) await this.blobs.put(key, left);
      await this.workbench.removeTranscript(b.id).catch(() => {});
      transcripts++;
    }
    const releasedIds: string[] = [];
    const stale = iso(7);
    for (const id of this.registry.unpromotedCapabilities()) {
      const builds = this.registry.buildIdsFor(id).map((b) => this.registry.getBuild(b)!);
      if (builds.some((b) => this.running.has(b.id) || !["failed", "cancelled"].includes(b.status) || b.updatedAt >= stale)) continue;
      for (const b of builds) {
        await this.workbench.remove(b.id).catch(() => {});
        await this.workbench.removeTranscript(b.id).catch(() => {});
        await this.blobs.delete(`transcripts/${b.id}.log`);
      }
      this.registry.purgeCapability(id);
      releasedIds.push(id);
    }
    if (releasedIds.length) this.logger(`cleanup: released ids that never got a version: ${releasedIds.join(", ")}`);
    this.agentStore.cleanup();
    // Reservations a crash left open (an hour is far past any call's deadline).
    this.registry.settleStaleModelSpend(new Date(now - 3600_000).toISOString());
    // The model catalog: refreshed at start and daily; not awaited (a slow list never holds cleanup).
    const fetched = this.registry.getKv<{ fetchedAt: string }>("models.catalog")?.fetchedAt;
    if (this.modelFetch && (!fetched || now - Date.parse(fetched) > 20 * 3600_000)) void this.refreshModelCatalog();
    // And what the active provider's key can use (models come and go).
    const active = this.modelSettings_().provider;
    const listed = active ? this.providerList(active)?.checkedAt : undefined;
    if (this.modelFetch && active && (!listed || now - Date.parse(listed) > 20 * 3600_000)) void this.checkModelProvider(USER, active).catch(() => {});
    const keep = this.logRetentionDays();
    const logs = keep > 0 ? this.registry.pruneCapabilityLogs(iso(keep)) : 0;
    this.registry.expireConfirmations(iso(1));
    return { workspaces, transcripts, releasedIds, logs };
  }

  // ---------- schedules ----------

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
    const timezone = this.timezone();
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
    const timezone = this.timezone();
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
      const principal: Agent = { id: `schedule:${s.id}`, kind: "schedule", scopes: new Set(["invoke"]), capabilities: new Set([s.capabilityId]) };
      // Claim the slot first, so a slow run can't be started twice.
      this.schedules.update(s.id, { nextRunAt: nextRun(cron, s.timezone, Math.max(now, Date.now())) });
      let outcome = "ok";
      try {
        this.scheduledOperation(s.capabilityId, s.operation, s.operationVersion);
        await this.invoke(principal, { capabilityId: s.capabilityId, operation: s.operation, operationVersion: s.operationVersion, input: s.input });
      } catch (e) {
        const err = e as PlatformError;
        outcome = `${err.code ?? "error"}: ${err.message}`.slice(0, 300);
      }
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
    this.checkApprovedSchedules(agent, req.schedules);
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

  // ---------- Attachments: images and files the owner attaches in the intake's box ----------

  /**
   * Schedules the owner approved with a build (on the intake's card): the owner's own, so only the
   * owner may attach them; agents propose schedules instead. Checked now, created on promotion.
   */
  private checkApprovedSchedules(agent: Agent, schedules: unknown) {
    if (schedules === undefined) return;
    requireOwner(agent);
    if (!Array.isArray(schedules) || schedules.length > MAX_APPROVED_SCHEDULES) throw new PlatformError("invalid_request", `schedules: a list of at most ${MAX_APPROVED_SCHEDULES}`);
    for (const x of schedules) {
      if (!x || typeof x.operation !== "string" || !x.operation || typeof x.cadence !== "string") throw new PlatformError("invalid_request", "each schedule needs an operation and a cadence");
      checkCadence(x.cadence, this.timezone());
    }
  }

  /** After a promotion: set up the schedules the owner approved with the build. One that no longer fits is skipped, never failing the build. */
  private applyApprovedSchedules(build: BuildRow, step: (message: string) => void) {
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
    if (builder === "keep" || builder.startsWith("copy:")) return {};
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
    const builder = this.builderFor();
    if (agent.kind === "user" || !this.modelEfforts || !builder || typeof ask.effort !== "string" || !EFFORT.test(ask.effort)) return;
    const model = typeof ask.model === "string" ? ask.model : this.buildModelFor(builder).model ?? "default";
    const levels = await this.modelEfforts(builder, model).catch(() => undefined);
    if (levels?.length && !levels.includes(ask.effort)) throw new PlatformError("invalid_request", `${model} doesn't take effort '${ask.effort}'; it takes: ${levels.join(", ")}`);
  }

  /** Model names agents may pass for builds by `builder` (default: the current builder). Always includes "default". */
  agentModelChoices(builder = this.builderFor()): string[] {
    if (!builder) return ["default"];
    const allowed = this.agentBuildModels?.(builder) ?? [];
    return ["default", ...allowed.filter((m) => m !== "default")];
  }

  private requireBuilder(): string {
    const builder = this.builderFor();
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
  async install(owner: Agent, req: { name: string; purpose: string; builder: string; id?: string; seed?: Files; requirements?: string }): Promise<BuildView> {
    requireOwner(owner);
    const id = req.id ?? slugify(req.name);
    const existing = this.registry.getCapability(id);
    if (existing?.activeVersion || existing?.archivedAt) throw new PlatformError("conflict", `capability '${id}' already exists`);
    return this.openCreateBuild(owner, id, { name: req.name, purpose: req.purpose, requirements: req.requirements ?? `install (${req.builder})` }, !existing, req.builder, req.seed);
  }

  /** `after`: a build to wait for first (e.g. adding the operation this change needs to a connection). */
  async modify(agent: Agent, req: { capabilityId: string; request: string; after?: string; schedules?: ApprovedSchedule[]; conversation?: BuildTurn[] } & ModelAsk): Promise<BuildView> {
    requireScope(agent, "modify");
    await this.checkEffort(agent, req);
    this.checkApprovedSchedules(agent, req.schedules);
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

  // ---------- Instructions: the owner's standing rules for building, read by the intake and the builder ----------

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
      const r = await this.validateAndPromote(build, step, (passed, total) => this.setStep(build.id, build.capabilityId, "tests", { passed, total }));
      if ("review" in r) {
        step(`passed; waiting for the owner's review before it goes live (${reviewReason(r.review)})`);
        return { review: r.review, log };
      }
      const version = r.version;
      step(`promoted: implementation v${version} is now active`);
      this.applyApprovedSchedules(build, step);
      this.setStep(build.id, build.capabilityId, this.readiness(build.capabilityId).ready ? "done" : "auth", this.steps.get(build.id)?.tests);
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
    if (this.slots.busy < this.maxRunningBuilds) {
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
    const max = Math.max(1, this.maxBuildAttempts());
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
      }, this.heartbeatMs);
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
          await new Promise((ok) => setTimeout(ok, this.interruptWaitMs));
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

  private async validateAndPromote(build: BuildRow, step: (message: string) => void, onTests: (passed: number, total: number) => void = () => {}): Promise<{ version: number } | { review: BuildReview }> {
    const id = build.capabilityId;
    const fail = (msg: string, problems: string[] = []): never => {
      throw new Error(problems.length ? `${msg}:\n  - ${problems.join("\n  - ")}` : msg);
    };
    const workspace = await this.workbench.read(build.id);

    // 1. manifest
    if (!workspace["capability.json"]) fail("capability.json missing");
    let manifest: CapabilityManifest;
    try {
      manifest = JSON.parse(text(workspace["capability.json"]));
    } catch (e) {
      return fail(`capability.json is not valid JSON: ${(e as Error).message}`);
    }
    const manifestErrors = validateManifest(manifest, id);
    if (manifest?.ui?.available && !workspace["ui/index.html"]) manifestErrors.push("ui.available but ui/index.html is missing");
    if (manifestErrors.length) fail("manifest invalid", manifestErrors);
    step("manifest valid");

    // 2. bundle (src/index.ts + npm dependencies), then: it exports exactly what the manifest declares
    const files = versionFiles(workspace);
    let bundled: { js: string; log: string[] };
    try {
      bundled = await this.workbench.bundle(build.id);
    } catch (e) {
      return fail(`bundling failed: ${(e as Error).message}`);
    }
    for (const line of bundled.log) step(line);
    const code: CodeRef = { hash: contentHash(files, bundled.js), js: bundled.js };
    let exportedKeys: string[];
    try {
      exportedKeys = await this.runtime.describe(code);
    } catch (e) {
      return fail(`implementation failed to load: ${(e as Error).message}`);
    }
    const exported = new Set(exportedKeys);
    const missing = manifest.operations.map((o) => opKey(o.name, o.version)).filter((k) => !exported.has(k));
    if (missing.length) fail("implementation does not export declared operations", missing);
    step(`implementation exports ${[...exported].join(", ")}`);

    // 3. contract compatibility with the active version
    const base = build.baseVersion ? await this.loadVersion(id, build.baseVersion) : undefined;
    if (base) {
      const breaks = contractBreaks(base.row.manifest, manifest, (key) => this.d.grants.operationUsers(id, key));
      if (breaks.length) fail("breaking change to a published operation contract (add a new operation version instead)", breaks);
      const removed = base.row.manifest.operations.map((o) => opKey(o.name, o.version)).filter((k) => !manifest.operations.some((o) => opKey(o.name, o.version) === k));
      step(`operation contracts compatible with active version${removed.length ? ` (removed deprecated ${removed.join(", ")})` : ""}`);
    }
    // 3a. a widgets build changes widgets only: the capability's own contract, data and UI stay as they are
    if (build.kind === "widgets") {
      if (!base) fail("a widgets build needs an active version to add widgets to");
      const problems = widgetsBuildProblems({ manifest: base!.row.manifest, files: base!.files }, { manifest, files });
      if (problems.length) fail("a widgets build changed more than widgets", problems);
      step(`widgets only: ${manifest.widgets!.map((w) => w.name).join(", ")}`);
    }

    // 3b. declared callees exist and offer the pinned operation versions
    const deps = (manifest.requires?.capabilities ?? []).flatMap((d) => d.operations.map((op) => ({ id: d.id, op })));
    const badDeps = deps.filter((d) => d.id === id || !this.d.grants.offers(d.id, d.op)).map((d) => (d.id === id ? `${d.id}: a capability cannot call itself` : `${d.id}/${d.op} does not exist`));
    if (badDeps.length) fail("requires.capabilities references unavailable operations", badDeps);
    if (deps.length) step(`calls ${deps.map((d) => `${d.id}/${d.op}`).join(", ")}`);

    // 4. migrations are append-only and non-destructive
    const migrations = migrationsOf(files);
    const migrationErrors = migrationProblems(migrations, base ? migrationsOf(base.files) : []);
    if (migrationErrors.length) fail("migrations rejected", migrationErrors);

    // 5. candidate test cases against fresh state
    const testState: StateRef = { capabilityId: id, scratch: `test:${build.id}` };
    const visualState: StateRef = { capabilityId: id, scratch: `visual:${build.id}` };
    const dryRun: StateRef = { capabilityId: id, scratch: `dryrun:${build.id}` };
    // Each operation's first passing result in the tests: the widget sheet draws these, and a review shows them.
    const views = new Map<string, unknown>();
    try {
      await this.runtime.dropState(testState);
      await this.runtime.migrate(testState, migrations, code);
      const cases = readCases(workspace);
      if (!cases.length) fail("tests/cases.json must contain at least one case");
      const untested = (manifest.widgets ?? []).filter((w) => !cases.some((c) => !c.expectError && `${c.operation}@${c.version ?? manifest.operations.filter((o) => o.name === c.operation).reduce((n, o) => Math.max(n, o.version), 0)}` === w.operation));
      if (untested.length) fail("every widget needs a test case for its operation (the case's output must match a template)", untested.map((w) => `${w.name}: no case calls ${w.operation}`));
      // Run every case (not just up to the first failure) so the owner and the builder see the whole picture.
      const failed: string[] = [];
      onTests(0, cases.length);
      for (const [i, c] of cases.entries()) {
        try {
          const result = await this.runCase(manifest, { capabilityId: id, code, state: testState, secrets: c.secrets, config: c.config }, c);
          const op = manifest.operations.filter((o) => o.name === c.operation && (c.version === undefined || o.version === c.version)).sort((a, b) => b.version - a.version)[0];
          if (op && !c.expectError && !views.has(opKey(op.name, op.version))) views.set(opKey(op.name, op.version), result);
        } catch (e) {
          failed.push((e as Error).message);
        }
        onTests(i + 1 - failed.length, cases.length);
      }
      if (failed.length) fail(`${failed.length} of ${cases.length} test cases failed`, failed);
      step(`${cases.length} test cases passed`);

      // 5b. the UI renders without errors (on fresh, empty state), with a screenshot for the owner
      let shot = false;
      if (manifest.ui?.available && this.workbench.visualCheck && build.kind !== "widgets") {
        await this.runtime.dropState(visualState);
        await this.runtime.migrate(visualState, migrations, code);
        const secrets = cases.find((c) => c.secrets)?.secrets ?? Object.fromEntries((manifest.requires?.secrets ?? []).map((x) => [x.name, "visual-check"]));
        const config = cases.find((c) => c.config)?.config ?? Object.fromEntries((manifest.config ?? []).map((x) => [x.name, "visual-check"]));
        const v = await this.workbench.visualCheck(build.id, {
          manifest: { ...manifest, status: { ready: true, missingSecrets: [], missingConfig: [], pendingGrants: [], missingDependencies: [] } },
          invoke: async (body) => {
            const { result } = await this.execute(
              manifest,
              { capabilityId: id, code, state: visualState, secrets, config, caller: { kind: "test", id: "visual-check" } },
              { capabilityId: id, operation: body.operation, operationVersion: body.operationVersion, input: body.input },
              async (call) => {
                throw new PlatformError("operation_failed", `calls to ${call.capabilityId} aren't available in the visual check`);
              },
              manifest.requires?.model && abiAtLeast(manifest, "2.2")
                ? async () => {
                    throw new PlatformError("operation_failed", "model calls aren't available in the visual check");
                  }
                : undefined,
            );
            return { result };
          },
        });
        if (v.skipped) step(`visual check skipped: ${v.skipped}`);
        else {
          if (v.screenshot) await this.blobs.put(`screenshots/${build.id}.png`, v.screenshot);
          if (v.screenshotDark) await this.blobs.put(`screenshots/${build.id}-dark.png`, v.screenshotDark);
          if (v.errors.length) fail("UI didn't render cleanly", v.errors);
          step("UI renders without errors (screenshot attached)");
          shot = true;
        }
      }

      // 5c. changed widgets, drawn in every size they offer (the screenshot, unless the UI's was taken)
      const widgetsChanged = !!manifest.widgets?.length && (build.kind === "widgets" || JSON.stringify(manifest.widgets) !== JSON.stringify(base?.row.manifest.widgets));
      if (widgetsChanged && !shot && this.workbench.visualCheck && abiAtLeast(manifest, "2.3")) {
        const widgets = manifest.widgets!.map((w) => ({ name: w.name, title: w.title, sizes: w.sizes, view: views.get(w.operation) ?? null }));
        const v = await this.workbench.visualCheck(build.id, { manifest, widgets, invoke: async () => ({ result: null }) });
        if (v.skipped) step(`widget check skipped: ${v.skipped}`);
        else {
          if (v.screenshot) await this.blobs.put(`screenshots/${build.id}.png`, v.screenshot);
          if (v.screenshotDark) await this.blobs.put(`screenshots/${build.id}-dark.png`, v.screenshotDark);
          if (v.errors.length) fail("widgets didn't render cleanly", v.errors);
          step(`widgets render in every size (screenshot attached)`);
        }
      }

      // 6. dry-run migrations against a copy of real state
      if (await this.runtime.hasState({ capabilityId: id })) {
        await this.runtime.copyState({ capabilityId: id }, dryRun);
        const applied = await this.runtime.migrate(dryRun, migrations, code);
        step(`upgrade dry-run ok (${applied.length ? applied.join(", ") : "no new migrations"})`);
      }
    } finally {
      for (const s of [testState, visualState, dryRun]) await this.runtime.dropState(s).catch(() => {});
    }

    // 7. freeze; an agent's change that adds operations or changes a connection waits for the owner
    await this.blobs.put(`versions/${code.hash}.json`, encodeVersion(code.hash, files, code.js));
    this.loaded.set(code.hash, { files, bundle: code.js });
    // A follow-up chained to the creation of the same capability (create with widgets) is part of that creation.
    const dep = build.dependsOn ? this.registry.getBuild(build.dependsOn) : undefined;
    const partOfCreate = dep?.kind === "create" && dep.capabilityId === id;
    const review = partOfCreate || !base ? undefined : reviewFor(build, { manifest: base.row.manifest, files: base.files }, { manifest, files }, code.hash, views);
    if (review) {
      await this.workbench.remove(build.id);
      return { review };
    }
    return { version: await this.promoteVersion(build, manifest, files, code, step) };
  }

  /** 8. promote a frozen candidate: back up live state, migrate it, make the version active. */
  private async promoteVersion(build: BuildRow, manifest: CapabilityManifest, files: Files, code: CodeRef, step: (message: string) => void): Promise<number> {
    const id = build.capabilityId;
    const migrations = migrationsOf(files);
    const next = this.registry.latestVersionNumber(id) + 1;
    const live: StateRef = { capabilityId: id };
    if (await this.runtime.hasState(live)) {
      await this.runtime.copyState(live, { capabilityId: id, scratch: `backup:before-v${next}-${Date.now()}` });
      // Per-promotion backups are a safety net for this step; nightly backups are the archive. Keep 3.
      const backups = (await this.runtime.listStates(id, "backup:before-v")).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
      for (const old of backups.slice(3)) await this.runtime.dropState({ capabilityId: id, scratch: old });
      step(`state backed up`);
    }
    const applied = await this.runtime.migrate(live, migrations, code);
    if (applied.length) step(`migrations applied: ${applied.join(", ")}`);

    this.registry.transaction(() => {
      this.registry.insertVersion({ capabilityId: id, version: next, manifest, contentHash: code.hash, buildId: build.id });
      this.registry.promote({ id, name: manifest.name, purpose: manifest.purpose, version: next });
    });
    // Grants this version no longer asks for go: asking again later means asking the owner again.
    const wanted = new Set(wantedGrants(manifest));
    for (const g of this.registry.grants(id)) {
      if (wanted.has(g)) continue;
      const [kind, ...rest] = g.split(":");
      this.registry.revokeGrant(id, kind as GrantKind, rest.join(":"));
      this.registry.addGrantEvent(id, "revoke", g, "platform");
      step(`grant ${g} dropped: v${next} doesn't ask for it`);
    }
    await this.workbench.remove(build.id).catch(() => {});
    return next;
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
      const version = await this.promoteVersion(build, manifest, v.files, { hash: build.review.contentHash, js: v.bundle }, step);
      step(`promoted: implementation v${version} is now active`);
      this.applyApprovedSchedules(build, step);
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

  private async runCase(manifest: CapabilityManifest, target: ExecutionTarget, c: TestCase) {
    const label = `test '${c.name}'`;
    try {
      const declared = manifest.requires?.capabilities ?? [];
      // A widget's operation is tested as it runs: read-only, read calls only, no model, and its output drawable.
      const op = manifest.operations.find((o) => o.name === c.operation && (c.version === undefined || o.version === c.version));
      const widget = op && abiAtLeast(manifest, "2.3") ? (manifest.widgets ?? []).find((w) => w.operation === opKey(op.name, op.version)) : undefined;
      const mock: CallHandler = async (call) => {
        const key = `${call.capabilityId}/${call.operation}`;
        if (!declared.some((d) => d.id === call.capabilityId && d.operations.includes(call.operation))) {
          throw new PlatformError("forbidden", `${manifest.id} did not declare ${key} in requires.capabilities`);
        }
        if (widget && this.registry.getCapability(call.capabilityId)?.activeVersion) {
          const [name, v] = call.operation.split("@");
          const callee = this.activeManifest(call.capabilityId).operations.find((o) => o.name === name && o.version === Number(v));
          if (callee && callee.sideEffect !== "read") throw new PlatformError("forbidden", `widgets are read-only: ${key} is a ${callee.sideEffect} operation`);
        }
        if (!c.calls || !(key in c.calls)) throw new PlatformError("operation_failed", `no mock for ${key} in test case '${c.name}' ("calls")`);
        return c.calls[key];
      };
      const replies = [...(c.model ?? [])];
      const requirement = manifest.requires?.model;
      const fakeModel: ModelHandler | undefined =
        requirement && abiAtLeast(manifest, "2.2") && !widget
          ? async (raw) => {
              const r = inspectRequest(raw, requirement.input?.includes("image") ?? false);
              const next = replies.shift();
              if (!next) throw new PlatformError("operation_failed", `no model reply left in test case '${c.name}' ("model": a list of { "text" } or { "json" } replies)`);
              if ("error" in next) throw new PlatformError("operation_failed", next.error);
              const text = next.text ?? JSON.stringify(next.json ?? null);
              const json = r.schema ? structured(text, r.schema) : next.json;
              return { text, ...(json !== undefined ? { json } : {}), usage: { inputTokens: 0, outputTokens: 0 }, cost: 0, model: "test/fake" };
            }
          : undefined;
      const { result } = await this.execute(
        manifest,
        { ...target, caller: { kind: "test", id: "validation" }, ...(widget ? { readOnly: true } : {}) },
        { capabilityId: manifest.id, operation: c.operation, operationVersion: c.version, input: c.input },
        mock,
        fakeModel,
      );
      if (c.expectError) throw new Error(`${label}: expected an error, got ${JSON.stringify(result)}`);
      const problems = widget ? viewErrors(result) : [];
      if (problems.length) throw new Error(`${label}: widget ${widget!.name} returned something no template can draw: ${problems.join("; ")}`);
      if (c.expect !== undefined && !matches(c.expect, result)) {
        throw new Error(`${label}: expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(result)}`);
      }
      return result;
    } catch (e) {
      if (e instanceof PlatformError && c.expectError) return undefined;
      if (e instanceof PlatformError) {
        throw new Error(`${label}: ${e.code}: ${e.message}${e.details ? " " + JSON.stringify(e.details) : ""}`);
      }
      throw e;
    }
  }

  // ---------- helpers ----------

  private visibleActive(agent: Agent, capabilityId: string) {
    const cap = this.registry.getCapability(capabilityId);
    if (!cap || cap.activeVersion === null || cap.archivedAt || !canSee(agent, cap.id)) {
      throw new PlatformError("not_found", `no capability '${capabilityId}'`);
    }
    return cap;
  }

  private mustBuild(buildId: string): BuildRow {
    const build = this.registry.getBuild(buildId);
    if (!build) throw new PlatformError("not_found", `no build '${buildId}'`);
    return build;
  }

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

function resolveOperation(m: CapabilityManifest, name: string, version?: number): OperationManifest {
  const candidates = m.operations.filter((o) => o.name === name);
  const op = version === undefined ? candidates.sort((a, b) => b.version - a.version)[0] : candidates.find((o) => o.version === version);
  if (!op) {
    throw new PlatformError("not_found", `${m.id} has no operation ${version ? opKey(name, version) : name}`, {
      available: m.operations.map((o) => opKey(o.name, o.version)),
    });
  }
  return op;
}

function readCases(files: Files): TestCase[] {
  const raw = files["tests/cases.json"];
  if (!raw) return [];
  const cases = JSON.parse(text(raw));
  if (!Array.isArray(cases)) throw new Error("tests/cases.json must be an array");
  return cases;
}

/** Subset match: every key in `expected` must match in `actual`; "$any" matches any present value. */
export function matches(expected: unknown, actual: unknown): boolean {
  if (expected === "$any") return actual !== undefined;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(e, actual[i]));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches(v, (actual as Record<string, unknown>)[k]));
  }
  return expected === actual;
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** A schedule the owner approved together with a build: an operation (name) and a cadence. */
export interface ApprovedSchedule {
  operation: string;
  cadence: string;
}
const MAX_APPROVED_SCHEDULES = 5;

const newBuildId = () => `b-${crypto.randomUUID().slice(0, 8)}`;

const fmtDuration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);

/** Ids that would collide with platform origins (e.g. http://hewn.localhost). */
export const RESERVED_IDS = new Set(["hewn", "www", "api", "platform"]);

/** How long a whole call chain may take (an agent's call and every capability call it causes). */
export const CALL_DEADLINE_MS = 30_000;

/** Invalid operation input, naming missing required fields in the message (details keep every schema error). */
function inputMismatch(key: string, errors: string[]): PlatformError {
  const missing = errors.map((e) => /^\$ Instance does not have required property "(.+)"/.exec(e)?.[1]).filter(Boolean);
  return new PlatformError("invalid_input", `input does not match ${key} inputSchema${missing.length ? ` (missing ${missing.join(", ")})` : ""}`, errors);
}

/** Maximum capability → capability nesting (origin caller excluded). */
export const MAX_CALL_DEPTH = 3;

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

/** How long a widget's operation may take (Home draws the cached view meanwhile). */
export const WIDGET_DEADLINE_MS = 15_000;

/** Home's stored layout (platform_kv). */
const HOME_LAYOUT = "home:layout";

export type HomeEntry = { type: "icon"; id: string; hidden?: true } | { type: "widget"; key: string; id: string; widget: string; size: WidgetSize; input?: Record<string, unknown> };
/** A layout entry as Home draws it: placed widgets carry their title, sizes and last view. */
export type HomeEntryView =
  | { type: "icon"; id: string; hidden?: true }
  | (Extract<HomeEntry, { type: "widget" }> & { title?: string; sizes?: WidgetSize[]; refreshMs?: number; open?: string; missing?: true; view: unknown; at: string | null; error: string | null });

export interface WidgetResult {
  capabilityId: string;
  widget: string;
  title: string;
  view: WidgetOutput;
  at: string;
}

const widgetKey = (capabilityId: string, name: string, input: Record<string, unknown>) => `${capabilityId}/${name}/${sha256(JSON.stringify(input)).slice(0, 16)}`;

/** Separates an owner's request from the failure context "Ask builder to fix" appends. */
const FIX_MARK = "--- Fix request ---";

/**
 * What of a stored secret must never leave a capability: the value itself, or for a JSON object (a
 * token set) each long string in it, except email addresses (who is signed in isn't secret).
 * Short values would match by accident; real credentials aren't short.
 */
function secretNeedles(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // not JSON
  }
  if (!parsed || typeof parsed !== "object") return value.length >= 8 ? [value] : [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.length >= 16 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) out.push(v);
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(parsed);
  return out;
}

/**
 * Whether a candidate waits for the owner: an agent's change (not the owner's, and not a new
 * capability, which has no data yet) to a connection, or one that adds operations. An agent with
 * `modify` otherwise decides what the code does with the capability's data and credentials.
 */
function reviewFor(build: BuildRow, base: { manifest: CapabilityManifest; files: Files }, candidate: { manifest: CapabilityManifest; files: Files }, contentHash: string, views: Map<string, unknown>): BuildReview | undefined {
  if (build.requestedBy === USER.id || build.requestedBy === WEB_USER.id) return undefined;
  const key = (o: OperationManifest) => opKey(o.name, o.version);
  const had = new Map(base.manifest.operations.map((o) => [key(o), o]));
  const newOperations = candidate.manifest.operations
    .filter((o) => !had.has(key(o)))
    .map((o) => ({ key: key(o), description: o.description, sideEffect: o.sideEffect, inputs: Object.keys((o.inputSchema as { properties?: object }).properties ?? {}), ...(views.has(key(o)) ? { example: shortJson(views.get(key(o))) } : {}) }));
  const connection = isConnection(candidate.manifest);
  if (!connection && !newOperations.length) return undefined;
  const ui = (f: Files) => Object.keys(f).filter((p) => p.startsWith("ui/")).sort();
  const sameBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  const uiChanged = JSON.stringify(ui(base.files)) !== JSON.stringify(ui(candidate.files)) || ui(candidate.files).some((p) => !sameBytes(base.files[p], candidate.files[p]));
  const oldMigrations = new Set(migrationsOf(base.files).map((m) => m.name));
  const oldGrants = new Set(wantedGrants(base.manifest));
  const strip = (o: OperationManifest) => JSON.stringify({ description: o.description, inputSchema: o.inputSchema, outputSchema: o.outputSchema });
  const now = new Set(candidate.manifest.operations.map(key));
  return {
    contentHash,
    connection,
    newOperations,
    changes: {
      ui: uiChanged,
      migrations: migrationsOf(candidate.files).map((m) => m.name).filter((n) => !oldMigrations.has(n)),
      newGrants: wantedGrants(candidate.manifest).filter((g) => !oldGrants.has(g)),
      changedOperations: candidate.manifest.operations.filter((o) => had.has(key(o)) && strip(had.get(key(o))!) !== strip(o)).map(key),
      removedOperations: [...had.keys()].filter((k) => !now.has(k)),
    },
  };
}

/** A value as indented JSON, cut to a readable size (long arrays to their first items). */
function shortJson(v: unknown, max = 1200): string {
  const trim = (x: unknown, depth: number): unknown => {
    if (Array.isArray(x)) return [...x.slice(0, 3).map((y) => trim(y, depth + 1)), ...(x.length > 3 ? [`… ${x.length - 3} more`] : [])];
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, depth > 3 ? "…" : trim(y, depth + 1)]));
    return typeof x === "string" && x.length > 120 ? `${x.slice(0, 120)}…` : x;
  };
  const out = JSON.stringify(trim(v, 0), null, 2) ?? "null";
  return out.length > max ? `${out.slice(0, max)}\n…` : out;
}

const reviewReason = (r: BuildReview) =>
  [r.connection && "it changes a connection", r.newOperations.length && `it adds ${r.newOperations.map((o) => `${o.key} (${o.sideEffect})`).join(", ")}`].filter(Boolean).join("; ");
