// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { EFFORT } from "@hewntools/core/build-models.ts";
import { claudeActivity, codexActivity } from "./activity.ts";
import { MODEL_REJECTED } from "./models.ts";
import { wrapBuilder } from "./sandbox.ts";
import type { BuildJob, CapabilityBuilder } from "./types.ts";

export function builderPrompt(job: BuildJob): string {
  const lines = [
    `You are a builder for Hewn, a personal capability platform. Build ${job.buildId} (${job.kind} of capability '${job.capabilityId}').`,
    `Your current directory is the build workspace. Read BUILDER.md: it holds the request and the implementation contract. Implement the request in place.`,
    `Only change files inside this directory. Do not try to start, call or promote anything on the platform. When the candidate is complete, stop. The platform validates it automatically.`,
  ];
  // The owner watches Home while it builds: the glyph first, not after reading everything.
  if (job.kind === "create") lines.push(`Right after reading BUILDER.md, before reading anything else, write ui/icon.svg and set "hue" in capability.json (see "Icon" in BUILDER.md): the owner's Home shows the icon while you build.`);
  if (job.feedback) {
    lines.push(`\nAttempt ${job.attempt}. The previous candidate FAILED platform validation:\n\n${job.feedback}\n\nFix the candidate.`);
  }
  return lines.join("\n");
}

/** A later attempt in the resumed session: the builder has read the brief and written the candidate; only the failure is new. */
export function resumePrompt(job: BuildJob): string {
  return `Attempt ${job.attempt}. The platform validated your candidate and it FAILED:\n\n${job.feedback ?? ""}\n\nFix the candidate in place: the workspace is as you left it, and BUILDER.md still holds the request and the contract. Only change files inside this directory. When it's complete, stop.`;
}

/**
 * The sessions of builds this process ran, per builder: a later attempt resumes the first one's
 * (brief read, candidate written) with the failure, instead of starting over. In memory only: after
 * a restart the next attempt starts fresh.
 */
const sessions = { claude: new Map<string, string>(), codex: new Map<string, string>() };
export const noteSession = (builder: keyof typeof sessions, buildId: string, id: string) => void sessions[builder].set(buildId, id);
/** The session a later attempt can resume, when this process ran an earlier one. */
export const sessionOf = (builder: keyof typeof sessions, job: Pick<BuildJob, "buildId" | "attempt">): string | undefined => (job.attempt > 1 ? sessions[builder].get(job.buildId) : undefined);
export const forgetSession = (buildId: string) => (sessions.claude.delete(buildId), sessions.codex.delete(buildId));

type Formatter = (event: any, cwd: string) => string | null;

const stamp = () => new Date().toTimeString().slice(0, 8);

/**
 * Run a headless coding-agent CLI in the workspace. Its JSON event stream is formatted into
 * readable activity lines in job.logPath; raw events are kept in <logPath without .log>.jsonl.
 */
interface Confine {
  ownState: string[];
  denyKeychain: boolean;
}

/** What a builder's environment keeps: the basics, its own model and login settings, proxies and CAs. Not the rest of yours (tokens). */
const BUILDER_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|TZ|TMPDIR|LC_\w+|(ANTHROPIC|CLAUDE|OPENAI|CODEX)_\w+|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR))$/;
export const builderEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => BUILDER_ENV.test(k)));

