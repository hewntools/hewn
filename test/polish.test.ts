// SPDX-License-Identifier: AGPL-3.0-or-later
// Polish: the owner asks for a second look at a tool already live. A change that runs the critique,
// then the craft pass, on the tool filled with its sample data; one without any has its builder write
// it first. The owner's own data only when they tick it. A failed pass fails the build, so the tool
// stays at its version. Owner only; the host's builder gets it over today's protocol.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { fromBase64, text, toBase64 } from "@hewntools/core/files.ts";
import { POLISH_KEEPS, REAL_DATA_RULE } from "@hewntools/core/passes.ts";
import { type BuildStepState, LINE_CHARS, polishWords } from "@hewntools/core/platform/builds.ts";
import type { BuildView } from "@hewntools/core/platform.ts";
import { remoteBuilder } from "@hewntools/cli/builders/remote.ts";
import type { BuildJob, CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { findBrowser, launchBrowser, type VisualCheck } from "@hewntools/cli/visual.ts";
import { intakePrompt, NO_SCREEN_TO_POLISH, parseIntake, SCHEMA, type Intake } from "@hewntools/cli/intake.ts";
import type { IntakeRequest } from "@hewntools/host-workerd/surface/intake-types.ts";
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
type Seen = { attempt: number; pass?: string; request?: string; feedback?: string; brief: string; shot?: string; words?: string };
const recorder = (jobs: Seen[]) => (ws: string, job: BuildJob) =>
  void jobs.push({
    attempt: job.attempt,
    ...(job.pass ? { pass: job.pass.name, request: job.pass.request } : {}),
    ...(job.feedback ? { feedback: job.feedback } : {}),
    brief: readFileSync(join(ws, "BUILDER.md"), "utf8"),
    ...(existsSync(join(ws, "screenshots", "desktop-light.png")) ? { shot: readFileSync(join(ws, "screenshots", "desktop-light.png"), "utf8") } : {}),
    ...(existsSync(join(ws, "OWNERS_WORDS.md")) ? { words: readFileSync(join(ws, "OWNERS_WORDS.md"), "utf8") } : {}),
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
    // Installed from a directory: no conversation led to it, so no OWNERS_WORDS.md and no mention of one.
    assert.equal(jobs[0].words, undefined);
    assert.doesNotMatch(jobs[0].brief + jobs[0].request!, /OWNERS_WORDS|OWNER'S OWN WORDS/);
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

  /** UI Counter as the owner asked for it in the chat, then changed once in the chat and once by an agent. */
  const ownersCounter = async () => {
    const asked = await t.build(() => t.platform.create(USER, { name: "UI Counter", purpose: "Count.", requirements: "A counter.", conversation: [{ role: "user", content: "A counter for my push-ups, big and sporty" }, { role: "intake", content: "One counter or one per exercise?" }, { role: "user", content: "Just one" }] }), (ws) => void cpSync(join(FIXTURES, "ui-counter"), ws, { recursive: true }));
    assert.equal(asked.status, "promoted", asked.log.join("\n"));
    const changed = await t.build(() => t.platform.modify(USER, { capabilityId: "ui-counter", request: "Show today's total", conversation: [{ role: "user", content: "Can it show today's total in green?" }] }), (ws) => markUi(ws, "v:change"));
    assert.equal(changed.status, "promoted", changed.log.join("\n"));
    const agents = await t.build(() => t.platform.modify(t.claude, { capabilityId: "ui-counter", request: "Say hi" }), (ws) => markUi(ws, "v:agent"));
    assert.equal(agents.status, "promoted", agents.log.join("\n"));
  };

  test("the conversations that led to the tool go with it, oldest first, the note last; the critique points at them", async () => {
    await ownersCounter();
    const jobs: Seen[] = [];
    const record = recorder(jobs);
    const { view } = await polish({ note: "Bolder, it's for workouts" }, (ws, job) => (record(ws, job), markUi(ws, "v:critique")), (ws, job) => (record(ws, job), markUi(ws, "v:craft")));
    assert.equal(view.status, "promoted", view.log.join("\n"));
    const words = jobs[0].words!;
    const day = new Date().toISOString().slice(0, 10);
    const order = [`## The tool as first asked for (v1, ${day})`, "OWNER: A counter for my push-ups, big and sporty", "INTAKE: One counter or one per exercise?", "OWNER: Just one", `## A change (v2, ${day})`, "OWNER: Can it show today's total in green?", "## This Polish: what the owner asked of it", "OWNER: Bolder, it's for workouts"];
    const at = order.map((line) => words.indexOf(`\n${line}\n`));
    assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), words);
    assert.match(words, /^# THE OWNER'S OWN WORDS\n\nTheir conversations with the intake that led to this tool as it is, oldest first, each under a heading \(a line starting "## "\) naming the build it led to, and last what they asked of this Polish\. The request in `BUILDER\.md` \(this Polish\) is the plan;/);
    // The agent's change (v3) had no conversation: nothing of it.
    assert.doesNotMatch(words, /v3|Say hi/);
    assert.match(jobs[0].brief, /THE OWNER'S OWN WORDS: their conversations with the intake that led to this tool as it is are in `OWNERS_WORDS\.md` in your workspace, oldest first, with this Polish's note last\./);
    assert.match(jobs[0].request!, /THE OWNER'S OWN WORDS in OWNERS_WORDS\.md\./);
    assert.equal(jobs[1].words, words, "the craft pass has the same file");
    // None of it goes into the tool.
    const cap = t.platform.registry.getCapability("ui-counter")!;
    assert.ok(!(await t.platform.loadVersion("ui-counter", cap.activeVersion!)).files["OWNERS_WORDS.md"]);
  });

  test("a tool an agent asked for has no conversation: no OWNERS_WORDS.md, and nothing points at one, note or not", async () => {
    const made = await t.build(() => t.platform.create(t.claude, { name: "UI Counter", purpose: "Count.", requirements: "A counter." }), (ws) => void cpSync(join(FIXTURES, "ui-counter"), ws, { recursive: true }));
    assert.equal(made.status, "promoted", made.log.join("\n"));
    const jobs: Seen[] = [];
    const record = recorder(jobs);
    const { view } = await polish({ note: "Bolder" }, (ws, job) => (record(ws, job), markUi(ws, "v:critique")), (ws) => markUi(ws, "v:craft"));
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.equal(jobs[0].words, undefined);
    assert.doesNotMatch(jobs[0].brief + jobs[0].request!, /OWNERS_WORDS|OWNER'S OWN WORDS/);
    assert.match(jobs[0].brief, /What the owner asks of this Polish: Bolder/, "the note is in BUILDER.md");
  });

  test("a change undone by a restore isn't in it, and neither is what Ask builder to fix adds to the note", async () => {
    await ownersCounter();
    await t.platform.rollback(USER, "ui-counter", 1);
    const failed = await polish({ note: "Bolder" }, breakTests, breakTests);
    assert.equal(failed.view.status, "failed");
    const jobs: Seen[] = [];
    const record = recorder(jobs);
    const fixed = await t.build(() => t.platform.retryBuild(USER, failed.view.buildId, { fix: true }), (ws, job) => (record(ws, job), markUi(ws, "v:critique")), (ws) => markUi(ws, "v:craft"));
    assert.equal(fixed.status, "promoted", fixed.log.join("\n"));
    assert.match(jobs[0].words!, /## The tool as first asked for \(v1, /);
    assert.doesNotMatch(jobs[0].words!, /today's total|## A change/);
    assert.match(jobs[0].words!, /OWNER: Bolder\n$/);
    assert.doesNotMatch(jobs[0].words!, /Fix request/);
    assert.match(jobs[0].brief, /What the owner asks of this Polish: Bolder\n\n--- Fix request ---/);
  });

  test("every line a Polish's builder reads is short, a long note and long conversations wrapped, nothing lost", async () => {
    const words = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
    const asked = await t.build(() => t.platform.create(USER, { name: "UI Counter", purpose: "Count.", requirements: "A counter.", conversation: [{ role: "user", content: words("ask", 400) }, { role: "intake", content: "x".repeat(3000) }] }), (ws) => void cpSync(join(FIXTURES, "ui-counter"), ws, { recursive: true }));
    assert.equal(asked.status, "promoted", asked.log.join("\n"));
    let files: Record<string, string> = {};
    const read: Script = (ws) => {
      const all = (dir: string): string[] => readdirSync(join(ws, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(dir, e.name)) : [join(dir, e.name)]));
      // The screenshots are images (here, short text standing in for them).
      files = Object.fromEntries(all(".").filter((f) => !f.endsWith(".png")).map((f) => [f, readFileSync(join(ws, f), "utf8")]));
      markUi(ws, "v:critique");
    };
    // Long, and part of it a run with no space to wrap at: within the 2,000 characters a note may have.
    const note = `${words("note", 100)} ${"Z".repeat(1200)}`;
    assert.ok(note.length <= 2000);
    const { view } = await polish({ note }, read, (ws) => markUi(ws, "v:craft"));
    assert.equal(view.status, "promoted", view.log.join("\n"));
    assert.ok(files["BUILDER.md"] && files["OWNERS_WORDS.md"], Object.keys(files).join(", "));
    for (const [f, text] of Object.entries(files)) {
      const longest = Math.max(...text.split("\n").map((l) => l.length));
      assert.ok(longest <= LINE_CHARS, `${f}: a line of ${longest} characters`);
    }
    for (const f of ["BUILDER.md", "OWNERS_WORDS.md"]) {
      assert.match(files[f], /note99/);
      assert.ok(files[f].replace(/\n */g, "").includes("Z".repeat(1200)), `${f}: the run is cut, not lost`);
    }
    assert.match(files["OWNERS_WORDS.md"], /ask399/);
  });

  test("a history past 40,000 bytes keeps every heading, the first ask, the newest turns and the note", () => {
    const long = (who: "user" | "intake", tag: string) => ({ role: who, content: `${tag} ${"word ".repeat(180)}` });
    const history = ["v1", "v2", "v3"].map((v) => ({ heading: `A change (${v}, 2026-10-20)`, turns: Array.from({ length: 20 }, (_, i) => long(i % 2 ? "intake" : "user", `${v}-turn-${i}`)) }));
    const words = polishWords(history, { note: "Bolder" });
    assert.ok(new TextEncoder().encode(words).length <= 40_000 + 1000, `within the cap (the intro aside): ${words.length}`);
    for (const v of ["v1", "v2", "v3"]) assert.ok(words.includes(`## A change (${v}, 2026-10-20)`), v);
    assert.match(words, /OWNER: v1-turn-0 /, "the first ask");
    assert.match(words, /INTAKE: v3-turn-19 /, "the newest turn");
    assert.match(words, /OWNER: Bolder\n$/, "the note last");
    assert.doesNotMatch(words, /v1-turn-5 /, "an old turn left out");
    assert.match(words, /\(\d+ turns left out\)/);
    // Nothing kept: empty, note or not.
    assert.equal(polishWords([], { note: "Bolder" }), "");
    assert.equal(polishWords([{ heading: "x", turns: [] }], {}), "");
    // This Polish's own conversation is enough for a file: it's the owner's words, last.
    assert.match(polishWords([], { note: "Bolder", conversation: [{ role: "user", content: "Polish it." }, { role: "intake", content: "Bolder it is." }] }), /\n## This Polish: the conversation that asked for it\n\nOWNER: Polish it\.\n\nINTAKE: Bolder it is\.\n$/);
  });

  test("the intake, asked for a Polish, replies with one (its note in the owner's terms); a tool without a screen gets an answer and the offer of one", () => {
    assert.ok((SCHEMA.properties.kind.enum as string[]).includes("polish"));
    const reply = parseIntake(JSON.stringify({ kind: "polish", message: "A second look, then.", request: " Bolder " }), "modify");
    assert.deepEqual(reply, { kind: "polish", message: "A second look, then.", polish: { note: "Bolder" } });
    const withScreen = JSON.parse(readFileSync(join(FIXTURES, "ui-counter", "capability.json"), "utf8"));
    const req: IntakeRequest = { mode: "modify", capabilityId: "ui-counter", messages: [{ role: "user", content: "Polish it." }], current: withScreen };
    assert.match(intakePrompt({ ...req, polish: true }), /- The owner opened this as a Polish\. A Polish \(when the owner asks for one\): [^\n]*Reply kind "polish": [^\n]*never reply kind "questions" for one\./);
    // Asked for by name in an ordinary change: the same, but nothing says they opened one.
    assert.match(intakePrompt(req), /- A Polish \(when the owner asks for one by name\): [^\n]*Reply kind "polish"/);
    assert.doesNotMatch(intakePrompt(req), /opened this as a Polish/);
    // A tool without a screen: nothing to polish; the intake says so and offers a screen, and a Polish reply becomes that answer.
    const { ui: _ui, ...noScreen } = withScreen;
    assert.match(intakePrompt({ ...req, polish: true, current: noScreen }), /This tool has no screen of its own [^\n]*nothing to polish: if they ask for one, reply kind "answer"[^\n]*offer to give it a screen of its own; if they say yes, reply kind "draft"/);
    assert.doesNotMatch(intakePrompt({ ...req, polish: true, current: noScreen }), /Reply kind "polish"/);
    assert.deepEqual(parseIntake(JSON.stringify({ kind: "polish", message: "", request: "" }), "modify", noScreen), { kind: "answer", message: NO_SCREEN_TO_POLISH });
    assert.deepEqual(parseIntake(JSON.stringify({ kind: "polish", message: "Aurora Watch has no screen to polish. Want one?", request: "" }), "modify", noScreen), { kind: "answer", message: "Aurora Watch has no screen to polish. Want one?" });
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
  test("Polish… opens the Change drawer: the intake proposes a Polish card (own data unticked), Build polish starts it with the conversation, and the drawer shows its steps", { skip: !browser && "no Chromium-based browser on this machine", timeout: 120_000 }, async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "increment" });
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    t.queue(async (ws) => (markUi(ws, "v:critique"), await gate), (ws) => markUi(ws, "v:craft"));
    const asked: IntakeRequest[] = [];
    const intake: Intake = async (req) => (asked.push(req), { kind: "polish", message: "I'll give it a second look.", polish: { note: "Bolder, the count first" } });
    const server = await serve(t.platform, t.home, { intake });
    const web = `http://hewn.localhost:${(server.address() as AddressInfo).port}`;
    const b = await launchBrowser(browser!);
    const until = async <T>(what: string, f: () => Promise<T | null | undefined | false>): Promise<T> => {
      for (let i = 0; i < 100; i++) {
        const v = await f();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    try {
      const page = await b.page({ name: "desktop", width: 1280, height: 900, mobile: false, scale: 1 });
      await page.goto(`${web}/auth?ticket=${t.platform.createWebTicket(USER)}`);
      await page.goto(`${web}/#/c/ui-counter`);
      await page.eval(`document.querySelector('.glass-bar button[aria-label="More"]').click()`);
      const items = await page.eval<string[]>(`[...document.querySelectorAll('.menu [role="menuitem"]')].map((b) => b.textContent)`);
      assert.deepEqual(items.slice(0, 4), ["Open", "Change…", "Polish…", "Info"]);
      await page.eval(`[...document.querySelectorAll('.menu [role="menuitem"]')].find((b) => b.textContent === "Polish…").click()`);
      // The tool with its Change drawer, in Polish mode: "Polish it." in the box, waiting for the owner's Send.
      const hash = await until("the drawer", async () => ((await page.eval<string>("location.hash")).includes("change=1") ? page.eval<string>("location.hash") : null));
      assert.match(hash, /^#\/app\/ui-counter\?change=1&polish=1$/);
      assert.equal(await until("the box", () => page.eval<string>(`document.querySelector(".drawer-intake .composer-input")?.value ?? ""`)), "Polish it.");
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(asked.length, 0, "nothing is sent until the owner sends it");
      await page.eval(`(() => { const i = document.querySelector(".drawer-intake .composer-input"); i.value = "Polish it. The count should lead."; i.dispatchEvent(new Event("input")); i.closest("form").requestSubmit(); })()`);
      const card = await until("the Polish card", () =>
        page.eval<{ title: string; text: string; build: boolean; box: { checked: boolean; disabled: boolean } } | null>(`(() => { const c = document.querySelector(".drawer-intake .proposal"); const box = c?.querySelector('input[type="checkbox"][aria-label="Show the builder my own data"]'); return c && box && !box.disabled ? { title: document.querySelector(".drawer-title")?.textContent, text: c.textContent, build: [...c.querySelectorAll("button")].some((b) => b.textContent === "Build polish"), box: { checked: box.checked, disabled: box.disabled } } : null })()`),
      );
      assert.equal(card.title, "Polish UI Counter");
      assert.ok(card.build, card.text);
      assert.deepEqual(card.box, { checked: false, disabled: false });
      assert.match(card.text, /Proposal · polish/);
      assert.match(card.text, /Note Bolder, the count first/);
      assert.match(card.text, /Show the builder my own data · its screenshots then show UI Counter with your own entries instead of made-up sample data, and the builder's AI model sees them/);
      assert.match(card.text, /A longer build than a change: two design passes\. If one fails, nothing changes\./);
      assert.ok(!(await page.eval<boolean>(`[...document.querySelectorAll(".drawer-intake button")].some((b) => /Polish now/.test(b.textContent))`)), "no Polish now: Draft now is the way past questions, and a Polish asks none");
      // The intake was asked for a Polish, with what the owner added.
      assert.equal(asked.length, 1);
      assert.equal(asked[0].polish, true);
      assert.equal(asked[0].messages[0].content, "Polish it. The count should lead.");
      await page.eval(`[...document.querySelectorAll(".drawer-intake .proposal button")].find((b) => b.textContent === "Build polish").click()`);
      const started = await until("the Polish to start", async () => t.platform.registry.recentBuilds(5).map((id) => t.platform.getBuild(USER, id)).find((x) => x.request.polish && x.step?.step === "critique"));
      assert.deepEqual(started.request, { capabilityId: "ui-counter", request: "Polish: Bolder, the count first", note: "Bolder, the count first", polish: true });
      const context = t.platform.buildContext(USER, started.buildId);
      assert.deepEqual(context.conversation?.map((m) => [m.role, m.content.split("\n")[0]]), [["user", "Polish it. The count should lead."], ["intake", "I'll give it a second look."]]);
      // The drawer follows the build: a Polish's steps.
      const rows = await until("the build's steps", async () => {
        const r = await page.eval<[string, string][]>(`[...document.querySelectorAll(".drawer ol.steps li")].map((li) => [li.className.replace("step ", ""), (li.children[0].querySelector("summary") ?? li.children[0]).textContent.trim()])`);
        return r.length >= 6 && r.some(([state]) => state === "live") ? r : null;
      });
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
