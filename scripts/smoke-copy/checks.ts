// SPDX-License-Identifier: AGPL-3.0-or-later
// The fixed checks of a smoke run. Each returns a CheckResult; none throws (a check that can't run says so).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, HOME_READY, type Watched } from "./browser.ts";
import type { CopyClient } from "./client.ts";
import { type CheckResult, type Item, type RunFacts, type Status, worst } from "./report.ts";
import { sleep, stubEvents } from "./scenario.ts";

/** A tool of the copy as the checks see it: its manifest and readiness, and its live version. */
export interface Tool {
  id: string;
  name: string;
  ready: boolean;
  version?: number;
  manifest: any;
  status: any;
}

export interface RunContext {
  c: CopyClient;
  tree: string;
  out: string;
  /** The copy's environment for the tree's CLI (`hewn doctor`). */
  env: NodeJS.ProcessEnv;
  network: "off" | "get";
  stubFile: string;
  logFile: string;
  timings: RunFacts["timings"];
  memory: RunFacts["memory"];
  browser?: Browser;
  tools: Tool[];
  /** The tool changes are made on. */
  pick?: Tool;
}

const TERMINAL = new Set(["promoted", "failed", "cancelled", "review"]);

/** Wait until `fn` holds, or throw after `ms`. */
export async function until(what: string, fn: () => boolean | Promise<boolean>, ms: number) {
  for (const end = Date.now() + ms; !(await Promise.resolve().then(fn).catch(() => false)); await sleep(250)) if (Date.now() > end) throw new Error(`${what}: not within ${ms / 1000} s`);
}

