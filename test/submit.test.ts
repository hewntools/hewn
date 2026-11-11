// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds from anywhere: a client fetches the pack, checks its files and submits them; Hewn validates
// a submission as any build and holds an agent's change for the owner (its approval mode).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER, WEB_USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { bytes, text } from "@hewntools/core/files.ts";
import { type BuildView, candidateFiles, type FileEntry } from "@hewntools/core/platform.ts";
import type { VisualCheck } from "@hewntools/cli/visual.ts";
import { FIXTURES, installFrom, installSeed, SEED, setup } from "./helpers.ts";

const SHOTS = ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"];
/** A visual check that renders nothing: four images named for the render. */
const fakeVisual: VisualCheck = async () => ({ errors: [], screenshot: Buffer.from("png"), shots: SHOTS.map((name) => ({ name, png: Buffer.from(name) })) });
/** The same, with the phone's light page long enough for a second part. */
const longPage: VisualCheck = async (...a) => ({ ...(await fakeVisual(...a)), shots: [...SHOTS, "mobile-light-2"].map((name) => ({ name, png: Buffer.from(name) })) });
const code = (c: string, message?: RegExp) => (e: unknown) => e instanceof PlatformError && e.code === c && (!message || message.test(e.message));

/** A folder's files as a client sends them. */
function entriesOf(dir: string, rel = ""): FileEntry[] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const path = rel ? `${rel}/${name}` : name;
    return statSync(join(dir, path)).isDirectory() ? entriesOf(dir, path) : [{ path, content: readFileSync(join(dir, path), "utf8") }];
  });
}
/** `files` with one file's text changed (or added). */
const edit = (files: FileEntry[], path: string, change: (s: string) => string): FileEntry[] => {
  const had = files.some((f) => f.path === path);
  return had ? files.map((f) => (f.path === path ? { ...f, content: change(f.content) } : f)) : [...files, { path, content: change("") }];
};
const reworded = (files: FileEntry[]) => edit(files, "capability.json", (s) => JSON.stringify({ ...JSON.parse(s), purpose: "Maintain a durable personal running history (reworded)." }, null, 2));

describe("the pack: what a client builds from", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
  });
  afterEach(() => t.cleanup());

  test("for a new tool: the other tools' contracts and looks and the design system, never the request or the owner's words", async () => {
    const pack = await t.platform.pack(t.claude, { kind: "create" });
    const paths = pack.files.map((f) => f.path);
    assert.ok(paths.includes("CONTRACTS.md"), paths.join(", "));
    assert.ok(paths.includes(".hewn-contracts/running-log.md") && paths.includes(".hewn-contracts/ui-counter.md"));
    assert.ok(paths.includes("OTHER_TOOLS.md"));
    for (const p of ["BUILDER.md", "OWNERS_WORDS.md", "BRIEF.md", "AGENTS.md", "capability.json"]) assert.ok(!paths.includes(p), p);
    assert.match(pack.next, /capabilities_check/);
  });

  test("for a change: the tool's own files, its version and its schedules too", async () => {
    t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "daily 07:00" });
    const pack = await t.platform.pack(t.claude, { kind: "modify", capabilityId: "running-log" });
    const paths = pack.files.map((f) => f.path);
    for (const p of ["capability.json", "src/index.ts", "tests/cases.json", "sample/calls.json", "migrations/001_init.sql", "CONTRACTS.md", ".hewn-contracts/ui-counter.md"]) assert.ok(paths.includes(p), `${p} in ${paths.join(", ")}`);
    assert.ok(!paths.includes(".hewn-contracts/running-log.md"), "not its own contract");
    assert.equal(pack.baseVersion, 1);
    assert.deepEqual(pack.schedules?.map((s) => [s.operation, s.cadence]), [["get_summary@1", "daily 07:00"]]);
  });

  test("a client sees only the tools its grant shows it", async () => {
    const limited = t.platform.agentStore.approveDirect("limited", ["discover", "create", "modify"], ["running-log"]);
    const agent = t.platform.agentStore.get(limited)!;
    const pack = await t.platform.pack(agent, { kind: "create" });
    const paths = pack.files.map((f) => f.path);
    assert.ok(paths.includes(".hewn-contracts/running-log.md"));
    assert.ok(!paths.some((p) => p.includes("ui-counter")), paths.join(", "));
    for (const f of pack.files.filter((x) => x.path === "CONTRACTS.md" || x.path === "OTHER_TOOLS.md")) assert.doesNotMatch(f.content, /ui-counter|UI Counter/, f.path);
    await assert.rejects(t.platform.pack(agent, { kind: "modify", capabilityId: "ui-counter" }), code("not_found"));
  });

  test("needs the scope the build would", async () => {
    await assert.rejects(t.platform.pack(t.codex, { kind: "create" }), code("forbidden"));
    await assert.rejects(t.platform.pack(t.claude, { kind: "rebuild" }), code("invalid_request"));
  });
});