function runCli(command: string, args: string[], job: BuildJob, format: Formatter, timeoutMs: number, confine: Confine, env: NodeJS.ProcessEnv = builderEnv(), onEvent?: (event: any) => void): Promise<void> {
  const write = (line: string) => appendFileSync(job.logPath, `${stamp()} ${line}\n`);
  write(`===== attempt ${job.attempt}: ${command}${job.platformRoot ? " (sandboxed)" : ""} =====`);
  if (job.platformRoot) {
    ({ command, args } = wrapBuilder(command, args, { workspace: job.workspace, platformRoot: job.platformRoot, ...confine }));
  }
  let unavailable: string | undefined;
  // Errors only (stderr, error and failed-result events), never the builder's own words about models.
  let modelRejected: string | undefined;
  // Only before the builder has done anything: a model that won't run fails at once.
  let worked = false;
  const checkModel = (text: string) => job.model && !worked && !modelRejected && MODEL_REJECTED.test(text) && (modelRejected = text.trim().slice(0, 300));
  return new Promise((resolve, reject) => {
    const raw = createWriteStream(job.logPath.replace(/\.log$/, ".jsonl"), { flags: "a" });
    const child = spawn(command, args, { cwd: job.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    createInterface({ input: child.stdout }).on("line", (line) => {
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
      if (/^→ /.test(activity)) worked = true;
      if (!unavailable && UNAVAILABLE.test(activity)) unavailable = activity.replace(/^\S+\s/, "");
      for (const l of activity.split("\n")) write(l);
      job.onActivity?.(activity.split("\n").at(-1)!);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (!line.trim()) return;
      if (!unavailable && UNAVAILABLE.test(line)) unavailable = line.trim();
      checkModel(line);
      write(`! ${line}`);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const cancel = () => child.kill("SIGTERM");
    job.signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", (e) => (clearTimeout(timer), reject(e)));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      job.signal?.removeEventListener("abort", cancel);
      if (job.signal?.aborted) return reject(Object.assign(new Error("cancelled"), { cancelled: true }));
      raw.end();
      if (code === 0) resolve();
      else if (modelRejected) reject(Object.assign(new Error(modelRejected), { modelRejected: true }));
      else if (unavailable) reject(Object.assign(new Error(`${unavailable} (log in to ${job.builderName ?? "the builder CLI"}, or switch "builder" in platform.json)`), { unavailable: true }));
      // `worked`: whether it got as far as touching the workspace (a resume that failed before that starts over).
      else reject(Object.assign(new Error(`${command} exited with ${signal ?? code} (see ${job.logPath})`), { worked }));
    });
  });
}

const TIMEOUT_MS = 15 * 60_000;

/**
 * Run with the asked-for model. If the CLI won't run it (retired, misspelled, not on this account),
 * the build stops at once and says so: the owner picks another; nothing is built on a model they
 * didn't choose.
 */
export async function withModelCheck(job: BuildJob, run: (job: BuildJob) => Promise<void>): Promise<void> {
  try {
    await run(job);
  } catch (e) {
    if (!(e as { modelRejected?: boolean }).modelRejected || !job.model) throw e;
    throw Object.assign(new Error(modelUnavailableText(job.model)), { modelUnavailable: true });
  }
}

/** What the owner reads when a model can't run. */
export const modelUnavailableText = (model: string) => `${model} isn't available. Pick another model (in the chat box or Settings › AI).`;

/** `--model` / `--effort` for Claude Code. */
export const claudeModelArgs = (m: { model?: string; effort?: string }) => [...(m.model ? ["--model", m.model] : []), ...(m.effort ? ["--effort", m.effort] : [])];
/** `-m` / reasoning effort for Codex. */
export const codexModelArgs = (m: { model?: string; effort?: string }) => [...(m.model ? ["-m", m.model] : []), ...(m.effort && EFFORT.test(m.effort) ? ["-c", `model_reasoning_effort="${m.effort}"`] : [])];

/** Builder output meaning "retrying won't help": not logged in, revoked token, no quota. */
export const UNAVAILABLE = /failed to authenticate|not logged in|please (run \/login|log in)|oauth token|invalid api key|unauthorized|401|usage limit|quota exceeded/i;

/**
 * Codex runs with its own HOME and CODEX_HOME (<hewn home>/builder-home/codex) holding only your
 * auth.json: none of your skills (~/.agents/skills), global AGENTS.md or config reach a build.
 * auth.json is copied in before each run and copied back if Codex refreshed it, so your own Codex
 * login and the builder's stay one and the same.
 */
export function codexHome(dir: string): { env: NodeJS.ProcessEnv; dir: string; syncBack: () => void } {
  const codexDir = join(dir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const yours = join(homedir(), ".codex", "auth.json");
  const theirs = join(codexDir, "auth.json");
  if (existsSync(yours)) copyFileSync(yours, theirs);
  const copied = existsSync(theirs) ? statSync(theirs).mtimeMs : 0;
  return {
    dir,
    env: { ...builderEnv(), HOME: dir, CODEX_HOME: codexDir },
    syncBack: () => {
      if (existsSync(theirs) && statSync(theirs).mtimeMs > copied && existsSync(dirname(yours))) copyFileSync(theirs, yours);
    },
  };
}

/**
 * Your Claude Code login: on macOS the Keychain item "Claude Code-credentials", elsewhere
 * ~/.claude/.credentials.json. It holds the model login (claudeAiOauth) and your MCP servers'
 * tokens (mcpOAuth), Hewn's among them.
 */
export interface ClaudeLogin {
  blob: { claudeAiOauth?: unknown; [k: string]: unknown };
  /** macOS: the Keychain item's account; else the file. */
  account?: string;
  file?: string;
}
const KEYCHAIN_SERVICE = "Claude Code-credentials";
function readClaudeLogin(): ClaudeLogin | undefined {
  try {
    if (platform() === "darwin") {
      const attrs = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const account = /"acct"<blob>="([^"]*)"/.exec(attrs)?.[1];
      const blob = JSON.parse(execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      return account ? { blob, account } : undefined;
    }
    const file = join(homedir(), ".claude", ".credentials.json");
    return existsSync(file) ? { blob: JSON.parse(readFileSync(file, "utf8")), file } : undefined;
  } catch {
    return undefined;
  }
}
function writeClaudeLogin(login: ClaudeLogin, blob: ClaudeLogin["blob"]) {
  const json = JSON.stringify(blob);
  if (login.file) return writeFileSync(login.file, json, { mode: 0o600 });
  // Through security's own prompt (stdin), so the token never shows in a process list.
  const hex = Buffer.from(json, "utf8").toString("hex");
  execFileSync("security", ["-i"], { input: `add-generic-password -U -a "${login.account}" -s "${KEYCHAIN_SERVICE}" -X ${hex}\n`, stdio: ["pipe", "ignore", "ignore"] });
}

/**
 * Claude runs with a config dir of its own for each run (`dir`, as CLAUDE_CONFIG_DIR): none of
 * your settings, sessions, history or MCP tokens, and nothing it writes reaches your own
 * ~/.claude. It gets your model login only (claudeAiOauth, as a file), never the MCP tokens kept
 * next to it; if Claude refreshed the login, the new one is copied back (unless yours changed
 * meanwhile). The dir, login included, is deleted after the run; with `keepSessions` only the login
 * goes, so a build's later attempt can resume the session (the workbench removes the dir with the
 * workspace).
 */
export function claudeHome(dir: string, store: { read: () => ClaudeLogin | undefined; write: (login: ClaudeLogin, blob: ClaudeLogin["blob"]) => void } = { read: readClaudeLogin, write: writeClaudeLogin }, opts: { keepSessions?: boolean } = {}): { env: NodeJS.ProcessEnv; dir: string; done: () => void } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, ".credentials.json");
  const login = store.read();
  const given = login?.blob.claudeAiOauth ? JSON.stringify({ claudeAiOauth: login.blob.claudeAiOauth }) : undefined;
  if (given) writeFileSync(file, given, { mode: 0o600 });
  return {
    dir,
    env: { ...builderEnv(), CLAUDE_CONFIG_DIR: dir },
    done: () => {
      try {
        const after = existsSync(file) ? readFileSync(file, "utf8") : undefined;
        const refreshed = after && after !== given ? (JSON.parse(after) as ClaudeLogin["blob"]).claudeAiOauth : undefined;
        const yours = refreshed && login ? store.read() : undefined;
        if (refreshed && yours && JSON.stringify(yours.blob.claudeAiOauth) === JSON.stringify(login!.blob.claudeAiOauth)) store.write(yours, { ...yours.blob, claudeAiOauth: refreshed });
      } catch {
        // Copying back is a courtesy: your own Claude Code can sign in again.
      } finally {
        if (opts.keepSessions) rmSync(file, { force: true });
        else rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Where a build's Claude Code config directory lives (its sessions between attempts). */
export const claudeBuildHome = (platformHome: string, buildId: string) => join(platformHome, "builder-home", "claude", buildId);

/**
 * Codex's sessions (kept so a later attempt can resume) pile up in its own home: drop the ones
 * older than `days` (every build's are over by then).
 */
export function pruneCodexSessions(platformHome: string, days = 2) {
  const root = join(platformHome, "builder-home", "codex", ".codex", "sessions");
  if (!existsSync(root)) return;
  const cutoff = Date.now() - days * 86400_000;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  };
  try {
    walk(root);
  } catch {
    // Housekeeping only.
  }
}

/** Codex, headless. Its own HOME (no user skills, instructions or config); OS sandbox limits writes to the workspace. */
export const codexBuilder: CapabilityBuilder = {
  name: "codex",
  build: (job) => withModelCheck(job, codexRun),
};

/**
 * Codex's arguments for an attempt: fresh, or resuming the build's earlier thread with the failure.
 * Sessions stay on disk in its own home (no --ephemeral), so a thread can be resumed. `exec`'s own
 * options (the sandbox, the project root, the directory) go before `resume`, the shared ones after.
 */
export function codexArgs(job: BuildJob, resume?: string): string[] {
  const shared = ["--ignore-user-config", "--skip-git-repo-check", "--json", ...codexModelArgs(job)];
  const where = [
    // Codex's own sandbox cannot nest inside ours. When the platform confines the
    // builder, ours is the boundary and Codex's commands inherit it.
    "--sandbox", job.platformRoot ? "danger-full-access" : "workspace-write",
    // The workspace is the project root: never walk up looking for other AGENTS.md files.
    "-c", 'project_root_markers=["BUILDER.md"]',
    "-C", job.workspace,
  ];
  return resume ? ["exec", ...where, "resume", ...shared, resume, resumePrompt(job)] : ["exec", ...shared, ...where, builderPrompt(job)];
}

/**
 * Run an attempt: resuming the earlier session when there is one, else fresh. A resume that fails
 * before touching the workspace (the session gone, the CLI changed) starts over in the same attempt.
 */
async function withResume(builder: "claude" | "codex", job: BuildJob, run: (resume: string | undefined) => Promise<void>) {
  const earlier = sessionOf(builder, job);
  if (!earlier) return run(undefined);
  try {
    await run(earlier);
  } catch (e) {
    const err = e as { worked?: boolean; cancelled?: boolean; unavailable?: boolean; modelRejected?: boolean };
    if (err.worked !== false || err.cancelled || err.unavailable || err.modelRejected) throw e;
    forgetSession(job.buildId);
    appendFileSync(job.logPath, `${stamp()} couldn't resume the earlier session; starting over\n`);
    job.onActivity?.("couldn't resume the earlier session; starting over");
    await run(undefined);
  }
}

async function codexRun(job: BuildJob) {
  const isolated = codexHome(join(dirname(dirname(job.logPath)), "builder-home", "codex"));
  try {
    await withResume("codex", job, (resume) =>
      runCli(
        "codex",
        codexArgs(job, resume),
        job,
        codexActivity,
        TIMEOUT_MS,
        // Codex has a shell: no Keychain. Its auth lives in its own home.
        { ownState: [isolated.dir], denyKeychain: true },
        isolated.env,
        // Its thread, for the next attempt to resume.
        (e) => e?.type === "thread.started" && typeof e.thread_id === "string" && noteSession("codex", job.buildId, e.thread_id),
      ),
    );
  } finally {
    isolated.syncBack();
  }
}

/** Claude Code, headless, in its own config dir. No MCP servers; file tools only, no shell. */
export const claudeBuilder: CapabilityBuilder = {
  name: "claude",
  build: (job) => withModelCheck(job, claudeRun),
};

/** Claude Code's arguments for an attempt: fresh with a session id of its own, or resuming the build's earlier session with the failure. */
export function claudeArgs(job: BuildJob, session: { id: string; resume: boolean }): string[] {
  return [
    "-p", session.resume ? resumePrompt(job) : builderPrompt(job),
    ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
    "--output-format", "stream-json", "--verbose",
    ...claudeModelArgs(job),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    // None of your user settings, hooks, memory (CLAUDE.md) or skills; the login stays yours.
    // No project settings either: the workspace is the builder's to write, and settings there
    // (hooks, apiKeyHelper) would run commands. Hooks are off whatever loads.
    "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
    "--permission-mode", "acceptEdits",
    // File tools only: no shell now, and --restricted drops every code-running tool, also ones added later.
    "--restricted",
    "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep",
    "--disallowedTools", "Bash",
  ];
}

async function claudeRun(job: BuildJob) {
  // Its own dir per build (builds run side by side), kept between attempts for the session; the login only for a run.
  const home = claudeBuildHome(dirname(dirname(job.logPath)), job.buildId);
  await withResume("claude", job, async (resume) => {
    const session = { id: resume ?? randomUUID(), resume: !!resume };
    const isolated = claudeHome(home, undefined, { keepSessions: true });
    try {
      await runCli(
        "claude",
        claudeArgs(job, session),
        job,
        claudeActivity,
        TIMEOUT_MS,
        // Its login comes as a file in its own dir: no Keychain, none of your ~/.claude.
        { ownState: [isolated.dir, join(homedir(), "Library", "Caches", "claude-cli-nodejs"), join(homedir(), ".cache", "claude-cli-nodejs")], denyKeychain: true },
        isolated.env,
        // The session it ran as (the one asked for), for the next attempt to resume.
        (e) => e?.type === "system" && e.subtype === "init" && typeof e.session_id === "string" && noteSession("claude", job.buildId, e.session_id),
      );
    } finally {
      isolated.done();
    }
  });
}

export const BUILDERS: Record<string, CapabilityBuilder> = { codex: codexBuilder, claude: claudeBuilder };
