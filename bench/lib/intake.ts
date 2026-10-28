// SPDX-License-Identifier: AGPL-3.0-or-later
// Specs the way they reach a builder: from the owner's short request through Hewn's intake (as it is, or
// a variant of its prompt), or as the thin requirements an agent might send. The owner's side of the
// conversation accepts the intake's defaults, as owners mostly do.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { intakePrompt, parseIntake } from "@hewntools/cli/intake.ts";
import type { IntakeMessage } from "@hewntools/host-workerd/surface/intake-types.ts";
import type { BenchCase } from "./cases.ts";
import { ask } from "./judge.ts";

/** Where a spec comes from: today's intake, the intake asked for UI intent instead of a sketch, or an agent's thin requirements. */
export type SpecSource = "intake" | "intent" | "thin" | "lean";

export interface Spec {
  name: string;
  purpose: string;
  requirements: string;
  /** The conversation it came from (the owner's turns and the intake's), for the builder to read too. */
  conversation?: IntakeMessage[];
}

/** 0.4.9's instruction for a create draft's requirements, which the intent variant puts back. */
export const SPEC_INSTRUCTION = `"requirements": a builder-ready spec with operations (names, inputs, outputs, side effects), what state to keep, secrets/hosts if any, and what tests should cover.`;

/** The intake's instruction for a create draft's requirements since 0.4.10 (packages/cli/src/intake.ts). */
export const LEAN_INSTRUCTION = `"requirements": a lean brief for the builder, not a spec. Plain short sentences under these headings and nothing else: FOR (who opens it, when, and the question it answers), KEEPS (the things it keeps and what matters about each, no schemas or field types), DECIDED (what the owner decided or accepted in this conversation: defaults, scope, what is out of the first version), PLATFORM (existing tools to call instead of duplicating, connections, secrets, hosts, schedules, the model tier; or "nothing external"), UI INTENT (what must be visible at a glance, what's worth drawing as a picture, how quick the main action must be, the feel and the subject's world; no layout). No operation names, inputs, outputs, test lists or screen layout: the builder designs those, and it reads the owner's own words in this conversation too.`;

/** 0.4.9's instruction for the UI part of a draft, after its spec (the lean brief has UI INTENT instead). */
export const SKETCH_INSTRUCTION = `If it gets a UI, end with a "UI sketch" (4–8 short lines): when the owner opens it and what they want from it; what's at the top (the one number, list or chart that answers that); the main action and its fields, with sensible defaults; what the screen shows on day one with no data; anything shown as a chart. Write it in the owner's words, not the API's.`;

export const INTENT_INSTRUCTION = `If it gets a UI, end with "UI intent" (4–8 short lines, no layout): who opens it and when, and the question it must answer at a glance; what in the data is worth drawing as a picture (what changes over time, what's due or late, what's compared with a goal); the main action and how quick it must be; the subject's world and the feeling it should have (a builder takes the tool's character and colours from it); anything the owner said about how it should look. Don't prescribe layout, sections, fields or components: the builder designs the screen.`;

/** The intake's prompt for a conversation: today's (the lean brief; "lean" is the same), or 0.4.9's spec with UI intent. */
export function promptFor(messages: IntakeMessage[], source: "intake" | "intent" | "lean"): string {
  const prompt = intakePrompt({ mode: "create", messages, catalog: [] }, { web: false });
  if (!prompt.includes(LEAN_INSTRUCTION)) throw new Error("the intake's requirements instruction changed: update bench/lib/intake.ts");
  if (source !== "intent") return prompt;
  return prompt.replace(LEAN_INSTRUCTION, `${SPEC_INSTRUCTION} ${INTENT_INSTRUCTION}`);
}

