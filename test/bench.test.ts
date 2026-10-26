// SPDX-License-Identifier: AGPL-3.0-or-later
// The build-quality bench (bench/): its arms still apply to today's brief, its cases load, and its
// plumbing (build, export, serve, screenshot, click through, summarize) works with a scripted builder.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { findBrowser } from "@hewntools/cli/visual.ts";
import { ARMS, briefFor, othersNote, replaceSection, runOrder } from "../bench/lib/arms.ts";
import { DESKTOP, PHONE, clickThrough, launchBrowser, layoutDefects, overflowX } from "../bench/lib/browser.ts";
import { idOf, loadCases, seedKit } from "../bench/lib/cases.ts";
import { parseJson, total } from "../bench/lib/judge.ts";
import { builderUsage, uiMetrics } from "../bench/lib/metrics.ts";
import { benchPlatform, caller, exportVersion, served, settle } from "../bench/lib/platform.ts";
import { checkOut, cleanEnv, otherTools, runOne } from "../bench/lib/run.ts";
import { summarize } from "../bench/lib/summary.ts";
import { setHidden, writeOwner } from "../bench/lib/view.ts";
import { startUiServer } from "../bench/lib/ui-server.ts";

const BRIEF = readFileSync(resolve(import.meta.dirname, "../spec/builder-brief.md"), "utf8");

describe("bench arms", () => {
  test("every arm's brief still applies to today's builder brief", () => {
    for (const arm of ARMS) {
      const brief = briefFor(arm, BRIEF);
      if (arm.brief || arm.from) assert.notEqual(brief, BRIEF, `${arm.name} builds on today's brief unchanged`);
      // The contract around the UI section is kept.
      assert.match(brief, /### Contract rules \(enforced\)/);
      assert.match(brief, /\*\*The platform renders your UI before promotion\*\*/);
    }
    assert.match(briefFor(ARMS.find((a) => a.name === "design-forward")!, BRIEF), /#### The UI is the product/);
  });

  test("a section that isn't there is an error, not a silent no-op", () => {
    assert.throws(() => replaceSection(BRIEF, "#### No such heading", "### UI", "x"), /no "#### No such heading"/);
    assert.equal(replaceSection("# a\nold\n# b\nrest", "# a", "# b", "# a\nnew"), "# a\nnew\n\n# b\nrest");
  });

  test("a sequential arm's build is told the earlier tools' names, hues and looks", () => {
    const run = mkdtempSync(join(tmpdir(), "bench-others-"));
    const tool = (c: string, manifest: object, look?: object, status = "done") => {
      const dir = join(run, c);
      mkdirSync(join(dir, "version", "ui"), { recursive: true });
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status }));
      writeFileSync(join(dir, "version", "capability.json"), JSON.stringify(manifest));
      if (look) writeFileSync(join(dir, "version", "ui", "look.json"), JSON.stringify(look));
      return dir;
    };
    const dirs = [tool("a", { name: "Plant Log", hue: 130 }, { mood: "greenhouse" }), tool("b", { name: "Spending", hue: 40, saturation: 80 }), tool("c", { name: "Broken" }, undefined, "failed")];
    const tools = otherTools(dirs);
    assert.deepEqual(tools, [{ name: "Plant Log", hue: 130, look: { mood: "greenhouse" } }, { name: "Spending", hue: 40, saturation: 80, look: undefined }]);
    const note = othersNote(tools);
    assert.match(note, /THE OWNER'S OTHER TOOLS/);
    assert.match(note, /- Plant Log \(hue 130\): \{"mood":"greenhouse"\}/);
    assert.match(note, /- Spending \(hue 40, saturation 80\): no look recorded/);
    assert.equal(othersNote([]), "");
    rmSync(run, { recursive: true, force: true });
  });

  test("an arm that starts from another runs after it", () => {
    assert.deepEqual(runOrder(["design-forward+critique"]).map((a) => a.name), ["design-forward", "design-forward+critique"]);
    assert.throws(() => runOrder(["x"], [{ name: "x", about: "", from: "y" }, { name: "y", about: "", from: "x" }]), /cycle/);
  });
});

