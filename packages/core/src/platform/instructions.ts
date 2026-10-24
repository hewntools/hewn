// SPDX-License-Identifier: AGPL-3.0-or-later
// Instructions: the owner's standing rules for building, read by the intake and the builder.
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { Domain } from "./context.ts";

/** The owner's instructions for building: at most this many lines per scope, each this long. */
const MAX_INSTRUCTION_LINES = 50;
const MAX_INSTRUCTION_CHARS = 500;

/** Where an instruction applies: every tool the owner builds, or one tool. */
export type InstructionScope = "global" | "tool";
export interface Instruction {
  scope: InstructionScope;
  text: string;
}

/** Instructions as the owner gives them: lines, or a text to split into lines; trimmed, bullets dropped, no repeats. */
function cleanInstructions(lines: unknown): string[] {
  const raw = typeof lines === "string" ? lines.split("\n") : Array.isArray(lines) ? lines : undefined;
  if (!raw) throw new PlatformError("invalid_request", "instructions: a text, one rule per line");
  const out: string[] = [];
  for (const l of raw) {
    if (typeof l !== "string") throw new PlatformError("invalid_request", "instructions: each line must be text");
    const t = l.trim().replace(/^[-*•]\s+/, "");
    if (!t) continue;
    if (t.length > MAX_INSTRUCTION_CHARS) throw new PlatformError("invalid_request", `instructions: each line at most ${MAX_INSTRUCTION_CHARS} characters`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_INSTRUCTION_LINES) throw new PlatformError("invalid_request", `instructions: at most ${MAX_INSTRUCTION_LINES} lines`);
  return out;
}

/** What the intake asks to remember or drop, for one scope: well-formed entries only (the model wrote them: the rest is ignored, never an error). */
function instructionEntries(list: unknown, scope: InstructionScope): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const x of list) {
    if (!x || x.scope !== scope || typeof x.text !== "string") continue;
    const t = x.text.trim().replace(/^[-*•]\s+/, "");
    if (t && t.length <= MAX_INSTRUCTION_CHARS && !out.includes(t)) out.push(t);
  }
  return out;
}

export class Instructions extends Domain {
  private instructionsKey = (capabilityId?: string) => (capabilityId ? `instructions:${capabilityId}` : "instructions:global");

  private instructionLines(capabilityId?: string): string[] {
    return this.registry.getKv<string[]>(this.instructionsKey(capabilityId)) ?? [];
  }

  private mustCapabilityForInstructions(capabilityId: string) {
    const cap = this.registry.getCapability(capabilityId);
    if (!cap || cap.archivedAt) throw new PlatformError("not_found", `no capability ${capabilityId}`);
  }

  /** The owner's instructions, one per line: for every tool (no id), or for one tool. Owner only. */
  instructions(owner: Agent, capabilityId?: string): string[] {
    requireOwner(owner);
    if (capabilityId) this.mustCapabilityForInstructions(capabilityId);
    return this.instructionLines(capabilityId);
  }

  /** Replace the owner's instructions for a scope with the list as edited (a text, one per line, or lines). */
  setInstructions(owner: Agent, capabilityId: string | undefined, lines: unknown): string[] {
    requireOwner(owner);
    if (capabilityId) this.mustCapabilityForInstructions(capabilityId);
    const list = cleanInstructions(lines);
    this.registry.setKv(this.instructionsKey(capabilityId), list);
    this.logger(`instructions for ${capabilityId ?? "every tool"}: ${list.length} line(s), set by ${owner.id}`);
    return list;
  }

  /**
   * What the intake remembered or dropped in one turn, applied: a remembered rule goes at the end of
   * its scope (never twice, never past the limit); a dropped one must match a line. Creating, there is
   * no tool yet, so only rules for every tool are kept. Returns what changed, for the owner to see and undo.
   */
  applyIntakeMemory(owner: Agent, capabilityId: string | undefined, remember: unknown, forget: unknown): { remember: Instruction[]; forget: Instruction[] } {
    requireOwner(owner);
    if (capabilityId) this.mustCapabilityForInstructions(capabilityId);
    const out: { remember: Instruction[]; forget: Instruction[] } = { remember: [], forget: [] };
    for (const scope of ["global", "tool"] as const) {
      const id = scope === "tool" ? capabilityId : undefined;
      if (scope === "tool" && !id) continue;
      const add = instructionEntries(remember, scope);
      const drop = instructionEntries(forget, scope);
      if (!add.length && !drop.length) continue;
      let list = this.instructionLines(id);
      const dropped: string[] = [];
      const added: string[] = [];
      for (const t of drop) {
        if (!list.includes(t)) continue;
        list = list.filter((x) => x !== t);
        dropped.push(t);
      }
      for (const t of add) {
        if (list.includes(t) || list.length >= MAX_INSTRUCTION_LINES) continue;
        list.push(t);
        added.push(t);
      }
      if (!added.length && !dropped.length) continue;
      out.forget.push(...dropped.map((text) => ({ scope, text })));
      out.remember.push(...added.map((text) => ({ scope, text })));
      this.registry.setKv(this.instructionsKey(id), list);
      this.logger(`instructions for ${id ?? "every tool"}: the intake remembered ${added.length}, dropped ${dropped.length}`);
    }
    return out;
  }

  /** The "Owner's instructions" section of BUILDER.md: the rules for every tool, then this tool's. Empty when there are none. */
  instructionsForBuild(capabilityId: string): string {
    const global = this.instructionLines();
    const tool = this.instructionLines(capabilityId);
    if (!global.length && !tool.length) return "";
    const bullets = (l: string[]) => l.map((x) => `- ${x}`).join("\n");
    return `## Owner's instructions\n\nThe owner's standing rules for how their tools are built. Follow them wherever they apply; the contract below still holds.\n${global.length ? `\nFor every tool:\n${bullets(global)}\n` : ""}${tool.length ? `\nFor this tool:\n${bullets(tool)}\n` : ""}`;
  }
}
