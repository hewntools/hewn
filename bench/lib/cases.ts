// SPDX-License-Identifier: AGPL-3.0-or-later
// Cases: frozen build requests (the intake's output, so the bench measures the builder alone) with a
// seed per case, so every arm's tool is shown with the same data.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Calls an operation on the tool being seeded; returns the operation's result, throws its error. */
export type Call = (operation: string, input?: Record<string, unknown>) => Promise<any>;

export interface SeedKit {
  call: Call;
  /** The local date `offset` days from today (negative: past), YYYY-MM-DD. */
  day: (offset: number) => string;
  /** A deterministic pseudo-random number in [0, 1): every arm gets the same "random" data. */
  rand: () => number;
}

export interface CaseModule {
  name: string;
  purpose: string;
  seed: (kit: SeedKit) => Promise<void>;
}

export interface BenchCase extends CaseModule {
  id: string;
  requirements: string;
}

const CASES_DIR = join(import.meta.dirname, "..", "cases");

export async function loadCases(ids?: string[]): Promise<BenchCase[]> {
  const all = readdirSync(CASES_DIR).filter((d) => existsSync(join(CASES_DIR, d, "case.ts"))).sort();
  const pick = ids?.length ? ids : all;
  const unknown = pick.filter((id) => !all.includes(id));
  if (unknown.length) throw new Error(`no case ${unknown.join(", ")} (cases: ${all.join(", ")})`);
  return Promise.all(
    pick.map(async (id) => {
      const m = (await import(join(CASES_DIR, id, "case.ts"))) as CaseModule;
      return { id, name: m.name, purpose: m.purpose, seed: m.seed, requirements: readFileSync(join(CASES_DIR, id, "requirements.md"), "utf8").trim() };
    }),
  );
}

/** Local YYYY-MM-DD of a Date. */
export const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function seedKit(call: Call, seed = 1, today = new Date()): SeedKit {
  let s = seed >>> 0 || 1;
  return {
    call,
    day: (offset) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12);
      return localDate(d);
    },
    // mulberry32
    rand: () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** The id in an operation's result, whether it returns the thing or wraps it (`{ plant: {...} }`). */
export function idOf(result: any, key?: string): unknown {
  if (result == null) return undefined;
  if (result.id !== undefined) return result.id;
  if (key && result[key]?.id !== undefined) return result[key].id;
  const inner = Object.values(result).find((v: any) => v && typeof v === "object" && "id" in v) as any;
  return inner?.id;
}
