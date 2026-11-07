// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-arm numbers for a run: what got built, what it cost, what the judge and the owner's votes say.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJudge, type Sameness } from "./judge.ts";
import { readOwner, visibleResults } from "./view.ts";

export interface Vote {
  at: string;
  case: string;
  left: { arm: string; key: string };
  right: { arm: string; key: string };
  winner: "left" | "right" | "tie";
  daily?: { left?: boolean; right?: boolean };
}

export const votesFile = (runDir: string) => join(runDir, "votes.jsonl");
export const readVotes = (runDir: string): Vote[] =>
  existsSync(votesFile(runDir))
    ? readFileSync(votesFile(runDir), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

export interface ArmSummary {
  arm: string;
  results: number;
  done: number;
  failed: number;
  seedErrors: number;
  usd?: number;
  minutes?: number;
  attempts?: number;
  /** Judge on the version before the passes (shots-first/), mean total out of 60. */
  judgeFirst?: number;
  /** Judge, mean over results (total out of 60). */
  judge?: { total: number; design_quality: number; originality: number; craft: number; usefulness: number; n: number };
  /** Most frequent tells the judge saw. */
  tells: [string, number][];
  sameness?: number;
  /** The owner's own scores (total out of 60), and how far the judge was from them on the same results. */
  owner?: { total: number; design_quality: number; originality: number; craft: number; usefulness: number; n: number; judgeGap?: number };
  /** Owner's blind votes: wins count 1, ties ½, over the comparisons this arm was in. */
  votes?: { n: number; winRate: number; daily: number };
  ui?: { kb: number; cssKb: number; svgSites: number; motion: number };
  pageErrors: number;
  clickFailures: number;
  overflowing: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const r1 = (x: number | undefined) => (x === undefined ? undefined : Math.round(x * 10) / 10);

export function summarize(runDir: string): ArmSummary[] {
  const all = visibleResults(runDir);
  const votes = readVotes(runDir);
  const arms = [...new Set(all.map((r) => r.result?.arm ?? r.job?.arm).filter(Boolean))] as string[];
  return arms.map((arm) => {
    const rs = all.filter((r) => (r.result?.arm ?? r.job?.arm) === arm);
    const done = rs.filter((r) => r.result?.status === "done");
    const judged = done.map((r) => readJudge(r.dir)).filter((j) => j !== undefined);
    const owned = done.map((r) => ({ o: readOwner(r.dir), j: readJudge(r.dir) })).filter((x) => x.o !== undefined);
    const gaps = owned.filter((x) => x.j).map((x) => x.j!.total - x.o!.total);
    const tellCount = new Map<string, number>();
    for (const j of judged) for (const t of j.tells ?? []) tellCount.set(t, (tellCount.get(t) ?? 0) + 1);
    const same = [...new Set(done.map((r) => r.result!.rep))]
      .map((rep) => join(runDir, "results", arm, `sameness-r${rep}.json`))
      .filter(existsSync)
      .map((f) => (JSON.parse(readFileSync(f, "utf8")) as Sameness).sameness);
    const mine = votes.filter((v) => v.left.arm === arm || v.right.arm === arm);
    const points = mine.map((v) => (v.winner === "tie" ? 0.5 : (v.winner === "left") === (v.left.arm === arm) ? 1 : 0));
    const daily = mine.map((v) => (v.left.arm === arm ? v.daily?.left : v.daily?.right) ?? false);
    return {
      arm,
      results: rs.length,
      done: done.length,
      failed: rs.filter((r) => r.result?.status === "failed").length,
      seedErrors: done.filter((r) => r.result!.seedError).length,
      usd: r1(mean(rs.filter((r) => r.result?.usage).map((r) => r.result!.usage!.usd))),
      minutes: r1(mean(rs.filter((r) => r.result?.usage).map((r) => r.result!.usage!.minutes))),
      attempts: r1(mean(rs.flatMap((r) => r.result?.builds.map((b) => b.attempts) ?? []))),
      judge: judged.length
        ? {
            n: judged.length,
            total: r1(mean(judged.map((j) => j.total)))!,
            design_quality: r1(mean(judged.map((j) => j.design_quality)))!,
            originality: r1(mean(judged.map((j) => j.originality)))!,
            craft: r1(mean(judged.map((j) => j.craft)))!,
            usefulness: r1(mean(judged.map((j) => j.usefulness)))!,
          }
        : undefined,
      owner: owned.length
        ? {
            n: owned.length,
            total: r1(mean(owned.map((x) => x.o!.total)))!,
            design_quality: r1(mean(owned.map((x) => x.o!.design_quality)))!,
            originality: r1(mean(owned.map((x) => x.o!.originality)))!,
            craft: r1(mean(owned.map((x) => x.o!.craft)))!,
            usefulness: r1(mean(owned.map((x) => x.o!.usefulness)))!,
            ...(gaps.length ? { judgeGap: r1(mean(gaps)) } : {}),
          }
        : undefined,
      judgeFirst: r1(mean(done.map((r) => readJudge(r.dir, "judge-first.json")?.total).filter((x): x is number => x !== undefined))),
      tells: [...tellCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      sameness: r1(mean(same)),
      votes: mine.length ? { n: mine.length, winRate: Math.round((100 * points.reduce((a: number, b) => a + b, 0)) / mine.length), daily: Math.round((100 * daily.filter(Boolean).length) / mine.length) } : undefined,
      ui: done.length
        ? {
            kb: r1(mean(done.map((r) => (r.result!.ui?.bytes ?? 0) / 1000)))!,
            cssKb: r1(mean(done.map((r) => (r.result!.ui?.cssBytes ?? 0) / 1000)))!,
            svgSites: r1(mean(done.map((r) => r.result!.ui?.svgSites ?? 0)))!,
            motion: r1(mean(done.map((r) => r.result!.ui?.motion ?? 0)))!,
          }
        : undefined,
      pageErrors: done.filter((r) => Object.values(r.result!.pageErrors ?? {}).some((e) => e.length)).length,
      clickFailures: done.filter((r) => r.result!.clicks?.failures.length).length,
      overflowing: done.filter((r) => (r.result!.overflowMobile ?? 0) > 1).length,
    };
  });
}

export function summaryMarkdown(runDir: string): string {
  const s = summarize(runDir);
  const meta = existsSync(join(runDir, "run.json")) ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) : {};
  const v = (x: unknown) => (x === undefined ? "–" : String(x));
  const lines = [
    `# Bench run ${meta.name ?? ""}`,
    "",
    `Started ${meta.startedAt ?? "?"} on ${meta.commit ?? "?"}${meta.dirty ? " (with uncommitted changes)" : ""}, brief ${meta.briefSha ?? "?"}, ${meta.claude ?? "claude ?"}. Cases: ${(meta.cases ?? []).join(", ")}; ${meta.reps ?? "?"} repetition(s).`,
    "",
    "| Arm | Built | $ / result | Min | You /60 (n) | Judge before passes | Judge /60 | Design | Original | Craft | Useful | Sameness /10 | Owner win % (n) | Daily % | UI KB | CSS KB | SVG | Motion | Page errors | Click failures | Phone overflow |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...s.map((a) => `| ${a.arm} | ${a.done}/${a.results}${a.seedErrors ? ` (${a.seedErrors} seed err)` : ""} | ${v(a.usd)} | ${v(a.minutes)} | ${a.owner ? `${a.owner.total} (${a.owner.n})` : "–"} | ${v(a.judgeFirst)} | ${v(a.judge?.total)} | ${v(a.judge?.design_quality)} | ${v(a.judge?.originality)} | ${v(a.judge?.craft)} | ${v(a.judge?.usefulness)} | ${v(a.sameness)} | ${a.votes ? `${a.votes.winRate} (${a.votes.n})` : "–"} | ${v(a.votes?.daily)} | ${v(a.ui?.kb)} | ${v(a.ui?.cssKb)} | ${v(a.ui?.svgSites)} | ${v(a.ui?.motion)} | ${a.pageErrors} | ${a.clickFailures} | ${a.overflowing} |`),
    "",
    "Tells the judge saw most:",
    "",
    ...s.map((a) => `- **${a.arm}:** ${a.tells.map(([t, n]) => `${t} (${n})`).join("; ") || "none"}`),
    "",
  ];
  return lines.join("\n");
}
