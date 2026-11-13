// SPDX-License-Identifier: AGPL-3.0-or-later
// What workerd's "experimental" flag gives a tool's code, on the pinned workerd. Tool isolates have the flag for
// the size limit of their data (capability-guard.ts), and the guard takes away what the flag adds. A tool's isolate
// as Hewn starts it (its flags, the guard) is compared with one started as before the limit (nodejs_compat only):
// every global, the state's own objects (ctx, storage, sql, a cursor, its entrypoint's Fetcher and context) and
// what each builtin module exports. A workerd whose flag adds something else fails here, with what it adds.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { workerdBinary } from "@hewntools/cli/app-dir.ts";
import { buildHostFiles } from "@hewntools/cli/supervisor/bundle.ts";
import { freePort } from "./workerd-helpers.ts";

/**
 * What tool code sees with the flag and the guard that it doesn't see without them: one method on the context of its
 * own entrypoint. mapVirtualHost routes a host name to a Fetcher, and the only Fetchers a tool holds are its own.
 */
const ADDED = [
  "entrypointCtx^.constructor.prototype.mapVirtualHost",
  "entrypointCtx^.mapVirtualHost",
  "entrypointCtx^.mapVirtualHost.length",
  "entrypointCtx^.mapVirtualHost.name",
];
/** And what it no longer sees: nested facets, and deleteAll (the guard's own, flag or not). */
const REMOVED = [
  "ctx.facets",
  "ctx.facets^.Symbol(Symbol.toStringTag)",
  "ctx.facets^.Symbol(cloudflare:internal-class)",
  "ctx.facets^.Symbol(kResourceTypeInspect)",
  "ctx.facets^.abort",
  "ctx.facets^.clone",
  "ctx.facets^.constructor",
  "ctx.facets^.delete",
  "ctx.facets^.get",
  "ctx.storage^.deleteAll",
  "storage^.constructor.prototype.deleteAll",
  "storage^.deleteAll",
  "storage^.deleteAll.length",
  "storage^.deleteAll.name",
];

// The tool's side: the guard runs as in capability-main.ts, then everything reachable is listed.
const PROBE = `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { lockStorage } from "./hewn-guard.js";
import MODULES from "./modules.js";
const objectish = (v) => v !== null && (typeof v === "object" || typeof v === "function");
function* levels(o) {
  for (let p = o, i = 0; p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p), i++) yield [p, "^".repeat(i)];
}
// Every key on a root and its prototypes, and on the objects and classes those hold (one level down).
function surface(roots) {
  const out = new Set();
  const add = (o, label) => { for (const [p, up] of levels(o)) for (const k of Reflect.ownKeys(p)) out.add(label + up + "." + String(k)); };
  for (const [label, root] of roots) {
    add(root, label);
    for (const [p, up] of levels(root)) for (const k of Reflect.ownKeys(p)) {
      let v;
      try { v = Reflect.get(p, k, root); } catch { continue; }
      if (!objectish(v) || v === root) continue;
      add(v, label + up + "." + String(k));
      if (typeof v === "function" && objectish(v.prototype)) add(v.prototype, label + up + "." + String(k) + ".prototype");
    }
  }
  return [...out];
}
export class Probe extends DurableObject {
  constructor(ctx, env) {
    lockStorage(ctx);
    super(ctx, env);
  }
  async surface() {
    const { storage } = this.ctx;
    const roots = [["globalThis", globalThis], ["ctx", this.ctx], ["storage", storage], ["sql", storage.sql], ["cursor", storage.sql.exec("SELECT 0")], ["fetcher", this.ctx.exports.default], ["signal", new AbortController().signal]];
    const modules = [];
    for (const m of MODULES) {
      let ns;
      try { ns = await import(m); } catch { continue; }
      for (const k of Object.keys(ns)) modules.push(m + ":" + k);
    }
    return [...surface(roots), ...(await this.ctx.exports.default.surface()), ...modules].sort();
  }
}
export default class extends WorkerEntrypoint {
  surface() {
    return surface([["entrypointCtx", this.ctx]]);
  }
}
`;

