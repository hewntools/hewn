// SPDX-License-Identifier: AGPL-3.0-or-later
import { Validator } from "@cfworker/json-schema";

// The contract's types and constants live in the spec (Apache-2.0); the checks below are the host's.
import { RUNTIME_PROFILES, WIDGET_SIZES, MODEL_TIERS, MODEL_PROVIDERS, HEALTH_STATUSES, CONNECT_OUTPUT, HEALTH_OUTPUT } from "@hewntools/spec/manifest.ts";
import type { RuntimeProfile, JSONSchema, SideEffect, OperationManifest, CapabilityManifest, WidgetSize, WidgetManifest, ModelTier, ModelProvider, ModelRequirement } from "@hewntools/spec/manifest.ts";
export { RUNTIME_PROFILES, WIDGET_SIZES, MODEL_TIERS, MODEL_PROVIDERS, HEALTH_STATUSES, CONNECT_OUTPUT, HEALTH_OUTPUT };
export type { RuntimeProfile, JSONSchema, SideEffect, OperationManifest, CapabilityManifest, WidgetSize, WidgetManifest, ModelTier, ModelProvider, ModelRequirement };

/** The grant a model requirement becomes: "model:standard" or "model:anthropic/claude-sonnet-5-5". */
export const modelGrant = (r: ModelRequirement) => `model:${r.model ?? r.tier}`;

import { ABI, DEFAULT_ABI } from "@hewntools/spec/abi.ts";
import { MANIFEST_SCHEMA } from "@hewntools/spec/schemas.ts";
export { ABI, DEFAULT_ABI };

/** Manifest features added after 2.0, each with the minor that introduced it. */
export interface AbiFeature {
  name: string;
  since: string;
  used: (m: CapabilityManifest) => boolean;
}
export const ABI_FEATURES: AbiFeature[] = [
  { name: '"kind"', since: "2.1", used: (m) => m.kind !== undefined },
  { name: "deprecated operations", since: "2.1", used: (m) => m.operations.some((o) => o.deprecated !== undefined) },
  { name: '"config"', since: "2.1", used: (m) => m.config !== undefined || (m.requires?.hosts ?? []).some((h) => h.startsWith("config:")) },
  { name: '"requires.model"', since: "2.2", used: (m) => m.requires?.model !== undefined },
  { name: '"widgets"', since: "2.3", used: (m) => m.widgets !== undefined },
  { name: '"saturation"', since: "2.4", used: (m) => m.saturation !== undefined },
];

/** ctx members added after 2.0, each exposed only to code whose manifest declares at least `since`. */
export const ABI_CTX: { name: string; since: string }[] = [{ name: "model", since: "2.2" }];
/** Whether a manifest's declared ABI reaches `since` (its code may use what arrived then). */
export const abiAtLeast = (m: CapabilityManifest, since: string) => !abiBelow(abiOf(m), since);

export const connectOperation = (m: CapabilityManifest) => (isConnection(m) ? m.operations.filter((o) => o.name === "connect").sort((a, b) => b.version - a.version)[0] : undefined);

const parseAbi = (v: string) => {
  const m = /^(\d+)\.(\d+)$/.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
};
const abiBelow = (a: string, b: string) => {
  const x = parseAbi(a)!, y = parseAbi(b)!;
  return x.major < y.major || (x.major === y.major && x.minor < y.minor);
};
export const abiOf = (m: CapabilityManifest): string => m.abi ?? DEFAULT_ABI;

/** Why this Hewn can't run a capability that needs `needs`, or undefined if it can. */
export function abiUnsupported(needs: string, has: string = ABI): string | undefined {
  const n = parseAbi(needs), h = parseAbi(has)!;
  if (!n) return `abi '${needs}' is not a version (expected major.minor, e.g. "${has}")`;
  if (n.major !== h.major || n.minor > h.minor) return `needs Hewn ABI ${needs}; this Hewn has ${has}`;
  return undefined;
}

/** ABI errors for a manifest: a version this Hewn lacks, or a feature newer than the declared version. */
export function abiErrors(m: CapabilityManifest, has: string = ABI, features: AbiFeature[] = ABI_FEATURES): string[] {
  const declared = abiOf(m);
  const unsupported = abiUnsupported(declared, has);
  if (unsupported) return [unsupported];
  return features
    .filter((f) => f.used(m) && abiBelow(declared, f.since))
    .map((f) => `${f.name} needs ABI ${f.since}, but the manifest declares ${declared}${m.abi === undefined ? " (no \"abi\")" : ""}: set "abi": "${f.since}"`);
}

