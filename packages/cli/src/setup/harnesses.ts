// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { HarnessStatus } from "@hewntools/host-workerd/surface/host.ts";
import { MARKDOWN, removeBlock, SHELL, writeBlock } from "./blocks.ts";

export { AGENT_POINTER } from "@hewntools/host-workerd/pointer.ts";
import { AGENT_POINTER } from "@hewntools/host-workerd/pointer.ts";

export interface SetupContext {
  url: string;
  home: string;
  /** Add the instruction-file pointer even where it is optional. */
  pointer: boolean;
}

export interface Step {
  describe: string;
  /** What the step does, for the web client to word plainly. */
  kind: "register" | "pointer" | "cleanup";
  /** File the step writes, if any. */
  file?: string;
  run: () => void;
}

/**
 * One agent harness: how to detect it and how to connect it to Hewn. Connecting registers Hewn's
 * address (no token: the harness signs in with OAuth, and the owner approves it in Hewn).
 */
export interface Harness {
  /** The agent name the approval card suggests for it. */
  agentId: string;
  label: string;
  /** Whether the harness needs the instruction-file pointer to find Hewn at all. */
  pointerRequired: boolean;
  pointerNote: string;
  detect(): boolean;
  /** Whether the harness has Hewn registered (reads its own config; never runs it). */
  registered(userHome: string): boolean;
  /** The address Hewn is registered at, when the harness's config says (to tell which Hewn it is). */
  registeredUrl?(userHome: string): string | undefined;
  steps(ctx: SetupContext): Step[];
  /** The harness's own OAuth sign-in to Hewn (opens the browser at Hewn's approval page). */
  login(url: string): string[];
  /** What to do when the sign-in failed, given its output. */
  loginFix(output: string): string;
}