/** Run `fn` as a check: its time, and a failure if it throws. */
export async function check(id: string, title: string, fn: () => Promise<Omit<CheckResult, "id" | "title" | "ms">>): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    return { id, title, ...(await fn()), ms: Date.now() - t0 };
  } catch (e) {
    return { id, title, status: "fail", summary: `couldn't run: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
}

const counts = (items: Item[]) => {
  const n = (s: Status) => items.filter((i) => i.status === s).length;
  return [`${n("pass")} passed`, n("fail") && `${n("fail")} failed`, n("warn") && `${n("warn")} warned`, n("skip") && `${n("skip")} skipped`].filter(Boolean).join(", ");
};

/** Run `fn` over `xs`, `n` at a time. */
async function pool<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]);
    }
  }));
  return out;
}

export async function loadTools(c: CopyClient): Promise<Tool[]> {
  const list = (await c.call<any[]>("list")) ?? [];
  const versions = new Map(((await c.admin<{ capabilities: { id: string; version?: number }[] }>("status")).capabilities ?? []).map((x) => [x.id, x.version]));
  return pool(list, 8, async (x) => {
    const g = await c.call<any>("get", x.id);
    const { status, ...manifest } = g;
    return { id: x.id, name: x.name ?? x.id, ready: !!x.ready, version: versions.get(x.id), manifest, status };
  });
}

const isConnection = (t: Tool) => t.manifest.kind === "connection";
const hostsOf = (t: Tool): string[] => t.manifest.requires?.hosts ?? [];
const calleesOf = (t: Tool, all: Tool[]): Tool[] => (t.manifest.requires?.capabilities ?? []).map((r: { id: string }) => all.find((x) => x.id === r.id)).filter(Boolean) as Tool[];

/** Whether a call into `t` may go out to the network (its own hosts, or a tool it calls). */
function reachesNetwork(t: Tool, all: Tool[], seen = new Set<string>()): boolean {
  if (seen.has(t.id)) return false;
  seen.add(t.id);
  return hostsOf(t).length > 0 || calleesOf(t, all).some((x) => reachesNetwork(x, all, seen));
}

/** Why a tool isn't ready, when it's only what a copy lacks (a skip); undefined when it's something else (a failure). */
function copyLacks(t: Tool): string | undefined {
  const s = t.status ?? {};
  const other = [...(s.missingConfig ?? []), ...(s.missingDependencies ?? [])].length || s.unsupportedAbi || s.suspended || s.retiredModel;
  if (other) return undefined;
  if (isConnection(t) && s.missingSecrets?.length) return "a connection: its sign-in is gone on the copy (no secrets), so it needs signing in again";
  if (s.missingSecrets?.length) return `needs a secret the copy hasn't got (${s.missingSecrets.join(", ")})`;
  if (s.missingModel) return "needs a model, and the copy has no model keys";
  if (s.onlySaidNo) return "only what the owner said no to stands in the way (as on the source)";
  if (s.pendingGrants?.length) return `waiting for the owner's grant (as on the source): ${s.pendingGrants.join(", ")}`;
  return undefined;
}

function notReadyReason(t: Tool): string {
  const s = t.status ?? {};
  return [
    s.missingConfig?.length && `config not set: ${s.missingConfig.join(", ")}`,
    s.missingDependencies?.length && `calls what isn't there: ${s.missingDependencies.join(", ")}`,
    s.unsupportedAbi && `needs ABI ${s.unsupportedAbi}`,
    s.suspended && `suspended: ${s.suspended.reason}`,
    s.retiredModel && `its model ${s.retiredModel.model} was retired`,
    s.missingSecrets?.length && `secrets: ${s.missingSecrets.join(", ")}`,
    s.pendingGrants?.length && `grants: ${s.pendingGrants.join(", ")}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Before a call: why it can't run on a copy (a skip), or undefined. */
function cantRun(t: Tool, all: Tool[]): string | undefined {
  if (!t.ready) return copyLacks(t) ?? `not ready: ${notReadyReason(t)}`;
  if (t.manifest.requires?.model) return "needs a model, and the copy has no model keys";
  const callee = calleesOf(t, all).find((x) => !x.ready);
  if (callee) return isConnection(callee) ? `calls ${callee.id}, a connection whose sign-in is gone on the copy` : `calls ${callee.id}, which isn't ready on the copy`;
  return undefined;
}

/** After a failed call: a skip when it's what a copy can't do (the network), else a failure. */
function failedCall(t: Tool, all: Tool[], network: RunContext["network"], message: string): Item["status"] {
  if (/egress denied|network is off|HEWN_NETWORK/.test(message)) return "skip";
  if (network === "off" && reachesNetwork(t, all)) return "skip";
  if (/not_ready/.test(message) && calleesOf(t, all).some((x) => !x.ready)) return "skip";
  return "fail";
}
const networkReason = (t: Tool, all: Tool[], network: RunContext["network"], message: string) =>
  network === "off" ? `network off: it reaches ${[...new Set([t, ...calleesOf(t, all)].flatMap(hostsOf))].join(", ") || "the network"}` : /only GET and HEAD/.test(message) ? "it posts, and the copy lets only GET and HEAD out (--network)" : `not run on the copy: ${message.slice(0, 160)}`;

// ---------- the checks ----------

/** What `hewn doctor` warns about on any copy: its key is a file (no Keychain entry for a throwaway home), and agents point at the live Hewn. */
const COPY_WARNINGS = [/^! Secrets key\s+kept in a file/, /^! .*registered at .*another Hewn/];

export const doctor = (r: RunContext) =>
  check("doctor", "hewn doctor", async () => {
    const p = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(r.tree, "packages/cli/src/cli.ts"), "doctor"], { cwd: r.tree, env: r.env, encoding: "utf8", timeout: 90_000 });
    const lines = `${p.stdout}${p.stderr}`.split("\n").filter((l) => l.trim());
    const bad = lines.filter((l) => /^\s*(✖|✗|x |FAIL)/.test(l));
    const warn = lines.filter((l) => /^\s*(!|⚠)/.test(l));
    const unexpected = warn.filter((l) => !COPY_WARNINGS.some((re) => re.test(l.trim())));
    return {
      status: p.status !== 0 ? "fail" : unexpected.length ? "warn" : "pass",
      summary: p.status !== 0 ? `exit ${p.status ?? p.signal}: ${bad.length} failure(s)` : `no problems; ${warn.length - unexpected.length} warning(s) every copy gets (its key is a file, agents point at the live Hewn)${unexpected.length ? `, ${unexpected.length} other` : ""}`,
      details: lines,
    };
  });

