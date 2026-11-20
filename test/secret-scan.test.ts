// SPDX-License-Identifier: AGPL-3.0-or-later
// The secret scan in validation: a known key shape in a tool's own files fails it, named by its file
// and line and never by its value; a long random string warns; npm's lockfile and made-up personal
// data in sample data do neither.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { FileEntry } from "@hewntools/core/platform.ts";
import { installSeed, SEED, setup } from "./helpers.ts";

/** A GitHub token's shape, made here so that no file in this repository holds one. */
const TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;
/** A long random string: a key or a hash, nobody can tell. */
const RANDOM = "q8Zk3vN0pL2xR7tY9wB4mC6dF1hJ5sA0e";

/** A folder's files as a client sends them. */
function entriesOf(dir: string, rel = ""): FileEntry[] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const path = rel ? `${rel}/${name}` : name;
    return statSync(join(dir, path)).isDirectory() ? entriesOf(dir, path) : [{ path, content: readFileSync(join(dir, path), "utf8") }];
  });
}
/** The running log's files with lines added to the end of one (or a file added). */
const plus = (path: string, ...lines: string[]): FileEntry[] => {
  const files = entriesOf(SEED);
  const had = files.some((f) => f.path === path);
  return had ? files.map((f) => (f.path === path ? { ...f, content: `${f.content}\n${lines.join("\n")}` } : f)) : [...files, { path, content: lines.join("\n") }];
};
/** The line the first added line lands on. */
const firstAdded = (path: string) => entriesOf(SEED).find((f) => f.path === path)!.content.split("\n").length + 1;

/** A lockfile as npm writes it: its integrity hashes look random. */
const LOCK = JSON.stringify(
  {
    name: "running-log",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "running-log" },
      "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQBdKDyVvGzvh8Fts4hDsIwF5U2pLuGcuEPLQ2jKGIQr1d5Q==" },
    },
  },
  null,
  2,
);

describe("the secret scan", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("a client's check: a key shape fails, named by its file and line, never its value", async () => {
    const r = await t.platform.checkFiles(t.claude, { files: plus("src/index.ts", `// ${TOKEN}`), capabilityId: "running-log" });
    assert.equal(r.passed, false, r.text);
    const failure = r.failures.find((f) => /a key in its files/.test(f));
    assert.ok(failure, r.text);
    assert.match(failure, new RegExp(`src/index\\.ts:${firstAdded("src/index.ts")}: looks like a GitHub token`));
    assert.ok(!JSON.stringify(r).includes(TOKEN.slice(4)), "never the value, nor a part of it");
  });

  test("a long random string warns, once a file at its first line, and passes; the lockfile's hashes and made-up personal data don't", async () => {
    const files = [
      ...plus("src/index.ts", `// ${RANDOM}`, `// ${RANDOM.split("").reverse().join("")}`),
      { path: "package-lock.json", content: LOCK },
    ].map((f) => (f.path === "sample/calls.json" ? { ...f, content: f.content.replace(/"notes": "[^"]*"/, '"notes": "with anna.berg@example.com, +44 20 7946 0958"') } : f));
    const r = await t.platform.checkFiles(t.claude, { files, capabilityId: "running-log" });
    assert.equal(r.passed, true, r.text);
    assert.deepEqual(r.warnings, [{ check: "secret-scan", message: "2 long random strings, the first here: if it's a key, it belongs in a connection's secrets, not in the tool's files (a hash or an id can stay)", file: "src/index.ts", line: firstAdded("src/index.ts") }]);
    assert.match(r.text, /Warnings \(they don't fail it/);
    assert.ok(!JSON.stringify(r).includes(RANDOM), "never the value");
  });

  test("a submission with a key shape fails by file and line; one with a long random string is held with the warning on its card and in its log", async () => {
    const failed = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: plus("tests/notes.txt", "a fixture", `token: ${TOKEN}`), capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.equal(failed.status, "failed");
    const seen = JSON.stringify(t.platform.getBuild(t.claude, failed.buildId));
    assert.match(seen, /tests\/notes\.txt:2: looks like a GitHub token/);
    assert.ok(!seen.includes(TOKEN.slice(4)), seen);
    assert.equal(t.platform.registry.getCapability("running-log")!.activeVersion, 1);

    const held = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: plus("tests/notes.txt", "a fixture", `hash: ${RANDOM}`), capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.equal(held.status, "review", held.log.join("\n"));
    assert.deepEqual(held.review!.warnings?.map((w) => [w.check, w.file, w.line]), [["secret-scan", "tests/notes.txt", 2]]);
    assert.ok(held.log.some((l) => /warning: secret-scan: a long random string.*\(tests\/notes\.txt:2\)/.test(l)), held.log.join("\n"));
  });
});
