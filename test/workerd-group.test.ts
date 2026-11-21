// SPDX-License-Identifier: AGPL-3.0-or-later
// A workerd's process is signalled as its process group (supervisor/group.ts), so what it started goes with it: on
// Linux the tools' sandbox is two bwrap processes, and a SIGKILL to the outer one left the inner one and its workerd
// running under init, one more for every restart of the tools.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signalChild, stopLeftover } from "@hewntools/cli/supervisor/group.ts";
import { sandboxed } from "@hewntools/cli/supervisor/index.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r())));
async function gone(find: () => number[], ms = 3000) {
  const until = Date.now() + ms;
  while (find().length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return find();
}
/** Processes whose command line is `sleep <marker>` (seen from here, whatever PID namespace they're in). */
const sleepers = (marker: string) => {
  if (platform() === "linux") {
    return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).filter((d) => {
      try { return readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" ").trim() === `sleep ${marker}`; } catch { return false; }
    }).map(Number);
  }
  return spawnSync("pgrep", ["-f", `^sleep ${marker}$`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
};
const marker = () => `${300 + Math.floor(Math.random() * 1000)}.${process.pid}`;

test("a signal to the process alone leaves what it started; to its group, nothing", async () => {
  const m1 = marker();
  // A process that starts another and waits, as bwrap does: started detached, like the supervisor's workerds.
  const lone = spawn("sh", ["-c", `sleep ${m1} & wait`], { detached: true, stdio: "ignore" });
  await gone(() => (sleepers(m1).length ? [] : [0]));
  const [left] = sleepers(m1);
  assert.ok(left, "the inner process started");
  lone.kill("SIGKILL");
  await exited(lone);
  assert.ok(alive(left), "the old way: the inner process outlives its parent");
  process.kill(left, "SIGKILL");

  const m2 = marker();
  const group = spawn("sh", ["-c", `sleep ${m2} & wait`], { detached: true, stdio: "ignore" });
  await gone(() => (sleepers(m2).length ? [] : [0]));
  assert.equal(sleepers(m2).length, 1);
  signalChild(group, "SIGKILL");
  await exited(group);
  assert.deepEqual(await gone(() => sleepers(m2)), []);
});

const bwrap = platform() === "linux" && ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].some(existsSync);
test("Linux: a SIGKILL to the tools' bwrap sandbox as a group leaves no process inside it", { skip: !bwrap && "bubblewrap on Linux" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hewn-group-"));
  const command = (m: string) => sandboxed(["sh", "-c", `sleep ${m} & wait`], { readable: [], writable: [dir], profile: join(dir, "p.sb") });
  // The bug: the outer bwrap killed alone, the inner one keeps the command running (under init).
  const m1 = marker();
  const [c1, ...a1] = command(m1);
  const lone = spawn(c1, a1, { detached: true, stdio: "ignore" });
  await gone(() => (sleepers(m1).length ? [] : [0]), 5000);
  assert.equal(sleepers(m1).length, 1, "the command runs in the sandbox");
  lone.kill("SIGKILL");
  await exited(lone);
  await new Promise((r) => setTimeout(r, 500));
  const leftOver = sleepers(m1);
  for (const pid of leftOver) process.kill(pid, "SIGKILL");
  // The fix: the group.
  const m2 = marker();
  const [c2, ...a2] = command(m2);
  const group = spawn(c2, a2, { detached: true, stdio: "ignore" });
  await gone(() => (sleepers(m2).length ? [] : [0]), 5000);
  assert.equal(sleepers(m2).length, 1, "the command runs in the sandbox");
  signalChild(group, "SIGKILL");
  await exited(group);
  assert.deepEqual(await gone(() => sleepers(m2)), []);
  // Recorded, not required: whether this bwrap leaves the inner process behind on its own (it did on the machine
  // the fix came from; --die-with-parent covers some kernels and bwrap versions, not all).
  t.diagnostic(`outer bwrap killed alone left ${leftOver.length} process(es) behind`);
});

test("a previous run's leftover: its group goes even when its leader is already gone (an outer bwrap killed alone)", async () => {
  const m = marker();
  const leader = spawn("sh", ["-c", `sleep ${m} & wait`], { detached: true, stdio: "ignore" });
  await gone(() => (sleepers(m).length ? [] : [0]));
  const [inner] = sleepers(m);
  // The leader goes, the process it started stays: the group (its pid recorded in the pid file) still has it.
  leader.kill("SIGKILL");
  await exited(leader);
  assert.ok(alive(inner));
  assert.equal(stopLeftover(leader.pid!, `sleep ${m}`), true);
  assert.deepEqual(await gone(() => sleepers(m)), []);
  // Nothing of it left: nothing to stop. A pid that isn't one (nothing matches): left alone.
  assert.equal(stopLeftover(leader.pid!, `sleep ${m}`), false);
  assert.equal(stopLeftover(process.pid, "no-such-command-line"), false);
  assert.ok(alive(process.pid));
});
