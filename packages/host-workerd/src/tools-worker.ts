// SPDX-License-Identifier: AGPL-3.0-or-later
// The tools' workerd. Hewn runs the platform and the tools in separate processes: this one holds every
// tool's CapabilityHost (its states, its code's isolates) and Egress, and nothing of the owner's (no
// secrets key, no platform data, no blobs). The platform calls it over a Unix socket in the data dir
// (tools-channel.ts), with this process's token; a call's callbacks go back with that call's token.
//   - default fetch: the channel (one route per CapabilityHost method), and /health
//   - CapabilityHost: one DO per capability; runs versions as facets (private SQLite each)
//   - Egress: the Dynamic Workers' globalOutbound, allowing only declared, granted hosts
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { GenerateRequest, GenerateResult } from "@hewntools/core/models.ts";
import type { Migration } from "@hewntools/core/migrations.ts";
import type { CodeRef } from "@hewntools/core/ports.ts";
import { sameDigest } from "@hewntools/core/sha256.ts";
import { gatedFetch } from "./egress.ts";
import { CALL_TOKEN_HEADER, type CallbackKind, type Callbacks, CODES_KEPT, HOST_METHODS, type HostCalls, type HostMethod, ISOLATE_HEADER, type SentCode, STARTED_HEADER, TOOLS_TOKEN_HEADER } from "./tools-channel.ts";
// Text modules, embedded by the supervisor's config.
// @ts-expect-error text module
import RUNTIME from "./capability-runtime.js";
// @ts-expect-error text module
import GUARD from "./capability-guard.js";

interface Env {
  CAPS: DurableObjectNamespace;
  LOADER: WorkerLoader;
  /** The platform's socket for a running call's callbacks. */
  PLATFORM: Fetcher;
  /** Authenticates the platform's calls to this process. */
  TOOLS_TOKEN: string;
}

const COMPAT_DATE = "2026-09-01";

// ---------- the channel: the platform's calls ----------

/** Bundles by hash: the platform sends a bundle's text once, then its hash (the oldest go first past CODES_KEPT). */
const codes = new Map<string, string>();

function codeOf(sent: SentCode): CodeRef | undefined {
  if (typeof sent.js === "string") {
    codes.delete(sent.hash);
    codes.set(sent.hash, sent.js);
    while (codes.size > CODES_KEPT) codes.delete(codes.keys().next().value!);
    return { hash: sent.hash, js: sent.js };
  }
  const js = codes.get(sent.hash);
  return js === undefined ? undefined : { hash: sent.hash, js };
}

