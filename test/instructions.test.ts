// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync } from "node:fs";
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

  test("a build runs with the instructions as they are when it opens: in owner-instructions/, BUILDER.md and AGENTS.md pointing there, recorded with the build", async () => {
    t.platform.setInstructions(USER, undefined, ["Swedish copy in every screen"]);
    const read = (ws: string, f: string) => (existsSync(join(ws, f)) ? readFileSync(join(ws, f), "utf8") : undefined);
    let seen: Record<string, string | undefined> = {};
    const look = (ws: string) => void (seen = Object.fromEntries(["BUILDER.md", "AGENTS.md", "owner-instructions/every-tool.md", "owner-instructions/this-tool.md"].map((f) => [f, read(ws, f)])));
    const b = await t.build(
      () => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }),
      (ws) => {
        look(ws);
        seed(ws);
      },
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.equal(seen["owner-instructions/every-tool.md"], "# The owner's instructions for every tool\n\nThe owner's standing rules for how their tools are built. Follow them wherever they apply; the contract in the brief still holds.\n\n- Swedish copy in every screen\n");
    assert.equal(seen["owner-instructions/this-tool.md"], undefined, "a new tool has none of its own");
    assert.match(seen["BUILDER.md"]!, /Requirements: r\n\n## Owner's instructions\n\nThe owner's standing rules for how their tools are built are in `owner-instructions\/every-tool\.md`: read it before you write anything[^]*\n\nNow read `BRIEF\.md`/);
    assert.doesNotMatch(seen["BUILDER.md"]!, /Swedish copy/, "the rules are in their file, not BUILDER.md");
    assert.match(seen["AGENTS.md"]!, /`owner-instructions\/every-tool\.md`/);
    assert.deepEqual(t.platform.buildContext(USER, b.buildId).ownerInstructions, { everyTool: ["Swedish copy in every screen"], thisTool: [] });
    assert.ok(!(await t.platform.versionCode(USER, "running-log", 1)).files.some((f) => f.path.startsWith("owner-instructions/")), "never part of a version");

    t.platform.setInstructions(USER, "running-log", ["One screen only"]);
    const m = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add notes" }), look);
    assert.match(seen["owner-instructions/this-tool.md"]!, /^# The owner's instructions for this tool\n[^]*\n- One screen only\n$/);
    // A client's pack for the same change carries the same files.
    const pack = await t.platform.pack(t.claude, { kind: "modify", capabilityId: "running-log" });
    for (const f of ["owner-instructions/every-tool.md", "owner-instructions/this-tool.md"]) assert.equal(pack.files.find((x) => x.path === f)?.content, seen[f], f);
    // A build no builder runs (a submission) reads nothing: it records none.
    const submitted = await t.platform.submitFiles(t.claude, { files: pack.files.filter((f) => !f.path.startsWith("owner-instructions/")).map((f) => ({ path: f.path, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) })), capabilityId: "running-log", request: "the same", baseVersion: 2 });
    assert.equal(t.platform.buildContext(USER, submitted.buildId).ownerInstructions, undefined);
    await t.platform.settle(submitted.buildId);
    assert.match(seen["owner-instructions/every-tool.md"]!, /- Swedish copy in every screen/);
    assert.match(seen["BUILDER.md"]!, /in `owner-instructions\/every-tool\.md` and `owner-instructions\/this-tool\.md`: read them/);
    assert.deepEqual(t.platform.buildContext(USER, m.buildId).ownerInstructions, { everyTool: ["Swedish copy in every screen"], thisTool: ["One screen only"] });
    // None: no files, no section.
    t.platform.setInstructions(USER, undefined, []);
    t.platform.setInstructions(USER, "running-log", []);
    await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add more" }), look);
    assert.doesNotMatch(seen["BUILDER.md"]!, /Owner's instructions/);
    assert.doesNotMatch(seen["AGENTS.md"]!, /owner-instructions/);
    assert.equal(seen["owner-instructions/every-tool.md"], undefined);
  });
});
