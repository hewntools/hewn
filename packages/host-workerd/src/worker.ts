// SPDX-License-Identifier: AGPL-3.0-or-later
// The workerd host. One Worker:
//   - default fetch: every request goes to the owner's HewnDO
//   - Public: the tunnel's way in (its own socket): only MCP and OAuth, rate limited
//   - HewnDO: the core Platform on Durable Object SQL, the HTTP surface, the admin channel
//   - CapabilityHost: one DO per capability; runs versions as facets (private SQLite each)
//   - Egress: the Dynamic Workers' globalOutbound, allowing only declared, granted hosts
// Machine-bound work (builders, bundling, intake, connecting local agents, blob deletes) goes to
// the supervisor over an authenticated HTTP channel.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { type Agent, USER } from "@hewntools/core/auth.ts";
import { deadlineOf, deadlineTimer } from "@hewntools/core/deadline.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import type { GenerateRequest, GenerateResult, HostGenerateResult } from "@hewntools/core/models.ts";
import { fromBase64, toBase64 } from "@hewntools/core/files.ts";
import type { Migration } from "@hewntools/core/migrations.ts";
import { Platform } from "@hewntools/core/platform.ts";
import type { Blobs, BuildJob, CapabilityRuntime, CodeRef, Files, SecretStore, Sql, StateRef, Workbench } from "@hewntools/core/ports.ts";
import { sameDigest } from "@hewntools/core/sha256.ts";
import { gatedFetch } from "./egress.ts";
import { handle, McpSessions } from "./surface/index.ts";
import { agentModels, intakeJob, jobModel, type ModelCatalog, type Settings, settingsProblems, type SurfaceHost } from "./surface/host.ts";
import { CLIENT_IP_HEADER, gatePublic, PROXY_SECRET_HEADER, PUBLIC_HEADER, RateLimiter } from "./surface/public.ts";
// Text modules, embedded by the supervisor's config.
// @ts-expect-error text module
import BRIEF from "./builder-brief.md";
// @ts-expect-error text module
import RUNTIME from "./capability-runtime.js";

interface Env {
  HEWN: DurableObjectNamespace;
  CAPS: DurableObjectNamespace;
  LOADER: WorkerLoader;
  BLOBS: Fetcher;
  ASSETS_WEB: Fetcher;
  ASSETS_UI: Fetcher;
  SUPERVISOR: Fetcher;
  /** Authenticates the supervisor → workerd admin channel. */
  ADMIN_TOKEN: string;
  /** Authenticates workerd → supervisor calls. */
  SUPERVISOR_TOKEN: string;
  /** base64 AES-256 key for secrets at rest (held by the supervisor, outside the data dir). */
  SECRETS_KEY: string;
  /** The owner's timezone (IANA), from the supervisor's machine. */
  TIMEZONE: string;
  PORT: string;
  /** HEWN_PROXY_SECRET: when set, the public sockets take only requests carrying it ("" = off). */
  PROXY_SECRET?: string;
  /** "1" when the host runs Hewn's builder and intake (HEWN_BUILD_URL): "remote" is a choice, and the default. */
  REMOTE_JOBS?: string;
  /** "1" when a host runs this Hewn for its owner (HEWN_HOSTED): no terminal, no local agents. */
  HOSTED?: string;
  /** Where the host signs the owner in (HEWN_HOST_SIGNIN_URL), for signed-out pages in hosted mode. */
  HOST_SIGNIN_URL?: string;
}

const COMPAT_DATE = "2026-09-01";
const CALL_TIMEOUT_MS = 30_000;

// ---------- the edge: everything goes to the owner's HewnDO ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only the Public entrypoint may mark a request public (and say who sent it).
    if (request.headers.has(PUBLIC_HEADER) || request.headers.has(CLIENT_IP_HEADER) || request.headers.has(PROXY_SECRET_HEADER)) {
      const headers = new Headers(request.headers);
      headers.delete(PUBLIC_HEADER);
      headers.delete(CLIENT_IP_HEADER);
      headers.delete(PROXY_SECRET_HEADER);
      request = new Request(request, { headers });
    }
    return env.HEWN.get(env.HEWN.idFromName("owner")).fetch(request);
  },
};

/** One isolate serves the public socket, so in-memory counters are the whole picture. */
const limiter = new RateLimiter();