describe("bench cases", () => {
  test("every case has a spec in the intake's shape and a seed", async () => {
    const cases = await loadCases();
    assert.ok(cases.length >= 6);
    for (const c of cases) {
      assert.match(c.requirements, /OPERATIONS/, c.id);
      assert.match(c.requirements, /\nUI sketch\n/, c.id);
      assert.equal(typeof c.seed, "function");
    }
    await assert.rejects(loadCases(["nope"]), /no case nope/);
  });

  test("seed data is the same for every arm, and dated from today", () => {
    const a = seedKit(async () => {}, 42, new Date(2026, 0, 31));
    const b = seedKit(async () => {}, 42, new Date(2026, 0, 31));
    assert.deepEqual([a.rand(), a.rand(), a.rand()], [b.rand(), b.rand(), b.rand()]);
    assert.equal(a.day(0), "2026-01-31");
    assert.equal(a.day(1), "2026-02-01");
    assert.equal(a.day(-31), "2025-12-31");
  });

  test("ids come out of plain and wrapped results", () => {
    assert.equal(idOf({ id: 3 }), 3);
    assert.equal(idOf({ plant: { id: 4 } }, "plant"), 4);
    assert.equal(idOf({ book: { id: "b1" }, tags: [] }), "b1");
    assert.equal(idOf(null), undefined);
  });
});

