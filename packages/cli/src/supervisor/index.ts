// SPDX-License-Identifier: AGPL-3.0-or-later
// The supervisor: runs workerd (the Hewn host) and does what an isolate can't: builders,
// bundling, intake, connecting local agents, deleting blobs. Hewn runs the platform and the tools
// in separate workerd processes, which talk over Unix sockets in the data dir. It also keeps both
// alive: a tool stuck in a CPU loop blocks the tools' (single-threaded) workerd, so a stalled
// /health there restarts the tools; the platform keeps answering meanwhile.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { hostname, platform as osPlatform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityBuilder } from "../builders/types.ts";
import { toBase64, fromBase64 } from "@hewntools/core/files.ts";
import { checkFromJson } from "@hewntools/core/checks.ts";
import type { CheckResult, Files } from "@hewntools/core/ports.ts";
import type { Home } from "../home.ts";
import { localWorkbench } from "../workbench.ts";
import type { Intake } from "../intake.ts";
import type { SetupHooks } from "../setup/hooks.ts";
import { connectHarness } from "../setup/connect.ts";
import { harnessStatuses } from "../setup/harnesses.ts";
import { assetDirs, buildHost, TOOLS_FILES } from "./bundle.ts";
import { chromiumCheck, findBrowser } from "../visual.ts";
import { backedUpToday, backupLocation, backupNow, listBackups, restoreBackup, sameDisk } from "../backup.ts";
import { readConfig } from "../config.ts";
import { type KeySource, masterKey } from "./master-key.ts";
import { Tunnel, validTunnelConfig } from "./tunnel.ts";
import { toolStatus } from "../setup/tools.ts";
import { cliCatalogs } from "../builders/cli-agents.ts";
import { hostAllowance, modelCatalogs } from "../builders/models.ts";
import { remoteGenerate, type RemoteJobs } from "../builders/remote.ts";
import type { Hosted, JobModel, ModelCatalog } from "@hewntools/host-workerd/surface/host.ts";
import { networkMode, type NetworkMode } from "@hewntools/host-workerd/egress.ts";
import { readShelf, shelfImage } from "../shelf.ts";
import { DATA_FORMAT, STORAGE_KEYS, VERSION } from "./format.ts";
import { afterParam, idleStatus, type IdleStatus } from "./idle.ts";
import type { ActivityView } from "@hewntools/core/platform/activity.ts";
import type { HostAllowance } from "@hewntools/core/models.ts";
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
  /**
   * Take the visitor's address from the trusted proxy's x-hewn-proxy-client-ip (only with a proxy secret, and only
   * for a proxy that sets the header itself, replacing any copy a client sent). Default: HEWN_PROXY_CLIENT_IP=1.
   */
  proxyClientIp?: boolean;
  builders: Record<string, CapabilityBuilder>;
  /** The intake on agent `which`, running on `run` (the owner's model and effort for building). */
  intake?: (which: string, run: JobModel) => Intake;
  setup?: SetupHooks;
  /** Run workerd inside the OS sandbox (Seatbelt / bubblewrap). */
  sandbox?: boolean;
  /** Confine builders away from the platform home. */
  sandboxBuilders?: () => boolean;
  log?: (line: string) => void;
  /** Tests only: the tools process's V8 inspector on this address ("127.0.0.1:9229"), to count its isolates. */
  toolsInspector?: string;
  /** Health check cadence and the stall that triggers a restart. */
  watchdog?: { intervalMs: number; stallMs: number } | false;
  /**
   * The resume check, every `intervalMs`: the wall clock jumping ahead of the time this process ran by more than
   * `jumpMs` (a suspended machine woke, a laptop's lid opened) runs what became due, then once more `recheckMs` later;
   * and the next schedule's time coming by the wall clock runs what's due (workerd's alarm can be late after a sleep).
   * Tests move `wall`.
   */
  resume?: { intervalMs?: number; jumpMs?: number; recheckMs?: number; wall?: () => number } | false;
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
  /**
   * For a copy of someone's Hewn (a smoke run, a restore drill), never the owner's own (`copySwitchesFromEnv`):
   * `schedulesOff`, no schedule runs (HEWN_SCHEDULES=off); `network`, what goes out (HEWN_NETWORK): `off`, nothing,
   * `get`, tools' GET and HEAD only. With either network mode the platform's own fetches (model providers, a
   * connection's sign-in, an install from a link) are off too: they post, or need keys a copy hasn't got.
   */
  schedulesOff?: boolean;
  network?: NetworkMode;
  /** Each agent's model list (default: read from its CLI, or the remote service). Tests stub it. */
  models?: (agent: string) => Promise<ModelCatalog>;
  /** The owner's allowance as the host's builder states it (tests; default: read from `remote`). */
  allowance?: (fresh?: boolean) => Promise<HostAllowance | null>;
  /**
   * The check on the disk with Hewn's data, every `intervalMs` (default 5 s): with less than its
   * floor free (diskFloor), tools' data doesn't grow. `space` says how big the disk is and how much
   * is free instead of asking it (tests).
   */
  disk?: { intervalMs?: number; space?: () => { free: number; total: number } };
  /**
   * The idle GC, asked every `intervalMs`: `quietMs` after the last work, one last-resort GC gives back the heap
   * workerd never returns by itself; after only an open page's refreshes and the like, at most every
   * `backgroundEveryMs` (host-workerd idle-gc.ts). Tests shorten them.
   */
  idleGc?: { intervalMs?: number; quietMs?: number; backgroundEveryMs?: number } | false;
}

