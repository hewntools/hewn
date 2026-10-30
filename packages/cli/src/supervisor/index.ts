// SPDX-License-Identifier: AGPL-3.0-or-later
// The supervisor: runs workerd (the Hewn host) and does what an isolate can't: builders,
// bundling, intake, connecting local agents, deleting blobs. It also keeps workerd alive: a
// capability stuck in a CPU loop blocks the whole (single-threaded) workerd, so a stalled
// /health is answered by a restart.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, platform as osPlatform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityBuilder } from "../builders/types.ts";
import { toBase64, fromBase64 } from "@hewntools/core/files.ts";
import { checkFromJson } from "@hewntools/core/checks.ts";
import type { CheckResult } from "@hewntools/core/ports.ts";
import type { Home } from "../home.ts";
import { localWorkbench } from "../workbench.ts";
import type { Intake } from "../intake.ts";
import type { SetupHooks } from "../setup/hooks.ts";
import { connectHarness } from "../setup/connect.ts";
import { harnessStatuses } from "../setup/harnesses.ts";
import { assetDirs, buildHost } from "./bundle.ts";
import { chromiumCheck, findBrowser } from "../visual.ts";
import { backedUpToday, backupLocation, backupNow, listBackups, restoreBackup, sameDisk } from "../backup.ts";
import { readConfig } from "../config.ts";
import { type KeySource, masterKey } from "./master-key.ts";
import { Tunnel, validTunnelConfig } from "./tunnel.ts";
import { toolStatus } from "../setup/tools.ts";
import { cliCatalogs } from "../builders/cli-agents.ts";
import { modelCatalogs } from "../builders/models.ts";
import { remoteGenerate, type RemoteJobs } from "../builders/remote.ts";
import type { Hosted, JobModel, ModelCatalog } from "@hewntools/host-workerd/surface/host.ts";
import { readShelf, shelfImage } from "../shelf.ts";
import { DATA_FORMAT, STORAGE_KEYS, VERSION } from "./format.ts";
import { workerdBinary } from "../app-dir.ts";

export interface SupervisorOptions {
  home: Home;
  port: number;
  /** The public listener tunnels point at (MCP and OAuth only). Default: port + 1. */
  publicPort?: number;
  /** An address of this machine where the public listener also answers (a reverse proxy elsewhere). */
  publicListen?: string;
  /**
   * Only requests carrying this in x-hewn-proxy-secret pass the public listener (a host behind its
   * own proxy). Default: HEWN_PROXY_SECRET; unset or "" = off.
   */
  proxySecret?: string;
  builders: Record<string, CapabilityBuilder>;
  /** The intake on agent `which`, running on `run` (the owner's model and effort for building). */
  intake?: (which: string, run: JobModel) => Intake;
  setup?: SetupHooks;
  /** Run workerd inside the OS sandbox (Seatbelt / bubblewrap). */
  sandbox?: boolean;
  /** Confine builders away from the platform home. */
  sandboxBuilders?: () => boolean;
  log?: (line: string) => void;
  /** Health check cadence and the stall that triggers a restart. */
  watchdog?: { intervalMs: number; stallMs: number } | false;
  /** Where the secrets master key lives (default: Keychain on macOS, libsecret or a file on Linux). */
  keySource?: KeySource;
  /** Builder / intake CLI status (default: checked on this machine). Tests stub it. */
  tools?: () => ReturnType<typeof toolStatus>;
  /** The browser for visual checks (default: found on this machine; "" = none, checks are skipped). */
  browser?: string;
  /** The newest release in this version's line, for Settings › About (default: none). `hewn serve` checks the release feed. */
  latest?: () => string | null;
  /** The notes of releases newer than this one, for About's upgrade card (default: none). */
  latestNotes?: () => { version: string; date?: string; items: string[] }[];
  /**
   * The host runs Hewn's builder and intake (HEWN_BUILD_URL): "remote" is a choice, and the
   * default. Its builder must also be in `builders` and its intake behind `intake("remote")`.
   */
  remote?: RemoteJobs;
  /** A host runs this Hewn for its owner (HEWN_HOSTED): see `hostedFromEnv`. */
  hosted?: Hosted;
  /** Each agent's model list (default: read from its CLI, or the remote service). Tests stub it. */
  models?: (agent: string) => Promise<ModelCatalog>;
}

