// SPDX-License-Identifier: AGPL-3.0-or-later
// The builders' own homes, one per vendor, each signed in by the vendor's own flow (`hewn builder sign-in <vendor>`).
// Builds and the intake run in their vendor's home. Hewn never reads, copies or writes the login in it: whether a
// builder is signed in is asked of the vendor's own CLI.
import { execFile, spawn } from "node:child_process";
import { constants, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builderEnv, OPENCODE_PROVIDER_ENV } from "./env.ts";
import { OPENCODE_NO_UPDATE, opencodeUserDirs } from "./opencode-dirs.ts";

export type BuilderVendor = "claude" | "codex" | "opencode";
export const BUILDER_VENDORS: BuilderVendor[] = ["claude", "codex", "opencode"];
export const isBuilderVendor = (name: string): name is BuilderVendor => (BUILDER_VENDORS as string[]).includes(name);
const LABEL: Record<BuilderVendor, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

/**
 * A vendor's builder home on this Hewn: one, shared by its builds (each in a session of its own) and the intake.
 * Absolute and resolved, the same at sign-in and at every run: Claude Code names its login after the path.
 * `HEWN_BUILDER_HOME` puts the homes elsewhere (the bench: one sign-in for many throwaway Hewns).
 */
export const builderHome = (platformHome: string, vendor: BuilderVendor) => (process.env.HEWN_BUILDER_HOME ? resolve(process.env.HEWN_BUILDER_HOME, vendor) : resolve(platformHome, "builder-home", vendor));

/** The command that signs a builder in: for the terminal (the CLI, the build's log, `hewn doctor`), never the web. */
export const signInCommand = (vendor: BuilderVendor) => `hewn builder sign-in ${vendor}`;

/** What the owner reads on the web when a builder isn't signed in: where to go, in words. */
export const notSignedInWords = (vendor: BuilderVendor) => `${LABEL[vendor]} isn't signed in on this Hewn. Sign in from the terminal on the machine that runs it.`;

/** A build or a talk with the intake stops with this when its builder isn't signed in: retrying won't help. */
export const notSignedIn = (vendor: BuilderVendor) => Object.assign(new Error(notSignedInWords(vendor)), { unavailable: true, notSignedIn: true });

/**
 * Signed in, but `claude -p` didn't use the sign-in: Claude Code's announced change (`--bare`, which "never reads
 * OAuth credentials", becoming the default for `-p`) would do this. Loud, so it's noticed the day it lands.
 */
export const claudeSignInIgnored = () =>
  Object.assign(new Error("Claude Code is signed in on this Hewn, but didn't use the sign-in. A newer Claude Code may no longer let Hewn's builds use it: keep the Claude Code version you had until Hewn handles it."), { unavailable: true });

/** Codex keeps its login in a file in its home, never the system keyring (a confined build can't reach that). */
export const CODEX_FILE_LOGIN = ["-c", 'cli_auth_credentials_store="file"'];

/** Each vendor's CLI pointed at its home; `base` is the rest of its environment. */
export const claudeEnv = (home: string, base: NodeJS.ProcessEnv = builderEnv()): NodeJS.ProcessEnv => ({ ...base, CLAUDE_CONFIG_DIR: home });
export const codexEnv = (home: string, base: NodeJS.ProcessEnv = builderEnv()): NodeJS.ProcessEnv => ({ ...base, HOME: home, CODEX_HOME: join(home, ".codex") });
/** OpenCode's HOME and its XDG directories: none of your config, plugins, skills (~/.agents, ~/.claude) or sessions reach it. */
export const opencodeEnv = (home: string, base: NodeJS.ProcessEnv = builderEnv(process.env, OPENCODE_PROVIDER_ENV)): NodeJS.ProcessEnv => ({
  ...base,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"),
  XDG_STATE_HOME: join(home, "state"),
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
});