/**
 * HEWN_SCHEDULES and HEWN_NETWORK, for a copy of someone's Hewn (see SupervisorOptions). Anything but the values
 * below is refused: a typo must not leave a copy's schedules or network on.
 */
export function copySwitchesFromEnv(env: NodeJS.ProcessEnv = process.env): { schedulesOff?: true; network?: NetworkMode } {
  const s = env.HEWN_SCHEDULES ?? "";
  if (!["", "on", "off"].includes(s)) throw new Error("HEWN_SCHEDULES must be off (or on, or unset)");
  const n = env.HEWN_NETWORK ?? "";
  if (!["", "on", "off", "get"].includes(n)) throw new Error("HEWN_NETWORK must be off or get (or on, or unset)");
  return { ...(s === "off" ? { schedulesOff: true as const } : {}), ...(networkMode(n) ? { network: networkMode(n) } : {}) };
}

/** How long after a schedule's time the resume check runs what's due itself (workerd's alarm, when it fires, comes first). */
export const ALARM_GRACE_MS = 5000;

/** The most free space Hewn keeps for itself and the system: below it, tools can't add data. */
export const DISK_FLOOR = 1024 ** 3;

/** The floor on a disk of `total` bytes: 1 GB, or a tenth of a small disk (a disk of 1 GB or less would never have 1 GB free). */
export const diskFloor = (total: number) => Math.floor(Math.min(DISK_FLOOR, total / 10));

/** "1.4 GB", "80 MB". */
/** Files the workerd host sent (base64 by path). */
const decodeFiles = (files: unknown): Files => Object.fromEntries(Object.entries(files as Record<string, string>).map(([p, x]) => [p, fromBase64(x)]));
const sized = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

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
  /** Restarts of the platform's workerd. */
  restarts: () => number;
  /** Restarts of the tools' workerd (a tool stuck in a loop, a crash). */
  toolsRestarts: () => number;
  /** The idle report: whether Hewn is idle, and when it next needs to be awake (`afterSeconds`: the host's quiet time). */
  status(afterSeconds?: number): Promise<IdleStatus>;
  /** Restart both workerd processes (state is on disk; in-memory caches go). */
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

/** Where the two processes reach each other: Unix sockets in the data dir, or loopback ports where a socket's path is too long. */
export interface Channel {
  /** The tools process's socket (the platform's calls). */
  tools: string;
  /** The platform's socket for a running call's callbacks (only the tools process is given it). */
  calls: string;
}

/** The platform's workerd config (capnp) for this home. Exported for tests. */
export function config(o: { dir: string; keys: typeof STORAGE_KEYS; port: number; publicPort: number; publicListen?: string; supervisorPort: number; data: string; assets: { web: string; ui: string; docs: string; spec: string }; channel: Channel; schedulesOff?: boolean; network?: NetworkMode }) {
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
    (name = "tools", external = (address = "${o.channel.tools}", http = ())),
    (name = "internet", network = (allow = [${o.network ? "" : '"public"'}], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${o.port}", http = (), service = "main"),
    (name = "tool-calls", address = "${o.channel.calls}", http = (), service = (name = "main", entrypoint = "ToolCalls")),
    (name = "public", address = "${o.publicListen === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"}:${o.publicPort}", http = (), service = (name = "main", entrypoint = "Public")),${
      // Another address too (a LAN address for a proxy on another machine). 0.0.0.0 already
      // covers loopback, and a second socket on the same port would fail to bind.
      o.publicListen && o.publicListen !== "0.0.0.0" ? `\n    (name = "public-network", address = "${o.publicListen}:${o.publicPort}", http = (), service = (name = "main", entrypoint = "Public")),` : ""
    }
  ],
  # gc() for the idle GC (the supervisor's tick, /_admin/idle-gc). This process only: the tools' never has it.
  v8Flags = ["--expose-gc"],
);
const hewn :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "worker.js"),
    (name = "builder-brief.md", text = embed "builder-brief.md"),
  ],
  compatibilityDate = "2026-09-01",
  # enable_request_signal: a request's signal aborts when its client goes (Stop in the chat stops the intake's CLI).
  compatibilityFlags = ["experimental", "enable_request_signal"],
  bindings = [
    (name = "HEWN", durableObjectNamespace = "HewnDO"),
    (name = "TOOLS", service = "tools"),
    (name = "TOOLS_TOKEN", fromEnvironment = "HEWN_TOOLS_TOKEN"),
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
    (name = "PROXY_CLIENT_IP", fromEnvironment = "HEWN_PROXY_CLIENT_IP"),
    (name = "REMOTE_JOBS", fromEnvironment = "HEWN_REMOTE_JOBS"),
    (name = "HOSTED", fromEnvironment = "HEWN_HOSTED"),
    (name = "HOST_SIGNIN_URL", fromEnvironment = "HEWN_HOST_SIGNIN_URL"),
    (name = "PORT", text = "${o.port}"),
    (name = "VERSION", text = "${VERSION}"),${o.schedulesOff ? `\n    (name = "SCHEDULES", text = "off"),` : ""}
  ],
  durableObjectNamespaces = [
    (className = "HewnDO", uniqueKey = "${o.keys.owner}", enableSql = true, preventEviction = true),
  ],
  durableObjectStorage = (localDisk = "do-storage"),
);
`;
}

/**
 * The tools' workerd config: every tool's CapabilityHost (the same do/ directory, its own namespace in it), the
 * loader and Egress. No secrets key, no blobs, no assets, no owner DO. Exported for tests.
 */
export function toolsConfig(o: { keys: typeof STORAGE_KEYS; data: string; channel: Channel; network?: NetworkMode }) {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .tools),
    (name = "do-storage", disk = (path = "${o.data}/do", writable = true)),
    (name = "platform", external = (address = "${o.channel.calls}", http = ())),
    (name = "internet", network = (allow = [${o.network === "off" ? "" : '"public"'}], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "tools", address = "${o.channel.tools}", http = (), service = "main"),
  ],
);
const tools :Workerd.Worker = (
  modules = [
    (name = "tools-worker.js", esModule = embed "tools-worker.js"),
    (name = "capability-runtime.js", text = embed "capability-runtime.js"),
    (name = "capability-guard.js", text = embed "capability-guard.js"),
  ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["experimental"],
  bindings = [
    (name = "CAPS", durableObjectNamespace = "CapabilityHost"),
    (name = "LOADER", workerLoader = (id = "capabilities")),
    (name = "PLATFORM", service = "platform"),
    (name = "TOOLS_TOKEN", fromEnvironment = "HEWN_TOOLS_TOKEN"),${o.network ? `\n    (name = "NETWORK", text = "${o.network}"),` : ""}
  ],
  durableObjectNamespaces = [
    (className = "CapabilityHost", uniqueKey = "${o.keys.capability}", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "do-storage"),
);
`;
}

