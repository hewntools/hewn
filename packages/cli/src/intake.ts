// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { claudeHome, claudeModelArgs, codexHome, codexModelArgs, modelUnavailableText, OPENCODE_INTAKE_RULES, OPENCODE_QUIET_START_MS, opencodeHasModel, opencodeHome, opencodeModelArgs, opencodeModelRejected } from "./builders/cli.ts";
import { MODEL_REJECTED, modelRejectReason, noteModelFailure, noteModelRan } from "./builders/models.ts";
import { wrapBuilder } from "./builders/sandbox.ts";
import { EFFORT, MODEL_NAME } from "@hewntools/core/build-models.ts";
import type { CapabilityManifest } from "@hewntools/core/manifest.ts";
import type { JobModel } from "@hewntools/host-workerd/surface/host.ts";

/**
 * Intake: a replaceable platform role (like the builder) that turns a non-agent client's rough
 * intent into a structured create/modify request. MCP agents skip it; they structure requests
 * themselves. It runs headless, sandboxed, with no tools that matter and no MCP.
 */

export type { ConnectionStep, CreateDraft, DraftSpec, ScheduleSuggestion, Intake, IntakeAttachment, IntakeInstruction, IntakeMemory, IntakeMessage, IntakeProgress, IntakeReply, IntakeRequest, WidgetProposal } from "@hewntools/host-workerd/surface/intake-types.ts";
import type { ConnectionStep, CreateDraft, DraftSpec, Intake, IntakeAttachment, IntakeInstruction, IntakeMemory, IntakeProgress, IntakeReply, IntakeRequest, ScheduleSuggestion, WidgetProposal } from "@hewntools/host-workerd/surface/intake-types.ts";
import { MAX_IDEAS } from "@hewntools/host-workerd/surface/intake-types.ts";

/**
 * The "message" and "questions" of a reply that is still being written: a tolerant reading of
 * incomplete JSON, so the owner can watch the answer arrive.
 */
export function partialReply(text: string): Pick<IntakeProgress, "message" | "questions"> {
  const ESC: Record<string, string> = { n: "\n", t: "\t", r: "", '"': '"', "\\": "\\", "/": "/", b: "", f: "" };
  /** Read a JSON string starting just after its opening quote: [value, index of closing quote or null]. */
  const str = (i: number): [string, number | null] => {
    let v = "";
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "\\") {
        const n = text[i + 1];
        if (n === undefined) break;
        if (n === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4) break;
          v += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          v += ESC[n] ?? n;
          i++;
        }
        continue;
      }
      if (c === '"') return [v, i];
      v += c;
    }
    return [v, null];
  };
  const out: Pick<IntakeProgress, "message" | "questions"> = {};
  const m = /"message"\s*:\s*"/.exec(text);
  if (m) out.message = str(m.index + m[0].length)[0];
  const q = /"questions"\s*:\s*\[/.exec(text);
  if (q) {
    const qs: string[] = [];
    let i = q.index + q[0].length;
    for (;;) {
      const skip = text.slice(i).search(/\S/);
      if (skip < 0) break;
      i += skip;
      if (text[i] === ",") i++;
      else if (text[i] === '"') {
        const [v, end] = str(i + 1);
        qs.push(v);
        if (end === null) break;
        i = end + 1;
      } else break;
    }
    out.questions = qs;
  }
  return out;
}

const TEMPLATES = ["stat", "list", "chart", "progress", "text"] as const;
const SIZES = ["small", "medium", "large"] as const;

const PROPOSALS = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["title", "shows", "template", "sizes", "replaces"],
    properties: {
      title: { type: "string" },
      replaces: { type: "string" },
      shows: { type: "string" },
      template: { type: "string", enum: [...TEMPLATES] },
      sizes: { type: "array", items: { type: "string", enum: [...SIZES] } },
    },
  },
};

const OPERATIONS = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "sideEffect"],
    properties: { name: { type: "string" }, sideEffect: { type: "string", enum: ["read", "write", "destructive"] } },
  },
};
const MODEL = { type: "string", enum: ["none", "light", "standard", "strong", "max"] };
const NAMES = { type: "array", items: { type: "string" } };
const CONNECTION = {
  type: "object",
  additionalProperties: false,
  required: ["action", "capabilityId", "name", "purpose", "requirements", "request"],
  properties: {
    action: { type: "string", enum: ["none", "create", "modify"] },
    capabilityId: { type: "string" },
    name: { type: "string" },
    purpose: { type: "string" },
    requirements: { type: "string" },
    request: { type: "string" },
  },
};

const SCHEDULES = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "cadence", "why"],
    properties: { operation: { type: "string" }, cadence: { type: "string" }, why: { type: "string" } },
  },
};

