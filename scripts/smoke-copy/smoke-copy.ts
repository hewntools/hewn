// SPDX-License-Identifier: AGPL-3.0-or-later
// A smoke run on a copy of a real Hewn: starts a tree's Hewn on a throwaway, made-safe copy of a home (from a
// `hewn backup` zip, or a home), runs the fixed checks and any scenario steps, and writes a report.
//
//   npm run smoke:copy -- --from <backup.zip | home> --tree <checkout> [--scenarios <dir>] [--out <dir>]
//                         [--network] [--tool <id>] [--baseline <results.json>] [--keep]
//
// See docs/internal/smoke-copy.md.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { NetworkMode } from "../../packages/host-workerd/src/egress.ts";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Browser } from "./browser.ts";
import * as checks from "./checks.ts";
import { alive, until } from "./checks.ts";
import { type Ready, CopyClient } from "./client.ts";
import { makeCopy } from "./copy.ts";
import { assertSpare, copyPorts, LIVE_PORTS } from "./ports.ts";
import { againstBaseline, type CheckResult, type Item, type RunFacts, worst, writeReport } from "./report.ts";
import { runScenario, scenarioFiles, sleep, stubEvents, type ScenarioContext } from "./scenario.ts";

const USAGE = `usage: npm run smoke:copy -- --from <backup.zip | home> --tree <checkout> [--scenarios <dir>] [--out <dir>] [--network] [--tool <id>] [--baseline <results.json>] [--keep]

  --from       a \`hewn backup\` zip, or a Hewn home (read as the nightly backup reads it, never written)
  --tree       the Hewn checkout to run (npm ci done in it)
  --scenarios  a folder of scenario files (*.ts, *.mjs) to run after the fixed checks
  --out        where the report goes (default: a new folder in the temp dir)
  --network    let tools' GET and HEAD out (default: nothing goes out)
  --tool       the tool changes are made on (default: the first ready one that needs no network, model or other tool)
  --baseline   results.json of a run on the base branch (same copy): what failed there too is only a warning
  --keep       keep the copy's home when done (default: deleted)`;

const { values: o } = parseArgs({
  options: { from: { type: "string" }, tree: { type: "string" }, baseline: { type: "string" }, scenarios: { type: "string" }, out: { type: "string" }, network: { type: "boolean" }, tool: { type: "string" }, keep: { type: "boolean" }, help: { type: "boolean" } },
});
if (o.help || !o.from || !o.tree) {
  console.log(USAGE);
  process.exit(o.help ? 0 : 2);
}

const say = (l: string) => console.log(`[smoke] ${l}`);
const tree = realpathSync(resolve(o.tree));
const network: NetworkMode = o.network ? "get" : "off";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = resolve(o.out ?? join(tmpdir(), `hewn-smoke-${stamp}`));
mkdirSync(join(out, "shots"), { recursive: true });
const logFile = join(out, "hewn.log");
const stubFile = join(out, "stub.jsonl");

// A baseline is read first: a bad one stops here, before anything runs.
const baseline = o.baseline ? readBaseline(resolve(o.baseline)) : undefined;
function readBaseline(file: string): CheckResult[] {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")).results;
    if (!Array.isArray(r)) throw new Error("no results in it");
    return r;
  } catch (e) {
    throw new Error(`--baseline ${file}: not a smoke run's results.json (${(e as Error).message})`);
  }
}

// ---------- the tree ----------
const workerdBin = join(tree, "node_modules", "workerd", "bin", "workerd");
if (!existsSync(join(tree, "packages", "cli", "src", "supervisor", "index.ts"))) throw new Error(`${tree} isn't a Hewn checkout`);
// npm ci --ignore-scripts leaves a Node shim there, which orphans the real workerd when stopped.
if (!existsSync(workerdBin) || statSync(workerdBin).size < 5_000_000) throw new Error(`${tree} has no workerd binary: run npm ci there (with install scripts)`);
const git = (...a: string[]) => spawnSync("git", ["-C", tree, ...a], { encoding: "utf8" }).stdout.trim();
const treeRef = `${git("rev-parse", "--short", "HEAD") || "?"}${git("rev-parse", "--abbrev-ref", "HEAD") && git("rev-parse", "--abbrev-ref", "HEAD") !== "HEAD" ? ` (${git("rev-parse", "--abbrev-ref", "HEAD")})` : ""}${git("status", "--porcelain") ? ", with uncommitted changes" : ""}`;

