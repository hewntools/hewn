// SPDX-License-Identifier: AGPL-3.0-or-later
// Platform: the one object every surface calls. A facade: each method hands its call to one of the
// domains in ./platform/ (builds, models, grants …; context.ts says what they share).
import { AgentStore, type AgentDetails, type PendingRequest } from "./agents.ts";
import type { Agent, Scope } from "./auth.ts";
import type { Cells } from "./glyph.ts";
import type { Deadline } from "./deadline.ts";
import type { CapabilityManifest, ModelRequirement, WidgetManifest } from "./manifest.ts";
import type { HostModels, ModelSettings } from "./models.ts";
import type { Blobs, CapabilityRuntime, Files, SecretStore, Sql, Workbench } from "./ports.ts";
import { type AttachmentRef, type BuildContext, type BuildFeedback, type BuildKind, type BuildTurn, type Confirmation, Registry } from "./registry.ts";
import type { AssertionResponse, RegistrationResponse } from "./webauthn.ts";
import { type Schedule, ScheduleStore } from "./schedules.ts";
import { Discovery, type CapabilitySummary } from "./platform/discovery.ts";
import { Presentation } from "./platform/presentation.ts";
import { Data } from "./platform/data.ts";
import { Sessions } from "./platform/sessions.ts";
import { Attachments, type AttachmentWithData } from "./platform/attachments.ts";
import { Instructions, type Instruction } from "./platform/instructions.ts";
import { Grants, type Readiness } from "./platform/grants.ts";
import { Connections, type ConnectionHealth } from "./platform/connections.ts";
import { Models } from "./platform/models.ts";
import { Invocation, type InvokeRequest } from "./platform/invocation.ts";
import { Schedules, type ApprovedSchedule } from "./platform/schedules.ts";
import { Builds, type BuildView, type BuildStepState, MAX_RUNNING_BUILDS, type ModelAsk, type BuildReport } from "./platform/builds.ts";
import { Validation } from "./platform/validation.ts";
import { Widgets, type HomeEntryView, type WidgetResult } from "./platform/widgets.ts";
import { Housekeeping, LOG_RETENTION_DAYS } from "./platform/housekeeping.ts";
import { Events, type Shared, type Domains, type LoadedVersion } from "./platform/context.ts";

// What the domains define, importable from here as before.
export { type CapabilitySummary } from "./platform/discovery.ts";
export { MAX_SATURATION } from "./platform/presentation.ts";
export { type Readiness, hostOf, resolveHosts } from "./platform/grants.ts";
export { WEB_SESSION_MS, normalizePublicUrl } from "./platform/sessions.ts";
export { MODEL_KEYS } from "./platform/models.ts";
export { type ConnectionHealth, HEALTH_DEADLINE_MS, HEALTH_CACHE_MS } from "./platform/connections.ts";
export { type InvokeRequest, maskInput, CALL_DEADLINE_MS, MAX_CALL_DEPTH } from "./platform/invocation.ts";
export { WIDGET_DEADLINE_MS, type HomeEntry, type HomeEntryView, type WidgetResult } from "./platform/widgets.ts";
export { LOG_RETENTION_DAYS } from "./platform/housekeeping.ts";
export { type ApprovedSchedule } from "./platform/schedules.ts";
export { type BuildView, type BuildProgress, type BuildStep, type BuildStepState, MAX_RUNNING_BUILDS, type ModelAsk, type BuildReportRow, type BuildReport, slugify, RESERVED_IDS } from "./platform/builds.ts";
export { matches } from "./platform/validation.ts";
export { ATTACHMENT_LIMITS, type AttachmentWithData, attachmentRefs } from "./platform/attachments.ts";
export { type InstructionScope, type Instruction } from "./platform/instructions.ts";

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

