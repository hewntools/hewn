// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, type FSWatcher, mkdirSync, readdirSync, realpathSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EFFORT } from "@hewntools/core/build-models.ts";
import { isArtefact } from "@hewntools/core/files.ts";
import { claudeActivity, codexActivity, opencodeActivity, USED_TOOL } from "./activity.ts";
import { MODEL_REJECTED, modelRejectReason, noteModelFailure, noteModelRan } from "./models.ts";
import { OPENCODE_NO_UPDATE, opencodeUserDirs } from "./opencode-dirs.ts";
import { wrapBuilder } from "./sandbox.ts";
import { builderEnv, OPENCODE_PROVIDER_ENV } from "./env.ts";
import { type AskCli, type BuilderVendor, builderHome, claudeEnv, claudeSignInIgnored, CODEX_FILE_LOGIN, codexEnv, notSignedIn, notSignedInWords, opencodeEnv, signedIn, signInCommand } from "./sign-in.ts";
import { CHECK_CLIENT_TIMEOUT_MS, CHECK_SERVER_NAME, type CheckServer, openCheck } from "./check.ts";
import type { BuildJob, CapabilityBuilder } from "./types.ts";

export { builderEnv, OPENCODE_PROVIDER_ENV };

export function builderPrompt(job: BuildJob): string {
  const lines = [
    `You are a builder for Hewn, a personal capability platform. Build ${job.buildId} (${job.kind} of capability '${job.capabilityId}').`,
    `Your current directory is the build workspace. Read BUILDER.md, the request, then BRIEF.md, all of it (in parts, if your reader cuts it short), before you write anything: it is the implementation contract, how to build for Hewn. Implement the request in place.`,
    `Only change files inside this directory. Do not try to start, call or promote anything on the platform. When the candidate is complete, stop. The platform validates it automatically.`,
  ];
  // Read the context that determines identity first; retries and passes keep the candidate's icon.
  if (job.kind === "create" && job.attempt === 1 && !job.retryOf && !job.pass) lines.push(`After reading BUILDER.md, BRIEF.md, and any OWNERS_WORDS.md and OTHER_TOOLS.md, write ui/icon.svg and set "hue" in capability.json as your first implementation changes (see "Icon" in BRIEF.md): the owner's Home shows the icon while you build.`);
  // A pass on a candidate already built (a fresh session: it couldn't resume the one that built it).
  if (job.pass) lines.push(`\nThe candidate in this workspace is built and passed validation: don't start over. Read BUILDER.md for the request and BRIEF.md for the contract, then do this ${job.pass.name} pass on it:\n\n${job.pass.request}`);
  // A retry carrying on from a failed build: its work is here (BUILDER.md says why it failed, if asked to fix that).
  if (job.carriesOn && job.attempt === 1) lines.push(`\nThis build carries on from an earlier build of the same request that ${job.carriesOn === "stopped" ? "the owner stopped before it finished" : "didn't finish"}: the workspace holds its work. Look at what's there before you write anything, and carry on from it rather than starting over.`);
  if (job.feedback) {
    lines.push(`\nAttempt ${job.attempt}. The previous candidate FAILED platform validation:\n\n${job.feedback}\n\nFix the candidate.`);
  }
  // Stopped for no activity with no session to resume: its work is in the workspace.
  if (job.resumedAfterIdle) lines.push(`\nHewn stopped an earlier run of this attempt after ${minutesText(job.idleMs ?? BUILDER_IDLE_MS)} with no activity. The workspace holds what it did: carry on from there rather than starting over.`);
  return lines.join("\n");
}

/** For a resumed session that may not have read the brief: read it now. */
const BRIEF_IF_NOT_READ = "If you haven't read all of BRIEF.md, read it before you change anything.";

/**
 * A later attempt in the resumed session: the builder has read the brief and written the candidate;
 * only the failure is new. Or a pass on the candidate that validated: what the pass asks.
 */
export function resumePrompt(job: BuildJob): string {
  // Stopped for no activity within this attempt: carry on, whatever it had been asked.
  if (job.resumedAfterIdle) return `Hewn stopped your previous run after ${minutesText(job.idleMs ?? BUILDER_IDLE_MS)} with no activity, before it finished. Carry on in place: the workspace is as you left it, with the request in BUILDER.md and the contract in BRIEF.md. ${BRIEF_IF_NOT_READ} Only change files inside this directory. When it's complete, stop.`;
  if (job.pass && !job.feedback) return `${job.pass.request}\n\n${BRIEF_IF_NOT_READ} Only change files inside this directory. When it's complete, stop.`;
  // The previous run stopped (crashed, timed out) before the platform could validate anything.
  if (!job.feedback) return `Attempt ${job.attempt}. Your previous run stopped before it finished. Carry on in place: the workspace is as you left it, with the request in BUILDER.md and the contract in BRIEF.md. ${BRIEF_IF_NOT_READ} Only change files inside this directory. When it's complete, stop.`;
  return `Attempt ${job.attempt}. The platform validated your candidate and it FAILED:\n\n${job.feedback ?? ""}\n\nFix the candidate in place: the workspace is as you left it, with the request in BUILDER.md and the contract in BRIEF.md. ${BRIEF_IF_NOT_READ} Only change files inside this directory. When it's complete, stop.`;
}

