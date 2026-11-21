// SPDX-License-Identifier: AGPL-3.0-or-later
// A workerd is started as the leader of a process group of its own (spawn's `detached`), and signalled as that group:
// on Linux its sandbox is two bwrap processes, and a signal to the outer one alone left the inner one, and the
// workerd in it, running under init (one more for every SIGKILL restart, until a reboot). The group is everything the
// command started, in the sandbox's PID namespace too (bwrap keeps the group unless told to start a new session).
import { spawnSync, type ChildProcess } from "node:child_process";

/**
 * Signal the process group `pid` leads; when there's no such group, the process alone, unless `groupOnly` (after the
 * leader has exited, when its pid may already be another process's).
 */
export function signalGroup(pid: number, signal: NodeJS.Signals, groupOnly = false): void {
  try {
    process.kill(-pid, signal);
  } catch {
    if (groupOnly) return;
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Signal a child started with `detached: true` and everything it started. */
export function signalChild(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child.pid, signal);
}

/**
 * A workerd a previous run left (its supervisor died), by the pid it recorded: the whole process group, when anything
 * in it is a workerd (the leader, an outer bwrap, may be gone and its inner one not); or, from a version that didn't
 * start it in a group of its own, the process alone. `match`: what its command line has. Says whether it stopped one.
 */
export function stopLeftover(pid: number, match = "workerd"): boolean {
  if (!pid) return false;
  const rows = spawnSync("ps", ["-A", "-o", "pgid=,command="], { encoding: "utf8" }).stdout.split("\n");
  const inGroup = rows.map((r) => /^\s*(\d+)\s+(.*)$/.exec(r)).filter((m) => m && Number(m[1]) === pid);
  if (inGroup.some((m) => m![2].includes(match))) {
    signalGroup(pid, "SIGKILL");
    return true;
  }
  if (spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout.includes(match)) {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      // already gone
    }
  }
  return false;
}
