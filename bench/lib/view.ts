// SPDX-License-Identifier: AGPL-3.0-or-later
// What of a run is in view (arms can be hidden from the gallery, the vote, the summary and the judge),
// and the owner's own scores.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { total, type Score } from "./judge.ts";
import { listResults } from "./run.ts";

const metaFile = (runDir: string) => join(runDir, "run.json");
const readMeta = (runDir: string) => (existsSync(metaFile(runDir)) ? JSON.parse(readFileSync(metaFile(runDir), "utf8")) : {});

export const hiddenArms = (runDir: string): string[] => readMeta(runDir).hidden ?? [];

/** Hide arms from the run's views (or show them again). Their results stay on disk. */
export function setHidden(runDir: string, arms: string[], hide: boolean): string[] {
  const meta = readMeta(runDir);
  const hidden = new Set<string>(meta.hidden ?? []);
  for (const a of arms) hide ? hidden.add(a) : hidden.delete(a);
  meta.hidden = [...hidden].sort();
  writeFileSync(metaFile(runDir), JSON.stringify(meta, null, 2));
  return meta.hidden;
}

/** The run's results in arms that aren't hidden. */
export function visibleResults(runDir: string) {
  const hidden = new Set(hiddenArms(runDir));
  return listResults(runDir).filter((r) => !hidden.has(r.result?.arm ?? r.job?.arm ?? ""));
}

/** The owner's score for a result: the judge's four criteria, on the judge's scale. */
export interface OwnerScore extends Pick<Score, "design_quality" | "originality" | "craft" | "usefulness" | "total"> {
  note?: string;
  at: string;
}

export const ownerFile = (dir: string) => join(dir, "owner.json");
export const readOwner = (dir: string): OwnerScore | undefined => (existsSync(ownerFile(dir)) ? JSON.parse(readFileSync(ownerFile(dir), "utf8")) : undefined);

export function writeOwner(dir: string, s: { design_quality: number; originality: number; craft: number; usefulness: number; note?: string }): OwnerScore {
  for (const k of ["design_quality", "originality", "craft", "usefulness"] as const) {
    if (!Number.isInteger(s[k]) || s[k] < 1 || s[k] > 10) throw new Error(`${k} must be a whole number from 1 to 10`);
  }
  const score: OwnerScore = { design_quality: s.design_quality, originality: s.originality, craft: s.craft, usefulness: s.usefulness, total: total(s), ...(s.note?.trim() ? { note: s.note.trim().slice(0, 2000) } : {}), at: new Date().toISOString() };
  writeFileSync(ownerFile(dir), JSON.stringify(score, null, 2));
  return score;
}
