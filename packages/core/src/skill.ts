// SPDX-License-Identifier: AGPL-3.0-or-later
// The Agent Skill "build a Hewn tool": the builder brief (spec/builder-brief.md) for a client that
// writes a tool itself, with the three calls (capabilities_pack, capabilities_check,
// capabilities_submit) where Hewn's builder has its workspace. One source: skills/build-a-hewn-tool/
// SKILL.md is skillText(the brief), checked in (a test fails when it's stale), and a Hewn serves the
// same at SKILL_URL and through hewn_docs. Hewn's builder reads the brief as BRIEF.md; they never differ.
import { ABI } from "./manifest.ts";

export const SKILL_NAME = "build-a-hewn-tool";
/** Where it is in the repo (in the npm package, under `dist/`), and its name as a hewn_docs page. */
export const SKILL_PATH = `skills/${SKILL_NAME}/SKILL.md`;
/** Where a Hewn serves it (public, like the design system). */
export const SKILL_URL = `/_platform/${SKILL_PATH}`;

const HEAD = `---
name: ${SKILL_NAME}
description: Build or change a tool (a capability) in the user's Hewn yourself, in a workspace of your own, then hand it to Hewn, which checks it and goes live or holds it for the owner. Use when the user asks you to write a Hewn tool instead of asking Hewn's builder. Needs Hewn's MCP tools capabilities_pack, capabilities_check and capabilities_submit.
---

# Build a Hewn tool

Hewn holds the user's tools: durable capabilities with their own state, typed operations and an optional screen. You can write one yourself and hand it to Hewn, which validates it exactly as it validates its own builder's work (the contracts, the tests, the migrations on a copy of the owner's data, the screen) and decides what goes live. You never promote anything.

1. **Fetch the pack:** \`capabilities_pack\` with \`kind: "create"\`, or \`kind: "modify"\` and the tool's \`capabilityId\`. The pack is what Hewn's builder finds in its workspace besides the request: the owner's other tools' contracts (\`CONTRACTS.md\`, and \`.hewn-contracts/<id>.md\` with each one in full), their looks (\`OTHER_TOOLS.md\`) and the design system (\`PLATFORM_UI.css\`); for a change, the tool's current files too. With a shell, download the pack (\`download.url\`) and unzip it into your workspace, the folder you write the tool in: \`curl -fsSL -o pack.zip '<download.url>'\`, then unzip it there. The link works once, for 10 minutes: fetch it once, yourself; if it answers 404, call \`capabilities_pack\` again for a new one. Without a shell, page the pack: \`files\` is a page, \`more\` lists the rest, and \`capabilities_pack\` with \`paths\` fetches them a page at a time. Read its reference files there and write only the tool's own files into your workspace. A paged pack leaves out \`.hewn-contracts/\`: \`capabilities_get\` has a tool's contract. A change's pack also has \`schedules\`, the owner's schedules on the tool, each \`{ operation, cadence, status }\` with \`operation\` as \`name@version\`: a schedule runs exactly that operation version, so keep each one in \`capability.json\`, whatever its \`status\` (Hewn's checks fail a version without one). For a contract the pack didn't carry, \`capabilities_get\`.
2. **Write the tool** by the contract below. What to build comes from the person you're talking to.
3. **Check it** with \`capabilities_check\` while you work, until it passes (the end of this file says how).
4. **Submit it** with \`capabilities_submit\`: the tool's own files only, a \`request\` saying what it is or what the change does, and for a change \`capabilityId\` and the pack's \`baseVersion\`. Not the pack's files, \`screenshots/\`, dotfiles or a builder's instructions (\`CLAUDE.md\` and the like): Hewn refuses them, naming the rule. Follow the build with \`builds_wait\`. Once it passes, a new tool waits for the owner's approval, and so does a change (status \`review\`): tell them. What a new tool needs from the owner, a host or a key, they approve in Hewn too.

`;