/**
 * The sessions of builds this process ran, per builder: a later attempt resumes the first one's
 * (brief read, candidate written) with the failure, instead of starting over. In memory only: after
 * a restart the next attempt starts fresh.
 */
const sessions = { claude: new Map<string, string>(), codex: new Map<string, string>(), opencode: new Map<string, string>() };
export const noteSession = (builder: keyof typeof sessions, buildId: string, id: string) => void sessions[builder].set(buildId, id);
/** The session a later attempt can resume, when this process ran an earlier one. */
export const sessionOf = (builder: keyof typeof sessions, job: Pick<BuildJob, "buildId" | "attempt">): string | undefined => (job.attempt > 1 ? sessions[builder].get(job.buildId) : undefined);
export const forgetSession = (buildId: string) => Object.values(sessions).forEach((m) => m.delete(buildId));

type Formatter = (event: any, cwd: string) => string | null;

const stamp = () => new Date().toTimeString().slice(0, 8);

/**
 * Run a headless coding-agent CLI in the workspace. Its JSON event stream is formatted into
 * readable activity lines in job.logPath; raw events are kept in <logPath without .log>.jsonl.
 */
interface Confine {
  ownState: string[];
  denyKeychain: boolean;
  /** Ports on this machine the builder may reach (a local model server's). */
  allowLoopback?: number[];
}

/** How long a builder may go with no activity (no output, no file change in its workspace) before it's stopped, unless platform.json says otherwise. */
export const BUILDER_IDLE_MS = 15 * 60_000;

