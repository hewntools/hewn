// SPDX-License-Identifier: AGPL-3.0-or-later
// The copy's Hewn: the tree under test's own supervisor and workerd host (as `hewn serve` starts them), with stub
// builders under every builder's name and a stub intake, so nothing a copy does can run a real builder or model on
// the owner's accounts. Run by smoke-copy.ts as a child process, stopped by its pid (SIGTERM).
//
// SMOKE_TREE    the Hewn checkout under test (its own node_modules)
// HEWN_HOME     the copy's home; HEWN_PORT, SMOKE_PUBLIC_PORT its ports
// SMOKE_NETWORK "off" or "get" (HEWN_NETWORK); schedules are always off
// SMOKE_STUB    where the stub builder notes what it did (JSON lines), for the checks
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} isn't set`);
  return v;
};
const tree = env("SMOKE_TREE");
const root = env("HEWN_HOME");
const port = Number(env("HEWN_PORT"));
const publicPort = Number(env("SMOKE_PUBLIC_PORT"));
const network = env("SMOKE_NETWORK");
const stubLog = env("SMOKE_STUB");
if (network !== "off" && network !== "get") throw new Error("SMOKE_NETWORK must be off or get");

const from = (p: string) => import(pathToFileURL(join(tree, p)).href);
const sv = await from("packages/cli/src/supervisor/index.ts");
const { openHome, writeFileAtomic } = await from("packages/cli/src/home.ts");
const { writeFormat } = await from("packages/cli/src/supervisor/format.ts");
const agents: { CLI_AGENT_NAMES?: string[]; CLI_AGENTS?: Record<string, { label?: string; harnessId?: string }> } = await from("packages/cli/src/builders/cli-agents.ts").catch(() => ({}));

// Fail closed: a tree without the copy switches would start the copy with its schedules and network on.
const probe = { keys: { owner: "o", capability: "c" }, data: "/x", channel: { tools: "t", calls: "c" } };
const supported =
  typeof sv.copySwitchesFromEnv === "function" &&
  /name = "NETWORK", text = "off"/.test(sv.toolsConfig({ ...probe, network: "off" })) &&
  /name = "SCHEDULES", text = "off"/.test(sv.config({ ...probe, dir: "/x", port: 1, publicPort: 2, supervisorPort: 3, assets: { web: "", ui: "", docs: "", spec: "" }, schedulesOff: true, network: "off" }));
if (!supported) {
  console.error("SMOKE-UNSUPPORTED this tree has no HEWN_SCHEDULES / HEWN_NETWORK switches: a copy can't start safely on it (rebase it onto a release that has them)");
  process.exit(3);
}

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
const note = (o: Record<string, unknown>) => appendFileSync(stubLog, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The stub builder. It reads the request in BUILDER.md:
 * - `[smoke:slow]`: notes its progress in src/index.ts, then waits (up to 2 minutes) for a Stop. A retry that carries
 *   on finds that note and finishes at once: that's how a check sees the work was carried on.
 * - `[smoke:fail]`: fails the attempt.
 * - anything else: a trivial edit (a comment at the end of src/index.ts).
 */
const PROGRESS = "// smoke-progress: started by ";
const stub = (name: string) => ({
  name,
  async build(job: { buildId: string; kind: string; workspace: string; attempt: number; carriesOn?: string; retryOf?: string; signal?: AbortSignal; onActivity?: (l: string) => void }) {
    const request = existsSync(join(job.workspace, "BUILDER.md")) ? readFileSync(join(job.workspace, "BUILDER.md"), "utf8") : "";
    const index = join(job.workspace, "src", "index.ts");
    const code = existsSync(index) ? readFileSync(index, "utf8") : undefined;
    const found = !!code?.includes(PROGRESS);
    note({ buildId: job.buildId, event: "start", builder: name, kind: job.kind, attempt: job.attempt, carriesOn: job.carriesOn ?? null, retryOf: job.retryOf ?? null, foundProgress: found });
    job.onActivity?.(`smoke stub (${name}): attempt ${job.attempt}${job.carriesOn ? `, carrying on from a ${job.carriesOn} build` : ""}`);
    if (job.kind === "create" || code === undefined) throw new Error("the smoke stub builder only changes tools that have src/index.ts");
    if (request.includes("[smoke:fail]")) throw new Error("smoke stub: asked to fail");
    if (request.includes("[smoke:slow]") && !(job.carriesOn && found)) {
      appendFileSync(index, `\n${PROGRESS}${job.buildId}\n`);
      note({ buildId: job.buildId, event: "waiting" });
      // Two minutes at most; a Stop ends it at once, as a builder that's killed would.
      const stopped = new Promise<void>((r) => (job.signal?.aborted ? r() : job.signal?.addEventListener("abort", () => r(), { once: true })));
      for (let i = 0; i < 60; i++) {
        job.onActivity?.("smoke stub: working slowly (waiting for a Stop)");
        if (await Promise.race([stopped.then(() => true), sleep(2000).then(() => false)])) {
          note({ buildId: job.buildId, event: "stopped" });
          throw new Error("stopped");
        }
      }
    }
    if (job.carriesOn && found) note({ buildId: job.buildId, event: "carried-on" });
    appendFileSync(index, `\n// smoke: a trivial edit by the stub builder (${job.buildId})\n`);
    note({ buildId: job.buildId, event: "done" });
  },
});

const names = [...new Set([...(agents.CLI_AGENT_NAMES ?? ["claude", "codex", "opencode"]), "claude", "codex", "opencode", "remote"])];
const builders = Object.fromEntries(names.map((n) => [n, stub(n)]));
const intake = () => async () => ({ kind: "answer", message: "This is a smoke copy: its intake is a stub and drafts nothing." });

const home = openHome(root);
// A stop asked for while it's still starting is kept until it's up (startSupervisor leaves nothing running when it
// fails): Node's default on SIGTERM ends the process without its exit handlers, which would orphan both workerds.
let s: any;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (!s) return;
  rmSync(sv.supervisorFile(home), { force: true });
  await s.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const startedAt = Date.now();
s = await sv.startSupervisor({
  home,
  port,
  publicPort,
  proxySecret: "",
  builders,
  intake,
  sandbox: true,
  sandboxBuilders: () => true,
  keySource: "file",
  schedulesOff: true,
  network,
  // What Settings shows: the stubs, signed in; no CLI of the owner's is asked anything.
  tools: () => names.filter((n) => n !== "remote").map((n) => ({ name: n, label: `${agents.CLI_AGENTS?.[n]?.label ?? n} (smoke stub)`, harnessId: agents.CLI_AGENTS?.[n]?.harnessId, found: true, loggedIn: true })),
  models: async (agent: string) => ({ agent, models: [{ id: "default", label: "Default", kind: "default", efforts: [] }] }),
  log,
});
if (stopping) {
  stopping = false;
  await stop();
}
writeFormat(home);
// What `hewn doctor`, `hewn status` and `hewn open --print` read, as `hewn serve` writes it.
writeFileAtomic(sv.supervisorFile(home), JSON.stringify({ url: s.url, adminToken: s.adminToken, control: s.control, publicListener: s.publicUrl, pid: process.pid }) + "\n", 0o600);
// `builders`: every name the copy's workbench has, each the stub (the safety check holds the settings to them).
console.log(`SMOKE-READY ${JSON.stringify({ url: s.url, adminToken: s.adminToken, control: s.control, pid: process.pid, startMs: Date.now() - startedAt, builders: names })}`);