// ---------- the copy ----------
const work = mkdtempSync(join(tmpdir(), "hewn-smoke-copy-"));
const facts: RunFacts = { startedAt: new Date().toISOString(), tree, treeRef, source: basename(resolve(o.from)), network, ports: { port: 0, publicPort: 0 }, copy: {}, timings: {}, memory: [], scenarios: [], ...(o.baseline ? { baseline: resolve(o.baseline) } : {}) };
const results: CheckResult[] = [];
let hewn: CopyProcess | undefined;
let browser: Browser | undefined;

/** The copy's Hewn: launch.ts in a child process, stopped by its own pid. */
class CopyProcess {
  child?: ChildProcess;
  ready?: Ready;
  private env: NodeJS.ProcessEnv;
  private starts = 0;
  constructor(env: NodeJS.ProcessEnv) {
    this.env = env;
  }

  start(): Promise<Ready> {
    const t0 = Date.now();
    const label = this.starts++ ? "start-up after a stop (spawn to ready)" : "start-up (spawn to ready)";
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "launch.ts")], { cwd: tree, env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let tail = "";
    return new Promise<Ready>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`not up within 120 s; the log ends:\n${tail.slice(-2000)}`)), 120_000);
      const onData = (b: Buffer) => {
        const text = b.toString();
        appendFileSync(logFile, text.split("\n").filter((l) => !l.startsWith("SMOKE-READY ")).join("\n"));
        tail = (tail + text).slice(-4000);
        const m = /^SMOKE-READY (.+)$/m.exec(text);
        if (m) {
          clearTimeout(timer);
          this.ready = JSON.parse(m[1]);
          facts.timings[label] = Date.now() - t0;
          ok(this.ready!);
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        fail(new Error(/SMOKE-UNSUPPORTED/.test(tail) ? tail.split("SMOKE-UNSUPPORTED ")[1].split("\n")[0] : `the copy's Hewn exited (${code}) before it was up; the log ends:\n${tail.slice(-2000)}`));
      });
    });
  }

  /** Stop it by its pid (SIGTERM, then SIGKILL after 20 s); whether it went on its own. */
  async stop(): Promise<boolean> {
    const c = this.child;
    if (!c?.pid || c.exitCode !== null || c.signalCode !== null) return true;
    const gone = new Promise((r) => c.once("exit", r));
    c.kill("SIGTERM");
    const clean = await Promise.race([gone.then(() => true), sleep(20_000).then(() => false)]);
    if (!clean) {
      c.kill("SIGKILL");
      await gone;
    }
    return clean;
  }
}

/**
 * Processes of the copy still running once it's stopped: any whose command line names the copy's work dir (each
 * workerd's config is there), whichever start they came from. Killed by pid; their pids returned.
 */
function sweep(): number[] {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout;
  // workerd is given real paths (on macOS the temp dir is under /private).
  const paths = existsSync(work) ? [work, realpathSync(work)] : [work];
  const left = ps
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && paths.some((p) => m[2].includes(p)) && Number(m[1]) !== process.pid)
    .map((m) => Number(m[1]));
  for (const pid of left) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return left;
}

/** A stop's outcome as an item's status and reason. */
const stopOutcome = (clean: boolean, orphans: number[]): Pick<Item, "status" | "reason"> => ({
  status: clean && !orphans.length ? "pass" : "fail",
  reason: orphans.length ? `left running: ${orphans.join(", ")} (killed)` : clean ? "supervisor and both workerds gone" : "didn't stop within 20 s (killed)",
});