/**
 * OpenCode also runs on its free tier, local models and keys from the environment, so a home with no provider login
 * still builds: its sign-in having run is what makes it ready (this file, Hewn's own, holds nothing of the login).
 */
const OPENCODE_READY = ".hewn-ready";

/**
 * An OpenCode home's directories, and what OpenCode would otherwise fetch on its first start: its plugin SDK (from
 * npm, minutes on a slow registry) and its model list, copied from your own OpenCode when it has them. Cloned where
 * the file system can (APFS), never a synchronous wait (the SDK is 60 MB in thousands of files).
 */
export async function prepareOpencodeHome(home: string, yours = opencodeUserDirs()): Promise<void> {
  const config = join(home, "config", "opencode");
  const cache = join(home, "cache", "opencode");
  for (const d of [home, config, join(home, "data", "opencode"), cache, join(home, "state")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const clone = (from: string, to: string) => cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE });
  if (!existsSync(join(config, "node_modules")) && existsSync(join(yours.config, "node_modules", "@opencode-ai", "plugin"))) {
    for (const f of ["package.json", "package-lock.json", "node_modules"]) if (existsSync(join(yours.config, f))) await clone(join(yours.config, f), join(config, f));
  }
  for (const f of ["models.json", "bin"]) if (!existsSync(join(cache, f)) && existsSync(join(yours.cache, f))) await clone(join(yours.cache, f), join(cache, f));
}

export interface CliAnswer {
  code: number;
  stdout: string;
  stderr: string;
}
export type AskCli = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CliAnswer>;
/** A vendor's CLI asked a question (never a synchronous wait: Hewn keeps serving meanwhile). */
const askCli: AskCli = (command, args, env) =>
  new Promise((done) =>
    execFile(command, args, { env, cwd: tmpdir(), encoding: "utf8", timeout: 20_000 }, (e, stdout, stderr) =>
      done({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    ),
  );

/**
 * Whether a builder is signed in on this Hewn, as its own CLI says in its home: `claude auth status`, `codex login
 * status`; OpenCode once its sign-in has run. `undefined`: can't tell (the CLI didn't answer).
 */
export async function signedIn(vendor: BuilderVendor, platformHome: string, ask: AskCli = askCli): Promise<boolean | undefined> {
  const home = builderHome(platformHome, vendor);
  if (!existsSync(home)) return false;
  if (vendor === "opencode") return existsSync(join(home, OPENCODE_READY));
  if (vendor === "claude") {
    const r = await ask("claude", ["auth", "status", "--json"], claudeEnv(home));
    try {
      return JSON.parse(r.stdout).loggedIn === true;
    } catch {
      return undefined;
    }
  }
  const r = await ask("codex", ["login", "status", ...CODEX_FILE_LOGIN], codexEnv(home));
  const said = r.stdout + r.stderr;
  return /not logged in/i.test(said) ? false : r.code === 0 && /logged in/i.test(said) ? true : undefined;
}

/**
 * Builder homes as they were up to 0.4.12: one per build (`builder-home/<vendor>/<build>`) and per talk with the intake
 * (`builder-home/intake-*`), which held a copy of the login for a run. Removed when Hewn starts: no build runs then.
 */
export function removeOldBuilderHomes(platformHome: string) {
  const root = join(platformHome, "builder-home");
  if (!existsSync(root)) return;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("intake-")) rmSync(join(root, e.name), { recursive: true, force: true });
    else if (isBuilderVendor(e.name)) for (const b of readdirSync(join(root, e.name))) if (/^b-[0-9a-f]+$/.test(b)) rmSync(join(root, e.name, b), { recursive: true, force: true });
  }
}

/** Anthropic's Commercial Terms, which running Claude Code in a product falls under. */
export const CLAUDE_TERMS_URL = "https://www.anthropic.com/legal/commercial-terms";
export const CLAUDE_TERMS_ASK = `Hewn runs Claude Code to build your tools. Running Claude Code in a product falls under Anthropic's Commercial Terms:\n  ${CLAUDE_TERMS_URL}\nAccept them for this Hewn? [y/N] `;

