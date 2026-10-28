// SPDX-License-Identifier: AGPL-3.0-or-later
// Operations on the real workerd host: restarts mid-build, backup/restore, a killed supervisor, data format.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { writeConfig } from "@hewntools/cli/config.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { checkFormat, DATA_FORMAT, writeFormat } from "@hewntools/cli/supervisor/format.ts";
import { SEED } from "./helpers.ts";
import { freePort, parse, startTestHost, type TestHost } from "./workerd-helpers.ts";

const health = (url: string) => fetch(`${url}/health`).then((r) => r.ok, () => false);
const until = async (fn: () => Promise<boolean> | boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe("operations on the workerd host", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost();
    const seed = await h.sv.admin("install", { name: "Running Log", purpose: "runs", dir: SEED, wait: true });
    assert.equal(seed.status, "promoted");
  });
  after(() => h?.stop());

  test("workerd restarted mid-build: the build is failed as interrupted and retried once, and finishes", async () => {
    const claude = await h.agent("claude-code", ["discover", "invoke", "create", "modify"]);
    let entered!: () => void;
    const inBuilder = new Promise<void>((r) => (entered = r));
    h.queue(async () => {
      entered();
      await new Promise(() => {}); // stuck until workerd goes away
    });
    h.queue((ws) => writeFileSync(join(ws, "migrations", "002_x.sql"), "ALTER TABLE runs ADD COLUMN x TEXT;"));
    const opened = parse(await claude.callTool({ name: "capabilities_modify", arguments: { capabilityId: "running-log", request: "add x" } }));
    await inBuilder;
    await h.sv.restart();
    let builds: any[] = [];
    await until(async () => {
      builds = (await h.sv.admin("status")).builds;
      return builds.some((b) => (b.request as any).autoRetryOf === opened.buildId && b.status === "promoted");
    }, 30_000);
    assert.match(builds.find((b) => b.buildId === opened.buildId).log.join("\n"), /interrupted/);
  });

  test("backup → change → restore through the supervisor: data comes back", async () => {
    const backups = mkdtempSync(join(tmpdir(), "hewn-bk-"));
    writeConfig(openHome(h.root), { backupDir: backups });
    const ctl = async (path: string, body: unknown = {}) => {
      const res = await fetch(`${h.sv.control.url}${path}`, { method: "POST", headers: { "x-hewn-control": h.sv.control.token, "content-type": "application/json" }, body: JSON.stringify(body) });
      return res.json() as Promise<any>;
    };
    const before = (await h.invoke("running-log", "list_runs")).result.runs.length;
    const b = await ctl("/control/backup");
    assert.ok(existsSync(b.file));
    await h.invoke("running-log", "record_run", { distanceKm: 99, durationSeconds: 9999 });
    assert.equal((await h.invoke("running-log", "list_runs")).result.runs.length, before + 1);
    const r = await ctl("/control/restore", { file: b.file });
    assert.ok(existsSync(r.aside), "what it replaced is kept");
    assert.equal((await h.invoke("running-log", "list_runs")).result.runs.length, before, "back to the backup");
    assert.equal((await fetch(`${h.sv.control.url}/control/status`, { method: "POST", headers: { "x-hewn-control": "nope".repeat(12) } })).status, 401);
    rmSync(backups, { recursive: true, force: true });
  });
});

describe("hewn serve killed hard", () => {
  test("a new hewn serve clears the workerd the dead one left behind and starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-kill-"));
    const port = await freePort();
    // A public port of its own, checked free: the default (port + 1) can be another process's on a busy machine.
    const env = { ...process.env, HEWN_HOME: root, HEWN_PORT: String(port), HEWN_PUBLIC_PORT: String(await freePort()), HEWN_KEY_SOURCE: "file" };
    const cli = join(import.meta.dirname, "..", "packages", "cli", "src", "cli.ts");
    const output: string[] = [];
    const serve = () => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "serve", "--no-sandbox"], { env, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr!.on("data", (b) => output.push(String(b)));
      return child;
    };
    const gone = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
    const exited = (child: ChildProcess) => (gone(child) ? Promise.resolve() : new Promise((r) => child.once("exit", r)));
    // Started once supervisor.json names it: hewn serve writes it last, whole. Killed before that, it would
    // die mid-start, which isn't what this is about. A loaded machine gets a minute.
    const started = (child: ChildProcess) =>
      until(() => {
        if (gone(child)) throw new Error(`hewn serve exited (${child.exitCode ?? child.signalCode})`);
        try {
          return JSON.parse(readFileSync(join(root, "supervisor.json"), "utf8")).pid === child.pid;
        } catch {
          return false; // not written yet
        }
      }, 60_000).catch((e) => {
        throw new Error(`${(e as Error).message}; its log:\n${output.join("")}`);
      });
    // The test home uses a file key, not the Keychain.
    mkdirSync(root, { recursive: true });
    const first = serve();
    let second: ChildProcess | undefined;
    try {
      await started(first);
      first.kill("SIGKILL");
      await exited(first);
      second = serve();
      await started(second);
      assert.ok(await health(`http://127.0.0.1:${port}`));
    } finally {
      for (const c of [first, second]) {
        if (!c || gone(c)) continue;
        c.kill("SIGTERM");
        await exited(c);
      }
      // The dead one's workerd, if no second hewn serve got to clear it: it would run on, orphaned.
      try {
        const left = Number(readFileSync(join(root, "workerd", "workerd.pid"), "utf8"));
        if (spawnSync("ps", ["-p", String(left), "-o", "command="], { encoding: "utf8" }).stdout.includes(root)) process.kill(left, "SIGKILL");
      } catch {
        // none, or gone already
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("data format", () => {
  test("an older format upgrades (after a backup); a newer one is refused", () => {
    const home = openHome(mkdtempSync(join(tmpdir(), "hewn-fmt-")));
    assert.deepEqual(checkFormat(home), { current: DATA_FORMAT, hasData: false }, "a fresh home");
    writeFormat(home, DATA_FORMAT);
    assert.equal(checkFormat(home, DATA_FORMAT + 1).upgradeFrom, DATA_FORMAT, "the next release sees an upgrade");
    writeFormat(home, DATA_FORMAT + 1);
    assert.match(checkFormat(home).refuse!, /written by a newer Hewn/);
    rmSync(home.root, { recursive: true, force: true });
    void cpSync;
  });
});