export const processes = (r: RunContext) =>
  check("processes", "Both processes up", async () => {
    const st = await r.c.control<any>("status");
    const alive = (pid: number | null) => !!pid && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    const items: Item[] = [
      { name: "supervisor", status: alive(st.pid) ? "pass" : "fail", reason: `pid ${st.pid}` },
      { name: "platform (workerd)", status: alive(st.workerdPid) && (await r.c.health()) ? "pass" : "fail", reason: `pid ${st.workerdPid}` },
      { name: "tools (workerd)", status: alive(st.toolsPid) ? "pass" : "fail", reason: `pid ${st.toolsPid}` },
      { name: "the sandbox", status: st.sandbox ? "pass" : "fail", reason: st.sandbox ? "on" : "OFF" },
    ];
    return { status: worst(items.map((i) => i.status)), summary: `supervisor ${st.pid}, platform ${st.workerdPid}, tools ${st.toolsPid}; restarts ${st.restarts}/${st.toolsRestarts}; schedules ${st.schedules}, network ${st.network}`, items };
  });

export const readiness = (r: RunContext) =>
  check("ready", "Every tool ready", async () => {
    // Suspended before any call ran here: so it was in the source (the owner resumes it there), not this run's doing.
    const item = (t: Tool): Item =>
      t.ready ? { name: t.id, status: "pass" } : copyLacks(t) ? { name: t.id, status: "skip", reason: copyLacks(t) } : t.status?.suspended && !notReadyReason({ ...t, status: { ...t.status, suspended: undefined } }) ? { name: t.id, status: "warn", reason: `suspended in the source: ${t.status.suspended.reason}` } : { name: t.id, status: "fail", reason: notReadyReason(t) || "not ready" };
    const items = r.tools.map(item);
    return { status: worst(items.map((i) => i.status)), summary: `${r.tools.length} tools: ${counts(items)}`, items };
  });

export const widgets = (r: RunContext) =>
  check("widgets", "Every widget renders", async () => {
    const jobs = r.tools.flatMap((t) => (t.manifest.widgets ?? []).map((w: any) => ({ t, w })));
    const items = await pool(jobs, 4, async ({ t, w }): Promise<Item> => {
      const name = `${t.id} · ${w.name}`;
      const skip = cantRun(t, r.tools);
      if (skip) return { name, status: "skip", reason: skip };
      const op = (t.manifest.operations ?? []).find((o: any) => `${o.name}@${o.version}` === w.operation || o.name === w.operation);
      if (op?.inputSchema?.required?.length) return { name, status: "skip", reason: "needs input" };
      const t0 = Date.now();
      try {
        const view = await r.c.api("POST", "/api/home/preview", { id: t.id, widget: w.name, input: {} });
        const v = view?.view ?? view;
        if (!v || typeof v !== "object") return { name, status: "fail", reason: `no view: ${JSON.stringify(view).slice(0, 160)}` };
        return { name, status: "pass", ms: Date.now() - t0 };
      } catch (e) {
        const m = (e as Error).message;
        const st = failedCall(t, r.tools, r.network, m);
        return { name, status: st, reason: st === "skip" ? networkReason(t, r.tools, r.network, m) : m.slice(0, 300) };
      }
    });
    return { status: worst(items.map((i) => i.status)), summary: `${items.length} widgets: ${counts(items)}`, items };
  });

