// SPDX-License-Identifier: AGPL-3.0-or-later
// The intake's CLI run: a hung one is stopped, and the owner is told so in words.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { INTAKE_TIMEOUT_MS, run } from "@hewntools/cli/intake.ts";

test("intake: a run past its time is stopped and says how long it had", async () => {
  assert.equal(INTAKE_TIMEOUT_MS, 15 * 60_000);
  const hang = ["-e", "console.log('{\"type\":\"stream_event\"}'); setTimeout(() => {}, 60_000)"];
  await assert.rejects(run(process.execPath, hang, tmpdir(), process.env, 300), /intake took longer than \d+ minutes, so Hewn stopped it$/);
  await assert.rejects(run(process.execPath, ["-e", "process.exit(3)"], tmpdir(), process.env, 60_000), /exited 3/);
});

test("intake: the prompt goes in on stdin, so a big one fits (one argument is capped at 128 KiB on Linux); a CLI that stops early is its exit", async () => {
  const prompt = "   1| x\n".repeat(40_000);
  const echo = ["-e", "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => process.stdout.write(String(s.length)))"];
  assert.equal(await run(process.execPath, echo, tmpdir(), process.env, 60_000, undefined, undefined, prompt), String(prompt.length));
  await assert.rejects(run(process.execPath, ["-e", "process.exit(2)"], tmpdir(), process.env, 60_000, undefined, undefined, prompt.repeat(10)), /exited 2/);
});
