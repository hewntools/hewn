// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { backupLocation, listBackups } from "./backup.ts";
import { CLI_AGENTS, isCliAgent } from "./builders/cli-agents.ts";
import { builderSandboxAvailable } from "./builders/sandbox.ts";
import { readConfig } from "./config.ts";
import type { Home } from "./home.ts";
import { busFix } from "./service.ts";
import type { Harness } from "./setup/harnesses.ts";
import { defaultKeySource, type KeySource } from "./supervisor/master-key.ts";
import { findBrowser } from "./visual.ts";
import { loggedIn as toolLoggedIn } from "./setup/tools.ts";
import { APP_DIR, BUNDLED, workerdBinary } from "./app-dir.ts";

const hasWorkerd = () => {
  try {
    return existsSync(workerdBinary());
  } catch {
    return false;
  }
};

/**
 * `hewn doctor`: is everything Hewn depends on in place? Each check says what's wrong and the one
 * thing to do about it. Checks never change anything. Every probe is injectable (tests).
 */

export interface Check {
  name: string;
  state: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  home: Home;
  port: number;
  userHome: string;
  harnesses: Harness[];
  /** Connection requests waiting for the owner, and the tunnel (from the running Hewn). */
  pendingAgents?: () => Promise<number>;
  /** Secrets this home's key can't read (a backup restored from another machine). */
  unreadableSecrets?: () => Promise<{ capabilityId: string; name: string }[]>;
  tunnel?: () => Promise<{ kind: string | null; state: string; url: string | null; error?: string } | undefined>;
  /** Whether a command is on PATH. */
  which?: (bin: string) => boolean;
  /** Hewn answering on its port. */
  health?: () => Promise<boolean>;
  /** The running supervisor's status (hewn serve), if any. */
  control?: () => Promise<{ restarts: number; keySource: KeySource; sandbox: boolean } | undefined>;
  /** The owner's builder and intake settings (from the running Hewn, else platform.json). */
  settings?: () => Promise<{ builder: string; jobModels?: { builder?: Record<string, { model?: string; effort?: string }> } }>;
  service?: () => { installed: boolean; running: boolean; busLost?: boolean };
  hasWorkerd?: () => boolean;
  /** Can this install build the workerd host? The first error, or undefined. */
  bundle?: () => Promise<string | undefined>;
  /** Can processes be confined here (and does it actually work)? */
  sandbox?: () => { ok: boolean; how: string; detail?: string };
  keySource?: () => KeySource;
  browser?: () => string | undefined;
  /** Whether a builder CLI is logged in (undefined: can't tell). */
  loggedIn?: (builder: string) => boolean | undefined;
  now?: Date;
}

const onPath = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

/** Exercise the OS sandbox for real (bubblewrap can be installed but blocked by user-namespace policy). */
function sandboxWorks(): { ok: boolean; how: string; detail?: string } {
  const s = builderSandboxAvailable();
  if (!s.ok) return { ...s, detail: `${s.how} isn't installed` };
  const r =
    platform() === "darwin"
      ? spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8" })
      : spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user-try", "--unshare-pid", "true"], { encoding: "utf8" });
  return r.status === 0 ? s : { ok: false, how: s.how, detail: String(r.stderr ?? "").trim().split("\n")[0] || `${s.how} can't run here` };
}


