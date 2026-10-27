// SPDX-License-Identifier: AGPL-3.0-or-later
// The build-quality bench: build the same frozen requests under different setups (arms), show each tool
// with the same data, and compare. See bench/README.md.
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ARMS } from "./lib/arms.ts";
import { loadCases } from "./lib/cases.ts";
import { judgeRun } from "./lib/judge.ts";
import { recheck, runBench, runOne } from "./lib/run.ts";
import { serveRun } from "./lib/serve.ts";
import { summaryMarkdown } from "./lib/summary.ts";
import { setHidden, visibleResults } from "./lib/view.ts";

const USAGE = `usage: npm run bench -- <command>

  run [--arms a,b] [--cases x,y] [--reps N] [--concurrency N] [--name NAME] [--out DIR] [--no-sandbox]
        build every case under every arm (default: all arms, all cases, 1 repetition, 3 at a time);
        a run that's started again with the same name keeps what's done
  judge <run> [--model M] [--again]    score the screenshots with a model (and each arm's sameness)
  serve <run> [--port N]               the gallery, live tools, the blind vote and the summary
  report <run>                         write <run>/summary.md
  recheck <run>                        redo the phone-overflow check and the click-through on finished, visible results
  hide <run> a,b  |  show <run> a,b     take arms out of (or back into) the gallery, vote, score page, summary and judge
  list                                 arms and cases

  <run> is a run's name (under --out) or its directory. --out defaults to $HEWN_BENCH_DIR or ~/hewn-bench.`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    arms: { type: "string" },
    cases: { type: "string" },
    reps: { type: "string", default: "1" },
    concurrency: { type: "string", default: "3" },
    name: { type: "string" },
    out: { type: "string", default: process.env.HEWN_BENCH_DIR ?? join(homedir(), "hewn-bench") },
    "no-sandbox": { type: "boolean", default: false },
    model: { type: "string" },
    again: { type: "boolean", default: false },
    port: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, arg] = positionals;
const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const runDir = (name?: string) => {
  if (!name) throw new Error("which run? (its name or directory)");
  return name.includes("/") ? resolve(name) : join(resolve(o.out!), name);
};

try {
  if (o.help || !command) console.log(USAGE);
  else if (command === "one") {
    // A STOP file in the run: results not started yet don't start (the run can be resumed later).
    const dir = resolve(arg);
    if (existsSync(join(dir, "..", "..", "..", "..", "STOP"))) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "failed", error: "stopped: the run has a STOP file", builds: [], startedAt: new Date().toISOString() }, null, 2));
    } else await runOne(dir);
  }
  else if (command === "run") {
    const dir = await runBench({
      out: o.out!,
      name: o.name ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"),
      arms: list(o.arms) ?? ARMS.map((a) => a.name),
      cases: list(o.cases),
      reps: Number(o.reps),
      concurrency: Number(o.concurrency),
      sandbox: !o["no-sandbox"],
    });
    writeFileSync(join(dir, "summary.md"), summaryMarkdown(dir));
    console.log(`\nnext: npm run bench -- judge ${dir}\n      npm run bench -- serve ${dir}`);
  } else if (command === "judge") {
    const dir = runDir(arg);
    await judgeRun(dir, { model: o.model, again: o.again });
    writeFileSync(join(dir, "summary.md"), summaryMarkdown(dir));
  } else if (command === "serve") {
    const server = await serveRun(runDir(arg), { port: o.port ? Number(o.port) : 7790 });
    console.log(`gallery: ${server.web}/   blind vote: ${server.web}/vote   summary: ${server.web}/summary`);
  } else if (command === "report") {
    const dir = runDir(arg);
    writeFileSync(join(dir, "summary.md"), summaryMarkdown(dir));
    console.log(summaryMarkdown(dir));
  } else if (command === "recheck") {
    const dir = runDir(arg);
    for (const r of visibleResults(dir).filter((x) => x.result?.status === "done")) {
      const after = await recheck(r.dir);
      console.log(`${r.result!.arm} / ${r.result!.case} / r${r.result!.rep}: phone overflow ${r.result!.overflowMobile ?? "–"} → ${after?.overflowMobile}px, broken clicks ${r.result!.clicks?.failures.length ?? "–"} → ${after?.clicks?.failures.length}`);
    }
    writeFileSync(join(dir, "summary.md"), summaryMarkdown(dir));
  } else if (command === "hide" || command === "show") {
    const arms = list(positionals[2]);
    if (!arms?.length) throw new Error(`which arms? npm run bench -- ${command} <run> a,b`);
    console.log(`hidden: ${setHidden(runDir(arg), arms, command === "hide").join(", ") || "none"}`);
  } else if (command === "list") {
    console.log("arms:");
    for (const a of ARMS) console.log(`  ${a.name.padEnd(26)} ${a.about}`);
    console.log("cases:");
    for (const c of await loadCases()) console.log(`  ${c.id.padEnd(26)} ${c.purpose}`);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