/** "15 minutes", "1 minute". */
const minutesText = (ms: number) => {
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} minute${n === 1 ? "" : "s"}`;
};

/**
 * Watch a workspace for files written, calling `changed` with a path inside it. macOS watches the whole tree
 * cheaply; elsewhere a recursive watch walks the tree (a node_modules too) and holds a watch per file, so only
 * the workspace's own folders are watched, as they are when the run starts. No watching at all: output alone counts.
 */
function watchWorkspace(workspace: string, changed: (file: string | null) => void): FSWatcher[] {
  const out: FSWatcher[] = [];
  const add = (dir: string, recursive: boolean) => {
    try {
      const w = watch(join(workspace, dir), { recursive }, (_event, file) => changed(file ? join(dir, file) : null));
      w.on("error", () => w.close());
      out.push(w);
    } catch {
      // Not watchable: its output still counts.
    }
  };
  if (platform() === "darwin") add("", true);
  else {
    const walk = (dir: string, depth: number) => {
      add(dir, false);
      if (depth >= 3 || out.length >= 200) return;
      for (const e of readdirSync(join(workspace, dir), { withFileTypes: true })) {
        const rel = join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith(".") && !isArtefact(rel)) walk(rel, depth + 1);
      }
    };
    try {
      walk("", 0);
    } catch {
      // A folder gone meanwhile: what's watched so far will do.
    }
  }
  return out;
}

/**
 * Run the CLI until it ends. It is stopped only after the job's `idleMs` with no activity: nothing on its output and no
 * file changed in the workspace (a hung run: a prompt it can't answer, a dead network call). That rejects with
 * `idle`, and `active` says whether the run did anything at all before it went quiet.
 */
export function runCli(command: string, args: string[], job: BuildJob, format: Formatter, confine: Confine, env: NodeJS.ProcessEnv = builderEnv(), onEvent?: (event: any) => void, quietStartMs?: number): Promise<void> {
  const idleMs = job.idleMs ?? BUILDER_IDLE_MS;
  const write = (line: string) => appendFileSync(job.logPath, `${stamp()} ${line}\n`);
  write(`===== attempt ${job.attempt}${job.pass ? `, the ${job.pass.name} pass` : ""}: ${command}${job.platformRoot ? " (sandboxed)" : ""} =====`);
  if (job.platformRoot) {
    ({ command, args } = wrapBuilder(command, args, { workspace: job.workspace, platformRoot: job.platformRoot, ...confine }));
  }
  let unavailable: string | undefined;
  // Errors only (stderr, error and failed-result events), never the builder's own words about models.
  let modelRejected: string | undefined;
  // Whether the builder got as far as using its tools. A model that won't run fails at once (before);
  // a resume that fails before has nothing to lose by starting over, after it the workspace may be half-changed.
  let usedTools = false;
  const checkModel = (text: string) => job.model && !usedTools && !modelRejected && MODEL_REJECTED.test(text) && (modelRejected = text.trim().slice(0, 300));
  return new Promise((resolve, reject) => {
    // Stopped before this run started (between an idle stop and its resume): don't start it.
    if (job.signal?.aborted) return reject(Object.assign(new Error("cancelled"), { cancelled: true }));
    const raw = createWriteStream(job.logPath.replace(/\.log$/, ".jsonl"), { flags: "a" });
    const child = spawn(command, args, { cwd: job.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    // A CLI that never says anything (OpenCode has been seen stuck before its first event): stop it early, with a reason.
    let stalled = false;
    let quiet = quietStartMs ? setTimeout(() => ((stalled = true), child.kill("SIGTERM")), quietStartMs) : undefined;
    const spoke = () => (clearTimeout(quiet), (quiet = undefined));
    let idle = false;
    // Whether it did any work: a line of activity (its words, a tool) or a file written; not its start-up events.
    let active = false;
    const stopIdle = () => ((idle = true), child.kill("SIGTERM"));
    // Never before the quiet start's own stop, which says better what happened.
    let idleTimer = setTimeout(stopIdle, Math.max(idleMs, quietStartMs ?? 0));
    /** Any sign of life puts the idle stop off; `work` also counts as having done something. */
    const busy = (work = false) => {
      if (work) active = true;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stopIdle, idleMs);
    };
    // A file it writes counts as activity too (a long edit, a write that prints nothing). Only one written
    // since the run started: macOS replays the last moments' events (the workspace being written) to a new watch.
    const started = Date.now();
    const changed = (file: string | null) => {
      try {
        if (file && statSync(join(job.workspace, file)).mtimeMs >= started) busy(true);
      } catch {
        // Gone, or not a path in the workspace: nothing to tell.
      }
    };
    const watchers = watchWorkspace(job.workspace, changed);
    createInterface({ input: child.stdout }).on("line", (line) => {
      spoke();
      busy();
      raw.write(line + "\n");
      let activity: string | null;
      try {
        const event = JSON.parse(line);
        // Claude Code names the model it runs on first (a family resolves to a full name).
        if (event?.type === "system" && event.subtype === "init" && typeof event.model === "string") job.onModel?.(event.model);
        if (event?.type === "error" || event?.type === "turn.failed" || (event?.type === "result" && event.is_error)) checkModel(JSON.stringify(event));
        onEvent?.(event);
        activity = format(event, job.workspace);
      } catch {
        activity = line.trim() || null;
      }
      if (!activity) return;
      busy(true);
      if (USED_TOOL.test(activity)) usedTools = true;
      if (!unavailable && UNAVAILABLE.test(activity)) unavailable = activity.replace(/^\S+\s/, "");
      for (const l of activity.split("\n")) write(l);
      job.onActivity?.(activity.split("\n").at(-1)!);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (!line.trim()) return;
      spoke();
      busy();
      if (!unavailable && UNAVAILABLE.test(line)) unavailable = line.trim();
      checkModel(line);
      write(`! ${line}`);
    });
    const cancel = () => child.kill("SIGTERM");
    const done = () => (clearTimeout(idleTimer), watchers.forEach((w) => w.close()), spoke());
    job.signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", (e) => (done(), reject(e)));
    child.once("close", (code, signal) => {
      done();
      job.signal?.removeEventListener("abort", cancel);
      if (job.signal?.aborted) return reject(Object.assign(new Error("cancelled"), { cancelled: true }));
      raw.end();
      if (code === 0) resolve();
      else if (idle && !stalled) reject(Object.assign(new Error(`no activity for ${minutesText(idleMs)}`), { idle: true, active, usedTools }));
      else if (stalled) reject(Object.assign(new Error(`${command} said nothing for ${minutesText(quietStartMs!)}, so Hewn stopped it (it never started); try again`), { usedTools }));
      else if (modelRejected) reject(Object.assign(new Error(modelRejected), { modelRejected: true }));
      else if (unavailable) reject(Object.assign(new Error(`${unavailable} (log in to ${job.builderName ?? "the builder CLI"}, or switch "builder" in platform.json)`), { unavailable: true }));
      else reject(Object.assign(new Error(`${command} exited with ${signal ?? code} (see ${job.logPath})`), { usedTools }));
    });
  });
}

/** How long OpenCode gets to say its first word (its model list, then a step): a run stuck before that is stopped. */
export const OPENCODE_QUIET_START_MS = 3 * 60_000;

/**
 * Run with the asked-for model. If the CLI won't run it (retired, misspelled, not on this account),
 * the build stops at once and says so: the owner picks another; nothing is built on a model they
 * didn't choose.
 */
export async function withModelCheck(agent: string, job: BuildJob, run: (job: BuildJob) => Promise<void>): Promise<void> {
  try {
    await run(job);
    if (job.model) noteModelRan(agent, job.model);
  } catch (e) {
    if (!(e as { modelRejected?: boolean }).modelRejected || !job.model) throw e;
    const reason = modelRejectReason((e as Error).message);
    noteModelFailure(agent, job.model, reason);
    throw Object.assign(new Error(modelUnavailableText(job.model, reason)), { modelUnavailable: true });
  }
}

/**
 * What the owner reads when a model can't run: the CLI's reason, and for OpenCode's free tier
 * (`opencode/…`) why the list offered it anyway.
 */
export const modelUnavailableText = (model: string, reason?: string) =>
  `${model} isn't available${reason ? ` (${reason})` : ""}. Pick another model (in the chat box or Settings › AI).${model.startsWith("opencode/") && !/doesn't list/.test(reason ?? "") ? " OpenCode's free tier changes which models it serves, and its list can lag behind; Hewn's lists mark the ones that failed lately." : ""}`;

/** `--model` / `--effort` for Claude Code. */
export const claudeModelArgs = (m: { model?: string; effort?: string }) => [...(m.model ? ["--model", m.model] : []), ...(m.effort ? ["--effort", m.effort] : [])];
/** `-m` / reasoning effort for Codex. */
export const codexModelArgs = (m: { model?: string; effort?: string }) => [...(m.model ? ["-m", m.model] : []), ...(m.effort && EFFORT.test(m.effort) ? ["-c", `model_reasoning_effort="${m.effort}"`] : [])];
/** `-m provider/model` / `--variant` (the model's named reasoning levels) for OpenCode. */
export const opencodeModelArgs = (m: { model?: string; effort?: string }) => [...(m.model ? ["-m", m.model] : []), ...(m.effort && EFFORT.test(m.effort) ? ["--variant", m.effort] : [])];

/** Builder output meaning "retrying won't help": not logged in, revoked token, no quota, no key for the provider. */
export const UNAVAILABLE = /failed to authenticate|not logged in|please (run \/login|log in)|oauth token|invalid api key|unauthorized|401|usage limit|quota exceeded|ProviderAuthError|no (api key|credentials?) (found|configured|set)|not authenticated/i;

/**
 * What an OpenCode run may do, set above anything in the workspace (`OPENCODE_CONFIG_CONTENT` wins
 * over a project `opencode.json`, which the builder could write). The builder: read and write the
 * workspace, nothing else (no shell, no web, no subagents, no skills, no questions: the run can't
 * answer them). The intake: read, and fetch web pages to check what the owner mentions, nothing else.
 * The intake reading a tool someone shared: nothing at all (its code is in the prompt, and nothing in
 * that code may send it to the web). Both names of the shell permission, for OpenCode versions on
 * either side of its rename.
 */
export interface OpencodeRules {
  permission: Record<string, string>;
  tools: Record<string, boolean>;
}
const deny = (names: string[]): Record<string, string> => Object.fromEntries(names.map((n) => [n, "deny"]));
const off = (names: string[]): Record<string, boolean> => Object.fromEntries(names.map((n) => [n, false]));
export const OPENCODE_BUILDER_RULES: OpencodeRules = {
  permission: { read: "allow", edit: "allow", glob: "allow", grep: "allow", doom_loop: "allow", ...deny(["bash", "shell", "webfetch", "websearch", "task", "skill", "lsp", "question", "external_directory"]) },
  tools: off(["bash", "shell", "webfetch", "websearch", "task", "skill", "question"]),
};
export const OPENCODE_INTAKE_RULES: OpencodeRules = {
  permission: { read: "allow", glob: "allow", grep: "allow", webfetch: "allow", doom_loop: "allow", ...deny(["edit", "bash", "shell", "websearch", "task", "skill", "lsp", "question", "external_directory"]) },
  tools: off(["edit", "write", "patch", "bash", "shell", "websearch", "task", "skill", "question"]),
};
export const OPENCODE_READER_RULES: OpencodeRules = {
  permission: deny(["read", "glob", "grep", "list", "webfetch", "edit", "bash", "shell", "websearch", "task", "skill", "lsp", "question", "external_directory"]),
  tools: off(["read", "glob", "grep", "list", "webfetch", "edit", "write", "patch", "bash", "shell", "websearch", "task", "skill", "question"]),
};

/** Your own OpenCode directories (XDG, honoured for your own home only), where its logins, config and caches live. */
export { opencodeUserDirs };

/** Ports on this machine among a provider config's base URLs: a local model server (Ollama, LM Studio) the run must reach. */
export function loopbackPorts(providers: Record<string, unknown> | undefined): number[] {
  const ports = new Set<number>();
  for (const p of Object.values(providers ?? {})) {
    const url = (p as { options?: { baseURL?: unknown } })?.options?.baseURL;
    if (typeof url !== "string") continue;
    try {
      const u = new URL(url);
      if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname)) ports.add(Number(u.port) || (u.protocol === "https:" ? 443 : 80));
    } catch {
      // not a URL: nothing to allow
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** `opencode <args>`, its stdout: asked without a synchronous wait (Hewn's own process keeps serving meanwhile). */
const opencodeSays = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => new Promise<string>((resolve, reject) => execFile("opencode", args, { ...o, encoding: "utf8", maxBuffer: 16 << 20 }, (e, out) => (e ? reject(e) : resolve(out))));

/**
 * Your OpenCode's resolved config (`opencode debug config`), read with plugins off and nothing
 * written: its `provider` section is what a run needs to see your custom providers (a local model
 * server, a provider with options). Kept for 10 minutes. Nothing when OpenCode can't say.
 */
let providerCache: { at: number; providers?: Record<string, unknown> } | undefined;
export async function opencodeProviders(read: () => Promise<string> | string = () => opencodeSays(["debug", "config", "--pure"], { cwd: tmpdir(), env: { ...process.env, ...OPENCODE_NO_UPDATE }, timeout: 20_000 })): Promise<Record<string, unknown> | undefined> {
  if (providerCache && Date.now() - providerCache.at < 10 * 60_000) return providerCache.providers;
  let providers: Record<string, unknown> | undefined;
  try {
    const cfg = JSON.parse(await read());
    if (cfg && typeof cfg.provider === "object" && cfg.provider && Object.keys(cfg.provider).length) providers = cfg.provider;
  } catch {
    // no OpenCode, or no config: the run sees the providers it's logged in to, and the free ones
  }
  providerCache = { at: Date.now(), providers };
  return providers;
}

/**
 * Whether OpenCode, in the run's own home, lists the model (`opencode models`: its logins, its
 * providers, the free tier). Asked before a run with a chosen model: a model it can't resolve (a
 * misspelling, a provider it isn't signed in to) doesn't fail an `opencode run`, it hangs it (seen
 * on 1.18.18), and the build would wait its whole timeout to say nothing. Can't tell (the command
 * fails): run anyway.
 */
export async function opencodeHasModel(model: string, env: NodeJS.ProcessEnv, cwd: string, list: () => Promise<string> | string = () => opencodeSays(["models", "--pure"], { cwd, env, timeout: 30_000 })): Promise<boolean> {
  try {
    return (await list()).split("\n").map((l) => l.trim()).includes(model);
  } catch {
    return true;
  }
}

/** The error a run with a model OpenCode doesn't list stops with (`withModelCheck` words it for the owner). */
export const opencodeModelRejected = (model: string) => Object.assign(new Error(`model not found: ${model} (not in opencode models)`), { modelRejected: true });

export interface OpencodeHomeOptions {
  /** What the run may do (OPENCODE_BUILDER_RULES or OPENCODE_INTAKE_RULES). */
  rules: OpencodeRules;
  /** Your custom providers (`provider` in your config), carried over. Default: read from OpenCode. */
  providers?: () => Record<string, unknown> | undefined;
  /** MCP servers the run gets (a build's `check`), with the rules (above a project config). */
  mcp?: Record<string, unknown>;
  /** Where the run keeps its sessions (OpenCode's database): a build's own, so its later attempts resume them and no other build reads them. */
  db: string;
}

/**
 * An OpenCode run in OpenCode's builder home (`home`: its HOME, its XDG directories, the login its sign-in made), which
 * Hewn never reads or writes the login in. Its sessions go in a database of the run's own (`db`). Your custom
 * providers (a local model server among them) come in a config file for this run alone (`OPENCODE_CONFIG`, gone after:
 * it may carry keys), with updates and session sharing off; the permissions on top as `OPENCODE_CONFIG_CONTENT`
 * (above a project config the builder could write). The run can't read ~/.claude's instructions or a project config.
 */
export async function opencodeHome(home: string, o: OpencodeHomeOptions): Promise<{ env: NodeJS.ProcessEnv; dir: string; loopback: number[]; done: () => void }> {
  const providers = await (o.providers ?? opencodeProviders)();
  const runs = join(home, "runs");
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(o.db), { recursive: true, mode: 0o700 });
  const config = join(runs, `${randomUUID()}.json`);
  writeFileSync(config, JSON.stringify({ $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", ...(providers ? { provider: providers } : {}) }, null, 2), { mode: 0o600 });
  return {
    dir: home,
    loopback: loopbackPorts(providers),
    env: {
      ...opencodeEnv(home),
      OPENCODE_CONFIG: config,
      OPENCODE_DB: o.db,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", ...o.rules, ...(o.mcp ? { mcp: o.mcp } : {}) }),
    },
    done: () => rmSync(config, { force: true }),
  };
}

/** Where a build keeps its OpenCode sessions, in OpenCode's builder home: removed with the build's workspace. */
export const opencodeBuildDb = (home: string, buildId: string) => join(home, "builds", `${buildId}.db`);

/**
 * What Codex would load from its home besides the login: instructions (AGENTS.md) and skills. Codex has a shell, and its
 * home is the one every build shares, so a build could leave them for the next; they go before each run.
 */
export function clearCodexInstructions(home: string) {
  for (const p of [join(home, ".codex", "AGENTS.md"), join(home, ".codex", "AGENTS.override.md"), join(home, ".codex", "skills"), join(home, ".agents")]) rmSync(p, { recursive: true, force: true });
}

/** The platform home a build runs under (its log is in `<home>/builds/`). */
const platformHomeOf = (job: BuildJob) => dirname(dirname(job.logPath));

/** Builder output meaning the sign-in (or a key) didn't work: then the vendor's own status says whether it's signed in. */
const SIGNED_OUT = /failed to authenticate|not logged in|please (run \/login|log in)|oauth token|invalid api key|unauthorized|\b401\b|not authenticated|no (api key|credentials?) (found|configured|set)/i;

/** A line in hewn.log (the supervisor's log): where the terminal's commands go, never a build's log, which the web shows. */
const hewnLog = (line: string) => console.error(`[${new Date().toISOString()}] ${line}`);

/**
 * A run in the vendor's builder home, signed in by the vendor's own flow. Not signed in (no home yet, or the run's
 * login failed and the vendor's status says it's signed out): it stops with the owner's words, in `note` (the build's
 * log, which the web shows) too, and hewn.log (`log`) names the command. A login failure while Claude Code says it is
 * signed in is the `claude -p` tripwire. A run on an API key (`apiKey`) needs no sign-in.
 */
export async function inBuilderHome<T>(vendor: BuilderVendor, platformHome: string, o: { apiKey?: string; note?: (line: string) => void; log?: (line: string) => void; ask?: AskCli }, run: (home: string) => Promise<T>): Promise<T> {
  const home = builderHome(platformHome, vendor);
  const log = o.log ?? hewnLog;
  const stop = () => (o.note?.(notSignedInWords(vendor)), log(`${notSignedInWords(vendor)} In a terminal there: ${signInCommand(vendor)}`), notSignedIn(vendor));
  if (!existsSync(home)) {
    if (!o.apiKey) throw stop();
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  try {
    return await run(home);
  } catch (e) {
    const err = e as Error & { unavailable?: boolean; notSignedIn?: boolean };
    if (o.apiKey || err.notSignedIn || !SIGNED_OUT.test(err.message)) throw e;
    const now = await signedIn(vendor, platformHome, o.ask);
    if (now === false) throw stop();
    if (now === true && vendor === "claude") {
      log(`Claude Code says it is signed in (claude auth status), but \`claude -p\` didn't use the sign-in: see hewn doctor's "Claude -p" line. It said: ${err.message}`);
      throw claudeSignInIgnored();
    }
    throw e;
  }
}