/** Several new capabilities at once: each a create draft of its own. */
const IDEAS = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "purpose", "requirements", "operations", "widgets", "model", "uses", "hosts", "secrets", "connection", "schedules"],
    properties: { name: { type: "string" }, purpose: { type: "string" }, requirements: { type: "string" }, operations: OPERATIONS, widgets: NAMES, model: MODEL, uses: NAMES, hosts: NAMES, secrets: NAMES, connection: CONNECTION, schedules: SCHEDULES },
  },
};

/** Standing rules to remember or drop for the owner (see "Remember standing rules" in the prompt). */
const MEMORY = {
  type: "array",
  items: { type: "object", additionalProperties: false, required: ["scope", "text"], properties: { scope: { type: "string", enum: ["global", "tool"] }, text: { type: "string" } } },
};

/** One reply shape for both modes ("widgets" and "schedules" only when modifying, "ideas" only when creating). */
export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "message", "questions", "name", "purpose", "requirements", "request", "operations", "widgets", "model", "uses", "hosts", "secrets", "connection", "proposals", "ideas", "schedules", "remember", "forget"],
  properties: {
    kind: { type: "string", enum: ["questions", "draft", "widgets", "ideas", "schedules"] },
    message: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    name: { type: "string" },
    purpose: { type: "string" },
    requirements: { type: "string" },
    request: { type: "string" },
    operations: OPERATIONS,
    widgets: NAMES,
    model: MODEL,
    uses: NAMES,
    hosts: NAMES,
    secrets: NAMES,
    connection: CONNECTION,
    proposals: PROPOSALS,
    ideas: IDEAS,
    schedules: SCHEDULES,
    remember: MEMORY,
    forget: MEMORY,
  },
};

/** What the intake needs to know about widgets, in either mode. */
const WIDGETS_GUIDE = `- Widgets: cards on Hewn's Home (and in agent chats), drawn by the platform from a view model a read operation returns. Templates: stat (one number with a caption), list (up to 5 rows: title, detail, value), chart (bar or line, up to 31 labels, 3 series), progress (value of max), text (up to 280 characters). Sizes: small (one number), medium (a number with context, 3 rows, a short chart), large (5 rows, a taller chart); its operation may return a view per size in one output, so large should use its room. Offer only the sizes its content fits: one size is fine (a word with its definition and buttons is large only); a size whose content gets cut off fails the build. Drawing one is read-only and offline: it shows what the capability already stores (no network, no model, no writes while drawing). It can still act: up to 3 buttons, each running one of the capability's own operations, writes included (grade a word, check off a habit), after which it redraws; and "reveal" text hidden behind "Show" (the answer on a practice card). Fresh outside data needs an operation that fetches and stores it (a host), run by a button on the widget or on a schedule the owner sets in Hewn.`;

/**
 * The capability being changed, for the intake: every operation with its input, without output
 * schemas, UI or tests (a cut-off manifest hides operations, and the intake then says they're missing).
 */
export function intakeManifest(m: CapabilityManifest): string {
  const { id, name, purpose, description, kind, config, requires, widgets } = m;
  const operations = m.operations.map((o) => ({ op: `${o.name}@${o.version}`, sideEffect: o.sideEffect, description: o.description, input: o.inputSchema, ...(o.deprecated ? { deprecated: o.deprecated } : {}) }));
  const brief = JSON.stringify({ id, name, purpose, description, kind, config, requires, operations, widgets });
  return brief.length <= 30_000 ? brief : JSON.stringify({ id, name, purpose, kind, requires, operations: operations.map(({ op, sideEffect, description }) => ({ op, sideEffect, description })), widgets });
}

/** How much of an earlier conversation the intake gets to continue from: the last turns, each cut short. */
const EARLIER_TURNS = 30;
const EARLIER_CHARS = 4000;

/** The images attached across the conversation (with their bytes), newest last, for the intake to look at. */
export const intakeImages = (req: IntakeRequest): IntakeAttachment[] => req.messages.flatMap((m) => (m.attachments ?? []).filter((a) => a.kind === "image" && !!a.data)).slice(-10);

/** How much of an attached text file goes into the prompt. */
const FILE_CHARS = 100_000;

/**
 * One turn as the prompt shows it. What the owner attached is listed under the message; a text
 * file's content follows (images are given to the model apart from the text).
 */
function turnText(m: { role: string; content: string; attachments?: IntakeAttachment[] }, max = Infinity): string {
  const head = `${m.role === "user" ? "USER" : "YOU (intake)"}: ${m.content.length > max ? `${m.content.slice(0, max)}…` : m.content}`;
  const atts = m.attachments ?? [];
  if (!atts.length) return head;
  const list = atts.map((a) => `${a.name} (${a.kind === "image" ? `image${a.width && a.height ? ` ${a.width}×${a.height}` : ""}` : "file"})`).join(", ");
  const files = atts
    .filter((a) => a.kind === "file" && a.data)
    .map((a) => {
      const text = Buffer.from(a.data!, "base64").toString("utf8");
      return `--- attached file ${a.name} ---\n${text.length > FILE_CHARS ? `${text.slice(0, FILE_CHARS)}\n… (cut at ${FILE_CHARS} characters)` : text}\n--- end of ${a.name} ---`;
    })
    .join("\n");
  return `${head}\n[attached: ${list}]${files ? `\n${files}` : ""}`;
}

