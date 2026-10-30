// SPDX-License-Identifier: AGPL-3.0-or-later
// Arms: the variants of the build setup a bench run compares. Each one is a way to turn today's brief
// (spec/builder-brief.md in this checkout) into the brief a build runs on, plus how the build runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpecSource } from "./intake.ts";

export interface Arm {
  name: string;
  /** One line for the gallery. */
  about: string;
  /** The brief this arm builds on, from today's. Default: today's as is. */
  brief?: (current: string) => string;
  /** Builder model and effort, as Claude Code takes them. Default: the CLI's (what Hewn passes when the owner picked none). */
  model?: string;
  effort?: string;
  /**
   * Start from another arm's result (its built and seeded tool) instead of building from scratch,
   * then run the critique pass on it. The base arm runs first.
   */
  from?: string;
  /**
   * After the build: hand the builder screenshots of its own UI with the seeded data, and let it
   * improve the UI. Without `from`, it's the same result: built, captured (shots-first/), reviewed,
   * captured again (shots/).
   */
  critique?: boolean;
  /**
   * Build the cases one after another, each told how this arm's earlier tools look (name, hue and
   * their ui/look.json), as an owner's Home fills up over time.
   */
  sequential?: boolean;
  /**
   * With `from`: a craft pass on that arm's tool: fresh screenshots plus the defects the bench
   * measures (what sticks out on a phone, text cut short, page errors), fixed without a redesign.
   */
  craft?: boolean;
  /**
   * Passes after the build, in the same result and in order, each on screenshots of the version
   * before it. The first version's screenshots stay in shots-first/ (and are judged on their own).
   */
  passes?: Pass[];
  /** Where the spec comes from (default: the case's frozen requirements). */
  spec?: SpecSource;
  /** The builder writes sample/calls.json, which the bench replays instead of the case's seed. */
  sample?: boolean;
}

export type Pass = "critique" | "craft";

const ARMS_DIR = join(import.meta.dirname, "..", "arms");

/**
 * Replace the brief from the heading `from` (inclusive) up to the heading `to` (exclusive) with
 * `text`. Throws when a heading isn't there: an arm that silently stops applying would compare
 * today's brief with itself.
 */
export function replaceSection(brief: string, from: string, to: string, text: string): string {
  const start = brief.indexOf(from);
  const end = brief.indexOf(to, start + 1);
  if (start < 0) throw new Error(`brief has no "${from}"`);
  if (end < 0) throw new Error(`brief has no "${to}" after "${from}"`);
  return brief.slice(0, start) + text.trimEnd() + "\n\n" + brief.slice(end);
}

const section = (file: string) => readFileSync(join(ARMS_DIR, file), "utf8");

/** Put `text` in front of the heading `before` (which must be there). */
export function insertBefore(brief: string, before: string, text: string): string {
  const at = brief.indexOf(before);
  if (at < 0) throw new Error(`brief has no "${before}"`);
  return brief.slice(0, at) + text.trimEnd() + "\n\n" + brief.slice(at);
}

/** The brief with its UI design section ("The UI is the product" up to "The platform renders your UI") replaced by an arm's. */
const uiSection = (b: string, file: string) => replaceSection(b, "#### The UI is the product", "**The platform renders your UI before promotion**", section(file));
const oneshot = (b: string) => uiSection(b, "character-oneshot.md");
const withSample = (b: string) => insertBefore(oneshot(b), "### Contract rules (enforced)", section("sample-data.md"));

export const ARMS: Arm[] = [
  {
    name: "current",
    about: "The brief as it is in this checkout.",
  },
  {
    name: "design-forward",
    about: "UI section rewritten: the UI is the product; a concept, a signature visual and something extra; ui.css is a base, not a limit.",
    brief: (b) => uiSection(b, "design-forward.md"),
  },
  {
    name: "design-forward+critique",
    about: "design-forward, then one pass where the builder reviews screenshots of its UI with real data and improves it.",
    from: "design-forward",
    critique: true,
  },
  {
    name: "distinct",
    about: "design-forward, plus three directions and a written colour/type plan before code, and the common AI looks named as ones to avoid.",
    brief: (b) => uiSection(b, "distinct.md"),
  },
  {
    name: "distinct+critique",
    about: "distinct, then the design-review pass on screenshots.",
    from: "distinct",
    critique: true,
  },
  {
    name: "identity",
    about: "distinct, but each tool anchors on its icon's hue, is told how the owner's other tools look and must differ, and picks the least typical of its three directions. Cases built in order.",
    brief: (b) => uiSection(b, "identity.md"),
    sequential: true,
  },
  {
    name: "identity+critique",
    about: "identity, then the design-review pass (told the other tools' looks too).",
    from: "identity",
    critique: true,
    sequential: true,
  },
  {
    name: "character",
    about: "identity, after the owner's votes: colour from the subject (no forced hue spread), a real palette (not one hue in shades), big visuals instead of label: value lists, the strongest direction rather than the least typical. Cases built in order.",
    brief: (b) => uiSection(b, "character.md"),
    sequential: true,
  },
  {
    name: "character-oneshot+craft",
    about: "character, plus the mistakes the critique passes kept finding as a first-pass checklist (dark mode, one answer first, no data twice, lists, the phone); one build, then only the cheap craft pass.",
    brief: oneshot,
    sequential: true,
    passes: ["craft"],
  },
  ...(
    [
      ["intake", "today's intake, from the owner's short request (questions answered with the defaults)"],
      ["intent", "0.4.9's intake spec, with UI intent (what to draw, the subject's world) instead of a UI sketch"],
      ["thin", "an agent's thin requirements: the owner's request and little else"],
    ] as const
  ).map(
    ([source, how]): Arm => ({
      name: `spec-${source}+craft`,
      about: `The spec from ${how}; character-oneshot builds it with its own sample data, then the craft pass.`,
      brief: withSample,
      spec: source,
      sample: true,
      sequential: true,
      passes: ["craft"],
    }),
  ),
  {
    name: "spec-lean+convo",
    about: "A real conversation (the owner's details and taste) with a lean intake; the builder gets the lean brief plus the owner's own words, with its own sample data; then the critique pass (also given the owner's words) and the craft pass.",
    brief: withSample,
    spec: "lean",
    sample: true,
    sequential: true,
    passes: ["critique", "craft"],
  },
  {
    name: "character+critique+craft",
    about: "character+critique, then a craft pass: fresh screenshots and the measured defects (cut off on the phone, text cut short), fixed without a redesign.",
    from: "character+critique",
    craft: true,
  },
  ...["design-forward", "distinct", "identity"].map(
    (base): Arm => ({ name: `${base}+critique+craft`, about: `${base}+critique, then the same craft pass.`, from: `${base}+critique`, craft: true }),
  ),
  {
    name: "character+critique",
    about: "character, then the design-review pass (told the other tools' looks too).",
    from: "character",
    critique: true,
    sequential: true,
  },
];