export type { Hosted };

/**
 * Hosted mode (HEWN_HOSTED=1): a host runs this Hewn for its owner, who has no terminal and no
 * agents on the machine, so the host must also build (HEWN_BUILD_URL). Unset: self-hosted.
 */
export function hostedFromEnv(env: NodeJS.ProcessEnv = process.env): Hosted | undefined {
  if (!env.HEWN_HOSTED || env.HEWN_HOSTED === "0") return undefined;
  if (env.HEWN_HOSTED !== "1") throw new Error("HEWN_HOSTED must be 1 (or 0, or unset)");
  if (!env.HEWN_BUILD_URL) throw new Error("HEWN_HOSTED needs HEWN_BUILD_URL: a hosted owner has no agent on the machine to build with");
  const url = env.HEWN_HOST_SIGNIN_URL;
  if (url && !(URL.canParse(url) && new URL(url).protocol === "https:")) throw new Error("HEWN_HOST_SIGNIN_URL must be an https URL");
  return url ? { signInUrl: url } : {};
}

export interface Supervisor {
  url: string;
  adminToken: string;
  /** The CLI's channel to the supervisor itself (backups, restore, status). */
  control: { url: string; token: string };
  /** Call the admin channel (as the owner). */
  admin<T = any>(path: string, body?: unknown): Promise<T>;
  /** Where tunnels point (only MCP and OAuth answer there). */
  publicUrl: string;
  /** The public listener on the network too (`publicListen`), for a reverse proxy on another machine. */
  publicNetwork?: string;
  tunnel: Tunnel;
  restarts: () => number;
  /** Restart workerd (state is on disk; in-memory caches go). */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/** The binary itself, not the workerd package's Node launcher (a stopped launcher can orphan it). */
const workerd = () => {
  try {
    return workerdBinary();
  } catch {
    return undefined;
  }
};

/** workerd's config (capnp) for this home. Exported for tests. */
export function config(o: { dir: string; keys: typeof STORAGE_KEYS; port: number; publicPort: number; publicListen?: string; supervisorPort: number; data: string; assets: { web: string; ui: string; docs: string; spec: string } }) {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .hewn),
    (name = "blobs", disk = (path = "${o.data}/blobs", writable = true)),
    (name = "do-storage", disk = (path = "${o.data}/do", writable = true)),
    (name = "assets-web", disk = (path = "${o.assets.web}")),
    (name = "assets-ui", disk = (path = "${o.assets.ui}")),
    (name = "assets-docs", disk = (path = "${o.assets.docs}")),
    (name = "assets-spec", disk = (path = "${o.assets.spec}")),
    (name = "supervisor", external = (address = "127.0.0.1:${o.supervisorPort}", http = ())),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${o.port}", http = (), service = "main"),
    (name = "public", address = "${o.publicListen === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"}:${o.publicPort}", http = (), service = (name = "main", entrypoint = "Public")),${
      // Another address too (a LAN address for a proxy on another machine). 0.0.0.0 already
      // covers loopback, and a second socket on the same port would fail to bind.
      o.publicListen && o.publicListen !== "0.0.0.0" ? `\n    (name = "public-network", address = "${o.publicListen}:${o.publicPort}", http = (), service = (name = "main", entrypoint = "Public")),` : ""
    }
  ],
);
const hewn :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "worker.js"),
    (name = "builder-brief.md", text = embed "builder-brief.md"),
    (name = "capability-runtime.js", text = embed "capability-runtime.js"),
  ],
  compatibilityDate = "2026-09-01",
  # enable_request_signal: a request's signal aborts when its client goes (Stop in the chat stops the intake's CLI).
  compatibilityFlags = ["experimental", "enable_request_signal"],
  bindings = [
    (name = "HEWN", durableObjectNamespace = "HewnDO"),
    (name = "CAPS", durableObjectNamespace = "CapabilityHost"),
    (name = "LOADER", workerLoader = (id = "capabilities")),
    (name = "BLOBS", service = "blobs"),
    (name = "ASSETS_WEB", service = "assets-web"),
    (name = "ASSETS_UI", service = "assets-ui"),
    (name = "ASSETS_DOCS", service = "assets-docs"),
    (name = "ASSETS_SPEC", service = "assets-spec"),
    (name = "SUPERVISOR", service = "supervisor"),
    (name = "ADMIN_TOKEN", fromEnvironment = "HEWN_ADMIN_TOKEN"),
    (name = "SUPERVISOR_TOKEN", fromEnvironment = "HEWN_SUPERVISOR_TOKEN"),
    (name = "SECRETS_KEY", fromEnvironment = "HEWN_SECRETS_KEY"),
    (name = "TIMEZONE", fromEnvironment = "HEWN_TIMEZONE"),
    (name = "PROXY_SECRET", fromEnvironment = "HEWN_PROXY_SECRET"),
    (name = "REMOTE_JOBS", fromEnvironment = "HEWN_REMOTE_JOBS"),
    (name = "HOSTED", fromEnvironment = "HEWN_HOSTED"),
    (name = "HOST_SIGNIN_URL", fromEnvironment = "HEWN_HOST_SIGNIN_URL"),
    (name = "PORT", text = "${o.port}"),
    (name = "VERSION", text = "${VERSION}"),
  ],
  durableObjectNamespaces = [
    (className = "HewnDO", uniqueKey = "${o.keys.owner}", enableSql = true, preventEviction = true),
    (className = "CapabilityHost", uniqueKey = "${o.keys.capability}", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "do-storage"),
);
`;
}

/** The OS sandbox around workerd: it may read its own files and write only its data dir. */
function sandboxed(cmd: string[], o: { data: string; readable: string[] }): string[] {
  if (osPlatform() === "darwin") {
    const home = process.env.HOME!;
    const profile = `(version 1)