export function intakePrompt(req: IntakeRequest, opts: { web?: boolean } = {}): string {
  const convo = req.messages.map((m) => turnText(m)).join("\n\n");
  const earlier = req.earlier?.messages?.length
    ? `An earlier conversation, which led to ${req.earlier.version ? `version ${req.earlier.version} of this capability` : "an earlier build"} (context only: the conversation below comes after it and may change what was agreed then):\n${req.earlier.messages.slice(-EARLIER_TURNS).map((m) => turnText(m, EARLIER_CHARS)).join("\n\n")}\n\n`
    : "";
  const focus = req.widget ? req.current?.widgets?.find((w) => w.name === req.widget) : undefined;
  const rules = req.instructions;
  const bullets = (l: string[]) => l.map((x) => `- ${x}`).join("\n");
  const instructions =
    rules && (rules.global.length || rules.tool?.length)
      ? `\nThe owner's standing rules for building (follow them, build on them, don't repeat them back; they're listed so you don't remember one twice):\n${rules.global.length ? `For every tool:\n${bullets(rules.global)}\n` : ""}${rules.tool?.length ? `For this tool:\n${bullets(rules.tool)}\n` : ""}`
      : "";
  return `You are the intake for Hewn, a personal capability platform. A human (the owner) describes something they want. Turn it into a precise ${req.mode === "create" ? "capability creation" : "modification"} request for a separate builder agent, who will implement it without asking anything.

How capabilities work (constraints the request must respect):
- A capability is a durable unit with typed operations (name@version, JSON Schema input/output, side effect read|write|destructive) and private SQLite state. Agents and UIs call operations; nobody touches state directly.
- Runtimes: node (default, preferred) or python (only when a needed library exists only there). Code runs sandboxed.
- Network: only to hosts the capability declares. Public, keyless APIs are just a host.
- A model: Hewn runs a language model for any capability that declares one ("requires.model" with a tier: light, standard, strong or max). Use it for what only a model can do: generate, brainstorm, rewrite, summarise, classify, explain, read an image. The owner's provider, keys and budget live in Hewn, set up once for every capability: never a connection or an API key for this, and never "capabilities can't run a model". A back-and-forth (the model asks follow-up questions, then suggests) is operations that keep the conversation in state and send it to the model each turn, with a UI to talk in. Pick the lowest tier that does the job (strong for creative or careful work). Tests use fake model replies; widgets never call it.
- Only connections hold credentials. A service that needs a key, token or login (GitHub, Spotify, a self-hosted server…) is wrapped by a connection: a capability of kind "connection" with generic API operations only (no use-case logic), a health operation, and the credentials (declared by name; the owner enters values out of band or signs in inside Hewn). Other capabilities call the connection's operations. Never ask the owner for secret values.
- If the idea needs such a service: use the existing connection (marked [connection] below) if there is one; if it lacks an operation the idea needs, fill "connection" with action "modify" (its capabilityId, and a "request" adding generic operations); if there is none, fill "connection" with action "create" (name e.g. "GitHub", purpose, and builder-ready "requirements": the generic operations, secrets/config, hosts, health). The capability you draft then calls it ("uses"). Otherwise action "none".
- A UI: one sandboxed screen, calling the capability's own operations, built from Hewn's design system. Include one when the owner will look at or enter data themselves (trackers, lists, logs, dashboards, reviews); leave it out for plumbing only agents or other capabilities call.
- A first version does a few things well: the smallest set of operations that makes the idea useful. Name what's left for later.
- Validation runs offline with fake data: network-dependent parts must be testable through pure functions.
- Prefer extending an existing capability over creating an overlapping one.
- Capabilities can call each other's operations (pinned name@version, owner-authorized). When the idea builds on data another capability already owns (runs, books, activities…), compose: say which operations to call instead of duplicating that data.
${WIDGETS_GUIDE}
- Schedules: Hewn can run a read or write operation that needs no input on a timetable, in the owner's timezone: "hourly", "daily 07:00", "weekly mon 07:00", or 5-field cron (at most every 5 minutes); one schedule per time of day. When something has to run on its own to be useful (fetching outside data a widget or screen shows, a morning digest, a nightly sync), suggest it yourself in "schedules" (operation name without version, cadence, and "why" in a few words for the owner) rather than telling the owner to set one up; the owner approves it on the card. The same when the owner asks you to set one up. In a draft, schedules name operations the capability has once built.

The owner's existing capabilities:
${(req.catalog ?? []).map((c) => `- ${c.name} (${c.id})${c.kind === "connection" ? " [connection]" : ""}: ${c.purpose} [${c.operations.join(", ")}]`).join("\n") || "(none)"}
${instructions}${req.current ? `\nThe capability being modified (its operations, without output schemas):\n${intakeManifest(req.current)}\n` : ""}${focus ? `\nThe owner opened this from its widget "${focus.title}" (name ${focus.name}, operation ${focus.operation}, sizes ${focus.sizes.join("/")}): their messages are about that widget unless they say otherwise. A change to how it looks or what it shows is a widgets build that replaces it: one proposal with "replaces": "${focus.name}". If the change needs the capability itself changed, draft that instead, saying in the request that it changes widget ${focus.name}.\n` : ""}
${earlier}Conversation so far:
${convo}

Decide:
- When you talk to the owner ("message", "questions"), call capabilities "tools": that is the owner's word for them (capability is Hewn's technical term). The builder-facing fields keep "capability".
- Write for a chat: short and clear. Say only what the owner needs to know or decide; never restate their request, and never list what the tool won't need (no network, no model, no key…). Put a blank line between paragraphs; when there are several things, a list (one per line, starting with "- ") instead of a long sentence. "message" is at most three short paragraphs: the proposal card carries the details. Each question is one line with its default in it.
- Engage with what the owner actually said in their latest message. If they point you at something (a service, API, link), address it explicitly in "message".
- Attachments: the owner may attach screenshots and files ("[attached: …]" under a message; a text file's content follows it; images are shown to you). A screenshot shows the screen or the look they mean, a sketch what they want; a file is reference material (a script to port, data to import, notes). Read them as part of the request: say in "message" what you took from them, and carry what matters into the requirements or the request in words (the builder gets copies of the attachments in its workspace, listed in the request, so name them when it should look at one).
- Remember standing rules. When the owner states a preference or a rule meant to hold beyond this request ("always Swedish copy", "never delete buttons", "keep this one to a single screen"), put it in "remember": scope "global" for every tool they build, "tool" for this one only${req.mode === "create" ? ' (creating, there is no tool yet: a rule for this tool goes into the requirements instead, and "remember" takes global ones only)' : ""}. One short rule each, in the owner's terms (not their sentence verbatim); never a rule they didn't state, never a secret, never a one-off detail of this request, never one already listed above. When they withdraw or contradict a listed rule, put its exact text in "forget". The owner sees what was saved and can undo it. Otherwise leave both empty.
${opts.web ? "- You can look things up (WebFetch/WebSearch) to check services or APIs the owner mentions: whether they exist, are maintained, legitimate, and what they offer. Only fetch what's needed." : "- You cannot open links or browse. If the owner sends one, say so in \"message\" and work from what you know."}
- Never design around piracy, credential sharing, or scraping that violates a service's terms. If a suggested source looks like that, say so plainly in "message" and propose a legitimate alternative.
- The conversation may hold your earlier draft or ideas (after "DRAFT" or "IDEAS"). If the owner keeps talking after one, revise it: change what they asked for and keep everything else as it was (names, operations, details, schedules), unless they ask for something new.
- Ask until it's clear; then draft. ${req.mode === "create" ? `Before a draft you must be able to say, from the conversation: the moment (when the owner opens or uses it, and the first thing they want to see or do there), what it keeps (the things and their fields), the main action, and what's out of scope. On the first turn, draft only when the request already says those; a one-line idea usually doesn't.` : `Before a draft you must be able to say what exactly changes and where (which screen, widget or operation) and how it should behave afterwards. A specific ask ("show pace per km in the table", "the bedtime column is always empty") is clear: draft. A vague one ("improve the UX", "make it nicer") isn't: ask what bothers them or what they want to do more easily, with your best guesses as the defaults.`} When it isn't clear, reply kind "questions": at most 3 short, concrete questions, each carrying the default you'd assume ("I'd assume one entry per day; right?"), and the last one ending with "Just say ok if that looks good.", so one word answers them all (an "ok" means every default). Once the owner has answered, draft, unless the answer raised something that would change what gets built. Never ask what's already answered, what their standing rules say, or what the earlier conversation above settled. When the owner says to draft now (or to just build it), draft at once with sensible assumptions, listed in "message".
${req.mode === "modify" ? `- If all the owner needs is to run operations the capability already has on a timetable (nothing to change or add), reply kind "schedules" with just "schedules": nothing gets built.
- If the owner wants widgets that the capability can already feed, reply kind "widgets" with "proposals": a quick widgets-only build. That build writes each widget's own read operation (widget_<name>, computing the view from the data already stored), so a missing read operation is not a reason to change the capability; it can't change existing operations, state, hosts or config, or add writes, so its buttons only call operations the capability already has. If they said what they want, propose exactly that one widget (or the few they named); offer 2–4 alternatives only when they ask for suggestions or leave it open. Never refuse a widget: if it needs something the capability lacks (data it doesn't store, a fetch, a write operation for a button), reply kind "draft" instead, a change to the capability that includes the widget, and say in "message" what must change in the capability first and why.
` : `- If the owner asks for suggestions or ideas, wants several tools at once, or asks to build several of the ones you suggested, reply kind "ideas" with 2–${MAX_IDEAS} "ideas" (exactly the ones they named, if they named them): separate new capabilities the owner ticks to build. Each idea is a complete draft with the same fields and rules as a draft below (name, purpose, requirements, operations, widgets, model, uses, hosts, secrets, connection, schedules). An idea may call the owner's existing capabilities, or build on another idea: then put that idea's id (its name in lowercase, every run of other characters than a-z and 0-9 replaced by "-") in "uses" and name the operations it calls in "requirements"; Hewn builds that one first. Never a cycle. Ideas that don't build on each other are built at the same time. If several ideas need the same new connection, give each the identical connection (same name); it is built once. Suggest what fits the owner and doesn't duplicate what they already have. Leave the top-level draft fields empty.
`}- Otherwise reply kind "draft".${req.mode === "create" ? ` Fill "name" (short human name; its slug becomes the stable id), "purpose" (one or two sentences, why it exists), and "requirements": a builder-ready spec with operations (names, inputs, outputs, side effects), what state to keep, secrets/hosts if any, and what tests should cover. If it gets a UI, end with a "UI sketch" (4–8 short lines): when the owner opens it and what they want from it; what's at the top (the one number, list or chart that answers that); the main action and its fields, with sensible defaults; what the screen shows on day one with no data; anything shown as a chart. Write it in the owner's words, not the API's. Leave "request" empty.` : ` Fill "request": a builder-ready description of the change (operations added/changed and how, state changes, widgets added or changed with their template, sizes, per-size views and buttons; compatibility: existing operation contracts must stay backward compatible). Leave name/purpose/requirements empty.`} Include widgets in a draft when the owner asks for them.
If the owner's idea overlaps an existing capability, say so in a question (or, in a modify draft, build on it).

Reply with ONLY a JSON object matching this schema, no prose, no code fences:
${JSON.stringify(SCHEMA)}
"message": optional short text shown to the owner before your questions or draft (findings, caveats, assumptions); empty if nothing to add.
In a draft, also summarise it for the owner: "operations" (each operation the capability will have${req.mode === "modify" ? " that this change adds or changes" : ""}, snake_case name + sideEffect), "widgets" (titles of the widgets it adds or changes), "model" (the tier if it uses a model, else "none"), "uses" (ids of the owner's capabilities it will call), "hosts" and "secrets" (names) it will need. These must match the spec.${req.mode === "create" ? " In kind \"ideas\", each idea carries these the same way." : ""}
In kind "widgets", each proposal: "title" (2–4 words), "shows" (one or two short sentences in the owner's words: what it shows, per size if they differ, what its buttons do), "template" (the main one), "sizes", "replaces" (the name of the existing widget it replaces, or empty for a new one); revise earlier proposals if the owner asked for changes, and leave the draft fields empty.${req.current?.widgets?.length ? ` It already has widgets: ${req.current.widgets.map((w) => `${w.name} ("${w.title}", ${w.sizes.join("/")})`).join(", ")}; don't propose those again (an improvement to one is fine; say so).` : ""}
Unused fields: empty string / empty array; "connection" with action "none" and empty strings when no connection must be built or changed first.`;
}

export function parseIntake(raw: string, mode: IntakeRequest["mode"], current?: CapabilityManifest): IntakeReply {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`intake returned no JSON: ${text.slice(0, 200)}`);
  const j = JSON.parse(text.slice(start, end + 1));
  return { ...replyOf(j, mode, current), ...memoryOf(j) };
}

/** What the reply asks to remember or drop: well-formed entries only (the platform checks again as it saves). */
function memoryOf(j: Record<string, unknown>): IntakeMemory {
  const list = (v: unknown): IntakeInstruction[] => (Array.isArray(v) ? v.filter((x) => x && (x.scope === "global" || x.scope === "tool") && typeof x.text === "string" && x.text.trim()).map((x) => ({ scope: x.scope, text: String(x.text).trim() })) : []);
  const remember = list(j.remember);
  const forget = list(j.forget);
  return { ...(remember.length ? { remember } : {}), ...(forget.length ? { forget } : {}) };
}

function replyOf(j: any, mode: IntakeRequest["mode"], current?: CapabilityManifest): IntakeReply {
  const message = typeof j.message === "string" ? j.message : "";
  if (mode === "modify" && j.kind === "widgets") return { kind: "widgets", message, proposals: proposals(j.proposals, current) };
  if (mode === "modify" && j.kind === "schedules") {
    // Only what it already has: anything else needs a build (a draft).
    const has = new Set((current?.operations ?? []).map((o) => o.name));
    const list = schedules(j.schedules).filter((x) => !current || has.has(x.operation));
    if (!list.length) throw new Error("intake schedules name no operation the capability has");
    return { kind: "schedules", message, schedules: list };
  }
  if (j.kind === "questions" && Array.isArray(j.questions) && j.questions.length) {
    return { kind: "questions", message, questions: j.questions.slice(0, 3).map(String) };
  }
  if (mode === "create" && j.kind === "ideas") {
    const ideas = (Array.isArray(j.ideas) ? j.ideas : []).map(createDraft).filter((d: CreateDraft | undefined): d is CreateDraft => !!d).slice(0, MAX_IDEAS);
    if (!ideas.length) throw new Error("intake ideas missing name/purpose/requirements");
    return { kind: "ideas", message, ideas };
  }
  if (mode === "modify") {
    if (!j.request) throw new Error("intake draft missing 'request'");
    return { kind: "draft", message, draft: { request: String(j.request), ...extras(j) } };
  }
  const draft = createDraft(j);
  if (!draft) throw new Error("intake draft missing name/purpose/requirements");
  return { kind: "draft", message, draft };
}

/** The spec card summary, the connection step and suggested schedules, when the draft has them. */
function extras(j: Record<string, unknown>) {
  const spec = draftSpec(j);
  const connection = connectionStep(j.connection);
  const sched = schedules(j.schedules);
  return { ...(spec ? { spec } : {}), ...(connection ? { connection } : {}), ...(sched.length ? { schedules: sched } : {}) };
}

function schedules(list: unknown): ScheduleSuggestion[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.operation === "string" && x.operation.trim() && typeof x.cadence === "string" && x.cadence.trim())
    .slice(0, 5)
    .map((x) => ({ operation: x.operation.trim().split("@")[0], cadence: x.cadence.trim(), why: typeof x.why === "string" ? x.why.trim().slice(0, 200) : "" }));
}

