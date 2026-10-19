// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED } from "./app-dir.ts";
import { isWsl } from "./open-url.ts";

/**
 * Hewn (`hewn serve`) as a background service that starts at login and restarts if it stops:
 * a launchd agent on macOS, a systemd user unit on Linux (and WSL with systemd).
 * Logs go to <home>/logs/hewn.log, rotated by Hewn itself.
 */

export const KIND: "launchd" | "systemd" = platform() === "darwin" ? "launchd" : "systemd";
export const LABEL = "tools.hewn.hewn";
const UNIT = "hewn.service";
export const unitPath = (userHome = homedir()) =>
  KIND === "launchd" ? join(userHome, "Library", "LaunchAgents", `${LABEL}.plist`) : join(process.env.XDG_CONFIG_HOME ?? join(userHome, ".config"), "systemd", "user", UNIT);
export const logFile = (homeRoot: string) => join(homeRoot, "logs", "hewn.log");
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface ServiceSpec {
  node: string;
  script: string;
  homeRoot: string;
  port: number;
  /** PATH for Hewn, so it finds codex / claude / bwrap like your shell does. */
  path: string;
}

export const defaultSpec = (homeRoot: string, port: number): ServiceSpec => ({
  node: process.execPath,
  // The CLI itself: cli.ts in a checkout, dist/cli.js in the npm package (this code is bundled into it).
  script: fileURLToPath(new URL(BUNDLED ? "./cli.js" : "./cli.ts", import.meta.url)),
  homeRoot,
  port,
  path: process.env.PATH ?? "/usr/bin:/bin",
});

const env = (s: ServiceSpec) => ({ HEWN_HOME: s.homeRoot, HEWN_PORT: String(s.port), HEWN_LOG_FILE: logFile(s.homeRoot), PATH: s.path });

export function plist(s: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(s.node)}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${xml(s.script)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env(s)).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>WorkingDirectory</key><string>${xml(dirname(dirname(s.script)))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(logFile(s.homeRoot))}.crash</string>
</dict>
</plist>
`;
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function systemdUnit(s: ServiceSpec): string {
  return `[Unit]
Description=Hewn (personal capability platform)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${dirname(dirname(s.script))}
ExecStart=${q(s.node)} --disable-warning=ExperimentalWarning ${q(s.script)} serve
${Object.entries(env(s)).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=3
StandardOutput=null
StandardError=append:${logFile(s.homeRoot)}.crash

[Install]
WantedBy=default.target
`;
}

type Run = (cmd: string, ...args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };
let runner: Run = (cmd, ...args) => spawnSync(cmd, args, { encoding: "utf8" });
const run: Run = (cmd, ...args) => runner(cmd, ...args);
/** Tests: replace launchctl/systemctl. Returns a function that puts the real one back. */
export function useRunner(r: Run): () => void {
  const real = runner;
  runner = r;
  return () => void (runner = real);
}
const domain = () => `gui/${userInfo().uid}`;
const systemctl = (...args: string[]) => run("systemctl", "--user", ...args);
const busLost = (r: ReturnType<typeof run>) => /Failed to connect to (user scope )?bus/i.test(`${r.stderr}${r.stdout}`);

/** This shell's view of its systemd user session: XDG_RUNTIME_DIR, and whether /run/user/<uid> exists. */
export interface UserSession {
  runtimeDir?: string;
  managerDir: boolean;
}
const userSession = (): UserSession => ({ runtimeDir: process.env.XDG_RUNTIME_DIR, managerDir: existsSync(`/run/user/${userInfo().uid}`) });

/**
 * `systemctl --user` can't reach the user's systemd. A shell from `sudo -iu` or `su` has no login
 * session: no XDG_RUNTIME_DIR, and (without lingering) no user manager at all. On WSL it's usually
 * WSLg mounting its own /run/user/<uid> over systemd's, which hides the bus; restarting the user
 * manager brings it back.
 */
export function busFix(wsl = isWsl(), session: UserSession = userSession(), user = userInfo().username): string {
  const machinectl = `or open the shell with sudo machinectl shell ${user}@ (package systemd-container), which sets it up`;
  if (!session.runtimeDir && !session.managerDir)
    return `No systemd user manager runs for ${user} (a shell from sudo -iu or su doesn't start one). From an account with sudo: sudo loginctl enable-linger ${user}. Then in this shell: export XDG_RUNTIME_DIR=/run/user/$(id -u), and try again (${machinectl}).`;
  if (!session.runtimeDir)
    return `This shell has no XDG_RUNTIME_DIR (sudo -iu and su don't set it). Run: export XDG_RUNTIME_DIR=/run/user/$(id -u), then try again (${machinectl}).`;
  const restart = "sudo systemctl restart user@$(id -u).service";
  return wsl
    ? `WSLg hid systemd's user bus (it mounts its own /run/user/$(id -u) over it). Run: ${restart}, then try again. If ps -p 1 -o comm= doesn't print systemd, enable systemd in /etc/wsl.conf first (see the quickstart).`
    : `Your user's systemd isn't reachable. Run: ${restart} (or log out and in again), then try again.`;
}

const fail = (what: string, r: ReturnType<typeof run>): never => {
  throw new Error(`${what} failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}${busLost(r) ? `\n  ${busFix()}` : ""}`);
};

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Home and port of the installed service, read from its plist or systemd unit (undefined if not installed). */
export function installed(path = unitPath()): { homeRoot: string; port: number } | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const env = (k: string): string | undefined => {
    if (path.endsWith(".plist")) {
      const v = new RegExp(`<key>${k}</key><string>([^<]*)</string>`).exec(text)?.[1];
      return v === undefined ? undefined : unxml(v);
    }
    // systemd: Environment="KEY=value" (quotes and backslashes escaped, see q())
    return new RegExp(`^Environment="${k}=((?:[^"\\\\]|\\\\.)*)"$`, "m").exec(text)?.[1]?.replace(/\\(.)/g, "$1");
  };
  const home = env("HEWN_HOME");
  return home === undefined ? undefined : { homeRoot: home, port: Number(env("HEWN_PORT") ?? 7717) };
}