export const opKey = (name: string, version: number) => `${name}@${version}`;

/** A compiled JSON Schema check. `errors` holds the last failure's messages. */
export interface SchemaCheck {
  (value: unknown): boolean;
  errors: string[];
}

// Keywords that only wrap other results; their own message adds nothing.
const WRAPPERS = new Set(["properties", "items", "prefixItems", "allOf", "anyOf", "oneOf", "$ref", "dependentSchemas", "if", "then", "else", "unevaluatedProperties", "contains", "false"]);
const cache = new Map<string, Validator>();
const where = (loc: string) => loc.replace(/^#/, "") || "$";

/** Readable leaf errors. cfworker reports a declared property that failed its own schema as
 *  "additional" too; those are dropped (the property's own error says what's wrong). */
function messages(errors: { keyword: string; instanceLocation: string; error: string }[]): string[] {
  const failedAt = new Set(errors.filter((e) => !WRAPPERS.has(e.keyword) && e.keyword !== "additionalProperties").map((e) => e.instanceLocation));
  const out: string[] = [];
  for (const e of errors) {
    if (e.keyword === "additionalProperties") {
      const name = /Property "(.*)" does not match/.exec(e.error)?.[1];
      if (name !== undefined && !failedAt.has(`${e.instanceLocation}/${name}`)) out.push(`${where(e.instanceLocation)} unexpected property "${name}"`);
    } else if (!WRAPPERS.has(e.keyword)) out.push(`${where(e.instanceLocation)} ${e.error}`);
  }
  return out.length ? out : errors.map((e) => `${where(e.instanceLocation)} ${e.error}`);
}

/** Compile a schema (Workers-safe: no eval). Cached by schema text. */
export function compileSchema(schema: JSONSchema): SchemaCheck {
  const key = JSON.stringify(schema);
  let v = cache.get(key);
  if (!v) cache.set(key, (v = new Validator(schema as any, "2020-12", false)));
  const validator = v;
  const check = ((value: unknown) => {
    const r = validator.validate(value);
    check.errors = r.valid ? [] : messages(r.errors);
    return r.valid;
  }) as SchemaCheck;
  check.errors = [];
  return check;
}

export function schemaErrors(check: SchemaCheck): string[] {
  return check.errors;
}

const validateManifestShape = compileSchema(MANIFEST_SCHEMA);

export function validateManifest(m: unknown, expectedId: string): string[] {
  if (!validateManifestShape(m)) return schemaErrors(validateManifestShape).map((e) => `manifest ${e}`);
  const manifest = m as CapabilityManifest;
  const errors: string[] = [];
  if (manifest.id !== expectedId) errors.push(`manifest id '${manifest.id}' must be '${expectedId}'`);
  errors.push(...abiErrors(manifest));
  errors.push(...kindErrors(manifest));
  errors.push(...widgetErrors(manifest));
  const model = manifest.requires?.model;
  if (model && (model.tier === undefined) === (model.model === undefined)) errors.push('requires.model takes either "tier" (light | standard | strong | max) or "model" ("<provider>/<model-id>"), not both');
  const seen = new Set<string>();
  for (const op of manifest.operations) {
    const key = opKey(op.name, op.version);
    if (seen.has(key)) errors.push(`duplicate operation ${key}`);
    seen.add(key);
    if (op.inputSchema.type !== "object") errors.push(`${key}: inputSchema must be type object`);
    for (const [which, schema] of [["inputSchema", op.inputSchema], ["outputSchema", op.outputSchema]] as const) {
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        errors.push(`${key}: ${which} invalid: must be a JSON Schema object`);
        continue;
      }
      try {
        compileSchema(schema)(null);
      } catch (e) {
        errors.push(`${key}: ${which} invalid: ${(e as Error).message}`);
      }
    }
  }
  return errors;
}

export const isConnection = (m: CapabilityManifest) => m.kind === "connection";

/** Interval refreshes: at least 5 minutes, at most a day; 30 minutes when not given. */
export const REFRESH_MIN_MS = 5 * 60_000;
export const REFRESH_MAX_MS = 24 * 3600_000;
export const DEFAULT_REFRESH_MS = 30 * 60_000;
export function refreshMs(w: WidgetManifest): number {
  const m = /^(\d+)(m|h)$/.exec(w.refresh?.every ?? "");
  return m ? Number(m[1]) * (m[2] === "h" ? 3600_000 : 60_000) : DEFAULT_REFRESH_MS;
}

export const widgetOf = (m: CapabilityManifest, name: string) => (m.widgets ?? []).find((w) => w.name === name);