function createDraft(j: any): CreateDraft | undefined {
  if (!j?.name || !j.purpose || !j.requirements) return undefined;
  return { name: String(j.name), purpose: String(j.purpose), requirements: String(j.requirements), ...extras(j) };
}

function proposals(list: unknown, current?: CapabilityManifest): WidgetProposal[] {
  const existing = new Set((current?.widgets ?? []).map((w) => w.name));
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.title === "string" && p.title.trim() && typeof p.shows === "string" && (TEMPLATES as readonly string[]).includes(p.template))
    .slice(0, 4)
    .map((p) => {
      const sizes = (Array.isArray(p.sizes) ? p.sizes : []).filter((s: unknown, i: number, a: unknown[]) => (SIZES as readonly unknown[]).includes(s) && a.indexOf(s) === i);
      return { title: String(p.title).trim().slice(0, 40), shows: String(p.shows).trim().slice(0, 600), template: p.template, sizes: sizes.length ? sizes : ["medium"], ...(existing.has(p.replaces) ? { replaces: String(p.replaces) } : {}) };
    });
}

function connectionStep(c: any): ConnectionStep | undefined {
  if (c?.action === "create" && c.name && c.purpose && c.requirements) return { mode: "create", name: String(c.name), purpose: String(c.purpose), requirements: String(c.requirements) };
  if (c?.action === "modify" && c.capabilityId && c.request) return { mode: "modify", capabilityId: String(c.capabilityId), request: String(c.request) };
  return undefined;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);