/** The conversation as the builder reads it: the owner's words, and what the intake said in between. */
export function ownersWords(conversation: IntakeMessage[] | undefined): string {
  if (!conversation?.length) return "";
  const turns = conversation.map((m) => `${m.role === "user" ? "OWNER" : "INTAKE"}: ${m.content.trim()}`).join("\n\n");
  return `\n\nTHE OWNER'S OWN WORDS (their conversation with the intake, oldest first). The brief above is the plan; where it is silent, vague, or differs from what the owner said, follow the owner's words, and their latest word where they changed their mind. Take their details and taste seriously.\n\n${turns}`;
}

/** What an agent might send capabilities_create: the owner's words and little else. */
export const thinSpec = (c: BenchCase): Spec => ({ name: c.name, purpose: c.purpose, requirements: `${c.ask}\n\nIt needs a screen for the owner. Choose the operations and the state that make it useful.` });

export async function specFor(c: BenchCase, source: SpecSource, dir: string, o: { model?: string; log?: (l: string) => void } = {}): Promise<Spec> {
  if (source === "thin") return thinSpec(c);
  if (source === "lean") return conversed(c, dir, o);
  const messages: IntakeMessage[] = [{ role: "user", content: c.ask }];
  const work = join(dir, "intake");
  mkdirSync(work, { recursive: true });
  for (let turn = 1; turn <= 4; turn++) {
    const raw = await ask(work, promptFor(messages, source), o.model, []);
    const reply = parseIntake(raw, "create");
    writeFileSync(join(dir, "intake.json"), JSON.stringify({ source, messages, last: reply }, null, 2));
    o.log?.(`intake turn ${turn}: ${reply.kind}`);
    if (reply.kind === "draft" && "name" in reply.draft) return { name: reply.draft.name, purpose: reply.draft.purpose, requirements: reply.draft.requirements };
    if (reply.kind === "ideas" && reply.ideas.length) return { name: reply.ideas[0].name, purpose: reply.ideas[0].purpose, requirements: reply.ideas[0].requirements };
    const said = reply.kind === "questions" ? [reply.message, ...reply.questions].filter(Boolean).join("\n") : reply.message;
    messages.push({ role: "intake", content: said });
    messages.push({ role: "user", content: reply.kind === "questions" ? "Ok, your defaults are all fine. Go ahead and draft it." : "Please just draft this one tool." });
  }
  throw new Error("the intake didn't draft within 4 turns (see intake.json)");
}

/**
 * The owner's scripted side of a conversation (the ask, then their further turns, then "draft it"),
 * with the lean intake answering live. Each owner turn goes in whatever the intake said; the draft
 * after the last one is the spec, and the whole conversation goes to the builder with it.
 */
async function conversed(c: BenchCase, dir: string, o: { model?: string; log?: (l: string) => void }): Promise<Spec> {
  const script = [c.ask, ...(c.talk ?? []), "Looks good, go ahead and draft it."];
  const messages: IntakeMessage[] = [];
  const work = join(dir, "intake");
  mkdirSync(work, { recursive: true });
  for (let turn = 0; turn < script.length + 2; turn++) {
    messages.push({ role: "user", content: turn < script.length ? script[turn] : "Ok, your defaults are all fine. Draft it now." });
    const reply = parseIntake(await ask(work, promptFor(messages, "lean"), o.model, []), "create");
    writeFileSync(join(dir, "intake.json"), JSON.stringify({ source: "lean", messages, last: reply }, null, 2));
    o.log?.(`intake turn ${turn + 1}: ${reply.kind}`);
    const draft = reply.kind === "draft" && "name" in reply.draft ? reply.draft : reply.kind === "ideas" ? reply.ideas[0] : undefined;
    const said = reply.kind === "questions" ? [reply.message, ...reply.questions].filter(Boolean).join("\n") : draft ? [reply.message, `DRAFT: ${draft.name}. ${draft.purpose}`].filter(Boolean).join("\n") : reply.message;
    messages.push({ role: "intake", content: said });
    if (draft && turn >= script.length - 1) return { name: draft.name, purpose: draft.purpose, requirements: draft.requirements, conversation: messages };
  }
  throw new Error("the intake didn't draft (see intake.json)");
}
