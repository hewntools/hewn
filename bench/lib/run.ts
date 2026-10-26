// SPDX-License-Identifier: AGPL-3.0-or-later
// Running a bench: every (arm, case, repetition) is a result, built and captured in a process of its own
// in <run>/results/<arm>/<case>/r<n>/. A run can be stopped and started again: finished results are kept.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { USER } from "@hewntools/core/auth.ts";
import type { BuildView } from "@hewntools/core/platform.ts";
import { ARMS, briefFor, CRITIQUE_REQUEST, othersNote, runOrder, type Arm } from "./arms.ts";
import { DESKTOP, launchBrowser, overflowX, PHONE, clickThrough, type ClickResult, type Page } from "./browser.ts";
import { loadCases, seedKit } from "./cases.ts";
import { builderUsage, uiMetrics, type BuilderUsage, type UiMetrics } from "./metrics.ts";
import { benchPlatform, caller, exportVersion, served, settle, type BenchPlatform } from "./platform.ts";
import { startUiServer, type Served } from "./ui-server.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const BENCH = join(REPO, "bench", "bench.ts");

export interface Job {
  arm: string;
  case: string;
  rep: number;
  /** The brief file this result builds on. */
  brief: string;
  model?: string;
  effort?: string;
  critique?: boolean;
  /** The result this one starts from (its built, seeded tool). */
  from?: string;
  /** Results whose tools count as the owner's other tools (a sequential arm's earlier cases). */
  others?: string[];
  sandbox: boolean;
}

export interface Result {
  arm: string;
  case: string;
  rep: number;
  status: "done" | "failed";
  /** Why it failed: the build's last log lines, or the error. */
  error?: string;
  capabilityId?: string;
  builds: { buildId: string; kind: string; status: string; attempts: number; tests?: { passed: number; total: number } }[];
  usage?: BuilderUsage;
  ui?: UiMetrics;
  seedError?: string;
  /** Errors on the page per viewport, with the seeded data. */
  pageErrors?: Record<string, string[]>;
  apiErrors?: Record<string, string[]>;
  /** CSS px the phone layout sticks out sideways. */
  overflowMobile?: number;
  clicks?: ClickResult;
  startedAt: string;
  finishedAt?: string;
}

export const resultFile = (dir: string) => join(dir, "result.json");
export const readResult = (dir: string): Result | undefined => (existsSync(resultFile(dir)) ? JSON.parse(readFileSync(resultFile(dir), "utf8")) : undefined);

/** The environment a result's process gets: yours, without a calling Claude Code session's own settings (its effort would leak into the builder). */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const session = /^(CLAUDECODE|CLAUDE_EFFORT|CLAUDE_PID|CLAUDE_JOB_DIR|CLAUDE_PLUGIN_\w+|CLAUDE_CODE_(ENTRYPOINT|SESSION_\w+|CHILD_SESSION|FORCE_SESSION_PERSISTENCE|MESSAGING_\w+|BRIDGE_SESSION_ID|EXECPATH))$/;
  return Object.fromEntries(Object.entries(env).filter(([k]) => !session.test(k)));
}

/** Claude Code refuses to write under a .claude directory, which would fail every build. */
export function checkOut(dir: string) {
  if (/(^|\/)\.claude(\/|$)/.test(resolve(dir))) throw new Error(`the bench output can't be inside a .claude directory (${dir}): Claude Code won't write there. Use --out or HEWN_BENCH_DIR.`);
}

// --- the parent: plan the results and run them ---------------------------------------------------

export interface RunOptions {
  out: string;
  name: string;
  arms: string[];
  cases?: string[];
  reps: number;
  concurrency: number;
  sandbox: boolean;
  log?: (line: string) => void;
}

const sh = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

