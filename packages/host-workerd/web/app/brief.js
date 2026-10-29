// SPDX-License-Identifier: AGPL-3.0-or-later
// A new tool's brief, as the intake writes it (FOR, KEEPS, DECIDED, PLATFORM, UI INTENT), read back
// into its parts for the proposal card. Text only: no DOM.

export { briefParts };

// A heading alone on its line ("KEEPS", "## Keeps", "**Keeps**"), or with a colon and its first line
// ("Keeps: …"): "FOR now, …" is a sentence, not a heading.
const HEADING = /^[#*\s]*(for|keeps|decided|platform|ui[\s_-]?intent)[*\s]*(?::[*\s]*(.*))?$/i;
// Headings run together on one line ("FOR: … KEEPS: …"): capitals and a colon only, so prose isn't split.
const INLINE = /\s+(?=\**(?:FOR|KEEPS|DECIDED|PLATFORM|UI INTENT)\**:)/g;
const MARKER = /^(?:[-*•]|\d+[.)])\s+/;

/**
 * The brief by its parts, keyed FOR, KEEPS, DECIDED, PLATFORM and UI INTENT: each part's lines, list
 * markers stripped, joined with " · ". Text without headings (a spec from before 0.4.10, a
 * connection's): none.
 */
function briefParts(text) {
  const parts = {};
  let at;
  for (const line of (text ?? "").replace(INLINE, "\n").split("\n").map((l) => l.trim())) {
    const m = HEADING.exec(line);
    if (m) (at = /^ui/i.test(m[1]) ? "UI INTENT" : m[1].toUpperCase()), (parts[at] = m[2] ? [m[2]] : []);
    else if (at && line) parts[at].push(line);
  }
  return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.map((l) => l.replace(MARKER, "")).join(" · ")]));
}
