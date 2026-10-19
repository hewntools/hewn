// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { writeConfig } from "@hewntools/cli/config.ts";
import { formatChecks, runDoctor } from "@hewntools/cli/doctor.ts";
import { busFix, installed, logToFile, plist, replaceConflict, status, stop, systemdUnit, uninstall, useRunner } from "@hewntools/cli/service.ts";
import { setup } from "./helpers.ts";

describe("service and doctor", () => {
  test("launchd plist: keeps hewn serve alive, passes home/port/PATH, escapes XML", () => {
    const p = plist({ node: "/opt/node", script: "/repo/src/cli.ts", homeRoot: "/data & co", port: 7717, path: "/usr/bin:/opt/bin" });
    assert.match(p, /<key>KeepAlive<\/key><true\/>/);
    assert.match(p, /<string>\/repo\/src\/cli.ts<\/string>\s*<string>serve<\/string>/);
    assert.match(p, /<key>HEWN_HOME<\/key><string>\/data &amp; co<\/string>/);
    assert.match(p, /<key>HEWN_LOG_FILE<\/key><string>\/data &amp; co\/logs\/hewn.log<\/string>/);
    assert.match(p, /<key>PATH<\/key><string>\/usr\/bin:\/opt\/bin<\/string>/);
  });

  test("systemd user unit: restarts always, runs hewn serve with home/port/PATH", () => {
    const u = systemdUnit({ node: "/usr/bin/node", script: "/repo/src/cli.ts", homeRoot: "/home/me/hewn data", port: 7727, path: "/usr/bin" });
    assert.match(u, /^Restart=always$/m);
    assert.match(u, /^ExecStart="\/usr\/bin\/node" --disable-warning=ExperimentalWarning "\/repo\/src\/cli.ts" serve$/m);
    assert.match(u, /^Environment="HEWN_HOME=\/home\/me\/hewn data"$/m);
    assert.match(u, /^Environment="HEWN_PORT=7727"$/m);
    assert.match(u, /^WantedBy=default.target$/m);
    // The installed systemd unit is read back too (for the repoint guard).
    const dir = mkdtempSync(join(tmpdir(), "hewn-unit-"));
    try {
      writeFileSync(join(dir, "hewn.service"), u);
      assert.deepEqual(installed(join(dir, "hewn.service")), { homeRoot: "/home/me/hewn data", port: 7727 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("install won't silently repoint the service at another home or port", () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-svc-"));
    const spec = { node: "/opt/node", script: "/repo/src/cli.ts", homeRoot: "/data & co", port: 7717, path: "/usr/bin" };
    try {
      const path = join(dir, "svc.plist");
      assert.equal(installed(path), undefined, "nothing installed");
      writeFileSync(path, plist(spec));
      const current = installed(path);
      assert.deepEqual(current, { homeRoot: "/data & co", port: 7717 }, "reads home and port back, unescaped");
      assert.equal(replaceConflict(current, spec), undefined, "reinstalling the same instance is fine");
      assert.equal(replaceConflict(undefined, spec), undefined, "first install is fine");
      assert.match(replaceConflict(current, { ...spec, homeRoot: "/other" }) ?? "", /installed for \/data & co \(port 7717\); this would move it to \/other.*--force/s);
      assert.match(replaceConflict(current, { ...spec, port: 7737 }) ?? "", /port 7737/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unwritable log file falls back to stderr instead of going silent", () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-log-"));
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    const saved = { error: console.error, log: console.log, warn: console.warn };
    const seen: string[] = [];
    console.error = (...a: unknown[]) => seen.push(a.join(" "));
    try {
      logToFile(join(blocker, "logs", "hewn.log"));
      console.error("No agents configured.");
      console.error("second line");
    } finally {
      Object.assign(console, saved);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.match(seen[0], /not writable/, "says why, once");
    assert.deepEqual(seen.slice(1), ["No agents configured.", "second line"]);
  });

  test("log file rotates by size", () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-log-"));
    const saved = { error: console.error, log: console.log, warn: console.warn };
    try {
      logToFile(join(dir, "hewn.log"), 100, 2);
      for (let i = 0; i < 40; i++) console.error(`line ${i} ${"x".repeat(20)}`);
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(existsSync(join(dir, "hewn.log.1")) && existsSync(join(dir, "hewn.log.2")) && !existsSync(join(dir, "hewn.log.3")));
    assert.match(readFileSync(join(dir, "hewn.log"), "utf8"), /line 39/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("doctor: says what's wrong and what to do", async () => {
    const t = setup();
    try {
      // Its own (empty) backup folder: the default sits next to the home, shared by every test under $TMPDIR.
      writeConfig(t.home, { backupDir: mkdtempSync(join(tmpdir(), "hewn-doctor-backups-")) });
      const broken = await runDoctor({
        home: t.home,
        port: 1,
        userHome: t.home.root,
        harnesses: [{ agentId: "codex", label: "Codex", pointerRequired: true, pointerNote: "", detect: () => true, registered: () => false, steps: () => [], login: () => ["codex"], loginFix: () => "" }],
        which: (bin) => bin === "claude",
        health: async () => false,
        service: () => ({ installed: false, running: false }),
        hasWorkerd: () => true,
        bundle: async () => 'ERROR: Could not resolve "zod/v3"',
        sandbox: () => ({ ok: false, how: "bubblewrap", detail: "bubblewrap isn't installed" }),
        keySource: () => "file",
        browser: () => undefined,
        loggedIn: () => false,
        settings: async () => ({ builder: "claude", intake: "codex" }),
      });
      const by = Object.fromEntries(broken.map((c) => [c.name, c]));
      assert.equal(by.Hewn.state, "fail");
      assert.equal(by.Service.fix, "hewn service install");
      assert.equal(by.Sandbox.state, "fail");
      assert.match(by.Sandbox.fix!, /bubblewrap|sandbox-exec/);
      assert.equal(by["Secrets key"].state, "warn");
      // Split between two agents: one line each.
      assert.match(by.Builds.detail, /isn't logged in/);
      assert.equal(by["Talks it through"].state, "fail", "codex isn't on PATH here");
      assert.equal(by["Visual check"].state, "warn");
      assert.equal(by.Codex.state, "warn");
      assert.equal(by.Backups.fix, "hewn backup now");
      assert.match(by.Install.detail, /doesn't build: ERROR: Could not resolve "zod\/v3"/);
      assert.match(by.Install.fix!, /&& npm ci$/);
      assert.match(formatChecks(broken), /5 problems, 5 warnings\.$/);

      const healthy = await runDoctor({
        home: t.home,
        port: 1,
        userHome: t.home.root,
        harnesses: [],
        which: () => true,
        health: async () => true,
        control: async () => ({ restarts: 0, keySource: "keychain", sandbox: true }),
        service: () => ({ installed: true, running: true }),
        hasWorkerd: () => true,
        bundle: async () => undefined,
        sandbox: () => ({ ok: true, how: "Seatbelt" }),
        browser: () => "/x/chrome-headless-shell",
        loggedIn: () => true,
        settings: async () => ({ builder: "claude", intake: "claude", jobModels: { builder: { claude: { model: "fable", effort: "high" } } } }),
      });
      assert.deepEqual(healthy.filter((c) => c.state !== "ok").map((c) => c.name), ["Backups"], "only 'no backup yet' remains");
      // One agent does both: one line, with the model it builds on.
      const builds = healthy.find((c) => c.name === "Builds tools");
      assert.match(builds!.detail, /claude found, logged in · fable, high effort/);
      assert.ok(!healthy.some((c) => c.name === "Builds" || c.name === "Talks it through"));
    } finally {
      t.cleanup();
    }
  });
});

describe("service stop and uninstall report failures", () => {
  const unit = () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-unit-"));
    const path = join(dir, "hewn.service");
    writeFileSync(path, "[Unit]\n");
    return { dir, path };
  };
  const fake = (results: Record<string, { status: number; stdout?: string; stderr?: string }>) => {
    const calls: string[] = [];
    const restore = useRunner((cmd, ...args) => {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      const hit = Object.entries(results).find(([k]) => line.includes(k))?.[1] ?? { status: 0 };
      return { stdout: "", stderr: "", ...hit };
    });
    return { calls, restore };
  };

  test("systemd: a failed disable throws and keeps the unit file (no invisible stray Hewn)", () => {
    const u = unit();
    const bus = { status: 1, stderr: "Failed to connect to bus: No such file or directory" };
    const f = fake({ disable: bus, " stop ": bus });
    try {
      assert.throws(() => uninstall({ kind: "systemd", path: u.path }), /Failed to connect to bus/);
      assert.ok(existsSync(u.path), "the unit file stays");
      assert.throws(() => stop("systemd"), /systemctl --user stop failed/);
    } finally {
      f.restore();
      rmSync(u.dir, { recursive: true, force: true });
    }
  });

  test("systemd: a clean uninstall removes the unit file", () => {
    const u = unit();
    const f = fake({});
    try {
      uninstall({ kind: "systemd", path: u.path });
      assert.ok(!existsSync(u.path));
      assert.ok(f.calls.some((c) => c.includes("disable --now hewn.service")));
    } finally {
      f.restore();
      rmSync(u.dir, { recursive: true, force: true });
    }
  });

  test("launchd: a bootout that leaves it loaded throws; not loaded is 'not running', not an error", () => {
    const u = unit();
    const loaded = fake({ "launchctl print": { status: 0, stdout: "state = running\n" }, bootout: { status: 5, stderr: "Boot-out failed: 5: Input/output error" } });
    try {
      assert.throws(() => uninstall({ kind: "launchd", path: u.path }), /Input\/output error/);
      assert.ok(existsSync(u.path));
      assert.throws(() => stop("launchd"), /bootout failed/);
    } finally {
      loaded.restore();
    }
    const gone = fake({ "launchctl print": { status: 113, stderr: "Could not find service" } });
    try {
      assert.equal(stop("launchd"), false);
      uninstall({ kind: "launchd", path: u.path });
      assert.ok(!existsSync(u.path));
      assert.ok(!gone.calls.some((c) => c.includes("bootout")));
    } finally {
      gone.restore();
      rmSync(u.dir, { recursive: true, force: true });
    }
  });
});

test("a sudo -iu / su shell: the bus error says to enable lingering and set XDG_RUNTIME_DIR", () => {
  const none = busFix(false, { managerDir: false }, "mag");
  assert.match(none, /sudo loginctl enable-linger mag/);
  assert.match(none, /export XDG_RUNTIME_DIR=\/run\/user\/\$\(id -u\)/);
  assert.match(none, /sudo machinectl shell mag@/);
  const lingering = busFix(false, { managerDir: true }, "mag");
  assert.doesNotMatch(lingering, /enable-linger/);
  assert.match(lingering, /export XDG_RUNTIME_DIR=/);
  assert.match(busFix(false, { runtimeDir: "/run/user/1000", managerDir: true }), /log out and in again/);
});

test("WSL: a hidden user bus is explained, with the fix, in errors, status and doctor", async (t0) => {
  // A shell with a login session, whatever this machine's is.
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
  t0.after(() => (runtimeDir === undefined ? delete process.env.XDG_RUNTIME_DIR : (process.env.XDG_RUNTIME_DIR = runtimeDir)));
  const restore = useRunner(() => ({ status: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" }));
  try {
    assert.throws(() => stop("systemd"), /Failed to connect to bus[\s\S]*sudo systemctl restart user@/);
    assert.equal(status("systemd").busLost, true);
  } finally {
    restore();
  }
  assert.match(busFix(true, { runtimeDir: "/run/user/1000", managerDir: true }), /WSLg hid systemd's user bus.*sudo systemctl restart user@\$\(id -u\)\.service/);
  const t = setup();
  try {
    const checks = await runDoctor({ home: t.home, port: 1, userHome: t.home.root, harnesses: [], health: async () => false, service: () => ({ installed: false, running: false, busLost: true }), bundle: async () => undefined, hasWorkerd: () => true, sandbox: () => ({ ok: true, how: "x" }), keySource: () => "file", browser: () => "x", which: () => true, loggedIn: () => true });
    const svc = checks.find((c) => c.name === "Service")!;
    assert.equal(svc.state, "fail");
    assert.match(svc.fix!, /restart user@/);
  } finally {
    t.cleanup();
  }
});

test("doctor: an agent registered with another Hewn (another port) is a warning, with the fix", async () => {
  const t = setup();
  try {
    const agent = (url: string) => ({ agentId: "claude-code", label: "Claude Code", detect: () => true, registered: () => true, registeredUrl: () => url }) as any;
    const run = (url: string) =>
      runDoctor({ home: t.home, port: 7850, userHome: t.home.root, harnesses: [agent(url)], health: async () => false, service: () => ({ installed: false, running: false }), bundle: async () => undefined, hasWorkerd: () => true, sandbox: () => ({ ok: true, how: "x" }), keySource: () => "file", browser: () => "x", which: () => true, loggedIn: () => true });
    const other = (await run("http://127.0.0.1:7717/mcp")).find((c) => c.name === "Claude Code")!;
    assert.equal(other.state, "warn");
    assert.match(other.detail, /another Hewn \(this one is on port 7850\)/);
    assert.match(other.fix!, /hewn setup --agents claude-code/);
    assert.equal((await run("http://127.0.0.1:7850/mcp")).find((c) => c.name === "Claude Code")!.state, "ok");
    assert.equal((await run("not a url")).find((c) => c.name === "Claude Code")!.state, "ok", "an address it can't read isn't an error");
  } finally {
    t.cleanup();
  }
});

test("Codex's config: the address Hewn is registered at", async () => {
  const { harnesses } = await import("@hewntools/cli/setup/harnesses.ts");
  const home = mkdtempSync(join(tmpdir(), "hewn-codex-"));
  try {
    const codex = harnesses().find((h) => h.agentId === "codex")!;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.other]\nurl = "http://x/mcp"\n\n[mcp_servers.hewn]\nurl = "http://127.0.0.1:7717/mcp"\n\n[profile]\nmodel = "y"\n');
    assert.equal(codex.registeredUrl!(home), "http://127.0.0.1:7717/mcp");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