describe("a client's files: what Hewn takes", () => {
  test("a file Hewn never keeps is refused, naming each path and its rule", () => {
    const files = { "capability.json": bytes("{}"), "CLAUDE.md": bytes("x"), ".claude/settings.json": bytes("{}"), "CONTRACTS.md": bytes("x"), "screenshots/desktop-light.png": bytes("x"), "node_modules/a/index.js": bytes("x") };
    assert.throws(
      () => candidateFiles(files),
      (e: unknown) => {
        assert.ok(e instanceof PlatformError && e.code === "invalid_request");
        assert.match(e.message, /CLAUDE\.md, \.claude\/settings\.json: Hewn never keeps a builder's own configuration/);
        assert.match(e.message, /CONTRACTS\.md, screenshots\/desktop-light\.png: Hewn writes these for builders/);
        assert.match(e.message, /node_modules\/a\/index\.js: build output/);
        assert.deepEqual((e.details as { refused: { path: string }[] }).refused.map((r) => r.path).sort(), [".claude/settings.json", "CLAUDE.md", "CONTRACTS.md", "node_modules/a/index.js", "screenshots/desktop-light.png"]);
        return true;
      },
    );
  });

  test("paths Hewn doesn't accept, twins, and more than 5 MB are refused", () => {
    for (const path of ["/etc/passwd", "../x", "a//b", "a\\b", "./a"]) assert.throws(() => candidateFiles({ [path]: bytes("x") }), code("invalid_request", /isn't a path Hewn accepts/), path);
    assert.throws(() => candidateFiles({ "src/a.ts": bytes("x"), "SRC/a.ts": bytes("y") }), code("invalid_request", /the same file/));
    assert.throws(() => candidateFiles({ "big.bin": new Uint8Array(5 * 1024 * 1024 + 1) }), code("invalid_request", /at most 5 MB/));
  });
});

describe("check: validation on request, promoting nothing", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup({ visualCheck: longPage });
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());
  const counter = () => entriesOf(join(FIXTURES, "ui-counter")).map((f) => (f.path === "capability.json" ? { ...f, content: f.content.replace('"ui-counter"', '"my-counter"').replace("UI Counter", "My Counter") } : f));

  test("a passing new tool: PASS, the four renders as images (a long page's further part named, left out), nothing installed; screenshots: \"all\" adds it, false leaves them all out", async () => {
    const r = await t.platform.checkFiles(t.claude, { files: counter() });
    assert.equal(r.passed, true, r.text);
    assert.match(r.text, /^PASS/);
    assert.deepEqual(r.images.map((i) => i.name), SHOTS);
    assert.match(r.text, /attached \(desktop-light, desktop-dark, mobile-light, mobile-dark\)\. A long page shows its top part; the rest \(mobile-light-2, top to bottom\) is left out: check again with screenshots: "all" to see it\./);
    assert.ok(!r.text.includes("screenshots/"), "no files to open: a client has the images only");
    const all = await t.platform.checkFiles(t.claude, { files: counter(), screenshots: "all" });
    assert.deepEqual(all.images.map((i) => i.name), [...SHOTS, "mobile-light-2"]);
    assert.match(all.text, /attached \(desktop-light, desktop-dark, mobile-light, mobile-dark\)\. A long page shows its top part; the rest follows it \(mobile-light-2, top to bottom\)\./);
    assert.deepEqual((await t.platform.checkFiles(t.claude, { files: counter(), screenshots: true })).images.map((i) => i.name), SHOTS);
    const bare = await t.platform.checkFiles(t.claude, { files: counter(), screenshots: false });
    assert.equal(bare.passed, true, bare.text);
    assert.deepEqual(bare.images, []);
    assert.match(bare.text, /rendered and measured, the screenshots left out \(screenshots: false\)/);
    await assert.rejects(t.platform.checkFiles(t.claude, { files: counter(), screenshots: "no" }), code("invalid_request", /screenshots: true, false or "all"/));
    assert.equal(t.platform.registry.getCapability("my-counter"), undefined, "nothing installed");
  });

  test("failing tests come back as failures; a change is checked against the tool's contract", async () => {
    const base = entriesOf(SEED);
    const broken = edit(base, "tests/cases.json", (s) => JSON.stringify([...JSON.parse(s), { name: "wrong", operation: "get_summary", input: {}, expect: { nope: 1 } }]));
    const r = await t.platform.checkFiles(t.claude, { files: broken, capabilityId: "running-log" });
    assert.equal(r.passed, false);
    assert.ok(r.failures.some((f) => /test cases failed/.test(f)), r.text);
    const breaking = edit(base, "capability.json", (s) => JSON.stringify({ ...JSON.parse(s), operations: JSON.parse(s).operations.filter((o: { name: string }) => o.name !== "list_runs") }));
    const b = await t.platform.checkFiles(t.claude, { files: breaking, capabilityId: "running-log" });
    assert.ok(b.failures.some((f) => /breaking change/.test(f)), b.text);
    assert.equal(t.platform.registry.getCapability("running-log")!.activeVersion, 1, "nothing changed");
  });

  test("a new tool under the id of one already here is told to check a change instead", async () => {
    await assert.rejects(t.platform.checkFiles(t.claude, { files: entriesOf(SEED) }), code("conflict", /pass capabilityId 'running-log'/));
  });

  test("30 an hour per client (here 2): the next is refused, another client isn't", async () => {
    t.platform.checksPerHour = 2;
    await t.platform.checkFiles(t.claude, { files: counter() });
    await t.platform.checkFiles(t.claude, { files: counter() });
    await assert.rejects(t.platform.checkFiles(t.claude, { files: counter() }), code("conflict", /No checks left this hour \(2\)/));
    const other = t.platform.agentStore.get(t.platform.agentStore.approveDirect("other", ["discover", "create", "modify"]))!;
    assert.equal((await t.platform.checkFiles(other, { files: counter() })).passed, true);
  });

  test("files Hewn never keeps are refused before anything runs", async () => {
    await assert.rejects(t.platform.checkFiles(t.claude, { files: [...counter(), { path: "AGENTS.md", content: "x" }] }), code("invalid_request", /AGENTS\.md: Hewn never keeps/));
    await assert.rejects(t.platform.checkFiles(t.codex, { files: counter() }), code("forbidden"));
  });
});

describe("submit: the same gate as any build", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup({ visualCheck: fakeVisual, attempts: 3 });
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());
  const counter = () => entriesOf(join(FIXTURES, "ui-counter"));

  test("a new tool the client submits waits for the owner (approval mode wait), its id kept; approved, it goes live", async () => {
    const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: counter(), request: "A counter with a screen" })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
    assert.equal(b.builder, "submitted");
    assert.equal(b.submittedBy, "claude-code");
    assert.equal(b.kind, "create");
    assert.equal(b.request.requirements, "A counter with a screen");
    assert.equal(b.review!.approval, "wait");
    assert.deepEqual(b.review!.newOperations.map((o) => o.key), ["increment@1", "get@1"]);
    assert.deepEqual(b.review!.shots, SHOTS);
    assert.equal(t.platform.registry.getCapability("ui-counter")!.activeVersion, null, "not live");
    // Its files as they are: nothing to compare with.
    const diff = await t.platform.reviewCode(USER, b.buildId);
    assert.equal(diff.base, null);
    assert.ok(diff.files.some((f) => f.path === "ui/index.html"));
    await assert.rejects(t.platform.submitFiles(t.claude, { files: counter(), request: "again" }), (e) => e instanceof PlatformError && /waits for the owner's approval \(build /.test(e.message));
    const live = await t.platform.approveBuild(USER, b.buildId);
    assert.equal(live.status, "promoted", live.log.join("\n"));
    assert.equal(t.platform.registry.getCapability("ui-counter")!.activeVersion, 1);
    await assert.rejects(t.platform.retryBuild(t.claude, b.buildId), code("conflict"));
  });

  test("a new tool the owner turns down never goes live; its id is free for the next", async () => {
    const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: counter(), request: "A counter" })).buildId);
    assert.equal((await t.platform.rejectBuild(USER, b.buildId)).status, "cancelled");
    assert.equal(t.platform.registry.getCapability("ui-counter")?.activeVersion ?? null, null);
    const again = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: counter(), request: "A counter, again" })).buildId);
    assert.equal(again.status, "review", again.log.join("\n"));
  });


  test("a change by an agent is held for the owner (approval mode wait), with the diff and the four renders", async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    const files = edit(entriesOf(join(FIXTURES, "ui-counter")), "ui/index.html", (s) => s.replace("</body>", "<p>new</p></body>"));
    const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files, capabilityId: "ui-counter", request: "A line under the count", baseVersion: 1 })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
    assert.equal(b.review!.approval, "wait");
    assert.deepEqual(b.review!.newOperations, []);
    assert.deepEqual(b.review!.shots, SHOTS);
    assert.equal(b.review!.changes!.ui, true);
    const diff = await t.platform.reviewCode(WEB_USER, b.buildId);
    assert.deepEqual(diff.files.filter((f) => f.status !== "same").map((f) => [f.path, f.status]), [["ui/index.html", "changed"]]);
    assert.equal(diff.base, 1);
    const file = await t.platform.reviewFile(WEB_USER, b.buildId, "ui/index.html");
    assert.ok(file.hunks.some((h) => h.lines.some((l) => l.type === "+" && /new/.test(l.text))));
    assert.equal(text(await t.platform.reviewShot(WEB_USER, b.buildId, "mobile-dark")), "mobile-dark");
    await assert.rejects(t.platform.reviewCode(t.claude, b.buildId), code("forbidden"));
    const done = await t.platform.approveBuild(WEB_USER, b.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(await t.platform.blobs.get(`screenshots/${b.buildId}/mobile-dark.png`), undefined, "the renders go once decided");
  });

  test("refused: a change while another is on its way, files from an older version, a create over an existing tool", async () => {
    const files = reworded(entriesOf(SEED));
    t.queue(async (ws) => {
      await new Promise((r) => setTimeout(r, 300));
      const p = join(ws, "capability.json");
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), purpose: "Changed by the owner meanwhile." }));
    });
    const other = await t.platform.modify(WEB_USER, { capabilityId: "running-log", request: "anything" });
    // It names the build in the way, for the client to follow with builds_wait.
    await assert.rejects(t.platform.submitFiles(t.claude, { files, capabilityId: "running-log", request: "reword" }), (e) => code("conflict", new RegExp(`on its way \\(build ${other.buildId}\\)`))(e) && (e as { details?: { buildId?: string } }).details?.buildId === other.buildId);
    await t.platform.settle(other.buildId);
    await assert.rejects(t.platform.submitFiles(t.claude, { files, capabilityId: "running-log", request: "reword", baseVersion: 1 }), code("conflict", /at v2 now and your files are from v1/));
    await assert.rejects(t.platform.submitFiles(t.claude, { files: entriesOf(SEED), request: "again" }), code("conflict", /submit with capabilityId 'running-log'/));
    await assert.rejects(t.platform.submitFiles(t.claude, { files, capabilityId: "running-log", request: " " }), code("invalid_request", /request/));
    await assert.rejects(t.platform.submitFiles(t.codex, { files, capabilityId: "running-log", request: "x" }), code("forbidden"));
    await assert.rejects(t.platform.submitFiles(t.claude, { files: [...files, { path: ".npmrc", content: "x" }], capabilityId: "running-log", request: "x" }), code("invalid_request", /\.npmrc: Hewn never keeps/));
  });

  test("files that fail validation fail once, saying why: a submission, an install from a file, one from a folder", async () => {
    // A build may try 3 times here; with no builder to change the files, the same files would fail the same way.
    const broken = (id: string) => edit(counter(), "tests/cases.json", () => "[]").map((f) => (f.path === "capability.json" ? { ...f, content: f.content.replace('"ui-counter"', `"${id}"`) } : f));
    const once = (b: BuildView, builder: string) => {
      assert.equal(b.builder, builder);
      assert.equal(b.status, "failed", builder);
      assert.match(b.log.join("\n"), /at least one case/, builder);
      assert.equal(b.log.filter((l) => /validating candidate/.test(l)).length, 1, `${builder}: validated once`);
      assert.match(b.log.at(-1)!, /after 1 attempts/, builder);
    };
    once(await t.platform.settle((await t.platform.submitFiles(t.claude, { files: broken("sent-counter"), request: "A counter" })).buildId), "submitted");
    const seed = Object.fromEntries(broken("file-counter").map((f) => [f.path, bytes(f.content)]));
    once(await t.platform.settle((await t.platform.install(USER, { name: "File Counter", purpose: "x", builder: "bundle", id: "file-counter", seed })).buildId), "bundle");
    const dir = mkdtempSync(join(tmpdir(), "hewn-copy-"));
    for (const f of broken("folder-counter")) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    once(await t.platform.settle((await t.platform.install(USER, { name: "Folder Counter", purpose: "x", builder: `copy:${dir}` })).buildId), `copy:${dir}`);
    rmSync(dir, { recursive: true });
  });

  test("the owner's own submission isn't held", async () => {
    const b = await t.platform.settle((await t.platform.submit(USER, { files: Object.fromEntries(reworded(entriesOf(SEED)).map((f) => [f.path, bytes(f.content)])), capabilityId: "running-log", builder: "submitted", request: "reword" })).buildId);
    assert.equal(b.status, "promoted", b.log.join("\n"));
  });
});