/**
 * Why installing `spec` over the current service needs --force, or undefined if it doesn't.
 * Guards against a shell with another instance's HEWN_HOME/HEWN_PORT silently repointing the service.
 */
export function replaceConflict(current: { homeRoot: string; port: number } | undefined, spec: ServiceSpec): string | undefined {
  if (!current || (current.homeRoot === spec.homeRoot && current.port === spec.port)) return undefined;
  return (
    `Hewn's service is installed for ${current.homeRoot} (port ${current.port}); this would move it to ${spec.homeRoot} (port ${spec.port}).\n` +
    `  Check HEWN_HOME / HEWN_PORT in this shell, or re-run with --force to replace it.`
  );
}

export function install(spec: ServiceSpec, opts: { force?: boolean } = {}): void {
  const conflict = replaceConflict(installed(), spec);
  if (conflict && !opts.force) throw new Error(conflict);
  mkdirSync(dirname(unitPath()), { recursive: true });
  mkdirSync(dirname(logFile(spec.homeRoot)), { recursive: true });
  if (KIND === "launchd") {
    writeFileSync(unitPath(), plist(spec));
    run("launchctl", "bootout", `${domain()}/${LABEL}`);
    const r = run("launchctl", "bootstrap", domain(), unitPath());
    if (r.status !== 0) fail("launchctl bootstrap", r);
    return;
  }
  writeFileSync(unitPath(), systemdUnit(spec));
  for (const args of [["daemon-reload"], ["enable", "--now", UNIT]]) {
    const r = systemctl(...args);
    if (r.status !== 0) fail(`systemctl --user ${args.join(" ")}`, r);
  }
  // Keep the user's services running without an open login session (so Hewn starts at boot).
  run("loginctl", "enable-linger", userInfo().username);
}

/**
 * Stop the service and remove it. If it can't be stopped, the unit file stays: deleting it would
 * leave a Hewn running that `hewn service` can no longer see.
 */
export function uninstall({ kind = KIND, path = unitPath() } = {}): void {
  if (kind === "launchd") {
    if (status(kind).loaded) {
      const r = run("launchctl", "bootout", `${domain()}/${LABEL}`);
      if (r.status !== 0 && status(kind).loaded) fail("launchctl bootout", r);
    }
  } else if (existsSync(path)) {
    const r = systemctl("disable", "--now", UNIT);
    if (r.status !== 0) fail("systemctl --user disable --now", r);
  }
  rmSync(path, { force: true });
  if (kind === "systemd") systemctl("daemon-reload");
}

