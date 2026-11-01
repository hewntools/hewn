// SPDX-License-Identifier: AGPL-3.0-or-later
// A builder's check result as JSON (its images base64): how it crosses from the core to the
// supervisor, and to the host's builder (docs/internal/remote-builder.md).
import { fromBase64, toBase64 } from "./files.ts";
import type { CheckResult } from "./ports.ts";

export interface CheckJson {
  passed: boolean;
  text: string;
  failures: string[];
  defects: string[];
  images: { name: string; png: string }[];
  /** The rest of a long page: for `screenshots/`, not to attach. */
  parts?: { name: string; png: string }[];
}

const shotsToJson = (shots: CheckResult["images"]) => shots.map((i) => ({ name: i.name, png: toBase64(i.png) }));
export const checkToJson = (r: CheckResult): CheckJson => ({ passed: r.passed, text: r.text, failures: r.failures, defects: r.defects, images: shotsToJson(r.images), ...(r.parts?.length ? { parts: shotsToJson(r.parts) } : {}) });

/** A result as sent; what doesn't fit the shape is dropped. A check that ran always has its text. */
export function checkFromJson(j: unknown): CheckResult {
  const o = (j ?? {}) as Record<string, unknown>;
  if (typeof o.text !== "string") throw new Error("not a check result");
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const shots = (v: unknown) => (Array.isArray(v) ? v : []).filter((i): i is { name: string; png: string } => !!i && typeof i.name === "string" && typeof i.png === "string").map((i) => ({ name: i.name, png: fromBase64(i.png) }));
  const parts = shots(o.parts);
  return { passed: o.passed === true, text: o.text, failures: strings(o.failures), defects: strings(o.defects), images: shots(o.images), ...(parts.length ? { parts } : {}) };
}
