// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's own pixel glyphs: the Inbox's bell, and the palette's actions and places (Agents › Add… uses
// them too). Only the kit is imported, so the modules that share these never depend on load order.
import { h, pixelGlyph, rowCells } from "../kit.js";

export { BELL, glyphTile, PALETTE_GLYPHS };

const BELL = ["..#..", ".###.", ".###.", "#####", "..#.."];

/** 5×5 glyphs for the palette's actions and places (Hewn's pixel style, no UI icon set). */
const PALETTE_GLYPHS = {
  plus: ["..#..", "..#..", "#####", "..#..", "..#.."],
  widget: ["##.##", "##.##", ".....", "##.##", "##.##"],
  edit: ["...##", "..###", ".###.", "###..", "#...."],
  agent: [".###.", ".###.", ".....", "#####", "#####"],
  link: ["##...", "#.#..", ".###.", "..#.#", "...##"],
  hammer: ["#####", "#####", "..#..", "..#..", "..#.."],
  ask: ["#####", "#...#", "#####", ".#...", "#...."],
  backup: ["..#..", "..#..", "#.#.#", ".###.", "#####"],
  appearance: [".###.", "###.#", "###.#", "###.#", ".###."],
  keys: ["#####", "#.#.#", "#####", "#...#", "#####"],
  home: ["..#..", ".###.", "#####", "##.##", "##.##"],
  bell: BELL,
  activity: ["#.###", ".....", "#.###", ".....", "#.###"],
  key: [".###.", ".#.#.", ".###.", "..#..", "..##."],
  settings: ["#.#.#", ".###.", "##.##", ".###.", "#.#.#"],
  chip: ["#####", "#...#", "#.#.#", "#...#", "#####"],
};
/** A small tile with a pixel glyph, for Hewn's own actions and places: ink on grey (saturation 0), like Home's New; colour is for tools. */
const glyphTile = (rows, size) => h("span", { class: "app-icon", style: { "--size": `${size}px`, "--s": 0 }, "aria-hidden": "true" }, pixelGlyph(rowCells(rows)));
