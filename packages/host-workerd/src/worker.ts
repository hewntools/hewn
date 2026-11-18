// SPDX-License-Identifier: AGPL-3.0-or-later
// The platform's workerd. Hewn runs the platform and the tools in separate processes; this is the
// platform's Worker (the tools' is tools-worker.ts):
//   - default fetch: every request goes to the owner's HewnDO
//   - Public: the tunnel's way in (its own socket): only MCP and OAuth, rate limited
//   - ToolCalls: a running tool call's callbacks (`call`, `model`), on a socket only the tools process reaches
//   - HewnDO: the core Platform on Durable Object SQL, the HTTP surface, the admin channel
// Machine-bound work (builders, bundling, intake, connecting local agents, blob deletes) goes to
// the supervisor over an authenticated HTTP channel.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { type Agent, USER } from "@hewntools/core/auth.ts";
import { deadlineOf, deadlineTimer } from "@hewntools/core/deadline.ts";
import { DOC_NAME } from "@hewntools/core/docs.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import type { GenerateRequest, GenerateResult, HostGenerateResult } from "@hewntools/core/models.ts";
import type { ShelfTool } from "@hewntools/core/bundle.ts";
import { fromBase64, toBase64 } from "@hewntools/core/files.ts";
import { checkToJson } from "@hewntools/core/checks.ts";
import { Platform } from "@hewntools/core/platform.ts";
import { resolveHosts } from "@hewntools/core/platform/grants.ts";
import type { Blobs, BuildJob, CapabilityRuntime, CodeRef, Files, SecretStore, Sql, StateRef, Workbench } from "@hewntools/core/ports.ts";
import { randomToken, sameDigest } from "@hewntools/core/sha256.ts";
import { handle, McpSessions } from "./surface/index.ts";
import { defaultPasses } from "@hewntools/core/passes.ts";
import { agentModels, intakeJob, jobModel, type ModelCatalog, type Settings, settingsProblems, type SurfaceHost, TOOL_DATA_LIMIT_MB, toolDataLimitMB } from "./surface/host.ts";
import { CLIENT_IP_HEADER, gatePublic, PROXY_CLIENT_IP_HEADER, PROXY_SECRET_HEADER, PUBLIC_HEADER, RateLimiter } from "./surface/public.ts";
import { fetchLink } from "./surface/fetch-link.ts";
// Text modules, embedded by the supervisor's config.
// @ts-expect-error text module
import BRIEF from "./builder-brief.md";
import { type CallInFlight, stallRoles } from "./stall-blame.ts";
import { IDLE_GC_BACKGROUND_EVERY_MS, IDLE_GC_QUIET_MS, IdleGc, tickCall } from "./idle-gc.ts";
import { CALL_TOKEN_HEADER, type CallbackKind, type Callbacks, EGRESS_PATH, type EgressMark, TOOLS_TOKEN_HEADER, toolsChannel, ToolsUnreachable } from "./tools-channel.ts";

interface Env {
  HEWN: DurableObjectNamespace;
  /** The tools process (tools-worker.ts), on its socket. */
  TOOLS: Fetcher;
  /** Authenticates the platform's calls to the tools process. */
  TOOLS_TOKEN: string;
  BLOBS: Fetcher;
  ASSETS_WEB: Fetcher;
  ASSETS_UI: Fetcher;
  /** Hewn's docs pages (hewn_docs): the user docs, and the spec's. */
  ASSETS_DOCS: Fetcher;
  ASSETS_SPEC: Fetcher;
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
  /** HEWN_PROXY_CLIENT_IP: "1" takes the visitor's address from the trusted proxy's x-hewn-proxy-client-ip. */
  PROXY_CLIENT_IP?: string;
  /** "1" when the host runs Hewn's builder and intake (HEWN_BUILD_URL): "remote" is a choice, and the default. */
  REMOTE_JOBS?: string;
  /** "1" when a host runs this Hewn for its owner (HEWN_HOSTED): no terminal, no local agents. */
  HOSTED?: string;
  /** This Hewn's version. */
  VERSION?: string;
  /** Where the host signs the owner in (HEWN_HOST_SIGNIN_URL), for signed-out pages in hosted mode. */
  HOST_SIGNIN_URL?: string;
}

const CALL_TIMEOUT_MS = 30_000;

// ---------- the edge: everything goes to the owner's HewnDO ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only the Public entrypoint may mark a request public (and say who sent it).
    if ([PUBLIC_HEADER, CLIENT_IP_HEADER, PROXY_SECRET_HEADER, PROXY_CLIENT_IP_HEADER].some((h) => request.headers.has(h))) {
      const headers = new Headers(request.headers);
      headers.delete(PUBLIC_HEADER);
      headers.delete(CLIENT_IP_HEADER);
      headers.delete(PROXY_SECRET_HEADER);
      headers.delete(PROXY_CLIENT_IP_HEADER);
      request = new Request(request, { headers });
    }
    return env.HEWN.get(env.HEWN.idFromName("owner")).fetch(request);
  },
};