/**
 * The OS sandbox around a workerd: it may read `readable` (directories, or files) and `writable`, write only
 * `writable`, and nothing in `hidden` past those (the tools' process: the data dir is hidden but for its own
 * storage and the sockets). `profile`: where macOS's profile is written.
 */
export function sandboxed(cmd: string[], o: { readable: string[]; writable: string[]; hidden?: string[]; listable?: string[]; profile: string }): string[] {
  if (osPlatform() === "darwin") {
    const home = process.env.HOME!;
    // A file as itself; a directory, or one made later, with what's in it.
    const path = (p: string) => (isFile(p) ? `(literal "${p}")` : `(subpath "${p}")`);
    // `listable`: a directory itself (to open it), not what's in it.
    const profile = `(version 1)
(allow default)
(deny file-read* (subpath "${home}")${(o.hidden ?? []).map((p) => ` (subpath "${p}")`).join("")})
(allow file-read* ${[...o.readable, ...o.writable].map(path).join(" ")}${(o.listable ?? []).map((p) => ` (literal "${p}")`).join("")})
(deny file-write* (subpath "/"))
(allow file-write* ${o.writable.map(path).join(" ")} (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null"))
`;
    writeFileSync(o.profile, profile);
    return ["sandbox-exec", "-f", o.profile, ...cmd];
  }
  return [
    "bwrap", "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--ro-bind-try", "/bin", "/bin",
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf", "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/hosts", "/etc/hosts", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...o.readable.flatMap((p) => ["--ro-bind", p, p]), ...o.writable.flatMap((p) => ["--bind", p, p]),
    "--unshare-all", "--share-net", "--die-with-parent", ...cmd,
  ];
}

/**
 * The tools' sandbox: their files, their storage and the sockets; nothing else of the data dir (not the owner's DO, the
 * blobs, the platform's files). Exported for tests.
 */
export const toolsSandbox = (home: string, data: string, binDir: string) => ({
  readable: [binDir, ...["tools.capnp", ...TOOLS_FILES].map((f) => join(data, f))],
  listable: [join(data, "do")],
  writable: [join(data, "do", STORAGE_KEYS.capability), join(data, "run")],
  hidden: [realpathSync(home), data],
  profile: join(data, "workerd-tools.sb"),
});