describe("bench metrics and judging", () => {
  test("UI metrics count the tool's own CSS, drawings and motion, not the icon", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ui-"));
    writeFileSync(join(dir, "icon.svg"), "<svg></svg>".repeat(50));
    writeFileSync(join(dir, "index.html"), `<style>.a{color:#ff0000;transition:opacity .2s}@media (prefers-reduced-motion: reduce){}</style><svg viewBox="0 0 1 1"></svg><div style="color: rgb(1, 2, 3)"></div>`);
    writeFileSync(join(dir, "app.css"), ".b{font-family: ui-serif, Georgia; color:#FF0000} :root{--display: ui-rounded, system-ui; --gap: 4px} .c{font-family: var(--display)}");
    writeFileSync(join(dir, "app.js"), `document.createElementNS(NS, "path"); barChart(el, {}); el.animate([], 100);`);
    const m = uiMetrics(dir);
    assert.equal(m.files, 3);
    assert.equal(m.svgSites, 2);
    assert.equal(m.platformCharts, 1);
    assert.equal(m.motion, 2);
    assert.equal(m.reducedMotion, true);
    assert.equal(m.colours, 2);
    assert.deepEqual(m.fonts, ["ui-serif, Georgia", "ui-rounded, system-ui"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("builder usage sums every attempt's result", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-usage-"));
    const run = (ms: number, usd: number) => [JSON.stringify({ type: "system", subtype: "init", model: "claude-x" }), "not json", JSON.stringify({ type: "result", duration_ms: ms, num_turns: 3, total_cost_usd: usd, usage: { output_tokens: 10, output_tokens_details: { thinking_tokens: 4 } } })].join("\n");
    writeFileSync(join(dir, "a1.jsonl"), run(60_000, 1.25));
    writeFileSync(join(dir, "a2.jsonl"), run(30_000, 0.5));
    assert.deepEqual(builderUsage([join(dir, "a1.jsonl"), join(dir, "a2.jsonl")]), { attempts: 2, model: "claude-x", minutes: 1.5, turns: 6, usd: 1.75, outputTokens: 20, thinkingTokens: 8 });
    rmSync(dir, { recursive: true, force: true });
  });

  test("the judge's reply is read even with prose around it; design and originality count double", () => {
    assert.deepEqual(parseJson('Here it is:\n{"a": 1, "b": {"c": 2}}\nThanks'), { a: 1, b: { c: 2 } });
    assert.throws(() => parseJson("no json"), /no JSON/);
    assert.equal(total({ design_quality: 5, originality: 6, craft: 7, usefulness: 8 }), 37);
  });

  test("the summary counts the owner's blind votes per arm", () => {
    const run = mkdtempSync(join(tmpdir(), "bench-run-"));
    const result = (arm: string, usd: number) => {
      const dir = join(run, "results", arm, "plant-log", "r1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.json"), JSON.stringify({ arm, case: "plant-log", rep: 1, status: "done", builds: [{ buildId: "b", kind: "create", status: "promoted", attempts: 1 }], usage: { attempts: 1, minutes: 5, turns: 1, usd, outputTokens: 1, thinkingTokens: 0 }, ui: { bytes: 2000, cssBytes: 1000, svgSites: 1, motion: 0 }, startedAt: "" }));
      writeFileSync(join(dir, "judge.json"), JSON.stringify({ design_quality: 5, originality: 5, craft: 5, usefulness: 5, total: 30, tells: ["pills and badges on everything"], problems: [], best: "" }));
    };
    result("current", 2);
    result("design-forward", 3);
    // The judge's view of an arm as a set sits beside its cases.
    writeFileSync(join(run, "results", "design-forward", "sameness-r1.json"), JSON.stringify({ sameness: 6, shared_traits: [], tells: [] }));
    const vote = (winner: string) => JSON.stringify({ at: "", case: "plant-log", left: { arm: "current", key: "k1" }, right: { arm: "design-forward", key: "k2" }, winner, daily: { right: true } });
    writeFileSync(join(run, "votes.jsonl"), [vote("right"), vote("right"), vote("tie")].join("\n") + "\n");
    const s = summarize(run);
    const df = s.find((a) => a.arm === "design-forward")!;
    assert.deepEqual(df.votes, { n: 3, winRate: 83, daily: 100 });
    assert.equal(s.find((a) => a.arm === "current")!.votes!.winRate, 17);
    assert.equal(df.usd, 3);
    assert.equal(df.judge!.total, 30);
    assert.equal(df.sameness, 6);
    assert.deepEqual(df.tells, [["pills and badges on everything", 1]]);
    // The owner's own scores sit beside the judge's; a hidden arm drops out of every view.
    writeOwner(join(run, "results", "design-forward", "plant-log", "r1"), { design_quality: 8, originality: 7, craft: 6, usefulness: 9 });
    assert.throws(() => writeOwner(run, { design_quality: 11, originality: 7, craft: 6, usefulness: 9 }), /design_quality must be a whole number from 1 to 10/);
    assert.deepEqual(summarize(run).find((a) => a.arm === "design-forward")!.owner, { n: 1, total: 45, design_quality: 8, originality: 7, craft: 6, usefulness: 9, judgeGap: -15 });
    writeFileSync(join(run, "run.json"), JSON.stringify({ name: "t" }));
    assert.deepEqual(setHidden(run, ["current"], true), ["current"]);
    assert.deepEqual(summarize(run).map((a) => a.arm), ["design-forward"]);
    assert.deepEqual(setHidden(run, ["current"], false), []);
    assert.equal(summarize(run).length, 2);
    rmSync(run, { recursive: true, force: true });
  });
});

describe("bench runs", () => {
  test("results don't go where Claude Code won't write, and a calling session's settings don't leak into builds", () => {
    assert.throws(() => checkOut("/Users/x/.claude/worktrees/w/out"), /\.claude/);
    checkOut("/Users/x/hewn-bench");
    const env = cleanEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_EFFORT: "xhigh", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/c", ANTHROPIC_API_KEY: "k" });
    assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "PATH"]);
  });

  // Screenshots and clicks need a browser (the platform's own visual tests run on macOS only, too).
  const browser = process.platform === "darwin" ? findBrowser() : undefined;
  test("an arm that critiques in the same result: built, captured, reviewed with its screenshots, captured again", { skip: !browser && "no Chromium-based browser on this machine", timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-one-"));
    const fixture = resolve(import.meta.dirname, "fixtures", "ui-counter");
    writeFileSync(join(dir, "brief.md"), "");
    writeFileSync(join(dir, "job.json"), JSON.stringify({ arm: "x+critique", case: "plant-log", rep: 1, brief: join(dir, "brief.md"), critique: true, sandbox: false }));
    const seen: { kind: string; shots: string[] }[] = [];
    await runOne(dir, {
      builder: {
        name: "claude",
        build: async (job) => {
          seen.push({ kind: job.kind, shots: existsSync(join(job.workspace, "screenshots")) ? readdirSync(join(job.workspace, "screenshots")).sort() : [] });
          cpSync(fixture, join(job.workspace), { recursive: true, filter: (f) => !f.endsWith("capability.json") || job.kind === "create" });
          const manifest = join(job.workspace, "capability.json");
          writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), id: job.capabilityId, name: "Plant Log" }));
        },
      },
    });
    const r = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    assert.equal(r.status, "done", r.error);
    assert.deepEqual(r.builds.map((b: { kind: string; status: string }) => `${b.kind} ${b.status}`), ["create promoted", "modify promoted"]);
    // The review saw the first version's screenshots, and they don't stay in the tool.
    assert.deepEqual(seen, [{ kind: "create", shots: [] }, { kind: "modify", shots: ["desktop-dark.png", "desktop-light.png", "mobile-dark.png", "mobile-light.png"] }]);
    assert.ok(!existsSync(join(dir, "version", "screenshots")));
    for (const f of ["desktop-light", "mobile-dark"]) {
      assert.ok(existsSync(join(dir, "shots-first", `${f}.png`)), `shots-first/${f}`);
      assert.ok(existsSync(join(dir, "shots", `${f}.png`)), `shots/${f}`);
    }
    assert.ok(r.first.ui);
    // The counter doesn't take plant-log's operations: recorded, not fatal.
    assert.match(r.seedError, /add_plant/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a scripted build is exported, seeded, served as Hewn serves it, screenshotted and clicked through", { skip: !browser && "no Chromium-based browser on this machine", timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "bench-e2e-"));
    const fixture = resolve(import.meta.dirname, "fixtures", "ui-counter");
    const bp = benchPlatform(join(root, "home"), { sandbox: false, builder: { name: "claude", build: async (job) => cpSync(fixture, job.workspace, { recursive: true }) } });
    let s: ReturnType<typeof served> | undefined;
    const server = await startUiServer((k) => (k === "r" ? s : undefined));
    const b = await launchBrowser(browser);
    try {
      const started = await bp.platform.create(USER, { name: "UI Counter", purpose: "Count.", requirements: "A counter." });
      const v = await settle(bp.platform, started.buildId);
      assert.equal(v.status, "promoted", v.log.join("\n"));
      await exportVersion(bp.platform, v.capabilityId, v.resultVersion!, join(root, "version"));
      const call = caller(bp.platform, v.capabilityId);
      for (let i = 0; i < 3; i++) await call("increment");
      s = served(bp.platform, v.capabilityId, join(root, "version"));
      const url = server.url("r", s.id);
      const desktop = await b.page(DESKTOP);
      await desktop.goto(url);
      // The seeded count is what the page shows: the shim sent /api/invoke to this tool's state.
      assert.equal(await desktop.eval("document.getElementById('n').textContent"), "3");
      const png = await desktop.shot();
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      assert.deepEqual(desktop.errors, []);
      const clicks = await clickThrough(desktop, url);
      assert.ok(clicks.clicked >= 1);
      assert.deepEqual(clicks.failures, []);
      assert.equal((await call("get")).count, 3 + clicks.clicked);
      // A button that asks with confirm() blocks the page until answered: the click-through dismisses it and goes on.
      const page = join(root, "version", "ui", "index.html");
      writeFileSync(page, readFileSync(page, "utf8").replace("</main>", `<button id="stop" onclick="if (confirm('Stop counting?')) document.title = 'stopped'">Stop</button></main>`));
      const asked = await clickThrough(desktop, url);
      assert.deepEqual(asked.dialogs, [{ label: "Stop", dialogs: ["confirm: Stop counting?"] }]);
      assert.deepEqual(asked.failures, []);
      const phone = await b.page(PHONE);
      await phone.goto(url);
      assert.equal(await overflowX(phone, PHONE.width), 0);
      // An SVG control (no .click() of its own) is clicked like any other.
      writeFileSync(page, readFileSync(page, "utf8").replace("</main>", `<svg width="40" height="40"><rect id="dot" role="button" aria-label="Dot" width="40" height="40" onclick="document.title = 'dot'"/></svg></main>`));
      const svg = await clickThrough(desktop, url);
      assert.ok(!svg.failures.some((f) => f.label === "Dot"), JSON.stringify(svg.failures));
      // Something cut off at the right edge by a page that hides what overflows still counts.
      writeFileSync(page, readFileSync(page, "utf8").replace("</main>", `<div style="width: 600px; height: 20px">wide</div></main><style>body { overflow-x: hidden }</style>`));
      await phone.goto(url);
      assert.ok((await overflowX(phone, PHONE.width)) >= 200, "clipped overflow not caught");
      // What the craft pass is told: the outermost thing that sticks out, and how far.
      const defects = await layoutDefects(phone, PHONE.width);
      assert.equal(defects.sticksOut.length, 1, JSON.stringify(defects));
      assert.match(defects.sticksOut[0], /\("wide"\): 2\d\dpx past the edge, 600px wide/);
    } finally {
      await b.close();
      await server.close();
      bp.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