export async function runBench(o: RunOptions): Promise<string> {
  checkOut(o.out);
  const log = o.log ?? console.log;
  const runDir = join(resolve(o.out), o.name);
  mkdirSync(join(runDir, "briefs"), { recursive: true });
  const arms = runOrder(o.arms);
  const cases = await loadCases(o.cases);
  const current = readFileSync(join(REPO, "spec", "builder-brief.md"), "utf8");
  const briefs: Record<string, string> = {};
  for (const arm of arms) {
    const text = briefFor(arm, current);
    const file = join(runDir, "briefs", `${arm.from ?? arm.name}.md`);
    writeFileSync(file, text);
    briefs[arm.name] = file;
  }
  const meta = {
    name: o.name,
    startedAt: new Date().toISOString(),
    commit: sh("git", ["rev-parse", "--short", "HEAD"]),
    dirty: !!sh("git", ["status", "--porcelain", "--", "spec", "packages", "bench"]),
    briefSha: createHash("sha256").update(current).digest("hex").slice(0, 12),
    claude: sh("claude", ["--version"]),
    arms: arms.map((a) => ({ name: a.name, about: a.about, model: a.model, effort: a.effort, from: a.from, critique: a.critique })),
    cases: cases.map((c) => c.id),
    reps: o.reps,
    sandbox: o.sandbox,
  };
  const metaFile = join(runDir, "run.json");
  const before = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : undefined;
  writeFileSync(metaFile, JSON.stringify({ ...before, ...meta, startedAt: before?.startedAt ?? meta.startedAt, arms: mergeBy(before?.arms, meta.arms), cases: [...new Set([...(before?.cases ?? []), ...meta.cases])] }, null, 2));

  interface Planned {
    dir: string;
    job: Job;
    /** Results that must be done first: the base it starts from, and a sequential arm's earlier cases. */
    after: string[];
  }
  const planned: Planned[] = [];
  const resultDir = (arm: string, c: string, rep: number) => join(runDir, "results", arm, c, `r${rep}`);
  for (const arm of arms)
    for (let rep = 1; rep <= o.reps; rep++)
      cases.forEach((c, i) => {
        const dir = resultDir(arm.name, c.id, rep);
        const from = arm.from ? resultDir(arm.from, c.id, rep) : undefined;
        const others = arm.sequential ? cases.slice(0, i).map((e) => resultDir(arm.name, e.id, rep)) : undefined;
        const after = [...(from ? [from] : []), ...(others?.length ? [others.at(-1)!] : [])];
        planned.push({ dir, after, job: { arm: arm.name, case: c.id, rep, brief: briefs[arm.name], model: arm.model, effort: arm.effort, critique: arm.critique, from, ...(others ? { others } : {}), sandbox: o.sandbox } });
      });
  const todo = planned.filter((p) => readResult(p.dir)?.status !== "done");
  log(`${planned.length} results, ${planned.length - todo.length} already done; running ${todo.length}, ${o.concurrency} at a time → ${runDir}`);

  const running = new Set<Promise<void>>();
  const finished = new Set<string>(planned.filter((p) => !todo.includes(p)).map((p) => p.dir));
  const waiting = [...todo];
  const label = (p: Planned) => `${p.job.arm} / ${p.job.case} / r${p.job.rep}`;
  while (waiting.length || running.size) {
    const ready = waiting.findIndex((p) => p.after.every((a) => finished.has(a) || !planned.some((q) => q.dir === a)));
    if (ready >= 0 && running.size < o.concurrency) {
      const [p] = waiting.splice(ready, 1);
      // A sequential arm goes on past an earlier case that failed (it's just not among the others); a missing base stops it.
      if (p.job.from && readResult(p.job.from)?.status !== "done") {
        mkdirSync(p.dir, { recursive: true });
        writeFileSync(resultFile(p.dir), JSON.stringify({ arm: p.job.arm, case: p.job.case, rep: p.job.rep, status: "failed", error: `its base (${p.job.from}) didn't finish`, builds: [], startedAt: new Date().toISOString() } satisfies Result, null, 2));
        finished.add(p.dir);
        log(`skip ${label(p)}: its base failed`);
        continue;
      }
      log(`start ${label(p)}`);
      const t = runChild(p.dir, p.job).then((r) => {
        finished.add(p.dir);
        running.delete(t);
        log(`${r?.status === "done" ? "done " : "FAIL "} ${label(p)}${r?.usage ? ` (${r.usage.minutes} min, $${r.usage.usd})` : ""}${r?.error ? `: ${r.error.split("\n")[0].slice(0, 160)}` : ""}`);
      });
      running.add(t);
      continue;
    }
    if (!running.size) break;
    await Promise.race(running);
  }
  return runDir;
}