function draftSpec(j: Record<string, unknown>): DraftSpec | undefined {
  const operations = Array.isArray(j.operations)
    ? j.operations
        .filter((o) => o && typeof o.name === "string" && o.name)
        .map((o) => ({ name: String(o.name), sideEffect: (["read", "write", "destructive"].includes(o.sideEffect) ? o.sideEffect : "read") as DraftSpec["operations"][number]["sideEffect"] }))
    : [];
  const model = ["light", "standard", "strong", "max"].includes(j.model as string) ? (j.model as DraftSpec["model"]) : undefined;
  const spec = { operations, widgets: strings(j.widgets), ...(model ? { model } : {}), uses: strings(j.uses), hosts: strings(j.hosts), secrets: strings(j.secrets) };
  return operations.length || spec.widgets.length || model || spec.uses.length || spec.hosts.length || spec.secrets.length ? spec : undefined;
}

/** Claude Code's stream-json input: the prompt and the attached images as one user message (how images reach it headless). */
export function claudeIntakeInput(prompt: string, images: { mediaType: string; data: string }[]): string {
  const content = [{ type: "text", text: prompt }, ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }))];
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** A failsafe for a run that hangs (you can stop one yourself): long enough for a big brief on a slow, careful model. */
export const INTAKE_TIMEOUT_MS = 15 * 60_000;

