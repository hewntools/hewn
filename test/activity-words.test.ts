// SPDX-License-Identifier: AGPL-3.0-or-later
// Activity says every access change and lifecycle event in words: each action the core records has one in the web
// client (a missing one shows as the raw action, "config_set").
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const core = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? core(join(dir, e.name)) : e.name.endsWith(".ts") ? [readFileSync(join(dir, e.name), "utf8")] : []));
const source = core(join(ROOT, "packages/core/src")).join("\n");
const activity = readFileSync(join(ROOT, "packages/host-workerd/web/app/activity.js"), "utf8");

test("every authority action the core records has words in Activity", () => {
  // The action literals in addAuthorityEvent calls ("x", or a ? "x" : "y").
  const calls = [...source.matchAll(/addAuthorityEvent\(\{[^}]*?action: ([^,]+),/g)].map((m) => m[1]);
  const actions = [...new Set(calls.flatMap((a) => [...a.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1])))];
  assert.ok(actions.length >= 20, `found ${actions.length}: ${actions.join(", ")}`);
  const missing = actions.filter((a) => !new RegExp(`\\b${a}: \\(\\) =>`).test(activity));
  assert.deepEqual(missing, [], `no words in web/app/activity.js for: ${missing.join(", ")}`);
});

test("every lifecycle event the core records has words in Activity", () => {
  const actions = [...new Set([...source.matchAll(/addLifecycleEvent\([^,]+, "([a-z-]+)"/g)].map((m) => m[1]))];
  assert.ok(actions.length >= 6, actions.join(", "));
  // The lifecycle words: the one line that maps them (it starts with delete: "Deleted").
  const words = activity.split("\n").find((l) => l.includes('delete: "Deleted"')) ?? "";
  // A key, or a shorthand property ({ …, schedule, … }).
  const missing = actions.filter((a) => !new RegExp(`(^|[\\s,{])"?${a}"?(:|,| })`).test(words));
  assert.deepEqual(missing, [], `no lifecycle words for: ${missing.join(", ")}`);
});
