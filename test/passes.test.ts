// SPDX-License-Identifier: AGPL-3.0-or-later
// A new tool's passes: once its candidate validates, the builder's session goes on with screenshots of
// it (the critique), then with fresh ones and what was measured on them (the craft pass), each
// validated in turn; a pass that doesn't leave a valid candidate keeps the one before it. Only creates
// run them; the host's builder gets them as attempts marked `pass`.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { fromBase64, text, toBase64 } from "@hewntools/core/files.ts";
import { CRITIQUE_REQUEST, passRequest } from "@hewntools/core/passes.ts";
import type { BuildStepState } from "@hewntools/core/platform/builds.ts";
import type { CheckResult } from "@hewntools/core/ports.ts";
import { builderPrompt, claudeArgs, resumePrompt } from "@hewntools/cli/builders/cli.ts";
import { remoteBuilder } from "@hewntools/cli/builders/remote.ts";
import { CHECK_DIR, openCheck } from "@hewntools/cli/builders/check.ts";
import { MAX_CHECKS } from "@hewntools/core/platform/validation.ts";
import { findBrowser, launchBrowser } from "@hewntools/cli/visual.ts";
import type { BuildJob, CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { readConfig, writeConfig } from "@hewntools/cli/config.ts";
import type { VisualCheck } from "@hewntools/cli/visual.ts";
import { settingsProblems } from "@hewntools/host-workerd/surface/host.ts";
import { FIXTURES, installFrom, platformWith, type Script, serve, setup } from "./helpers.ts";

/** The renders a fake visual check returns: each screen and scheme, the phone's light page in two parts. */
const SHOTS = ["desktop-light", "desktop-dark", "mobile-light", "mobile-light-2", "mobile-dark"];
/** Which version of the UI a render shows: the marker in its index.html. */
const marker = (uiDir: string) => (existsSync(join(uiDir, "index.html")) && /<!-- (v:[a-z0-9-]+) -->/.exec(readFileSync(join(uiDir, "index.html"), "utf8"))?.[1]) || "v:none";
/** A visual check that renders nothing: its images and the build page's screenshot name the UI they show, and it measures a defect when asked. */
const fakeVisual = (seen: { measure?: boolean; ui: string }[] = []): VisualCheck => async (req) => {
  // The widget sheet: drawn, no screen.
  if (req.widgets) return { errors: [], screenshot: Buffer.from("widgets") };
  const ui = marker(req.uiDir);
  seen.push({ measure: req.measure, ui });
  return { errors: [], screenshot: Buffer.from(`page ${ui}`), shots: SHOTS.map((name) => ({ name, png: Buffer.from(`${name} ${ui}`) })), ...(req.measure ? { defects: [`Drawn over each other on the phone (390 px): "›" (span.chev) covers "Repot" (span.chip) in ${ui}`] } : {}) };
};

/** The UI Counter in the workspace, its screen marked `v`. */
const counter = (v: string): Script => (ws) => {
  cpSync(join(FIXTURES, "ui-counter"), ws, { recursive: true });
  markUi(ws, v);
};
const markUi = (ws: string, v: string) => {
  const page = join(ws, "ui", "index.html");
  writeFileSync(page, readFileSync(page, "utf8").replace(/<!-- v:[a-z0-9-]+ -->|$/, `<!-- ${v} -->`));
};
/** What the critique asked, and whether the workspace had OWNERS_WORDS.md then. */
const critiqueSeen = (into: { ownersWords: boolean; request: string }[]): Script => (ws, job) => void (job.pass?.name === "critique" && into.push({ ownersWords: existsSync(join(ws, "OWNERS_WORDS.md")), request: job.pass.request }));
/** A test case that can't pass: validation fails. */
const breakTests = (ws: string) => writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "get", operation: "get", input: {}, expect: { count: 5 } }]));

