// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CapabilityManifest } from "./manifest.ts";
import type { Sql } from "./ports.ts";

export interface CapabilityRow {
  id: string;
  name: string;
  purpose: string;
  activeVersion: number | null;
  /** Owner overrides: presentation only, never identity. */
  displayName: string | null;
  /** "glyph" = an owner-set 5×5 glyph; otherwise an uploaded image's MIME type. */
  iconType: string | null;
  /** Owner's tile hue (overrides the manifest's). */
  hue: number | null;
  /** Owner's position on Home (null: after the ordered ones, by name). */
  homeOrder: number | null;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface VersionRow {
  capabilityId: string;
  version: number;
  manifest: CapabilityManifest;
  contentHash: string;
  buildId: string;
  createdAt: string;
}

/** "widgets": a follow-up build that adds or changes widgets only (the core stays as it is). */
export type BuildKind = "create" | "modify" | "widgets";
export type GrantKind = "secret" | "host" | "capability" | "model";
/** "waiting": a dependent build that starts once the build it depends on promotes. */
export type BuildStatus = "waiting" | "open" | "building" | "validating" | "review" | "failed" | "promoted" | "cancelled";

/**
 * An agent's change that passed validation and waits for the owner before it goes live: what it
 * would add, and the candidate (stored by content hash) that approving promotes.
 */
export interface BuildReview {
  contentHash: string;
  /** The capability is a connection (it holds the owner's credentials). */
  connection: boolean;
  /** Operations (or operation versions) the active version doesn't have. */
  newOperations: {
    key: string;
    description: string;
    sideEffect: string;
    /** Its input fields (none: it takes no input). */
    inputs?: string[];
    /** What it returned in its first passing test case, as JSON (shortened). */
    example?: string;
  }[];
  /** Everything else that differs from the active version (absent on reviews from before 2026-10-17). */
  changes?: {
    /** Files under ui/ differ. */
    ui: boolean;
    /** New migrations (the data's shape changes). */
    migrations: string[];
    /** Authority it asks for that the active version doesn't. */
    newGrants: string[];
    /** Existing operations whose contract (description, input or output) differs, compatibly. */
    changedOperations: string[];
    /** Operations it no longer has (deprecated ones nothing uses). */
    removedOperations: string[];
  };
}

/** What a build ran on (Settings › AI, or what was asked for), for the build page and Activity. */
export interface BuildModel {
  /** As asked or set: an alias ("fable"), a full name, or unset for the builder's default. */
  model?: string;
  effort?: string;
  /** What the builder reported running on (a full name). */
  ran?: string;
  /** `fallback`: the model wasn't available, so it ran on the builder's default. */
  note?: { kind: "fallback"; model: string; text: string };
}

export interface BuildRow {
  id: string;
  capabilityId: string;
  kind: BuildKind;
  request: Record<string, unknown>;
  requestedBy: string;
  /** The platform builder that runs it (null only on builds recorded before every build had one). */
  builder: string | null;
  status: BuildStatus;
  baseVersion: number | null;
  resultVersion: number | null;
  /** The build this one waits for (e.g. the connection it calls). */
  dependsOn: string | null;
  /** Set while the build waits for the owner's review (status "review"). */
  review: BuildReview | null;
  log: string[];
  createdAt: string;
  updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capabilities (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  active_version INTEGER,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  display_name   TEXT,
  icon_type      TEXT,
  archived_at    TEXT,
  hue            TEXT,
  home_order     TEXT,
  ui_key         TEXT
);
CREATE TABLE IF NOT EXISTS capability_versions (
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  version       INTEGER NOT NULL,
  manifest      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  build_id      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (capability_id, version)
);
CREATE TABLE IF NOT EXISTS grants (
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  approved_by   TEXT NOT NULL,
  approved_at   TEXT NOT NULL,
  PRIMARY KEY (capability_id, kind, name)
);
CREATE TABLE IF NOT EXISTS config_values (
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  set_by        TEXT NOT NULL,
  set_at        TEXT NOT NULL,
  PRIMARY KEY (capability_id, name)
);
CREATE TABLE IF NOT EXISTS ui_sessions (
  token_hash    TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  kind          TEXT NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   TEXT,
  last_seen_at TEXT,
  user_agent   TEXT
);
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  rp_id         TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  sign_count    INTEGER NOT NULL,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE TABLE IF NOT EXISTS access_requests (
  capability_id TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  note          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grant_events (
  capability_id TEXT NOT NULL,
  action        TEXT NOT NULL,
  grant_ref     TEXT NOT NULL,
  actor         TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lifecycle_events (
  capability_id TEXT NOT NULL,
  action        TEXT NOT NULL,
  detail        TEXT NOT NULL,
  actor         TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS authority_events (
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  capability_id TEXT,
  detail        TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS confirmations (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  operation     TEXT NOT NULL,
  input_hash    TEXT NOT NULL,
  input         TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE TABLE IF NOT EXISTS capability_logs (
  capability_id TEXT NOT NULL,
  at            TEXT NOT NULL,
  entry         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capability_logs_by_cap ON capability_logs (capability_id, at);
CREATE TABLE IF NOT EXISTS platform_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS widget_cache (
  key           TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  view          TEXT,
  at            TEXT,
  error         TEXT,
  error_at      TEXT
);
CREATE TABLE IF NOT EXISTS model_calls (
  id             TEXT PRIMARY KEY,
  capability_id  TEXT NOT NULL,
  model          TEXT NOT NULL,
  month          TEXT NOT NULL,
  at             TEXT NOT NULL,
  status         TEXT NOT NULL,
  reserved_usd   REAL NOT NULL,
  cost_usd       REAL NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  caller         TEXT
);
CREATE INDEX IF NOT EXISTS model_calls_by_month ON model_calls (month, capability_id);
CREATE TABLE IF NOT EXISTS builds (
  id             TEXT PRIMARY KEY,
  capability_id  TEXT NOT NULL REFERENCES capabilities(id),
  kind           TEXT NOT NULL,
  request        TEXT NOT NULL,
  requested_by   TEXT NOT NULL,
  status         TEXT NOT NULL,
  base_version   INTEGER,
  result_version INTEGER,
  log            TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  builder        TEXT,
  depends_on     TEXT,
  review         TEXT
);
-- What a build runs on: the model and effort asked for (or the owner's setting), the model it
-- actually ran on, and a note for the owner (a pinned model that wasn't available).
CREATE TABLE IF NOT EXISTS build_models (
  build_id       TEXT PRIMARY KEY,
  model          TEXT,
  effort         TEXT,
  ran_model      TEXT,
  note           TEXT
);
`;

type Row = Record<string, any>;
const now = () => new Date().toISOString();

export interface Confirmation {
  id: string;
  agentId: string;
  capabilityId: string;
  operation: string;
  inputHash: string;
  input: unknown;
  status: "pending" | "approved" | "rejected" | "used" | "reported";
  createdAt: string;
  decidedAt: string | null;
}

const confirmationRow = (x: Row): Confirmation => ({
  id: x.id as string,
  agentId: x.agent_id as string,
  capabilityId: x.capability_id as string,
  operation: x.operation as string,
  inputHash: x.input_hash as string,
  input: JSON.parse(x.input as string),
  status: x.status as Confirmation["status"],
  createdAt: x.created_at as string,
  decidedAt: (x.decided_at as string | null) ?? null,
});

const toCapability = (r: Row): CapabilityRow => ({
  id: r.id,
  name: r.name,
  purpose: r.purpose,
  activeVersion: r.active_version,
  displayName: r.display_name ?? null,
  iconType: r.icon_type ?? null,
  hue: r.hue === null || r.hue === undefined ? null : Number(r.hue),
  homeOrder: r.home_order === null || r.home_order === undefined ? null : Number(r.home_order),
  archivedAt: r.archived_at ?? null,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const toVersion = (r: Row): VersionRow => ({
  capabilityId: r.capability_id,
  version: r.version,
  manifest: JSON.parse(r.manifest),
  contentHash: r.content_hash,
  buildId: r.build_id,
  createdAt: r.created_at,
});

const toBuild = (r: Row): BuildRow => ({
  id: r.id,
  capabilityId: r.capability_id,
  kind: r.kind,
  request: JSON.parse(r.request),
  requestedBy: r.requested_by,
  builder: r.builder ?? null,
  status: r.status,
  baseVersion: r.base_version,
  resultVersion: r.result_version,
  dependsOn: r.depends_on ?? null,
  review: r.review ? JSON.parse(r.review) : null,
  log: JSON.parse(r.log),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const passkeyRow = (r: Row) => ({
  credentialId: r.credential_id as string,
  rpId: r.rp_id as string,
  publicKey: r.public_key as string,
  signCount: Number(r.sign_count),
  name: r.name as string,
  createdAt: r.created_at as string,
  lastUsedAt: (r.last_used_at as string | null) ?? null,
});

/** Platform metadata store. Capability state lives elsewhere (one DB per capability). */
export class Registry {
  db: Sql;

  constructor(db: Sql) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  // ---------- metrics (aggregates only; never inputs, outputs or names of data) ----------

  /** Counts for the metrics endpoint: tools, builds, calls (from the call logs), model use this month. */
  metricsSnapshot(since24h: string, since7d: string, month: string) {
    const all = <T>(sql: string, ...args: unknown[]) => this.db.prepare(sql).all(...args) as T[];
    const one = <T>(sql: string, ...args: unknown[]) => this.db.prepare(sql).get(...args) as T;
    const tools = one<{ active: number; archived: number; unversioned: number }>(`
      SELECT sum(CASE WHEN archived_at IS NULL AND active_version IS NOT NULL THEN 1 ELSE 0 END) AS active,
             sum(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
             sum(CASE WHEN archived_at IS NULL AND active_version IS NULL THEN 1 ELSE 0 END) AS unversioned
      FROM capabilities`);
    const builds = all<{ status: string; n: number }>("SELECT status, count(*) AS n FROM builds GROUP BY status");
    const buildTime = one<{ n: number; seconds: number | null }>(`
      SELECT count(*) AS n, sum((julianday(updated_at) - julianday(created_at)) * 86400) AS seconds
      FROM builds WHERE status = 'promoted' AND created_at >= ?`, since7d);
    const calls = (since: string) => all<{ entry: string }>("SELECT entry FROM capability_logs WHERE at >= ?", since).map((r) => r.entry);
    const model = one<{ usd: number | null; input: number | null; output: number | null; calls: number }>(`
      SELECT sum(cost_usd) AS usd, sum(input_tokens) AS input, sum(output_tokens) AS output, count(*) AS calls
      FROM model_calls WHERE month = ?`, month);
    return { tools, builds, buildTime, calls24h: calls(since24h), calls7d: calls(since7d), model };
  }

  // ---------- platform settings (JSON values) ----------

  getKv<T>(key: string): T | undefined {
    const r = this.db.prepare("SELECT value FROM platform_kv WHERE key = ?").get(key) as Row | undefined;
    return r ? (JSON.parse(r.value as string) as T) : undefined;
  }

  /** The stored JSON text, for callers that cache by it. */
  getKvRaw(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM platform_kv WHERE key = ?").get(key) as Row | undefined)?.value as string | undefined;
  }

  setKv(key: string, value: unknown) {
    this.db.prepare("INSERT INTO platform_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  // ---------- widget cache: the last view (and the last error) per widget and input ----------

  widgetCache(key: string): { view: unknown; at: string | null; error: string | null; errorAt: string | null } | undefined {
    const r = this.db.prepare("SELECT * FROM widget_cache WHERE key = ?").get(key) as Row | undefined;
    return r ? { view: r.view ? JSON.parse(r.view as string) : null, at: r.at ?? null, error: r.error ?? null, errorAt: r.error_at ?? null } : undefined;
  }

  putWidgetView(key: string, capabilityId: string, view: unknown) {
    this.db
      .prepare("INSERT INTO widget_cache (key, capability_id, view, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET view = excluded.view, at = excluded.at, error = NULL, error_at = NULL")
      .run(key, capabilityId, JSON.stringify(view), now());
  }

  /** A failed refresh keeps the last view (Home shows it with a "!"). */
  putWidgetError(key: string, capabilityId: string, error: string) {
    this.db
      .prepare("INSERT INTO widget_cache (key, capability_id, error, error_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET error = excluded.error, error_at = excluded.error_at")
      .run(key, capabilityId, error, now());
  }

  dropWidgetCache(capabilityId: string) {
    this.db.prepare("DELETE FROM widget_cache WHERE capability_id = ?").run(capabilityId);
  }

  // ---------- model spend (one row per ctx.model call) ----------

  /**
   * Reserve `usd` for a call if both caps allow it (checked and written in one transaction, so
   * concurrent calls can't overshoot). Returns false when a cap would be exceeded.
   */
  reserveModelSpend(row: { id: string; capabilityId: string; model: string; month: string; usd: number; caller?: string }, caps: { total: number; capability?: number }): { ok: true } | { ok: false; spent: number; cap: number; scope: "all" | "capability" } {
    return this.db.transaction(() => {
      const sum = (where: string, ...p: unknown[]) =>
        Number((this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_usd ELSE cost_usd END), 0) AS s FROM model_calls WHERE month = ? ${where}`).get(row.month, ...p) as Row).s);
      const total = sum("");
      if (total + row.usd > caps.total) return { ok: false as const, spent: total, cap: caps.total, scope: "all" as const };
      if (caps.capability !== undefined) {
        const mine = sum("AND capability_id = ?", row.capabilityId);
        if (mine + row.usd > caps.capability) return { ok: false as const, spent: mine, cap: caps.capability, scope: "capability" as const };
      }
      this.db.prepare("INSERT INTO model_calls (id, capability_id, model, month, at, status, reserved_usd, caller) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)").run(row.id, row.capabilityId, row.model, row.month, now(), row.usd, row.caller ?? null);
      return { ok: true as const };
    });
  }

  settleModelSpend(id: string, r: { costUsd: number; inputTokens: number; outputTokens: number; error?: string }) {
    this.db.prepare("UPDATE model_calls SET status = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, error = ? WHERE id = ?").run(r.error ? "failed" : "settled", r.costUsd, r.inputTokens, r.outputTokens, r.error ?? null, id);
  }

  /** Reservations a crash left open count as spent at their reserved amount until settled; settle them at that amount. */
  settleStaleModelSpend(before: string): number {
    const r = this.db.prepare("UPDATE model_calls SET status = 'failed', cost_usd = reserved_usd, error = 'interrupted' WHERE status = 'reserved' AND at < ?").run(before) as { changes?: number };
    return Number(r?.changes ?? 0);
  }

  /** The latest model calls, newest first (Activity). */
  recentModelCalls(limit: number): { at: string; capabilityId: string; model: string; caller: string; status: string; costUsd: number; inputTokens: number; outputTokens: number; error: string | null }[] {
    return this.db
      .prepare("SELECT * FROM model_calls ORDER BY at DESC LIMIT ?")
      .all(limit)
      .map((r) => ({ at: r.at, capabilityId: r.capability_id, model: r.model, caller: r.caller ?? `capability:${r.capability_id}`, status: r.status, costUsd: Number(r.status === "reserved" ? r.reserved_usd : r.cost_usd), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), error: r.error ?? null }));
  }

  modelSpend(month: string): { capabilityId: string; model: string; calls: number; costUsd: number; inputTokens: number; outputTokens: number }[] {
    return this.db
      .prepare(
        `SELECT capability_id, model, COUNT(*) AS calls, SUM(CASE WHEN status = 'reserved' THEN reserved_usd ELSE cost_usd END) AS cost, SUM(input_tokens) AS tin, SUM(output_tokens) AS tout
         FROM model_calls WHERE month = ? GROUP BY capability_id, model ORDER BY cost DESC`,
      )
      .all(month)
      .map((r) => ({ capabilityId: r.capability_id, model: r.model, calls: Number(r.calls), costUsd: Number(r.cost), inputTokens: Number(r.tin), outputTokens: Number(r.tout) }));
  }

  /** Builds left mid-flight by a previous process can never finish. Returns their ids. */
  failInterruptedBuilds(): string[] {
    const ids = this.db
      .prepare("SELECT id FROM builds WHERE status IN ('building', 'validating')")
      .all()
      .map((r) => (r as Row).id as string);
    for (const id of ids) {
      const log = [...this.getBuild(id)!.log, "FAILED: interrupted by platform restart"];
      this.updateBuild(id, { status: "failed", log });
    }
    return ids;
  }

  close() {
    this.db.close?.();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  /** One call's entry in a capability's log: a header line plus its own console lines (indented). */
  addCapabilityLog(capabilityId: string, at: string, header: string, lines: string[]) {
    this.db.prepare("INSERT INTO capability_logs (capability_id, at, entry) VALUES (?, ?, ?)").run(capabilityId, at, [header, ...lines.map((l) => `  ${l}`)].join("\n"));
  }

  /** The last `n` log lines of a capability, oldest first. */
  capabilityLogLines(capabilityId: string, n: number): string[] {
    const rows = this.db.prepare("SELECT entry FROM capability_logs WHERE capability_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(capabilityId, n);
    return rows.reverse().flatMap((r) => String(r.entry).split("\n")).slice(-n);
  }

  getCapability(id: string): CapabilityRow | undefined {
    const r = this.db.prepare("SELECT * FROM capabilities WHERE id = ?").get(id);
    return r ? toCapability(r) : undefined;
  }

  listActiveCapabilities(): CapabilityRow[] {
    return this.db
      .prepare("SELECT * FROM capabilities WHERE active_version IS NOT NULL AND archived_at IS NULL ORDER BY id")
      .all()
      .map(toCapability);
  }

  listArchivedCapabilities(): CapabilityRow[] {
    return this.db
      .prepare("SELECT * FROM capabilities WHERE active_version IS NOT NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC")
      .all()
      .map(toCapability);
  }

  insertCapability(c: { id: string; name: string; purpose: string; createdBy: string }) {
    this.db
      .prepare("INSERT INTO capabilities (id, name, purpose, active_version, created_by, created_at) VALUES (?, ?, ?, NULL, ?, ?)")
      .run(c.id, c.name, c.purpose, c.createdBy, now());
  }

  /** The secret part of a capability's UI address, made on first use (a new capability under a purged id gets a new one). */
  uiKey(id: string, make: () => string): string {
    const cur = this.db.prepare("SELECT ui_key FROM capabilities WHERE id = ?").get(id)?.ui_key as string | null | undefined;
    if (cur) return cur;
    const key = make();
    this.db.prepare("UPDATE capabilities SET ui_key = ? WHERE id = ?").run(key, id);
    return key;
  }

  setOwnerPrefs(id: string, prefs: { displayName?: string | null; iconType?: string | null; archivedAt?: string | null; hue?: number | null }) {
    const map: Record<string, string> = { displayName: "display_name", iconType: "icon_type", archivedAt: "archived_at", hue: "hue" };
    for (const [k, v] of Object.entries(prefs)) this.db.prepare(`UPDATE capabilities SET ${map[k]} = ? WHERE id = ?`).run(v ?? null, id);
  }

  promote(c: { id: string; name: string; purpose: string; version: number }) {
    this.db
      .prepare("UPDATE capabilities SET name = ?, purpose = ?, active_version = ? WHERE id = ?")
      .run(c.name, c.purpose, c.version, c.id);
  }

  getVersion(capabilityId: string, version: number): VersionRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM capability_versions WHERE capability_id = ? AND version = ?")
      .get(capabilityId, version);
    return r ? toVersion(r) : undefined;
  }

  latestVersionNumber(capabilityId: string): number {
    const r = this.db
      .prepare("SELECT MAX(version) AS v FROM capability_versions WHERE capability_id = ?")
      .get(capabilityId) as Row;
    return r.v ?? 0;
  }

  insertVersion(v: Omit<VersionRow, "createdAt">) {
    this.db
      .prepare("INSERT INTO capability_versions (capability_id, version, manifest, content_hash, build_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(v.capabilityId, v.version, JSON.stringify(v.manifest), v.contentHash, v.buildId, now());
  }

  insertBuild(b: Pick<BuildRow, "id" | "capabilityId" | "kind" | "request" | "requestedBy" | "baseVersion" | "builder"> & { dependsOn?: string }) {
    const t = now();
    const status = b.dependsOn ? "waiting" : "building";
    this.db
      .prepare("INSERT INTO builds (id, capability_id, kind, request, requested_by, builder, status, base_version, depends_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(b.id, b.capabilityId, b.kind, JSON.stringify(b.request), b.requestedBy, b.builder, status, b.baseVersion, b.dependsOn ?? null, t, t);
  }

  /** The model and effort a build runs with (kept apart from the request: retries copy the request, not the outcome). */
  setBuildModel(buildId: string, m: { model?: string; effort?: string }) {
    this.db.prepare("INSERT OR REPLACE INTO build_models (build_id, model, effort) VALUES (?, ?, ?)").run(buildId, m.model ?? null, m.effort ?? null);
  }

  /** The model the builder reported running on, and a note for the owner. */
  updateBuildModel(buildId: string, patch: { ranModel?: string; note?: BuildModel["note"] }) {
    this.db.prepare("INSERT OR IGNORE INTO build_models (build_id) VALUES (?)").run(buildId);
    if (patch.ranModel !== undefined) this.db.prepare("UPDATE build_models SET ran_model = ? WHERE build_id = ?").run(patch.ranModel, buildId);
    if (patch.note !== undefined) this.db.prepare("UPDATE build_models SET note = ? WHERE build_id = ?").run(JSON.stringify(patch.note), buildId);
  }

  buildModel(buildId: string): BuildModel | undefined {
    const r = this.db.prepare("SELECT * FROM build_models WHERE build_id = ?").get(buildId);
    if (!r) return undefined;
    return {
      ...(r.model ? { model: r.model as string } : {}),
      ...(r.effort ? { effort: r.effort as string } : {}),
      ...(r.ran_model ? { ran: r.ran_model as string } : {}),
      ...(r.note ? { note: JSON.parse(r.note as string) } : {}),
    };
  }

  /** Builds waiting for `buildId` (or, without it, every waiting build). */
  waitingBuilds(buildId?: string): BuildRow[] {
    const rows = buildId
      ? this.db.prepare("SELECT * FROM builds WHERE status = 'waiting' AND depends_on = ? ORDER BY created_at").all(buildId)
      : this.db.prepare("SELECT * FROM builds WHERE status = 'waiting' ORDER BY created_at").all();
    return rows.map(toBuild);
  }

  /** The newest retry of a build ("retryOf" in its request), if any. */
  retryOf(buildId: string): string | undefined {
    const rows = this.db.prepare("SELECT id, request FROM builds WHERE created_at >= (SELECT created_at FROM builds WHERE id = ?) ORDER BY created_at DESC").all(buildId);
    return rows.find((r) => r.id !== buildId && JSON.parse(r.request as string).retryOf === buildId)?.id as string | undefined;
  }

  /** User-approved authority for a capability: "secret:NAME" / "host:example.com". */
  grants(capabilityId: string): Set<string> {
    return new Set(
      this.db
        .prepare("SELECT kind, name FROM grants WHERE capability_id = ?")
        .all(capabilityId)
        .map((r) => `${(r as Row).kind}:${(r as Row).name}`),
    );
  }

  approveGrant(capabilityId: string, kind: GrantKind, name: string, by: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO grants (capability_id, kind, name, approved_by, approved_at) VALUES (?, ?, ?, ?, ?)")
      .run(capabilityId, kind, name, by, now());
  }

  /** Grants other capabilities hold to call `capabilityId`: [holder, "capability:<id>/<op>"]. */
  grantsTo(capabilityId: string): [string, string][] {
    return this.db
      .prepare("SELECT capability_id, name FROM grants WHERE kind = 'capability' AND substr(name, 1, ?) = ?")
      .all(capabilityId.length + 1, `${capabilityId}/`)
      .map((r) => [r.capability_id as string, `capability:${r.name as string}`]);
  }

  revokeGrant(capabilityId: string, kind: GrantKind, name: string) {
    this.db.prepare("DELETE FROM grants WHERE capability_id = ? AND kind = ? AND name = ?").run(capabilityId, kind, name);
  }

  /** The owner's values for a capability's declared config (non-secret settings). */
  config(capabilityId: string): Record<string, string> {
    return Object.fromEntries(this.db.prepare("SELECT name, value FROM config_values WHERE capability_id = ?").all(capabilityId).map((r) => [r.name as string, r.value as string]));
  }

  setConfig(capabilityId: string, name: string, value: string, by: string) {
    this.db.prepare("INSERT OR REPLACE INTO config_values (capability_id, name, value, set_by, set_at) VALUES (?, ?, ?, ?, ?)").run(capabilityId, name, value, by, now());
  }

  deleteConfig(capabilityId: string, name: string) {
    this.db.prepare("DELETE FROM config_values WHERE capability_id = ? AND name = ?").run(capabilityId, name);
  }

  /** UI auth: one-time tickets (from `hewn open`) and the sessions they are exchanged for. */
  insertUiToken(hash: string, capabilityId: string, kind: "ticket" | "session", expiresAt: number) {
    this.db.prepare("DELETE FROM ui_sessions WHERE expires_at < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO ui_sessions (token_hash, capability_id, kind, expires_at) VALUES (?, ?, ?, ?)")
      .run(hash, capabilityId, kind, expiresAt);
  }

  /** Returns the capability id for a live token of that kind; tickets are consumed. */
  useUiToken(hash: string, kind: "ticket" | "session"): string | undefined {
    const r = this.db
      .prepare("SELECT capability_id FROM ui_sessions WHERE token_hash = ? AND kind = ? AND expires_at >= ?")
      .get(hash, kind, Date.now()) as Row | undefined;
    if (r && kind === "ticket") this.db.prepare("DELETE FROM ui_sessions WHERE token_hash = ?").run(hash);
    return r?.capability_id;
  }

  insertWebToken(hash: string, kind: "ticket" | "session", expiresAt: number, userAgent?: string) {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(Date.now());
    const t = now();
    this.db
      .prepare("INSERT INTO web_sessions (token_hash, kind, expires_at, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(hash, kind, expiresAt, t, t, userAgent?.slice(0, 300) ?? null);
  }

  /** Sliding expiry: push a live session's expiry out (and note when it was last used). */
  touchWebSession(hash: string, expiresAt: number) {
    this.db.prepare("UPDATE web_sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ? AND kind = 'session'").run(expiresAt, now(), hash);
  }

  webSessions() {
    return this.db
      .prepare("SELECT token_hash, created_at, last_seen_at, user_agent, expires_at FROM web_sessions WHERE kind = 'session' AND expires_at >= ? ORDER BY last_seen_at DESC")
      .all(Date.now())
      .map((r) => {
        const x = r as Row;
        return { hash: x.token_hash as string, createdAt: x.created_at as string | null, lastSeenAt: x.last_seen_at as string | null, userAgent: x.user_agent as string | null, expiresAt: x.expires_at as number };
      });
  }

  deleteWebSession(hash: string) {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ? AND kind = 'session'").run(hash);
  }

  useWebToken(hash: string, kind: "ticket" | "session"): boolean {
    const r = this.db.prepare("SELECT 1 FROM web_sessions WHERE token_hash = ? AND kind = ? AND expires_at >= ?").get(hash, kind, Date.now());
    if (r && kind === "ticket") this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(hash);
    return !!r;
  }

  // ---------- passkeys (the owner's, per public host) ----------

  insertPasskey(p: { credentialId: string; rpId: string; publicKey: string; signCount: number; name: string }) {
    this.db.prepare("INSERT INTO passkeys (credential_id, rp_id, public_key, sign_count, name, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(p.credentialId, p.rpId, p.publicKey, p.signCount, p.name, now());
  }

  passkey(credentialId: string) {
    const r = this.db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").get(credentialId) as Row | undefined;
    return r ? passkeyRow(r) : undefined;
  }

  passkeys() {
    return this.db.prepare("SELECT * FROM passkeys ORDER BY created_at").all().map((r) => passkeyRow(r as Row));
  }

  usePasskey(credentialId: string, signCount: number) {
    this.db.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?").run(signCount, now(), credentialId);
  }

  deletePasskey(credentialId: string) {
    this.db.prepare("DELETE FROM passkeys WHERE credential_id = ?").run(credentialId);
  }

  /** Implementation history with the build that produced each version. */
  versions(capabilityId: string) {
    return this.db
      .prepare(
        `SELECT v.version, v.created_at, b.kind, b.requested_by, b.builder, b.request
         FROM capability_versions v LEFT JOIN builds b ON b.id = v.build_id
         WHERE v.capability_id = ? ORDER BY v.version DESC`,
      )
      .all(capabilityId)
      .map((r) => {
        const x = r as Row;
        return { version: x.version, createdAt: x.created_at, kind: x.kind, requestedBy: x.requested_by, builder: x.builder ?? "agent", request: x.request ? JSON.parse(x.request) : null };
      });
  }

  /** Authority history for the activity timeline: approve / revoke / request (an agent asking). */
  addGrantEvent(capabilityId: string, action: "approve" | "revoke" | "request", grant: string, actor: string) {
    this.db.prepare("INSERT INTO grant_events (capability_id, action, grant_ref, actor, at) VALUES (?, ?, ?, ?, ?)").run(capabilityId, action, grant, actor, now());
  }

  grantEvents(limit = 500) {
    return this.db
      .prepare("SELECT * FROM grant_events ORDER BY at DESC LIMIT ?")
      .all(limit)
      .map((r) => {
        const x = r as Row;
        return { capabilityId: x.capability_id as string, action: x.action as "approve" | "revoke" | "request", grant: x.grant_ref as string, actor: x.actor as string, at: x.at as string };
      });
  }

  /**
   * Who changed what has authority over the owner's Hewn, beyond grants (those have their own
   * events): agents approved, declined, revoked or re-scoped; secrets set or removed;
   * destructive calls confirmed or rejected.
   */
  addAuthorityEvent(e: { actor: string; action: string; subject: string; capabilityId?: string; detail?: string }) {
    this.db.prepare("INSERT INTO authority_events (at, actor, action, subject, capability_id, detail) VALUES (?, ?, ?, ?, ?, ?)").run(now(), e.actor, e.action, e.subject, e.capabilityId ?? null, e.detail ?? "");
  }

  authorityEvents(limit = 500) {
    return this.db
      .prepare("SELECT * FROM authority_events ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(limit)
      .map((r) => {
        const x = r as Row;
        return { at: x.at as string, actor: x.actor as string, action: x.action as string, subject: x.subject as string, capabilityId: (x.capability_id as string | null) ?? null, detail: x.detail as string };
      });
  }

  // ---------- confirmations (destructive calls by agents) ----------

  addConfirmation(c: { id: string; agentId: string; capabilityId: string; operation: string; inputHash: string; input: unknown }) {
    this.db
      .prepare("INSERT INTO confirmations (id, agent_id, capability_id, operation, input_hash, input, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(c.id, c.agentId, c.capabilityId, c.operation, c.inputHash, JSON.stringify(c.input ?? {}), now());
  }

  /** The newest confirmation for exactly this call (agent, capability, operation, input). */
  findConfirmation(agentId: string, capabilityId: string, operation: string, inputHash: string): Confirmation | undefined {
    const r = this.db
      .prepare("SELECT * FROM confirmations WHERE agent_id = ? AND capability_id = ? AND operation = ? AND input_hash = ? AND status IN ('pending', 'approved', 'rejected') ORDER BY created_at DESC LIMIT 1")
      .get(agentId, capabilityId, operation, inputHash);
    return r && confirmationRow(r as Row);
  }

  getConfirmation(id: string): Confirmation | undefined {
    const r = this.db.prepare("SELECT * FROM confirmations WHERE id = ?").get(id);
    return r && confirmationRow(r as Row);
  }

  setConfirmation(id: string, status: Confirmation["status"]) {
    this.db.prepare("UPDATE confirmations SET status = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?").run(status, now(), id);
  }

  pendingConfirmations(): Confirmation[] {
    return this.db.prepare("SELECT * FROM confirmations WHERE status = 'pending' ORDER BY created_at").all().map((r) => confirmationRow(r as Row));
  }

  /** Drop confirmations older than `before` (pending ones expire, decided ones are spent). */
  expireConfirmations(before: string) {
    this.db.prepare("DELETE FROM confirmations WHERE created_at < ?").run(before);
  }

  /** Capability call logs are kept for a limited time (14 days by default). */
  pruneCapabilityLogs(before: string): number {
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM capability_logs WHERE at < ?").get(before) as Row).n as number;
    this.db.prepare("DELETE FROM capability_logs WHERE at < ?").run(before);
    return n;
  }

  /** Owner's Home order: ids in the order given; everything else keeps no position. */
  setHomeOrder(ids: string[]) {
    this.transaction(() => {
      this.db.prepare("UPDATE capabilities SET home_order = NULL").run();
      ids.forEach((id, i) => this.db.prepare("UPDATE capabilities SET home_order = ? WHERE id = ?").run(String(i), id));
    });
  }

  /** Owner lifecycle actions for the activity timeline: delete, restore, rollback, purge. */
  addLifecycleEvent(capabilityId: string, action: "delete" | "restore" | "rollback" | "purge" | "schedule", detail: string, actor: string) {
    this.db.prepare("INSERT INTO lifecycle_events (capability_id, action, detail, actor, at) VALUES (?, ?, ?, ?, ?)").run(capabilityId, action, detail, actor, now());
  }

  lifecycleEvents(limit = 500) {
    return this.db
      .prepare("SELECT * FROM lifecycle_events ORDER BY at DESC LIMIT ?")
      .all(limit)
      .map((r) => {
        const x = r as Row;
        return { capabilityId: x.capability_id as string, action: x.action as string, detail: x.detail as string, actor: x.actor as string, at: x.at as string };
      });
  }

  /** Point the capability at an existing version (rollback). */
  activate(id: string, version: number) {
    const v = this.getVersion(id, version)!;
    this.promote({ id, name: v.manifest.name, purpose: v.manifest.purpose, version });
  }

  /** Remove every row about a capability (permanent delete). */
  purgeCapability(id: string) {
    this.transaction(() => {
      for (const table of ["grants", "config_values", "grant_events", "access_requests", "ui_sessions", "builds", "capability_versions", "capability_logs", "confirmations"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE capability_id = ?`).run(id);
      }
      this.db.prepare("DELETE FROM capabilities WHERE id = ?").run(id);
    });
  }

  /** Builds that ended (promoted, failed, cancelled) before `before` (ISO time). */
  finishedBuildsBefore(before: string): { id: string; capabilityId: string; status: string }[] {
    return this.db
      .prepare("SELECT id, capability_id, status FROM builds WHERE status IN ('promoted', 'failed', 'cancelled') AND updated_at < ?")
      .all(before)
      .map((r) => ({ id: r.id, capabilityId: r.capability_id, status: r.status }));
  }

  /** Reserved ids that never got a version: capabilities without an active one or an archive mark. */
  unpromotedCapabilities(): string[] {
    return this.db.prepare("SELECT id FROM capabilities WHERE active_version IS NULL AND archived_at IS NULL").all().map((r) => r.id as string);
  }

  buildIdsFor(capabilityId: string): string[] {
    return this.db.prepare("SELECT id FROM builds WHERE capability_id = ?").all(capabilityId).map((r) => (r as Row).id as string);
  }

  /** The most recent build per capability (for Home badges). */
  latestBuilds(): Map<string, { id: string; status: BuildStatus }> {
    const out = new Map<string, { id: string; status: BuildStatus }>();
    for (const r of this.db.prepare("SELECT id, capability_id, status FROM builds ORDER BY created_at ASC").all()) {
      const x = r as Row;
      out.set(x.capability_id, { id: x.id, status: x.status });
    }
    return out;
  }

  recentBuilds(limit = 20) {
    return this.db.prepare("SELECT id FROM builds ORDER BY created_at DESC LIMIT ?").all(limit).map((r) => (r as Row).id as string);
  }

  addAccessRequest(capabilityId: string, requestedBy: string, note: string) {
    this.db.prepare("INSERT INTO access_requests (capability_id, requested_by, note, created_at) VALUES (?, ?, ?, ?)").run(capabilityId, requestedBy, note, now());
  }

  accessRequests(capabilityId?: string) {
    const rows = capabilityId
      ? this.db.prepare("SELECT * FROM access_requests WHERE capability_id = ? ORDER BY created_at DESC").all(capabilityId)
      : this.db.prepare("SELECT * FROM access_requests ORDER BY created_at DESC").all();
    return rows.map((r) => ({ capabilityId: (r as Row).capability_id, requestedBy: (r as Row).requested_by, note: (r as Row).note, createdAt: (r as Row).created_at }));
  }

  clearAccessRequests(capabilityId: string) {
    this.db.prepare("DELETE FROM access_requests WHERE capability_id = ?").run(capabilityId);
  }

  getBuild(id: string): BuildRow | undefined {
    const r = this.db.prepare("SELECT * FROM builds WHERE id = ?").get(id);
    return r ? toBuild(r) : undefined;
  }

  updateBuild(id: string, patch: Partial<Pick<BuildRow, "status" | "resultVersion" | "log" | "baseVersion" | "dependsOn" | "review">>) {
    const cur = this.getBuild(id)!;
    const next = { ...cur, ...patch };
    this.db
      .prepare("UPDATE builds SET status = ?, result_version = ?, log = ?, base_version = ?, depends_on = ?, review = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.resultVersion, JSON.stringify(next.log), next.baseVersion, next.dependsOn, next.review ? JSON.stringify(next.review) : null, now(), id);
  }

  /** Whether any version (of any capability) is stored under this content hash. */
  versionWithHash(hash: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM capability_versions WHERE content_hash = ? LIMIT 1").get(hash);
  }

  /** Builds waiting for the owner's review, oldest first. */
  buildsInReview(): BuildRow[] {
    return this.db.prepare("SELECT * FROM builds WHERE status = 'review' ORDER BY created_at").all().map(toBuild);
  }
}