/** Whether `p` is a file (false for a directory, or anything missing or unreadable). */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
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
  const proxyClientIp = !!proxySecret && (o.proxyClientIp ?? process.env.HEWN_PROXY_CLIENT_IP === "1");
  if (proxyClientIp) log("public listener: the visitor's address from the trusted proxy (HEWN_PROXY_CLIENT_IP)");
  if (o.schedulesOff) log("schedules: off (HEWN_SCHEDULES=off): none runs");
  if (o.network) log(`network: ${o.network === "off" ? "off (HEWN_NETWORK=off): nothing goes out" : "GET and HEAD only (HEWN_NETWORK=get)"}; the platform's own fetches are off`);
  const controlToken = randomBytes(24).toString("hex");
  const startedAt = Date.now();
  const backupDir = () => backupLocation(o.home, readConfig(o.home).backupDir).dir;
  const models = o.models ?? modelCatalogs({ catalogs: cliCatalogs(), ...(o.remote ? { remote: { url: o.remote.url, token: o.remote.token } } : {}) });
  // What the host's builder says of the owner's allowance (hosted); none without one.
  const allowance = o.allowance ?? (o.remote ? hostAllowance({ url: o.remote.url, token: o.remote.token }) : async () => null);
  const workbench = localWorkbench({ root: o.home.builds, builders: o.builders, confineTo: () => (o.sandboxBuilders?.() ? o.home.root : undefined), builderIdleMs: () => {
      const minutes = readConfig(o.home).builderIdleMinutes;
      return minutes === undefined ? undefined : minutes * 60_000;
    },
  });
  const blobRoot = join(data, "blobs");

  // ---------- the supervisor's own HTTP channel (workerd → supervisor) ----------
  const ndjson = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    return (e: unknown) => res.write(JSON.stringify(e) + "\n");
  };
  /** Builders' checks waiting for the core's answer (`${buildId}/${id}`). */
  const checks = new Map<string, { resolve: (r: CheckResult) => void; reject: (e: Error) => void }>();
  const routes: Record<string, (body: any, req: IncomingMessage, res: ServerResponse) => Promise<unknown>> = {
    "/workbench/open": async (b) => workbench.open(b.buildId, decodeFiles(b.files)),
    "/workbench/read": async (b) => ({ files: Object.fromEntries(Object.entries(await workbench.read(b.buildId)).map(([p, x]) => [p, toBase64(x)])) }),
    "/workbench/file": async (b) => {
      const f = await workbench.file(b.buildId, b.path);
      return { data: f ? toBase64(f) : null };
    },
    "/workbench/remove": async (b) => workbench.remove(b.buildId),
    "/workbench/snapshot": async (b) => workbench.snapshot(String(b.buildId), String(b.to)),
    "/workbench/carry-over": async (b) => ({ carried: await workbench.carryOver(String(b.from), String(b.to), decodeFiles(b.overlay)) }),
    "/workbench/write-folder": async (b) => workbench.writeFolder(String(b.buildId), String(b.folder), decodeFiles(b.files)),
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
      // Checks still waiting when the build ends get no answer from the core: say so.
      for (const key of asked) {
        checks.get(key)?.reject(new Error("the build ended"));
        checks.delete(key);
      }
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
    // The platform's stop of a call past its deadline went unanswered: the tools are stuck.
    "/tools/stalled": async (b) => toolsStalled(String(b.reason ?? "a call didn't stop")),
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
    "/models/allowance": async (b) => ({ allowance: await allowance(b.fresh === true) }),
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
      if (b.action === "start") {
        // A copy (HEWN_NETWORK) never goes on a public address.
        if (o.network) throw new Error("no tunnel here: this Hewn's network is off (HEWN_NETWORK)");
        return tunnel.start(validTunnelConfig(b.tunnel));
      }
      if (b.action === "stop") return tunnel.stop();
      return tunnel.current();
    },
    "/control/status": async (b) => ({
      pid: process.pid,
      workerdPid: platform.child?.pid ?? null,
      toolsPid: tools.child?.pid ?? null,
      restarts: platform.restarts,
      toolsRestarts: tools.restarts,
      upSeconds: Math.round((Date.now() - startedAt) / 1000),
      keySource: secretsKey.source,
      sandbox: !!o.sandbox,
      schedules: o.schedulesOff ? "off" : "on",
      network: o.network ?? "on",
      backups: { dir: backupDir(), last: listBackups(backupDir())[0] ?? null },
      // Wrapped: a call during startup, before `status` is defined, is a rejection here, not a thrown route.
      idle: await (async () => status(afterParam(b.after === undefined ? null : String(b.after))))().catch(() => null),
    }),
    "/control/backup": async () => backupNow(o.home, backupDir()),
    "/control/backups": async () => ({ dir: backupDir(), backups: listBackups(backupDir()) }),
    "/control/restore": async (b) => {
      // Stop both workerd processes, swap the data in, start them again.
      await stopWorkerd();
      try {
        return restoreBackup(o.home, String(b.file));
      } finally {
        await startBoth((p) => p.resume());
        // What's live now may not be the newest backup: the idle report asks for one today.
        await admin("changed", {}).catch(() => {});
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

  // ---------- workerd: the platform's process and the tools' ----------
  const bin = workerd();
  if (!bin) throw new Error("the workerd runtime is missing: reinstall Hewn");
  const binDir = realpathSync(resolve(bin, "..", ".."));
  // The sockets between the two: in a directory only this user can enter. A socket's path has a length
  // limit (103 bytes on macOS, 107 on Linux); a data dir too deep for one gets loopback ports instead (each
  // call still carries its token).
  const run = join(data, "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  chmodSync(run, 0o700);
  const socketPath = (name: "tools" | "calls") => join(run, `${name}.sock`);
  const unix = Buffer.byteLength(socketPath("tools")) <= (osPlatform() === "darwin" ? 103 : 107);
  const ports = unix ? undefined : { tools: await freePort(), calls: await freePort() };
  const channel: Channel = ports ? { tools: `127.0.0.1:${ports.tools}`, calls: `127.0.0.1:${ports.calls}` } : { tools: `unix:${socketPath("tools")}`, calls: `unix:${socketPath("calls")}` };
  /** Where the supervisor reaches the tools process (its health check). */
  const toolsAt = ports ? { host: "127.0.0.1", port: ports.tools } : { socketPath: socketPath("tools") };
  if (!unix) log(`the data dir's path is too long for a socket: the platform and the tools talk over loopback ports`);
  const toolsToken = randomBytes(24).toString("hex");
  writeFileSync(join(data, "config.capnp"), config({ dir: data, keys: STORAGE_KEYS, port: o.port, publicPort, publicListen: o.publicListen, supervisorPort, data, assets: assetDirs(), channel, schedulesOff: o.schedulesOff, network: o.network }));
  writeFileSync(join(data, "tools.capnp"), toolsConfig({ keys: STORAGE_KEYS, data, channel, network: o.network }));
  // The tools' own storage (made before each start): the tools process can write nowhere else in the data dir.
  const toolsStorage = join(data, "do", STORAGE_KEYS.capability);
  const platformBase = [bin, "serve", "--experimental", join(data, "config.capnp")];
  const toolsBase = [bin, "serve", "--experimental", join(data, "tools.capnp"), ...(o.toolsInspector ? ["--inspector-addr", o.toolsInspector] : [])];
  const platformCommand = o.sandbox ? sandboxed(platformBase, { readable: [binDir, ...Object.values(assetDirs()).map((d) => realpathSync(d))], writable: [data], profile: join(data, "workerd.sb") }) : platformBase;
  const toolsCommand = o.sandbox ? sandboxed(toolsBase, toolsSandbox(o.home.root, data, binDir)) : toolsBase;
  const url = `http://127.0.0.1:${o.port}`;
  /** The admin channel to the platform (as the owner). */
  const admin = async (path: string, body?: unknown, timeoutMs?: number) => {
    const res = await fetch(`${url}/_admin/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-hewn-admin": adminToken, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const out = await res.json();
    if (!res.ok) throw Object.assign(new Error((out as any).message ?? (out as any).error), out);
    return out;
  };
  let stopping = false;
  /**
   * One workerd: started, restarted when it exits (backing off from a crash loop), its pid on disk. `label` starts
   * its lines in the log; `onExit`, when it exits by itself (not stopped on purpose); `onStarted`, after each start.
   */
  const workerdProcess = (o: { label: string; command: string[]; env: () => NodeJS.ProcessEnv; pidFile: string; socket?: string; cwd: string; onExit?: () => void; onStarted?: () => void }) => {
    const p = {
      child: undefined as ChildProcess | undefined,
      restarts: 0,
      quickExits: 0,
      restartTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      /** Set while it's stopped on purpose (a restore): no restart on exit. */
      held: false,
      /** Set when it's killed to be restarted at once (it stopped responding), not after the usual pause. */
      restartNow: false,
      start() {
        const startedAt = Date.now();
        // The sockets' directory and the tools' storage, again (a restore swaps do/ for the backup's).
        mkdirSync(run, { recursive: true, mode: 0o700 });
        mkdirSync(toolsStorage, { recursive: true });
        // workerd doesn't remove its socket when it ends, and won't bind over one that's there.
        if (o.socket) rmSync(o.socket, { force: true });
        const child = spawn(o.command[0], o.command.slice(1), {
          // workerd opens its working directory: one its sandbox allows (the data dir; the tools', their sockets' dir).
          cwd: o.cwd,
          env: { ...o.env(), PWD: o.cwd },
          stdio: ["ignore", "pipe", "pipe"],
        });
        p.child = child;
        if (child.pid) writeFileSync(o.pidFile, String(child.pid));
        const forward = (b: Buffer) => b.toString().split("\n").filter(Boolean).forEach((l) => log(`${o.label}${l.replace(/^\[\S+\] /, "")}`));
        child.stdout!.on("data", forward);
        child.stderr!.on("data", forward);
        o.onStarted?.();
        child.on("exit", (code, signal) => {
          if (stopping || p.held) return;
          // A crash loop (e.g. a bad config) backs off instead of spinning.
          p.quickExits = Date.now() - startedAt < 3000 ? p.quickExits + 1 : 0;
          const delay = p.restartNow ? 0 : p.quickExits > 3 ? Math.min(30_000, 1000 * 2 ** (p.quickExits - 3)) : 200;
          p.restartNow = false;
          log(`${o.label}workerd exited (${signal ?? code}); restarting${delay > 200 ? ` in ${Math.round(delay / 1000)}s` : ""}`);
          p.restarts++;
          p.restartTimer = setTimeout(() => p.start(), delay);
          o.onExit?.();
        });
      },
      /** Stop it, held (no restart on exit, for a restore) or restarted at once. */
      stop(signal: NodeJS.Signals = "SIGTERM", then: "hold" | "restart now" = "hold") {
        return new Promise<void>((done) => {
          const c = p.child;
          if (!c || c.exitCode !== null || c.signalCode !== null) return done();
          if (then === "hold") p.held = true;
          else p.restartNow = true;
          c.once("exit", () => done());
          c.kill(signal);
        });
      },
      resume() {
        p.held = false;
        p.start();
      },
    };
    return p;
  };
  // A workerd left behind by a supervisor that died (macOS has no die-with-parent) would hold the port.
  const pidFiles = { platform: join(data, "workerd.pid"), tools: join(data, "workerd-tools.pid") };
  for (const pidFile of Object.values(pidFiles)) {
    if (!existsSync(pidFile)) continue;
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
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const platform = workerdProcess({
    label: "",
    command: platformCommand,
    env: () => ({ ...process.env, HEWN_ADMIN_TOKEN: adminToken, HEWN_SUPERVISOR_TOKEN: supervisorToken, HEWN_SECRETS_KEY: secretsKey.key, HEWN_TOOLS_TOKEN: toolsToken, HEWN_TIMEZONE: timezone, HEWN_PROXY_SECRET: proxySecret, HEWN_PROXY_CLIENT_IP: proxyClientIp ? "1" : "", HEWN_REMOTE_JOBS: o.remote ? "1" : "", HEWN_HOSTED: o.hosted ? "1" : "", HEWN_HOST_SIGNIN_URL: o.hosted?.signInUrl ?? "" }),
    pidFile: pidFiles.platform,
    socket: unix ? socketPath("calls") : undefined,
    cwd: data,
    // The calls running in the tools process went with the platform that made them (their callbacks, their deadlines): the tools restart too.
    onExit: () => void tools.stop("SIGTERM", "restart now"),
  });
  // The tools' environment: their token, and what workerd needs from the system (PATH, HOME, TMPDIR, the locale, the
  // time zone); none of the supervisor's own variables (its secrets among them).
  const toolsEnv = (): NodeJS.ProcessEnv => {
    const keep = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];
    return { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), TZ: process.env.TZ ?? timezone, HEWN_TOOLS_TOKEN: toolsToken };
  };
  const tools = workerdProcess({
    label: "tools: ",
    command: toolsCommand,
    env: toolsEnv,
    pidFile: pidFiles.tools,
    socket: unix ? socketPath("tools") : undefined,
    cwd: run,
    // The platform holds its calls while the tools are away, and sends them once a new process answers: never to a
    // socket nothing listens on yet.
    onExit: () => void admin("tools-gone", {}, 2000).catch(() => {}),
    onStarted: () => void waitFor(toolsHealthy, "the tools' workerd").then(() => admin("tools-back", {}, 2000)).catch(() => {}),
  });
  const healthy = async (timeoutMs: number) => {
    try {
      return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
    } catch {
      return false;
    }
  };
  /** The tools process's /health, on its socket. */
  const toolsHealthy = (timeoutMs: number) =>
    new Promise<boolean>((done) => {
      const req = httpRequest({ ...toolsAt, path: "/health", timeout: timeoutMs }, (res) => {
        res.resume();
        done(res.statusCode === 200);
      });
      req.on("timeout", () => (req.destroy(), done(false)));
      req.on("error", () => done(false));
      req.end();
    });
  const waitFor = async (check: (ms: number) => Promise<boolean>, what: string) => {
    for (let i = 0; !(await check(500)); i++) {
      if (i > 150) throw new Error(`${what} did not start`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** The tools first, answering, then the platform (it calls them as it starts: interrupted builds, schedules). */
  const startBoth = async (start: (p: typeof tools) => void) => {
    start(tools);
    await waitFor(toolsHealthy, "the tools' workerd");
    start(platform);
    await waitFor(healthy, "workerd");
  };
  const waitHealthy = async () => {
    await waitFor(toolsHealthy, "the tools' workerd");
    await waitFor(healthy, "workerd");
  };
  /** Stop both without the restart-on-exit (for a restore): the platform first, so nothing calls the tools meanwhile. */
  const stopWorkerd = async () => {
    await platform.stop();
    await tools.stop();
  };
  // This process exiting (a crash, a forced exit) takes workerd with it; after a kill -9, the pid files above.
  const killOnExit = () => {
    platform.child?.kill("SIGKILL");
    tools.child?.kill("SIGKILL");
  };
  /** Stop both for good (and a restart they had coming) and close the supervisor's channel. */
  const shutdown = async () => {
    stopping = true;
    clearTimeout(platform.restartTimer);
    clearTimeout(tools.restartTimer);
    process.off("exit", killOnExit);
    tunnel.halt();
    // The platform first, so nothing calls the tools meanwhile; the tools when it has gone (or after a moment).
    const toolsChild = tools.child;
    if (platform.child && platform.child.exitCode === null && platform.child.signalCode === null) {
      const gone = new Promise((r) => platform.child!.once("exit", r));
      platform.child.kill("SIGTERM");
      await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    }
    toolsChild?.kill("SIGTERM");
    await new Promise((r) => supervisorServer.close(r));
  };
  process.on("exit", killOnExit);
  try {
    await startBoth((p) => p.start());
  } catch (e) {
    // Leave nothing running: workerd restarting forever would keep this process (hewn serve, a test) alive.
    await shutdown();
    throw e;
  }
  /** Set while the tools are being restarted for not responding (one restart at a time). */
  let toolsRestarting = false;
  /**
   * The tools stopped responding (code that never yields): the platform is told first, while what was running there
   * is still running (it says which tools did, and fails the builds whose code did), then the tools are restarted.
   */
  const toolsStalled = async (why: string) => {
    if (toolsRestarting) return;
    toolsRestarting = true;
    try {
      log(`Hewn's tools stopped responding (${why}; a tool may be stuck in a loop); restarting them`);
      await admin("tools-stalled", { at: new Date().toISOString(), why }, 3000).catch((e) => log(`couldn't tell Hewn what was running: ${(e as Error).message}`));
      await tools.stop("SIGKILL", "restart now");
    } finally {
      toolsRestarting = false;
    }
  };
  if (!o.network) tunnel.resume();

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
  // Each process answers /health; one that stops answering for `stallMs` is restarted. The tools stop
  // answering when a tool's code never yields (the platform is told what was running, then they're restarted);
  // the platform is restarted alone.
  const timers: ReturnType<typeof setInterval>[] = [];
  if (o.watchdog !== false) {
    const { intervalMs, stallMs } = o.watchdog ?? { intervalMs: 1000, stallMs: 5000 };
    const watch = (check: (ms: number) => Promise<boolean>, onStall: (seconds: number) => Promise<void> | void) => {
      let lastOk = Date.now();
      let checking = false;
      const t = setInterval(async () => {
        if (checking) return;
        checking = true;
        // A ping that timed out may have been this process's own pause (a long synchronous step, a laptop
        // waking), not workerd's: one more, with a fresh timeout, before it counts.
        if ((await check(intervalMs)) || (await check(intervalMs))) lastOk = Date.now();
        else if (Date.now() - lastOk > stallMs) {
          const seconds = Math.round((Date.now() - lastOk) / 1000);
          lastOk = Date.now() + 5000;
          await onStall(seconds);
        }
        checking = false;
      }, intervalMs);
      t.unref();
      timers.push(t);
    };
    watch(toolsHealthy, (seconds) => toolsStalled(`no answer for ${seconds} s`));
    watch(healthy, (seconds) => {
      log(`workerd unresponsive for ${seconds}s; restarting it`);
      platform.child?.kill("SIGKILL");
    });
  }

  // The resume check: the wall clock ran ahead of this process (the machine was suspended, or asleep). Due schedules run
  // by the wall clock and the alarm is re-armed (whether workerd's own alarm fires after such a jump isn't assumed),
  // the backup check runs, and all of it once more a little later: after a wake the clock may lag until NTP catches up.
  // And when the next schedule's time comes by the wall clock, what's due runs too: workerd's alarm waits on a clock
  // that stops while the machine sleeps, and re-arming it for the same time changes nothing, so after a wake it can
  // fire hours late.
  let resumeTimer: ReturnType<typeof setInterval> | undefined;
  /** When the last resume was noticed: the idle report's grace starts again from it. */
  let resumedAt: number | null = null;
  const recheckTimers = new Set<ReturnType<typeof setTimeout>>();
  if (o.resume !== false) {
    const { intervalMs = 5000, jumpMs = 30_000, recheckMs = 15_000, wall = Date.now } = o.resume ?? {};
    /** When the next schedule is due (ms), as the platform last said: at start, and in every catch-up's reply. */
    let nextAlarmAt: number | null = null;
    /** Whether a catch-up has replied (the start's read then says nothing newer). */
    let replied = false;
    /** Catch-ups in flight: the schedule's-time check starts none meanwhile. */
    let catchingUp = 0;
    /** The schedule time a catch-up last ran for (once per time: a reply that says it again starts none), and one that failed (said once). */
    let caughtUpFor: number | null = null;
    let failedFor: number | null = null;
    /** Run what's due by the wall clock and re-arm the alarm. The reply says the next schedule's time. */
    const catchUp = async () => {
      catchingUp++;
      try {
        const r = await admin("resumed", {});
        nextAlarmAt = r.nextAlarmAt ?? null;
        replied = true;
        return r as { nextAlarmAt: number | null };
      } finally {
        catchingUp--;
      }
    };
    /** After a resume: catch up, and the backup check. */
    const caughtUp = async () => {
      try {
        const r = await catchUp();
        log(`caught up after a resume${r.nextAlarmAt ? `; next alarm ${new Date(r.nextAlarmAt).toISOString()}` : ""}`);
      } catch (e) {
        log(`catching up after a resume failed: ${(e as Error).message}`);
      }
      nightly();
    };
    /** The next schedule's time came by the wall clock: catch up, once for that time (tried again if it fails). */
    const scheduleTime = (at: number) => {
      caughtUpFor = at;
      void catchUp().catch((e) => {
        caughtUpFor = null;
        if (failedFor !== at) log(`running the schedule due ${new Date(at).toISOString()} failed: ${(e as Error).message}; trying again`);
        failedFor = at;
      });
    };
    // Its first value. If workerd doesn't answer this yet, it stays unset until the first catch-up: only a sleep makes
    // the alarm late, and a resume's catch-up says the time.
    void admin("call", { method: "nextScheduleAt" }).then(
      (r) => {
        if (!replied) nextAlarmAt = r.result ?? null;
      },
      (e) => log(`couldn't read the next schedule's time at start: ${(e as Error).message}`),
    );
    let last = { wall: wall(), mono: performance.now() };
    resumeTimer = setInterval(() => {
      const now = { wall: wall(), mono: performance.now() };
      const jump = now.wall - last.wall - (now.mono - last.mono);
      last = now;
      if (jump <= jumpMs) {
        // The next schedule's time came by the wall clock (and a little more: the alarm, when it fires, comes first).
        if (!catchingUp && nextAlarmAt !== null && nextAlarmAt !== caughtUpFor && now.wall >= nextAlarmAt + ALARM_GRACE_MS) scheduleTime(nextAlarmAt);
        return;
      }
      log(`the clock jumped ${Math.round(jump / 1000)}s ahead (resumed); catching up`);
      resumedAt = Date.now();
      void caughtUp();
      const t = setTimeout(() => (recheckTimers.delete(t), void caughtUp()), recheckMs);
      t.unref();
      recheckTimers.add(t);
    }, intervalMs);
    resumeTimer.unref();
  }

  const status = async (afterSeconds?: number) => {
    const { result } = (await admin("call", { method: "idleActivity" })) as { result: ActivityView };
    const backups = listBackups(backupDir());
    const lastAt = backups.length ? Math.max(...backups.map((b) => Date.parse(b.at))) : null;
    return idleStatus(result, { lastAt, backedUpToday: backedUpToday(backupDir()) }, { afterSeconds, resumedAt });
  };


  // ---------- the disk ----------
  // A tool's data can't grow while the disk with Hewn's data is nearly full. workerd is told while it is
  // (on every check: a restarted workerd starts out not knowing), and once when it no longer is.
  const { intervalMs: diskMs = 5000, space = () => { const f = statfsSync(data); return { free: f.bavail * f.bsize, total: f.blocks * f.bsize }; } } = o.disk ?? {};
  let diskLow = false;
  let diskChecking = false;
  const checkDisk = async () => {
    if (diskChecking) return;
    diskChecking = true;
    try {
      const { free, total } = space();
      const floor = diskFloor(total);
      const low = free < floor;
      if (low || diskLow) await admin("disk", { low, free, floor });
      if (low !== diskLow) log(low ? `the disk with Hewn's data has ${sized(free)} free, under ${sized(floor)}: tools can't add data until there's more room` : `the disk with Hewn's data has ${sized(free)} free again: tools can add data`);
      diskLow = low;
    } catch {
      // workerd restarting, or the disk unreadable for a moment: the next check
    } finally {
      diskChecking = false;
    }
  };
  void checkDisk();
  const diskTimer = setInterval(checkDisk, diskMs);
  diskTimer.unref();

  // ---------- the idle GC ----------
  // workerd never runs V8's idle-time GC, so the platform's heap stays as big as its last burst of requests made it.
  // Asked on a tick; the platform decides when (idle-gc.ts), and the tick itself counts as nothing.
  let gcTimer: ReturnType<typeof setInterval> | undefined;
  if (o.idleGc !== false) {
    const { intervalMs = 5000, ...times } = o.idleGc ?? {};
    let asking = false;
    gcTimer = setInterval(async () => {
      if (asking) return;
      asking = true;
      try {
        await admin("idle-gc", times, 5000);
      } catch {
        // workerd restarting: the next tick
      } finally {
        asking = false;
      }
    }, intervalMs);
    gcTimer.unref();
  }

  return {
    url,
    adminToken,
    control: { url: `http://127.0.0.1:${supervisorPort}`, token: controlToken },
    publicUrl: `http://127.0.0.1:${publicPort}`,
    ...(o.publicListen ? { publicNetwork: `http://${o.publicListen}:${publicPort}` } : {}),
    tunnel,
    admin,
    restarts: () => platform.restarts,
    toolsRestarts: () => tools.restarts,
    status,
    async restart() {
      const before = { platform: platform.restarts, tools: tools.restarts };
      platform.child?.kill("SIGTERM");
      tools.child?.kill("SIGTERM");
      while (platform.restarts === before.platform || tools.restarts === before.tools) await new Promise((r) => setTimeout(r, 50));
      await waitHealthy().catch(() => {
        throw new Error("workerd did not come back");
      });
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      clearInterval(diskTimer);
      clearInterval(gcTimer);
      if (resumeTimer) clearInterval(resumeTimer);
      for (const t of recheckTimers) clearTimeout(t);
      for (const t of backupTimers) clearTimeout(t as ReturnType<typeof setTimeout>);
      await shutdown();
    },
  };
}

const STREAMED = Symbol("streamed");

export const supervisorFile = (home: Home) => join(home.root, "supervisor.json");
export const hasWorkerd = () => { const b = workerd(); return !!b && existsSync(b); };

/** A free loopback port (for the processes' channel when a socket's path is too long). */
const freePort = () =>
  new Promise<number>((done, fail) => {
    const srv = createNetServer();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => done(port));
    });
  });