/** Run a command under a pseudo-terminal (Claude Code's login refuses to run without one). */
export const withPty = (argv: string[]): string[] =>
  process.platform === "darwin" ? ["script", "-q", "/dev/null", ...argv] : ["script", "-qfec", argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"];

export type Exec = (command: string, args: string[], opts?: { allowFail?: boolean; cwd?: string }) => void;

export const realExec: Exec = (command, args, opts = {}) => {
  const r = spawnSync(command, args, { encoding: "utf8", ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${command} ${args.slice(0, 3).join(" ")} … failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  }
};

const onPath = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;

function shellProfile(home: string): string {
  const shell = basename(process.env.SHELL ?? "zsh");
  return join(home, shell === "bash" ? ".bashrc" : shell === "fish" ? ".config/fish/config.fish" : ".zshrc");
}

export function harnesses(exec: Exec = realExec): Harness[] {
  return [
    {
      agentId: "claude-code",
      label: "Claude Code",
      pointerRequired: false,
      pointerNote: "optional: Claude Code shows MCP server instructions, which already describe Hewn",
      detect: () => onPath("claude"),
      registered: (home) => {
        try {
          return !!JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers?.hewn;
        } catch {
          return false;
        }
      },
      registeredUrl: (home) => {
        try {
          const url = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers?.hewn?.url;
          return typeof url === "string" ? url : undefined;
        } catch {
          return undefined;
        }
      },
      login: () => withPty(["claude", "mcp", "login", "hewn"]),
      // `claude mcp login` is recent; older versions sign in from inside a session.
      loginFix: (output) =>
        /unknown command|unknown option|did you mean/i.test(output)
          ? "This Claude Code is too old to sign in from the command line. Update it (claude update), then connect again. Or sign in from Claude Code itself: run /mcp, pick hewn, then Authenticate, and approve it in Hewn."
          : "Run claude mcp login hewn in a terminal to see why. Or sign in from Claude Code itself: /mcp, pick hewn, then Authenticate.",
      steps(ctx) {
        const steps: Step[] = [
          {
            describe: `claude mcp add --scope user --transport http hewn ${ctx.url}  (replaces any existing 'hewn')`,
            kind: "register",
            run: () => {
              exec("claude", ["mcp", "remove", "--scope", "user", "hewn"], { allowFail: true });
              exec("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "hewn", ctx.url]);
            },
          },
        ];
        if (ctx.pointer) {
          const file = join(ctx.home, ".claude", "CLAUDE.md");
          steps.push({ describe: `add Hewn pointer block to ${file}`, kind: "pointer", file, run: () => writeBlock(file, AGENT_POINTER, MARKDOWN) });
        }
        return steps;
      },
    },
    {
      agentId: "codex",
      label: "Codex",
      pointerRequired: true,
      pointerNote: "required: Codex defers MCP tools and ignores server instructions",
      detect: () => onPath("codex"),
      registered: (home) => {
        const config = join(home, ".codex", "config.toml");
        return existsSync(config) && /^\[mcp_servers\.hewn\]/m.test(readFileSync(config, "utf8"));
      },
      registeredUrl: (home) => {
        const config = join(home, ".codex", "config.toml");
        if (!existsSync(config)) return undefined;
        const section = /^\[mcp_servers\.hewn\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(readFileSync(config, "utf8"))?.[1] ?? "";
        return /^\s*url\s*=\s*"([^"]+)"/m.exec(section)?.[1];
      },
      // `codex mcp add` signs in by itself when the server speaks OAuth: adding is the login.
      login: (url) => ["codex", "mcp", "add", "hewn", "--url", url],
      loginFix: (output) =>
        /unknown|unrecognized|unexpected argument/i.test(output)
          ? "This Codex is too old to sign in to MCP servers. Update it (npm install -g @openai/codex), then connect again."
          : `Run codex mcp login hewn in a terminal to see why, and approve it in Hewn.`,
      steps(ctx) {
        const profile = shellProfile(ctx.home);
        const agentsMd = join(ctx.home, ".codex", "AGENTS.md");
        const steps: Step[] = [];
        // Before OAuth, setup exported a static token from the shell profile.
        if (existsSync(profile) && /HEWN_CODEX_TOKEN/.test(readFileSync(profile, "utf8"))) {
          steps.push({ describe: `remove the old HEWN_CODEX_TOKEN block from ${profile}`, kind: "cleanup", file: profile, run: () => void removeBlock(profile, SHELL) });
        }
        steps.push(
          {
            describe: `codex mcp remove hewn  (the sign-in adds it again: codex mcp add hewn --url ${ctx.url})`,
            kind: "register",
            run: () => {
              exec("codex", ["mcp", "remove", "hewn"], { allowFail: true });
            },
          },
          { describe: `add Hewn pointer block to ${agentsMd}`, kind: "pointer", file: agentsMd, run: () => writeBlock(agentsMd, AGENT_POINTER, MARKDOWN) },
        );
        return steps;
      },
    },
    {
      agentId: "opencode",
      label: "OpenCode",
      pointerRequired: true,
      pointerNote: "required: OpenCode reads its global AGENTS.md, not MCP server instructions",
      detect: () => onPath("opencode"),
      registered: (home) => !!opencodeMcpUrl(home),
      registeredUrl: (home) => opencodeMcpUrl(home),
      // `opencode mcp auth` runs the server's OAuth sign-in (it opens the browser at Hewn's approval page).
      login: () => ["opencode", "mcp", "auth", "hewn"],
      loginFix: (output) =>
        /unknown (command|argument)|unrecognized|not found: hewn/i.test(output)
          ? "This OpenCode is too old to sign in to MCP servers. Update it (opencode upgrade), then connect again."
          : "Run opencode mcp auth hewn in a terminal to see why, and approve it in Hewn.",
      steps(ctx) {
        const dir = opencodeConfigDir(ctx.home);
        const agentsMd = join(dir, "AGENTS.md");
        return [
          {
            // Run in its global config directory: older OpenCode writes there whatever the directory, newer ones write to the directory's config.
            describe: `opencode mcp add hewn --url ${ctx.url}  (in ${dir}; replaces any existing 'hewn')`,
            kind: "register",
            run: () => {
              mkdirSync(dir, { recursive: true });
              exec("opencode", ["mcp", "add", "hewn", "--url", ctx.url], { cwd: dir });
            },
          },
          { describe: `add Hewn pointer block to ${agentsMd}`, kind: "pointer", file: agentsMd, run: () => writeBlock(agentsMd, AGENT_POINTER, MARKDOWN) },
        ];
      },
    },
  ];
}

/** OpenCode's global config directory: `$XDG_CONFIG_HOME/opencode` for your own home, else `<home>/.config/opencode`. */
export const opencodeConfigDir = (home: string, env: NodeJS.ProcessEnv = process.env) => join((home === homedir() && env.XDG_CONFIG_HOME) || join(home, ".config"), "opencode");

/** JSON with comments and trailing commas (OpenCode's `opencode.jsonc`), read leniently. */
export function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

/** The address Hewn is registered at in OpenCode's global config (`mcp.hewn`, or `mcp.servers.hewn` in newer versions). */
export function opencodeMcpUrl(home: string): string | undefined {
  const dir = opencodeConfigDir(home);
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      const cfg = parseJsonc(readFileSync(file, "utf8")) as { mcp?: { hewn?: { url?: unknown }; servers?: { hewn?: { url?: unknown } } } };
      const url = cfg?.mcp?.hewn?.url ?? cfg?.mcp?.servers?.hewn?.url;
      if (typeof url === "string") return url;
    } catch {
      // not readable as JSON: not registered as far as Hewn can tell
    }
  }
  return undefined;
}

