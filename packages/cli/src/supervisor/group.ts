// SPDX-License-Identifier: AGPL-3.0-or-later
// A workerd is started as the leader of a process group of its own (spawn's `detached`), and signalled as that group:
// on Linux its sandbox is two bwrap processes, and a signal to the outer one alone left the inner one, and the
// workerd in it, running under init (one more for every SIGKILL restart, until a reboot). The group is everything the
// command started, in the sandbox's PID namespace too (bwrap keeps the group unless told to start a new session).
import type { ChildProcess } from "node:child_process";

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