/** What the craft pass asks for: the screen made right, not redesigned. */
export function craftRequest(defects: string[]): string {
  return [
    "Craft pass. The screenshots in screenshots/ show this tool's UI as it is now, filled with real data (desktop light, desktop dark, phone light, phone dark, the phone 390 px wide). Open every one of them.",
    defects.length ? `Measured on this UI:\n${defects.map((d) => `- ${d}`).join("\n")}` : "Nothing was measured as broken, but look closely anyway.",
    "Fix what's broken, cramped or cut off, on the phone first: anything that sticks out past the screen or gets clipped, elements that overlap or cover each other, labels cut short where the cut hides what they mean, text wrapping one word per line, collisions in charts and axes, low contrast, misalignment, and empty gaps that look like mistakes. Check the result against every screenshot's size, and keep it working from 375 px up.",
    "Don't redesign: keep the concept, palette, type and layout direction, and every feature. Change only ui/ (keep ui/look.json true). The screenshots/ folder is removed after this pass; don't link to it.",
  ].join("\n\n");
}

/** What a build is told about the owner's other tools (the arm's earlier results): name, hue, look. */
export function othersNote(tools: { name: string; hue?: number; saturation?: number; look?: unknown }[]): string {
  if (!tools.length) return "";
  const line = (t: (typeof tools)[number]) => `- ${t.name}${t.hue !== undefined ? ` (hue ${t.hue}${t.saturation !== undefined ? `, saturation ${t.saturation}` : ""})` : ""}: ${t.look ? JSON.stringify(t.look).slice(0, 700) : "no look recorded"}`;
  return `\n\nTHE OWNER'S OTHER TOOLS (on their Home already; this one must look clearly different from each)\n${tools.map(line).join("\n")}`;
}

export function armNamed(name: string, arms: Arm[] = ARMS): Arm {
  const arm = arms.find((a) => a.name === name);
  if (!arm) throw new Error(`no arm "${name}" (arms: ${arms.map((a) => a.name).join(", ")})`);
  return arm;
}

/** The arms to run for `names`, each after the arm it starts from. */
export function runOrder(names: string[], arms: Arm[] = ARMS): Arm[] {
  const out: Arm[] = [];
  const add = (name: string, seen: string[] = []) => {
    if (seen.includes(name)) throw new Error(`arm cycle: ${[...seen, name].join(" → ")}`);
    const arm = armNamed(name, arms);
    if (arm.from) add(arm.from, [...seen, name]);
    if (!out.includes(arm)) out.push(arm);
  };
  names.forEach((n) => add(n));
  return out;
}

/** The brief an arm builds on (an arm that starts from another builds nothing itself; its critique runs on the base's brief). */
export function briefFor(arm: Arm, current: string, arms: Arm[] = ARMS): string {
  if (arm.from) return briefFor(armNamed(arm.from, arms), current, arms);
  return arm.brief ? arm.brief(current) : current;
}

/** What the critique pass asks for, as a modify request. */
export const CRITIQUE_REQUEST = [
  "Design review pass. The screenshots in screenshots/ show this tool's UI as the owner sees it today, filled with real data (desktop light, desktop dark, mobile light, mobile dark). Open every one of them and look at them critically, as a demanding senior product designer would.",
  "First write down the five biggest problems you see (hierarchy, density, what the eye lands on first, how generic it looks, how well the data is visualised, the main action, small-screen layout, dark mode, delight). Then fix them in ui/, raising the bar: a screen the owner is delighted to open, with its own character and at least one custom data visual.",
  "Change only ui/ (the operations, state and tests stay exactly as they are). The screenshots/ folder is removed after this pass; don't link to it.",
].join("\n\n");
