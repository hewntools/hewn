// SPDX-License-Identifier: AGPL-3.0-or-later
// Polish: the owner asks for a second look at a tool already live. A change that runs the critique,
// then the craft pass, on the tool filled with its sample data; one without any has its builder write
// it first. The owner's own data only when they tick it. A failed pass fails the build, so the tool
// stays at its version. Owner only; the host's builder gets it over today's protocol.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { fromBase64, text, toBase64 } from "@hewntools/core/files.ts";
import { POLISH_KEEPS, REAL_DATA_RULE } from "@hewntools/core/passes.ts";
import type { BuildStepState } from "@hewntools/core/platform/builds.ts";
import type { BuildView } from "@hewntools/core/platform.ts";
import { remoteBuilder } from "@hewntools/cli/builders/remote.ts";
import type { BuildJob, CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { findBrowser, launchBrowser, type VisualCheck } from "@hewntools/cli/visual.ts";
import { FIXTURES, installFrom, platformWith, type Script, serve, setup } from "./helpers.ts";

/** The renders a fake visual check returns: each screen and scheme, the phone's light page in two parts. */
const SHOTS = ["desktop-light", "desktop-dark", "mobile-light", "mobile-light-2", "mobile-dark"];
/** Which version of the UI a render shows: the marker in its index.html. */
const marker = (uiDir: string) => (existsSync(join(uiDir, "index.html")) && /<!-- (v:[a-z0-9-]+) -->/.exec(readFileSync(join(uiDir, "index.html"), "utf8"))?.[1]) || "v:none";
const markUi = (ws: string, v: string) => {
  const page = join(ws, "ui", "index.html");
  writeFileSync(page, readFileSync(page, "utf8").replace(/<!-- v:[a-z0-9-]+ -->|$/, `<!-- ${v} -->`));
};
/** A visual check that renders nothing: each image names the UI it shows and the count the tool showed it (sample data: 3). */
const countingVisual = (): VisualCheck => async (req) => {
  if (req.widgets) return { errors: [], screenshot: Buffer.from("widgets") };
  const { result } = (await req.invoke({ operation: "get" })) as { result: { count: number } };
  const shown = `${marker(req.uiDir)} count ${result.count}`;
  return { errors: [], screenshot: Buffer.from(`page ${shown}`), shots: SHOTS.map((name) => ({ name, png: Buffer.from(`${name} ${shown}`) })) };
};
/** A test case that can't pass: validation fails. */
const breakTests = (ws: string) => writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "get", operation: "get", input: {}, expect: { count: 5 } }]));

/** What a run of the builder was given. */
type Seen = { attempt: number; pass?: string; request?: string; feedback?: string; brief: string; shot?: string };
const recorder = (jobs: Seen[]) => (ws: string, job: BuildJob) =>
  void jobs.push({
    attempt: job.attempt,
    ...(job.pass ? { pass: job.pass.name, request: job.pass.request } : {}),
    ...(job.feedback ? { feedback: job.feedback } : {}),
    brief: readFileSync(join(ws, "BUILDER.md"), "utf8"),
    ...(existsSync(join(ws, "screenshots", "desktop-light.png")) ? { shot: readFileSync(join(ws, "screenshots", "desktop-light.png"), "utf8") } : {}),
  });

/** The UI Counter fixture without its sample data, in a folder of its own. */
function counterWithoutSample(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "hewn-polish-")), "ui-counter");
  cpSync(join(FIXTURES, "ui-counter"), dir, { recursive: true });
  rmSync(join(dir, "sample"), { recursive: true });
  return dir;
}
const writeSample = (ws: string) => cpSync(join(FIXTURES, "ui-counter", "sample"), join(ws, "sample"), { recursive: true });