export interface SignInIO {
  print: (line: string) => void;
}
/** The vendor's own sign-in, attached to this terminal; its exit code. */
export type RunAttached = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
const runAttached: RunAttached = (command, args, env) =>
  new Promise((done) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", () => done(127));
    child.once("close", (code) => done(code ?? 1));
  });

/**
 * `hewn builder sign-in <vendor>`: the vendor's own sign-in (`claude auth login`, `codex login`, `opencode auth login`),
 * run in this terminal with the builder's home in place of yours. The login is made by that flow and stays in the home;
 * Hewn never sees it. `extra`: the vendor's own options (`--device-auth` for Codex on a machine without a browser).
 * Your own sign-ins (~/.claude, ~/.codex, your OpenCode) stay as they are.
 */
export async function signIn(vendor: BuilderVendor, platformHome: string, o: { io: SignInIO; extra?: string[]; run?: RunAttached; ask?: AskCli }): Promise<boolean> {
  const home = builderHome(platformHome, vendor);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (vendor === "opencode") {
    await prepareOpencodeHome(home);
    writeFileSync(join(home, OPENCODE_READY), "OpenCode's sign-in ran here: its builds may run on its free tier, local models or keys from the environment.\n");
  }
  const extra = o.extra ?? [];
  const [command, args, env] =
    vendor === "claude"
      ? (["claude", ["auth", "login", ...extra], claudeEnv(home, process.env)] as const)
      : vendor === "codex"
        ? (["codex", ["login", ...CODEX_FILE_LOGIN, ...extra], codexEnv(home, process.env)] as const)
        : (["opencode", ["auth", "login", ...extra], { ...opencodeEnv(home, process.env), ...OPENCODE_NO_UPDATE }] as const);
  o.io.print(`${LABEL[vendor]} signs in for this Hewn's builds, in a home of its own (${home}); your own ${LABEL[vendor]} stays signed in as it is.`);
  o.io.print(`Running ${command} ${args.join(" ")}:\n`);
  const code = await (o.run ?? runAttached)(command, [...args], env);
  if (code === 127) {
    o.io.print(`\n✖ ${command} isn't on PATH: install ${LABEL[vendor]} first.`);
    return false;
  }
  const ok = await signedIn(vendor, platformHome, o.ask);
  if (vendor === "opencode") o.io.print(`\n✔ OpenCode is set up for this Hewn's builds${code === 0 ? "" : " (no provider signed in: it runs on its free tier, local models or keys from the environment)"}.`);
  else o.io.print(ok ? `\n✔ ${LABEL[vendor]} is signed in for this Hewn's builds.` : `\n✖ ${LABEL[vendor]} isn't signed in for this Hewn's builds${ok === undefined ? " (it didn't say)" : ""}. Try again: ${signInCommand(vendor)}`);
  return ok === true;
}

/**
 * The `claude -p` tripwire, read from `claude --help`: `--bare` (which "never reads OAuth credentials") is announced
 * as the future default for `-p`. A `--no-bare` option, or `--bare`'s own text calling itself the default, means
 * builds on the sign-in would stop. Why, or undefined when nothing says so.
 */
export function claudeBareDefault(help: string): string | undefined {
  if (/(^|\s)--no-bare\b/.test(help)) return "Claude Code has a --no-bare option, so `claude -p` runs without the sign-in unless told otherwise";
  // The option's own text: from its line to the next option's (options sit two spaces in; their text further).
  const bare = /^ {1,4}--bare\b[\s\S]*?(?=^ {1,4}-|(?![\s\S]))/m.exec(help)?.[0] ?? "";
  if (/\bdefault\b/i.test(bare)) return "Claude Code's help says --bare is the default, so `claude -p` may run without the sign-in";
  return undefined;
}