export class Public extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const gated = gatePublic(request, limiter, (l) => console.log(`[${new Date().toISOString()}] ${l}`), this.env.PROXY_SECRET);
    if (gated instanceof Response) return gated;
    return this.env.HEWN.get(this.env.HEWN.idFromName("owner")).fetch(gated);
  }
}

// ---------- adapters ----------

function doSql(storage: DurableObjectStorage): Sql {
  const rows = (query: string, params: unknown[]) => [...storage.sql.exec(query, ...params)] as Record<string, any>[];
  return {
    // DO SQL takes one statement per exec unless there are no bindings; split simple scripts.
    exec: (query) => void storage.sql.exec(query).toArray(),
    prepare: (query) => ({
      run: (...params) => storage.sql.exec(query, ...params).toArray(),
      all: (...params) => rows(query, params),
      get: (...params) => rows(query, params)[0],
    }),
    transaction: (fn) => storage.transactionSync(fn),
  };
}

/**
 * Secrets encrypted at rest (AES-256-GCM, bound to capability and name) in the owner's DO.
 * Values are decrypted into memory at start so the core's lookups stay synchronous; writes are
 * encrypted and persisted before the request that made them completes (see HewnDO.fetch).
 */
class EncryptedSecretStore implements SecretStore {
  private sql: Sql;
  private key: CryptoKey;
  private values = new Map<string, string>();
  /** Rows encrypted with another key (a backup restored on a new machine): treated as not set. */
  private lost = new Set<string>();
  private pending: Promise<void>[] = [];

  private constructor(sql: Sql, key: CryptoKey) {
    this.sql = sql;
    this.key = key;
  }

  static async open(sql: Sql, base64Key: string): Promise<EncryptedSecretStore> {
    if (!base64Key) throw new Error("no secrets key (HEWN_SECRETS_KEY); start Hewn with hewn serve");
    const key = await crypto.subtle.importKey("raw", fromBase64(base64Key), "AES-GCM", false, ["encrypt", "decrypt"]);
    const store = new EncryptedSecretStore(sql, key);
    sql.exec("CREATE TABLE IF NOT EXISTS secrets_enc (capability_id TEXT NOT NULL, name TEXT NOT NULL, iv TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (capability_id, name))");
    for (const r of sql.prepare("SELECT * FROM secrets_enc").all()) {
      try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(r.iv), additionalData: aad(r.capability_id, r.name) }, key, fromBase64(r.data));
        store.values.set(`${r.capability_id}/${r.name}`, new TextDecoder().decode(plain));
      } catch {
        store.lost.add(`${r.capability_id}/${r.name}`);
      }
    }
    if (store.lost.size) {
      console.log(`[${new Date().toISOString()}] ${store.lost.size} secret(s) can't be read with this home's secrets key (restored from another machine or home?): ${[...store.lost].join(", ")}. They count as not set: set them again, or start Hewn with the old key.`);
    }
    return store;
  }

  get(capabilityId: string, name: string) {
    return this.values.get(`${capabilityId}/${name}`);
  }

  unreadable() {
    return [...this.lost];
  }

  set(capabilityId: string, name: string, value: string) {
    this.values.set(`${capabilityId}/${name}`, value);
    this.lost.delete(`${capabilityId}/${name}`);
    this.pending.push(
      (async () => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(capabilityId, name) }, this.key, new TextEncoder().encode(value)));
        // A newer write or a delete may have happened meanwhile; only the latest value is kept.
        if (this.values.get(`${capabilityId}/${name}`) !== value) return;
        this.sql.prepare("INSERT OR REPLACE INTO secrets_enc (capability_id, name, iv, data) VALUES (?, ?, ?, ?)").run(capabilityId, name, toBase64(iv), toBase64(data));
      })(),
    );
  }

  delete(capabilityId: string, name: string) {
    this.values.delete(`${capabilityId}/${name}`);
    this.lost.delete(`${capabilityId}/${name}`);
    this.sql.prepare("DELETE FROM secrets_enc WHERE capability_id = ? AND name = ?").run(capabilityId, name);
  }

  /** Wait until every write so far is persisted. */
  async flush() {
    const p = this.pending;
    this.pending = [];
    await Promise.all(p);
  }
}

const aad = (capabilityId: string, name: string) => new TextEncoder().encode(`${capabilityId}/${name}`);

