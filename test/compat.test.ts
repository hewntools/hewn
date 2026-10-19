// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { breakingChanges } from "@hewntools/core/manifest.ts";

// A new version of an operation contract: input may only accept more, output may only promise more.
const obj = (properties: Record<string, object>, required: string[] = []) => ({ type: "object", properties, required });
const broken = (o: object, n: object, dir: "input" | "output") => breakingChanges(o as any, n as any, dir).length > 0;

test("bounds: a tighter input breaks, a looser input doesn't; the reverse for output", () => {
  const a = obj({ n: { type: "integer", minimum: 1, maximum: 10 } });
  const tighter = obj({ n: { type: "integer", minimum: 2, maximum: 10 } });
  const looser = obj({ n: { type: "integer", minimum: 0 } });
  assert.ok(broken(a, tighter, "input"));
  assert.ok(!broken(a, looser, "input"));
  assert.ok(broken(a, looser, "output"));
  assert.ok(!broken(a, tighter, "output"));
  assert.ok(broken(obj({ s: { type: "string" } }), obj({ s: { type: "string", maxLength: 40 } }), "input"), "a new maxLength restricts input");
  assert.ok(broken(obj({ s: { type: "string", maxLength: 40 } }), obj({ s: { type: "string" } }), "output"), "dropping maxLength loosens output");
});

test("restrictions: pattern, format and const added or changed restrict; removed loosen", () => {
  const plain = obj({ d: { type: "string" } });
  const dated = obj({ d: { type: "string", format: "date" } });
  const iso = obj({ d: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } });
  assert.ok(broken(plain, dated, "input"));
  assert.ok(!broken(dated, plain, "input"));
  assert.ok(broken(dated, plain, "output"));
  assert.ok(!broken(plain, iso, "output"));
  assert.ok(broken(obj({ d: { type: "string", pattern: "^a" } }), obj({ d: { type: "string", pattern: "^b" } }), "input"), "a changed pattern can't be compared");
});

test("composite keywords aren't compared: any change breaks, no change doesn't", () => {
  const one = obj({ v: { oneOf: [{ type: "string" }, { type: "number" }] } });
  const two = obj({ v: { oneOf: [{ type: "string" }] } });
  assert.ok(broken(one, two, "input"));
  assert.ok(broken(one, two, "output"));
  assert.ok(!broken(one, structuredClone(one), "input"));
  assert.ok(broken(obj({ r: { $ref: "#/a" } }), obj({ r: { $ref: "#/b" } }), "output"));
});

test("what already held still holds: removed and newly required properties, types, enums, items", () => {
  assert.ok(broken(obj({ a: { type: "string" } }), obj({}), "input"));
  assert.ok(broken(obj({ a: { type: "string" } }), obj({ a: { type: "string" } }, ["a"]), "input"));
  assert.ok(broken(obj({ a: { type: "string" } }, ["a"]), obj({ a: { type: "string" } }), "output"));
  assert.ok(broken(obj({ a: { type: "string" } }), obj({ a: { type: "number" } }), "output"));
  assert.ok(broken(obj({ e: { enum: ["x", "y"] } }), obj({ e: { enum: ["x"] } }), "input"));
  assert.ok(!broken(obj({ e: { enum: ["x"] } }), obj({ e: { enum: ["x", "y"] } }), "input"));
  assert.ok(broken({ type: "array" }, { type: "array", items: { type: "string" } }, "input"), "items added restricts input");
  assert.ok(!broken({ type: "array" }, { type: "array", items: { type: "string" } }, "output"));
  assert.ok(!broken(obj({ a: { type: "string", description: "x" } }), obj({ a: { type: "string", description: "y" } }), "input"), "descriptions don't matter");
});