function mergeBy<T extends { name: string }>(a: T[] | undefined, b: T[]): T[] {
  const out = [...(a ?? [])];
  for (const x of b) {
    const i = out.findIndex((y) => y.name === x.name);
    i >= 0 ? (out[i] = x) : out.push(x);
  }
  return out;
}

function runChild(dir: string, job: Job): Promise<Result | undefined> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job.json"), JSON.stringify(job, null, 2));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BENCH, "one", dir], { cwd: REPO, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const out = (d: Buffer) => appendFileSync(join(dir, "run.log"), d);
    child.stdout.on("data", out);
    child.stderr.on("data", out);
    // A result that hangs (a stuck browser, a builder past its attempts) doesn't hold the run forever.
    const timer = setTimeout(() => child.kill("SIGKILL"), 75 * 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      let r = readResult(dir);
      if (!r) {
        r = { arm: job.arm, case: job.case, rep: job.rep, status: "failed", error: `the result's process exited with ${code} (see run.log)`, builds: [], startedAt: new Date().toISOString() };
        writeFileSync(resultFile(dir), JSON.stringify(r, null, 2));
      }
      resolve(r);
    });
  });
}

// --- the child: one result -----------------------------------------------------------------------

/** The finished tools among `dirs`: name, hue and saturation from the manifest, and the look the builder recorded. */
export function otherTools(dirs: string[] = []): { name: string; hue?: number; saturation?: number; look?: unknown }[] {
  const read = (f: string) => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return undefined;
    }
  };
  return dirs
    .filter((d) => readResult(d)?.status === "done" && existsSync(join(d, "version", "capability.json")))
    .map((d) => {
      const m = read(join(d, "version", "capability.json"));
      return { name: m?.name ?? d, ...(Number.isInteger(m?.hue) ? { hue: m.hue } : {}), ...(Number.isInteger(m?.saturation) ? { saturation: m.saturation } : {}), look: read(join(d, "version", "ui", "look.json")) };
    });
}

const buildSummary = (v: BuildView, transcripts: string) => ({
  buildId: v.buildId,
  kind: v.kind,
  status: v.status,
  attempts: existsSync(transcripts) ? readdirSync(transcripts).filter((f) => f.startsWith(`${v.buildId}-`) && f.endsWith(".log")).length : 0,
  ...(v.tests ? { tests: v.tests } : {}),
});

