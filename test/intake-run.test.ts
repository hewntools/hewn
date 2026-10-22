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