export const readOps = (r: RunContext) =>
  check("reads", "Every read operation with no required input runs", async () => {
    const widgetOps = (t: Tool) => new Set((t.manifest.widgets ?? []).map((w: any) => String(w.operation).split("@")[0]));
    const jobs = r.tools.flatMap((t) =>
      (t.manifest.operations ?? [])
        .filter((o: any) => o.sideEffect === "read" && !o.deprecated && !(o.inputSchema?.required?.length) && !widgetOps(t).has(o.name) && !(isConnection(t) && o.name === "connect"))
        .map((o: any) => ({ t, o })),
    );
    let fastest: { t: Tool; o: any; ms: number } | undefined;
    const items = await pool(jobs, 4, async ({ t, o }): Promise<Item> => {
      const name = `${t.id} · ${o.name}@${o.version}`;
      const skip = cantRun(t, r.tools);
      if (skip) return { name, status: "skip", reason: skip };
      const t0 = Date.now();
      try {
        await r.c.admin("invoke", { capabilityId: t.id, operation: o.name, operationVersion: o.version, input: {} }, 60_000);
        const ms = Date.now() - t0;
        if (!reachesNetwork(t, r.tools) && (!fastest || ms < fastest.ms)) fastest = { t, o, ms };
        return { name, status: "pass", ms };
      } catch (e) {
        const m = (e as Error).message;
        const st = failedCall(t, r.tools, r.network, m);
        return { name, status: st, reason: st === "skip" ? networkReason(t, r.tools, r.network, m) : m.slice(0, 300) };
      }
    });
    if (fastest) r.timings[`a tool call, as the owner (${fastest.t.id} · ${fastest.o.name})`] = fastest.ms;
    // An agent's call of the same operation over MCP: signed in, its session, the call.
    if (fastest) {
      const a = await r.c.agent("smoke-agent", ["discover", "invoke"]);
      try {
        const t0 = Date.now();
        await a.tool("capabilities_invoke", { capabilityId: fastest.t.id, operation: fastest.o.name, input: {} });
        r.timings[`a tool call over MCP (${fastest.t.id} · ${fastest.o.name})`] = Date.now() - t0;
      } finally {
        await a.close();
      }
    }
    const needInput = r.tools.reduce((n, t) => n + (t.manifest.operations ?? []).filter((o: any) => o.sideEffect === "read" && o.inputSchema?.required?.length).length, 0);
    return { status: worst(items.map((i) => i.status)), summary: `${items.length} read operations: ${counts(items)} (${needInput} need input: not run)`, items };
  });

/** Pages in the browser, with no console errors, and a screenshot of each. */
export const pages = (r: RunContext) =>
  check("pages", "Pages load with no console errors", async () => {
    if (!r.browser) return { status: "skip", summary: "no browser" };
    const items: Item[] = [];
    const shots: string[] = [];
    const t0 = Date.now();
    const w = await r.browser.signedIn();
    await w.page.goto(`${r.c.origin}/#/`);
    await w.page.waitForSelector(HOME_READY, { timeout: 30_000 });
    r.timings["the first Home (signed in to drawn)"] = Date.now() - t0;
    const shoot = async (w: Watched, name: string, title: string, before = 0) => {
      await sleep(800);
      const file = `shots/${name}.png`;
      await w.page.screenshot({ path: join(r.out, file) });
      shots.push(file);
      const errs = w.errors.slice(before);
      items.push({ name: title, status: errs.length ? "fail" : "pass", ...(errs.length ? { reason: errs.slice(0, 5).join(" · ") } : {}) });
    };
    await shoot(w, "home", "Home");
    let n = w.errors.length;
    await w.page.click(".inbox-btn");
    await w.page.waitForSelector(".inbox-panel", { state: "visible", timeout: 10_000 });
    await shoot(w, "inbox", "Inbox", n);
    await w.page.keyboard.press("Escape");
    const tool = r.pick ?? r.tools.find((t) => t.ready) ?? r.tools[0];
    for (const [hash, name, title] of [...(tool ? [[`#/c/${encodeURIComponent(tool.id)}`, "info", `A tool's Info (${tool.id})`]] : []), ["#/activity", "activity", "Activity"], ["#/settings", "settings", "Settings"]] as [string, string, string][]) {
      n = w.errors.length;
      await w.page.goto(`${r.c.origin}/${hash}`);
      await w.page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await shoot(w, name, title, n);
    }
    await w.page.context().close();
    return { status: worst(items.map((i) => i.status)), summary: `${items.length} pages: ${counts(items)}`, items, shots };
  });

