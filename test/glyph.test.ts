// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cellsFromRows, cellsFromSvg, glyphSvg } from "@hewntools/core/glyph.ts";

describe("5×5 glyphs", () => {
  test("rows and SVG round-trip to the same cells", () => {
    const cells = cellsFromRows(["#....", ".#...", "..#..", "...#.", "....#"])!;
    assert.deepEqual(cellsFromSvg(glyphSvg(cells)), cells);
  });
  test("multi-cell rects are expanded; anything off the grid is rejected", () => {
    assert.equal(cellsFromSvg('<svg viewBox="0 0 5 5"><rect x="1" y="1" width="3" height="2"/></svg>')!.length, 6);
    assert.equal(cellsFromSvg('<svg viewBox="0 0 24 24"><rect width="1" height="1"/></svg>'), undefined);
    assert.equal(cellsFromSvg('<svg viewBox="0 0 5 5"><rect x="0.5" y="0" width="1" height="1"/></svg>'), undefined);
    assert.equal(cellsFromSvg('<svg viewBox="0 0 5 5"><rect x="4" y="0" width="2" height="1"/></svg>'), undefined);
    assert.equal(cellsFromRows(["#####"]), undefined);
  });
});