/** Calls to the supervisor (token-authenticated, loopback only). */
function supervisor(env: Env) {
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await env.SUPERVISOR.fetch(`http://supervisor${path}`, { ...init, headers: { "x-hewn-token": env.SUPERVISOR_TOKEN, "content-type": "application/json", ...(init.headers ?? {}) } });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; unavailable?: boolean };
      throw Object.assign(new Error(body.error ?? `supervisor ${path}: HTTP ${res.status}`), { unavailable: body.unavailable });
    }
    return res;
  };
  return {
    call,
    json: async <T>(path: string, body?: unknown): Promise<T> => (await call(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })).json() as Promise<T>,
    /** POST and read an NDJSON stream of events. */
    async stream(path: string, body: unknown, onEvent: (e: any) => void, signal?: AbortSignal) {
      const res = await call(path, { method: "POST", body: JSON.stringify(body), signal });
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) onEvent(JSON.parse(line));
        }
      }
    },
  };
}

const encodeFiles = (files: Files) => Object.fromEntries(Object.entries(files).map(([p, b]) => [p, toBase64(b)]));
const decodeFiles = (files: Record<string, string>): Files => Object.fromEntries(Object.entries(files).map(([p, b]) => [p, fromBase64(b)]));

/** Candidate UIs being rendered by the supervisor: their API calls come back here by build id. */
type VisualInvoke = (body: { operation: string; operationVersion?: number; input?: unknown }) => Promise<{ result: unknown }>;

function remoteWorkbench(env: Env, visualInvokers: Map<string, VisualInvoke>): Workbench {
  const sv = supervisor(env);
  return {
    async visualCheck(buildId, args) {
      visualInvokers.set(buildId, args.invoke);
      try {
        const r = await sv.json<{ skipped?: string; errors: string[]; screenshot?: string; screenshotDark?: string }>("/workbench/visual", { buildId, manifest: args.manifest, ...(args.widgets ? { widgets: args.widgets } : {}) });
        return { skipped: r.skipped, errors: r.errors ?? [], screenshot: r.screenshot ? fromBase64(r.screenshot) : undefined, screenshotDark: r.screenshotDark ? fromBase64(r.screenshotDark) : undefined };
      } finally {
        visualInvokers.delete(buildId);
      }
    },
    open: async (buildId, files) => void (await sv.json("/workbench/open", { buildId, files: encodeFiles(files) })),
    read: async (buildId) => decodeFiles((await sv.json<{ files: Record<string, string> }>("/workbench/read", { buildId })).files),
    file: async (buildId, path) => {
      const r = await sv.json<{ data: string | null }>("/workbench/file", { buildId, path });
      return r.data === null ? undefined : fromBase64(r.data);
    },
    remove: async (buildId) => void (await sv.json("/workbench/remove", { buildId })),
    build: async (job: BuildJob, hooks) => {
      let failure: { error: string; unavailable?: boolean; refused?: boolean; modelUnavailable?: boolean } | undefined;
      try {
        await sv.stream("/workbench/build", job, (e) => {
          if (e.activity) hooks.onActivity(e.activity);
          if (e.model) hooks.onModel?.(e.model);
          if (e.charge) hooks.onCharge?.(e.charge);
          if (e.error) failure = e;
        }, hooks.signal);
      } catch (e) {
        // The supervisor (where the builder runs) went away mid-build: Hewn is likely restarting.
        if (!hooks.signal.aborted && !(e as { unavailable?: boolean }).unavailable && !/supervisor .*HTTP/.test((e as Error).message)) throw Object.assign(e as Error, { interrupted: true });
        throw e;
      }
      if (failure) throw Object.assign(new Error(failure.error), { unavailable: failure.unavailable, refused: failure.refused, modelUnavailable: failure.modelUnavailable });
    },
    bundle: (buildId) => sv.json("/workbench/bundle", { buildId }),
    note: async (buildId, line) => void (await sv.json("/workbench/note", { buildId, line })),
    transcript: async (buildId) => (await sv.json<{ text: string | null }>("/workbench/transcript", { buildId })).text ?? undefined,
    removeTranscript: async (buildId) => void (await sv.json("/workbench/remove-transcript", { buildId })),
  };
}