/** Codex, headless. Its own HOME (no user skills, instructions or config); OS sandbox limits writes to the workspace. */
export const codexBuilder: CapabilityBuilder = {
  name: "codex",
  build: (job) => withModelCheck("codex", job, codexRun),
};

/**
 * Codex's arguments for an attempt: fresh, or resuming the build's earlier thread with the failure.
 * Sessions stay on disk in its builder home (no --ephemeral), so a thread can be resumed. `exec`'s own
 * options (the sandbox, the project root, the directory) go before `resume`, the shared ones after.
 */
export function codexArgs(job: BuildJob, resume?: string, check?: CheckServer): string[] {
  const shared = ["--ignore-user-config", "--skip-git-repo-check", "--json", ...codexModelArgs(job)];
  const where = [
    // Codex's own sandbox cannot nest inside ours. When the platform confines the
    // builder, ours is the boundary and Codex's commands inherit it.
    "--sandbox", job.platformRoot ? "danger-full-access" : "workspace-write",
    // The workspace is the project root: never walk up looking for other AGENTS.md files.
    "-c", 'project_root_markers=["BUILDER.md"]',
    // Its login: the file in its builder home (never the system keyring, which our sandbox closes).
    ...CODEX_FILE_LOGIN,
    // Its `check` tool (no other MCP server: --ignore-user-config), waited on as long as a check takes.
    ...(check
      ? ["-c", `mcp_servers.${CHECK_SERVER_NAME}.command=${JSON.stringify(check.command)}`, "-c", `mcp_servers.${CHECK_SERVER_NAME}.args=${JSON.stringify(check.args)}`, "-c", `mcp_servers.${CHECK_SERVER_NAME}.tool_timeout_sec=${CHECK_CLIENT_TIMEOUT_MS / 1000}`]
      : []),
    "-C", job.workspace,
  ];
  return resume ? ["exec", ...where, "resume", ...shared, resume, resumePrompt(job)] : ["exec", ...shared, ...where, builderPrompt(job)];
}