export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, onLine?: (line: string) => void, signal?: AbortSignal, stdin?: string, quietStartMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"));
    const child = spawn(command, args, { cwd, env, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (stdin !== undefined) child.stdin!.end(stdin);
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    let out = "";
    let err = "";
    let pending = "";
    // A CLI that never says anything (OpenCode has been seen stuck before its first event): stop it early, with a reason.
    let stalled = false;
    let quiet = quietStartMs ? setTimeout(() => ((stalled = true), child.kill("SIGTERM")), quietStartMs) : undefined;
    const spoke = () => (clearTimeout(quiet), (quiet = undefined));
    child.stdout!.on("data", (d) => {
      spoke();
      out += d;
      if (!onLine) return;
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const l of lines) if (l.trim()) onLine(l);
    });
    child.stderr!.on("data", (d) => (spoke(), (err += d)));
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), child.kill("SIGTERM")), timeoutMs);
    child.once("error", (e) => (clearTimeout(timer), spoke(), reject(e)));
    child.once("close", (code) => {
      clearTimeout(timer);
      spoke();
      if (signal?.aborted) return reject(new Error("stopped"));
      if (timedOut) return reject(new Error(`intake took longer than ${Math.round(timeoutMs / 60_000)} minutes, so Hewn stopped it`));
      if (stalled) return reject(new Error(`intake ${command} said nothing for ${Math.round(quietStartMs! / 60_000)} minutes, so Hewn stopped it (it never started); try again`));
      code === 0 ? resolve(out) : reject(new Error(`intake ${command} exited ${code}: ${(err.trim() || out.trim().split("\n").at(-1) || "no output").slice(-500)}`));
    });
  });
}