/** A running call's callbacks: back to the platform, with that call's token. */
function callback<K extends CallbackKind>(env: Env, token: string, kind: K, body: Callbacks[K]): Promise<unknown> {
  return env.PLATFORM.fetch(`http://platform/${kind}`, { method: "POST", headers: { [CALL_TOKEN_HEADER]: token, "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (res) => {
    const out = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { result?: unknown; error?: string; code?: string };
    if (!res.ok || out.error !== undefined) throw Object.assign(new Error(out.error ?? `HTTP ${res.status}`), out.code ? { code: out.code } : {});
    return out.result;
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const method = new URL(request.url).pathname.slice(1) as HostMethod;
    if (method === ("health" as HostMethod)) return new Response("ok");
    if (request.method !== "POST" || !HOST_METHODS.includes(method)) return Response.json({ error: "not_found" }, { status: 404 });
    if (!sameDigest(request.headers.get(TOOLS_TOKEN_HEADER) ?? "", env.TOOLS_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = (await request.json()) as { capabilityId: string; code?: SentCode } & Record<string, any>;
    let code: CodeRef | undefined;
    if (body.code) {
      code = codeOf(body.code);
      if (!code) return Response.json({ missing: body.code.hash }, { status: 409 });
    }
    const host = env.CAPS.get(env.CAPS.idFromName(body.capabilityId)) as unknown as CapabilityHost;
    if (method === "invoke") {
      // Its headers go now, the result after: the platform knows the call started here (one queued behind a tool
      // that never yields doesn't), and in which isolate (whose fetches Egress tells it about).
      const c = body as unknown as HostCalls["invoke"];
      const reply = new TransformStream<Uint8Array, Uint8Array>();
      const writer = reply.writable.getWriter();
      const done = Promise.resolve()
        .then(() => run(env, host, method, body, code!))
        .then((result) => ({ result: result ?? null }), (e: Error) => ({ error: e.message }))
        .then(async (out) => {
          await writer.write(new TextEncoder().encode(JSON.stringify(out)));
          await writer.close();
        });
      ctx.waitUntil(done);
      return new Response(reply.readable, { headers: { "content-type": "application/json", [STARTED_HEADER]: "1", [ISOLATE_HEADER]: isolateKey(code!.hash, c.hosts, c.limit, c.named) } });
    }
    try {
      return Response.json({ result: (await run(env, host, method, body, code!)) ?? null });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  },
};

/** The key of the isolate that runs `hash` with these hosts and limit (CapabilityHost.worker); `named`: the live tool's own. */
const isolateKey = (hash: string, hosts: string[], limit: number, named: boolean) => `${hash}|${hosts.join(",")}|${limitBytes(limit)}${named ? "" : "|unnamed"}`;

/** Tell the platform a fetch of the tools in `isolate` went out (1) or came back (-1): their code waits on the network meanwhile. */
const egressMark = (env: Env, isolate: string, delta: 1 | -1) =>
  env.PLATFORM.fetch("http://platform/egress", { method: "POST", headers: { [TOOLS_TOKEN_HEADER]: env.TOOLS_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ isolate, delta }) }).then(
    (r) => r.body?.cancel(),
    () => {},
  );

function run(env: Env, host: CapabilityHost, method: HostMethod, b: any, code: CodeRef): Promise<unknown> | unknown {
  switch (method) {
    case "invoke": {
      const c = b as HostCalls["invoke"];
      const call = (capabilityId: string, operation: string, input: unknown) => callback(env, c.call, "call", { capabilityId, operation, input });
      const model = c.model ? (req: GenerateRequest) => callback(env, c.call, "model", req) as Promise<GenerateResult> : null;
      return host.invoke(code, c.scratch, c.key, c.input, c.secrets, c.hosts, c.caller, call, c.config, model, c.readOnly, c.limit, c.named);
    }
    case "stop":
      return host.stop(b.scratch, b.reason);
    case "describe":
      return host.describe(code);
    case "migrate":
      return host.migrate(b.scratch, b.migrations, code, b.limit, b.hosts, b.named);
    case "dump":
      return host.dump(b.scratch, code, b.limit, b.hosts, b.named);
    case "count":
      return host.count(b.scratch, code, b.limit, b.hosts, b.named);
    case "load":
      return host.load(b.scratch, b.tables, code, b.limit, b.hosts, b.named);
    case "hasState":
      return host.hasState(b.scratch);
    case "copyState":
      return host.copyState(b.from, b.to);
    case "dropState":
      return host.dropState(b.scratch);
    case "listStates":
      return host.listStates(b.prefix);
  }
}

// ---------- CapabilityHost: one per capability ----------

/** A capability's states are facets of its host: "live", or "s:<scratch name>". */
const LIVE = "live";
const facetName = (scratch: string | null) => (scratch ? `s:${scratch}` : LIVE);

/** A state's size limit in bytes, as its isolate's code carries it (0: not at all). */
const limitBytes = (limit: number) => (Number.isSafeInteger(limit) && limit > 0 ? limit : 0);

export class CapabilityHost extends DurableObject<Env> {
  /** Which loaded code each running facet was started with. */
  private running = new Map<string, string>();
  /** The isolates a build's states run, by code: each kept until every state that ran it is dropped (the build is done with them). */
  private buildIsolates = new Map<string, { stub: WorkerStub; states: Set<string> }>();
  /** Calls (and other work) in progress on each facet. */
  private busy = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS states (name TEXT PRIMARY KEY)");
  }

  /**
   * Stop a state's code: whatever it has running (awaits, timers, writes) ends, and calls in progress
   * on it fail with `reason`. Its data stays; the next call starts it afresh. How a tool's code is
   * stopped is this host's business: code in a process of its own would be stopped by ending that.
   */
  stop(scratch: string | null, reason: string) {
    this.halt(facetName(scratch), reason);
  }

  private halt(name: string, reason: string) {
    if (this.running.has(name)) this.ctx.facets.abort(name, new Error(reason));
    this.running.delete(name);
  }

  /**
   * Work on a facet. When the last piece of work on it ends, the facet is stopped, so nothing a call
   * leaves behind (a timer, a promise it didn't await) runs on after it.
   */
  private async on<T>(scratch: string | null, code: CodeRef, hosts: string[], named: boolean, limit: number, work: (facet: any) => Promise<T>): Promise<T> {
    const name = facetName(scratch);
    const facet = this.facet(scratch, code, hosts, named, limit);
    this.busy.set(name, (this.busy.get(name) ?? 0) + 1);
    try {
      return await work(facet);
    } finally {
      const left = this.busy.get(name)! - 1;
      if (left > 0) this.busy.set(name, left);
      else {
        this.busy.delete(name);
        this.halt(name, "finished");
      }
    }
  }

  /**
   * The code for `code`'s isolate with these hosts and this size limit (bytes) for each state it runs.
   * "experimental" is for the limit's setter, sql.setMaxPageCountForTest: hewn-guard.js
   * (capability-guard.ts) takes it, with what else the flag adds to storage, out of the
   * capability's reach before its code can use any.
   */
  private workerCode(code: CodeRef, hosts: string[], bytes: number, key: string): WorkerLoaderWorkerCode {
    return {
      compatibilityDate: COMPAT_DATE,
      compatibilityFlags: ["nodejs_compat", "experimental"],
      allowExperimental: true,
      mainModule: "hewn-runtime.js",
      modules: { "hewn-runtime.js": RUNTIME, "hewn-guard.js": GUARD, "hewn-limit.js": `export default ${bytes};`, "capability.js": code.js },
      env: {},
      globalOutbound: (this.ctx as any).exports.Egress({ props: { hosts, isolate: key } }),
    };
  }

  /**
   * The isolate a state runs `code` in. workerd keeps a named isolate until it restarts, so only the
   * live tool's own (`named`: its active version, with its calls' hosts) is named: one per tool
   * version, its calls and data ops alike. Anything else gets an unnamed one, which goes once nothing
   * holds it: a build's states share one per code until they're dropped; on the live state (code
   * going live, sample data replayed) it's held only while it runs.
   */
  private worker(name: string, code: CodeRef, hosts: string[], named: boolean, limit: number) {
    const bytes = limitBytes(limit);
    const key = isolateKey(code.hash, hosts, limit, named);
    if (named) return { key, stub: this.env.LOADER.get(key, () => this.workerCode(code, hosts, bytes, key)) };
    if (name === LIVE) return { key, stub: this.env.LOADER.load(this.workerCode(code, hosts, bytes, key)) };
    let entry = this.buildIsolates.get(key);
    if (!entry) this.buildIsolates.set(key, (entry = { stub: this.env.LOADER.load(this.workerCode(code, hosts, bytes, key)), states: new Set() }));
    entry.states.add(name);
    return { key, stub: entry.stub };
  }

  /** The facet for a state, running `code` with `limit` (restarted if it was running other code or another limit). */
  private facet(scratch: string | null, code: CodeRef, hosts: string[], named: boolean, limit: number) {
    const name = facetName(scratch);
    const w = this.worker(name, code, hosts, named, limit);
    if (this.running.has(name) && this.running.get(name) !== w.key) this.ctx.facets.abort(name, new Error("new version"));
    this.running.set(name, w.key);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO states (name) VALUES (?)", name);
    return this.ctx.facets.get(name, () => ({ class: w.stub.getDurableObjectClass("Capability") })) as any;
  }

  // `limit`: how big the state may grow, in bytes (0: not at all; workerdRuntime passes the owner's).
  // `named`: the live tool's own isolate (see `worker`).
  async invoke(code: CodeRef, scratch: string | null, key: string, input: unknown, secrets: Record<string, string>, hosts: string[], caller: { kind: string; id: string } | undefined, call: (capabilityId: string, operation: string, input: unknown) => Promise<unknown>, config: Record<string, string> = {}, model: ((req: GenerateRequest) => Promise<GenerateResult>) | null = null, readOnly = false, limit = 0, named = false) {
    return this.on(scratch, code, hosts, named, limit, (f) => f.invoke(key, input, secrets, caller, call, config, model, readOnly));
  }

  // Validation's: an unnamed isolate, gone once described (it opens no state, so no limit).
  async describe(code: CodeRef): Promise<string[]> {
    return (this.env.LOADER.load(this.workerCode(code, [], 0, isolateKey(code.hash, [], 0, false))).getEntrypoint() as any).describe();
  }

  // The data ops' `hosts` and `named`: the tool's calls', when this is the live tool (see `worker`).
  async migrate(scratch: string | null, migrations: Migration[], code: CodeRef, limit = 0, hosts: string[] = [], named = false): Promise<string[]> {
    return this.on(scratch, code, hosts, named, limit, (f) => f.migrate(migrations));
  }

  async dump(scratch: string | null, code: CodeRef, limit = 0, hosts: string[] = [], named = false) {
    return this.on(scratch, code, hosts, named, limit, (f) => f.dump());
  }

  async count(scratch: string | null, code: CodeRef, limit = 0, hosts: string[] = [], named = false): Promise<Record<string, number>> {
    return this.on(scratch, code, hosts, named, limit, (f) => f.count());
  }

  async load(scratch: string | null, tables: Record<string, Record<string, unknown>[]>, code: CodeRef, limit = 0, hosts: string[] = [], named = false): Promise<number> {
    return this.on(scratch, code, hosts, named, limit, (f) => f.load(tables));
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
    this.halt(name, "dropped");
    for (const [key, entry] of this.buildIsolates) if (entry.states.delete(name) && !entry.states.size) this.buildIsolates.delete(key);
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

export class Egress extends WorkerEntrypoint<Env, { hosts: string[]; isolate?: string }> {
  async fetch(request: Request): Promise<Response> {
    // While a tool's fetch is out, its code waits on the network: the platform is told (before it goes, and once it's
    // back), so a tool waiting on a fetch isn't the one blamed when the tools stop responding.
    const isolate = this.ctx.props.isolate;
    if (isolate) await egressMark(this.env, isolate, 1);
    try {
      return await gatedFetch(request, this.ctx.props.hosts ?? []);
    } finally {
      if (isolate) await egressMark(this.env, isolate, -1);
    }
  }
}