/** Before anything runs on the copy: its switches are on, its configs say so, nothing is active, no secret is there. */
async function safety(c: CopyClient, home: string, ports: number[]): Promise<CheckResult> {
  return checks.check("safety", "Safety: the copy can't act for the owner", async () => {
    const st = await c.control<any>("status");
    const data = join(home, "workerd");
    const platformConfig = readFileSync(join(data, "config.capnp"), "utf8");
    const toolsConfig = readFileSync(join(data, "tools.capnp"), "utf8");
    const schedules = (await c.admin<any[]>("schedules", {})) ?? [];
    const secrets = (await c.call<any[]>("unreadableSecrets")) ?? [];
    const settings = await c.adminGet<{ builder: string; intake: string }>("settings");
    const stubs = c.ready.builders ?? [];
    const items: Item[] = [
      { name: "schedules off (HEWN_SCHEDULES=off)", status: st.schedules === "off" && /name = "SCHEDULES", text = "off"/.test(platformConfig) ? "pass" : "fail", reason: `the supervisor says ${st.schedules}` },
      { name: `${facts.copy.paused} schedule(s) paused before start, none active`, status: schedules.some((s) => s.status === "active") ? "fail" : "pass", reason: `${schedules.length} in the copy: ${[...new Set(schedules.map((s) => s.status))].join(", ") || "none"}` },
      { name: `network ${network} (HEWN_NETWORK=${network})`, status: st.network === network && new RegExp(`name = "NETWORK", text = "${network}"`).test(toolsConfig) && /name = "internet", network = \(allow = \[\]/.test(platformConfig) ? "pass" : "fail", reason: `tools: ${network === "off" ? "nothing goes out" : "GET and HEAD only"}; the platform's own fetches: off` },
      { name: "no secrets in the copy", status: secrets.length === 0 ? "pass" : "fail", reason: `rows removed before start: ${JSON.stringify(facts.copy.stripped)}` },
      { name: "spare ports, never a live Hewn's", status: ports.every((p) => !LIVE_PORTS.has(p)) && Number(new URL(c.ready.url).port) === ports[0] ? "pass" : "fail", reason: `${ports.join(", ")} (never ${[...LIVE_PORTS].join(", ")})` },
      { name: "the sandbox on; the secrets key a file in the copy", status: st.sandbox && st.keySource === "file" && existsSync(join(home, "master.key")) ? "pass" : "fail", reason: `sandbox ${st.sandbox ? "on" : "OFF"}, key ${st.keySource}` },
      { name: "stub builders only", status: stubs.includes(settings.builder) && stubs.includes(settings.intake) ? "pass" : "fail", reason: `builder ${settings.builder}, intake ${settings.intake}; the stub under ${stubs.join(", ") || "no name"}` },
    ];
    return { status: worst(items.map((i) => i.status)), summary: items.every((i) => i.status === "pass") ? "every switch on and checked" : "a safety switch isn't on: stopped", items };
  });
}

async function restartCycle(r: checks.RunContext): Promise<CheckResult> {
  return checks.check("restart", "A restart cycle: both come back, nothing orphaned", async () => {
    const items: Item[] = [];
    const st0 = await r.c.control<any>("status");
    // The tools' workerd dies: the watchdog brings it back alone.
    process.kill(st0.toolsPid, "SIGKILL");
    await until("the tools come back", async () => {
      const s = await r.c.control<any>("status");
      return s.toolsPid && s.toolsPid !== st0.toolsPid && s.toolsRestarts > st0.toolsRestarts && !alive(st0.toolsPid);
    }, 30_000);
    const st1 = await r.c.control<any>("status");
    items.push({ name: "the tools' workerd killed: restarted", status: "pass", reason: `restarts: platform ${st1.restarts}, tools ${st1.toolsRestarts}` });
    // The platform's dies: it comes back, and the tools with it.
    process.kill(st1.workerdPid, "SIGKILL");
    await until("the platform comes back", async () => {
      const s = await r.c.control<any>("status");
      return s.workerdPid && s.workerdPid !== st1.workerdPid && s.restarts > st1.restarts && (await r.c.health());
    }, 30_000);
    await sleep(1000);
    const st2 = await r.c.control<any>("status");
    items.push({ name: "the platform's workerd killed: restarted, the tools with it", status: alive(st2.toolsPid) && st2.toolsPid !== st1.toolsPid ? "pass" : "fail", reason: `restarts: platform ${st2.restarts}, tools ${st2.toolsRestarts}` });
    // A stop by the supervisor's pid, and a start on the same home.
    const clean = await hewn!.stop();
    await sleep(500);
    items.push({ name: "stopped by its pid: nothing orphaned", ...stopOutcome(clean && !alive(st2.pid), sweep()) });
    const ready = await hewn!.start();
    r.c.ready = ready;
    await until("up again", () => r.c.health(), 30_000);
    const st3 = await r.c.control<any>("status");
    const list = await r.c.call<any[]>("list");
    items.push({ name: "started again on the same copy", status: alive(st3.workerdPid) && alive(st3.toolsPid) && list.length === r.tools.length ? "pass" : "fail", reason: `restarts: platform ${st3.restarts}, tools ${st3.toolsRestarts}; ${list.length} tools` });
    return { status: worst(items.map((i) => i.status)), summary: items.map((i) => i.reason).join("; "), items };
  });
}

let exitCode = 0;
let finishing: Promise<never> | undefined;
/**
 * The end of every run, however it ends (done, stopped early, interrupted): the copy stopped and swept, the log
 * scanned, the copy's home deleted (unless --keep), the report written. Once.
 */
function finish(code: number): Promise<never> {
  finishing ??= (async () => {
    await browser?.close();
    if (hewn?.child) {
      const clean = await hewn.stop();
      await sleep(500);
      const { status, reason } = stopOutcome(clean, sweep());
      results.push({ id: "stop", title: "Stopped by its pid, nothing orphaned", status, summary: reason!, ms: 0 });
    } else sweep();
    if (existsSync(logFile)) results.push(await checks.logScan({ logFile }));
    if (o.keep) say(`kept the copy: ${work}`);
    else rmSync(work, { recursive: true, force: true });
    const { file, status } = writeReport(out, facts, baseline ? againstBaseline(results, baseline) : results);
    say(`${status}: ${file}`);
    process.exit(code || (status === "fail" ? 1 : 0));
  })();
  return finishing;
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    facts.aborted ??= `interrupted (${sig})`;
    say(`interrupted: stopping the copy`);
    void finish(130);
  });
}