const MODULES = [
  ...builtinModules.filter((m) => !m.startsWith("_")).map((m) => (m.startsWith("node:") ? m : `node:${m}`)),
  ...["sockets", "workers", "email", "workflows", "pipelines", "node"].map((m) => `cloudflare:${m}`),
  ...["fuzzilli", "stdin", "unsafe", "unsafe-eval"].map((m) => `workerd:${m}`),
];

let dir: string;
let child: ChildProcess | undefined;
const surfaces: { before?: string[]; now?: string[] } = {};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "hewn-experimental-"));
  mkdirSync(join(dir, "do"));
  // The tool isolates' compatibility date and flags, as worker.ts starts them.
  const worker = readFileSync(join(import.meta.dirname, "..", "packages", "host-workerd", "src", "worker.ts"), "utf8");
  const date = /const COMPAT_DATE = "([^"]+)"/.exec(worker)![1];
  const flags = JSON.parse(/compatibilityFlags: (\["nodejs_compat"[^\]]*\]),\s*allowExperimental: true/.exec(worker)![1]) as string[];
  assert.ok(flags.includes("experimental"), flags.join(", "));
  const guard = (await buildHostFiles())["capability-guard.js"];
  writeFileSync(
    join(dir, "main.js"),
    `import { DurableObject } from "cloudflare:workers";
const NOW = ${JSON.stringify({ date, flags, guard, probe: PROBE, modules: MODULES })};
export class Host extends DurableObject {
  async fetch(req) {
    const now = new URL(req.url).pathname === "/now";
    const key = now ? "now" : "before";
    const worker = this.env.LOADER.get(key, () => ({
      compatibilityDate: NOW.date,
      compatibilityFlags: now ? NOW.flags : ["nodejs_compat"],
      allowExperimental: now,
      mainModule: "probe.js",
      modules: { "probe.js": NOW.probe, "hewn-guard.js": now ? NOW.guard : "export function lockStorage() {}", "hewn-limit.js": "export default 1048576;", "modules.js": "export default " + JSON.stringify(NOW.modules) + ";" },
      env: {},
      globalOutbound: null,
    }));
    const probe = this.ctx.facets.get(key, () => ({ class: worker.getDurableObjectClass("Probe") }));
    return Response.json(await probe.surface());
  }
}
export default { fetch: (req, env) => env.HOST.get(env.HOST.idFromName("host")).fetch(req) };
`,
  );
  const port = await freePort();
  writeFileSync(
    join(dir, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .host), (name = "do", disk = (path = ${JSON.stringify(join(dir, "do"))}, writable = true)) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const host :Workerd.Worker = (
  modules = [ (name = "main.js", esModule = embed "main.js") ],
  compatibilityDate = ${JSON.stringify(date)},
  compatibilityFlags = ["experimental"],
  durableObjectNamespaces = [ (className = "Host", uniqueKey = "host", enableSql = true) ],
  durableObjectStorage = (localDisk = "do"),
  bindings = [ (name = "HOST", durableObjectNamespace = "Host"), (name = "LOADER", workerLoader = (id = "tools")) ],
);
`,
  );
  child = spawn(workerdBinary(), ["serve", "--experimental", join(dir, "config.capnp")], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (b: Buffer) => void (stderr += b));
  for (const which of ["before", "now"] as const) {
    for (let i = 0; ; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/${which}`).catch(() => undefined);
      if (res?.ok) {
        surfaces[which] = (await res.json()) as string[];
        break;
      }
      if (res || i > 100) throw new Error(`${which}: ${res ? `${res.status} ${await res.text()}` : "workerd didn't start"}\n${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("the experimental flag gives a tool's code nothing the guard doesn't take away, but one method on its own entrypoint's context", () => {
  const before = new Set(surfaces.before), now = new Set(surfaces.now);
  // The probe really looked: globals, storage, builtin modules.
  for (const k of ["globalThis^.fetch", "sql^.exec", "cursor^.toArray", "node:buffer:Buffer", "cloudflare:sockets:connect"]) assert.ok(before.has(k) && now.has(k), k);
  const added = [...now].filter((k) => !before.has(k)).sort();
  const removed = [...before].filter((k) => !now.has(k)).sort();
  assert.deepEqual({ added, removed }, { added: ADDED, removed: REMOVED });
});