function diskBlobs(env: Env): Blobs {
  const sv = supervisor(env);
  return {
    async get(key) {
      const res = await env.BLOBS.fetch(`http://blobs/${key}`);
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
    },
    async put(key, data) {
      const res = await env.BLOBS.fetch(`http://blobs/${key}`, { method: "PUT", body: data as BodyInit });
      if (!res.ok) throw new Error(`blob write ${key}: HTTP ${res.status}`);
    },
    // The disk service can't delete; the supervisor can.
    delete: async (key) => void (await sv.json("/blobs/delete", { key })),
  };
}

/** The runtime port: capability code runs in its CapabilityHost, isolated, with its own state. */
function workerdRuntime(env: Env): CapabilityRuntime {
  // RPC stub of a CapabilityHost (typed loosely: the generated stub types are too deep for tsc).
  const host = (capabilityId: string) => env.CAPS.get(env.CAPS.idFromName(capabilityId)) as unknown as CapabilityHostApi;
  return {
    async invoke(target, key, input, onCall, onModel) {
      const call = async (capabilityId: string, operation: string, callInput: unknown) => {
        if (!onCall) throw new Error("capability calls are not available here");
        return onCall({ capabilityId, operation, input: callInput });
      };
      const timer = deadlineTimer(deadlineOf(target.deadline, CALL_TIMEOUT_MS), () => new PlatformError("operation_failed", `${key} timed out (call chain deadline)`));
      try {
        const r = await Promise.race([
          host(target.capabilityId).invoke(target.code, target.state.scratch ?? null, key, input, target.secrets ?? {}, target.hosts ?? [], target.caller, call, target.config ?? {}, onModel ?? null, !!target.readOnly),
          timer.expired,
        ]);
        if (!r.ok) throw new PlatformError("operation_failed", `${key} failed: ${r.error}`, { logs: r.logs });
        return { output: r.output, secretUpdates: r.secretUpdates, logs: r.logs };
      } catch (e) {
        if (e instanceof PlatformError) throw e;
        throw new PlatformError("operation_failed", `${key} failed: ${(e as Error).message}`);
      } finally {
        timer.clear();
      }
    },
    // Describing only loads code; any capability id's host can do it.
    describe: (code) => host("_describe").describe(code),
    migrate: (state, migrations, code) => host(state.capabilityId).migrate(state.scratch ?? null, migrations, code),
    hasState: (state) => host(state.capabilityId).hasState(state.scratch ?? null),
    copyState: (from, to) => host(from.capabilityId).copyState(from.scratch ?? null, to.scratch ?? null),
    dropState: (state) => host(state.capabilityId).dropState(state.scratch ?? null),
    listStates: (capabilityId, prefix) => host(capabilityId).listStates(prefix),
    dumpState: (state, code) => host(state.capabilityId).dump(state.scratch ?? null, code),
    loadState: (state, tables, code) => host(state.capabilityId).load(state.scratch ?? null, tables, code),
  };
}

type CapabilityHostApi = {
  [K in "invoke" | "describe" | "migrate" | "dump" | "load" | "hasState" | "copyState" | "dropState" | "listStates"]: (...args: any[]) => Promise<any>;
};

// ---------- HewnDO: the owner's platform ----------

const DEFAULT_SETTINGS: Settings = { builder: "claude", maxBuildAttempts: 3, sandbox: true, intake: "claude", logRetentionDays: 14 };