export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  const which = d.which ?? onPath;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // Hewn itself
  const up = await (d.health ?? (() => fetch(`http://127.0.0.1:${d.port}/health`).then((r) => r.ok, () => false)))();
  const status = up ? await (d.control ?? (async () => undefined))().catch(() => undefined) : undefined;
  add(
    up
      ? { name: "Hewn", state: "ok", detail: `running on port ${d.port}${status?.restarts ? ` · workerd restarted ${status.restarts}× (watchdog/crash)` : ""}` }
      : { name: "Hewn", state: "fail", detail: "not running", fix: "hewn service install (or hewn serve in a terminal)" },
  );
  if (d.service) {
    const s = d.service();
    add(
      s.busLost
        ? { name: "Service", state: "fail", detail: "systemctl --user can't reach your user's systemd (Failed to connect to bus)", fix: busFix() }
        : s.installed
        ? { name: "Service", state: s.running ? "ok" : "warn", detail: s.running ? "starts at login, restarts on crash" : "installed but not running", ...(s.running ? {} : { fix: "hewn service start" }) }
        : { name: "Service", state: "warn", detail: "Hewn only runs while a terminal keeps it open", fix: "hewn service install" },
    );
  }
  const bundle = await (d.bundle ?? (async () => (await import("./upgrade.ts")).bundleProblem()))();
  const version = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version;
  const reinstall = BUNDLED ? `npm install -g @hewntools/cli@${version}` : `cd ${APP_DIR} && npm ci`;
  add(
    bundle
      ? { name: "Install", state: "fail", detail: `Hewn ${version}: its own code doesn't build: ${bundle}`, fix: `reinstall: ${reinstall}` }
      : { name: "Install", state: "ok", detail: `Hewn ${version}${BUNDLED ? "" : " (from a checkout)"}` },
  );
  add((d.hasWorkerd ?? hasWorkerd)() ? { name: "workerd", state: "ok", detail: "installed" } : { name: "workerd", state: "fail", detail: "the workerd runtime is missing", fix: reinstall });

  // Isolation
  const sb = (d.sandbox ?? sandboxWorks)();
  if (status && !status.sandbox) add({ name: "Sandbox", state: "warn", detail: "Hewn runs workerd without the OS sandbox (--no-sandbox)", fix: "restart without --no-sandbox" });
  else
    add(
      sb.ok
        ? { name: "Sandbox", state: "ok", detail: `${sb.how}: workerd and builders are confined` }
        : { name: "Sandbox", state: "fail", detail: sb.detail ?? `${sb.how} isn't available`, fix: sb.how === "Seatbelt" ? "sandbox-exec is part of macOS; check this Mac's security settings" : "install bubblewrap (sudo apt install bubblewrap); on Ubuntu 24.04, also allow it in AppArmor (docs/troubleshooting.md → Sandbox)" },
    );

  // Secrets key
  const key = status?.keySource ?? (d.keySource ?? (() => defaultKeySource(d.home.root)))();
  add(
    key === "file"
      ? { name: "Secrets key", state: "warn", detail: "kept in a file (master.key) in the Hewn home: anyone who can read the home as you can decrypt secrets", fix: "keep the Hewn home private to you (chmod 700). On a Linux desktop with a keyring (GNOME Keyring, KWallet), a new Hewn home keeps its key there if libsecret-tools is installed before its first start; not on WSL or a server" }
      : { name: "Secrets key", state: "ok", detail: key === "keychain" ? "in the macOS Keychain" : "in the desktop keyring (libsecret)" },
  );
  const lost = up ? await d.unreadableSecrets?.().catch(() => []) : [];
  if (lost?.length) {
    add({ name: "Secrets", state: "warn", detail: `${lost.length} can't be read with this home's key (restored from another machine or home?): ${lost.map((s) => `${s.capabilityId} ${s.name}`).join(", ")}`, fix: "set them again (open each tool), or start Hewn with the old key: see docs/data.md" });
  }

  // Who builds tools: the builder's agent talks each request through and builds it.
  const cfg = await (d.settings ?? (async () => readConfig(d.home)))();
  const loggedIn = d.loggedIn ?? toolLoggedIn;
  const agent = cfg.builder;
  const m = cfg.jobModels?.builder?.[agent];
  const model = m?.model || m?.effort ? ` · ${[m.model, m.effort && `${m.effort} effort`].filter(Boolean).join(", ")}` : "";
  const name = "Builds tools";
  const builds = (): Check => {
    if (agent === "remote") return { name, state: "ok", detail: `the host's builder (HEWN_BUILD_URL)${model}` };
    // One of the CLIs: its binary and its own install and sign-in words (the descriptor's); another name is checked as is.
    const cli = isCliAgent(agent) ? CLI_AGENTS[agent] : undefined;
    const label = cli?.label ?? agent;
    if (!which(cli?.bin ?? agent)) return { name, state: "fail", detail: `${label} isn't on PATH`, fix: `${cli ? cli.install : `install ${agent}`}, or pick another in Settings › AI` };
    const li = loggedIn(agent);
    if (li === false) return { name, state: "fail", detail: `${label} isn't logged in`, fix: cli ? cli.login : `run ${agent} once and log in` };
    return { name, state: "ok", detail: `${label} found${li ? ", logged in" : ""}${model}` };
  };
  add(builds());

  // Visual check
  const browser = (d.browser ?? findBrowser)();
  add(browser ? { name: "Visual check", state: "ok", detail: browser.split("/").pop()! } : { name: "Visual check", state: "warn", detail: "no Chromium-based browser: built UIs aren't rendered before promotion", fix: "npx playwright install chromium-headless-shell" });

  // Agents (local harnesses)
  for (const h of d.harnesses) {
    if (!h.detect()) add({ name: h.label, state: "ok", detail: "not installed on this machine (skipped)" });
    else if (!h.registered(d.userHome)) add({ name: h.label, state: "warn", detail: "installed, but Hewn isn't connected", fix: "Agents → Connect an agent (web client), or hewn setup" });
    else {
      // Registered with *a* Hewn; check it's this one (another home, another port).
      const at = h.registeredUrl?.(d.userHome);
      const url = at && URL.canParse(at) ? new URL(at) : undefined;
      if (at && url && Number(url.port || 80) !== d.port && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname))
        add({ name: h.label, state: "warn", detail: `Hewn is registered at ${at}, another Hewn (this one is on port ${d.port})`, fix: `hewn setup --agents ${h.agentId}, to point it at this one` });
      else add({ name: h.label, state: "ok", detail: `Hewn registered (if it asks to sign in: hewn setup --agents ${h.agentId})` });
    }
  }
  const waiting = up ? await d.pendingAgents?.().catch(() => 0) : 0;
  if (waiting) add({ name: "Approvals", state: "warn", detail: `${waiting} agent${waiting > 1 ? "s" : ""} waiting to connect`, fix: "Agents in the web client, or hewn agents pending" });
  const tunnel = up ? await d.tunnel?.().catch(() => undefined) : undefined;
  if (tunnel?.kind) {
    add(
      tunnel.state === "up"
        ? { name: "Tunnel", state: "ok", detail: `${tunnel.kind}: ${tunnel.url}/mcp (only MCP and sign-in are reachable)` }
        : { name: "Tunnel", state: "fail", detail: `${tunnel.kind}: ${tunnel.state}${tunnel.error ? ` (${tunnel.error})` : ""}`, fix: "hewn tunnel status; hewn tunnel start again" },
    );
  }

  // Backups
  const { dir } = backupLocation(d.home, readConfig(d.home).backupDir);
  const last = listBackups(dir)[0];
  const ageDays = last ? ((d.now ?? new Date()).getTime() - new Date(last.at).getTime()) / 86400000 : Infinity;
  if (!last) add({ name: "Backups", state: "warn", detail: `none yet (${dir})`, fix: "hewn backup now" });
  else add(ageDays < 2 ? { name: "Backups", state: "ok", detail: `last ${last.date} · ${dir}` } : { name: "Backups", state: "warn", detail: `last one is from ${last.date} (${dir})`, fix: "keep Hewn running (hewn service install), or hewn backup now" });
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const icon = { ok: "✔", warn: "!", fail: "✖" };
  const lines = checks.map((c) => `${icon[c.state]} ${c.name.padEnd(13)} ${c.detail}${c.fix ? `\n  ${" ".repeat(13)} → ${c.fix}` : ""}`);
  const bad = checks.filter((c) => c.state === "fail").length;
  const warn = checks.filter((c) => c.state === "warn").length;
  return `${lines.join("\n")}\n\n${bad ? `${bad} problem${bad > 1 ? "s" : ""}` : "No problems"}${warn ? `, ${warn} warning${warn > 1 ? "s" : ""}` : ""}.`;
}