/** The tool changes are made on: ready, its own code only (no network, model or other tools), with a screen if one has. */
export function pickTool(tools: Tool[], wanted?: string): Tool | undefined {
  if (wanted) return tools.find((t) => t.id === wanted);
  const plain = tools.filter((t) => t.ready && !isConnection(t) && !t.manifest.requires?.model && !hostsOf(t).length && !(t.manifest.requires?.capabilities ?? []).length && t.version);
  return plain.find((t) => t.manifest.ui?.available) ?? plain[0];
}

async function waitBuild(c: CopyClient, buildId: string, ms = 300_000): Promise<any> {
  for (const end = Date.now() + ms; ; await sleep(500)) {
    const b = await c.call("getBuild", buildId);
    if (TERMINAL.has(b.status)) return b;
    if (Date.now() > end) throw new Error(`build ${buildId} still ${b.status} after ${ms / 1000} s`);
  }
}
export { waitBuild };

/** Back to `version` (when the tool isn't there already). */
async function backTo(c: CopyClient, id: string, version: number) {
  const now = (await c.admin<{ capabilities: { id: string; version?: number }[] }>("status")).capabilities.find((x) => x.id === id)?.version;
  if (now !== version) await c.admin("rollback", { capabilityId: id, version });
}

export const changeAndRollback = (r: RunContext) =>
  check("change", "A change goes live (stub builder), then a rollback", async () => {
    const t = r.pick;
    if (!t?.version) return { status: "skip", summary: "no tool fits (ready, its own code only)" };
    const items: Item[] = [];
    const t0 = Date.now();
    const b = await r.c.admin("modify", { capabilityId: t.id, request: "Smoke run: a trivial edit (the stub builder adds a comment).", wait: true }, 330_000);
    r.timings[`a change build, request to live (${t.id})`] = Date.now() - t0;
    items.push({ name: `change ${t.id} v${t.version}`, status: b.status === "promoted" ? "pass" : "fail", reason: b.status === "promoted" ? `v${b.resultVersion}, ${b.tests ? `${b.tests.passed}/${b.tests.total} test cases` : "no test cases"}` : `${b.status}: ${b.failure?.message ?? b.log?.slice(-3).join(" | ")}` });
    if (b.status === "promoted") {
      const rb = await r.c.admin("rollback", { capabilityId: t.id, version: t.version });
      const now = (await r.c.admin<{ capabilities: { id: string; version?: number }[] }>("status")).capabilities.find((x) => x.id === t.id)?.version;
      items.push({ name: "rollback", status: now === t.version ? "pass" : "fail", reason: `v${rb.from} → v${rb.to}, live: v${now}` });
      const call = (t.manifest.operations ?? []).find((o: any) => o.sideEffect === "read" && !o.inputSchema?.required?.length);
      if (call) {
        try {
          await r.c.admin("invoke", { capabilityId: t.id, operation: call.name, operationVersion: call.version, input: {} }, 60_000);
          items.push({ name: `a call after the rollback (${call.name})`, status: "pass" });
        } catch (e) {
          items.push({ name: `a call after the rollback (${call.name})`, status: "fail", reason: (e as Error).message.slice(0, 300) });
        }
      }
    }
    return { status: worst(items.map((i) => i.status)), summary: `${t.id}: ${items.map((i) => `${i.name} ${i.status}`).join(", ")}`, items };
  });