/**
 * Where Hewn's entry sits in OpenCode's global config, and whether Hewn may edit that file: plain
 * JSON, yes; a `.jsonc` with comments or trailing commas is the owner's to edit (rewriting it would
 * lose them).
 */
export function opencodeHewnEntry(home: string): { file: string; editable: boolean } | undefined {
  const dir = opencodeConfigDir(home);
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    let cfg: { mcp?: { hewn?: unknown; servers?: { hewn?: unknown } } } | undefined;
    try {
      cfg = parseJsonc(text) as typeof cfg;
    } catch {
      continue;
    }
    if (!cfg?.mcp?.hewn && !cfg?.mcp?.servers?.hewn) continue;
    let editable = true;
    try {
      JSON.parse(text);
    } catch {
      editable = false;
    }
    return { file, editable };
  }
  return undefined;
}

/**
 * Take Hewn out of OpenCode's global config (`mcp.hewn`, or `mcp.servers.hewn`) and its sign-in to
 * Hewn out of OpenCode's MCP logins (`mcp-auth.json`): OpenCode has no `mcp remove`. Plain JSON
 * only (see `opencodeHewnEntry`); the login file is OpenCode's own JSON.
 */
export function opencodeForget(home: string, file: string, env: NodeJS.ProcessEnv = process.env): void {
  const cfg = JSON.parse(readFileSync(file, "utf8")) as { mcp?: { hewn?: unknown; servers?: { hewn?: unknown } } };
  if (cfg.mcp) {
    delete cfg.mcp.hewn;
    if (cfg.mcp.servers) delete cfg.mcp.servers.hewn;
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  const logins = join((home === homedir() && env.XDG_DATA_HOME) || join(home, ".local", "share"), "opencode", "mcp-auth.json");
  if (!existsSync(logins)) return;
  try {
    const auth = JSON.parse(readFileSync(logins, "utf8")) as Record<string, unknown>;
    if (!("hewn" in auth)) return;
    delete auth.hewn;
    writeFileSync(logins, JSON.stringify(auth, null, 2) + "\n");
  } catch {
    // not a file Hewn understands: left as it is
  }
}

export const defaultHome = () => homedir();

/** A macOS app in /Applications or ~/Applications. */
export const appInstalled = (name: string, userHome = homedir()) => process.platform === "darwin" && [join("/Applications", `${name}.app`), join(userHome, "Applications", `${name}.app`)].some((p) => existsSync(p));

/**
 * Desktop apps Hewn can tell the owner about. Neither is a harness of its own:
 * - Codex Desktop reads the same ~/.codex/config.toml and sign-in as the Codex CLI, so connecting
 *   Codex (the CLI's `codex mcp add`) connects both.
 * - Claude Desktop's custom connectors are reached from Anthropic's cloud (a localhost URL can't
 *   work) and are shared with claude.ai, so it connects through the tunnel, like claude.ai.
 */
export const DESKTOP_APPS: { agentId: string; label: string; app: string; via?: string; cloud?: true }[] = [
  { agentId: "codex-desktop", label: "Codex Desktop", app: "Codex", via: "codex" },
  { agentId: "claude-desktop", label: "Claude Desktop", app: "Claude", cloud: true },
];

/** What the Agents page lists: each harness (found, registered), then the desktop apps. */
export function harnessStatuses(list: Harness[], userHome: string, installed: (app: string) => boolean = (a) => appInstalled(a, userHome)): HarnessStatus[] {
  const rows: HarnessStatus[] = list.map((h) => ({ agentId: h.agentId, label: h.label, found: h.detect(), connected: h.registered(userHome) }));
  for (const d of DESKTOP_APPS) {
    const via = d.via ? rows.find((r) => r.agentId === d.via) : undefined;
    rows.push({ agentId: d.agentId, label: d.label, found: installed(d.app), connected: via?.connected ?? false, ...(d.via ? { via: d.via } : {}), ...(d.cloud ? { cloud: true } : {}) });
  }
  return rows;
}
