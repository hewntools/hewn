// SPDX-License-Identifier: AGPL-3.0-or-later
// The passes a new tool's build runs once its candidate validates: the critique (the builder looks at
// screenshots of its own UI filled with its sample data, names the five biggest problems and fixes
// them) and the craft pass (fresh screenshots and what was measured on them, fixed without a
// redesign). A Polish runs them on a tool already live. What each asks of the builder; the
// build-quality bench (bench/) asks the same.

/** A pass after the build, run in this order. */
export type Pass = "critique" | "craft";
export const PASSES: readonly Pass[] = ["critique", "craft"];

/** How many times a pass's builder may try to leave a valid candidate (at most the build's attempts) before its build fails. */
export const PASS_TRIES = 2;

/** The passes new tools' builds run unless the owner says otherwise (a fresh list each time). */
export const defaultPasses = (): Pass[] => [...PASSES];

/**
 * A long page renders in parts, top to bottom: "mobile-light", then "mobile-light-2" and on. The
 * name of part `i` (0 the first) of a render, and whether a render's name is a further part.
 */
export const partName = (name: string, i: number) => (i ? `${name}-${i + 1}` : name);
export const isPart = (name: string) => /-\d+$/.test(name);

/** Whether a build's request is a Polish: a change that runs the passes on a tool already live. */
export const isPolish = (request: Record<string, unknown>) => request.polish === true;

/** The passes in `list` that Hewn knows, once each, in the order they run. */
export const passesIn = (list: unknown): Pass[] => (Array.isArray(list) ? PASSES.filter((p) => list.includes(p)) : []);

/** What the critique pass asks for (the bench's words). */
export const CRITIQUE_REQUEST = [
  "Design review pass. The screenshots in screenshots/ show this tool's current UI (desktop light, desktop dark, mobile light, mobile dark). Open every one of them and look at them critically, as a demanding senior product designer would.",
  "First write down the five biggest problems you see (hierarchy, density, what the eye lands on first, how generic it looks, how well the data is visualised, the main action, small-screen layout, dark mode, delight). Then fix them in ui/, raising the bar: a screen the owner is delighted to open, with its own character and at least one custom data visual. Stay within requested behavior and preserve every feature.",
  "Change only ui/ (the operations, state and tests stay exactly as they are). The screenshots/ folder is never part of the tool; don't link to it.",
].join("\n\n");

/** What the craft pass asks for: the screen made right, not redesigned (the bench's words). */
export function craftRequest(defects: string[]): string {
  return [
    "Craft pass. The screenshots in screenshots/ show this tool's current UI (desktop light, desktop dark, phone light, phone dark, the phone 390 px wide). Open every one of them.",
    defects.length ? `Measured on this UI:\n${defects.map((d) => `- ${d}`).join("\n")}` : "Nothing was measured as broken, but look closely anyway.",
    "Fix what's broken, cramped or cut off, on the phone first: anything that sticks out past the screen or gets clipped, elements that overlap or cover each other, labels cut short where the cut hides what they mean, text wrapping one word per line, collisions in charts and axes, low contrast, misalignment, and empty gaps that look like mistakes. Check the result against every screenshot's size, and keep it working from 375 px up.",
    "Don't redesign: keep the concept, palette, type and layout direction, and every feature. Change only ui/ (keep ui/look.json true). The screenshots/ folder is never part of the tool; don't link to it.",
  ].join("\n\n");
}

/** What a Polish keeps (the owner, 2026-11-02): the tool's identity, unless the owner asks for a new look. */
export const POLISH_KEEPS = "This tool is live and the owner uses it: lift its design, but keep its identity (its concept, its hue and the palette family in ui/look.json) and every feature, unless the request in BUILDER.md asks for a new look.";

/** Why a Polish's screenshots are private, and what that rules out: the owner let the builder see their own data. */
export const REAL_DATA_RULE = "They show the owner's own data (they allowed it for this Polish), not sample data. It's private: never copy any of it into the tool's files. Sample data, tests and the UI's text stay made up.";

/**
 * What a pass asks of a build's builder: the bench's request, then the screenshots by name (a long
 * page comes in parts), whether they're filled with sample data (or, `real`, a copy of the owner's
 * own), and (the critique) what else to hold the screen against: the owner's words in OWNERS_WORDS.md
 * and the other tools' looks in OTHER_TOOLS.md, pointed to rather than repeated (the builder has read
 * them, and both can be long), and on a Polish (`polish`) what it keeps.
 */
export function passRequest(pass: Pass, o: { files: string[]; sampled: boolean; real?: boolean; defects?: string[]; ownersWords?: boolean; otherTools?: boolean; polish?: boolean }): string {
  const parts = o.files.some((f) => isPart(f.replace(/\.png$/, "")));
  return [
    pass === "critique" ? CRITIQUE_REQUEST : craftRequest(o.defects ?? []),
    `The screenshots: ${o.files.join(", ")}.${parts ? " A long page comes in parts, top to bottom: desktop-light-2.png carries on from desktop-light.png, and so on." : ""}${o.real ? ` ${REAL_DATA_RULE}` : o.sampled ? " They show made-up sample data from sample/calls.json." : " The tool has no sample data (sample/calls.json), so they show it empty."}`,
    pass === "critique" && o.polish ? POLISH_KEEPS : "",
    pass === "critique" && o.ownersWords ? "Also check the screen against what the owner asked for and how they wanted it to feel: THE OWNER'S OWN WORDS in OWNERS_WORDS.md." : "",
    pass === "critique" && o.otherTools ? (o.polish ? "Whatever you change must still look clearly different from each of the owner's other tools in OTHER_TOOLS.md; this tool keeps its own hue." : "It must still look clearly different from each of the owner's other tools in OTHER_TOOLS.md.") : "",
    "Keep everything working: Hewn validates the result again, and the tool goes live only if it passes.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