try {
  say(`copying ${o.from} into ${work}`);
  const t0 = Date.now();
  const copy = makeCopy(o.from, work);
  facts.timings["the copy made safe (restore, strip, pause)"] = Date.now() - t0;
  facts.copy = { source: copy.source, tools: copy.capabilities, paused: copy.paused, schedules: copy.schedules, stripped: copy.stripped, "open builds": copy.openBuilds };
  say(`copy ready: ${copy.capabilities} tools, ${copy.paused} schedule(s) paused, removed ${JSON.stringify(copy.stripped)}`);
  const avoid = process.env.HEWN_PORT ? [Number(process.env.HEWN_PORT)] : [];
  const ports = await copyPorts(undefined, avoid);
  assertSpare([ports.port, ports.publicPort], avoid);
  facts.ports = ports;
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "HEWN_BROWSER"];
  const base = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  // Only these: nothing of a live Hewn's environment (a build service, a proxy secret, a metrics port) reaches the copy.
  const copyEnv = { ...base, HEWN_HOME: copy.home, HEWN_PORT: String(ports.port), HEWN_PUBLIC_PORT: String(ports.publicPort), HEWN_KEY_SOURCE: "file", HEWN_SCHEDULES: "off", HEWN_NETWORK: network };
  hewn = new CopyProcess({ ...copyEnv, SMOKE_TREE: tree, SMOKE_PUBLIC_PORT: String(ports.publicPort), SMOKE_NETWORK: network, SMOKE_STUB: stubFile });
  say(`starting ${treeRef} on ${ports.port}`);
  const c = new CopyClient(await hewn.start());
  const safe = await safety(c, copy.home, [ports.port, ports.publicPort]);
  results.push(safe);
  if (safe.status !== "pass") throw Object.assign(new Error(`a safety check failed: ${safe.items?.filter((i) => i.status !== "pass").map((i) => i.name).join(", ") ?? safe.summary}`), { abort: true });

  await sleep(3000);
  facts.memory.push(await checks.memory(c, "at rest, after start"));
  await c.signIn();
  // Twice: a first round's growth that the second doesn't repeat is a cache filling, not a leak.
  for (const round of ["", ", again"]) {
    facts.timings[`200 GETs of /api/capabilities (8 at a time)${round}`] = await checks.load(c, 200);
    facts.memory.push(await checks.memory(c, `after 200 GETs of /api/capabilities${round}`));
  }

  const tools = await checks.loadTools(c);
  const opened = await Browser.open(c);
  if (typeof opened === "string") say(`no browser: ${opened}`);
  else browser = opened;
  const r: checks.RunContext = { c, tree, out, env: copyEnv, network, stubFile, logFile, timings: facts.timings, memory: facts.memory, browser, tools, changeTool: checks.pickTool(tools, o.tool) };
  if (o.tool && !r.changeTool) throw new Error(`no tool ${o.tool} in the copy`);

  for (const run of [checks.processes, checks.doctor, checks.readiness, checks.widgets, checks.readOps, checks.pages, checks.changeAndRollback, checks.stopAndRetry]) {
    const res = await run(r);
    say(`${res.status.padEnd(4)} ${res.title}: ${res.summary}`);
    results.push(res);
  }
  facts.memory.push(await checks.memory(c, "after the checks"));

  if (o.scenarios) {
    for (const file of scenarioFiles(o.scenarios)) {
      const res = await runScenario(file, (steps, shots): ScenarioContext => {
        let watched: Awaited<ReturnType<Browser["signedIn"]>> | undefined;
        let seen = 0;
        return {
          copy: c,
          tool: r.changeTool?.id,
          log: (l) => say(`  ${l}`),
          stub: {
            events: (id) => stubEvents(stubFile).filter((e) => !id || e.buildId === id),
            waitFor: (id, event, ms) => checks.stubEvent(stubFile, id, event, ms),
          },
          waitBuild: (id, ms) => checks.waitBuild(c, id, ms),
          page: async (hash = "#/") => {
            if (!browser) throw new Error("no browser on this machine (see the report's Pages check)");
            watched ??= await browser.signedIn();
            await watched.page.goto(`${c.origin}/${hash}`);
            return watched.page;
          },
          shot: async (name) => {
            if (!watched) throw new Error("no page open to take a screenshot of");
            const rel = `shots/scenario-${basename(file).replace(/\.\w+$/, "")}-${name.replace(/[^\w-]+/g, "-")}.png`;
            await watched.page.screenshot({ path: join(out, rel) });
            shots.push(rel);
          },
          step: async (name, fn) => {
            const t0 = Date.now();
            seen = watched?.errors.length ?? 0;
            try {
              await fn();
              const errs = watched?.errors.slice(seen) ?? [];
              if (errs.length) throw new Error(errs.slice(0, 3).join(" · "));
              steps.push({ name, status: "pass", ms: Date.now() - t0 });
            } catch (e) {
              steps.push({ name, status: "fail", reason: (e as Error).message.slice(0, 400), ms: Date.now() - t0 });
              throw e;
            }
          },
        };
      });
      facts.scenarios.push(res.title.replace(/^Scenario: /, ""));
      say(`${res.status.padEnd(4)} ${res.title}: ${res.summary}`);
      results.push(res);
    }
  }

  const restart = await restartCycle(r);
  say(`${restart.status.padEnd(4)} ${restart.title}: ${restart.summary}`);
  results.push(restart);
} catch (e) {
  facts.aborted ??= (e as Error).message;
  say(`stopped: ${facts.aborted}`);
  exitCode = 2;
}
await finish(exitCode);
