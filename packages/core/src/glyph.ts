// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 5×5 pixel glyphs (app icons). Parsed into cells and re-rendered, so a stored glyph is always the
 * canonical, inert SVG: whole-unit rects, currentColor, nothing else.
 */

export type Cells = [x: number, y: number][];

/** Rows like ".####" (lit = "#"), five of them. */
export function cellsFromRows(rows: unknown): Cells | undefined {
  if (!Array.isArray(rows) || rows.length !== 5 || !rows.every((r) => typeof r === "string" && /^[.#]{5}$/.test(r))) return undefined;
  return rows.flatMap((r: string, y) => [...r].flatMap((c, x) => (c === "#" ? [[x, y] as [number, number]] : [])));
}

/** Lit cells of a 5×5 SVG, or undefined if it isn't one (wrong viewBox, fractional or out-of-range rects). */
export function cellsFromSvg(svg: string): Cells | undefined {
  if (!/<svg\b[^>]*viewBox=["']\s*0\s+0\s+5\s+5\s*["']/i.test(svg)) return undefined;
  const lit = new Set<string>();
  for (const m of svg.matchAll(/<rect\b([^>]*)>/gi)) {
    const attr = (n: string, d: number) => {
      const v = new RegExp(`\\b${n}=["']([^"']*)["']`).exec(m[1])?.[1];
      return v === undefined ? d : Number(v);
    };
    const [x, y, w, h] = [attr("x", 0), attr("y", 0), attr("width", 1), attr("height", 1)];
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > 5 || y + h > 5) return undefined;
    for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) lit.add(`${i},${j}`);
  }
  if (!lit.size) return undefined;
  return [...lit].map((k) => k.split(",").map(Number) as [number, number]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

export function glyphSvg(cells: Cells): string {
  const rects = cells.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" fill="currentColor" shape-rendering="crispEdges">${rects}</svg>\n`;
}