describe("approval mode: an agent's changes wait for the owner", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("every agent starts at wait; go live can't be chosen yet", () => {
    assert.deepEqual(t.platform.agents(USER).map((a) => a.approvalMode), ["wait", "wait", "wait"]);
    assert.throws(() => t.platform.updateAgent(USER, "claude-code", { approvalMode: "live" }), code("invalid_request", /0\.4\.12/));
    assert.throws(() => t.platform.updateAgent(USER, "claude-code", { approvalMode: "soon" as never }), code("invalid_request"));
    t.platform.updateAgent(USER, "claude-code", { approvalMode: "wait" });
    assert.equal(t.platform.agentStore.approvalMode("claude-code"), "wait");
    assert.equal(t.platform.agentStore.approvalMode("gone"), "wait", "an agent Hewn doesn't know: wait");
  });

  test("a change by the platform's builder that adds nothing waits too, and says why", async () => {
    t.queue((ws) => {
      const p = join(ws, "capability.json");
      const m = JSON.parse(readFileSync(p, "utf8"));
      m.purpose += " (reworded)";
      writeFileSync(p, JSON.stringify(m));
    });
    const b = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "running-log", request: "reword" })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
    assert.equal(b.review!.approval, "wait");
    assert.match(b.instructions!, /agent's changes wait for the owner's approval/);
  });
});