export class Platform {
  registry: Registry;
  blobs: Blobs;
  runtime: CapabilityRuntime;
  workbench: Workbench;
  agentStore: AgentStore;
  logger: (message: string) => void;
  builderFor: () => string | undefined;
  /** Builds that may run at once; the rest wait their turn. */
  maxRunningBuilds: number;
  maxBuildAttempts: () => number;
  secrets: SecretStore;
  schedules: ScheduleStore;
  timezone: () => string;
  confirmWaitMs: number;
  logRetentionDays: () => number;
  modelFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Hosted: the host runs tools' model calls (PlatformOptions.hostModels). */
  hostModels?: HostModels;
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
    // Everything worth a log line may change what agents see (catalog, readiness): open MCP
    // sessions re-check their tool lists (debounced, and only notified when it differs).
    const log = opts.logger ?? (() => {});
    this.logger = (m) => (log(m), this.events.emit("changed"));
    this.builderFor = opts.builder ?? (() => undefined);
    this.maxRunningBuilds = opts.maxRunningBuilds ?? MAX_RUNNING_BUILDS;
    this.maxBuildAttempts = opts.maxBuildAttempts ?? (() => 3);
    this.secrets = opts.secrets ?? new MemorySecretStore();
    this.schedules = new ScheduleStore(opts.sql);
    this.timezone = opts.timezone ?? (() => "UTC");
    this.confirmWaitMs = opts.confirmWaitMs ?? 60_000;
    this.logRetentionDays = opts.logRetentionDays ?? (() => LOG_RETENTION_DAYS);
    this.modelFetch = opts.modelFetch;
    this.hostModels = opts.hostModels;
    // The domains share the facade, the ports and the event bus, and reach each other through `d`.
    const d = (this.d = {} as Domains);
    const s: Shared = { platform: this, events: this.events, loaded: new Map(), d };
    d.attachments = new Attachments(s);
    d.builds = new Builds(s, opts);
    d.connections = new Connections(s);
    d.data = new Data(s);
    d.discovery = new Discovery(s);
    d.grants = new Grants(s);
    d.housekeeping = new Housekeeping(s);
    d.instructions = new Instructions(s);
    d.invocation = new Invocation(s);
    d.models = new Models(s);
    d.presentation = new Presentation(s);
    d.schedules = new Schedules(s, opts);
    d.sessions = new Sessions(s);
    d.validation = new Validation(s);
    d.widgets = new Widgets(s);
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

  // ---------- models: providers, tiers, budget, the model port (platform/models.ts) ----------

  modelSettings_(): ModelSettings { return this.d.models.modelSettings_(); }
  modelProblem(r: ModelRequirement): string | undefined { return this.d.models.modelProblem(r); }
  models(owner: Agent) { return this.d.models.models(owner); }
  setModelSettings(owner: Agent, change: { provider?: string; tiers?: Record<string, Record<string, string | null>>; monthlyCapUsd?: unknown; capabilityCapsUsd?: Record<string, unknown>; capabilityCapsHost?: Record<string, unknown>; prices?: Record<string, unknown> }) { return this.d.models.setModelSettings(owner, change); }
  setModelKey(owner: Agent, provider: string, key: string | null) { return this.d.models.setModelKey(owner, provider, key); }
  retiredModel(model: string): { successor?: string } | undefined { return this.d.models.retiredModel(model); }
  setCapabilityModel(owner: Agent, capabilityId: string, to: { tier?: string; model?: string }): Promise<BuildView> { return this.d.models.setCapabilityModel(owner, capabilityId, to); }
  replacePinnedModel(owner: Agent, capabilityId: string, model: string): Promise<BuildView> { return this.d.models.replacePinnedModel(owner, capabilityId, model); }
  checkModelProvider(owner: Agent, provider: string) { return this.d.models.checkModelProvider(owner, provider); }
  refreshModelCatalog(): Promise<{ models: number } | { error: string }> { return this.d.models.refreshModelCatalog(); }
  hostCharges(owner: Agent, month?: string) { return this.d.models.hostCharges(owner, month); }
  hostCapUse(capabilityId: string, month?: string): { spent: number; unit: string } { return this.d.models.hostCapUse(capabilityId, month); }
  recordHostCharge(owner: Agent, kind: "intake", c: unknown) { return this.d.models.recordHostCharge(owner, kind, c); }
  modelSpend(owner: Agent, month?: string) { return this.d.models.modelSpend(owner, month); }

  // ---------- Accounts: connections and their health (platform/connections.ts) ----------

  connect(owner: Agent, capabilityId: string, input: Record<string, unknown>) { return this.d.connections.connect(owner, capabilityId, input); }
  connectionHealth(owner: Agent, capabilityId: string, o?: { cached?: boolean }): Promise<ConnectionHealth> { return this.d.connections.connectionHealth(owner, capabilityId, o); }
  accounts(owner: Agent) { return this.d.connections.accounts(owner); }

