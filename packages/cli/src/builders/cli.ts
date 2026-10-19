// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
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
  if (job.feedback) {
    lines.push(`\nAttempt ${job.attempt}. The previous candidate FAILED platform validation:\n\n${job.feedback}\n\nFix the candidate.`);
  }
  return lines.join("\n");
}

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

function runCli(command: string, args: string[], job: BuildJob, format: Formatter, timeoutMs: number, confine: Confine, env: NodeJS.ProcessEnv = builderEnv()): Promise<void> {
  const write = (line: string) => appendFileSync(job.logPath, `${stamp()} ${line}\n`);
  write(`===== attempt ${job.attempt}: ${command}${job.platformRoot ? " (sandboxed)" : ""} =====`);
  if (job.platformRoot) {
    ({ command, args } = wrapBuilder(command, args, { workspace: job.workspace, platformRoot: job.platformRoot, ...confine }));
  }
  let unavailable: string | undefined;
  // Errors only (stderr, error and failed-result events), never the builder's own words about models.
  let modelRejected: string | undefined;
  // Only before the builder has done anything: a model that won't run fails at once, and a re-run
  // on the default must not start over a half-written workspace.
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
      else reject(new Error(`${command} exited with ${signal ?? code} (see ${job.logPath})`));
    });
  });
}

const TIMEOUT_MS = 15 * 60_000;

/**
 * Run with the asked-for model; if the CLI won't run it (retired, or not on this account), say so
 * and run again on the CLI's default, so the build still happens. The owner is told (the Inbox).
 */
export async function withModelFallback(job: BuildJob, run: (job: BuildJob) => Promise<void>): Promise<void> {
  try {
    await run(job);
  } catch (e) {
    if (!(e as { modelRejected?: boolean }).modelRejected || !job.model) throw e;
    const text = `${job.model} isn't available (${(e as Error).message.slice(0, 160)}); building with the default model instead`;
    appendFileSync(job.logPath, `${stamp()} ${text}\n`);
    job.onNote?.({ kind: "fallback", model: job.model, text });
    const { model: _model, ...rest } = job;
    await run(rest);
  }
}

/** `--model` / `--effort` for Claude Code. */
export const claudeModelArgs = (m: { model?: string; effort?: string }) => [...(m.model ? ["--model", m.model] : []), ...(m.effort ? ["--effort", m.effort] : [])];
/** `-m` / reasoning effort for Codex. */
export const codexModelArgs = (m: { model?: string; effort?: string }) => [...(m.model ? ["-m", m.model] : []), ...(m.effort && /^[a-z]{2,12}$/.test(m.effort) ? ["-c", `model_reasoning_effort="${m.effort}"`] : [])];

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
 * meanwhile). The dir, login included, is deleted after the run.
 */
export function claudeHome(dir: string, store: { read: () => ClaudeLogin | undefined; write: (login: ClaudeLogin, blob: ClaudeLogin["blob"]) => void } = { read: readClaudeLogin, write: writeClaudeLogin }): { env: NodeJS.ProcessEnv; dir: string; done: () => void } {
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
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Codex, headless. Its own HOME (no user skills, instructions or config); OS sandbox limits writes to the workspace. */
export const codexBuilder: CapabilityBuilder = {
  name: "codex",
  build: (job) => withModelFallback(job, codexRun),
};

async function codexRun(job: BuildJob) {
  const isolated = codexHome(join(dirname(dirname(job.logPath)), "builder-home", "codex"));
  try {
    await runCli(
      "codex",
      [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--skip-git-repo-check",
        "--json",
        ...codexModelArgs(job),
        // Codex's own sandbox cannot nest inside ours. When the platform confines the
        // builder, ours is the boundary and Codex's commands inherit it.
        "--sandbox", job.platformRoot ? "danger-full-access" : "workspace-write",
        // The workspace is the project root: never walk up looking for other AGENTS.md files.
        "-c", 'project_root_markers=["BUILDER.md"]',
        "-C", job.workspace,
        builderPrompt(job),
      ],
      job,
      codexActivity,
      TIMEOUT_MS,
      // Codex has a shell: no Keychain. Its auth lives in its own home.
      { ownState: [isolated.dir], denyKeychain: true },
      isolated.env,
    );
  } finally {
    isolated.syncBack();
  }
}

/** Claude Code, headless, in its own config dir. No MCP servers; file tools only, no shell. */
export const claudeBuilder: CapabilityBuilder = {
  name: "claude",
  build: (job) => withModelFallback(job, claudeRun),
};

async function claudeRun(job: BuildJob) {
  // Its own dir per build: builds run side by side.
  const isolated = claudeHome(join(dirname(dirname(job.logPath)), "builder-home", "claude", job.buildId));
  try {
    await runCli(
      "claude",
      [
        "-p", builderPrompt(job),
        "--output-format", "stream-json", "--verbose",
        ...claudeModelArgs(job),
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        // None of your user settings, hooks, memory (CLAUDE.md) or skills; the login stays yours.
        // No project settings either: the workspace is the builder's to write, and settings there
        // (hooks, apiKeyHelper) would run commands. Hooks are off whatever loads.
        "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep",
        "--disallowedTools", "Bash",
      ],
      job,
      claudeActivity,
      TIMEOUT_MS,
      // Its login comes as a file in its own dir: no Keychain, none of your ~/.claude.
      { ownState: [isolated.dir, join(homedir(), "Library", "Caches", "claude-cli-nodejs"), join(homedir(), ".cache", "claude-cli-nodejs")], denyKeychain: true },
      isolated.env,
    );
  } finally {
    isolated.done();
  }
}

export const BUILDERS: Record<string, CapabilityBuilder> = { codex: codexBuilder, claude: claudeBuilder };