/**
 * Run an attempt: resuming the earlier session when there is one, else fresh. A resume that fails
 * before the builder used any tool (the session gone, the CLI changed) starts over in the same
 * attempt; one that fails after is a failed attempt like any other (the workspace may be half-changed).
 * A run stopped for no activity resumes its session in the same attempt: that isn't a failure, unless it
 * did nothing at all before it went quiet (then it's hung, and resuming would hang again).
 */
export async function withResume(builder: keyof typeof sessions, job: BuildJob, run: (resume: string | undefined, current: BuildJob) => Promise<void>) {
  const note = (line: string) => (appendFileSync(job.logPath, `${stamp()} ${line}\n`), job.onActivity?.(line));
  const once = async (resume: string | undefined, current: BuildJob) => {
    if (!resume) return run(undefined, current);
    try {
      await run(resume, current);
    } catch (e) {
      const err = e as { usedTools?: boolean; cancelled?: boolean; unavailable?: boolean; modelRejected?: boolean; idle?: boolean };
      if (err.usedTools !== false || err.cancelled || err.unavailable || err.modelRejected || err.idle) throw e;
      forgetSession(job.buildId);
      note("couldn't resume the earlier session; starting over");
      await run(undefined, current);
    }
  };
  let resume = sessionOf(builder, job);
  let current = job;
  for (;;) {
    try {
      return await once(resume, current);
    } catch (e) {
      const err = e as { idle?: boolean; active?: boolean; message: string };
      if (!err.idle || !err.active) throw e;
      if (job.signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
      // Its own session, where it stopped: the prompt says so, not the failure it had already been given.
      resume = sessions[builder].get(job.buildId);
      note(`${err.message}; ${resume ? "resuming" : "starting again in place"}`);
      current = { ...job, resumedAfterIdle: true };
    }
  }
}

async function codexRun(job: BuildJob) {
  const note = (line: string) => appendFileSync(job.logPath, `${stamp()} ${line}\n`);
  // Codex's builder home, signed in by Codex's own flow; a build's thread is its own (by id), kept between attempts.
  await inBuilderHome("codex", platformHomeOf(job), { apiKey: job.apiKey, note }, (home) =>
    withResume("codex", job, async (resume, current) => {
      clearCodexInstructions(home);
      const check = job.check ? openCheck(job.workspace, job.check) : undefined;
      try {
        await runCli(
          "codex",
          codexArgs(current, resume, check?.server),
          current,
          codexActivity,
          // Codex has a shell: no Keychain. Its login is a file in its home.
          { ownState: [home], denyKeychain: true },
          codexEnv(home, job.apiKey ? { ...builderEnv(), CODEX_API_KEY: job.apiKey } : builderEnv()),
          // Its thread, for the next attempt to resume.
          (e) => e?.type === "thread.started" && typeof e.thread_id === "string" && noteSession("codex", job.buildId, e.thread_id),
        );
      } finally {
        check?.close();
      }
    }),
  );
}

/** OpenCode, headless, in a home of its own. File tools only (no shell, no web, no subagents); OS sandbox limits writes to the workspace. */
export const opencodeBuilder: CapabilityBuilder = {
  name: "opencode",
  build: (job) => withModelCheck("opencode", job, opencodeRun),
};

/**
 * OpenCode's arguments for an attempt: fresh, or resuming the build's earlier session (`-s`, kept in
 * its own home's database) with the failure. `--pure`: none of its plugins. `--auto`: approve what the
 * rules don't deny (the run can't ask); the rules are in the environment (see `opencodeHome`).
 */
export function opencodeArgs(job: BuildJob, resume?: string): string[] {
  return ["run", "--format", "json", "--pure", "--auto", ...opencodeModelArgs(job), ...(resume ? ["-s", resume, resumePrompt(job)] : [builderPrompt(job)])];
}

async function opencodeRun(job: BuildJob) {
  const note = (line: string) => appendFileSync(job.logPath, `${stamp()} ${line}\n`);
  // OpenCode's builder home, set up by its own sign-in; a build's sessions in a database of its own, kept between attempts.
  await inBuilderHome("opencode", platformHomeOf(job), { note }, async (home) => {
    if (!(await signedIn("opencode", platformHomeOf(job)))) throw (note(notSignedInWords("opencode")), hewnLog(`${notSignedInWords("opencode")} In a terminal there: ${signInCommand("opencode")}`), notSignedIn("opencode"));
    await withResume("opencode", job, async (resume, current) => {
      const check = job.check ? openCheck(job.workspace, job.check) : undefined;
      const isolated = await opencodeHome(home, { ...(check ? opencodeCheck(check.server) : { rules: OPENCODE_BUILDER_RULES }), db: opencodeBuildDb(home, job.buildId) });
      try {
        // Asked from its home, not the workspace (builder-written from the second attempt on).
        if (job.model && !(await opencodeHasModel(job.model, isolated.env, isolated.dir))) throw opencodeModelRejected(job.model);
        await runCli(
          "opencode",
          opencodeArgs(current, resume),
          current,
          opencodeActivity,
          // Its logins are a file in its home: no Keychain, none of your ~/.config/opencode. A local model server's port stays open.
          { ownState: [isolated.dir], denyKeychain: true, allowLoopback: isolated.loopback },
          isolated.env,
          // Its session (every event names it), for the next attempt to resume.
          (e) => typeof e?.sessionID === "string" && e.sessionID && noteSession("opencode", job.buildId, e.sessionID),
          OPENCODE_QUIET_START_MS,
        );
      } finally {
        check?.close();
        isolated.done();
      }
    });
  });
}

/** OpenCode's rules and MCP servers with `check` offered: its one tool allowed, waited on as long as a check takes. */
export function opencodeCheck(check: CheckServer): { rules: OpencodeRules; mcp: Record<string, unknown> } {
  return {
    rules: { ...OPENCODE_BUILDER_RULES, permission: { ...OPENCODE_BUILDER_RULES.permission, [`${CHECK_SERVER_NAME}_*`]: "allow" } },
    mcp: { [CHECK_SERVER_NAME]: { type: "local", command: [check.command, ...check.args], enabled: true, timeout: CHECK_CLIENT_TIMEOUT_MS } },
  };
}

/** Claude Code, headless, in its own config dir. File tools only, no shell; no MCP server but Hewn's `check`. */
export const claudeBuilder: CapabilityBuilder = {
  name: "claude",
  build: (job) => withModelCheck("claude", job, claudeRun),
};

/** Claude Code's arguments for an attempt: fresh with a session id of its own, or resuming the build's earlier session with the failure. */
export function claudeArgs(job: BuildJob, session: { id: string; resume: boolean }, check?: CheckServer): string[] {
  return [
    "-p", session.resume ? resumePrompt(job) : builderPrompt(job),
    ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
    "--output-format", "stream-json", "--verbose",
    ...claudeModelArgs(job),
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: check ? { [CHECK_SERVER_NAME]: { command: check.command, args: check.args } } : {} }),
    // None of your user settings, hooks, memory (CLAUDE.md) or skills; the login stays yours.
    // No project settings either: the workspace is the builder's to write, and settings there
    // (hooks, apiKeyHelper) would run commands. Hooks are off whatever loads.
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
    "--permission-mode", "acceptEdits",
    // File tools only: no shell now, and --restricted drops every code-running tool, also ones added later.
    "--restricted",
    "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", ...(check ? [`mcp__${CHECK_SERVER_NAME}__check`] : []),
    "--disallowedTools", "Bash",
  ];
}