describe("passes after a new tool's build", () => {
  let t: ReturnType<typeof setup>;
  let seen: { measure?: boolean; ui: string }[];
  beforeEach(() => {
    seen = [];
    t = setup({ visualCheck: fakeVisual(seen), attempts: 3, buildPasses: () => ["critique", "craft"] });
  });
  afterEach(() => t.cleanup());

  const create = () => t.platform.create(USER, { name: "UI Counter", purpose: "Count.", requirements: "A counter." });
  /** Start a create, follow its steps, and wait for it to end. */
  const follow = async (...scripts: Script[]) => {
    t.queue(...scripts);
    const started = await create();
    const steps: BuildStepState[] = [];
    if (started.step) steps.push(started.step);
    await t.platform.waitForBuild(USER, started.buildId, { timeoutMs: 60_000, onStep: (s) => steps.push(s) });
    return { view: await t.platform.settle(started.buildId), steps };
  };
  const ui = async (id: string) => {
    const cap = t.platform.registry.getCapability(id)!;
    return text((await t.platform.loadVersion(id, cap.activeVersion!)).files["ui/index.html"]);
  };

  test("the critique, then the craft pass: each resumes with screenshots of the candidate before it, and is validated; the drawer names the steps", async () => {
    const jobs: { attempt: number; pass?: string; request?: string; shots: string[]; check: boolean; feedback?: string }[] = [];
    const record: Script = (ws, job) => void jobs.push({ attempt: job.attempt, pass: job.pass?.name, request: job.pass?.request, shots: existsSync(join(ws, "screenshots")) ? readdirSync(join(ws, "screenshots")).sort() : [], check: !!job.check, ...(job.feedback ? { feedback: job.feedback } : {}) });
    const { view, steps } = await follow(
      (ws, job) => (record(ws, job), counter("v:build")(ws, job)),
      (ws, job) => (record(ws, job), markUi(ws, "v:critique")),
      (ws, job) => (record(ws, job), markUi(ws, "v:craft")),
    );
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.match(await ui("ui-counter"), /v:craft/, "the craft pass's screen went live");
    // One session: attempt numbers go on, each pass is marked, each may check its work.
    assert.deepEqual(jobs.map((j) => [j.attempt, j.pass ?? "build", j.check]), [[1, "build", true], [2, "critique", true], [3, "craft", true]]);
    // Each pass sees the candidate before it, whole (the long page in parts): what the build left, then what the critique left.
    const files = SHOTS.map((s) => `${s}.png`).sort();
    assert.deepEqual(jobs[1].shots, files);
    assert.deepEqual(jobs[2].shots, files);
    assert.equal(jobs[1].request, passRequest("critique", { files: SHOTS.map((s) => `screenshots/${s}.png`), sampled: true, defects: [], ownersWords: false, otherTools: false }));
    assert.ok(jobs[1].request!.startsWith(CRITIQUE_REQUEST));
    assert.match(jobs[1].request!, /screenshots\/mobile-light-2\.png[^]*A long page comes in parts, top to bottom/);
    // The craft pass is told what was measured on the critique's screen (filled with its sample data): measured only for it, not on the build's.
    assert.match(jobs[2].request!, /^Craft pass\.[^]*covers "Repot" \(span\.chip\) in v:critique/);
    assert.deepEqual(seen.map((s) => [s.ui, !!s.measure]), [["v:build", false], ["v:build", false], ["v:critique", false], ["v:critique", true], ["v:craft", false], ["v:craft", false]], "each validation renders it empty, then filled");
    // What the screenshots showed stays out of the version; the build page shows the screen that went live.
    const cap = t.platform.registry.getCapability("ui-counter")!;
    assert.ok(!Object.keys((await t.platform.loadVersion("ui-counter", cap.activeVersion!)).files).some((p) => p.startsWith("screenshots/")));
    assert.equal(text((await t.platform.blobs.get(`screenshots/${view.buildId}.png`))!), "page v:craft");
    // The log: the build's attempt, each pass's run and validation, and where it went live.
    assert.ok(view.log.some((l) => /^critique pass: builder script finished/.test(l)), view.log.join("\n"));
    assert.ok(view.log.some((l) => /^craft pass: 2 test cases passed/.test(l)), view.log.join("\n"));
    assert.ok(view.log.some((l) => /^craft pass: promoted: implementation v1 is now active/.test(l)), view.log.join("\n"));
    assert.deepEqual(view.tests, { passed: 2, total: 2 });
    // The drawer's steps: the passes listed from the start, each live in turn after the tests.
    assert.deepEqual(steps[0].passes, ["critique", "craft"]);
    const order = steps.map((s) => s.step).filter((s, i, all) => s !== all[i - 1]);
    assert.deepEqual(order, ["code", "tests", "critique", "craft", "done"]);
    assert.ok(steps.some((s) => s.step === "craft" && s.tests?.total === 2), "a pass's own tests show on its step");
  });

  test("the critique points at OWNERS_WORDS.md when the owner asked for the tool in the chat", async () => {
    const critiques: { ownersWords: boolean; request: string }[] = [];
    const record = critiqueSeen(critiques);
    const conversation = [{ role: "user" as const, content: "a counter for my push-ups" }];
    const owners = await t.build(() => t.platform.create(USER, { name: "UI Counter", purpose: "Count.", requirements: "A counter.", conversation }), counter("v:build"), (ws, job) => (record(ws, job), markUi(ws, "v:critique")), (ws) => markUi(ws, "v:craft"));
    assert.equal(owners.status, "promoted", owners.log.join("\n"));
    assert.ok(critiques[0].ownersWords, "the file is in the workspace");
    assert.match(critiques[0].request, /THE OWNER'S OWN WORDS in OWNERS_WORDS\.md\./, "and the critique points at it");
  });

  test("an agent's build has no OWNERS_WORDS.md, and its critique doesn't mention one", async () => {
    const critiques: { ownersWords: boolean; request: string }[] = [];
    const record = critiqueSeen(critiques);
    const agents = await t.build(() => t.platform.create(t.claude, { name: "UI Counter", purpose: "Count.", requirements: "A counter." }), counter("v:build"), (ws, job) => (record(ws, job), markUi(ws, "v:critique")), (ws) => markUi(ws, "v:craft"));
    assert.equal(agents.status, "promoted", agents.log.join("\n"));
    assert.equal(critiques[0].ownersWords, false);
    assert.doesNotMatch(critiques[0].request, /OWNER'S OWN WORDS|OWNERS_WORDS/);
  });

  test("each step's time is Hewn's own: writing code counts all of it (checks too), and each pass is timed", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { view, steps } = await follow(
      async (ws, job) => {
        counter("v:build")(ws, job);
        await sleep(300);
        await job.check!("c1");
        await sleep(300);
      },
      async (ws) => void (markUi(ws, "v:critique"), await sleep(400)),
      async (ws) => void (markUi(ws, "v:craft"), await sleep(200)),
    );
    assert.equal(view.status, "promoted", view.log.join("\n"));
    const last = steps.at(-1)!;
    assert.ok(last.seconds.code! >= 0.6, `writing code, across its check: ${last.seconds.code}`);
    assert.ok(last.seconds.critique! >= 0.4, `the critique: ${last.seconds.critique}`);
    assert.ok(last.seconds.craft! >= 0.2, `the craft pass: ${last.seconds.craft}`);
    assert.ok(last.seconds.tests! < 0.6, `the tests are timed apart: ${last.seconds.tests}`);
    // Each step state carries them, so a page opened at any point shows the same.
    const atCraft = steps.find((s) => s.step === "craft")!;
    assert.equal(atCraft.seconds.code, last.seconds.code);
  });

  test("a pass that doesn't validate after its tries fails the build like an attempt: it says which step and what, nothing goes live, and a retry builds it again", async () => {
    const { view } = await follow(counter("v:build"), (ws) => (markUi(ws, "v:critique"), breakTests(ws)), (ws, job) => {
      assert.match(job.feedback ?? "", /1 of 1 test cases failed/, "the second try gets the failure");
      assert.match(resumePrompt(job), /FAILED/);
      breakTests(ws);
    });
    assert.equal(view.status, "failed", view.log.join("\n"));
    assert.equal(t.platform.registry.getCapability("ui-counter")?.activeVersion ?? null, null, "nothing went live");
    assert.equal(view.log.at(-1), "FAILED: no valid candidate after 2 tries of the critique pass");
    assert.ok(!view.log.some((l) => l.startsWith("craft pass")), "the craft pass didn't run");
    assert.equal(view.failure?.title, "Reviewing the design: 1 of 1 tests didn't pass");
    assert.match(view.failure?.detail ?? "", /get didn't return what its test expected/);
    // Retry: the whole build again, as for any failed build.
    const again = await t.build(() => t.platform.retryBuild(USER, view.buildId), counter("v:retry"), (ws) => markUi(ws, "v:retry-critique"), (ws) => markUi(ws, "v:retry-craft"));
    assert.equal(again.status, "promoted", again.log.join("\n"));
    assert.match(await ui("ui-counter"), /v:retry-craft/);
  });

  test("the craft pass breaking fails the build too, and says so", async () => {
    const { view } = await follow(counter("v:build"), (ws) => markUi(ws, "v:critique"), (ws) => (markUi(ws, "v:craft"), breakTests(ws)), (ws) => breakTests(ws));
    assert.equal(view.status, "failed", view.log.join("\n"));
    assert.equal(t.platform.registry.getCapability("ui-counter")?.activeVersion ?? null, null);
    assert.equal(view.failure?.title, "Fixing details: 1 of 1 tests didn't pass");
  });

  test("paused by the builder's host mid-pass: the build is paused, as at any other point", async () => {
    const { view } = await follow(counter("v:build"), () => {
      throw Object.assign(new Error("This build has used its allowance."), { paused: true });
    });
    assert.equal(view.status, "failed");
    assert.equal(view.failure?.paused, true);
    assert.equal(view.failure?.detail, "This build has used its allowance.");
    assert.equal(view.log.at(-1), "PAUSED: This build has used its allowance.");
    assert.equal(t.platform.registry.getCapability("ui-counter")?.activeVersion ?? null, null);
  });

  test("a builder failing in a pass is tried again, like an attempt", async () => {
    const { view } = await follow(
      counter("v:build"),
      () => {
        throw new Error("crashed");
      },
      (ws) => markUi(ws, "v:critique"),
      (ws) => markUi(ws, "v:craft"),
    );
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.ok(view.log.includes("critique pass: builder script failed: crashed"));
    assert.match(await ui("ui-counter"), /v:craft/);
  });

  test("cancelled mid-pass: nothing goes live, and a new create of the name takes it over", async () => {
    const { view } = await follow(counter("v:build"), (_ws, job) => void t.platform.cancelBuild(USER, job.buildId));
    assert.equal(view.status, "cancelled");
    assert.equal(t.platform.registry.getCapability("ui-counter")?.activeVersion ?? null, null);
    const again = await t.build(create, counter("v:again"), (ws) => markUi(ws, "v:again-critique"), (ws) => markUi(ws, "v:again-craft"));
    assert.equal(again.status, "promoted", again.log.join("\n"));
    assert.match(await ui("ui-counter"), /v:again-craft/);
  });

  test("checks in a pass count against that pass's own cap", async () => {
    const results: CheckResult[] = [];
    const check: Script = async (_ws, job) => void results.push(await job.check!("c1"));
    const { view } = await follow(async (ws, job) => (counter("v:build")(ws, job), await check(ws, job)), async (ws, job) => (markUi(ws, "v:critique"), await check(ws, job)), (ws) => markUi(ws, "v:craft"));
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.deepEqual(results.map((r) => r.passed), [true, true]);
    // A check shows the top of a long page: four images, whatever its length; the rest in files beside them.
    assert.deepEqual(results[1].images.map((i) => i.name), ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"]);
    assert.deepEqual(results[1].parts?.map((i) => i.name), ["mobile-light-2"]);
    assert.match(results[1].text, /A long page shows its top part; the rest is in screenshots\/mobile-light-2\.png \(top to bottom\): open those to see it\./);
  });

  test("a check's further parts stay within their budget: what doesn't fit is left out, never the top images", async () => {
    const heavy = setup({ attempts: 1, visualCheck: async () => ({ errors: [], screenshot: Buffer.from("x"), shots: ["desktop-light", "desktop-light-2", "desktop-light-3", "mobile-light", "mobile-light-2"].map((name) => ({ name, png: Buffer.alloc(4_000_000) })) }) });
    try {
      let r: CheckResult | undefined;
      const b = await heavy.build(() => heavy.platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" }), async (ws, job) => void (counter("v:build")(ws, job), (r = await job.check!("c1"))));
      assert.equal(b.status, "promoted", b.log.join("\n"));
      assert.deepEqual(r!.images.map((i) => i.name), ["desktop-light", "mobile-light"]);
      assert.deepEqual(r!.parts?.map((i) => i.name), ["desktop-light-2", "desktop-light-3"], "10 MB: two of three");
      assert.doesNotMatch(r!.text, /mobile-light-2/);
    } finally {
      heavy.cleanup();
    }
  });

  test("a check on this machine writes every part to screenshots/, none left from before, and attaches the top ones", async () => {
    const ws = mkdtempSync(join(tmpdir(), "hewn-parts-"));
    mkdirSync(join(ws, "screenshots"));
    writeFileSync(join(ws, "screenshots", "mobile-light-3.png"), "a pass's, from before");
    const check = openCheck(ws, async () => ({ passed: true, text: "PASS", failures: [], defects: [], images: [{ name: "mobile-light", png: Buffer.from("top") }], parts: [{ name: "mobile-light-2", png: Buffer.from("rest") }] }));
    try {
      writeFileSync(join(ws, CHECK_DIR, "requests", "c1.json"), "{}");
      const result = join(ws, CHECK_DIR, "results", "c1.json");
      for (let i = 0; i < 100 && !existsSync(result); i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(JSON.parse(readFileSync(result, "utf8")).images, ["c1-mobile-light.png"], "only the top is shown");
      assert.deepEqual(readdirSync(join(ws, "screenshots")).sort(), ["mobile-light-2.png", "mobile-light.png"]);
      assert.equal(readFileSync(join(ws, "screenshots", "mobile-light-2.png"), "utf8"), "rest");
    } finally {
      check.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a new tool with a screen needs sample data that fills it; an install brings what it has", async () => {
    const plain = (ws: string, job: BuildJob) => (counter("v:build")(ws, job), rmSync(join(ws, "sample"), { recursive: true }));
    const b = await t.build(create, plain, plain, plain);
    assert.equal(b.status, "failed");
    assert.match(b.log.join("\n"), /sample\/calls\.json is missing: a new tool with a screen needs sample data that fills it/);
    // Installed from a directory without it: as it is.
    const dir = mkdtempSync(join(tmpdir(), "hewn-nosample-"));
    cpSync(join(FIXTURES, "ui-counter"), dir, { recursive: true });
    rmSync(join(dir, "sample"), { recursive: true });
    try {
      const installed = await installFrom(t.platform, dir, "UI Counter");
      assert.equal(installed.status, "promoted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pass's run has its own ten checks, as every run of the builder: an eleventh is refused", async () => {
    const results: CheckResult[] = [];
    const { view } = await follow(counter("v:build"), async (ws, job) => {
      markUi(ws, "v:critique");
      for (let i = 1; i <= MAX_CHECKS + 1; i++) results.push(await job.check!(`c${i}`));
    }, (ws) => markUi(ws, "v:craft"));
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.deepEqual(results.slice(0, MAX_CHECKS).map((r) => r.passed), Array(MAX_CHECKS).fill(true));
    assert.match(results[MAX_CHECKS].text, /No checks left: this attempt has had its 10/);
  });

  test("only new tools run them: not a change, not an install, not a connection, not a tool without a screen", async () => {
    // A tool with a screen, built: the passes run.
    const made = await t.build(create, counter("v:build"), (ws) => markUi(ws, "v:critique"), (ws) => markUi(ws, "v:craft"));
    assert.equal(made.status, "promoted", made.log.join("\n"));
    // A change: one attempt, no passes (a second queued script would be left over).
    const changed = await t.build(() => t.platform.modify(USER, { capabilityId: "ui-counter", request: "say hi" }), (ws) => markUi(ws, "v:change"));
    assert.equal(changed.status, "promoted", changed.log.join("\n"));
    assert.ok(!changed.log.some((l) => / pass: /.test(l)), changed.log.join("\n"));
    assert.equal(changed.step?.passes, undefined);
    // An install from a directory (no builder runs).
    const installed = await installFrom(t.platform, join(FIXTURES, "widget-counter"));
    assert.ok(!installed.log.some((l) => / pass: /.test(l)), installed.log.join("\n"));
    // No screen: nothing to look at, so the passes are dropped from its steps.
    const steps: BuildStepState[] = [];
    t.queue((ws, job) => {
      cpSync(join(FIXTURES, "widget-counter"), ws, { recursive: true });
      const manifest = join(ws, "capability.json");
      writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), id: job.capabilityId }));
    });
    const plain = await t.platform.create(USER, { name: "Widget Counter Two", purpose: "x", requirements: "x" });
    await t.platform.waitForBuild(USER, plain.buildId, { timeoutMs: 60_000, onStep: (s) => steps.push(s) });
    const done = await t.platform.settle(plain.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(!done.log.some((l) => / pass: /.test(l)), done.log.join("\n"));
    assert.equal(steps.at(-1)?.passes, undefined, "dropped once it was clear there's nothing to look at");
    // A connection has no screen: none planned.
    t.queue((ws) => void cpSync(join(FIXTURES, "site-connection"), ws, { recursive: true }));
    const conn = await t.platform.create(USER, { name: "Site Connection", purpose: "x", requirements: "x", kind: "connection" });
    assert.equal(conn.step?.passes, undefined);
    await t.platform.settle(conn.buildId);
  });

  // The build page (build.js) in a real browser: the visual check on Linux is P2 (#4), as in visual.test.ts.
  const browser = process.platform === "darwin" ? findBrowser() : undefined;
  test("the build page names the passes as steps, times each one by Hewn's clock (the running one counting up), and keeps them at your authorization", { skip: !browser && "no Chromium-based browser on this machine", timeout: 120_000 }, async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    t.queue(
      (ws, job) => {
        counter("v:build")(ws, job);
        // A host to approve: the tool needs you once it's built.
        const manifest = join(ws, "capability.json");
        writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), requires: { hosts: ["api.example.com"] } }));
      },
      async (ws) => (markUi(ws, "v:critique"), await gate),
      (ws) => markUi(ws, "v:craft"),
    );
    const server = await serve(t.platform, t.home);
    const web = `http://hewn.localhost:${(server.address() as AddressInfo).port}`;
    const b = await launchBrowser(browser!);
    try {
      const started = await create();
      for (let i = 0; t.platform.getBuild(USER, started.buildId).step?.step !== "critique"; i++) {
        assert.ok(i < 200, "the critique starts");
        await new Promise((r) => setTimeout(r, 50));
      }
      const page = await b.page({ name: "desktop", width: 1280, height: 900, mobile: false, scale: 1 });
      await page.goto(`${web}/auth?ticket=${t.platform.createWebTicket(USER)}`);
      await page.goto(`${web}/#/b/${started.buildId}`);
      const rows = () => page.eval<[string, string, string][]>(`[...document.querySelectorAll("ol.steps li")].map((li) => [li.className.replace("step ", ""), (li.children[0].querySelector("summary") ?? li.children[0]).textContent.trim(), li.querySelector(".meta").textContent])`);
      const during = await rows();
      assert.deepEqual(during.map(([state, label]) => [state, label]), [["done", "Spec agreed"], ["done", "Writing code"], ["done", "Running tests"], ["live", "Reviewing the design"], ["todo", "Fixing details"], ["todo", "Your authorization"]]);
      for (const [, label, meta] of during.slice(0, 4)) assert.match(meta, /^\d+:\d\d$/, `${label} is timed`);
      // The running step counts up between the states Hewn sends.
      const secs = (m: string) => Number(m.split(":")[0]) * 60 + Number(m.split(":")[1]);
      await new Promise((r) => setTimeout(r, 2200));
      assert.ok(secs((await rows())[3][2]) >= secs(during[3][2]) + 2, "the running step's time counts up");
      release();
      await t.platform.settle(started.buildId);
      // Built; it needs a host approved: the page shows your step, the passes and their times still there.
      for (let i = 0; i < 100 && !(await rows()).some(([state, label]) => state === "live" && label === "Your authorization"); i++) await new Promise((r) => setTimeout(r, 100));
      const after = await rows();
      assert.deepEqual(after.map(([state, label]) => [state, label]), [["done", "Spec agreed"], ["done", "Writing code"], ["done", "Running tests"], ["done", "Reviewing the design"], ["done", "Fixing details"], ["live", "Your authorization"]]);
      for (const [, label, meta] of after.slice(1, 5)) assert.ok(meta, `${label} keeps its time`);
    } finally {
      await b.close();
      server.close();
    }
  });

  test("turned off, a create runs none; craft alone measures the build's own screen", async () => {
    const off = setup({ visualCheck: fakeVisual(), attempts: 1, buildPasses: () => [] });
    try {
      const b = await off.build(() => off.platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" }), counter("v:build"));
      assert.equal(b.status, "promoted", b.log.join("\n"));
      assert.ok(!b.log.some((l) => / pass: /.test(l)));
    } finally {
      off.cleanup();
    }
    const measured: { measure?: boolean; ui: string }[] = [];
    const craft = setup({ visualCheck: fakeVisual(measured), attempts: 1, buildPasses: () => ["craft"] });
    try {
      let asked = "";
      const b = await craft.build(() => craft.platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" }), counter("v:build"), (ws, job) => ((asked = job.pass!.request), markUi(ws, "v:craft")));
      assert.equal(b.status, "promoted", b.log.join("\n"));
      assert.deepEqual(measured.map((s) => [s.ui, !!s.measure]), [["v:build", false], ["v:build", true], ["v:craft", false], ["v:craft", false]]);
      assert.match(asked, /covers "Repot" \(span\.chip\) in v:build/);
    } finally {
      craft.cleanup();
    }
  });
});

describe("a pass, as the builder is asked", () => {
  const job = (o: Partial<BuildJob> = {}): BuildJob => ({ buildId: "b-1", capabilityId: "plants", kind: "create", workspace: "/tmp/ws", attempt: 2, logPath: "/tmp/b-1.log", pass: { name: "critique", request: "Design review pass. Look." }, ...o });

  test("resumed: the pass's request; a later try of it: the failure", () => {
    assert.equal(resumePrompt(job()), "Design review pass. Look.\n\nIf you haven't read all of BRIEF.md, read it before you change anything. Only change files inside this directory. When it's complete, stop.");
    assert.match(resumePrompt(job({ attempt: 3, feedback: "1 of 2 test cases failed" })), /^Attempt 3\. The platform validated your candidate and it FAILED:\n\n1 of 2 test cases failed/);
    const args = claudeArgs(job(), { id: "s-1", resume: true });
    assert.equal(args[args.indexOf("-p") + 1], resumePrompt(job()));
    assert.equal(args[args.indexOf("--resume") + 1], "s-1");
  });

  test("in a fresh session: the brief first, then the pass on the candidate as it is (not the icon again)", () => {
    const p = builderPrompt(job());
    assert.match(p, /Read BUILDER\.md, the request, then BRIEF\.md, all of it/);
    assert.match(p, /Read BUILDER\.md for the request and BRIEF\.md for the contract, then do this critique pass on it/);
    assert.match(p, /The candidate in this workspace is built and passed validation: don't start over\.[^]*critique pass on it:\n\nDesign review pass\. Look\./);
    assert.doesNotMatch(p, /write ui\/icon\.svg/);
    assert.match(builderPrompt(job({ pass: undefined, attempt: 1 })), /write ui\/icon\.svg/);
  });

  test("the critique points at the owner's words and the other tools' looks when there are some; the craft pass gets what was measured", () => {
    const files = ["screenshots/desktop-light.png", "screenshots/mobile-light.png"];
    const critique = passRequest("critique", { files, sampled: true, ownersWords: true, otherTools: true });
    assert.match(critique, /THE OWNER'S OWN WORDS in OWNERS_WORDS\.md/);
    assert.match(critique, /OTHER_TOOLS\.md/);
    assert.doesNotMatch(critique, /no sample data|in parts/);
    assert.doesNotMatch(passRequest("critique", { files, sampled: false }), /OWNER'S OWN WORDS|OTHER_TOOLS/);
    assert.match(passRequest("critique", { files, sampled: false }), /no sample data \(sample\/calls\.json\), so they show it empty/);
    const craft = passRequest("craft", { files, sampled: true, defects: ["Sticks out on the phone (390 px): div.row"] });
    assert.match(craft, /^Craft pass\.[^]*Measured on this UI:\n- Sticks out on the phone/);
    assert.doesNotMatch(craft, /OWNER'S OWN WORDS/);
  });
});

describe("buildPasses, the setting", () => {
  test("a list of the passes Hewn knows, both by default", () => {
    const base = { builder: "claude", intake: "claude", maxBuildAttempts: 3, sandbox: true, logRetentionDays: 14 };
    assert.deepEqual(settingsProblems({ ...base, buildPasses: ["critique", "craft"] }), []);
    assert.deepEqual(settingsProblems({ ...base, buildPasses: [] }), []);
    assert.match(settingsProblems({ ...base, buildPasses: ["polish"] }).join(), /buildPasses must be a list of "critique" and "craft"/);
    assert.match(settingsProblems({ ...base, buildPasses: "craft" }).join(), /buildPasses/);
    const t = setup();
    try {
      assert.deepEqual(readConfig(t.home).buildPasses, ["critique", "craft"]);
      writeConfig(t.home, { buildPasses: ["craft"] });
      assert.deepEqual(readConfig(t.home).buildPasses, ["craft"]);
    } finally {
      t.cleanup();
    }
  });
});

describe("the host's builder: a pass is an attempt marked `pass`", () => {
  let server: Server;
  const sent: any[] = [];
  before(async () => {
    // A service that knows nothing of passes: it builds what the prompt says, the same as any attempt.
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      sent.push(body);
      const files: Record<string, string> = { ...body.files };
      if (body.attempt === 1) for (const [p, b] of Object.entries(readTreeB64(join(FIXTURES, "ui-counter")))) files[p] = b;
      const page = text(fromBase64(files["ui/index.html"]));
      files["ui/index.html"] = toBase64(new TextEncoder().encode(`${page.replace(/<!-- v:[a-z-]+ -->/, "")}<!-- v:${body.pass ?? "build"} -->`));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end([{ activity: "→ Edit ui/index.html" }, { files }, { done: true }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });
  after(() => server.close());

  test("each pass goes over today's protocol, with `pass`, the same session and its screenshots in the workspace; the service needn't know it", async () => {
    const t = setup();
    const builder: CapabilityBuilder = remoteBuilder({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, token: "t", label: "Test Cloud" });
    const platform = platformWith(t.home, () => builder, { visualCheck: fakeVisual(), attempts: 3, buildPasses: () => ["critique", "craft"] });
    try {
      const done = await platform.settle((await platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" })).buildId);
      assert.equal(done.status, "promoted", done.log.join("\n"));
      assert.deepEqual(sent.map((b) => [b.attempt, b.pass ?? null, b.session]), [[1, null, done.buildId], [2, "critique", done.buildId], [3, "craft", done.buildId]]);
      // A service that resumes its session sends what a local builder says then: the pass's request, not the whole prompt again.
      assert.equal(sent[0].resumePrompt, undefined);
      assert.match(sent[1].resumePrompt, /^Design review pass\.[^]*Only change files inside this directory\. When it's complete, stop\.$/);
      assert.match(sent[2].resumePrompt, /^Craft pass\./);
      assert.ok(!Object.keys(sent[0].files).some((p) => p.startsWith("screenshots/")));
      assert.deepEqual(Object.keys(sent[1].files).filter((p) => p.startsWith("screenshots/")).sort(), SHOTS.map((s) => `screenshots/${s}.png`).sort());
      // A stateless service gets the whole prompt, a fresh session can work from: the brief, that the
      // candidate is built (not to start over), what the pass asks and where its screenshots are.
      for (const [i, pass] of [[1, "critique"], [2, "craft"]] as const) {
        const prompt: string = sent[i].prompt;
        assert.match(prompt, /^You are a builder for Hewn[^]*Read BUILDER\.md/);
        assert.match(prompt, new RegExp(`The candidate in this workspace is built and passed validation: don't start over\\.[^]*${pass} pass on it:\\n\\n${pass === "critique" ? "Design review pass" : "Craft pass"}\\.`));
        assert.match(prompt, /The screenshots: screenshots\/desktop-light\.png, [^]*screenshots\/mobile-dark\.png\./);
        assert.doesNotMatch(prompt, /write ui\/icon\.svg/);
      }
      const cap = platform.registry.getCapability("ui-counter")!;
      assert.match(text((await platform.loadVersion("ui-counter", cap.activeVersion!)).files["ui/index.html"]), /v:craft/);
    } finally {
      platform.close();
      t.cleanup();
    }
  });
});

/** A directory's files, base64, as the service sends a workspace. */
function readTreeB64(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) readTreeB64(p, base, out);
    else out[p.slice(base.length + 1)] = readFileSync(p).toString("base64");
  }
  return out;
}
