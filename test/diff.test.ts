// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, diffStats, splitLines, toHunks } from "@hewntools/core/diff.ts";

/** Apply a diff to its old side: the result must be the new side. */
const apply = (lines: ReturnType<typeof diffLines>) => lines.filter((l) => l.type !== "-").map((l) => l.text);
const old = (lines: ReturnType<typeof diffLines>) => lines.filter((l) => l.type !== "+").map((l) => l.text);

test("diff: unchanged, added, removed, both sides line-numbered", () => {
  const a = splitLines("one\ntwo\nthree\nfour\n");
  const b = splitLines("one\nTWO\nthree\nfour\nfive");
  const d = diffLines(a, b);
  assert.deepEqual(apply(d), b);
  assert.deepEqual(old(d), a);
  assert.deepEqual(diffStats(d), { added: 2, removed: 1 });
  assert.deepEqual(d.find((l) => l.text === "three"), { type: " ", text: "three", old: 3, new: 3 });
  assert.deepEqual(d.find((l) => l.text === "two"), { type: "-", text: "two", old: 2 });
  assert.deepEqual(d.find((l) => l.text === "five"), { type: "+", text: "five", new: 5 });
});

test("diff: empty sides, identical files, a file rewritten past the limit", () => {
  assert.deepEqual(diffStats(diffLines([], ["a", "b"])), { added: 2, removed: 0 });
  assert.deepEqual(diffStats(diffLines(["a"], [])), { added: 0, removed: 1 });
  assert.deepEqual(toHunks(diffLines(["a", "b"], ["a", "b"])), []);
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
  const d = diffLines(a, b);
  assert.deepEqual(diffStats(d), { added: 3000, removed: 3000 });
  assert.deepEqual(apply(d), b);
});

test("diff: random edits round-trip", () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rnd(40) }, () => `l${rnd(8)}`);
    const b = a.flatMap((l) => (rnd(5) === 0 ? [] : rnd(6) === 0 ? [l, `n${rnd(8)}`] : [l]));
    const d = diffLines(a, b);
    assert.deepEqual(apply(d), b);
    assert.deepEqual(old(d), a);
  }
});

test("hunks: three lines of context, nearby changes merged, git-style starts and counts", () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const b = [...a];
  b[4] = "changed 5";
  b[7] = "changed 8";
  b.splice(25, 0, "inserted");
  const h = toHunks(diffLines(a, b));
  assert.equal(h.length, 2);
  assert.deepEqual([h[0].oldStart, h[0].oldLines, h[0].newStart, h[0].newLines], [2, 10, 2, 10]);
  assert.deepEqual([h[1].oldStart, h[1].oldLines, h[1].newStart, h[1].newLines], [23, 6, 23, 7]);
  assert.equal(h[1].lines.filter((l) => l.type === "+").length, 1);
});
