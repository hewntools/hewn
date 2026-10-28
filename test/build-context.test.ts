// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { ownersWords } from "@hewntools/core/platform/builds.ts";
import { SEED, setup } from "./helpers.ts";

const seed = (ws: string) => cpSync(SEED, ws, { recursive: true });
const turns = [
  { role: "user" as const, content: "track my runs" },
  { role: "intake" as const, content: "DRAFT\nRunning Log: runs, with pace" },
];

describe("what a build keeps", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("the conversation, the brief and the transcript stay with the build; the request stays clean", async () => {
    const b = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "record runs", conversation: turns }), seed);
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.ok(!("conversation" in b.request), "the conversation isn't part of the request");

    const ctx = t.platform.buildContext(USER, b.buildId);
    assert.deepEqual(ctx.conversation, turns);
    // An intake turn keeps its structured reply (the card as it was); an oversized one is dropped, a user's ignored.
    const withReply = [
      { role: "user" as const, content: "x", reply: { kind: "nope" } },
      { role: "intake" as const, content: "DRAFT\nX", reply: { kind: "draft", message: "", draft: { name: "X", purpose: "x", requirements: "r" } } },
      { role: "intake" as const, content: "big", reply: { kind: "draft", pad: "x".repeat(100_001) } },
    ];
    const m = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add notes", conversation: withReply as any }), () => {});
    assert.deepEqual(t.platform.buildContext(USER, m.buildId).conversation, [
      { role: "user", content: "x" },
      { role: "intake", content: "DRAFT\nX", reply: withReply[1].reply },
      { role: "intake", content: "big" },
    ]);
    assert.match(ctx.brief!, /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/, "the brief id is the spec's version and a hash of the text");

    assert.ok(await t.platform.blobs.get(`transcripts/${b.buildId}.log`), "the transcript is kept in blobs");
    assert.match((await t.platform.buildTranscript(USER, b.buildId)) ?? "", /\[platform\]/);
    assert.equal(t.platform.registry.versions("running-log").at(-1)!.buildId, b.buildId, "v1 knows the build that made it");
    assert.equal(t.platform.registry.versions("running-log").at(-1)!.conversation, true, "and that a conversation was kept");
  });

  test("only the owner attaches a conversation, and only a well-formed one; only the owner reads it", async () => {
    await assert.rejects(t.platform.create(t.claude, { name: "X", purpose: "x", requirements: "x", conversation: turns }), /owner actions/);
    await assert.rejects(t.platform.create(USER, { name: "X", purpose: "x", requirements: "x", conversation: [{ role: "bot", content: "x" }] as any }), /role/);
    await assert.rejects(t.platform.create(USER, { name: "X", purpose: "x", requirements: "x", conversation: "hello" as any }), /at most/);
    const b = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), seed);
    assert.throws(() => t.platform.buildContext(t.claude, b.buildId), /owner actions/);
    await assert.rejects(t.platform.buildTranscript(t.claude, b.buildId), /owner actions/);
    assert.throws(() => t.platform.buildContext(USER, "b-nope"), /no build/);
    // A build without a conversation (an agent's, an install's) still records the brief.
    assert.equal(t.platform.buildContext(USER, b.buildId).conversation, undefined);
    assert.ok(t.platform.buildContext(USER, b.buildId).brief);
    assert.equal(t.platform.registry.versions("running-log").at(-1)!.conversation, false, "a version without one says so");
  });

  test("a change and its widgets keep the conversation; a retry copies it; cleanup keeps the transcript", async () => {
    await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), seed);
    const m = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add notes", conversation: turns }), () => {});
    assert.deepEqual(t.platform.buildContext(USER, m.buildId).conversation, turns);
    assert.ok(!("conversation" in m.request));

    const w = await t.build(() => t.platform.addWidgets(USER, { capabilityId: "running-log", request: "a stat", conversation: turns }), () => {
      throw new Error("the builder gave up");
    });
    assert.equal(w.status, "failed");
    assert.deepEqual(t.platform.buildContext(USER, w.buildId).conversation, turns);
    t.queue(() => {
      throw new Error("again");
    });
    const again = await t.platform.retryBuild(USER, w.buildId);
    await t.platform.settle(again.buildId);
    assert.deepEqual(t.platform.buildContext(USER, again.buildId).conversation, turns, "the retry carries the conversation");

    // A month later the workbench's copy goes; the build's stays.
    const kept = await t.platform.buildTranscript(USER, m.buildId);
    assert.ok(kept);
    await t.platform.cleanup(Date.now() + 31 * 86400_000);
    assert.equal(await t.platform.workbench.transcript(m.buildId), undefined);
    assert.equal(await t.platform.buildTranscript(USER, m.buildId), kept);
  });

  test("BUILDER.md carries the owner's own words after the request, with the rule; an agent's build doesn't", async () => {
    const said = [
      { role: "user" as const, content: "track my runs, and I care about pace per km" },
      { role: "intake" as const, content: "DRAFT\nRunning Log: runs, with pace\nrecord_run@1 …", reply: { kind: "draft", message: "Here's a first go.", draft: { name: "Running Log", purpose: "runs, with pace", requirements: "record_run@1 …" } } },
      { role: "user" as const, content: "make it orange, not green" },
    ];
    let brief = "";
    const read = (ws: string) => void (brief = readFileSync(join(ws, "BUILDER.md"), "utf8"));
    await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "record runs", conversation: said }), (ws) => (read(ws), seed(ws)));
    const words = brief.indexOf("THE OWNER'S OWN WORDS");
    assert.ok(brief.indexOf("Requirements: record runs") < words && words < brief.indexOf("## Implementation contract"), "after the request, before the contract");
    assert.match(brief, /The request above is the plan; where it is silent, vague, or differs from what the owner said, follow the owner's words, and their latest word/);
    assert.match(brief, /OWNER: track my runs, and I care about pace per km\n\nINTAKE: Here's a first go\.\n\(It drafted Running Log: runs, with pace\)\n\nOWNER: make it orange, not green/);
    assert.doesNotMatch(brief, /record_run@1 …/, "a draft comes down to its name and purpose");

    await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add notes", conversation: turns }), read);
    assert.match(brief, /Requested change: add notes\n\nTHE OWNER'S OWN WORDS/, "a change's too");

    brief = "";
    const a = await t.build(() => t.platform.create(t.claude, { name: "Reading List", purpose: "books", requirements: "track books" }), read);
    assert.match(brief, /Requirements: track books/, a.log.join("\n"));
    assert.doesNotMatch(brief, /OWNER'S OWN WORDS/, "an agent's build has no conversation");
  });

  test("the owner's words: ideas come down to their names, anything else is kept as written; a long conversation keeps its first turn and the latest", () => {
    assert.equal(ownersWords(undefined), "");
    assert.match(ownersWords([{ role: "intake", content: "IDEAS\n1. A\n…", reply: { kind: "ideas", message: "Two ways:", ideas: [{ name: "A", purpose: "a" }, { name: "B", purpose: "b" }] } }]), /INTAKE: Two ways:\n\(It offered:\n- A: a\n- B: b\)$/);
    assert.match(ownersWords([{ role: "intake", content: "SCHEDULES\n…", reply: { kind: "schedules" } }]), /INTAKE: SCHEDULES\n…$/);
    const long = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? ("intake" as const) : ("user" as const), content: `turn ${i} ${"x".repeat(1000)}` }));
    const w = ownersWords(long);
    assert.ok(w.length < 42_000, `capped (${w.length})`);
    assert.match(w, /OWNER: turn 0 x+\n\n\(\d+ turns left out\)\n\n(OWNER|INTAKE): turn \d+ x+/);
    assert.match(w, /INTAKE: turn 59 x+$/, "ends with the latest");
  });

  test("purging a deleted capability removes what its builds kept", async () => {
    const b = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r", conversation: turns }), seed);
    t.platform.archive(USER, "running-log");
    await t.platform.purge(USER, "running-log", "running-log");
    assert.equal(await t.platform.blobs.get(`transcripts/${b.buildId}.log`), undefined);
    assert.equal(t.platform.registry.buildContext(b.buildId), undefined);
  });
});