describe("a migration that fails on the tool's data: the error is the owner's", () => {
  let t: ReturnType<typeof setup>;
  const NOTE = "a-note-only-the-owner-wrote";
  // On the tests' empty tables it does nothing; on the tool's data its error quotes a row.
  const quoting = () => [...entriesOf(SEED), { path: "migrations/002_quote.sql", content: "SELECT json_extract('{}', (SELECT 'x' || group_concat(notes, '|') FROM runs));" }];
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 5, durationSeconds: 1500, notes: NOTE } });
  });
  afterEach(() => t.cleanup());

  test("a client's check doesn't run its migrations on the tool's data: they run when it submits", async () => {
    const r = await t.platform.checkFiles(t.claude, { files: quoting(), capabilityId: "running-log" });
    assert.ok(!JSON.stringify(r).includes(NOTE), r.text);
    assert.match(r.text, /Not in a check: the upgrade dry run/);
  });

  test("a submission's build tells the agent it failed on the data, not the error; the owner's transcript has it", async () => {
    const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: quoting(), capabilityId: "running-log", request: "a migration" })).buildId);
    assert.equal(b.status, "failed");
    const seen = JSON.stringify(t.platform.getBuild(t.claude, b.buildId));
    assert.ok(!seen.includes(NOTE), seen);
    assert.match(seen, /the upgrade dry run failed on a copy of the tool's data/);
    assert.match((await t.platform.buildTranscript(USER, b.buildId)) ?? "", new RegExp(NOTE));
  });

  test("so does a change an agent asks Hewn's builder for; the owner's own build says it as it is", async () => {
    const write = (ws: string) => writeFileSync(join(ws, "migrations", "002_quote.sql"), quoting().at(-1)!.content);
    t.queue(write);
    const agents = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "running-log", request: "a migration" })).buildId);
    assert.equal(agents.status, "failed");
    assert.ok(!JSON.stringify(t.platform.getBuild(t.claude, agents.buildId)).includes(NOTE));
    t.queue(write);
    const own = await t.platform.settle((await t.platform.modify(WEB_USER, { capabilityId: "running-log", request: "a migration" })).buildId);
    assert.match(own.log.join("\n"), new RegExp(NOTE));
  });

  test("Hewn's builder checking an agent's change doesn't see the error either; on the owner's own build it does", async () => {
    const seen: string[] = [];
    const checking = async (ws: string, job: { check?: (id: string) => Promise<{ text: string; failures: string[] }> }) => {
      writeFileSync(join(ws, "migrations", "002_quote.sql"), quoting().at(-1)!.content);
      const r = await job.check!("1");
      seen.push(JSON.stringify(r));
    };
    t.queue(checking as never);
    await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "running-log", request: "a migration" })).buildId);
    assert.ok(!seen[0].includes(NOTE), seen[0]);
    assert.match(seen[0], /the upgrade dry run failed on a copy of the tool's data/);
    t.queue(checking as never);
    await t.platform.settle((await t.platform.modify(WEB_USER, { capabilityId: "running-log", request: "a migration" })).buildId);
    assert.match(seen[1], new RegExp(NOTE));
  });
});