  // ---------- invocation (platform/invocation.ts) ----------

  invoke(agent: Agent, req: InvokeRequest, trace?: string[], within?: Deadline | number, opts?: { record?: boolean; readOnly?: boolean; readChain?: boolean; origin?: Agent }) { return this.d.invocation.invoke(agent, req, trace, within, opts); }
  recentFailures(owner: Agent, capabilityId: string) { return this.d.invocation.recentFailures(owner, capabilityId); }
  logLines(capabilityId: string, n: number): string[] { return this.d.invocation.logLines(capabilityId, n); }

  // ---------- widgets and Home (platform/widgets.ts) ----------

  widget(agent: Agent, capabilityId: string, name: string, input?: Record<string, unknown>): Promise<WidgetResult> { return this.d.widgets.widget(agent, capabilityId, name, input); }
  cachedWidget(owner: Agent, capabilityId: string, name: string, input?: Record<string, unknown>) { return this.d.widgets.cachedWidget(owner, capabilityId, name, input); }
  widgetGallery(agent: Agent): { capabilityId: string; name: string; widgets: (WidgetManifest & { inputSchema: Record<string, unknown> })[] }[] { return this.d.widgets.widgetGallery(agent); }
  homeLayout(owner: Agent): HomeEntryView[] { return this.d.widgets.homeLayout(owner); }
  setHomeLayout(owner: Agent, entries: unknown): HomeEntryView[] { return this.d.widgets.setHomeLayout(owner, entries); }
  placeWidget(owner: Agent, entry: { id: string; widget: string; size: string; input?: Record<string, unknown> }): HomeEntryView[] { return this.d.widgets.placeWidget(owner, entry); }
  removeWidget(owner: Agent, capabilityId: string, name: string): Promise<BuildView> { return this.d.widgets.removeWidget(owner, capabilityId, name); }
  refreshHomeWidget(owner: Agent, key: string): Promise<{ view: unknown; at: string | null; error: string | null }> { return this.d.widgets.refreshHomeWidget(owner, key); }

  // ---------- housekeeping (platform/housekeeping.ts) ----------

  metrics(owner: Agent) { return this.d.housekeeping.metrics(owner); }
  cleanup(now?: number): Promise<{ workspaces: number; transcripts: number; releasedIds: string[]; logs: number }> { return this.d.housekeeping.cleanup(now); }

  // ---------- schedules (platform/schedules.ts) ----------

  listSchedules(agent: Agent, capabilityId?: string): Schedule[] { return this.d.schedules.listSchedules(agent, capabilityId); }
  createSchedule(owner: Agent, req: { capabilityId: string; operation: string; operationVersion?: number; input?: unknown; cadence: string }): Schedule { return this.d.schedules.createSchedule(owner, req); }
  proposeSchedule(agent: Agent, req: { capabilityId: string; operation: string; operationVersion?: number; input?: unknown; cadence: string; note?: string }): Schedule { return this.d.schedules.proposeSchedule(agent, req); }
  updateSchedule(owner: Agent, id: string, change: { status?: "active" | "paused"; cadence?: string; input?: unknown }): Schedule { return this.d.schedules.updateSchedule(owner, id, change); }
  deleteSchedule(owner: Agent, id: string) { return this.d.schedules.deleteSchedule(owner, id); }
  nextScheduleAt(): number | null { return this.d.schedules.nextScheduleAt(); }
  runDueSchedules(now?: number): Promise<{ id: string; ok: boolean }[]> { return this.d.schedules.runDueSchedules(now); }

  // ---------- builds (platform/builds.ts) ----------