/** The rules for a manifest's widgets beyond their shape. */
function widgetErrors(m: CapabilityManifest): string[] {
  const errors: string[] = [];
  const widgets = m.widgets ?? [];
  if (widgets.length && isConnection(m)) errors.push("a connection has no widgets (it is listed under Accounts, not on Home)");
  const seen = new Set<string>();
  for (const w of widgets) {
    if (seen.has(w.name)) errors.push(`duplicate widget ${w.name}`);
    seen.add(w.name);
    const op = m.operations.find((o) => opKey(o.name, o.version) === w.operation);
    if (!op) errors.push(`widget ${w.name}: operation ${w.operation} is not declared`);
    else if (op.sideEffect !== "read") errors.push(`widget ${w.name}: ${w.operation} must be a read operation (widgets are read-only)`);
    const ms = refreshMs(w);
    if (w.refresh?.every && (ms < REFRESH_MIN_MS || ms > REFRESH_MAX_MS)) errors.push(`widget ${w.name}: refresh.every must be between 5m and 24h`);
    if (w.open && !m.ui?.available) errors.push(`widget ${w.name}: "open": "${w.open}" needs a UI ("ui": { "available": true })`);
  }
  return errors;
}

/** The rules of the connection kind (spec/tools.md, "Connections"). */
function kindErrors(m: CapabilityManifest): string[] {
  const errors: string[] = [];
  const config = new Set((m.config ?? []).map((c) => c.name));
  if (config.size !== (m.config ?? []).length) errors.push("config names must be unique");
  for (const h of m.requires?.hosts ?? []) if (h.startsWith("config:") && !config.has(h.slice(7))) errors.push(`requires.hosts '${h}': no config named ${h.slice(7)}`);
  const secrets = m.requires?.secrets ?? [];
  if (!isConnection(m)) {
    if (secrets.length) errors.push(`only connections hold credentials: ${secrets.map((s) => s.name).join(", ")} must live in a connection (a capability with "kind": "connection") that wraps the service; call its operations instead`);
    return errors;
  }
  if (m.ui?.available) errors.push("a connection has no UI (it is listed under Accounts, not on Home)");
  const health = m.operations.find((o) => o.name === "health" && o.version === 1);
  if (!health) errors.push('a connection must have a "health@1" operation (read, no required input) returning { "status": "connected" | "expired" | "broken" }');
  else {
    if (health.sideEffect !== "read") errors.push("health@1 must be a read operation");
    if (health.inputSchema.required?.length) errors.push("health@1 must not require input");
    for (const b of breakingChanges(HEALTH_OUTPUT, health.outputSchema, "output")) errors.push(`health@1 output must match { status: connected | expired | broken }: ${b}`);
  }
  for (const c of m.operations.filter((o) => o.name === "connect")) {
    const key = opKey(c.name, c.version);
    if (c.sideEffect !== "write") errors.push(`${key} (the owner's sign-in step) must be a write operation`);
    for (const b of breakingChanges(CONNECT_OUTPUT, c.outputSchema, "output")) errors.push(`${key} output must match { status: connected | needs_input }: ${b}`);
  }
  return errors;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keywords whose value is a bound: a higher minimum (or lower maximum) accepts less. */
const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"];
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"];
/** Keywords that only restrict: adding or changing one accepts less, removing one accepts more. */
const RESTRICTIONS = ["pattern", "format", "const", "multipleOf", "uniqueItems"];
/** Keywords not compared structurally: any change to one is treated as breaking. */
const OPAQUE = ["oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$ref", "patternProperties", "propertyNames", "contains", "prefixItems", "dependentRequired", "dependentSchemas"];

/**
 * Compatibility check between two schemas of the same operation contract (spec/tools.md,
 * "Operations"): input must accept everything it accepted before; output must keep every
 * guarantee. Constraints are compared (a tighter input or a looser output breaks); composite
 * keywords (oneOf, $ref, …) aren't compared, so any change to one counts as breaking.
 */
export function breakingChanges(oldS: JSONSchema, newS: JSONSchema, dir: "input" | "output", path = "$"): string[] {
  const out: string[] = [];
  if (!same(oldS.type, newS.type)) return [`${path}: type changed`];

  if (oldS.enum || newS.enum) {
    const o: unknown[] | undefined = oldS.enum;
    const n: unknown[] | undefined = newS.enum;
    const narrowed = (from?: unknown[], to?: unknown[]) => !!to && (!from || from.some((v) => !to.includes(v)));
    if (dir === "input" ? narrowed(o, n) : narrowed(n, o)) out.push(`${path}: enum changed incompatibly`);
  }

  // Tighter: the new schema accepts less than the old one. Breaking for input; for output, the
  // reverse (looser) breaks, because callers relied on the old guarantee.
  const breaks = (tighter: boolean) => (dir === "input" ? tighter : !tighter);
  for (const k of LOWER_BOUNDS) {
    const o = oldS[k], n = newS[k];
    if (o === n) continue;
    const tighter = n !== undefined && (o === undefined || n > o);
    if (breaks(tighter)) out.push(`${path}: ${k} ${o ?? "none"} -> ${n ?? "none"}`);
  }
  for (const k of UPPER_BOUNDS) {
    const o = oldS[k], n = newS[k];
    if (o === n) continue;
    const tighter = n !== undefined && (o === undefined || n < o);
    if (breaks(tighter)) out.push(`${path}: ${k} ${o ?? "none"} -> ${n ?? "none"}`);
  }
  for (const k of RESTRICTIONS) {
    if (same(oldS[k], newS[k])) continue;
    // Added or changed restricts input; removed or changed loosens output.
    const restricts = newS[k] !== undefined;
    const loosens = oldS[k] !== undefined;
    if ((dir === "input" && restricts) || (dir === "output" && loosens)) out.push(`${path}: ${k} changed`);
  }
  for (const k of OPAQUE) if (!same(oldS[k], newS[k])) out.push(`${path}: ${k} changed (not compared; any change is breaking)`);
  if (typeof oldS.additionalProperties === "object" || typeof newS.additionalProperties === "object") {
    if (!same(oldS.additionalProperties, newS.additionalProperties)) out.push(`${path}: additionalProperties schema changed (not compared; any change is breaking)`);
  }

  if (oldS.properties || newS.properties) {
    const oP: Record<string, JSONSchema> = oldS.properties ?? {};
    const nP: Record<string, JSONSchema> = newS.properties ?? {};
    const oR = new Set<string>(oldS.required ?? []);
    const nR = new Set<string>(newS.required ?? []);
    for (const k of Object.keys(oP)) {
      if (!(k in nP)) out.push(`${path}.${k}: removed`);
      else out.push(...breakingChanges(oP[k], nP[k], dir, `${path}.${k}`));
    }
    if (dir === "input") {
      for (const k of nR) if (!oR.has(k)) out.push(`${path}.${k}: newly required`);
      if (oldS.additionalProperties !== false && newS.additionalProperties === false) {
        out.push(`${path}: now rejects additional properties`);
      }
    } else {
      for (const k of oR) if (!nR.has(k)) out.push(`${path}.${k}: no longer guaranteed`);
    }
  }

  if (oldS.items && newS.items) out.push(...breakingChanges(oldS.items, newS.items, dir, `${path}[]`));
  else if (newS.items && dir === "input") out.push(`${path}: items now restricted`);
  else if (oldS.items && dir === "output") out.push(`${path}: items no longer guaranteed`);
  return out;
}

/**
 * Every operation contract in `base` must still exist, compatibly, in `next`. An operation may
 * only be removed if `base` already marks it deprecated and nothing uses it (`usedBy(key)` names
 * what still does).
 */
export function contractBreaks(base: CapabilityManifest, next: CapabilityManifest, usedBy: (key: string) => string[] = () => []): string[] {
  const out: string[] = [];
  // A connection's authority model (its sign-in step, its sole hold on credentials) can't be dropped by a change.
  if (isConnection(base) && !isConnection(next)) out.push('kind: a connection stays a connection ("kind": "connection")');
  for (const old of base.operations) {
    const key = opKey(old.name, old.version);
    const cur = next.operations.find((o) => o.name === old.name && o.version === old.version);
    if (!cur) {
      const users = usedBy(key);
      if (!old.deprecated) out.push(`${key}: removed (mark it "deprecated" with its replacement first; remove it in a later version, once nothing uses it)`);
      else if (users.length) out.push(`${key}: removed, but ${users.join(", ")} still use${users.length === 1 ? "s" : ""} it`);
      continue;
    }
    if (cur.sideEffect !== old.sideEffect) out.push(`${key}: sideEffect changed ${old.sideEffect} -> ${cur.sideEffect}`);
    out.push(...breakingChanges(old.inputSchema, cur.inputSchema, "input").map((m) => `${key} input ${m}`));
    out.push(...breakingChanges(old.outputSchema, cur.outputSchema, "output").map((m) => `${key} output ${m}`));
  }
  return out;
}

export const profileOf = (_m: CapabilityManifest): RuntimeProfile => "isolate";