describe("Polish", () => {
  let t: ReturnType<typeof setup>;
  // The setting for new tools' passes is off: a Polish runs both whatever it says.
  beforeEach(() => (t = setup({ visualCheck: countingVisual(), attempts: 3, buildPasses: () => [] })));
  afterEach(() => t.cleanup());

  /** Start a Polish, follow its steps, and wait for it to end. */
  const polish = async (req: { note?: string; realData?: boolean } = {}, ...scripts: Script[]) => {
    t.queue(...scripts);
    const started = await t.platform.polish(USER, { capabilityId: "ui-counter", ...req });
    const steps: BuildStepState[] = started.step ? [started.step] : [];
    await t.platform.waitForBuild(USER, started.buildId, { timeoutMs: 60_000, onStep: (s) => steps.push(s) });
    return { view: await t.platform.settle(started.buildId), order: steps.map((s) => s.step).filter((s, i, all) => s !== all[i - 1]), steps };
  };
  const live = async () => {
    const cap = t.platform.registry.getCapability("ui-counter")!;
    return { version: cap.activeVersion, ui: text((await t.platform.loadVersion("ui-counter", cap.activeVersion!)).files["ui/index.html"]) };
  };

  test("a tool with sample data goes straight to the passes: the critique first, in a fresh session, on the live version as it is", async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    const jobs: Seen[] = [];
    const record = recorder(jobs);
    const { view, order, steps } = await polish({}, (ws, job) => (record(ws, job), markUi(ws, "v:critique")), (ws, job) => (record(ws, job), markUi(ws, "v:craft")));
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.equal(view.kind, "modify");
    assert.deepEqual(view.request, { capabilityId: "ui-counter", request: "Polish", polish: true });
    assert.deepEqual(await live().then((l) => [l.version, /v:craft/.test(l.ui)]), [2, true]);
    // No attempt before the passes: the critique is the builder's first run (a fresh session), the craft pass resumes it.
    assert.deepEqual(jobs.map((j) => [j.attempt, j.pass]), [[1, "critique"], [2, "craft"]]);
    // It looks at the live version filled with its sample data.
    assert.equal(jobs[0].shot, "desktop-light v:none count 3");
    assert.equal(jobs[1].shot, "desktop-light v:critique count 3");
    // BUILDER.md says what a Polish is and keeps; nothing to write first. The critique says what it keeps too.
    assert.match(jobs[0].brief, /^# Build: modify `ui-counter`\n\nThis is a \*\*Polish\*\*: the tool works and is live; this build lifts its design, not what it does\. Hewn shows you screenshots of it filled with its sample data/);
    assert.ok(jobs[0].brief.includes(POLISH_KEEPS), jobs[0].brief.slice(0, 1200));
    assert.doesNotMatch(jobs[0].brief, /First, before the passes|What the owner asks of this Polish/);
    assert.ok(jobs[0].request!.includes(POLISH_KEEPS));
    assert.ok(!jobs[1].request!.includes(POLISH_KEEPS), "the craft pass doesn't redesign anyway");
    assert.doesNotMatch(jobs[0].request!, /own data/);
    // The live version was checked first, as validation does.
    assert.ok(view.log.some((l) => /^v1: 2 test cases passed/.test(l)), view.log.join("\n"));
    assert.ok(view.log.some((l) => /^craft pass: promoted: implementation v2 is now active/.test(l)), view.log.join("\n"));
    // The drawer: the passes from the start, no code step entered.
    assert.deepEqual(steps[0].passes, ["critique", "craft"]);
    assert.deepEqual(order, ["spec", "tests", "critique", "craft", "done"]);
  });

  test("without sample data, its builder writes sample/calls.json first (required), then the passes resume that session", async () => {
    await installFrom(t.platform, counterWithoutSample());
    const jobs: Seen[] = [];
    const record = recorder(jobs);
    const { view, order } = await polish(
      { note: "Make the number the main thing" },
      // Forgets it: validation says it's needed.
      (ws, job) => record(ws, job),
      (ws, job) => (record(ws, job), writeSample(ws)),
      (ws, job) => (record(ws, job), markUi(ws, "v:critique")),
      (ws, job) => (record(ws, job), markUi(ws, "v:craft")),
    );
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.deepEqual(jobs.map((j) => [j.attempt, j.pass ?? "attempt"]), [[1, "attempt"], [2, "attempt"], [3, "critique"], [4, "craft"]]);
    assert.match(jobs[0].brief, /First, before the passes: the tool has no sample data\. Write sample\/calls\.json \(see "sample\/calls\.json" below\) with made-up entries that show what it does, change nothing else, and stop\./);
    assert.match(jobs[0].brief, /\n\nWhat the owner asks of this Polish: Make the number the main thing/);
    assert.match(jobs[1].feedback!, /sample\/calls\.json is missing: a Polish shows the builder the tool filled with sample data/);
    // The passes see what it wrote.
    assert.equal(jobs[2].shot, "desktop-light v:none count 3");
    assert.deepEqual(view.request, { capabilityId: "ui-counter", request: "Polish: Make the number the main thing", note: "Make the number the main thing", polish: true });
    // The tool keeps its sample data.
    const cap = t.platform.registry.getCapability("ui-counter")!;
    assert.ok((await t.platform.loadVersion("ui-counter", cap.activeVersion!)).files["sample/calls.json"]);
    // (The first attempt's code step may come before the wait starts following it.)
    assert.deepEqual(order.slice(-6), ["tests", "code", "tests", "critique", "craft", "done"]);
  });

  test("a failed pass fails the build: nothing goes live, the tool stays at its version; Ask builder to fix polishes again (the owner's, not an agent's)", async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    const before = await live();
    const { view } = await polish({ note: "Bolder" }, breakTests, breakTests);
    assert.equal(view.status, "failed");
    assert.match(view.log.at(-1)!, /^FAILED: no valid candidate after 2 tries of the critique pass$/);
    assert.deepEqual(await live(), before, "the live version is untouched");
    // An agent can't polish again (or polish at all): the owner does.
    await assert.rejects(t.platform.retryBuild(t.claude, view.buildId), /owner/);
    const jobs: Seen[] = [];
    const record = recorder(jobs);
    const fixed = await t.build(() => t.platform.retryBuild(USER, view.buildId, { fix: true }), (ws, job) => (record(ws, job), markUi(ws, "v:critique")), (ws) => markUi(ws, "v:craft"));
    assert.equal(fixed.status, "promoted", fixed.log.join("\n"));
    assert.equal(fixed.request.polish, true);
    assert.equal(fixed.request.retryOf, view.buildId);
    assert.match(String(fixed.request.note), /^Bolder\n\n--- Fix request ---\nThe previous build failed/);
    assert.match(jobs[0].brief, /What the owner asks of this Polish: Bolder\n\n--- Fix request ---/);
    assert.equal(jobs[0].pass, "critique");
  });

  test("the owner's own data only when asked: off by default; on, the passes see a copy of it, the builder's checks still sample data, and the tool's data is untouched", async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    for (let i = 0; i < 7; i++) await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "increment" });
    const jobs: Seen[] = [];
    const record = recorder(jobs);
    // Off unless asked.
    const off = await polish({}, (ws, job) => (record(ws, job), markUi(ws, "v:a")), (ws, job) => (record(ws, job), markUi(ws, "v:b")));
    assert.equal(off.view.status, "promoted", off.view.log.join("\n"));
    assert.equal(off.view.request.realData, undefined);
    assert.equal(jobs[0].shot, "desktop-light v:none count 3");
    assert.ok(!jobs[0].request!.includes(REAL_DATA_RULE));
    // Asked for: a copy of the tool's own data fills what the passes see, and they're told it's private.
    jobs.length = 0;
    let checked: string | undefined;
    const on = await polish(
      { realData: true },
      async (ws, job) => {
        record(ws, job);
        const c = await job.check!("c1");
        checked = text(c.images.find((i) => i.name === "desktop-light")!.png);
        markUi(ws, "v:c");
      },
      (ws, job) => (record(ws, job), markUi(ws, "v:d")),
    );
    assert.equal(on.view.status, "promoted", on.view.log.join("\n"));
    assert.equal(on.view.request.realData, true);
    assert.equal(jobs[0].shot, "desktop-light v:b count 7");
    assert.equal(jobs[1].shot, "desktop-light v:c count 7");
    for (const j of jobs) assert.ok(j.request!.includes(REAL_DATA_RULE), String(j.request));
    assert.match(jobs[0].brief, /filled with a copy of the owner's own data \(they allowed it\)/);
    assert.equal(checked, "desktop-light v:b count 3", "a check shows the sample data");
    assert.ok(on.view.log.some((l) => /with a copy of your own data \(screenshot attached, with your own data\)/.test(l)), on.view.log.join("\n"));
    assert.equal(((await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "get" })) as { result: { count: number } }).result.count, 7, "its data is as it was");
  });

  test("only for a tool with a screen, by the owner", async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    await installFrom(t.platform, join(FIXTURES, "widget-counter"));
    await assert.rejects(t.platform.polish(t.claude, { capabilityId: "ui-counter" }), /owner/);
    await assert.rejects(t.platform.polish(USER, { capabilityId: "widget-counter" }), /widget-counter has no screen to polish/);
    await assert.rejects(t.platform.polish(USER, { capabilityId: "ui-counter", note: "x".repeat(2001) }), /note: text of at most 2000 characters/);
    await assert.rejects(t.platform.polish(USER, { capabilityId: "ui-counter", realData: "yes" as unknown as boolean }), /realData must be true or false/);
  });

  test("nothing it can render: the Polish ends saying so, and the tool stays as it was", async () => {
    const blind = setup({ attempts: 3 });
    try {
      await installFrom(blind.platform, join(FIXTURES, "ui-counter"));
      const started = await blind.platform.polish(USER, { capabilityId: "ui-counter" });
      const done = await blind.platform.settle(started.buildId);
      assert.equal(done.status, "failed");
      assert.match(done.log.at(-1)!, /^FAILED: nothing to polish: Hewn couldn't render the tool's screen/);
      assert.equal(blind.platform.registry.getCapability("ui-counter")!.activeVersion, 1);
    } finally {
      blind.cleanup();
    }
  });

  // The menu and the sheet (tool-actions.js) in a real browser, as passes.test.ts does the build page.
  const browser = process.platform === "darwin" ? findBrowser() : undefined;
  test("the tool's menu has Polish… under Change…; its sheet leaves the own data unticked, and the build page shows a Polish's steps", { skip: !browser && "no Chromium-based browser on this machine", timeout: 120_000 }, async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "increment" });
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    t.queue(async (ws) => (markUi(ws, "v:critique"), await gate), (ws) => markUi(ws, "v:craft"));
    const server = await serve(t.platform, t.home);
    const web = `http://hewn.localhost:${(server.address() as AddressInfo).port}`;
    const b = await launchBrowser(browser!);
    try {
      const page = await b.page({ name: "desktop", width: 1280, height: 900, mobile: false, scale: 1 });
      await page.goto(`${web}/auth?ticket=${t.platform.createWebTicket(USER)}`);
      await page.goto(`${web}/#/c/ui-counter`);
      await page.eval(`document.querySelector('.glass-bar button[aria-label="More"]').click()`);
      const items = await page.eval<string[]>(`[...document.querySelectorAll('.menu [role="menuitem"]')].map((b) => b.textContent)`);
      assert.deepEqual(items.slice(0, 4), ["Open", "Change…", "Polish…", "Info"]);
      await page.eval(`[...document.querySelectorAll('.menu [role="menuitem"]')].find((b) => b.textContent === "Polish…").click()`);
      let sheet: { box: { checked: boolean; disabled: boolean }; text: string } | null = null;
      for (let i = 0; i < 50 && !sheet; i++) {
        await new Promise((r) => setTimeout(r, 100));
        sheet = await page.eval(`(() => { const d = document.querySelector("dialog[open]"); const box = d?.querySelector('input[type="checkbox"]'); return box ? { box: { checked: box.checked, disabled: box.disabled }, text: d.textContent } : null })()`);
      }
      assert.ok(sheet, "the sheet opens");
      assert.deepEqual(sheet.box, { checked: false, disabled: false });
      assert.match(sheet.text, /Show the builder my own data · its screenshots then show UI Counter with your own entries instead of made-up sample data, and the builder's AI model sees them/);
      assert.match(sheet.text, /A longer build than a change: two design passes\. If one fails, nothing changes\./);
      await page.eval(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Polish").click()`);
      let started: BuildView | undefined;
      for (let i = 0; i < 100 && !(started = t.platform.registry.recentBuilds(5).map((id) => t.platform.getBuild(USER, id)).find((x) => x.request.polish && x.step?.step === "critique")); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(started, "the Polish started");
      assert.equal(started.request.realData, undefined, "unticked: not the owner's data");
      for (let i = 0; i < 50 && !(await page.eval<string>("location.hash")).startsWith("#/b/"); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(await page.eval<string>("location.hash"), `#/b/${started.buildId}`);
      let rows: [string, string][] = [];
      for (let i = 0; i < 50 && rows.length < 6; i++) {
        await new Promise((r) => setTimeout(r, 100));
        rows = await page.eval(`[...document.querySelectorAll("ol.steps li")].map((li) => [li.className.replace("step ", ""), (li.children[0].querySelector("summary") ?? li.children[0]).textContent.trim()])`);
      }
      assert.deepEqual(rows, [["done", "Spec agreed"], ["done", "Sample data"], ["done", "Running tests"], ["live", "Reviewing the design"], ["todo", "Fixing details"], ["todo", "Your authorization"]]);
      release();
      assert.equal((await t.platform.settle(started.buildId)).status, "promoted");
    } finally {
      release();
      await b.close();
      server.close();
    }
  });
});