export const stopAndRetry = (r: RunContext) =>
  check("retry", "Stop a build mid-way, then Retry: it carries on", async () => {
    const t = r.pick;
    if (!t?.version) return { status: "skip", summary: "no tool fits (ready, its own code only)" };
    const items: Item[] = [];
    const started = await r.c.admin("modify", { capabilityId: t.id, request: "Smoke run [smoke:slow]: work slowly until stopped." });
    const id = started.buildId as string;
    await until("the stub builder starts working", () => stubEvents(r.stubFile).some((e) => e.buildId === id && e.event === "waiting"), 120_000);
    items.push({ name: "the build is working", status: "pass", reason: id });
    await r.c.call("cancelBuild", id);
    await until("the build stops", async () => (await r.c.call("getBuild", id)).status === "cancelled", 30_000);
    // Its builder told to stop, as the owner sees it stop before pressing Start again.
    const told = await until("the builder is told to stop", () => stubEvents(r.stubFile).some((e) => e.buildId === id && e.event === "stopped"), 10_000).then(() => true, () => false);
    items.push({ name: "Stop", status: told ? "pass" : "fail", reason: told ? "cancelled; its builder stopped" : "cancelled, but its builder wasn't told to stop within 10 s" });
    const t0 = Date.now();
    const retry = await r.c.call("retryBuild", id);
    const done = await waitBuild(r.c, retry.buildId);
    r.timings[`a retry that carries on, to live (${t.id})`] = Date.now() - t0;
    const start = stubEvents(r.stubFile).find((e) => e.buildId === retry.buildId && e.event === "start");
    const carried = stubEvents(r.stubFile).some((e) => e.buildId === retry.buildId && e.event === "carried-on");
    items.push({ name: "Retry carries on", status: start?.carriesOn === "stopped" && start.foundProgress && carried ? "pass" : "fail", reason: `carriesOn: ${start?.carriesOn ?? "unset"}; the stopped build's work ${start?.foundProgress ? "was" : "wasn't"} in the workspace` });
    items.push({ name: "the retry goes live", status: done.status === "promoted" ? "pass" : "fail", reason: done.status === "promoted" ? `v${done.resultVersion}` : `${done.status}: ${done.failure?.message ?? ""}` });
    await backTo(r.c, t.id, t.version);
    return { status: worst(items.map((i) => i.status)), summary: items.map((i) => `${i.name}: ${i.status}`).join(", "), items };
  });

/** RSS (MB) of each process. */
export async function memory(c: CopyClient, label: string): Promise<RunFacts["memory"][number]> {
  const st = await c.control<any>("status");
  const rss = (pid: number | null) => {
    if (!pid) return 0;
    const p = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    return Math.round(Number(p.stdout.trim() || 0) / 1024);
  };
  return { label, supervisor: rss(st.pid), platform: rss(st.workerdPid), tools: rss(st.toolsPid) };
}

/** `n` GETs of /api/capabilities (8 at a time), as an open web client makes. */
export async function load(c: CopyClient, n: number): Promise<number> {
  const t0 = Date.now();
  await pool(Array.from({ length: n }, (_, i) => i), 8, async () => {
    const res = await c.web("GET", "/api/capabilities");
    if (res.status !== 200) throw new Error(`/api/capabilities: HTTP ${res.status}`);
  });
  return Date.now() - t0;
}

/**
 * Error lines every copy has, with why: the platform's own fetches are refused (the network is off for it), so its
 * model catalog refresh fails; a check's own doing (it kills both workerds).
 */
export const EXPECTED_LINES: [RegExp, string][] = [
  [/connect\(\) blocked by restrictPeers\(\)/, "the platform's own fetch refused: its network is off on a copy"],
  [/model catalog refresh failed/, "the model catalog can't be fetched: the platform's network is off on a copy"],
];

/** Error lines in the copy's log: jsg, ERROR, unhandled. The ones every copy has are listed apart. */
export const logScan = (r: Pick<RunContext, "logFile">) =>
  check("log", "The log has no error lines", async () => {
    const lines = existsSync(r.logFile) ? readFileSync(r.logFile, "utf8").split("\n") : [];
    const bad = lines.filter((l) => /\bjsg\b|\bERROR\b|unhandled|model catalog refresh failed/i.test(l)).map((l) => l.replace(/^\[[^\]]+\] /, ""));
    const expected = new Map<string, number>();
    const other: string[] = [];
    for (const l of bad) {
      const why = EXPECTED_LINES.find(([re]) => re.test(l))?.[1];
      if (why) expected.set(why, (expected.get(why) ?? 0) + 1);
      else other.push(l);
    }
    const unique = [...new Set(other)];
    const details = [...unique.slice(0, 40), ...[...expected].map(([why, n]) => `(expected on a copy, ${n}×) ${why}`)];
    return { status: other.length ? "fail" : "pass", summary: other.length ? `${other.length} error line(s) (${unique.length} different) in ${lines.length}` : `${lines.length} lines, no error but ${[...expected.values()].reduce((a, b) => a + b, 0)} every copy has`, details };
  });
