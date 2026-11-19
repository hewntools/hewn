// SPDX-License-Identifier: AGPL-3.0-or-later
// Scenarios: a PR's own steps, the ones its owner would otherwise try by hand, run on the copy after the fixed checks.
// A scenario is a file in the --scenarios folder (`*.ts` or `*.mjs`) whose default export is a `Scenario`:
//
//   import type { Scenario } from "<hewn>/scripts/smoke-copy/scenario.ts";
//   export default {
//     name: "Stop then Retry carries on",
//     async run(s) {
//       await s.step("start a slow change", async () => { … s.copy.admin("modify", …) … });
//       await s.step("the build page shows it", async () => { const p = await s.page("#/b/" + id); … await s.shot("build"); });
//     },
//   } satisfies Scenario;
//
// A step that throws fails (with its message) and ends the scenario; the next scenario still runs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CopyClient } from "./client.ts";
import type { CheckResult, Item } from "./report.ts";

/** What the stub builder noted (stub.jsonl): one line per thing it did. */
export interface StubEvent {
  at: string;
  buildId: string;
  event: "start" | "waiting" | "stopped" | "carried-on" | "done";
  attempt?: number;
  carriesOn?: "failed" | "stopped" | null;
  foundProgress?: boolean;
  /** `[smoke:slow-exit]`: the note the stopped build wrote after its Stop was there too. */
  foundLate?: boolean;
}

export interface ScenarioContext {
  /** The copy: `admin` and `call` (as the owner, like the CLI), `api` (the web API, signed in), `agent` (MCP). */
  copy: CopyClient;
  /** A browser page signed in as the owner, at `hash` (e.g. "#/activity"); its console errors fail the step it's in. Throws without a browser. */
  page: (hash?: string) => Promise<any>;
  /** One step: its name in the report, pass or fail. */
  step: (name: string, fn: () => Promise<void>) => Promise<void>;
  /** A screenshot of the current page into the report. */
  shot: (name: string) => Promise<void>;
  /** A tool of the copy the run picked for changes (ready, no network, model or connection needed), if one fits. */
  tool?: string;
  /**
   * The stub builder: the request's text steers it. `[smoke:slow]` notes its progress, then waits for a Stop (a retry
   * that carries on finds the note and finishes at once); `[smoke:fail]` fails; anything else is a trivial edit.
   */
  stub: { events: (buildId?: string) => StubEvent[]; waitFor: (buildId: string, event: StubEvent["event"], ms?: number) => Promise<StubEvent> };
  /** A build once it ends (promoted, failed, cancelled, review), or throws after `ms`. */
  waitBuild: (buildId: string, ms?: number) => Promise<any>;
  log: (line: string) => void;
}

export interface Scenario {
  name: string;
  run: (s: ScenarioContext) => Promise<void>;
}

export function stubEvents(file: string): StubEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as StubEvent);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The scenario files in `dir`, in name order. */
export function scenarioFiles(dir: string): string[] {
  const d = resolve(dir);
  if (!existsSync(d)) throw new Error(`no scenarios folder at ${d}`);
  return readdirSync(d)
    .filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith(".d.ts"))
    .sort()
    .map((f) => join(d, f));
}

/** Run one scenario file: its steps as the result's items. */
export async function runScenario(file: string, make: (steps: Item[], shots: string[]) => ScenarioContext): Promise<CheckResult> {
  const t0 = Date.now();
  const steps: Item[] = [];
  const shots: string[] = [];
  let name = file.split("/").pop()!;
  try {
    const mod = await import(pathToFileURL(file).href);
    const sc = mod.default as Scenario;
    if (!sc || typeof sc.run !== "function") throw new Error("its default export isn't a Scenario ({ name, run })");
    name = sc.name || name;
    await sc.run(make(steps, shots));
  } catch (e) {
    if (!steps.some((s) => s.status === "fail")) steps.push({ name: "scenario", status: "fail", reason: (e as Error).message });
  }
  const failed = steps.filter((s) => s.status === "fail");
  return {
    id: `scenario:${name}`,
    title: `Scenario: ${name}`,
    status: failed.length ? "fail" : "pass",
    summary: failed.length ? `failed at "${failed[0].name}": ${failed[0].reason}` : `${steps.length} step(s) passed`,
    items: steps,
    shots,
    ms: Date.now() - t0,
  };
}
