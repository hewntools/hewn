// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, realpathSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Seatbelt profile for headless builders. Reads are deny-based (builders legitimately need their
 * own CLI install, auth files and model API): no reads of the platform home except the build
 * workspace, no reads of the user's repos and credential stores. Writes are allow-based: only the
 * workspace, temp and the builder's own state dirs, anywhere on the disk (a builder that could
 * write to /opt/homebrew/bin or /Applications could plant a program the user runs unsandboxed).
 */
export interface BuilderSandboxOptions {
  workspace: string;
  platformRoot: string;
  /** The builder's own state/auth locations under $HOME (writable). */
  ownState: string[];
  /** For builders with a shell: block the `security` CLI and Keychain files (their auth must not need them). */
  denyKeychain: boolean;
  home?: string;
}

const q = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Locations under $HOME that hold the user's work and credentials. The builders' own logins are
 * here too (.claude, .codex): each builder re-opens only its own (`ownState`).
 */
export const PRIVATE_HOME_DIRS = [
  "github", "Documents", "Desktop", "Downloads",
  ".ssh", ".aws", ".azure", ".gnupg", ".config", ".docker", ".kube", ".gem", ".cargo", ".password-store", ".local/share/keyrings", ".mozilla",
  ".claude", ".codex",
  "Library/Keychains", "Library/Application Support", "Library/Cookies", "Library/Mail", "Library/Messages", "Library/Safari",
];
/** Files directly under $HOME with credentials or history. */
export const PRIVATE_HOME_FILES = [".npmrc", ".netrc", ".pypirc", ".git-credentials", ".zsh_history", ".bash_history", ".claude.json", ".claude.json.backup"];

/** The per-user folder $TMPDIR sits in on macOS (/private/var/folders/xx/yyyy, holding T/ and C/), else $TMPDIR. */
function userTempRoot(): string {
  const t = real(tmpdir());
  return /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(t) ? dirname(t) : t;
}

export function builderProfile(o: BuilderSandboxOptions): string {
  const home = real(o.home ?? homedir());
  const sub = (ps: string[]) => ps.map((p) => `(subpath ${q(real(p))})`).join(" ");
  // Claude loads its own login from the Keychain; builders without a shell keep the Keychain dir readable.
  const privateDirs = [...PRIVATE_HOME_DIRS.filter((d) => o.denyKeychain || d !== "Library/Keychains"), ...PRIVATE_HOME_FILES].map((d) => join(home, d));
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${sub([o.platformRoot, ...privateDirs])})`,
    // Not Hewn's own ports (or anything else on this machine): builders only need their model API.
    '(deny network-outbound (remote ip "localhost:*"))',
    "(allow file-read-metadata)",
    `(allow file-read* ${sub([o.workspace, ...o.ownState])})`,
    '(deny file-write* (subpath "/"))',
    // Temp: $TMPDIR's per-user folder (its T/ and C/: temp and caches) and /tmp.
    `(allow file-write* ${sub([userTempRoot(), "/private/tmp", ...o.ownState])} (literal "/dev/null") (regex #"^/dev/tty"))`,
    // Later rules win: re-deny the platform home (it may sit under tmp), then open the workspace.
    `(deny file-write* ${sub([o.platformRoot])})`,
    `(allow file-write* ${sub([o.workspace, ...o.ownState])})`,
    // The Security framework mach service stays reachable: TLS root certificates load through it
    // (codex fails with "UnknownIssuer" otherwise). Keychain files are unreadable (PRIVATE_HOME_DIRS)
    // and the `security` CLI is blocked; programmatic Security-framework access remains (an accepted gap).
    o.denyKeychain ? '(deny process-exec (literal "/usr/bin/security"))' : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The same deny model with bubblewrap (Linux, WSL): the filesystem is read-only, the platform home
 * and the private dirs are hidden behind empty tmpfs mounts, and only the workspace, temp and
 * the builder's own state are writable. Network is shared (builders need their model API), loopback
 * included: unlike Seatbelt, bubblewrap can't take loopback away and keep the rest (a known gap on Linux).
 */
export function bubblewrapArgs(o: BuilderSandboxOptions): string[] {
  const home = real(o.home ?? homedir());
  // An empty tmpfs over the path (nothing to read), made read-only after the binds below are in place.
  const hidden: string[] = [];
  const own = new Set(o.ownState.map(real));
  const hide = (p: string) => (existsSync(p) && !own.has(real(p)) ? (hidden.push(real(p)), ["--tmpfs", real(p)]) : []);
  // A file: an empty one bound over it.
  const hideFile = (p: string) => (existsSync(p) && !own.has(real(p)) ? ["--ro-bind", "/dev/null", real(p)] : []);
  const rw = (p: string) => (existsSync(p) ? ["--bind", real(p), real(p)] : []);
  const privateDirs = PRIVATE_HOME_DIRS.filter((d) => !d.startsWith("Library/")).map((d) => join(home, d));
  // A builder with a shell may not reach the desktop keyring over D-Bus either.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const hides = [...privateDirs.flatMap(hide), ...PRIVATE_HOME_FILES.map((f) => join(home, f)).flatMap(hideFile), ...hide(o.platformRoot), ...(o.denyKeychain && runtime ? hide(runtime) : [])];
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    ...hides,
    // Mounted last, so they show through the hidden parents.
    ...o.ownState.flatMap(rw),
    ...rw(o.workspace),
    ...hidden.flatMap((p) => ["--remount-ro", p]),
    "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try",
    "--die-with-parent", "--new-session",
    "--chdir", real(o.workspace),
  ];
}

export function wrapBuilder(command: string, args: string[], o: BuilderSandboxOptions): { command: string; args: string[] } {
  if (platform() === "darwin") return { command: "/usr/bin/sandbox-exec", args: ["-p", builderProfile(o), command, ...args] };
  return { command: "bwrap", args: [...bubblewrapArgs(o), command, ...args] };
}

/** Whether builders can be confined on this machine (and how). */
export function builderSandboxAvailable(): { ok: boolean; how: string } {
  if (platform() === "darwin") return { ok: existsSync("/usr/bin/sandbox-exec"), how: "Seatbelt" };
  return { ok: ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].some(existsSync), how: "bubblewrap" };
}
