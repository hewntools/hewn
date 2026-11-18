// SPDX-License-Identifier: AGPL-3.0-or-later
// The smoke run's report: one markdown file with its screenshots next to it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type Status = "pass" | "fail" | "skip" | "warn";

/** One thing a check looked at (a tool, an operation, a page): its outcome and why. */
export interface Item {
  name: string;
  status: Status;
  reason?: string;
  ms?: number;
}

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  /** One line: what was found. */
  summary: string;
  items?: Item[];
  /** Further lines, shown as they are (a log excerpt, numbers). */
  details?: string[];
  /** Screenshots, relative to the report. */
  shots?: string[];
  ms: number;
}

export interface RunFacts {
  startedAt: string;
  tree: string;
  treeRef: string;
  source: string;
  network: "off" | "get";
  ports: { port: number; publicPort: number };
  copy: Record<string, unknown>;
  timings: Record<string, number>;
  memory: { label: string; supervisor: number; platform: number; tools: number }[];
  scenarios: string[];
  /** The run this one is compared with (its results.json). */
  baseline?: string;
  aborted?: string;
}

const ICON: Record<Status, string> = { pass: "✅", fail: "❌", skip: "⏭️", warn: "⚠️" };
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const secs = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

/** The worst of some outcomes: fail, then warn, then pass; skips alone are a skip. */
export function worst(statuses: Status[]): Status {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("pass")) return "pass";
  return statuses.length ? "skip" : "pass";
}

/** Items in groups: what failed one by one, skips by their reason, passes as a count with their names folded. */
function itemLines(items: Item[]): string[] {
  const out: string[] = [];
  const failed = items.filter((i) => i.status === "fail" || i.status === "warn");
  for (const i of failed) out.push(`- ${ICON[i.status]} **${esc(i.name)}**: ${i.reason ?? i.status}`);
  const skips = new Map<string, string[]>();
  for (const i of items.filter((x) => x.status === "skip")) skips.set(i.reason ?? "skipped", [...(skips.get(i.reason ?? "skipped") ?? []), i.name]);
  for (const [reason, names] of skips) out.push(`- ${ICON.skip} ${names.length} skipped, ${reason}: ${names.map(esc).join(", ")}`);
  const passed = items.filter((i) => i.status === "pass");
  if (passed.length) {
    out.push(`- ${ICON.pass} ${passed.length} passed`);
    out.push("", "<details><summary>passed</summary>", "", ...passed.map((i) => `- ${esc(i.name)}${i.ms !== undefined ? ` (${secs(i.ms)})` : ""}${i.reason ? `: ${esc(i.reason)}` : ""}`), "", "</details>");
  }
  return out;
}

/** The key an item is matched by across runs. */
const key = (check: string, item?: string) => `${check}::${item ?? ""}`;

/**
 * With a baseline (results.json of a run on the base branch, on the same copy): what failed there too isn't this
 * tree's doing, so it's a warning, said so. A tool's own bug in the copy then fails only the run that brings it.
 */
export function againstBaseline(results: CheckResult[], baseline: CheckResult[]): CheckResult[] {
  const failedBefore = new Set<string>();
  for (const r of baseline) {
    if (r.status === "fail" && !r.items?.length) failedBefore.add(key(r.id));
    for (const i of r.items ?? []) if (i.status === "fail") failedBefore.add(key(r.id, i.name));
  }
  return results.map((r) => {
    if (r.status === "fail" && !r.items?.length && failedBefore.has(key(r.id))) return { ...r, status: "warn", summary: `${r.summary} (fails on the base too)` };
    if (!r.items?.length) return r;
    const items = r.items.map((i) => (i.status === "fail" && failedBefore.has(key(r.id, i.name)) ? { ...i, status: "warn" as const, reason: `fails on the base too: ${i.reason ?? ""}` } : i));
    const known = items.filter((i, n) => i !== r.items![n]).length;
    return { ...r, items, status: worst(items.map((i) => i.status)), ...(known ? { summary: `${r.summary}; ${known} of them fail${known === 1 ? "s" : ""} on the base too` } : {}) };
  });
}

export function writeReport(out: string, facts: RunFacts, results: CheckResult[]): { file: string; status: Status } {
  writeFileSync(join(out, "results.json"), JSON.stringify({ facts, results }, null, 2) + "\n");
  const status = facts.aborted ? "fail" : worst(results.map((r) => r.status));
  const lines: string[] = [
    `# Smoke run on a copy: ${ICON[status]} ${status}`,
    "",
    `- When: ${facts.startedAt}`,
    `- Tree: \`${facts.tree}\` at ${facts.treeRef}`,
    `- Copy of: ${facts.source}`,
    `- Network: ${facts.network === "off" ? "off (nothing goes out)" : "GET and HEAD only (--network)"} · schedules off · ports ${facts.ports.port}, ${facts.ports.publicPort}`,
    `- The copy: ${Object.entries(facts.copy).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}`,
    ...(facts.scenarios.length ? [`- Scenarios: ${facts.scenarios.join(", ")}`] : []),
    ...(facts.baseline ? [`- Baseline: ${facts.baseline} (what failed there too is a warning here)`] : []),
    ...(facts.aborted ? ["", `**Stopped early:** ${facts.aborted}`] : []),
    "",
    "| Check | Result | What was found | Took |",
    "| --- | --- | --- | --- |",
    ...results.map((r) => `| ${esc(r.title)} | ${ICON[r.status]} ${r.status} | ${esc(r.summary)} | ${secs(r.ms)} |`),
    "",
  ];
  if (Object.keys(facts.timings).length) {
    lines.push("## Timings", "", "| What | Took |", "| --- | --- |", ...Object.entries(facts.timings).map(([k, v]) => `| ${esc(k)} | ${v} ms |`), "");
  }
  if (facts.memory.length) {
    lines.push("## Memory (RSS, MB)", "", "| When | Supervisor | Platform | Tools |", "| --- | --- | --- | --- |", ...facts.memory.map((m) => `| ${esc(m.label)} | ${m.supervisor} | ${m.platform} | ${m.tools} |`), "");
  }
  for (const r of results) {
    lines.push(`## ${ICON[r.status]} ${r.title}`, "", r.summary, "");
    if (r.items?.length) lines.push(...itemLines(r.items), "");
    if (r.details?.length) lines.push("```text", ...r.details, "```", "");
    for (const s of r.shots ?? []) lines.push(`![${s}](${s})`, "");
  }
  const file = join(out, "report.md");
  writeFileSync(file, lines.join("\n"));
  return { file, status };
}