/** Stop until next login (or `start`); the service stays installed. False if it wasn't running. */
export function stop(kind = KIND): boolean {
  if (kind === "launchd") {
    if (!status(kind).loaded) return false;
    const r = run("launchctl", "bootout", `${domain()}/${LABEL}`);
    if (r.status !== 0 && status(kind).loaded) fail("launchctl bootout", r);
    return true;
  }
  const r = systemctl("stop", UNIT);
  if (r.status !== 0) fail("systemctl --user stop", r);
  return true;
}

/** Restart a running service (picks up new code). */
export function restart(): void {
  const r = KIND === "launchd" ? run("launchctl", "kickstart", "-k", `${domain()}/${LABEL}`) : systemctl("restart", UNIT);
  if (r.status !== 0) fail("restart (is it installed? hewn service install)", r);
}

export function start(): void {
  if (!existsSync(unitPath())) throw new Error("not installed: run hewn service install");
  if (KIND === "launchd") {
    // Already loaded: bootstrap would fail ("5: Input/output error"), so just make sure it runs.
    if (status().loaded) {
      run("launchctl", "kickstart", `${domain()}/${LABEL}`);
      return;
    }
    const r = run("launchctl", "bootstrap", domain(), unitPath());
    if (r.status !== 0 && !/already/i.test(r.stderr)) fail("launchctl bootstrap", r);
  } else {
    const r = systemctl("start", UNIT);
    if (r.status !== 0) fail("systemctl --user start", r);
  }
}

export function status(kind = KIND): { installed: boolean; loaded: boolean; running: boolean; pid?: number; lastExit?: string; busLost?: boolean } {
  const installed = existsSync(unitPath());
  if (kind === "launchd") {
    const r = run("launchctl", "print", `${domain()}/${LABEL}`);
    if (r.status !== 0) return { installed, loaded: false, running: false };
    const pid = /\bpid = (\d+)/.exec(r.stdout)?.[1];
    const lastExit = /last exit code = ([^\n]+)/.exec(r.stdout)?.[1]?.trim();
    return { installed, loaded: true, running: /\bstate = running\b/.test(r.stdout), ...(pid ? { pid: Number(pid) } : {}), ...(lastExit ? { lastExit } : {}) };
  }
  const r = systemctl("show", UNIT, "--property=LoadState,ActiveState,MainPID,ExecMainStatus");
  if (r.status !== 0) return { installed, loaded: false, running: false, ...(busLost(r) ? { busLost: true } : {}) };
  const prop = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout)?.[1];
  const pid = Number(prop("MainPID") ?? 0);
  const exit = prop("ExecMainStatus");
  return { installed, loaded: prop("LoadState") === "loaded", running: prop("ActiveState") === "active", ...(pid ? { pid } : {}), ...(exit && exit !== "0" ? { lastExit: exit } : {}) };
}

/**
 * Send console output to a size-rotated log file (hewn.log, .1, .2, .3; 5 MB each).
 * Used when Hewn runs as a service (HEWN_LOG_FILE set).
 */
export function logToFile(path: string, maxBytes = 5 * 1024 * 1024, keep = 3) {
  // If the file can't be written, fall back to stderr (launchd sends it to hewn.log.crash),
  // so a failing daemon never goes silent.
  const stderr = console.error.bind(console);
  let warned = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // reported by the first failing write below
  }
  const rotate = () => {
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    renameSync(path, `${path}.1`);
  };
  const write = (...parts: unknown[]) => {
    try {
      if (existsSync(path) && statSync(path).size > maxBytes) rotate();
      appendFileSync(path, parts.map((p) => (typeof p === "string" ? p : p instanceof Error ? (p.stack ?? p.message) : JSON.stringify(p))).join(" ") + "\n");
    } catch (e) {
      // logging must never take Hewn down
      if (!warned) stderr(`log file ${path} not writable (${(e as Error).message}); logging to stderr`);
      warned = true;
      stderr(...parts);
    }
  };
  console.error = write;
  console.log = write;
  console.warn = write;
}