export class HewnDO extends DurableObject<Env> {
  private platform!: Platform;
  private sessions!: McpSessions;
  private secrets!: EncryptedSecretStore;
  private visualInvokers = new Map<string, VisualInvoke>();
  private sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = doSql(ctx.storage);
    this.sql.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (env.REMOTE_JOBS === "1") this.forgetFrozenJobs();
    ctx.blockConcurrencyWhile(async () => {
      this.secrets = await EncryptedSecretStore.open(this.sql, env.SECRETS_KEY);
      this.platform = new Platform({
        sql: this.sql,
        blobs: diskBlobs(env),
        runtime: workerdRuntime(env),
        workbench: remoteWorkbench(env, this.visualInvokers),
        secrets: this.secrets,
        brief: BRIEF,
        designSystem: async () => {
          const res = await env.ASSETS_UI.fetch("http://assets/ui.css");
          return res.ok ? res.text() : undefined;
        },
        logger: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
        builder: () => this.settings().builder,
        buildModel: (builder) => jobModel(this.settings(), "builder", builder),
        agentBuildModels: (builder) => agentModels(this.settings(), builder),
        // From the builder's model list (the supervisor reads it and keeps it a while).
        modelEfforts: async (builder, model) => (await supervisor(env).json<ModelCatalog>("/models/catalog", { agent: builder })).models.find((m) => m.id === model)?.efforts,
        maxBuildAttempts: () => this.settings().maxBuildAttempts,
        logRetentionDays: () => this.settings().logRetentionDays,
        timezone: () => this.settings().timeZone || env.TIMEZONE || "UTC",
        onSchedulesChanged: () => void this.armAlarm(),
        // Model providers are called from here (host-side), never from capability code.
        modelFetch: (url, init) => fetch(url, init),
        // Hosted: tools' model calls go to the host, through the supervisor (it holds the host's token).
        ...(env.HOSTED === "1"
          ? {
              hostModels: async (req, signal) => {
                const j = (await (await supervisor(env).call("/models/generate", { method: "POST", body: JSON.stringify(req), signal })).json()) as { result?: HostGenerateResult; error?: string; refused?: boolean; charge?: unknown; stop?: string };
                if (j.error !== undefined || !j.result) throw Object.assign(new Error(j.error ?? "no reply"), { refused: !!j.refused, charge: j.charge, stop: j.stop });
                return j.result;
              },
            }
          : {}),
      });
      this.sessions = new McpSessions(this.platform, (m) => console.log(`[${new Date().toISOString()}] ${m}`), (p) => this.surfaceHost().asset(p));
      await this.armAlarm();
      // Not awaited: retried builds run in the background.
      void this.platform.recoverInterruptedBuilds().then(() => this.platform.cleanup());
    });
  }

  /** One DO alarm for the next due schedule (re-armed whenever that may change). */
  private async armAlarm() {
    const next = this.platform.nextScheduleAt();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  async alarm() {
    await this.platform.runDueSchedules();
    await this.secrets.flush();
    await this.armAlarm();
  }

  private settings(): Settings {
    // A host that runs the builder and intake makes them the default.
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...(this.env.REMOTE_JOBS === "1" ? { builder: "remote", intake: "remote" } : {}) };
    for (const r of this.sql.prepare("SELECT key, value FROM settings").all()) out[r.key] = JSON.parse(r.value);
    // Hosted: the host builds, whatever was stored before (a home moved from a machine with agents).
    if (this.env.HOSTED === "1") Object.assign(out, { builder: "remote", intake: "remote" });
    return out as unknown as Settings;
  }

  /** Validate the whole result, store only what changed: settings left alone keep following their defaults. */
  private writeSettings(change: Record<string, unknown>): Settings {
    if (this.env.HOSTED === "1" && [change.builder, change.intake].some((a) => a !== undefined && a !== "remote")) throw new PlatformError("invalid_request", "the host builds tools here");
    const next = { ...this.settings(), ...change } as Settings;
    const bad = settingsProblems(next as unknown as Record<string, unknown>, { remote: this.env.REMOTE_JOBS === "1", changed: Object.keys(change) });
    if (bad.length) throw new PlatformError("invalid_request", bad.join("; "));
    for (const k of ["builder", "intake", "maxBuildAttempts", "sandbox", "firstRunDone", "logRetentionDays", "timeZone", "jobsChosen", "jobModels", "agentModels"] as const)
      if (k in change && next[k] !== undefined) this.sql.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(k, JSON.stringify(next[k]));
    return next;
  }

  /**
   * Up to 0.4.2 saving any setting stored every default with it, so a home could hold builder or
   * intake "claude" that the owner never picked, hiding the host's builder (the default here). Drop
   * a job's stored agent unless the owner chose it (jobsChosen); the host's default applies again.
   */
  private forgetFrozenJobs() {
    const stored = (k: string): unknown => {
      const r = this.sql.prepare("SELECT value FROM settings WHERE key = ?").get(k);
      return r === undefined ? undefined : JSON.parse(r.value);
    };
    const chosen = stored("jobsChosen");
    for (const k of ["builder", "intake"]) {
      const agent = stored(k);
      if (agent !== undefined && agent !== "remote" && !(Array.isArray(chosen) && chosen.includes(k))) this.sql.prepare("DELETE FROM settings WHERE key = ?").run(k);
    }
  }

  private surfaceHost(): SurfaceHost {
    const env = this.env;
    const sv = supervisor(env);
    const hosted = env.HOSTED === "1";
    return {
      port: Number(env.PORT),
      log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
      async asset(path) {
        const [kind, ...rest] = path.split("/");
        const svc = kind === "web" ? env.ASSETS_WEB : kind === "platform-ui" ? env.ASSETS_UI : undefined;
        if (!svc || rest.some((p) => p === ".." || p === "")) return undefined;
        const res = await svc.fetch(`http://assets/${rest.join("/")}`);
        return res.ok && res.headers.get("content-type") !== "application/json" ? new Uint8Array(await res.arrayBuffer()) : undefined;
      },
      settings: { read: async () => this.settings(), write: async (change) => this.writeSettings(change) },
      intake: async (req, onProgress, signal) => {
        let reply: any;
        let error: string | undefined;
        const { agent, run } = intakeJob(this.settings());
        await sv.stream("/intake", { intake: agent, run, req }, (e) => {
          if (e.progress) onProgress?.(e.progress);
          if (e.reply) reply = e.reply;
          if (e.error) error = e.error;
        }, signal);
        if (error || !reply) throw new Error(error ?? "intake returned nothing");
        return reply;
      },
      intakeLog: async (entry) => void (await sv.json("/intake/log", entry)),
      modelCatalog: (agent) => sv.json<ModelCatalog>("/models/catalog", { agent }),
      // The supervisor checked the link is https; checked again, as it goes into an href.
      ...(hosted ? { hosted: env.HOST_SIGNIN_URL && URL.canParse(env.HOST_SIGNIN_URL) && new URL(env.HOST_SIGNIN_URL).protocol === "https:" ? { signInUrl: env.HOST_SIGNIN_URL } : {} } : {}),
      // Hosted: no local agents to connect, and the public address is the host's (no tunnel).
      ...(hosted
        ? {}
        : {
            setup: {
              list: () => sv.json("/setup/list", {}),
              // The supervisor runs the harness steps and its OAuth login; the owner approves in the web client.
              connect: (agentId, mcpUrl, event) => sv.stream("/setup/connect", { agentId, mcpUrl }, (e) => event(e.name, e.data)),
            },
            tunnel: () => sv.json("/tunnel/status", {}),
          }),
      backups: {
        location: async () => (await sv.json<{ dir: string }>("/backups/list", {})).dir,
        list: async () => (await sv.json<{ backups: unknown[] }>("/backups/list", {})).backups,
        now: () => sv.json("/backups/now", {}),
        sameDisk: async () => (await sv.json<{ sameDisk?: boolean | null }>("/backups/list", {})).sameDisk ?? null,
      },
      tools: () => sv.json("/setup/tools", {}),
      status: () => sv.json("/status/info", {}),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const res = url.pathname.startsWith("/_admin/") ? await this.admin(request, url) : await handle(this.platform, this.sessions, this.surfaceHost(), request);
    // Secret writes are durable before the answer goes out. (Calls that refresh a secret run
    // inside these requests too.)
    await this.secrets.flush();
    return res;
  }

  /** The supervisor's channel: CLI actions as the owner (open, init, install, status). */
  private async admin(request: Request, url: URL): Promise<Response> {
    if (!sameDigest(request.headers.get("x-hewn-admin") ?? "", this.env.ADMIN_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const body: any = request.method === "POST" ? await request.json() : {};
    try {
      switch (url.pathname) {
        case "/_admin/visual-invoke": {
          // The supervisor's headless browser calling the candidate UI's API.
          const invoke = this.visualInvokers.get(body.buildId);
          if (!invoke) return Response.json({ error: "not_found", message: "no visual check in progress for this build" }, { status: 404 });
          try {
            return Response.json(await invoke(body.body));
          } catch (e) {
            const err = e as PlatformError;
            return Response.json({ error: err.code ?? "internal", message: err.message, details: err.details }, { status: 400 });
          }
        }
        case "/_admin/call": {
          // The CLI's way in: allow-listed core methods, as the owner.
          const spec = ADMIN_CALLS[body.method as string];
          if (!spec) return Response.json({ error: "not_found", message: `no admin method ${body.method}` }, { status: 404 });
          const args = spec.owner ? [USER, ...(body.args ?? [])] : (body.args ?? []);
          return Response.json({ result: (await (this.platform as any)[body.method](...args)) ?? null });
        }
        case "/_admin/web-ticket":
          return Response.json({ ticket: this.platform.createWebTicket(USER) });
        case "/_admin/install": {
          const seed = body.files ? decodeFiles(body.files) : undefined;
          const builder = body.builder ?? (seed ? "keep" : `copy:${body.dir}`);
          const started = await this.platform.install(USER, { name: body.name, purpose: body.purpose, builder, id: body.id, seed, requirements: body.requirements });
          return Response.json(body.wait ? await this.platform.settle(started.buildId) : started);
        }
        case "/_admin/status":
          return Response.json({
            capabilities: this.platform.list(USER).map((c) => ({ id: c.id, ready: c.ready, version: this.platform.registry.getCapability(c.id)?.activeVersion })),
            builds: this.platform.registry.recentBuilds(10).map((b) => this.platform.getBuild(USER, b)),
          });
        case "/_admin/invoke": {
          const agent: Agent = USER;
          return Response.json(await this.platform.invoke(agent, body));
        }
        case "/_admin/approve":
          return Response.json({ approved: this.platform.approveGrants(USER, body.capabilityId) });
        case "/_admin/modify": {
          const started = await this.platform.modify(USER, { capabilityId: body.capabilityId, request: body.request });
          return Response.json(body.wait ? await this.platform.settle(started.buildId) : started);
        }
        case "/_admin/schedules":
          return Response.json(body.id ? this.platform.updateSchedule(USER, body.id, body.change) : body.capabilityId && body.cadence ? this.platform.createSchedule(USER, body) : this.platform.listSchedules(USER, body.capabilityId));
        case "/_admin/schedules/fire": {
          // Test hook: make a schedule due now (the alarm fires it).
          this.platform.schedules.update(body.id, { nextRunAt: Date.now() });
          await this.armAlarm();
          return Response.json({ ok: true });
        }
        case "/_admin/import":
          return Response.json(await this.platform.importData(USER, body.capabilityId, body.tables));
        case "/_admin/secret":
          this.platform.setSecret(USER, body.capabilityId, body.name, body.value);
          return Response.json({ ok: true });
        case "/_admin/revoke":
          this.platform.revokeGrant(USER, body.capabilityId, body.grant);
          return Response.json({ ok: true });
        case "/_admin/readiness":
          return Response.json(this.platform.readiness(body.capabilityId));
        case "/_admin/logs":
          return Response.json({ lines: this.platform.logLines(body.capabilityId, body.n ?? 100) });
        case "/_admin/archive":
          this.platform.archive(USER, body.capabilityId);
          return Response.json({ ok: true });
        case "/_admin/rollback":
          return Response.json(await this.platform.rollback(USER, body.capabilityId, body.version));
        case "/_admin/export":
          return Response.json(await this.platform.exportData(USER, body.capabilityId));
        case "/_admin/purge":
          await this.platform.purge(USER, body.capabilityId, body.confirm);
          return Response.json({ ok: true });
        case "/_admin/settings":
          return Response.json(request.method === "POST" ? this.writeSettings(body) : this.settings());
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (e) {
      const err = e as PlatformError;
      return Response.json({ error: err.code ?? "internal", message: err.message, details: err.details }, { status: 400 });
    }
  }
}

/** Core methods the CLI may call over the admin channel; `owner`: the first argument is the owner. */
const ADMIN_CALLS: Record<string, { owner: boolean }> = {
  list: { owner: true }, get: { owner: true }, authorization: { owner: false }, readiness: { owner: false },
  setSecret: { owner: true }, deleteSecret: { owner: true }, setConfig: { owner: true }, connect: { owner: true }, accounts: { owner: true }, approveGrants: { owner: true }, approveGrant: { owner: true }, revokeGrant: { owner: true },
  archive: { owner: true }, restore: { owner: true }, archived: { owner: true }, rollback: { owner: true }, exportData: { owner: true }, importData: { owner: true }, purge: { owner: true },
  logLines: { owner: false }, getBuild: { owner: true }, retryBuild: { owner: true }, cancelBuild: { owner: true },
  buildsInReview: { owner: true }, approveBuild: { owner: true }, rejectBuild: { owner: true },
  buildReport: { owner: true },
  cleanup: { owner: false },
  listSchedules: { owner: true }, createSchedule: { owner: true }, updateSchedule: { owner: true }, deleteSchedule: { owner: true },
  createWebTicket: { owner: true }, createUiTicket: { owner: false }, publicUrl: { owner: false }, setPublicUrl: { owner: true }, passkeys: { owner: true }, removePasskey: { owner: true },
  agents: { owner: true }, updateAgent: { owner: true }, pendingAgents: { owner: true }, decideAgent: { owner: true }, unreadableSecrets: { owner: true },
  confirmations: { owner: true }, decideConfirmation: { owner: true },
  models: { owner: true }, setModelSettings: { owner: true }, setModelKey: { owner: true }, checkModelProvider: { owner: true }, replacePinnedModel: { owner: true }, setCapabilityModel: { owner: true }, modelSpend: { owner: true }, refreshModelCatalog: { owner: false },
  metrics: { owner: true },
};

// ---------- CapabilityHost: one per capability ----------

/** A capability's states are facets of its host: "live", or "s:<scratch name>". */
const facetName = (scratch: string | null) => (scratch ? `s:${scratch}` : "live");

export class CapabilityHost extends DurableObject<Env> {
  /** Which loaded code each running facet was started with. */
  private running = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS states (name TEXT PRIMARY KEY)");
  }

  private worker(code: CodeRef, hosts: string[]) {
    const key = `${code.hash}|${hosts.join(",")}`;
    return {
      key,
      stub: this.env.LOADER.get(key, () => ({
        compatibilityDate: COMPAT_DATE,
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "hewn-runtime.js",
        modules: { "hewn-runtime.js": RUNTIME, "capability.js": code.js },
        env: {},
        globalOutbound: (this.ctx as any).exports.Egress({ props: { hosts } }),
      })),
    };
  }

  /** The facet for a state, running `code` (restarted if it was running other code). */
  private facet(scratch: string | null, code: CodeRef, hosts: string[]) {
    const name = facetName(scratch);
    const w = this.worker(code, hosts);
    if (this.running.has(name) && this.running.get(name) !== w.key) this.ctx.facets.abort(name, new Error("new version"));
    this.running.set(name, w.key);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO states (name) VALUES (?)", name);
    return this.ctx.facets.get(name, () => ({ class: w.stub.getDurableObjectClass("Capability") })) as any;
  }

  async invoke(code: CodeRef, scratch: string | null, key: string, input: unknown, secrets: Record<string, string>, hosts: string[], caller: { kind: string; id: string } | undefined, call: (capabilityId: string, operation: string, input: unknown) => Promise<unknown>, config: Record<string, string> = {}, model: ((req: GenerateRequest) => Promise<GenerateResult>) | null = null, readOnly = false) {
    return this.facet(scratch, code, hosts).invoke(key, input, secrets, caller, call, config, model, readOnly);
  }

  async describe(code: CodeRef): Promise<string[]> {
    return (this.worker(code, []).stub.getEntrypoint() as any).describe();
  }

  async migrate(scratch: string | null, migrations: Migration[], code: CodeRef): Promise<string[]> {
    return this.facet(scratch, code, []).migrate(migrations);
  }

  async dump(scratch: string | null, code: CodeRef) {
    return this.facet(scratch, code, []).dump();
  }

  async load(scratch: string | null, tables: Record<string, Record<string, unknown>[]>, code: CodeRef): Promise<number> {
    return this.facet(scratch, code, []).load(tables);
  }

  hasState(scratch: string | null): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM states WHERE name = ?", facetName(scratch)).toArray().length > 0;
  }

  copyState(from: string | null, to: string | null) {
    const src = facetName(from);
    const dst = facetName(to);
    this.drop(dst);
    this.ctx.facets.clone(src, dst);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO states (name) VALUES (?)", dst);
  }

  dropState(scratch: string | null) {
    this.drop(facetName(scratch));
  }

  private drop(name: string) {
    if (this.running.has(name)) this.ctx.facets.abort(name, new Error("dropped"));
    this.running.delete(name);
    this.ctx.facets.delete(name);
    this.ctx.storage.sql.exec("DELETE FROM states WHERE name = ?", name);
  }

  listStates(prefix: string): string[] {
    return this.ctx.storage.sql
      .exec("SELECT name FROM states WHERE name LIKE 's:%'")
      .toArray()
      .map((r) => String(r.name).slice(2))
      .filter((n) => n.startsWith(prefix));
  }
}

// ---------- Egress: the only way out of a capability ----------

export class Egress extends WorkerEntrypoint<Env, { hosts: string[] }> {
  async fetch(request: Request): Promise<Response> {
    return gatedFetch(request, this.ctx.props.hosts ?? []);
  }
}
