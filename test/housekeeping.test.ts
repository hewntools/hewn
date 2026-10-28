// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { installSeed, setup } from "./helpers.ts";

const DAY = 86400_000;

describe("housekeeping", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("abandoned builds: workspaces go after a day, transcripts after 30, unused ids after 7", async () => {
    await installSeed(t.platform);
    // A create that never succeeds: its id stays reserved (for a retry, or the next create of that name), its workspace stays for a look.
    const failed = await t.build(
      () => t.platform.create(t.claude, { name: "Half Baked", purpose: "x", requirements: "x" }),
      () => {
        throw new Error("model overloaded");
      },
    );
    assert.equal(failed.status, "failed");
    const ws = join(t.home.builds, failed.buildId);
    assert.ok(existsSync(ws));

    assert.deepEqual(await t.platform.cleanup(Date.now()), { workspaces: 0, transcripts: 0, releasedIds: [], logs: 0 }, "nothing is old yet");
    const later = await t.platform.cleanup(Date.now() + 2 * DAY);
    assert.ok(!existsSync(ws), "workspace removed after a day");
    assert.deepEqual(later.releasedIds, [], "the id is kept for a week");

    const week = await t.platform.cleanup(Date.now() + 8 * DAY);
    assert.deepEqual(week.releasedIds, ["half-baked"]);
    assert.ok(t.platform.list(t.claude).some((c) => c.id === "running-log"), "promoted capabilities are untouched");
    t.queue(() => new Promise(() => {}));
    const again = await t.platform.create(t.claude, { name: "Half Baked", purpose: "x", requirements: "x" });
    assert.equal(again.capabilityId, "half-baked", "the id is free again");
  });
});