/** Claude Code's caches outside its config dir, which it writes as it runs. */
export const claudeCaches = () => [join(homedir(), "Library", "Caches", "claude-cli-nodejs"), join(homedir(), ".cache", "claude-cli-nodejs")];

/**
 * Claude Code without a shell may read the macOS Keychain, where its sign-in keeps the login (an item named after its
 * builder home): its file tools can't run `security`, and the login is Claude Code's to read. Elsewhere the login is a
 * file in the home.
 */
export const CLAUDE_KEYCHAIN = platform() === "darwin";

async function claudeRun(job: BuildJob) {
  const note = (line: string) => appendFileSync(job.logPath, `${stamp()} ${line}\n`);
  // Claude Code's builder home, signed in by Claude Code's own flow; a build's session is its own (by id), kept between attempts.
  await inBuilderHome("claude", platformHomeOf(job), { apiKey: job.apiKey, note }, (home) =>
    withResume("claude", job, async (resume, current) => {
      const session = { id: resume ?? randomUUID(), resume: !!resume };
      // Known before it starts: a run stopped for no activity resumes it even if it never said so.
      noteSession("claude", job.buildId, session.id);
      const env = claudeEnv(home, job.apiKey ? { ...builderEnv(), ANTHROPIC_API_KEY: job.apiKey } : builderEnv());
      const check = job.check ? openCheck(job.workspace, job.check) : undefined;
      try {
        await runCli(
          "claude",
          claudeArgs(current, session, check?.server),
          current,
          claudeActivity,
          // Its home and caches; none of your ~/.claude.
          { ownState: [home, ...claudeCaches()], denyKeychain: !CLAUDE_KEYCHAIN },
          // A check takes longer than an MCP call usually does.
          check ? { ...env, MCP_TOOL_TIMEOUT: String(CHECK_CLIENT_TIMEOUT_MS) } : env,
          // The session it ran as (the one asked for), for the next attempt to resume.
          (e) => e?.type === "system" && e.subtype === "init" && typeof e.session_id === "string" && noteSession("claude", job.buildId, e.session_id),
        );
      } finally {
        check?.close();
      }
    }),
  );
}

/**
 * What a build kept in the builders' homes between its attempts, removed with its workspace: Claude Code's session
 * (its project folder, named after the workspace), Codex's thread (its rollout file, when this process ran it),
 * OpenCode's session database. Best effort: the homes are the vendors' to lay out.
 */
export function forgetBuild(platformHome: string, buildId: string, workspace: string) {
  const claude = builderHome(platformHome, "claude");
  let real = workspace;
  try {
    real = realpathSync(workspace);
  } catch {
    // Gone already: its path as given.
  }
  for (const ws of new Set([workspace, real])) rmSync(join(claude, "projects", ws.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true });
  const thread = sessions.codex.get(buildId);
  const rollouts = join(builderHome(platformHome, "codex"), ".codex", "sessions");
  if (thread && existsSync(rollouts)) {
    const walk = (dir: string, depth: number) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && depth < 4) walk(join(dir, e.name), depth + 1);
        else if (e.isFile() && e.name.includes(thread)) rmSync(join(dir, e.name), { force: true });
      }
    };
    try {
      walk(rollouts, 0);
    } catch {
      // A folder gone meanwhile: what's left stays.
    }
  }
  const db = opencodeBuildDb(builderHome(platformHome, "opencode"), buildId);
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  forgetSession(buildId);
}
