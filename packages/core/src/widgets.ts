// SPDX-License-Identifier: AGPL-3.0-or-later
// Widgets (ABI 2.3): a capability's data snapshot plus a layout, drawn by the platform on Home
// and in agent chats. A widget names a read operation; the operation returns a view model for one
// of the platform's templates. Capability code never ships widget HTML.
// The manifest side (WidgetManifest, sizes, rules) lives in manifest.ts.
import { type CapabilityManifest, compileSchema, type JSONSchema, opKey, schemaErrors } from "./manifest.ts";
import type { Files } from "./ports.ts";

// The templates and view-model types are the spec's (Apache-2.0); the schemas and checks below are the host's.
import { WIDGET_TEMPLATES } from "@hewntools/spec/widgets.ts";
import type { WidgetButton, WidgetOutput, WidgetTemplate, WidgetView } from "@hewntools/spec/widgets.ts";
export { WIDGET_TEMPLATES };
export type { WidgetButton, WidgetOutput, WidgetTemplate, WidgetView };


const text = (max: number): JSONSchema => ({ type: "string", maxLength: max });
const BUTTONS: JSONSchema = {
  type: "array",
  maxItems: 3,
  items: {
    type: "object",
    required: ["label", "operation"],
    additionalProperties: false,
    properties: { label: text(24), operation: { type: "string", pattern: "^[a-z][a-z0-9_]*@[0-9]+$" }, input: { type: "object" } },
  },
};
const view = (template: WidgetTemplate, required: string[], properties: Record<string, JSONSchema>): JSONSchema => ({
  type: "object",
  required: ["template", ...required],
  additionalProperties: false,
  properties: { template: { const: template }, buttons: BUTTONS, ...properties },
});
/** Hidden until tapped ("Show"): the answer on a practice card. Drawn by the platform; nothing is written. */
const reveal = text(280);

/** The view model each template draws. A widget operation's output must match one. */
export const TEMPLATE_SCHEMAS: Record<WidgetTemplate, JSONSchema> = {
  stat: view("stat", ["value"], { value: { type: ["string", "number"] }, unit: text(12), caption: text(80), reveal }),
  list: view("list", ["items"], {
    reveal,
    items: {
      type: "array",
      maxItems: 5,
      items: { type: "object", required: ["title"], additionalProperties: false, properties: { title: text(80), detail: text(80), value: { type: ["string", "number"] } } },
    },
    empty: text(80),
  }),
  chart: view("chart", ["labels", "series"], {
    kind: { enum: ["bar", "line"] },
    labels: { type: "array", maxItems: 31, items: text(16) },
    series: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "object", required: ["name", "values"], additionalProperties: false, properties: { name: text(24), values: { type: "array", maxItems: 31, items: { type: "number" } } } },
    },
    unit: text(12),
    caption: text(80),
  }),
  progress: view("progress", ["value", "max"], { value: { type: "number" }, max: { type: "number", exclusiveMinimum: 0 }, label: text(40), caption: text(80) }),
  text: view("text", ["text"], { text: text(280), caption: text(80), reveal }),
};

const SIZES = ["small", "medium", "large"] as const;

/** The view to draw at a size: the output itself, or its view for that size (else the nearest one). */
export function viewFor(output: WidgetOutput, size: string): WidgetView {
  if ("template" in output) return output as WidgetView;
  const per = output as Partial<Record<(typeof SIZES)[number], WidgetView>>;
  const order = size === "large" ? ["large", "medium", "small"] : size === "small" ? ["small", "medium", "large"] : ["medium", "large", "small"];
  return per[order.find((s) => per[s as (typeof SIZES)[number]]) as (typeof SIZES)[number]]!;
}

/** Why a value is not something the platform can draw (empty: it is): a view, or views per size. */
export function viewErrors(value: unknown): string[] {
  if (value && typeof value === "object" && !Array.isArray(value) && !("template" in value)) {
    const keys = Object.keys(value);
    if (!keys.length || keys.some((k) => !(SIZES as readonly string[]).includes(k))) return ['a widget operation returns a view (with "template"), or views per size: { "medium": {…}, "large": {…} }'];
    return keys.flatMap((k) => oneViewErrors((value as Record<string, unknown>)[k]).map((e) => `${k}: ${e}`));
  }
  return oneViewErrors(value);
}

