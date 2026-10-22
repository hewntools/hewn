// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { SEED, setup } from "./helpers.ts";

const seed = (ws: string) => cpSync(SEED, ws, { recursive: true });

describe("instructions: the owner's standing rules for building", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("set, read and clean up; owner only; a tool's need the tool", async () => {
    assert.deepEqual(t.platform.instructions(USER), []);
    assert.deepEqual(t.platform.setInstructions(USER, undefined, "- Swedish copy\n\n* Metric units\nSwedish copy\n"), ["Swedish copy", "Metric units"]);
    assert.deepEqual(t.platform.setInstructions(USER, undefined, ["Dates as 2026-10-22"]), ["Dates as 2026-10-22"]);
    assert.throws(() => t.platform.setInstructions(USER, undefined, 42), /one rule per line/);
    assert.throws(() => t.platform.setInstructions(USER, undefined, ["x".repeat(501)]), /at most 500/);
    assert.throws(() => t.platform.setInstructions(USER, undefined, Array.from({ length: 51 }, (_, i) => `rule ${i}`)), /at most 50 lines/);
    assert.throws(() => t.platform.instructions(t.claude), /owner actions/);
    assert.throws(() => t.platform.setInstructions(t.claude, undefined, ["x"]), /owner actions/);
    assert.throws(() => t.platform.instructions(USER, "running-log"), /no capability/);
    await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), seed);
    assert.deepEqual(t.platform.setInstructions(USER, "running-log", "One screen only"), ["One screen only"]);
    assert.deepEqual(t.platform.instructions(USER, "running-log"), ["One screen only"]);
    assert.deepEqual(t.platform.instructions(USER), ["Dates as 2026-10-22"], "scopes are apart");
  });

  test("what the intake remembers is added once, what it drops must match; creating keeps global rules only", async () => {
    await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), seed);
    const first = t.platform.applyIntakeMemory(USER, "running-log", [{ scope: "global", text: " - Swedish copy" }, { scope: "tool", text: "One screen" }, { scope: "tool", text: "" }, { scope: "x", text: "no" }], []);
    assert.deepEqual(first, { remember: [{ scope: "global", text: "Swedish copy" }, { scope: "tool", text: "One screen" }], forget: [] });
    // Again: nothing new, nothing saved twice.
    assert.deepEqual(t.platform.applyIntakeMemory(USER, "running-log", [{ scope: "global", text: "Swedish copy" }], []), { remember: [], forget: [] });
    assert.deepEqual(t.platform.instructions(USER), ["Swedish copy"]);
    // Creating (no capability id): the tool's rule has nowhere to go.
    assert.deepEqual(t.platform.applyIntakeMemory(USER, undefined, [{ scope: "tool", text: "Dark only" }, { scope: "global", text: "Metric units" }], []), { remember: [{ scope: "global", text: "Metric units" }], forget: [] });
    // Dropping: only a line that exists.
    assert.deepEqual(t.platform.applyIntakeMemory(USER, "running-log", [], [{ scope: "global", text: "Swedish copy" }, { scope: "global", text: "never there" }]), { remember: [], forget: [{ scope: "global", text: "Swedish copy" }] });
    assert.deepEqual(t.platform.instructions(USER), ["Metric units"]);
    assert.deepEqual(t.platform.instructions(USER, "running-log"), ["One screen"]);
    assert.throws(() => t.platform.applyIntakeMemory(t.claude, undefined, [], []), /owner actions/);
    // An archived tool takes no rules; purging it drops the ones it had, so a new tool under the id starts clean.
    t.platform.archive(USER, "running-log");
    assert.throws(() => t.platform.applyIntakeMemory(USER, "running-log", [{ scope: "tool", text: "Dark only" }], []), /no capability/);
    await t.platform.purge(USER, "running-log", "running-log");
    await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), seed);
    assert.deepEqual(t.platform.instructions(USER, "running-log"), []);
    assert.deepEqual(t.platform.instructions(USER), ["Metric units"], "the rules for every tool stay");
  });

  test("a build runs with the instructions as they are when it opens: in BUILDER.md, recorded with the build", async () => {
    t.platform.setInstructions(USER, undefined, ["Swedish copy in every screen"]);
    let brief = "";
    const b = await t.build(
      () => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }),
      (ws) => {
        brief = readFileSync(join(ws, "BUILDER.md"), "utf8");
        seed(ws);
      },
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.match(brief, /Requirements: r\n\n## Owner's instructions\n\n[^]*For every tool:\n- Swedish copy in every screen\n\n## Implementation contract/);
    assert.doesNotMatch(brief, /For this tool/);
    assert.match(t.platform.buildContext(USER, b.buildId).instructions!, /Swedish copy/);

    t.platform.setInstructions(USER, "running-log", ["One screen only"]);
    const m = await t.build(
      () => t.platform.modify(USER, { capabilityId: "running-log", request: "add notes" }),
      (ws) => {
        brief = readFileSync(join(ws, "BUILDER.md"), "utf8");
      },
    );
    assert.match(brief, /For every tool:\n- Swedish copy in every screen\n\nFor this tool:\n- One screen only\n/);
    assert.match(t.platform.buildContext(USER, m.buildId).instructions!, /One screen only/);
    // None: no section at all.
    t.platform.setInstructions(USER, undefined, []);
    t.platform.setInstructions(USER, "running-log", []);
    await t.build(
      () => t.platform.modify(USER, { capabilityId: "running-log", request: "add more" }),
      (ws) => {
        brief = readFileSync(join(ws, "BUILDER.md"), "utf8");
      },
    );
    assert.doesNotMatch(brief, /Owner's instructions/);
  });
});
