// SPDX-License-Identifier: AGPL-3.0-or-later
// A builder's check result as JSON (its images base64): how it crosses from the core to the
// supervisor, and to the host's builder (docs/internal/remote-builder.md).
import { fromBase64, toBase64 } from "./files.ts";
import type { CheckResult, CheckWarning } from "./ports.ts";

export interface CheckJson {
  passed: boolean;
  text: string;
  failures: string[];
  warnings: CheckWarning[];
  defects: string[];
  images: { name: string; png: string }[];
  /** The rest of a long page: for `screenshots/`, not to attach. */
  parts?: { name: string; png: string }[];
}

const shotsToJson = (shots: CheckResult["images"]) => shots.map((i) => ({ name: i.name, png: toBase64(i.png) }));
export const checkToJson = (r: CheckResult): CheckJson => ({ passed: r.passed, text: r.text, failures: r.failures, warnings: r.warnings, defects: r.defects, images: shotsToJson(r.images), ...(r.parts?.length ? { parts: shotsToJson(r.parts) } : {}) });

/** A result as sent; what doesn't fit the shape is dropped. A check that ran always has its text. */
export function checkFromJson(j: unknown): CheckResult {
  const o = (j ?? {}) as Record<string, unknown>;
  if (typeof o.text !== "string") throw new Error("not a check result");
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const shots = (v: unknown) => (Array.isArray(v) ? v : []).filter((i): i is { name: string; png: string } => !!i && typeof i.name === "string" && typeof i.png === "string").map((i) => ({ name: i.name, png: fromBase64(i.png) }));
  const parts = shots(o.parts);
  return { passed: o.passed === true, text: o.text, failures: strings(o.failures), warnings: warningsFrom(o.warnings), defects: strings(o.defects), images: shots(o.images), ...(parts.length ? { parts } : {}) };
}

/** Warnings as sent: each needs its check and its sentence; a file and line are kept when they're the right type. */
export function warningsFrom(v: unknown): CheckWarning[] {
  return (Array.isArray(v) ? v : [])
    .filter((w): w is Record<string, unknown> => !!w && typeof w.check === "string" && typeof w.message === "string")
    .map((w) => ({ check: w.check as string, message: w.message as string, ...(typeof w.file === "string" ? { file: w.file } : {}), ...(typeof w.line === "number" ? { line: w.line } : {}), ...(typeof w.host === "string" ? { host: w.host } : {}) }));
}
