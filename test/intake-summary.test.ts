// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { intakePrompt, parseIntake, SUMMARY_SCHEMA, schemaFor, SCHEMA } from "@hewntools/cli/intake.ts";

const bundle = {
  manifest: { id: "plant-log", name: "Plant Log", purpose: "Watering per plant.", abi: "2.5", requires: { hosts: ["api.plantnet.org"], model: { tier: "light" as const, input: ["text" as const, "image" as const] } }, operations: [] },
  files: [{ path: "capability.json", text: "   1| {" }, { path: "src/index.ts", text: "   1| export const operations = {};" }],
  cut: ["ui/index.html (after 40 KB)"],
};

test("summarize: the prompt carries the files with their line numbers, what the sandbox allows, and what was cut", () => {
  const p = intakePrompt({ mode: "summarize", messages: [], bundle });
  assert.match(p, /=== src\/index\.ts\n {3}1\| export const operations/);
  assert.match(p, /hosts: api\.plantnet\.org; a model \(light, with images\)/);
  assert.match(p, /Left out or shortened .*ui\/index\.html \(after 40 KB\)/);
  assert.doesNotMatch(p, /Conversation so far/, "no conversation: a reading, not a chat");
  assert.equal(schemaFor({ mode: "summarize" }), SUMMARY_SCHEMA);
  assert.equal(schemaFor({ mode: "create" }), SCHEMA);
});

test("summarize: the reply, with prose around it; warnings first, at most six; an empty one is refused", () => {
  const raw = `Here you go:\n${JSON.stringify({
    kind: "summary",
    message: " Logs watering per plant. ",
    keeps: "Plants and waterings.",
    reaches: "Each photo goes to the model.",
    findings: [{ kind: "ok", title: "Nothing else leaves", detail: "", file: "", line: 0 }, { kind: "warn", title: "Sends each photo to the model", detail: "The description doesn't say so", file: "src/vision.ts", line: 14 }, { kind: "maybe", title: "dropped", detail: "", file: "", line: 0 }],
  })}\nDone.`;
  const r = parseIntake(raw, "summarize") as any;
  assert.equal(r.kind, "summary");
  assert.equal(r.message, "Logs watering per plant.");
  assert.deepEqual(r.findings, [{ kind: "warn", title: "Sends each photo to the model", detail: "The description doesn't say so", file: "src/vision.ts", line: 14 }, { kind: "ok", title: "Nothing else leaves" }]);
  assert.throws(() => parseIntake(JSON.stringify({ kind: "summary", message: "", keeps: "", reaches: "", findings: [] }), "summarize"), /summary is empty/);
});