  recoverInterruptedBuilds(): Promise<string[]> { return this.d.builds.recoverInterruptedBuilds(); }
  waitForBuild(agent: Agent, buildId: string, opts: { timeoutMs: number; onEvent?: (line: string) => void; onStep?: (step: BuildStepState) => void; signal?: AbortSignal }): Promise<BuildView & { waitTimedOut?: boolean }> { return this.d.builds.waitForBuild(agent, buildId, opts); }
  drain(): Promise<void> { return this.d.builds.drain(); }
  settle(buildId: string): Promise<BuildView> { return this.d.builds.settle(buildId); }
  isRunning(buildId: string): boolean { return this.d.builds.isRunning(buildId); }
  stepState(buildId: string): BuildStepState | undefined { return this.d.builds.stepState(buildId); }
  buildGlyph(buildId: string): Promise<{ svg: string; hue: number | null; saturation: number | null } | undefined> { return this.d.builds.buildGlyph(buildId); }
  activeBuilds(): { buildId: string; capabilityId: string; kind: BuildKind; name: string; purpose: string; connection: boolean; state: BuildStepState }[] { return this.d.builds.activeBuilds(); }
  create(agent: Agent, req: { name: string; purpose: string; requirements: string; kind?: "capability" | "connection"; after?: string; widgets?: boolean; schedules?: ApprovedSchedule[]; conversation?: BuildTurn[] } & ModelAsk): Promise<BuildView & { widgetsBuildId?: string }> { return this.d.builds.create(agent, req); }
  agentModelChoices(builder?: string): string[] { return this.d.builds.agentModelChoices(builder); }
  install(owner: Agent, req: { name: string; purpose: string; builder: string; id?: string; seed?: Files; requirements?: string }): Promise<BuildView> { return this.d.builds.install(owner, req); }
  modify(agent: Agent, req: { capabilityId: string; request: string; after?: string; schedules?: ApprovedSchedule[]; conversation?: BuildTurn[] } & ModelAsk): Promise<BuildView> { return this.d.builds.modify(agent, req); }
  addWidgets(agent: Agent, req: { capabilityId: string; request?: string; after?: string; conversation?: BuildTurn[] } & ModelAsk): Promise<BuildView> { return this.d.builds.addWidgets(agent, req); }
  retryBuild(agent: Agent, buildId: string, opts?: { fix?: boolean; auto?: boolean }): Promise<BuildView> { return this.d.builds.retryBuild(agent, buildId, opts); }
  cancelBuild(agent: Agent, buildId: string): BuildView { return this.d.builds.cancelBuild(agent, buildId); }
  getBuild(agent: Agent, buildId: string): BuildView { return this.d.builds.getBuild(agent, buildId); }
  buildContext(owner: Agent, buildId: string): BuildContext & { feedback?: BuildFeedback } { return this.d.builds.buildContext(owner, buildId); }
  setBuildFeedback(owner: Agent, buildId: string, f: { score?: unknown; note?: unknown }): BuildFeedback { return this.d.builds.setBuildFeedback(owner, buildId, f); }
  buildReport(owner: Agent, opts?: { days?: number }): BuildReport { return this.d.builds.buildReport(owner, opts); }
  buildTranscript(owner: Agent, buildId: string): Promise<string | undefined> { return this.d.builds.buildTranscript(owner, buildId); }
  buildsInReview(owner: Agent): BuildView[] { return this.d.builds.buildsInReview(owner); }
  approveBuild(owner: Agent, buildId: string): Promise<BuildView> { return this.d.builds.approveBuild(owner, buildId); }
  rejectBuild(owner: Agent, buildId: string): Promise<BuildView> { return this.d.builds.rejectBuild(owner, buildId); }

  // ---------- attachments (platform/attachments.ts) ----------

  addAttachment(owner: Agent, a: { session?: unknown; kind?: unknown; name?: unknown; mediaType?: unknown; data?: unknown }): Promise<AttachmentRef> { return this.d.attachments.addAttachment(owner, a); }
  attachmentBytes(owner: Agent, ref: string): Promise<{ meta: AttachmentRef; bytes: Uint8Array }> { return this.d.attachments.attachmentBytes(owner, ref); }
  attachmentsWithData(owner: Agent, refs: unknown): Promise<AttachmentWithData[]> { return this.d.attachments.attachmentsWithData(owner, refs); }

  // ---------- instructions (platform/instructions.ts) ----------

  instructions(owner: Agent, capabilityId?: string): string[] { return this.d.instructions.instructions(owner, capabilityId); }
  setInstructions(owner: Agent, capabilityId: string | undefined, lines: unknown): string[] { return this.d.instructions.setInstructions(owner, capabilityId, lines); }
  applyIntakeMemory(owner: Agent, capabilityId: string | undefined, remember: unknown, forget: unknown): { remember: Instruction[]; forget: Instruction[] } { return this.d.instructions.applyIntakeMemory(owner, capabilityId, remember, forget); }
}