/**
 * Intake backed by a headless coding-agent CLI, confined by the builder sandbox profile. It runs on
 * the owner's model for building (`run`, Settings › AI); one the CLI won't run stops it with a
 * reason the owner can act on (pick another), never a quiet switch to the default.
 */
export type IntakeCli = "claude" | "codex" | "opencode";

export function cliIntake(which: IntakeCli, platformRoot: string, run: JobModel = {}): Intake {
  const once = cliIntakeOnce(which, platformRoot, run);
  return async (req, onProgress, signal) => {
    try {
      const reply = await once(req, onProgress, signal);
      if (run.model) noteModelRan(which, run.model);
      return reply;
    } catch (e) {
      if (run.model && !signal?.aborted && MODEL_REJECTED.test((e as Error).message)) {
        const reason = modelRejectReason((e as Error).message);
        noteModelFailure(which, run.model, reason);
        throw new Error(modelUnavailableText(run.model, reason));
      }
      throw e;
    }
  };
}

/**
 * What an `opencode run --format json` stream says once it's done: the reply (its last text part), or
 * why it failed. `onEvent` sees each event as it comes (progress).
 */
export function opencodeOutput(onEvent?: (e: any) => void): { line: (line: string) => void; text: () => string | undefined; error: () => string | undefined } {
  let text: string | undefined;
  let error: string | undefined;
  return {
    line: (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e?.type === "text" && typeof e.part?.text === "string" && e.part.text.trim()) text = e.part.text;
      if (e?.type === "error") error = typeof e.error === "string" ? e.error : (e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? JSON.stringify(e.error));
      onEvent?.(e);
    },
    text: () => text,
    error: () => error,
  };
}