function oneViewErrors(value: unknown): string[] {
  const t = (value as { template?: unknown } | null)?.template;
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["a widget operation must return an object with a \"template\""];
  if (typeof t !== "string" || !(WIDGET_TEMPLATES as readonly string[]).includes(t)) return [`"template" must be one of ${WIDGET_TEMPLATES.join(", ")}`];
  const check = compileSchema(TEMPLATE_SCHEMAS[t as WidgetTemplate]);
  if (check(value)) {
    const v = value as WidgetView;
    if (v.template === "chart" && v.series.some((s) => s.values.length !== v.labels.length)) return ["chart: every series needs one value per label"];
    return [];
  }
  return schemaErrors(check).map((e) => `${t}: ${e}`);
}

/** JSON with object keys sorted, so a reformatted manifest compares equal. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

const sameBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What a widgets build changed beyond widgets. It may change `widgets`, raise `abi`, add read
 * operations that a widget uses, and change code and tests; everything else (existing
 * operations, `requires`, config, migrations, the UI) must be exactly as in the base version.
 */
export function widgetsBuildProblems(base: { manifest: CapabilityManifest; files: Files }, next: { manifest: CapabilityManifest; files: Files }): string[] {
  const out: string[] = [];
  const b = base.manifest, n = next.manifest;
  if (!n.widgets?.length) out.push('declares no widgets (add "widgets" to capability.json)');
  const keys = new Set([...Object.keys(b), ...Object.keys(n)]);
  for (const k of keys) {
    if (k === "widgets" || k === "abi" || k === "operations") continue;
    if (canonical((b as unknown as Record<string, unknown>)[k]) !== canonical((n as unknown as Record<string, unknown>)[k])) out.push(`"${k}" changed (a widgets build may only change widgets)`);
  }
  const used = new Set((n.widgets ?? []).map((w) => w.operation));
  for (const op of n.operations) {
    const key = opKey(op.name, op.version);
    const old = b.operations.find((o) => opKey(o.name, o.version) === key);
    if (old && canonical(old) !== canonical(op)) out.push(`${key} changed (a widgets build adds operations, it doesn't change them)`);
    if (!old && op.sideEffect !== "read") out.push(`${key} is new and ${op.sideEffect}: a widgets build adds read operations only`);
    if (!old && !used.has(key)) out.push(`${key} is new but no widget uses it`);
  }
  const protectedFiles = (f: Files) => Object.keys(f).filter((p) => p.startsWith("migrations/") || p.startsWith("ui/")).sort();
  const before = protectedFiles(base.files), after = protectedFiles(next.files);
  for (const p of new Set([...before, ...after])) if (!sameBytes(base.files[p], next.files[p])) out.push(`${p} ${!base.files[p] ? "added" : !next.files[p] ? "removed" : "changed"} (a widgets build leaves data and UI alone)`);
  return out;
}

/** A plain-text rendering of a view model: what clients without MCP Apps (and logs) show. */
export function viewText(title: string, output: WidgetOutput, size = "medium"): string {
  const v = viewFor(output, size);
  const cap = (s?: string) => (s ? `\n${s}` : "");
  switch (v.template) {
    case "stat":
      return `${title}: ${v.value}${v.unit ? ` ${v.unit}` : ""}${cap(v.caption)}`;
    case "list":
      return `${title}\n${v.items.length ? v.items.map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ""}${i.value !== undefined ? `: ${i.value}` : ""}`).join("\n") : (v.empty ?? "Nothing here.")}`;
    case "chart":
      return `${title}\n${v.labels.map((l, i) => `${l}: ${v.series.map((s) => `${v.series.length > 1 ? `${s.name} ` : ""}${s.values[i]}`).join(", ")}${v.unit ? ` ${v.unit}` : ""}`).join("\n")}${cap(v.caption)}`;
    case "progress":
      return `${title}: ${v.label ?? `${v.value} / ${v.max}`} (${Math.round((v.value / v.max) * 100)}%)${cap(v.caption)}`;
    case "text":
      return `${title}\n${v.text}${cap(v.caption)}`;
  }
}