describe("Polish on the host's builder: a change with `pass`, over today's protocol", () => {
  let server: Server;
  const sent: any[] = [];
  before(async () => {
    // A service that knows nothing of Polish: it builds what the prompt says (sample data when no pass asks for a screen).
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      sent.push(body);
      const files: Record<string, string> = { ...body.files };
      if (!body.pass) files["sample/calls.json"] = toBase64(readFileSync(join(FIXTURES, "ui-counter", "sample", "calls.json")));
      else files["ui/index.html"] = toBase64(new TextEncoder().encode(`${text(fromBase64(files["ui/index.html"])).replace(/<!-- v:[a-z-]+ -->/, "")}<!-- v:${body.pass} -->`));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end([{ activity: "→ Edit ui/index.html" }, { files }, { done: true }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });
  after(() => server.close());

  const run = async (dir: string) => {
    sent.length = 0;
    const t = setup();
    const builder: CapabilityBuilder = remoteBuilder({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, token: "t", label: "Test Cloud" });
    const platform = platformWith(t.home, () => builder, { visualCheck: countingVisual(), attempts: 3 });
    try {
      await installFrom(platform, dir);
      const done = await platform.settle((await platform.polish(USER, { capabilityId: "ui-counter" })).buildId);
      assert.equal(done.status, "promoted", done.log.join("\n"));
      const cap = platform.registry.getCapability("ui-counter")!;
      assert.match(text((await platform.loadVersion("ui-counter", cap.activeVersion!)).files["ui/index.html"]), /v:craft/);
      return done;
    } finally {
      platform.close();
      t.cleanup();
    }
  };

  test("with sample data: the critique is the first attempt, a fresh session with the whole prompt; the craft pass resumes it", async () => {
    const done = await run(join(FIXTURES, "ui-counter"));
    assert.deepEqual(sent.map((b) => [b.kind, b.attempt, b.pass ?? null, b.session]), [["modify", 1, "critique", done.buildId], ["modify", 2, "craft", done.buildId]]);
    assert.equal(sent[0].resumePrompt, undefined, "nothing to resume yet");
    assert.match(sent[0].prompt, /^You are a builder for Hewn[^]*The candidate in this workspace is built and passed validation: don't start over\.[^]*critique pass on it:\n\nDesign review pass\./);
    assert.match(text(fromBase64(sent[0].files["BUILDER.md"])), /This is a \*\*Polish\*\*/);
    assert.deepEqual(Object.keys(sent[0].files).filter((p) => p.startsWith("screenshots/")).sort(), SHOTS.map((s) => `screenshots/${s}.png`).sort());
    assert.match(sent[1].resumePrompt, /^Craft pass\./);
  });

  test("without: its first attempt writes the sample data, then both passes resume that session", async () => {
    const done = await run(counterWithoutSample());
    assert.deepEqual(sent.map((b) => [b.attempt, b.pass ?? null, b.session]), [[1, null, done.buildId], [2, "critique", done.buildId], [3, "craft", done.buildId]]);
    assert.equal(sent[0].resumePrompt, undefined);
    assert.ok(!Object.keys(sent[0].files).some((p) => p.startsWith("screenshots/")));
    assert.match(text(fromBase64(sent[0].files["BUILDER.md"])), /First, before the passes: the tool has no sample data/);
    assert.match(sent[1].resumePrompt, /^Design review pass\./);
    assert.match(sent[2].resumePrompt, /^Craft pass\./);
  });
});
