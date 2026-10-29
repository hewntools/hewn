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
    // Its name isn't held from a new create: that one takes the id over (and fails too, here).
    const retaken = await t.build(
      () => t.platform.create(t.claude, { name: "Half Baked", purpose: "x", requirements: "x" }),
      () => {
        throw new Error("model overloaded");
      },
    );
    assert.equal(retaken.capabilityId, "half-baked");
    assert.notEqual(retaken.buildId, failed.buildId);

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

  test("a new create of a name being released isn't released with it", async () => {
    const ask = { name: "Half Baked", purpose: "x", requirements: "x" };
    const failed = await t.build(
      () => t.platform.create(t.claude, ask),
      () => {
        throw new Error("model overloaded");
      },
    );
    assert.equal(failed.status, "failed");
    // Cleanup is slow to remove the old build's files: the new create comes in meanwhile.
    const wb = t.platform.workbench;
    const removeTranscript = wb.removeTranscript.bind(wb);
    let reached!: () => void;
    let release!: () => void;
    const removing = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    wb.removeTranscript = async (id) => (reached(), await gate, removeTranscript(id));
    const cleanup = t.platform.cleanup(Date.now() + 8 * DAY);
    await removing;
    t.queue(() => {
      throw new Error("model overloaded");
    });
    const again = await t.platform.create(t.claude, ask);
    release();
    assert.deepEqual((await cleanup).releasedIds, ["half-baked"]);
    assert.equal((await t.platform.settle(again.buildId)).status, "failed", "still there, with how it went");
    assert.equal(t.platform.registry.getCapability("half-baked")?.name, "Half Baked");
  });
});