/** One isolate serves the public socket, so in-memory counters are the whole picture. */
const limiter = new RateLimiter();

export class Public extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const gated = gatePublic(request, limiter, (l) => console.log(`[${new Date().toISOString()}] ${l}`), this.env.PROXY_SECRET, this.env.PROXY_CLIENT_IP === "1");
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

/** The shelf, read once (it changes only with the release). */
let shelfCache: Promise<{ tools: ShelfTool[]; firstRun: string[] }> | undefined;

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
        const r = await sv.json<{ skipped?: string; errors: string[]; screenshot?: string; screenshotDark?: string; shots?: { name: string; png: string }[]; defects?: string[] }>("/workbench/visual", { buildId, manifest: args.manifest, ...(args.widgets ? { widgets: args.widgets } : {}), ...(args.measure ? { measure: true } : {}) });
        return {
          skipped: r.skipped,
          errors: r.errors ?? [],
          screenshot: r.screenshot ? fromBase64(r.screenshot) : undefined,
          screenshotDark: r.screenshotDark ? fromBase64(r.screenshotDark) : undefined,
          ...(r.shots ? { shots: r.shots.map((s) => ({ name: s.name, png: fromBase64(s.png) })) } : {}),
          ...(r.defects ? { defects: r.defects } : {}),
        };
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
    snapshot: async (buildId, to) => void (await sv.json("/workbench/snapshot", { buildId, to })),
    carryOver: async (from, to, overlay) => (await sv.json<{ carried: boolean }>("/workbench/carry-over", { from, to, overlay: encodeFiles(overlay) })).carried,
    writeFolder: async (buildId, folder, files) => void (await sv.json("/workbench/write-folder", { buildId, folder, files: encodeFiles(files) })),
    build: async (job: BuildJob, hooks) => {
      let failure: { error: string; unavailable?: boolean; refused?: boolean; paused?: boolean; modelUnavailable?: boolean } | undefined;
      // The builder's checks, run here (the core) and answered to the supervisor, where the builder waits.
      const answer = (id: string) =>
        hooks.onCheck!(id)
          .then((r) => ({ result: checkToJson(r) }), (e: Error) => ({ error: e.message }))
          .then((out) => sv.json("/workbench/check-result", { buildId: job.buildId, id, ...out }))
          .catch(() => {});
      try {
        await sv.stream("/workbench/build", { ...job, ...(hooks.onCheck ? { check: true } : {}) }, (e) => {
          if (e.activity) hooks.onActivity(e.activity);
          if (e.model) hooks.onModel?.(e.model);
          if (e.charge) hooks.onCharge?.(e.charge);
          if (e.check && typeof e.check.id === "string" && hooks.onCheck) void answer(e.check.id);
          // An empty message is still a failure (a pause without a note).
          if (e.error !== undefined) failure = e;
        }, hooks.signal);
      } catch (e) {
        // The supervisor (where the builder runs) went away mid-build: Hewn is likely restarting.
        if (!hooks.signal.aborted && !(e as { unavailable?: boolean }).unavailable && !/supervisor .*HTTP/.test((e as Error).message)) throw Object.assign(e as Error, { interrupted: true });
        throw e;
      }
      if (failure) throw Object.assign(new Error(failure.error), { unavailable: failure.unavailable, refused: failure.refused, paused: failure.paused, modelUnavailable: failure.modelUnavailable });
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

/**
 * How big a capability's states may grow (bytes; 0: not at all), and what to say when a call needed
 * more: the owner's limit, or none while the disk is nearly full.
 */
interface DataLimits {
  limit(capabilityId: string): number;
  full(capabilityId: string, limit: number): string;
}

/** SQLite's error for a write past a state's limit (or a full disk). */
const isFull = (message: string | undefined) => /SQLITE_FULL/.test(message ?? "");

/**
 * The hosts a tool's calls run with when `code` is its active version (null when it isn't: code
 * going live).
 */
type LiveHosts = (capabilityId: string, code: CodeRef) => string[] | null;

/** A tool call running in the tools process: what its callbacks reach, by the token they carry. */
export interface ToolCall extends CallInFlight {
  call: (c: Callbacks["call"]) => Promise<unknown>;
  model: ((req: GenerateRequest) => Promise<GenerateResult>) | null;
  /** Past its deadline: its callbacks are refused (it stays listed for a stall the stop may lead to). */
  over: boolean;
}

/** What the runtime needs from the platform's DO besides the data limits. */
interface ToolsSide {
  /** The calls running in the tools process, by token (the DO answers their callbacks from it). */
  calls: Map<string, ToolCall>;
  /**
   * When the supervisor last said the tools stopped responding (ms), and why: what was running then failed for it.
   * `suspects`: the calls whose code may have held them (unset: it couldn't be told).
   */
  stall(): { at: number; why: string; suspects?: Set<string> } | undefined;
  /** Other work running tool code in the tools process now (loading, migrating, reading a tool's data). */
  otherWork: { running: number };
  /** Whether the tools process went away (a stall, an exit) and hasn't answered again since: the supervisor says both. */
  away(): boolean;
  /** The tools process won't stop a call (code that never yields): have the supervisor restart it. */
  stuck(reason: string): Promise<void>;
}

/** How long a stop may take before the tools process counts as stuck. */
const STOP_TIMEOUT_MS = 1000;
/** How long a call waits for the tools to answer again after they stopped responding. */
const RESTART_WAIT_MS = 10_000;

/**
 * The runtime port: capability code runs in its CapabilityHost, isolated, with its own state, in the tools
 * process (tools-worker.ts). The tools process going away (stopped, or restarted for not responding) fails
 * what was running there; what was running when it stopped responding fails saying so (`details.stalled`:
 * the stall was already told, with whoever was running then). Once it stopped responding, nothing more is
 * sent until a new one answers.
 */
function workerdRuntime(env: Env, data: DataLimits, liveHosts: LiveHosts, tools: ToolsSide): CapabilityRuntime {
  const host = toolsChannel(env.TOOLS, env.TOOLS_TOKEN);
  /** The tool's calls' hosts when this is its live state running its active version (null: it isn't). */
  const liveOf = (state: StateRef, code: CodeRef) => (state.scratch ? null : liveHosts(state.capabilityId, code));
  // Data ops run with the hosts the tool's calls have, so on the live state they share the calls' isolate
  // and never stop a call in progress; a build's states run with none, as validation's calls do. Only the
  // live tool's own isolate is named (workerd keeps it): `named`.
  const dataIsolate = (state: StateRef, code: CodeRef) => {
    const live = liveOf(state, code);
    return { hosts: live ?? [], named: live !== null };
  };
  /**
   * The tools process went away while `what` ran (sent at `sentAt`; `token`: the call's). A suspect of a stall failed
   * with it (told already, as a stall); a call running beside it, held up by it, fails saying so.
   */
  const lost = (what: string, sentAt: number, e: ToolsUnreachable, token?: string) => {
    const stall = tools.stall();
    if (!stall || sentAt > stall.at) return new PlatformError("operation_failed", `${what} failed: ${e.message}`);
    if (stall.suspects && !(token && stall.suspects.has(token))) return new PlatformError("operation_failed", `${what} failed: another tool's code held up Hewn's tools while this ran, and they were restarted (${stall.why})`, { heldUp: true });
    return new PlatformError("operation_failed", `${what} failed: stalled: Hewn's tools stopped responding while this ran and were restarted (${stall.why})`, { stalled: true });
  };
  /**
   * Once the tools process went away (it stopped responding, or exited), nothing is sent until the supervisor says a new
   * one answers: sent to the stuck one, a call would run there if it were only slow, then fail with it.
   */
  const toolsAnswer = async () => {
    for (const end = Date.now() + RESTART_WAIT_MS; tools.away() && Date.now() < end; ) await scheduler.wait(50);
  };
  /**
   * A call to the tools process, once it answers; failing as `lost` says if it goes. `runsCode`: it runs the tool's code
   * there (loading, migrating, reading its data), work a stall can't tell apart from the calls.
   */
  const toTools = async <T>(what: string, run: () => Promise<T>, runsCode = false): Promise<T> => {
    await toolsAnswer();
    const sentAt = Date.now();
    if (runsCode) tools.otherWork.running++;
    try {
      return await run();
    } catch (e) {
      throw e instanceof ToolsUnreachable ? lost(what, sentAt, e) : e;
    } finally {
      if (runsCode) tools.otherWork.running--;
    }
  };
  /** Run against a state with its limit; a write past it fails saying so. */
  const limited = async <T>(capabilityId: string, what: string, run: (limit: number) => Promise<T>): Promise<T> => {
    const limit = data.limit(capabilityId);
    try {
      return await toTools(what, () => run(limit), true);
    } catch (e) {
      if (isFull((e as Error).message)) throw new PlatformError("operation_failed", data.full(capabilityId, limit));
      throw e;
    }
  };
  return {
    async invoke(target, key, input, onCall, onModel) {
      // Its callbacks come back with this token, good while the call runs.
      const token = randomToken(24);
      const running: ToolCall = {
        token,
        capabilityId: target.capabilityId,
        state: target.state.scratch ?? "",
        started: false,
        waiting: 0,
        over: false,
        call: async (c) => {
          if (!onCall) throw new Error("capability calls are not available here");
          return onCall({ capabilityId: c.capabilityId, operation: c.operation, input: c.input });
        },
        model: onModel ?? null,
      };
      tools.calls.set(token, running);
      const timer = deadlineTimer(deadlineOf(target.deadline, CALL_TIMEOUT_MS), () => new PlatformError("operation_failed", `${key} timed out (call chain deadline)`));
      // Past the deadline the call is stopped, not only no longer waited for: its code, and anything
      // else running on that state with it, ends there. Code that never yields doesn't answer the stop:
      // the tools process is restarted (what was running there is told so, this call with it).
      let late: Error | undefined;
      const expired = timer.expired.catch(async (e: PlatformError) => {
        late = e;
        // Its callbacks are refused from now; it stays listed, for a stall its stop may lead to.
        running.over = true;
        const reason = `stopped: ${target.capabilityId}/${key} ran past its deadline`;
        await host(target.capabilityId)
          .stop({ scratch: target.state.scratch ?? null, reason }, { timeoutMs: STOP_TIMEOUT_MS })
          .catch(async (x) => {
            if (!(x instanceof ToolsUnreachable && x.timeout)) return;
            e.details = { stalled: true };
            await tools.stuck(`${reason} and didn't stop`).catch((err) => console.log(`[${new Date().toISOString()}] couldn't have the tools restarted: ${(err as Error).message}`));
          });
        throw e;
      });
      const limit = data.limit(target.capabilityId);
      const hosts = target.hosts ?? [];
      // A call on the live state with other hosts (sample data replayed, nothing granted yet) gets an isolate of its own.
      const live = liveOf(target.state, target.code);
      const named = live !== null && live.join(",") === hosts.join(",");
      let sentAt = Number.POSITIVE_INFINITY;
      const started = (isolate: string) => Object.assign(running, { started: true, isolate });
      const send = () => host(target.capabilityId).invoke({ code: target.code, scratch: target.state.scratch ?? null, key, input, secrets: target.secrets ?? {}, hosts, caller: target.caller, config: target.config ?? {}, readOnly: !!target.readOnly, limit, named, call: token, model: !!onModel }, { started });
      try {
        const r = await Promise.race([toolsAnswer().then(() => ((sentAt = Date.now()), send())), expired]);
        if (!r.ok) throw new PlatformError("operation_failed", isFull(r.error) ? data.full(target.capabilityId, limit) : `${key} failed: ${r.error}`, { logs: r.logs });
        return { output: r.output, secretUpdates: r.secretUpdates, logs: r.logs, inserted: r.inserted };
      } catch (e) {
        // Out of time: whatever came back once it was stopped, it timed out.
        if (late) throw late;
        if (e instanceof PlatformError) throw e;
        if (e instanceof ToolsUnreachable) throw lost(key, sentAt, e, token);
        throw new PlatformError("operation_failed", isFull((e as Error).message) ? data.full(target.capabilityId, limit) : `${key} failed: ${(e as Error).message}`);
      } finally {
        timer.clear();
        tools.calls.delete(token);
      }
    },
    // Describing only loads code (in an isolate of its own, gone once described); any capability id's host can do it.
    describe: (code) => toTools("loading it", () => host("_describe").describe({ code }), true),
    migrate: (state, migrations, code) => limited(state.capabilityId, "migrating", (limit) => host(state.capabilityId).migrate({ scratch: state.scratch ?? null, migrations, code, limit, ...dataIsolate(state, code) })),
    hasState: (state) => toTools("reading its data", () => host(state.capabilityId).hasState({ scratch: state.scratch ?? null })),
    copyState: (from, to) => toTools("copying its data", () => host(from.capabilityId).copyState({ from: from.scratch ?? null, to: to.scratch ?? null })),
    dropState: (state) => toTools("dropping its data", () => host(state.capabilityId).dropState({ scratch: state.scratch ?? null })),
    listStates: (capabilityId, prefix) => toTools("reading its data", () => host(capabilityId).listStates({ prefix })),
    dumpState: (state, code) => toTools("reading its data", () => host(state.capabilityId).dump({ scratch: state.scratch ?? null, code, limit: data.limit(state.capabilityId), ...dataIsolate(state, code) }), true),
    countState: (state, code) => toTools("reading its data", () => host(state.capabilityId).count({ scratch: state.scratch ?? null, code, limit: data.limit(state.capabilityId), ...dataIsolate(state, code) }), true),
    loadState: (state, tables, code) => limited(state.capabilityId, "loading its data", (limit) => host(state.capabilityId).load({ scratch: state.scratch ?? null, tables, code, limit, ...dataIsolate(state, code) })),
  };
}

// ---------- ToolCalls: a running call's callbacks, from the tools process ----------

/**
 * Its own socket in the data dir, which only the tools process is given. A callback carries its call's token:
 * a call that ended (or never ran) is refused. The owner's DO answers, as for a call made in this process.
 */
export class ToolCalls extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const owner = this.env.HEWN.get(this.env.HEWN.idFromName("owner")) as unknown as { toolCallback(token: string, kind: CallbackKind, body: unknown): Promise<{ result?: unknown; error?: string; code?: string; refused?: boolean }>; toolsFetch(mark: EgressMark): Promise<void> };
    if (path === EGRESS_PATH && request.method === "POST") {
      // Egress, with the tools' token: a fetch out of a tool isolate went out or is over.
      if (!sameDigest(request.headers.get(TOOLS_TOKEN_HEADER) ?? "", this.env.TOOLS_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
      await owner.toolsFetch((await request.json()) as EgressMark);
      return Response.json({ ok: true });
    }
    const kind = path.slice(1) as CallbackKind;
    if (request.method !== "POST" || (kind !== "call" && kind !== "model")) return Response.json({ error: "not_found" }, { status: 404 });
    const token = request.headers.get(CALL_TOKEN_HEADER) ?? "";
    const out = await owner.toolCallback(token, kind, await request.json());
    return Response.json(out, { status: out.refused ? 403 : 200 });
  }
}

// ---------- HewnDO: the owner's platform ----------

const DEFAULT_SETTINGS: Settings = { builder: "claude", maxBuildAttempts: 3, sandbox: true, intake: "claude", logRetentionDays: 14, buildPasses: defaultPasses(), toolDataLimitMB: TOOL_DATA_LIMIT_MB };

const MB = 1024 * 1024;
/** "100 MB", "2 GB". */
const sizeText = (bytes: number) => (bytes >= 1024 * MB && bytes % (1024 * MB) === 0 ? `${bytes / (1024 * MB)} GB` : `${Math.round(bytes / MB)} MB`);

export class HewnDO extends DurableObject<Env> {
  private platform!: Platform;
  private sessions!: McpSessions;
  private secrets!: EncryptedSecretStore;
  private visualInvokers = new Map<string, VisualInvoke>();
  private sql: Sql;
  /** The supervisor's word that the disk with Hewn's data is nearly full: tools' data doesn't grow while it is. */
  private diskLow: { floor: number } | null = null;
  /** Tool calls running in the tools process, by the token their callbacks carry. */
  private toolCalls = new Map<string, ToolCall>();
  /** When the supervisor last said the tools stopped responding (ms), and why. */
  private toolsStall: { at: number; why: string; suspects?: Set<string> } | undefined;
  /** Work besides calls running tool code in the tools process now. */
  private toolsOtherWork = { running: 0 };
  /** Fetches out of each tool isolate in the tools process (Egress's marks), by isolate key. */
  private fetchesOut = new Map<string, number>();
  /** When the supervisor last said the tools process went away (stalled or exited), and when one answered again (ms). */
  private toolsGoneAt = 0;
  private toolsBackAt = 0;
  /** The idle GC (`gc` is there in this process only). */
  private idleGc = new IdleGc((globalThis as { gc?: (o: object) => void }).gc);

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
        runtime: workerdRuntime(
          env,
          { limit: (id) => this.dataLimit(id), full: (id, limit) => this.dataFull(id, limit) },
          (id, code) => this.liveHosts(id, code),
          {
            calls: this.toolCalls,
            stall: () => this.toolsStall,
            otherWork: this.toolsOtherWork,
            away: () => this.toolsGoneAt > this.toolsBackAt,
            // The supervisor tells this DO what's stalled (/_admin/tools-stalled), then restarts the tools process.
            stuck: async (reason) => void (await supervisor(env).json("/tools/stalled", { reason })),
          },
        ),
        workbench: remoteWorkbench(env, this.visualInvokers),
        secrets: this.secrets,
        brief: BRIEF,
        version: env.VERSION,
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
        buildPasses: () => this.settings().buildPasses,
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
      // What was written down as running when this process ended goes: tool code runs in the tools process, so
      // none of it made this one stop (a stall there is told as it happens, /_admin/tools-stalled).
      try {
        this.platform.recoverStall();
      } catch (e) {
        console.log(`[${new Date().toISOString()}] couldn't clear what was running when Hewn stopped: ${(e as Error).message}`);
      }
      // Not awaited: retried builds run in the background.
      void this.platform.recoverInterruptedBuilds().then(() => this.platform.cleanup());
    });
  }

  /** A tool call's callback, from the tools process (ToolCalls): answered while that call runs, refused after. */
  async toolCallback(token: string, kind: CallbackKind, body: unknown): Promise<{ result?: unknown; error?: string; code?: string; refused?: boolean }> {
    this.idleGc.work();
    const running = this.toolCalls.get(token);
    if (!running || running.over) return { error: "this call isn't running", refused: true };
    // Waiting on Hewn meanwhile: not the code that holds the tools, if they stop responding.
    running.waiting++;
    try {
      if (kind === "call") return { result: await running.call(body as Callbacks["call"]) };
      if (!running.model) throw new PlatformError("forbidden", "this call has no model");
      return { result: await running.model(body as GenerateRequest) };
    } catch (e) {
      const code = (e as PlatformError).code;
      return { error: (e as Error).message, ...(typeof code === "string" ? { code } : {}) };
    } finally {
      running.waiting--;
    }
  }

  /** Egress's mark (ToolCalls): a fetch out of a tool isolate went out (1) or is over (-1). */
  async toolsFetch(mark: EgressMark): Promise<void> {
    const n = (this.fetchesOut.get(mark.isolate) ?? 0) + (mark.delta > 0 ? 1 : -1);
    if (n > 0) this.fetchesOut.set(mark.isolate, n);
    else this.fetchesOut.delete(mark.isolate);
  }

  /** How big a capability's states may grow, in bytes: its limit, or 0 while the disk is nearly full. */
  private dataLimit(capabilityId: string): number {
    return this.diskLow ? 0 : toolDataLimitMB(this.settings(), capabilityId) * MB;
  }

  /** The hosts the tool's calls run with (as invocation resolves them), when `code` is its active version. */
  private liveHosts(capabilityId: string, code: CodeRef): string[] | null {
    const registry = this.platform.registry;
    const active = registry.getCapability(capabilityId)?.activeVersion;
    const version = active ? registry.getVersion(capabilityId, active) : undefined;
    return version && version.contentHash === code.hash ? resolveHosts(version.manifest, registry.config(capabilityId)) : null;
  }

  /** What a call that needed more room than `limit` gives fails with; the owner's log says so too. */
  private dataFull(capabilityId: string, limit: number): string {
    const name = this.platform.registry.getCapability(capabilityId)?.name ?? capabilityId;
    const message = limit
      ? `${name}'s data is at its ${sizeText(limit)} limit, so it can't save more. The limit is in Settings › Data.`
      : `${name} can't save more: the disk with Hewn's data has less than ${sizeText(this.diskLow?.floor ?? 1024 * MB)} free.`;
    console.log(`[${new Date().toISOString()}] ${capabilityId}: ${message}`);
    return message;
  }

  /** One DO alarm for the next due schedule (re-armed whenever that may change). */
  private async armAlarm() {
    const next = this.platform.nextScheduleAt();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  /** The alarm's work, one pass at a time (the alarm and a resume can both ask for it). */
  private catchingUp: Promise<void> = Promise.resolve();

  async alarm() {
    this.idleGc.work();
    const pass = this.catchingUp.then(async () => {
      await this.platform.runDueSchedules();
      await this.secrets.flush();
      await this.armAlarm();
    });
    this.catchingUp = pass.catch(() => {});
    return pass;
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
    for (const k of ["builder", "intake", "maxBuildAttempts", "sandbox", "firstRunDone", "logRetentionDays", "timeZone", "jobsChosen", "jobModels", "agentModels", "buildPasses", "toolDataLimitMB", "toolDataLimitsMB"] as const)
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
        const svc = kind === "web" ? env.ASSETS_WEB : kind === "platform-ui" ? env.ASSETS_UI : kind === "docs" ? env.ASSETS_DOCS : kind === "spec" ? env.ASSETS_SPEC : undefined;
        if (!svc || rest.some((p) => p === ".." || p === "")) return undefined;
        // Of the docs, only the pages themselves: not docs/internal/ or the spec's sources.
        if ((kind === "docs" || kind === "spec") && !DOC_NAME.test(rest.join("/"))) return undefined;
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
      modelCatalog: (agent, fresh) => sv.json<ModelCatalog>("/models/catalog", { agent, ...(fresh ? { fresh: true } : {}) }),
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
      // The release's Official shelf: the supervisor reads seeds/ (kept a while: it changes only with the release).
      shelf: {
        tools: async () => {
          shelfCache ??= sv.json<{ tools: (Omit<ShelfTool, "files"> & { files: Record<string, string> })[]; firstRun: string[] }>("/shelf/tools", {}).then((r) => ({ firstRun: r.firstRun, tools: r.tools.map((t) => ({ ...t, files: Object.fromEntries(Object.entries(t.files).map(([p, b]) => [p, fromBase64(b)])) })) }));
          return shelfCache.catch((e) => ((shelfCache = undefined), Promise.reject(e)));
        },
        image: async (id, name) => {
          const r = await sv.json<{ data: string | null }>("/shelf/image", { id, name });
          return r.data ? fromBase64(r.data) : undefined;
        },
      },
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
    const admin = url.pathname.startsWith("/_admin/");
    // For the idle GC, a request is background as it comes and as it's answered (one the idle report counts is work
    // there too); the watchdog's /health is neither, and admin() tells the CLI's work from the supervisor's ticks.
    const background = !admin && url.pathname !== "/health";
    if (background) this.idleGc.background();
    const res = admin ? await this.admin(request, url) : await handle(this.platform, this.sessions, this.surfaceHost(), request);
    // Secret writes are durable before the answer goes out. (Calls that refresh a secret run
    // inside these requests too.)
    await this.secrets.flush();
    if (background) this.idleGc.background();
    return res;
  }

  /** The supervisor's channel: CLI actions as the owner (open, init, install, status). */
  private async admin(request: Request, url: URL): Promise<Response> {
    if (!sameDigest(request.headers.get("x-hewn-admin") ?? "", this.env.ADMIN_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const body: any = request.method === "POST" ? await request.json() : {};
    if (!tickCall(url.pathname, body)) this.idleGc.work();
    // The idle report: what the CLI changes, a backup should keep (a tool call counts itself).
    if (request.method === "POST" && adminChanges(url.pathname, body)) this.platform.activity.changed();
    try {
      switch (url.pathname) {
        case "/_admin/resumed":
          // The supervisor saw the wall clock jump (a suspended machine woke), or a schedule's time come by it: run
          // what became due, re-arm the alarm.
          await this.alarm();
          return Response.json({ ok: true, nextAlarmAt: this.platform.nextScheduleAt() });
        case "/_admin/changed":
          // A restore swapped the data in (adminChanges counts it).
          return Response.json({ ok: true });
        case "/_admin/idle-gc":
          // The supervisor's tick (tests shorten the times).
          return Response.json(this.idleGc.collectIfQuiet(this.platform.idleActivity(), this.toolCalls.size > 0, { quietMs: Number.isFinite(body.quietMs) ? body.quietMs : IDLE_GC_QUIET_MS, backgroundEveryMs: Number.isFinite(body.backgroundEveryMs) ? body.backgroundEveryMs : IDLE_GC_BACKGROUND_EVERY_MS }));
        case "/_admin/disk":
          // The supervisor checks the disk with Hewn's data: while it's nearly full, tools' data doesn't grow.
          this.diskLow = body.low === true ? { floor: Number.isFinite(body.floor) ? body.floor : 1024 * MB } : null;
          return Response.json({ ok: true });
        case "/_admin/tools-stalled": {
          // The supervisor's watchdog: the tools process stopped responding, and is restarted once this answers.
          // What was running there is told so now (only the tools whose code may have held it, when that can be
          // told); it fails as the process goes.
          const at = Date.parse(String(body.at));
          const { suspects, role } = stallRoles([...this.toolCalls.values()], this.fetchesOut, this.toolsOtherWork.running);
          this.toolsStall = { at, why: String(body.why ?? "they stopped responding"), ...(suspects ? { suspects } : {}) };
          this.toolsGoneAt = Math.max(this.toolsGoneAt, at);
          return Response.json({ ok: true, ...this.platform.recoverStall(String(body.at), role) });
        }
        case "/_admin/tools-gone":
          // The supervisor: the tools process exited; calls wait until a new one answers.
          this.toolsGoneAt = Date.now();
          return Response.json({ ok: true });
        case "/_admin/tools-back":
          // The supervisor: a new tools process answers. Nothing of the old one's fetches is out any more.
          this.toolsBackAt = Date.now();
          this.fetchesOut.clear();
          return Response.json({ ok: true });
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
          // A shared tool's file or link (hewn install <file.hewn.zip | https://…>): staged, then installed under its name (or the given one), with its sample data unless told not to.
          if (body.bundle || body.url) {
            const fetched = body.url ? await fetchLink(String(body.url)) : null;
            const preview = await this.platform.stageBundle(USER, fetched ? fetched.bytes : fromBase64(body.bundle), fetched ? fetched.origin : { from: "file" });
            const started = await this.platform.installBundle(USER, preview.token, { name: body.name ?? preview.suggestedName, sample: body.sample !== false });
            return Response.json(body.wait ? await this.platform.settle(started.buildId) : started);
          }
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
          // Test hook: make a schedule due now (the alarm fires it; `arm: false`, as if the alarm didn't: a resume runs it).
          this.platform.schedules.update(body.id, { nextRunAt: Date.now() });
          if (body.arm !== false) await this.armAlarm();
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
        case "/_admin/data":
          return Response.json(await this.platform.dataSummary(USER, body.capabilityId));
        // hewn share: the check (with findings), and the file unless it's blocked.
        case "/_admin/share": {
          const check = await this.platform.shareCheck(USER, body.capabilityId, body.version);
          if (check.blocked || body.check) return Response.json({ check });
          const { name, bundle } = await this.platform.shareBundle(USER, body.capabilityId, body.version);
          return Response.json({ check, name, bundle: toBase64(bundle) });
        }
        // hewn data reset: Start over.
        case "/_admin/start-over":
          return Response.json(await this.platform.startOver(USER, body.capabilityId, { confirm: body.confirm, sample: !!body.sample }));
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

/** Admin routes that change nothing a backup keeps (`/_admin/invoke` counts its own writes). */
const ADMIN_READS = new Set(["/_admin/visual-invoke", "/_admin/web-ticket", "/_admin/status", "/_admin/invoke", "/_admin/readiness", "/_admin/logs", "/_admin/export", "/_admin/data", "/_admin/share", "/_admin/resumed", "/_admin/disk", "/_admin/tools-gone", "/_admin/tools-back", "/_admin/idle-gc"]);

/** Whether an admin request changes what a backup keeps (the idle report's backup reason). */
function adminChanges(path: string, body: any): boolean {
  if (path === "/_admin/call") return !!ADMIN_CALLS[body.method]?.changes;
  // Without an id or a new schedule's capability and cadence, it lists them.
  if (path === "/_admin/schedules") return !!(body.id || (body.capabilityId && body.cadence));
  return !ADMIN_READS.has(path);
}

/**
 * Core methods the CLI may call over the admin channel; `owner`: the first argument is the owner; `changes`: it
 * changes what a backup keeps (the idle report's backup reason).
 */
const ADMIN_CALLS: Record<string, { owner: boolean; changes?: boolean }> = {
  list: { owner: true }, get: { owner: true }, authorization: { owner: false }, readiness: { owner: false },
  setSecret: { owner: true, changes: true }, deleteSecret: { owner: true, changes: true }, setConfig: { owner: true, changes: true }, connect: { owner: true, changes: true }, accounts: { owner: true }, approveGrants: { owner: true, changes: true }, approveGrant: { owner: true, changes: true }, revokeGrant: { owner: true, changes: true }, declineGrant: { owner: true, changes: true },
  archive: { owner: true, changes: true }, restore: { owner: true, changes: true }, resume: { owner: true, changes: true }, archived: { owner: true }, rollback: { owner: true, changes: true }, exportData: { owner: true }, importData: { owner: true, changes: true }, purge: { owner: true, changes: true }, startOver: { owner: true, changes: true },
  logLines: { owner: false }, getBuild: { owner: true }, retryBuild: { owner: true }, cancelBuild: { owner: true },
  buildsInReview: { owner: true }, approveBuild: { owner: true }, rejectBuild: { owner: true },
  buildReport: { owner: true },
  cleanup: { owner: false },
  listSchedules: { owner: true }, createSchedule: { owner: true, changes: true }, updateSchedule: { owner: true, changes: true }, deleteSchedule: { owner: true, changes: true },
  createWebTicket: { owner: true }, createUiTicket: { owner: false }, publicUrl: { owner: false }, setPublicUrl: { owner: true, changes: true }, passkeys: { owner: true }, removePasskey: { owner: true, changes: true },
  agents: { owner: true }, updateAgent: { owner: true, changes: true }, pendingAgents: { owner: true }, decideAgent: { owner: true, changes: true }, unreadableSecrets: { owner: true },
  capabilityAgents: { owner: true }, setCapabilityAgent: { owner: true, changes: true },
  confirmations: { owner: true }, decideConfirmation: { owner: true },
  models: { owner: true }, setModelSettings: { owner: true, changes: true }, setModelKey: { owner: true, changes: true }, checkModelProvider: { owner: true }, replacePinnedModel: { owner: true }, setCapabilityModel: { owner: true }, modelSpend: { owner: true }, refreshModelCatalog: { owner: false },
  metrics: { owner: true }, idleActivity: { owner: false }, nextScheduleAt: { owner: false },
};
