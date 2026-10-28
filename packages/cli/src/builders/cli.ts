// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, constants, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EFFORT } from "@hewntools/core/build-models.ts";
import { claudeActivity, codexActivity, opencodeActivity, USED_TOOL } from "./activity.ts";
import { MODEL_REJECTED, modelRejectReason, noteModelFailure, noteModelRan } from "./models.ts";
import { OPENCODE_NO_UPDATE, opencodeUserDirs } from "./opencode-dirs.ts";
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

/**
 * What a builder's environment keeps: the basics, its own model and login settings (the providers'
 * API keys OpenCode reads from the environment among them), proxies and CAs. Not the rest of yours
 * (tokens), and not OpenCode's own config variables: the run gets its own.
 */
const BUILDER_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|TZ|TMPDIR|LC_\w+|(ANTHROPIC|CLAUDE|OPENAI|CODEX)_\w+|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR))$/;
/** The other providers' keys OpenCode reads from the environment: its run only, no other builder's. */
export const OPENCODE_PROVIDER_ENV = /^((OPENROUTER|GEMINI|GOOGLE_GENERATIVE_AI|XAI|GROQ|MISTRAL|DEEPSEEK|OPENCODE)_API_KEY|OLLAMA_HOST)$/;
export const builderEnv = (env: NodeJS.ProcessEnv = process.env, also?: RegExp): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => BUILDER_ENV.test(k) || (also?.test(k) ?? false)));

function runCli(command: string, args: string[], job: BuildJob, format: Formatter, timeoutMs: number, confine: Confine, env: NodeJS.ProcessEnv = builderEnv(), onEvent?: (event: any) => void, quietStartMs?: number): Promise<void> {
  const write = (line: string) => appendFileSync(job.logPath, `${stamp()} ${line}\n`);
  write(`===== attempt ${job.attempt}: ${command}${job.platformRoot ? " (sandboxed)" : ""} =====`);
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
    const raw = createWriteStream(job.logPath.replace(/\.log$/, ".jsonl"), { flags: "a" });
    const child = spawn(command, args, { cwd: job.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    // A CLI that never says anything (OpenCode has been seen stuck before its first event): stop it early, with a reason.
    let stalled = false;
    let quiet = quietStartMs ? setTimeout(() => ((stalled = true), child.kill("SIGTERM")), quietStartMs) : undefined;
    const spoke = () => (clearTimeout(quiet), (quiet = undefined));
    createInterface({ input: child.stdout }).on("line", (line) => {
      spoke();
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
      if (USED_TOOL.test(activity)) usedTools = true;
      if (!unavailable && UNAVAILABLE.test(activity)) unavailable = activity.replace(/^\S+\s/, "");
      for (const l of activity.split("\n")) write(l);
      job.onActivity?.(activity.split("\n").at(-1)!);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (!line.trim()) return;
      spoke();
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
      spoke();
      job.signal?.removeEventListener("abort", cancel);
      if (job.signal?.aborted) return reject(Object.assign(new Error("cancelled"), { cancelled: true }));
      raw.end();
      if (code === 0) resolve();
      else if (stalled) reject(Object.assign(new Error(`${command} said nothing for ${Math.round(quietStartMs! / 60_000)} minutes, so Hewn stopped it (it never started); try again`), { usedTools }));
      else if (modelRejected) reject(Object.assign(new Error(modelRejected), { modelRejected: true }));
      else if (unavailable) reject(Object.assign(new Error(`${unavailable} (log in to ${job.builderName ?? "the builder CLI"}, or switch "builder" in platform.json)`), { unavailable: true }));
      else reject(Object.assign(new Error(`${command} exited with ${signal ?? code} (see ${job.logPath})`), { usedTools }));
    });
  });
}

const TIMEOUT_MS = 15 * 60_000;
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
  /** Your OpenCode directories (defaults: XDG under your home). */
  yours?: { config: string; data: string; cache: string };
  /** Your custom providers (`provider` in your config), carried over. Default: read from OpenCode. */
  providers?: () => Record<string, unknown> | undefined;
}

