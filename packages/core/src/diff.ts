// SPDX-License-Identifier: AGPL-3.0-or-later
// A line diff (Myers) and git-style hunks: what the code browser shows as Changes between two
// versions of a file, and the +n −n beside each file in the list.

export interface DiffLine {
  /** " " unchanged, "+" added, "-" removed. */
  type: " " | "+" | "-";
  text: string;
  /** Line number on each side (absent on the side the line isn't on). */
  old?: number;
  new?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Beyond this many differing lines a file counts as rewritten: all of the old out, all of the new in. */
const MAX_EDITS = 1000;

export const splitLines = (text: string): string[] => (text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Every line of `before` and `after`, in order, marked unchanged, removed or added. */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let endA = before.length;
  let endB = after.length;
  while (endA > head && endB > head && before[endA - 1] === after[endB - 1]) (endA--, endB--);
  const a = before.slice(head, endA);
  const b = after.slice(head, endB);
  const middle = myers(a, b) ?? [...a.map((text) => ({ type: "-" as const, text })), ...b.map((text) => ({ type: "+" as const, text }))];
  const out: DiffLine[] = [];
  let o = 1;
  let n = 1;
  const same = (text: string) => out.push({ type: " ", text, old: o++, new: n++ });
  for (let i = 0; i < head; i++) same(before[i]);
  for (const l of middle) {
    if (l.type === " ") same(l.text);
    else if (l.type === "-") out.push({ type: "-", text: l.text, old: o++ });
    else out.push({ type: "+", text: l.text, new: n++ });
  }
  for (let i = endA; i < before.length; i++) same(before[i]);
  return out;
}

/** Myers' O(ND) diff on what's left after the common ends; undefined past MAX_EDITS. */
function myers(a: string[], b: string[]): { type: " " | "+" | "-"; text: string }[] | undefined {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  const max = n + m;
  const offset = max;
  // v[k]: the furthest x on diagonal k. One array: step d only reads diagonals step d−1 wrote.
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(v.slice(offset - d, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) (x++, y++);
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return undefined;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dEnd: number) {
  const out: { type: " " | "+" | "-"; text: string }[] = [];
  let x = a.length;
  let y = b.length;
  // trace[d] holds v[-d .. d+1] as it was before step d.
  const at = (d: number, k: number) => trace[d][k + d];
  for (let d = dEnd; d > 0; d--) {
    const k = x - y;
    const prevK = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1)) ? k + 1 : k - 1;
    const prevX = at(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ type: " ", text: a[--x] });
      y--;
    }
    if (x === prevX) out.push({ type: "+", text: b[--y] });
    else out.push({ type: "-", text: a[--x] });
  }
  while (x > 0 && y > 0) {
    out.push({ type: " ", text: a[--x] });
    y--;
  }
  return out.reverse();
}

/** Lines added and removed. */
export const diffStats = (lines: DiffLine[]) => ({ added: lines.filter((l) => l.type === "+").length, removed: lines.filter((l) => l.type === "-").length });

/** Git-style hunks: each change with `context` unchanged lines around it, nearby changes merged. */
export function toHunks(lines: DiffLine[], context = 3): Hunk[] {
  const changed = lines.map((l, i) => (l.type === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  return ranges.map(([from, to]) => {
    const part = lines.slice(from, to + 1);
    // Where each side starts: the first line on it, or (none in the hunk) just after the line before.
    const startOn = (side: "old" | "new") => part.find((l) => l[side] !== undefined)?.[side] ?? (lines.slice(0, from).reverse().find((l) => l[side] !== undefined)?.[side] ?? 0);
    return {
      oldStart: startOn("old"),
      oldLines: part.filter((l) => l.type !== "+").length,
      newStart: startOn("new"),
      newLines: part.filter((l) => l.type !== "-").length,
      lines: part,
    };
  });
}
