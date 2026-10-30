// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { LOOK_CHARS, lookText, looksNote } from "@hewntools/core/platform/builds.ts";
import { editJson, FIXTURES, SEED, setup } from "./helpers.ts";

/** A recorded look, long enough to be cut short (a palette of 40 named colours). */
const look = {
  hue: 25,
  palette: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`clay${i}`, `#c2410${i % 10}`])),
  type: { display: "Oswald", body: "Inter" },
  layout: "a race-day bib",
  signature: "the pace ribbon",
  mood: "brisk, outdoorsy",
};

/** The builder writes the Running Log seed as `id`, with a hue and, when given, a recorded look. */
const seedAs =
  (id: string, name: string, { hue, recorded }: { hue?: number; recorded?: string } = {}) =>
  (ws: string) => {
    cpSync(SEED, ws, { recursive: true });
    editJson(join(ws, "capability.json"), (m) => {
      Object.assign(m, { id, name });
      if (hue !== undefined) m.hue = hue;
    });
    if (recorded === undefined) return;
    mkdirSync(join(ws, "ui"), { recursive: true });
    writeFileSync(join(ws, "ui", "look.json"), recorded);
  };

describe("the owner's other tools' looks", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("BUILDER.md lists each other tool with its hue and recorded look, cut short; one without a look is listed without one", async () => {
    let brief = "";
    const read = (ws: string) => void (brief = readFileSync(join(ws, "BUILDER.md"), "utf8"));
    const first = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), (ws) => (read(ws), seedAs("running-log", "Running Log", { hue: 25, recorded: JSON.stringify(look, null, 2) })(ws)));
    assert.equal(first.status, "promoted", first.log.join("\n"));
    assert.doesNotMatch(brief, /other tools' looks/, "the first tool has no others");
    await t.build(() => t.platform.create(USER, { name: "Reading List", purpose: "books", requirements: "r" }), seedAs("reading-list", "Reading List"));
    // A connection has no UI: not among the looks, and its own build gets none.
    const conn = await t.build(() => t.platform.create(USER, { name: "Site Connection", purpose: "the site", requirements: "r", kind: "connection" }), (ws) => (read(ws), cpSync(join(FIXTURES, "site-connection"), ws, { recursive: true })));
    assert.equal(conn.status, "promoted", conn.log.join("\n"));
    assert.match(brief, /## The owner's other capabilities/, "a connection's build still gets the contracts");
    assert.doesNotMatch(brief, /other tools' looks/);

    await t.build(() => t.platform.create(USER, { name: "Sleep Log", purpose: "sleep", requirements: "r" }), (ws) => (read(ws), seedAs("sleep-log", "Sleep Log")(ws)));
    const at = brief.indexOf("## The owner's other tools' looks");
    assert.ok(at > brief.indexOf("## The owner's other capabilities"), "after the contracts, at the end of the file");
    const looks = brief.slice(at);
    assert.match(looks, /This one must look clearly different from each of them/);
    const recorded = looks.match(/^- \*\*Running Log\*\* \(`running-log`\), hue 25: (.*)$/m)?.[1];
    assert.ok(recorded, looks);
    assert.equal(recorded.length, LOOK_CHARS, "cut short");
    assert.ok(recorded.startsWith('{"hue":25,"palette":{"clay0":"#c24100"') && recorded.endsWith("…"), recorded);
    assert.match(looks, /^- \*\*Reading List\*\* \(`reading-list`\): no look recorded$/m, "listed without a look, and without a hue it doesn't have");
    assert.doesNotMatch(looks, /site-connection|Sleep Log/, "neither the connection nor the tool being built");

    // Home's hue and saturation, the owner's over the manifest's, and the name Home shows.
    t.platform.setHue(USER, "reading-list", 300);
    t.platform.setSaturation(USER, "reading-list", 70);
    t.platform.rename(USER, "running-log", "Runs");
    // A change keeps its own look and isn't listed among the others.
    await t.build(() => t.platform.modify(USER, { capabilityId: "sleep-log", request: "add notes" }), (ws) => {
      read(ws);
      throw new Error("the builder gave up");
    });
    const changed = brief.slice(brief.indexOf("## The owner's other tools' looks"));
    assert.match(changed, /This tool keeps its own look; whatever is new in it, and a new look when the request asks for one, must still look clearly different/);
    assert.match(changed, /^- \*\*Reading List\*\* \(`reading-list`\), hue 300, saturation 70%: no look recorded$/m);
    assert.match(changed, /^- \*\*Runs\*\* \(`running-log`\), hue 25: \{"hue":25/m);
    assert.doesNotMatch(changed, /sleep-log/);
  });

  test("a recorded look comes on one line: compact JSON, or the text as written; an empty one is none", () => {
    assert.equal(lookText('{\n  "hue": 25,\n  "mood": "brisk,   outdoorsy"\n}\n'), '{"hue":25,"mood":"brisk, outdoorsy"}');
    assert.equal(lookText("warm paper,\n\n  a library card"), "warm paper, a library card", "not JSON: the builder's words");
    for (const empty of ["", "  \n", "{}", "null", '""']) assert.equal(lookText(empty), undefined, JSON.stringify(empty));
    assert.equal(lookText("x".repeat(LOOK_CHARS)), "x".repeat(LOOK_CHARS), "at the cap: whole");
    assert.equal(lookText("x".repeat(LOOK_CHARS + 1)), `${"x".repeat(LOOK_CHARS - 1)}…`);
    assert.equal(looksNote([]), "", "no other tools: no section");
  });
});
