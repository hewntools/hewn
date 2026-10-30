// SPDX-License-Identifier: AGPL-3.0-or-later
// A new tool's passes: once its candidate validates, the builder's session goes on with screenshots of
// it (the critique), then with fresh ones and what was measured on them (the craft pass), each
// validated in turn; a pass that doesn't leave a valid candidate keeps the one before it. Only creates
// run them; the host's builder gets them as attempts marked `pass`.
import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type { BuildJob, CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { readConfig, writeConfig } from "@hewntools/cli/config.ts";
import type { VisualCheck } from "@hewntools/cli/visual.ts";
import { settingsProblems } from "@hewntools/host-workerd/surface/host.ts";
import { FIXTURES, installFrom, platformWith, type Script, setup } from "./helpers.ts";

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
    assert.equal(jobs[1].request, passRequest("critique", { files: SHOTS.map((s) => `screenshots/${s}.png`), sampled: false, defects: [], ownersWords: false, otherTools: false }));
    assert.ok(jobs[1].request!.startsWith(CRITIQUE_REQUEST));
    assert.match(jobs[1].request!, /screenshots\/mobile-light-2\.png[^]*A long page comes in parts, top to bottom/);
    // The craft pass is told what was measured on the critique's screen: measured only for it, not on the build's.
    assert.match(jobs[2].request!, /^Craft pass\.[^]*covers "Repot" \(span\.chip\) in v:critique/);
    assert.deepEqual(seen.map((s) => [s.ui, !!s.measure]), [["v:build", false], ["v:critique", true], ["v:craft", false]]);
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

  test("a pass that doesn't validate after its tries: the candidate before it goes live, and the passes after it don't run", async () => {
    const { view } = await follow(counter("v:build"), (ws) => (markUi(ws, "v:critique"), breakTests(ws)), (ws, job) => {
      assert.match(job.feedback ?? "", /1 of 1 test cases failed/, "the second try gets the failure");
      assert.match(resumePrompt(job), /FAILED/);
      breakTests(ws);
    });
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.match(await ui("ui-counter"), /v:build/, "the build's own screen went live");
    assert.ok(view.log.includes("critique pass: no valid candidate after 2 tries"), view.log.join("\n"));
    assert.ok(view.log.includes("critique pass: kept the candidate from before it (2 test cases passed)"), view.log.join("\n"));
    assert.ok(!view.log.some((l) => l.startsWith("craft pass")), "the craft pass didn't run");
    assert.ok(view.log.some((l) => /^attempt 1: promoted: implementation v1/.test(l)), view.log.join("\n"));
    // What the build shows is the version that went live: its tests, its screenshot.
    assert.deepEqual(view.tests, { passed: 2, total: 2 });
    assert.equal(text((await t.platform.blobs.get(`screenshots/${view.buildId}.png`))!), "page v:build");
    assert.equal(view.failure, undefined);
  });

  test("the craft pass breaking falls back to the critique's candidate", async () => {
    const { view } = await follow(counter("v:build"), (ws) => markUi(ws, "v:critique"), (ws) => (markUi(ws, "v:craft"), breakTests(ws)), (ws) => breakTests(ws));
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.match(await ui("ui-counter"), /v:critique/);
    assert.ok(view.log.some((l) => /^critique pass: promoted: implementation v1/.test(l)), view.log.join("\n"));
  });

  test("paused by the builder's host mid-pass: the candidate before it goes live (it isn't paused)", async () => {
    const { view } = await follow(counter("v:build"), () => {
      throw Object.assign(new Error("This build has used its allowance."), { paused: true });
    });
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.ok(view.log.includes("critique pass: stopped (paused: This build has used its allowance.)"), view.log.join("\n"));
    assert.ok(view.log.includes("critique pass: kept the candidate from before it (2 test cases passed)"));
    assert.ok(!view.log.some((l) => /^(PAUSED|FAILED): /.test(l)));
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
    // A check shows the top of a long page: four images, whatever its length.
    assert.deepEqual(results[1].images.map((i) => i.name), ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"]);
    assert.match(results[1].text, /A long page shows its top part\./);
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
      assert.deepEqual(measured.map((s) => [s.ui, !!s.measure]), [["v:build", true], ["v:craft", false]]);
      assert.match(asked, /covers "Repot" \(span\.chip\) in v:build/);
    } finally {
      craft.cleanup();
    }
  });
});

describe("a pass, as the builder is asked", () => {
  const job = (o: Partial<BuildJob> = {}): BuildJob => ({ buildId: "b-1", capabilityId: "plants", kind: "create", workspace: "/tmp/ws", attempt: 2, logPath: "/tmp/b-1.log", pass: { name: "critique", request: "Design review pass. Look." }, ...o });

  test("resumed: the pass's request; a later try of it: the failure", () => {
    assert.equal(resumePrompt(job()), "Design review pass. Look.\n\nOnly change files inside this directory. When it's complete, stop.");
    assert.match(resumePrompt(job({ attempt: 3, feedback: "1 of 2 test cases failed" })), /^Attempt 3\. The platform validated your candidate and it FAILED:\n\n1 of 2 test cases failed/);
    const args = claudeArgs(job(), { id: "s-1", resume: true });
    assert.equal(args[args.indexOf("-p") + 1], resumePrompt(job()));
    assert.equal(args[args.indexOf("--resume") + 1], "s-1");
  });

  test("in a fresh session: the brief first, then the pass on the candidate as it is (not the icon again)", () => {
    const p = builderPrompt(job());
    assert.match(p, /Read BUILDER\.md/);
    assert.match(p, /The candidate in this workspace is built and passed validation: don't start over\.[^]*critique pass on it:\n\nDesign review pass\. Look\./);
    assert.doesNotMatch(p, /write ui\/icon\.svg/);
    assert.match(builderPrompt(job({ pass: undefined, attempt: 1 })), /write ui\/icon\.svg/);
  });

  test("the critique points at the owner's words and the other tools' looks when there are some; the craft pass gets what was measured", () => {
    const files = ["screenshots/desktop-light.png", "screenshots/mobile-light.png"];
    const critique = passRequest("critique", { files, sampled: true, ownersWords: true, otherTools: true });
    assert.match(critique, /THE OWNER'S OWN WORDS in BUILDER\.md/);
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
      assert.ok(!Object.keys(sent[0].files).some((p) => p.startsWith("screenshots/")));
      assert.deepEqual(Object.keys(sent[1].files).filter((p) => p.startsWith("screenshots/")).sort(), SHOTS.map((s) => `screenshots/${s}.png`).sort());
      // A stateless service gets the whole prompt: the brief, then the pass.
      assert.match(sent[1].prompt, /Read BUILDER\.md[^]*critique pass on it:\n\nDesign review pass\./);
      assert.match(sent[2].prompt, /craft pass on it:\n\nCraft pass\./);
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