export async function runOne(dir: string): Promise<void> {
  const job: Job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
  const [c] = await loadCases([job.case]);
  const log = (line: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`);
  const result: Result = { arm: job.arm, case: job.case, rep: job.rep, status: "failed", builds: [], startedAt: new Date().toISOString() };
  const save = () => writeFileSync(resultFile(dir), JSON.stringify(result, null, 2));
  const home = join(dir, "home");
  const versionDir = join(dir, "version");
  if (job.from) cpSync(join(job.from, "home"), home, { recursive: true });
  const bp = benchPlatform(home, { brief: readFileSync(job.brief, "utf8"), model: job.model, effort: job.effort, sandbox: job.sandbox, transcripts: join(dir, "transcripts"), log: (l) => log(`[platform] ${l}`) });
  try {
    let build: BuildView;
    if (job.from) {
      const base = readResult(job.from)!;
      result.capabilityId = base.capabilityId;
      if (job.critique) {
        // The builder gets its own UI, with the data, as the owner sees it.
        for (const f of ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"]) {
          if (existsSync(join(job.from, "shots", `${f}.png`))) bp.extraFiles[`screenshots/${f}.png`] = join(job.from, "shots", `${f}.png`);
        }
        const started = await bp.platform.modify(USER, { capabilityId: base.capabilityId!, request: CRITIQUE_REQUEST + othersNote(otherTools(job.others)) });
        build = await settle(bp.platform, started.buildId);
      } else {
        throw new Error(`arm ${job.arm} starts from ${job.from} but does nothing to it`);
      }
    } else {
      const started = await bp.platform.create(USER, { name: c.name, purpose: c.purpose, requirements: c.requirements + othersNote(otherTools(job.others)) });
      result.capabilityId = started.capabilityId;
      build = await settle(bp.platform, started.buildId);
    }
    result.builds.push(buildSummary(build, join(dir, "transcripts")));
    result.usage = builderUsage((existsSync(join(dir, "transcripts")) ? readdirSync(join(dir, "transcripts")) : []).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, "transcripts", f)));
    if (build.status !== "promoted" || !build.resultVersion) {
      result.error = `build ${build.status}:\n${build.log.slice(-12).join("\n")}`;
      save();
      return;
    }
    const capabilityId = build.capabilityId;
    await exportVersion(bp.platform, capabilityId, build.resultVersion, versionDir);
    result.ui = uiMetrics(join(versionDir, "ui"));
    mkdirSync(join(dir, "shots"), { recursive: true });
    // The platform's own render check: the empty state, as the owner saw it on the build.
    for (const [from, to] of [[`${build.buildId}.png`, "empty-light.png"], [`${build.buildId}-dark.png`, "empty-dark.png"]]) {
      const f = join(home, "blobs", "screenshots", from);
      if (existsSync(f)) cpSync(f, join(dir, "shots", to));
    }
    if (!job.from) {
      try {
        await c.seed(seedKit(caller(bp.platform, capabilityId), [...job.case].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7)));
      } catch (e) {
        // A tool that doesn't take the spec's operations as written: a finding, and it's still shown with what got in.
        result.seedError = (e as Error).message;
        log(`seed failed: ${result.seedError}`);
      }
    }
    await capture(dir, bp, capabilityId, result);
    bp.close();
    // Clicks write: they run on a copy, so the seeded state stays as it was for the gallery.
    const scratch = join(dir, "home-clicks");
    rmSync(scratch, { recursive: true, force: true });
    cpSync(home, scratch, { recursive: true });
    const sp = benchPlatform(scratch);
    try {
      result.clicks = await withPage(served(sp.platform, capabilityId, versionDir), async (page, url) => clickThrough(page, url));
    } finally {
      sp.close();
      rmSync(scratch, { recursive: true, force: true });
    }
    result.status = "done";
  } catch (e) {
    result.error = (e as Error).stack ?? String(e);
  } finally {
    try {
      bp.close();
    } catch {
      // closed already
    }
    result.finishedAt = new Date().toISOString();
    save();
  }
}

async function withPage<T>(s: Served, fn: (page: Page, url: string) => Promise<T>): Promise<T> {
  const server = await startUiServer((k) => (k === "r" ? s : undefined));
  const browser = await launchBrowser();
  try {
    const page = await browser.page(DESKTOP);
    return await fn(page, server.url("r", s.id));
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Screenshots of the seeded UI: desktop and phone, light and dark, with the errors each showed. */
async function capture(dir: string, bp: BenchPlatform, capabilityId: string, result: Result) {
  const s = served(bp.platform, capabilityId, join(dir, "version"));
  const server = await startUiServer((k) => (k === "r" ? s : undefined));
  const browser = await launchBrowser();
  result.pageErrors = {};
  result.apiErrors = {};
  try {
    for (const v of [DESKTOP, PHONE]) {
      const page = await browser.page(v);
      for (const scheme of ["light", "dark"] as const) {
        await page.scheme(scheme);
        await page.goto(server.url("r", capabilityId));
        writeFileSync(join(dir, "shots", `${v.name}-${scheme}.png`), await page.shot());
        if (v === PHONE && scheme === "light") result.overflowMobile = await overflowX(page);
      }
      result.pageErrors[v.name] = [...new Set(page.errors)];
      result.apiErrors[v.name] = [...new Set(page.apiErrors)];
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Every result in a run directory. */
export function listResults(runDir: string): { dir: string; key: string; result?: Result; job?: Job }[] {
  const root = join(runDir, "results");
  if (!existsSync(root)) return [];
  const out: { dir: string; key: string; result?: Result; job?: Job }[] = [];
  const dirs = (d: string) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const arm of dirs(root))
    for (const c of dirs(join(root, arm)))
      for (const rep of dirs(join(root, arm, c))) {
        const dir = join(root, arm, c, rep);
        const job = existsSync(join(dir, "job.json")) ? (JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as Job) : undefined;
        out.push({ dir, key: createHash("sha256").update(`${arm}/${c}/${rep}`).digest("hex").slice(0, 10), result: readResult(dir), job });
      }
  return out;
}

export { ARMS, type Arm };