function cliIntakeOnce(which: IntakeCli, platformRoot: string, model: JobModel): Intake {
  return async (req, onProgress, signal) => {
    // They become CLI arguments (and Codex config): names and levels only.
    if (model.model !== undefined && !MODEL_NAME.test(String(model.model))) throw new Error("intake: model must be a model name");
    if (model.effort !== undefined && !EFFORT.test(String(model.effort))) throw new Error("intake: effort must be a level such as low or high");
    const ws = mkdtempSync(join(tmpdir(), "hewn-intake-"));
    try {
      // Claude and OpenCode get web lookup (WebFetch/WebSearch; OpenCode's webfetch) to check services the owner
      // mentions; the owner reviews every draft before anything is built.
      const prompt = intakePrompt(req, { web: which !== "codex" });
      const images = intakeImages(req);
      const h = homedir();
      if (which === "opencode") {
        // Attached images go in as files (-f; a model that takes images sees them); text files are in the prompt already.
        // `-f` takes several files: it goes before another flag, never right before the prompt (it would take it).
        const imageArgs = images.flatMap((img, i) => {
          const p = join(ws, `attachment-${i + 1}.${IMAGE_EXT[img.mediaType] ?? "png"}`);
          writeFileSync(p, Buffer.from(img.data!, "base64"));
          return ["-f", p];
        });
        const args = ["run", ...imageArgs, "--format", "json", "--pure", "--auto", ...opencodeModelArgs(model), prompt];
        // Its own home, like the builder: none of your OpenCode config, plugins or sessions. Kept between intakes (no session is resumed).
        const isolated = opencodeHome(join(platformRoot, "builder-home", "intake-opencode"), { rules: OPENCODE_INTAKE_RULES });
        const out = opencodeOutput((e) => {
          if (!onProgress) return;
          if (e.type === "step_start") onProgress({ activity: "Thinking" });
          else if (e.type === "tool_use") onProgress({ activity: e.part?.tool === "webfetch" ? "Reading a web page" : "Looking" });
        });
        try {
          // A model OpenCode can't resolve hangs its run instead of failing it: ask first.
          if (model.model && !opencodeHasModel(model.model, isolated.env, ws)) throw opencodeModelRejected(model.model);
          const w = wrapBuilder("opencode", args, { workspace: ws, platformRoot, ownState: [isolated.dir], denyKeychain: true, allowLoopback: isolated.loopback });
          await run(w.command, w.args, ws, isolated.env, INTAKE_TIMEOUT_MS, out.line, signal, undefined, OPENCODE_QUIET_START_MS);
        } catch (e) {
          // OpenCode says why it stopped (a model it won't run, a provider without a key) in an error event.
          if (out.error() && !signal?.aborted) throw new Error(`intake failed: ${out.error()!.slice(0, 300)}`);
          throw e;
        } finally {
          isolated.done();
        }
        if (out.error() || !out.text()) throw new Error(`intake failed: ${(out.error() ?? "no reply").slice(0, 300)}`);
        return parseIntake(out.text()!, req.mode, req.current);
      }
      if (which === "codex") {
        writeFileSync(join(ws, "schema.json"), JSON.stringify(SCHEMA));
        // Attached images go in as files next to the prompt (-i); text files are in the prompt already.
        const imageArgs = images.flatMap((img, i) => {
          const p = join(ws, `attachment-${i + 1}.${IMAGE_EXT[img.mediaType] ?? "png"}`);
          writeFileSync(p, Buffer.from(img.data!, "base64"));
          return ["-i", p];
        });
        // `-i` takes several files: it goes before another flag, never right before the prompt (it would take it).
        const args = [
          "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", ...imageArgs,
          ...codexModelArgs(model),
          "--sandbox", "danger-full-access", "-c", "project_doc_max_bytes=0",
          "-C", ws, "--output-schema", join(ws, "schema.json"), "-o", join(ws, "out.json"), prompt,
        ];
        // Its own home, like the builder: none of your Codex config or instructions.
        const isolated = codexHome(join(platformRoot, "builder-home", "intake-codex"));
        try {
          const w = wrapBuilder("codex", args, { workspace: ws, platformRoot, ownState: [isolated.dir], denyKeychain: true });
          await run(w.command, w.args, ws, isolated.env, INTAKE_TIMEOUT_MS, undefined, signal);
        } finally {
          isolated.done();
        }
        return parseIntake(readFileSync(join(ws, "out.json"), "utf8"), req.mode, req.current);
      }
      // With images, the prompt goes in on stdin as one user message with image blocks (stream-json input).
      const stdin = images.length ? claudeIntakeInput(prompt, images.map((i) => ({ mediaType: i.mediaType, data: i.data! }))) : undefined;
      const args = [
        ...(stdin === undefined ? ["-p", prompt] : ["-p", "--input-format", "stream-json"]),
        "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", "8",
        ...claudeModelArgs(model),
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        // None of your settings, hooks or memory: it reads web pages, which may try to steer it.
        "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
        // Web tools only: --restricted drops every code-running tool, also ones added later.
        "--restricted",
        "--allowedTools", "WebFetch", "WebSearch",
        "--disallowedTools", "Bash", "Edit", "Write", "Task",
      ];
      // Its own config dir per request, with your model login only (never your MCP tokens).
      const isolated = claudeHome(join(platformRoot, "builder-home", "intake-claude", basename(ws)));
      const w = wrapBuilder("claude", args, {
        workspace: ws,
        platformRoot,
        ownState: [isolated.dir, join(h, "Library", "Caches", "claude-cli-nodejs"), join(h, ".cache", "claude-cli-nodejs")],
        denyKeychain: true,
      });
      // Stream: text deltas of the current assistant turn, parsed as they arrive; tool calls as activity.
      let text = "";
      let out: { result?: string; is_error?: boolean } = {};
      const onLine = (line: string) => {
        let j: any;
        try {
          j = JSON.parse(line);
        } catch {
          return;
        }
        if (j.type === "result") out = j;
        if (j.type !== "stream_event" || !onProgress) return;
        const e = j.event;
        if (e?.type === "message_start") text = "";
        else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          text += e.delta.text;
          onProgress(partialReply(text));
        } else if (e?.type === "content_block_start" && e.content_block?.type === "thinking") {
          onProgress({ activity: "Thinking" });
        } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
          onProgress({ activity: e.content_block.name === "WebSearch" ? "Searching the web" : "Reading a web page" });
        }
      };
      try {
        await run(w.command, w.args, ws, isolated.env, INTAKE_TIMEOUT_MS, onLine, signal, stdin);
      } catch (e) {
        // Claude Code reports why it stopped (an API error, a rate limit, a sign-in) on stdout, as its result.
        if (out.result && !signal?.aborted) throw new Error(`intake failed: ${String(out.result).slice(0, 300)}`);
        throw e;
      } finally {
        isolated.done();
      }
      if (out.is_error || !out.result) throw new Error(`intake failed: ${String(out.result ?? "no result").slice(0, 300)}`);
      return parseIntake(out.result, req.mode, req.current);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  };
}