/**
 * OpenCode runs with a HOME of its own (`dir`, one per build or for the intake) and its config, data,
 * cache and state directories under it: none of your config, plugins, skills (~/.agents/skills,
 * ~/.claude/skills), sessions or MCP logins reach it, and nothing it writes reaches yours. It gets
 * your provider logins (auth.json) for the run, copied back if it refreshed them and removed after;
 * your custom providers (a local model server among them) are written into its config, with updates
 * and session sharing off, and the permissions on top as `OPENCODE_CONFIG_CONTENT` (above a project
 * config the builder could write). Its plugin SDK install is copied from yours when it's there (else
 * OpenCode installs it from npm, once per home), with your model list cache. The run can't read
 * ~/.claude's instructions or a project config (`OPENCODE_DISABLE_*`). What else it writes (a
 * build's session, for a later attempt to resume) stays until the dir goes.
 */
export async function opencodeHome(dir: string, o: OpencodeHomeOptions): Promise<{ env: NodeJS.ProcessEnv; dir: string; loopback: number[]; done: () => void }> {
  const yours = o.yours ?? opencodeUserDirs();
  const config = join(dir, "config", "opencode");
  const data = join(dir, "data", "opencode");
  const cache = join(dir, "cache", "opencode");
  for (const d of [dir, config, data, cache, join(dir, "state")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // Copies that may be big (the SDK is 60 MB in thousands of files): cloned where the file system can (APFS), and never a
  // synchronous wait, which once froze Hewn long enough for its watchdog to restart workerd under a running build.
  const clone = (from: string, to: string) => cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE });
  // The plugin SDK OpenCode installs into its config dir on every start when missing (from npm, minutes on a slow registry): yours instead.
  if (!existsSync(join(config, "node_modules")) && existsSync(join(yours.config, "node_modules", "@opencode-ai", "plugin"))) {
    for (const f of ["package.json", "package-lock.json", "node_modules"]) if (existsSync(join(yours.config, f))) await clone(join(yours.config, f), join(config, f));
  }
  for (const f of ["models.json", "bin"]) if (!existsSync(join(cache, f)) && existsSync(join(yours.cache, f))) await clone(join(yours.cache, f), join(cache, f));
  const providers = await (o.providers ?? opencodeProviders)();
  writeFileSync(join(config, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", ...(providers ? { provider: providers } : {}), ...o.rules }, null, 2));
  // Your provider logins for the run: copied in, back if the run refreshed them, gone after (as is the run's copy of your
  // provider config, which may carry keys too; the next attempt writes both again).
  const yourAuth = join(yours.data, "auth.json");
  const runAuth = join(data, "auth.json");
  if (existsSync(yourAuth)) copyFileSync(yourAuth, runAuth);
  const copied = existsSync(runAuth) ? statSync(runAuth).mtimeMs : 0;
  return {
    dir,
    loopback: loopbackPorts(providers),
    env: {
      ...builderEnv(process.env, OPENCODE_PROVIDER_ENV),
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_STATE_HOME: join(dir, "state"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", ...o.rules }),
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    },
    done: () => {
      if (existsSync(runAuth) && statSync(runAuth).mtimeMs > copied && existsSync(dirname(yourAuth))) copyFileSync(runAuth, yourAuth);
      rmSync(runAuth, { force: true });
      if (providers) writeFileSync(join(config, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", ...o.rules }, null, 2));
    },
  };
}

/**
 * Codex runs with its own HOME and CODEX_HOME (`dir`, one per build or per intake) holding your
 * auth.json for the run: none of your skills (~/.agents/skills), global AGENTS.md or config reach
 * it. auth.json is copied in before each run and, when done, copied back if Codex refreshed it
 * (your own Codex login and the builder's stay one and the same) and removed; what else Codex
 * wrote there (a build's thread, for a later attempt to resume) stays until the dir goes.
 */
export function codexHome(dir: string): { env: NodeJS.ProcessEnv; dir: string; done: () => void } {
  const codexDir = join(dir, ".codex");
  mkdirSync(codexDir, { recursive: true, mode: 0o700 });
  const yours = join(homedir(), ".codex", "auth.json");
  const theirs = join(codexDir, "auth.json");
  if (existsSync(yours)) copyFileSync(yours, theirs);
  const copied = existsSync(theirs) ? statSync(theirs).mtimeMs : 0;
  return {
    dir,
    env: { ...builderEnv(), HOME: dir, CODEX_HOME: codexDir },
    done: () => {
      if (existsSync(theirs) && statSync(theirs).mtimeMs > copied && existsSync(dirname(yours))) copyFileSync(theirs, yours);
      rmSync(theirs, { force: true });
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

/**
 * Where a build's builder home lives: Claude Code's config directory, Codex's HOME. One per build,
 * so a build's session (kept there between attempts) is its own: no other build's sandbox can read
 * or edit it. The workbench removes it with the workspace.
 */
export const claudeBuildHome = (platformHome: string, buildId: string) => join(platformHome, "builder-home", "claude", buildId);
export const codexBuildHome = (platformHome: string, buildId: string) => join(platformHome, "builder-home", "codex", buildId);
export const opencodeBuildHome = (platformHome: string, buildId: string) => join(platformHome, "builder-home", "opencode", buildId);

/** Codex, headless. Its own HOME (no user skills, instructions or config); OS sandbox limits writes to the workspace. */
export const codexBuilder: CapabilityBuilder = {
  name: "codex",
  build: (job) => withModelCheck("codex", job, codexRun),
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
 * before the builder used any tool (the session gone, the CLI changed) starts over in the same
 * attempt; one that fails after is a failed attempt like any other (the workspace may be half-changed).
 */
export async function withResume(builder: keyof typeof sessions, job: BuildJob, run: (resume: string | undefined) => Promise<void>) {
  const earlier = sessionOf(builder, job);
  if (!earlier) return run(undefined);
  try {
    await run(earlier);
  } catch (e) {
    const err = e as { usedTools?: boolean; cancelled?: boolean; unavailable?: boolean; modelRejected?: boolean };
    if (err.usedTools !== false || err.cancelled || err.unavailable || err.modelRejected) throw e;
    forgetSession(job.buildId);
    appendFileSync(job.logPath, `${stamp()} couldn't resume the earlier session; starting over\n`);
    job.onActivity?.("couldn't resume the earlier session; starting over");
    await run(undefined);
  }
}

async function codexRun(job: BuildJob) {
  // Its own home per build (builds run side by side), kept between attempts for the thread; the login only for a run.
  const home = codexBuildHome(dirname(dirname(job.logPath)), job.buildId);
  await withResume("codex", job, async (resume) => {
    const isolated = codexHome(home);
    try {
      await runCli(
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
      );
    } finally {
      isolated.done();
    }
  });
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
  // Its own home per build (builds run side by side), kept between attempts for the session; the login only for a run.
  const home = opencodeBuildHome(dirname(dirname(job.logPath)), job.buildId);
  await withResume("opencode", job, async (resume) => {
    const isolated = await opencodeHome(home, { rules: OPENCODE_BUILDER_RULES });
    try {
      // Asked from the run's own home, not the workspace (builder-written from the second attempt on).
      if (job.model && !(await opencodeHasModel(job.model, isolated.env, isolated.dir))) throw opencodeModelRejected(job.model);
      await runCli(
        "opencode",
        opencodeArgs(job, resume),
        job,
        opencodeActivity,
        TIMEOUT_MS,
        // Its logins come as a file in its own home: no Keychain, none of your ~/.config/opencode. A local model server's port stays open.
        { ownState: [isolated.dir], denyKeychain: true, allowLoopback: isolated.loopback },
        isolated.env,
        // Its session (every event names it), for the next attempt to resume.
        (e) => typeof e?.sessionID === "string" && e.sessionID && noteSession("opencode", job.buildId, e.sessionID),
        OPENCODE_QUIET_START_MS,
      );
    } finally {
      isolated.done();
    }
  });
}

/** Claude Code, headless, in its own config dir. No MCP servers; file tools only, no shell. */
export const claudeBuilder: CapabilityBuilder = {
  name: "claude",
  build: (job) => withModelCheck("claude", job, claudeRun),
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
