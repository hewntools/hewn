// SPDX-License-Identifier: AGPL-3.0-or-later
// The schema fuzz's inputs: from an operation's input schema, inputs its schema accepts (the host refuses the rest with
// invalid_input before the tool's code runs), the edges a tool's code most often forgets. No randomness: the same
// schema gives the same inputs, so a failure can be named and tried again.
import { CALL_TIMEOUT_MS, ENGINE_ERRORS, type KeysSince } from "./abi.ts";
import { PlatformError } from "./errors.ts";
import { compileSchema, type JSONSchema, type OperationManifest, opKey } from "./manifest.ts";

/** At most this many inputs per operation. */
export const FUZZ_INPUTS_PER_OPERATION = 12;
/** The long string's length (10 KB of ASCII). */
export const FUZZ_LONG_STRING = 10 * 1024;

/** One input, and how a person reads it ("the 10 KB input in `title`"): validation names it when the call fails. */
export interface FuzzInput {
  label: string;
  input: Record<string, unknown>;
}

type Schema = Record<string, unknown>;
const isSchema = (s: unknown): s is Schema => !!s && typeof s === "object" && !Array.isArray(s);
const typesOf = (s: Schema): string[] => (Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const LONG = "fuzz input 0123456789 ".repeat(Math.ceil(FUZZ_LONG_STRING / 22)).slice(0, FUZZ_LONG_STRING);
const UNICODE = "Ünïcödé ✓ 漢字 Ελληνικά עברית 🎉👩‍💻";
/** A value each string format accepts. */
const FORMATS: Record<string, string> = {
  date: "2026-01-31",
  "date-time": "2026-01-31T12:00:00Z",
  time: "12:00:00Z",
  duration: "P1D",
  email: "someone@example.com",
  "idn-email": "someone@example.com",
  hostname: "example.com",
  "idn-hostname": "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  uri: "https://example.com/",
  "uri-reference": "https://example.com/",
  iri: "https://example.com/",
  "iri-reference": "https://example.com/",
  url: "https://example.com/",
  uuid: "00000000-0000-4000-8000-000000000000",
  "json-pointer": "/a",
  regex: "a",
};

/** The branch a value is made from: the first of oneOf/anyOf, else the schema itself. */
function branch(s: Schema): Schema {
  for (const k of ["oneOf", "anyOf"]) {
    const list = s[k];
    if (Array.isArray(list) && isSchema(list[0])) return { ...list[0], ...Object.fromEntries(Object.entries(s).filter(([key]) => key !== k)) };
  }
  return s;
}

/** An ordinary value the schema accepts (undefined when none can be made): its example, default, const or first enum value, else one by its type. */
function typical(raw: unknown, depth = 0, every = false): unknown {
  if (!isSchema(raw) || depth > 6) return undefined;
  const s = branch(raw);
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if ("default" in s) return s.default;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = typesOf(s).find((t) => t !== "null") ?? (s.properties ? "object" : s.items ? "array" : typesOf(s)[0]);
  switch (type) {
    case "string": {
      if (typeof s.format === "string" && FORMATS[s.format]) return FORMATS[s.format];
      const min = num(s.minLength) ?? 0;
      const max = num(s.maxLength);
      const base = "sample".padEnd(min, "x");
      return max !== undefined ? base.slice(0, max) : base;
    }
    case "integer":
    case "number": {
      let v = type === "integer" ? 1 : 1.5;
      const lo = num(s.minimum) ?? (num(s.exclusiveMinimum) !== undefined ? num(s.exclusiveMinimum)! + 1 : undefined);
      const hi = num(s.maximum) ?? (num(s.exclusiveMaximum) !== undefined ? num(s.exclusiveMaximum)! - 1 : undefined);
      if (lo !== undefined && v < lo) v = type === "integer" ? Math.ceil(lo) : lo;
      if (hi !== undefined && v > hi) v = type === "integer" ? Math.floor(hi) : hi;
      return v;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      // With every field set, a list has one item at least (an empty one is an edge of its own).
      const n = Math.max(num(s.minItems) ?? 0, every ? 1 : 0);
      const item = typical(s.items, depth + 1, every);
      return item === undefined ? [] : Array.from({ length: n }, () => item);
    }
    case "object":
      return objectOf(s, depth, every);
    default:
      return undefined;
  }
}

/** An object the schema accepts: its required properties, or (`every`) all of them, each a typical value. */
function objectOf(s: Schema, depth: number, every: boolean): Record<string, unknown> {
  const props = isSchema(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(props)) {
    if (!every && !required.has(name)) continue;
    const v = typical(p, depth + 1, every);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** The edges of one property's schema, most telling first: what a tool's code most often forgets. */
function edges(name: string, raw: unknown): { label: string; value: unknown }[] {
  if (!isSchema(raw)) return [];
  const s = branch(raw);
  const at = `in \`${name}\``;
  const types = typesOf(s);
  const out: { label: string; value: unknown }[] = [];
  if (types.includes("null") || (Array.isArray(s.enum) && s.enum.includes(null))) out.push({ label: `null ${at}`, value: null });
  if (Array.isArray(s.enum)) for (const v of s.enum.slice(1)) out.push({ label: `${JSON.stringify(v)} ${at}`, value: v });
  if (types.includes("string") || (!types.length && (s.minLength !== undefined || s.maxLength !== undefined))) {
    const max = num(s.maxLength);
    out.push({ label: `the empty string ${at}`, value: "" });
    if (max === undefined || max >= FUZZ_LONG_STRING) out.push({ label: `the 10 KB input ${at}`, value: LONG });
    else out.push({ label: `the longest string ${at} (${max} characters)`, value: LONG.slice(0, max) });
    out.push({ label: `unicode and emoji ${at}`, value: max !== undefined ? UNICODE.slice(0, max) : UNICODE });
  }
  if (types.includes("integer") || types.includes("number")) {
    const lo = num(s.minimum);
    const hi = num(s.maximum);
    out.push({ label: `0 ${at}`, value: 0 }, { label: `-1 ${at}`, value: -1 });
    if (lo !== undefined && lo !== 0 && lo !== -1) out.push({ label: `the minimum ${at} (${lo})`, value: lo });
    if (hi !== undefined && hi !== 0 && hi !== -1) out.push({ label: `the maximum ${at} (${hi})`, value: hi });
  }
  if (types.includes("boolean")) out.push({ label: `false ${at}`, value: false });
  if (types.includes("array") || (!types.length && s.items)) out.push({ label: `an empty list ${at}`, value: [] });
  if (types.includes("object") || (!types.length && s.properties)) out.push({ label: `an empty object ${at}`, value: {} });
  return out;
}

/**
 * The fuzz's inputs for one operation, at most FUZZ_INPUTS_PER_OPERATION, each one its schema accepts: the schema's
 * own examples, the minimal input (its required properties only), the input with every property set, then each
 * property's edges in turn (null where it's allowed, the empty string, a 10 KB string, unicode and emoji, 0, -1, the
 * minimum and maximum, an empty list or object), set in the input with every property, taking one edge of each
 * property before the next of any, so every property gets some.
 */
export function fuzzInputs(inputSchema: JSONSchema): FuzzInput[] {
  const schema = isSchema(inputSchema) ? inputSchema : {};
  const accepts = compileSchema(inputSchema);
  const out: FuzzInput[] = [];
  const seen = new Set<string>();
  const add = (label: string, input: unknown) => {
    if (out.length >= FUZZ_INPUTS_PER_OPERATION || !input || typeof input !== "object" || Array.isArray(input)) return;
    const key = JSON.stringify(input);
    if (seen.has(key) || !accepts(input)) return;
    seen.add(key);
    out.push({ label, input: input as Record<string, unknown> });
  };
  const examples = Array.isArray(schema.examples) ? schema.examples : [];
  examples.forEach((e, i) => add(examples.length === 1 ? "the schema's example" : `the schema's example ${i + 1}`, e));
  const minimal = objectOf(schema, 0, false);
  add("the minimal input", minimal);
  const full = objectOf(schema, 0, true);
  add("the input with every field set", full);
  const props = isSchema(schema.properties) ? Object.entries(schema.properties) : [];
  // Each property's edges the schema accepts, so one it refuses doesn't take the property's turn.
  const perProp = props.map(([name, p]) =>
    edges(name, p)
      .map((e) => ({ label: e.label, input: { ...full, [name]: e.value } }))
      .filter((e) => !seen.has(JSON.stringify(e.input)) && accepts(e.input)),
  );
  for (let i = 0; out.length < FUZZ_INPUTS_PER_OPERATION && perProp.some((list) => i < list.length); i++) {
    for (const list of perProp) if (list[i]) add(list[i].label, list[i].input);
  }
  return out;
}

/** The fuzz's own bounds: a bound reached stops it there (what wasn't tried is named), and fails nothing. */
export const FUZZ_OPERATION_MS = 5_000;
export const FUZZ_TOOL_MS = 60_000;

/**
 * What the fuzz needs from validation: one call (failing as the host fails it), the tool's keys (`mark` snapshots them
 * in the copy, `since` compares, abi.ts), and a pause between calls (which throws to stop it).
 */
export interface FuzzDeps {
  call(op: OperationManifest, input: FuzzInput): Promise<unknown>;
  mark(): Promise<void>;
  since(): Promise<KeysSince>;
  between(): Promise<void>;
  now?: () => number;
}

/** What the fuzz found (`problems`, each failing the candidate), what it noted, and how much it did. */
export interface FuzzReport {
  problems: string[];
  notes: string[];
  operations: number;
  calls: number;
  /** A call stalled (the stall rule, told by stalls.ts): the fuzz stopped there. */
  stalled?: true;
}

const RANK: Record<string, number> = { read: 0, write: 1, destructive: 2 };

/** How the tool's data changed since its keys were marked, in words ("`runs` went from 3 to 4 rows"). */
export function keysChanged(k: KeysSince): string[] {
  const out: string[] = [];
  for (const [t, x] of Object.entries(k.tables)) {
    const after = x.gone ? 0 : (x.after ?? 0);
    if (after !== x.before) out.push(`\`${t}\` went from ${x.before} to ${after} rows`);
    else if (x.kept !== null && x.kept !== x.before) out.push(`\`${t}\`'s keys changed`);
  }
  for (const [t, n] of Object.entries(k.added)) if (n) out.push(`\`${t}\` went from 0 to ${n} rows`);
  return out;
}

/**
 * Hewn's schema fuzz: each operation called with the inputs its schema accepts (fuzzInputs), reads first, then writes,
 * destructive ones last, on a copy that is thrown away after. A read is called twice with each input, and the second
 * call must leave the tool's data as the first left it. Fails, naming the operation and the input: an output its
 * outputSchema refuses, a crash (an error the JS engine raised, ENGINE_ERRORS), a call past its deadline, a read that
 * isn't idempotent. Not a failure: an error the tool threw itself (its refusal), or one after the call reached for the
 * network, a secret, a setting, another tool or the model (none of which it gets here). One problem per operation is enough. A stall stops it (stalls.ts fails the run).
 */
export async function fuzz(operations: OperationManifest[], d: FuzzDeps): Promise<FuzzReport> {
  const now = d.now ?? Date.now;
  const report: FuzzReport = { problems: [], notes: [], operations: 0, calls: 0 };
  const ops = operations.map((op, i) => ({ op, i })).sort((a, b) => (RANK[a.op.sideEffect] ?? 1) - (RANK[b.op.sideEffect] ?? 1) || a.i - b.i);
  const toolEnd = now() + FUZZ_TOOL_MS;
  const notReached: string[] = [];
  /** One call: fine (`ok`, or a refusal), a problem in words, or the stall that stops the fuzz. */
  const attempt = async (op: OperationManifest, f: FuzzInput, net: Set<string>): Promise<{ ok: boolean; problem?: string; stop?: true }> => {
    const key = opKey(op.name, op.version);
    report.calls++;
    try {
      await d.call(op, f);
      return { ok: true };
    } catch (e) {
      if (!(e instanceof PlatformError)) return { ok: false };
      const details = (e.details ?? {}) as { stalled?: boolean; heldUp?: boolean; thrown?: string; reached?: boolean };
      if (details.stalled) return { ok: false, stop: true };
      if (details.heldUp) return { ok: false };
      if (e.code === "invalid_output") {
        const why = Array.isArray(e.details) ? (e.details as string[]).slice(0, 3).join("; ") : "";
        return { ok: false, problem: `${key} returned output its outputSchema refuses, on ${f.label}${why ? `: ${why}` : ""}` };
      }
      if (/timed out \(call chain deadline\)$/.test(e.message)) return { ok: false, problem: `${key} ran past its deadline (${CALL_TIMEOUT_MS / 1000} s), on ${f.label}` };
      if (details.thrown && ENGINE_ERRORS.includes(details.thrown)) {
        if (details.reached) {
          net.add(key);
          return { ok: false };
        }
        const what = e.message.replace(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} failed: `), "");
        return { ok: false, problem: `${key} crashed on ${f.label}: ${details.thrown}: ${what}` };
      }
      return { ok: false };
    }
  };
  for (const { op } of ops) {
    const key = opKey(op.name, op.version);
    if (now() >= toolEnd) {
      notReached.push(key);
      continue;
    }
    report.operations++;
    const opEnd = Math.min(now() + FUZZ_OPERATION_MS, toolEnd);
    const inputs = fuzzInputs(op.inputSchema);
    const net = new Set<string>();
    for (const [i, f] of inputs.entries()) {
      if (now() >= opEnd) {
        report.notes.push(`${key}: ${inputs.length - i} of its ${inputs.length} inputs not tried (the fuzz's ${opEnd === toolEnd ? `${FUZZ_TOOL_MS / 1000} s for the tool` : `${FUZZ_OPERATION_MS / 1000} s for an operation`})`);
        break;
      }
      await d.between();
      const first = await attempt(op, f, net);
      if (first.stop) return { ...report, stalled: true };
      if (first.problem) {
        report.problems.push(first.problem);
        break;
      }
      if (op.sideEffect !== "read" || !first.ok) continue;
      await d.mark();
      await d.between();
      const second = await attempt(op, f, net);
      if (second.stop) return { ...report, stalled: true };
      if (second.problem) {
        report.problems.push(second.problem);
        break;
      }
      const changed = keysChanged(await d.since());
      if (changed.length) {
        report.problems.push(`${key} isn't idempotent: called again with ${f.label}, it changed the tool's data (${changed.join("; ")})`);
        break;
      }
    }
    if (net.size) report.notes.push(`${key} reached for the network, a secret, a setting, another tool or the model, which the fuzz doesn't give it: an error after that isn't judged`);
  }
  if (notReached.length) report.notes.push(`not reached within the fuzz's ${FUZZ_TOOL_MS / 1000} s for the tool: ${notReached.join(", ")}`);
  return report;
}
