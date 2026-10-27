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
export type SpecSource = "intake" | "intent" | "thin";

export interface Spec {
  name: string;
  purpose: string;
  requirements: string;
}

/** Today's instruction for the UI part of a draft (packages/cli/src/intake.ts), which `intent` replaces. */
export const SKETCH_INSTRUCTION = `If it gets a UI, end with a "UI sketch" (4–8 short lines): when the owner opens it and what they want from it; what's at the top (the one number, list or chart that answers that); the main action and its fields, with sensible defaults; what the screen shows on day one with no data; anything shown as a chart. Write it in the owner's words, not the API's.`;

export const INTENT_INSTRUCTION = `If it gets a UI, end with "UI intent" (4–8 short lines, no layout): who opens it and when, and the question it must answer at a glance; what in the data is worth drawing as a picture (what changes over time, what's due or late, what's compared with a goal); the main action and how quick it must be; the subject's world and the feeling it should have (a builder takes the tool's character and colours from it); anything the owner said about how it should look. Don't prescribe layout, sections, fields or components: the builder designs the screen.`;

/** The intake's prompt for a conversation, with today's UI instruction or the intent one. */
export function promptFor(messages: IntakeMessage[], source: "intake" | "intent"): string {
  const prompt = intakePrompt({ mode: "create", messages, catalog: [] }, { web: false });
  if (source === "intake") return prompt;
  if (!prompt.includes(SKETCH_INSTRUCTION)) throw new Error("the intake's UI sketch instruction changed: update bench/lib/intake.ts");
  return prompt.replace(SKETCH_INSTRUCTION, INTENT_INSTRUCTION);
}

/** What an agent might send capabilities_create: the owner's words and little else. */
export const thinSpec = (c: BenchCase): Spec => ({ name: c.name, purpose: c.purpose, requirements: `${c.ask}\n\nIt needs a screen for the owner. Choose the operations and the state that make it useful.` });

export async function specFor(c: BenchCase, source: SpecSource, dir: string, o: { model?: string; log?: (l: string) => void } = {}): Promise<Spec> {
  if (source === "thin") return thinSpec(c);
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