const SUBMIT =
  "When the tool is complete, check it with `capabilities_check` until it passes, then submit it with `capabilities_submit` (above). Hewn validates it again; if that fails, the build says why: fix it and submit again.";

const CHECK = `### Check your work: \`capabilities_check\`

Before you submit, call \`capabilities_check\` with the tool's files (and \`capabilityId\` for a change). It runs Hewn's pre-promotion checks (manifest, bundling, contracts, migrations on empty tables, \`tests/cases.json\`, \`sample/calls.json\`, widgets) and renders your UI headless, empty and with sample data, at 1280 and 390 px, light and dark. It answers PASS or FAIL with every failure, UI measurements (overflow past the phone edge, cut text, page errors, buttons that break the page) and four screenshots as images, the top of a long page. The text names a long page's further parts; \`screenshots: "all"\` sends them too, after the four, so ask for them when the page goes on below the screen. \`structuredContent.screenshots\` names the images sent, in order. With \`screenshots: false\` no images come back; the UI is still rendered and measured.

Fix failures and measured defects, then look at every screenshot and fix what looks broken, cramped, cut off or unreadable; check again until it passes. PASS can still come with visual defects. You have 30 checks an hour. Checks never promote: \`capabilities_submit\` validates exactly the files you send, and runs your migrations on a copy of the owner's data too. Don't save the screenshots into the tool: \`screenshots/\` is never part of one.
`;

/** What changes from the brief, each found exactly once (a brief edit that moves one fails the build of the Skill, and its test). */
const SWAPS: [string, string][] = [
  ["Write a **candidate** in this workspace; the platform owns validation and promotion.", "Write a **candidate** in your workspace; Hewn owns validation and promotion."],
  ["{{SUBMIT}} If you have a `check` tool, use it before you stop (see the end).", SUBMIT],
  ["Keep `id` equal to the capability id in `BUILDER.md`.", 'Keep `id` equal to the tool\'s id: for a change, the `capabilityId` you packed; for a new tool, its name in lowercase letters, digits and dashes ("Plant Care" → `plant-care`).'],
  ["after reading `BUILDER.md`, this brief, and any `OWNERS_WORDS.md` and `OTHER_TOOLS.md`,", "after reading this brief and the pack's `OTHER_TOOLS.md`,"],
  ["The owner's other capabilities are named at the end of `BUILDER.md`; `CONTRACTS.md` lists their operations,", "The owner's other capabilities are in the pack's `CONTRACTS.md`, which lists their operations,"],
  [" A widgets or Polish build's narrower scope in `BUILDER.md` wins.", ""],
  // Hewn's Home draws a build's icon while its builder works; nothing shows a client's work until it's handed in.
  ["your first implementation changes: Home shows them while you build.", "part of the tool from the start: the owner's review card and Home show them."],
];

/** The brief's own section on the builder's `check` tool, to its end: the Skill's says `capabilities_check`. */
const CHECK_SECTION = /### Check your work: the `check` tool\n[^]*?(?=\n#{1,3} |$)/;

/** SKILL.md, from the brief (spec/builder-brief.md). Throws when the brief no longer has what it swaps. */
export function skillText(brief: string): string {
  let text = brief;
  for (const [from, to] of SWAPS) {
    const n = text.split(from).length - 1;
    if (n !== 1) throw new Error(`the builder brief has ${n} of "${from.slice(0, 60)}…" (the Skill swaps exactly one): update SWAPS in packages/core/src/skill.ts`);
    text = text.replace(from, to);
  }
  if (!CHECK_SECTION.test(text)) throw new Error("the builder brief has no \"Check your work: the `check` tool\" section: update CHECK_SECTION in packages/core/src/skill.ts");
  text = text.replace(CHECK_SECTION, CHECK).replaceAll("{{ABI}}", ABI);
  return `${HEAD}${text.trimEnd()}\n`;
}