(allow default)
(deny file-read* (subpath "${home}"))
(allow file-read* ${o.readable.map((p) => `(subpath "${p}")`).join(" ")} (subpath "${o.data}"))
(deny file-write* (subpath "/"))
(allow file-write* (subpath "${o.data}") (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null"))
`;
    const file = join(o.data, "workerd.sb");
    writeFileSync(file, profile);
    return ["sandbox-exec", "-f", file, ...cmd];
  }
  return [
    "bwrap", "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--ro-bind-try", "/bin", "/bin",
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf", "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/hosts", "/etc/hosts", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...o.readable.flatMap((p) => ["--ro-bind", p, p]), "--bind", o.data, o.data,
    "--unshare-all", "--share-net", "--die-with-parent", ...cmd,
  ];
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export async function startSupervisor(o: SupervisorOptions): Promise<Supervisor> {
  const log = o.log ?? ((l: string) => console.error(`[${new Date().toISOString()}] ${l}`));
  const publicPort = o.publicPort ?? o.port + 1;
  const tunnel = new Tunnel(o.home, publicPort, log);
  mkdirSync(resolve(o.home.root, "workerd"), { recursive: true });
  // Real paths: the OS sandbox matches them (on macOS /tmp is /private/tmp).
  const data = realpathSync(resolve(o.home.root, "workerd"));
  for (const d of ["blobs", "do"]) mkdirSync(join(data, d), { recursive: true });
  await buildHost(data);
  const adminToken = randomBytes(24).toString("hex");
  const secretsKey = masterKey(o.home.root, o.keySource);
  log(`secrets key: ${secretsKey.source}`);
  const supervisorToken = randomBytes(24).toString("hex");
  // Never logged: only whether it's on.
  const proxySecret = o.proxySecret ?? process.env.HEWN_PROXY_SECRET ?? "";
  if (proxySecret) log("public listener: only requests from the trusted proxy (HEWN_PROXY_SECRET)");
  const controlToken = randomBytes(24).toString("hex");
  const startedAt = Date.now();
  const backupDir = () => backupLocation(o.home, readConfig(o.home).backupDir).dir;
  const models = o.models ?? modelCatalogs({ catalogs: cliCatalogs(), ...(o.remote ? { remote: { url: o.remote.url, token: o.remote.token } } : {}) });
  const workbench = localWorkbench({ root: o.home.builds, builders: o.builders, confineTo: () => (o.sandboxBuilders?.() ? o.home.root : undefined) });
  const blobRoot = join(data, "blobs");

  // ---------- the supervisor's own HTTP channel (workerd → supervisor) ----------
  const ndjson = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    return (e: unknown) => res.write(JSON.stringify(e) + "\n");
  };
  /** Builders' checks waiting for the core's answer (`${buildId}/${id}`). */
  const checks = new Map<string, { resolve: (r: CheckResult) => void; reject: (e: Error) => void }>();
  const routes: Record<string, (body: any, req: IncomingMessage, res: ServerResponse) => Promise<unknown>> = {
    "/workbench/open": async (b) => workbench.open(b.buildId, Object.fromEntries(Object.entries(b.files as Record<string, string>).map(([p, x]) => [p, fromBase64(x)]))),
    "/workbench/read": async (b) => ({ files: Object.fromEntries(Object.entries(await workbench.read(b.buildId)).map(([p, x]) => [p, toBase64(x)])) }),
    "/workbench/file": async (b) => {
      const f = await workbench.file(b.buildId, b.path);
      return { data: f ? toBase64(f) : null };
    },
    "/workbench/remove": async (b) => workbench.remove(b.buildId),
    "/workbench/bundle": async (b) => workbench.bundle(b.buildId),
    "/workbench/note": async (b) => workbench.note(b.buildId, b.line),
    "/workbench/transcript": async (b) => ({ text: (await workbench.transcript(b.buildId)) ?? null }),
    "/workbench/remove-transcript": async (b) => workbench.removeTranscript(b.buildId),
    "/workbench/build": async (b, req, res) => {
      // Streams activity; the host aborting the request cancels the builder.
      const send = ndjson(res);
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      // `check`: the core answers the builder's checks. Each goes up as an event; its result comes back on /workbench/check-result.
      const { check, ...job } = b;
      const asked = new Set<string>();
      const onCheck = (id: string) =>
        new Promise<CheckResult>((resolve, reject) => {
          const key = `${job.buildId}/${id}`;
          asked.add(key);
          checks.set(key, { resolve, reject });
          send({ check: { id } });
        });
      try {
        await workbench.build(job, { signal: abort.signal, onActivity: (activity) => send({ activity }), onModel: (model) => send({ model }), onCharge: (charge) => send({ charge }), ...(check === true ? { onCheck } : {}) });
        send({ done: true });
      } catch (e) {
        send({ error: (e as Error).message, unavailable: (e as { unavailable?: boolean }).unavailable, refused: (e as { refused?: boolean }).refused, paused: (e as { paused?: boolean }).paused, modelUnavailable: (e as { modelUnavailable?: boolean }).modelUnavailable });
      }
      for (const key of asked) checks.get(key)?.reject(new Error("the build ended")), checks.delete(key);
      res.end();
      return STREAMED;
    },
    "/workbench/check-result": async (b) => {
      const key = `${b.buildId}/${b.id}`;
      const waiting = checks.get(key);
      checks.delete(key);
      if (!waiting) return;
      if (typeof b.error === "string") waiting.reject(new Error(b.error));
      else {
        try {
          waiting.resolve(checkFromJson(b.result));
        } catch (e) {
          waiting.reject(e as Error);
        }
      }
    },
    // The Official shelf (seeds/, shipped with this release): every tool's listing and files, and a card image.
    "/shelf/tools": async () => {
      const s = readShelf();
      return { firstRun: s.firstRun, tools: s.tools.map((t) => ({ ...t, files: Object.fromEntries(Object.entries(t.files).map(([p, b]) => [p, toBase64(b)])) })) };
    },
    "/shelf/image": async (b) => {
      const png = shelfImage(String(b.id), String(b.name));
      return { data: png ? toBase64(png) : null };
    },
    "/backups/list": async () => ({ dir: backupDir(), backups: listBackups(backupDir()), sameDisk: sameDisk(o.home.root, backupDir()) }),
    "/backups/now": async () => backupNow(o.home, backupDir()),
    "/workbench/visual": async (b) => {
      // Render the candidate UI from its workspace; its API calls go back to the owner's DO.
      const browser = o.browser === undefined ? findBrowser() : o.browser || undefined;
      const check = chromiumCheck(browser);
      const r = await check({
        uiDir: join(o.home.builds, String(b.buildId), "ui"),
        manifest: b.manifest,
        ...(Array.isArray(b.widgets) ? { widgets: b.widgets } : {}),
        ...(b.measure === true ? { measure: true } : {}),
        invoke: async (body) => {
          const res = await fetch(`${url}/_admin/visual-invoke`, { method: "POST", headers: { "x-hewn-admin": adminToken, "content-type": "application/json" }, body: JSON.stringify({ buildId: b.buildId, body }) });
          return res.json();
        },
      });
      return {
        skipped: r.skipped,
        errors: r.errors,
        screenshot: r.screenshot ? toBase64(new Uint8Array(r.screenshot)) : undefined,
        screenshotDark: r.screenshotDark ? toBase64(new Uint8Array(r.screenshotDark)) : undefined,
        ...(r.shots ? { shots: r.shots.map((s) => ({ name: s.name, png: toBase64(new Uint8Array(s.png)) })) } : {}),
        ...(r.defects ? { defects: r.defects } : {}),
      };
    },
    "/blobs/delete": async (b) => {
      const p = resolve(blobRoot, String(b.key));
      if (p.startsWith(blobRoot + "/")) rmSync(p, { force: true });
    },
    "/intake": async (b, req, res) => {
      const send = ndjson(res);
      // The owner stopped it (the request closed early): stop the intake's CLI too.
      const abort = new AbortController();
      res.on("close", () => !res.writableFinished && abort.abort());
      try {
        if (!o.intake) throw new Error("intake is not configured");
        const reply = await o.intake(b.intake, b.run ?? {})(b.req, (progress) => send({ progress }), abort.signal);
        send({ reply });
      } catch (e) {
        send({ error: (e as Error).message });
      }
      res.end();
      return STREAMED;
    },
    // Hosted: a tool's model call, on the host's keys. Errors come back as data (refused, charge).
    "/models/generate": async (b, _req, res) => {
      const abort = new AbortController();
      res.on("close", () => !res.writableFinished && abort.abort());
      if (!o.hosted || !o.remote) return { error: "tools' model calls aren't run by the host here" };
      try {
        return { result: await remoteGenerate(o.remote)(b, abort.signal) };
      } catch (e) {
        const x = e as Error & { refused?: boolean; charge?: unknown; stop?: string };
        return { error: x.message, ...(x.refused ? { refused: true } : {}), ...(x.charge ? { charge: x.charge } : {}), ...(x.stop ? { stop: x.stop } : {}) };
      }
    },
    "/intake/log": async (b) => {
      const dir = join(o.home.root, "intake");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.log`), JSON.stringify(b) + "\n");
    },
    "/setup/list": async () => {
      const s = o.setup;
      if (!s) return [];
      return harnessStatuses(s.harnesses(), s.userHome);
    },
    "/tunnel/status": async () => tunnel.current(),
    // Hosted: no agents on the machine, only the host's builder.
    "/setup/tools": async () => [...(o.hosted ? [] : (o.tools ?? toolStatus)()), ...(o.remote ? [{ name: "remote", label: o.remote.label, found: true, loggedIn: true, remote: true }] : [])],
    "/models/catalog": async (b) => models(String(b.agent), b.fresh === true),
    "/status/info": async () => ({ machine: hostname().replace(/\.local$/, ""), version: VERSION, dataFormat: DATA_FORMAT, lastBackup: listBackups(backupDir())[0]?.at ?? null, backupDir: backupDir(), latest: o.latest?.() ?? null, notes: o.latestNotes?.() ?? [] }),
    "/setup/connect": async (b, req, res) => {
      const send = ndjson(res);
      const s = o.setup!;
      const h = s.harnesses().find((x) => x.agentId === b.agentId)!;
      await connectHarness(h, { url: b.mcpUrl, userHome: s.userHome }, (name, data) => send({ name, data }), { login: s.login, log });
      res.end();
      return STREAMED;
    },
  };
  // The CLI (owner, same machine) → supervisor. Separate token from workerd's.
  const control: typeof routes = {
    "/control/tunnel": async (b) => {
      if (b.action === "start") return tunnel.start(validTunnelConfig(b.tunnel));
      if (b.action === "stop") return tunnel.stop();
      return tunnel.current();
    },
    "/control/status": async () => ({
      pid: process.pid,
      workerdPid: child?.pid ?? null,
      restarts,
      upSeconds: Math.round((Date.now() - startedAt) / 1000),
      keySource: secretsKey.source,
      sandbox: !!o.sandbox,
      backups: { dir: backupDir(), last: listBackups(backupDir())[0] ?? null },
    }),
    "/control/backup": async () => backupNow(o.home, backupDir()),
    "/control/backups": async () => ({ dir: backupDir(), backups: listBackups(backupDir()) }),
    "/control/restore": async (b) => {
      // Stop workerd, swap the data in, start it again.
      await stopWorkerd();
      try {
        return restoreBackup(o.home, String(b.file));
      } finally {
        start();
        await waitHealthy();
      }
    },
  };
  const tokenOk = (presented: unknown, expected: string) => {
    const a = Buffer.from(String(presented ?? ""));
    const e = Buffer.from(expected);
    return a.length === e.length && timingSafeEqual(a, e);
  };
  const supervisorServer: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const isControl = path.startsWith("/control/");
    if (!tokenOk(isControl ? req.headers["x-hewn-control"] : req.headers["x-hewn-token"], isControl ? controlToken : supervisorToken)) return void res.writeHead(401).end();
    const route = (isControl ? control : routes)[path];
    if (!route) return void res.writeHead(404).end();
    try {
      const out = await route(await readBody(req), req, res);
      if (out !== STREAMED) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message, unavailable: (e as { unavailable?: boolean }).unavailable }));
    }
  });
  await new Promise<void>((r) => supervisorServer.listen(0, "127.0.0.1", () => r()));
  const supervisorPort = (supervisorServer.address() as AddressInfo).port;

  // ---------- workerd ----------
  writeFileSync(join(data, "config.capnp"), config({ dir: data, keys: STORAGE_KEYS, port: o.port, publicPort, publicListen: o.publicListen, supervisorPort, data, assets: assetDirs() }));
  const bin = workerd();
  if (!bin) throw new Error("the workerd runtime is missing: reinstall Hewn");
  const base = [bin, "serve", "--experimental", join(data, "config.capnp")];
  const command = o.sandbox ? sandboxed(base, { data, readable: [realpathSync(resolve(bin, "..", "..")), ...Object.values(assetDirs()).map((d) => realpathSync(d))] }) : base;
  const url = `http://127.0.0.1:${o.port}`;
  let child: ChildProcess | undefined;
  let stopping = false;
  let restarts = 0;
  let quickExits = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  // A workerd left behind by a supervisor that died (macOS has no die-with-parent) would hold the port.
  const pidFile = join(data, "workerd.pid");
  if (existsSync(pidFile)) {
    const old = Number(readFileSync(pidFile, "utf8"));
    try {
      if (old && spawnSync("ps", ["-p", String(old), "-o", "command="], { encoding: "utf8" }).stdout.includes("workerd")) {
        process.kill(old, "SIGKILL");
        log(`stopped a workerd left over from a previous run (pid ${old})`);
      }
    } catch {
      // already gone
    }
  }
  const start = () => {
    const startedAt = Date.now();
    child = spawn(command[0], command.slice(1), {
      // Run in its own data dir: workerd opens its working directory, and the sandbox only allows that.
      cwd: data,
      env: { ...process.env, PWD: data, HEWN_ADMIN_TOKEN: adminToken, HEWN_SUPERVISOR_TOKEN: supervisorToken, HEWN_SECRETS_KEY: secretsKey.key, HEWN_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone, HEWN_PROXY_SECRET: proxySecret, HEWN_REMOTE_JOBS: o.remote ? "1" : "", HEWN_HOSTED: o.hosted ? "1" : "", HEWN_HOST_SIGNIN_URL: o.hosted?.signInUrl ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    const forward = (b: Buffer) => b.toString().split("\n").filter(Boolean).forEach((l) => log(l.replace(/^\[\S+\] /, "")));
    child.stdout!.on("data", forward);
    child.stderr!.on("data", forward);
    child.on("exit", (code, signal) => {
      if (stopping) return;
      // A crash loop (e.g. a bad config) backs off instead of spinning.
      quickExits = Date.now() - startedAt < 3000 ? quickExits + 1 : 0;
      const delay = quickExits > 3 ? Math.min(30_000, 1000 * 2 ** (quickExits - 3)) : 200;
      log(`workerd exited (${signal ?? code}); restarting${delay > 200 ? ` in ${Math.round(delay / 1000)}s` : ""}`);
      restarts++;
      restartTimer = setTimeout(start, delay);
    });
  };
  const healthy = async (timeoutMs: number) => {
    try {
      return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
    } catch {
      return false;
    }
  };
  const waitHealthy = async () => {
    for (let i = 0; !(await healthy(500)); i++) {
      if (i > 150) throw new Error("workerd did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** Stop workerd without the restart-on-exit (for a restore). */
  const stopWorkerd = () =>
    new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      stopping = true;
      child.once("exit", () => {
        stopping = false;
        resolve();
      });
      child.kill("SIGTERM");
    });
  // This process exiting (a crash, a forced exit) takes workerd with it; after a kill -9, the pid file above.
  const killOnExit = () => child?.kill("SIGKILL");
  /** Stop workerd for good (and a restart it had coming) and close the supervisor's channel. */
  const shutdown = async () => {
    stopping = true;
    clearTimeout(restartTimer);
    process.off("exit", killOnExit);
    tunnel.halt();
    child?.kill("SIGTERM");
    await new Promise((r) => supervisorServer.close(r));
  };
  process.on("exit", killOnExit);
  start();
  try {
    await waitHealthy();
  } catch (e) {
    // Leave nothing running: workerd restarting forever would keep this process (hewn serve, a test) alive.
    await shutdown();
    throw e;
  }
  tunnel.resume();

  // Nightly backup: one per day, checked hourly (and a minute after start, for machines that sleep at night).
  const nightly = () => {
    void admin("call", { method: "cleanup", args: [] }).catch((e) => log(`cleanup failed: ${(e as Error).message}`));
    try {
      if (backedUpToday(backupDir())) return;
      const b = backupNow(o.home, backupDir());
      log(`backup: ${b.file} (${Math.round(b.bytes / 1024)} KB)`);
    } catch (e) {
      log(`backup failed: ${(e as Error).message}`);
    }
  };
  const backupTimers = [setTimeout(nightly, 60_000), setInterval(nightly, 3600_000)];
  for (const t of backupTimers) t.unref();

  // ---------- watchdog ----------
  let timer: ReturnType<typeof setInterval> | undefined;
  if (o.watchdog !== false) {
    const { intervalMs, stallMs } = o.watchdog ?? { intervalMs: 1000, stallMs: 5000 };
    let lastOk = Date.now();
    let checking = false;
    timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      // A ping that timed out may have been this process's own pause (a long synchronous step, a laptop
      // waking), not workerd's: one more, with a fresh timeout, before it counts.
      if ((await healthy(intervalMs)) || (await healthy(intervalMs))) lastOk = Date.now();
      else if (Date.now() - lastOk > stallMs) {
        log(`workerd unresponsive for ${Math.round((Date.now() - lastOk) / 1000)}s (a capability may be stuck in a loop); restarting it`);
        lastOk = Date.now() + 5000;
        child?.kill("SIGKILL");
      }
      checking = false;
    }, intervalMs);
    timer.unref();
  }

  const admin = async (path: string, body?: unknown) => {
    const res = await fetch(`${url}/_admin/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-hewn-admin": adminToken, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw Object.assign(new Error((out as any).message ?? (out as any).error), out);
    return out;
  };

  return {
    url,
    adminToken,
    control: { url: `http://127.0.0.1:${supervisorPort}`, token: controlToken },
    publicUrl: `http://127.0.0.1:${publicPort}`,
    ...(o.publicListen ? { publicNetwork: `http://${o.publicListen}:${publicPort}` } : {}),
    tunnel,
    admin,
    restarts: () => restarts,
    async restart() {
      const before = restarts;
      child?.kill("SIGTERM");
      while (restarts === before) await new Promise((r) => setTimeout(r, 50));
      for (let i = 0; !(await healthy(500)); i++) {
        if (i > 100) throw new Error("workerd did not come back");
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async stop() {
      if (timer) clearInterval(timer);
      for (const t of backupTimers) clearTimeout(t as ReturnType<typeof setTimeout>);
      await shutdown();
    },
  };
}

const STREAMED = Symbol("streamed");

export const supervisorFile = (home: Home) => join(home.root, "supervisor.json");
export const hasWorkerd = () => { const b = workerd(); return !!b && existsSync(b); };
