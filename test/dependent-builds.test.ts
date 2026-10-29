// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { USER } from "@hewntools/core/auth.ts";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { MemorySecretStore } from "@hewntools/test-host/secrets.ts";
import { nodePlatform } from "@hewntools/test-host/index.ts";
import { FIXTURES, type Script, setup } from "./helpers.ts";

/** The builder writes the site-connection fixture (a connection). */
const writeConnection: Script = (ws) => cpSync(join(FIXTURES, "site-connection"), ws, { recursive: true });
const broken: Script = (ws) => writeFileSync(join(ws, "capability.json"), "{ not json");

/** The builder writes a capability that calls site-connection/site@1 (validated only if that exists). */
const writeConsumer: Script = (ws) => {
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "tests"), { recursive: true });
  writeFileSync(
    join(ws, "capability.json"),
    JSON.stringify({
      id: "site-report",
      name: "Site Report",
      purpose: "Reports on the site through its connection.",
      abi: "2.0",
      requires: { capabilities: [{ id: "site-connection", operations: ["site@1"] }] },
      operations: [{ name: "report", description: "Report", version: 1, sideEffect: "read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
    }),
  );
  writeFileSync(join(ws, "src", "index.ts"), `export const operations = { async "report@1"(_i: unknown, ctx: any) { return { site: await ctx.call("site-connection", "site@1", {}) }; } };`);
  writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "report", operation: "report", input: {}, calls: { "site-connection/site@1": { config: {} } }, expect: { site: { config: {} } } }]));
};

const connReq = { name: "Site Connection", purpose: "Wraps the site.", requirements: "health, site", kind: "connection" as const };
const consumerReq = { name: "Site Report", purpose: "Reports on the site.", requirements: "call site@1" };

describe("dependent builds", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(async () => {
    await t.platform.drain();
    t.cleanup();
  });

  test("a capability waits for the connection it calls, then builds", async () => {
    t.queue(writeConnection, writeConsumer);
    const conn = await t.platform.create(t.claude, connReq);
    const consumer = await t.platform.create(t.claude, { ...consumerReq, after: conn.buildId });
    assert.equal(consumer.status, "waiting");
    assert.equal(consumer.dependsOn, conn.buildId);
    assert.equal(consumer.step?.step, "waiting");
    assert.match(consumer.instructions!, /waits for build/);
    assert.ok(t.platform.activeBuilds().some((b) => b.buildId === consumer.buildId), "shown on Home while it waits");
    const waited = t.platform.waitForBuild(t.claude, consumer.buildId, { timeoutMs: 10_000 });
    assert.equal((await t.platform.settle(conn.buildId)).status, "promoted");
    const done = await t.platform.settle(consumer.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal((await waited).status, "promoted", "builds_wait follows a waiting build to the end");
    assert.ok(done.log.some((l) => /calls site-connection\/site@1/.test(l)));
  });

  test("a new connection shows as a connection while it builds (Accounts, not Home)", async () => {
    let release!: () => void;
    t.queue(async (ws) => {
      await new Promise<void>((r) => (release = r));
      writeConnection(ws, undefined as never);
    }, writeConsumer);
    const conn = await t.platform.create(t.claude, connReq);
    const other = await t.platform.create(t.claude, { ...consumerReq, after: conn.buildId });
    const active = t.platform.activeBuilds();
    assert.equal(active.find((b) => b.buildId === conn.buildId)?.connection, true);
    assert.equal(active.find((b) => b.buildId === other.buildId)?.connection, false);
    release();
    assert.equal((await t.platform.settle(conn.buildId)).status, "promoted");
    await t.platform.settle(other.buildId);
  });

  test("the workspace has the design system to read; it never becomes part of the version", async () => {
    let css = "";
    t.queue((ws) => {
      css = readFileSync(join(ws, "PLATFORM_UI.css"), "utf8");
      writeConnection(ws, undefined as never);
    });
    const done = await t.platform.settle((await t.platform.create(t.claude, connReq)).buildId);
    assert.match(css, /--field/, "the real ui.css");
    const files = Object.keys((await t.platform.loadVersion("site-connection", done.resultVersion!)).files);
    assert.ok(!files.includes("PLATFORM_UI.css") && !files.includes("BUILDER.md"));
  });

  test("the connection's skeleton is a connection", async () => {
    let seen = "";
    t.queue((ws) => {
      seen = JSON.stringify(JSON.parse(readFileSync(join(ws, "capability.json"), "utf8")));
      writeConnection(ws, undefined as never);
    });
    await t.platform.settle((await t.platform.create(t.claude, connReq)).buildId);
    assert.match(seen, /"abi":"2.1","kind":"connection"/);
  });

  test("when the dependency fails, the waiting build fails; retried in order, both promote", async () => {
    t.queue(broken);
    const conn = await t.platform.create(t.claude, connReq);
    const consumer = await t.platform.create(t.claude, { ...consumerReq, after: conn.buildId });
    assert.equal((await t.platform.settle(conn.buildId)).status, "failed");
    const failed = await t.platform.settle(consumer.buildId);
    assert.equal(failed.status, "failed");
    assert.match(failed.log.join("\n"), new RegExp(`build ${conn.buildId}, which it waited for, failed`));
    await assert.rejects(t.platform.retryBuild(t.claude, consumer.buildId), /retry it first/);

    t.queue(writeConnection, writeConsumer);
    const conn2 = await t.platform.retryBuild(t.claude, conn.buildId);
    const consumer2 = await t.platform.retryBuild(t.claude, consumer.buildId);
    assert.equal(consumer2.status, "waiting", "the retry waits for the dependency's retry");
    assert.equal(consumer2.dependsOn, conn2.buildId);
    assert.equal((await t.platform.settle(conn2.buildId)).status, "promoted");
    assert.equal((await t.platform.settle(consumer2.buildId)).status, "promoted");
  });

  test("after a promoted build starts at once; after a failed one is refused", async () => {
    t.queue(writeConnection);
    const conn = await t.platform.settle((await t.platform.create(t.claude, connReq)).buildId);
    t.queue(writeConsumer);
    const consumer = await t.platform.create(t.claude, { ...consumerReq, after: conn.buildId });
    assert.notEqual(consumer.status, "waiting");
    assert.equal((await t.platform.settle(consumer.buildId)).status, "promoted");

    t.queue(broken);
    const bad = await t.platform.settle((await t.platform.create(t.claude, { name: "Other", purpose: "p", requirements: "r" })).buildId);
    await assert.rejects(t.platform.create(t.claude, { name: "Third", purpose: "p", requirements: "r", after: bad.buildId }), (e) => e instanceof PlatformError && e.code === "conflict");
  });

  test("a modify can wait for another build (the connection's new operation first)", async () => {
    t.queue(writeConnection);
    await t.platform.settle((await t.platform.create(t.claude, connReq)).buildId);
    t.queue(writeConsumer);
    await t.platform.settle((await t.platform.create(t.claude, consumerReq)).buildId);

    t.queue(
      (ws) => {
        const p = join(ws, "capability.json");
        const m = JSON.parse(readFileSync(p, "utf8"));
        m.operations.push({ ...m.operations[1], name: "pages" });
        writeFileSync(p, JSON.stringify(m));
        writeFileSync(join(ws, "src", "index.ts"), readFileSync(join(ws, "src", "index.ts"), "utf8").replace('async "site@1"', 'async "pages@1"(i: any, c: any) { return { config: c.config }; },\n  async "site@1"'));
      },
      (ws) => {
        const p = join(ws, "capability.json");
        const m = JSON.parse(readFileSync(p, "utf8"));
        m.requires.capabilities[0].operations.push("pages@1");
        writeFileSync(p, JSON.stringify(m));
      },
    );
    const connChange = await t.platform.modify(t.claude, { capabilityId: "site-connection", request: "add pages@1" });
    const change = await t.platform.modify(t.claude, { capabilityId: "site-report", request: "use pages@1", after: connChange.buildId });
    assert.equal(change.status, "waiting");
    // An agent's change to a connection waits for the owner; what waits for it keeps waiting.
    assert.equal((await t.platform.settle(connChange.buildId)).status, "review");
    assert.equal(t.platform.getBuild(t.claude, change.buildId).status, "waiting");
    assert.equal((await t.platform.approveBuild(USER, connChange.buildId)).status, "promoted");
    const done = await t.platform.settle(change.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(done.log.some((l) => /site-connection\/pages@1/.test(l)));
  });

  test("a change that waited for another build still takes its turn behind a change to the same capability", async () => {
    t.queue(writeConnection);
    await t.platform.settle((await t.platform.create(t.claude, connReq)).buildId);
    t.queue(writeConsumer);
    await t.platform.settle((await t.platform.create(t.claude, consumerReq)).buildId);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let releaseConn!: () => void;
    const connGate = new Promise<void>((r) => (releaseConn = r));
    t.queue(
      () => gate,
      async () => void (await connGate),
      () => {},
    );
    const running = await t.platform.modify(t.claude, { capabilityId: "site-report", request: "reword" });
    const connChange = await t.platform.modify(USER, { capabilityId: "site-connection", request: "tidy" });
    const change = await t.platform.modify(t.claude, { capabilityId: "site-report", request: "after the connection", after: connChange.buildId });
    assert.equal(change.dependsOn, connChange.buildId);
    assert.equal(change.queued, undefined, "waits for the build it needs");
    releaseConn();
    assert.equal((await t.platform.settle(connChange.buildId)).status, "promoted");
    const queued = t.platform.getBuild(t.claude, change.buildId);
    assert.equal(queued.status, "waiting");
    assert.equal(queued.dependsOn, running.buildId, "then for the change already running on site-report");
    assert.equal(queued.queued, true);
    release();
    assert.equal((await t.platform.settle(running.buildId)).status, "promoted");
    const done = await t.platform.settle(change.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
  });

  test("a change waiting for the owner's review doesn't hold up the next change to the capability", async () => {
    t.queue(writeConnection);
    await t.platform.settle((await t.platform.create(t.claude, connReq)).buildId);
    // An agent's change to a connection waits for the owner's review.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.queue(async () => void (await gate), () => {});
    const reviewed = await t.platform.modify(t.claude, { capabilityId: "site-connection", request: "a" });
    const next = await t.platform.modify(USER, { capabilityId: "site-connection", request: "b" });
    assert.equal(next.queued, true, "queued while the first one builds");
    release();
    assert.equal((await t.platform.settle(reviewed.buildId)).status, "review");
    assert.equal((await t.platform.settle(next.buildId)).status, "promoted", "started once the first one was only waiting for review");
    const after = await t.platform.modify(USER, { capabilityId: "site-connection", request: "c" });
    assert.notEqual(after.status, "waiting", "nothing to wait for: the review doesn't count");
    t.queue(() => {});
    await t.platform.settle(after.buildId);
  });

  test("cancelling a waiting build; whatever waits for it fails", async () => {
    let release!: () => void;
    t.queue(async (ws) => {
      await new Promise<void>((r) => (release = r));
      writeConnection(ws, undefined as never);
    });
    const conn = await t.platform.create(t.claude, connReq);
    const consumer = await t.platform.create(t.claude, { ...consumerReq, after: conn.buildId });
    const third = await t.platform.create(t.claude, { name: "Third", purpose: "p", requirements: "r", after: consumer.buildId });
    assert.equal(t.platform.cancelBuild(t.claude, consumer.buildId).status, "cancelled");
    const f = await t.platform.settle(third.buildId);
    assert.equal(f.status, "failed");
    assert.match(f.log.join("\n"), /which it waited for, cancelled/);
    release();
    assert.equal((await t.platform.settle(conn.buildId)).status, "promoted");
  });
});

describe("a queued change released while every build slot is taken", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup({ maxRunningBuilds: 1 })));
  afterEach(async () => {
    await t.platform.drain();
    t.cleanup();
  });

  test("it counts as started: the owner's answer to the review ahead of it doesn't start it again", async () => {
    t.queue(writeConnection);
    await t.platform.settle((await t.platform.create(t.claude, connReq)).buildId);
    let releaseA!: () => void;
    let releaseX!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateX = new Promise<void>((r) => (releaseX = r));
    let runsB = 0;
    t.queue(
      async () => void (await gateA),
      async (ws, job) => (await gateX, writeConsumer(ws, job)),
      () => void runsB++,
    );
    // A: an agent's change to the connection (it waits for review), building in the one slot.
    const a = await t.platform.modify(t.claude, { capabilityId: "site-connection", request: "a" });
    const b = await t.platform.modify(USER, { capabilityId: "site-connection", request: "b" });
    assert.equal(b.queued, true);
    // X takes the slot A gives up, so B, released when A goes to review, waits for a slot.
    const x = await t.platform.create(t.claude, consumerReq);
    releaseA();
    assert.equal((await t.platform.settle(a.buildId)).status, "review");
    for (let i = 0; i < 200 && !t.platform.getBuild(USER, b.buildId).log.length; i++) await new Promise((r) => setTimeout(r, 10));
    const started = t.platform.getBuild(USER, b.buildId);
    assert.equal(started.status, "open", "started, though no slot is free yet");
    assert.equal(started.queued, undefined);
    await t.platform.rejectBuild(USER, a.buildId);
    releaseX();
    assert.equal((await t.platform.settle(x.buildId)).status, "promoted");
    const done = await t.platform.settle(b.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(runsB, 1, "built once");
  });
});

describe("dependent builds across a restart", () => {
  test("the interrupted dependency is retried, and the waiting build follows the retry", async () => {
    const t = setup();
    // The first platform's builder never finishes: Hewn "stops" mid-build.
    t.queue(() => new Promise<void>(() => {}));
    const conn = await t.platform.create(t.claude, connReq);
    const consumer = await t.platform.create(t.claude, { ...consumerReq, after: conn.buildId });
    t.platform.close();

    const scripts: Script[] = [writeConnection, writeConsumer];
    const builder: CapabilityBuilder = { name: "script", build: async (job) => scripts.shift()!(job.workspace, job) };
    const fresh = nodePlatform(t.home, { secrets: new MemorySecretStore(), builders: { script: builder }, builder: () => "script", maxBuildAttempts: () => 1 });
    try {
      const [retry] = await fresh.recoverInterruptedBuilds();
      assert.ok(retry);
      assert.equal(fresh.registry.getBuild(consumer.buildId)!.dependsOn, retry, "re-pointed to the retry");
      assert.equal((await fresh.settle(retry)).status, "promoted");
      assert.equal((await fresh.settle(consumer.buildId)).status, "promoted");
    } finally {
      await fresh.drain();
      fresh.close();
    }
  });
});

describe("queued changes across a restart", () => {
  test("the interrupted change is retried, and the change queued behind it follows the retry", async () => {
    const t = setup();
    t.queue(writeConnection);
    await t.platform.settle((await t.platform.create(USER, connReq)).buildId);
    // The first platform's builder never finishes: Hewn "stops" mid-build.
    t.queue(() => new Promise<void>(() => {}));
    const first = await t.platform.modify(USER, { capabilityId: "site-connection", request: "a" });
    const second = await t.platform.modify(USER, { capabilityId: "site-connection", request: "b" });
    const third = await t.platform.modify(USER, { capabilityId: "site-connection", request: "c" });
    assert.equal(third.dependsOn, second.buildId);
    t.platform.close();

    const scripts: Script[] = [() => {}, () => {}, () => {}];
    const builder: CapabilityBuilder = { name: "script", build: async (job) => scripts.shift()!(job.workspace, job) };
    const fresh = nodePlatform(t.home, { secrets: new MemorySecretStore(), builders: { script: builder }, builder: () => "script", maxBuildAttempts: () => 1 });
    try {
      const [retry] = await fresh.recoverInterruptedBuilds();
      assert.ok(retry);
      assert.equal(fresh.registry.getBuild(retry)!.dependsOn, null, "the retry takes the first one's place: it waits for nothing");
      assert.equal(fresh.registry.getBuild(second.buildId)!.dependsOn, retry, "re-pointed to the retry");
      for (const id of [retry, second.buildId, third.buildId]) assert.equal((await fresh.settle(id)).status, "promoted");
    } finally {
      await fresh.drain();
      fresh.close();
    }
  });
});

describe("schedules approved with a build", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(async () => {
    await t.platform.drain();
    t.cleanup();
  });

  test("the owner's approved schedules are set up when the build promotes; one that doesn't fit is skipped", async () => {
    const { USER } = await import("@hewntools/core/auth.ts");
    t.queue(writeConnection);
    const b = await t.platform.create(USER, { ...connReq, schedules: [{ operation: "site@1", cadence: "daily 07:00" }, { operation: "nope", cadence: "hourly" }] });
    assert.equal(t.platform.listSchedules(USER).length, 0, "nothing before it promotes");
    const done = await t.platform.settle(b.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    const [s, ...rest] = t.platform.listSchedules(USER, "site-connection");
    assert.equal(rest.length, 0);
    assert.equal(s.operation, "site");
    assert.equal(s.cadence, "daily 07:00");
    assert.equal(s.status, "active");
    assert.ok(done.log.some((l) => /schedule .* set: site daily 07:00/.test(l)));
    assert.ok(done.log.some((l) => /schedule skipped \(nope hourly\)/.test(l)));
  });

  test("only the owner attaches schedules (agents propose them), and cadences are checked up front", async () => {
    const { USER } = await import("@hewntools/core/auth.ts");
    await assert.rejects(t.platform.create(t.claude, { ...connReq, schedules: [{ operation: "site", cadence: "hourly" }] }), (e: unknown) => e instanceof PlatformError && e.code === "forbidden");
    await assert.rejects(t.platform.create(USER, { ...connReq, schedules: [{ operation: "site", cadence: "sometimes" }] }), /cadence must be/);
    await assert.rejects(t.platform.create(USER, { ...connReq, schedules: [{ operation: "", cadence: "hourly" }] }), /operation and a cadence/);
    assert.equal(t.platform.registry.getCapability("site-connection"), undefined, "nothing reserved");
  });
});

describe("intake: a connection first", () => {
  test("a draft may carry a connection to build or change first", async () => {
    const { parseIntake, intakePrompt } = await import("@hewntools/cli/intake.ts");
    const base = { kind: "draft", message: "", questions: [], name: "Weekly Review", purpose: "p", requirements: "r", request: "", operations: [], uses: ["todoist"], hosts: [], secrets: [] };
    const none = { action: "none", capabilityId: "", name: "", purpose: "", requirements: "", request: "" };
    assert.equal((parseIntake(JSON.stringify({ ...base, connection: none }), "create") as any).draft.connection, undefined);
    const create = parseIntake(JSON.stringify({ ...base, connection: { ...none, action: "create", name: "Todoist", purpose: "Wraps Todoist", requirements: "list_tasks" } }), "create") as any;
    assert.deepEqual(create.draft.connection, { mode: "create", name: "Todoist", purpose: "Wraps Todoist", requirements: "list_tasks" });
    const modify = parseIntake(JSON.stringify({ ...base, connection: { ...none, action: "modify", capabilityId: "todoist", request: "add list_projects" } }), "create") as any;
    assert.deepEqual(modify.draft.connection, { mode: "modify", capabilityId: "todoist", request: "add list_projects" });
    const prompt = intakePrompt({ mode: "create", messages: [{ role: "user", content: "x" }], catalog: [{ id: "todoist", name: "Todoist", purpose: "p", operations: ["list_tasks@1"], kind: "connection" }] });
    assert.match(prompt, /Todoist \(todoist\) \[connection\]/);
    assert.match(prompt, /Only connections hold credentials/);
    // "Continue from here": the earlier conversation comes first, as context, then the new one.
    const again = intakePrompt({ mode: "modify", capabilityId: "x", messages: [{ role: "user", content: "now add y" }], earlier: { buildId: "b-1", version: 3, messages: [{ role: "user", content: "make x" }, { role: "intake", content: "DRAFT\nX" }] } });
    assert.match(again, /An earlier conversation, which led to version 3[^]*USER: make x[^]*YOU \(intake\): DRAFT[^]*Conversation so far:[^]*USER: now add y/);
    assert.doesNotMatch(prompt, /An earlier conversation, which led to/);
    // Attachments: listed under the message, a text file's content with it; images go to the model apart from the text.
    const { claudeIntakeInput, intakeImages } = await import("@hewntools/cli/intake.ts");
    const notes = Buffer.from("hello notes").toString("base64");
    const withFiles = { mode: "create" as const, messages: [{ role: "user" as const, content: "like this", attachments: [{ ref: "at-1", kind: "image" as const, name: "screen.png", mediaType: "image/png", width: 10, height: 20, data: "aW1n" }, { ref: "at-2", kind: "file" as const, name: "notes.txt", mediaType: "text/plain", data: notes }] }] };
    const attached = intakePrompt(withFiles);
    assert.match(attached, /USER: like this\n\[attached: screen\.png \(image 10×20\), notes\.txt \(file\)\]\n--- attached file notes\.txt ---\nhello notes\n--- end of notes\.txt ---/);
    assert.match(attached, /- Attachments: the owner may attach screenshots and files/);
    assert.deepEqual(intakeImages(withFiles).map((a) => a.name), ["screen.png"]);
    const input = JSON.parse(claudeIntakeInput("the prompt", [{ mediaType: "image/png", data: "aW1n" }]));
    assert.equal(input.type, "user");
    assert.deepEqual(input.message.content, [{ type: "text", text: "the prompt" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } }]);
    // The owner's standing rules, and how to remember new ones (creating: global only; modifying: this tool too).
    assert.doesNotMatch(prompt, /standing rules for building \(/);
    const ruled = intakePrompt({ mode: "modify", capabilityId: "x", messages: [{ role: "user", content: "x" }], instructions: { global: ["Swedish copy"], tool: ["One screen"] } });
    assert.match(ruled, /The owner's standing rules for building[^]*For every tool:\n- Swedish copy\n[^]*For this tool:\n- One screen\n/);
    assert.match(ruled, /Remember standing rules[^]*put its exact text in "forget"/);
    assert.doesNotMatch(ruled, /there is no tool yet/);
    assert.match(intakePrompt({ mode: "create", messages: [{ role: "user", content: "x" }], instructions: { global: ["Swedish copy"] } }), /For every tool:\n- Swedish copy\n[^]*there is no tool yet/);
    // The reply's memory comes through on any kind of reply, well-formed entries only.
    const remembered = parseIntake(JSON.stringify({ kind: "questions", message: "", questions: ["q?"], remember: [{ scope: "global", text: " Swedish copy " }, { scope: "nope", text: "x" }, { scope: "tool" }], forget: [] }), "modify") as any;
    assert.deepEqual(remembered.remember, [{ scope: "global", text: "Swedish copy" }]);
    assert.equal(remembered.forget, undefined);
    // Asks until it's clear, per mode, with defaults; no cap on rounds (the owner's Draft now is the stop).
    assert.match(prompt, /Ask until it's clear; then draft\. Before a draft you must be able to say, from the conversation: the moment[^]*each carrying the default you'd assume[^]*An "ok" from the owner means every default; don't tell them how to answer[^]*When the owner says to draft now/);
    assert.doesNotMatch(prompt, /Just say ok/, "the owner isn't told how to answer every time");
    assert.doesNotMatch(prompt, /Round \d+ of at most|last round/);
    assert.match(ruled, /what exactly changes and where[^]*A vague one \("improve the UX"/);
    assert.doesNotMatch(ruled, /the moment \(when the owner opens/);
  });

  test("creating: several ideas at once, each a full draft (incomplete ones dropped, at most five)", async () => {
    const { parseIntake, intakePrompt } = await import("@hewntools/cli/intake.ts");
    const none = { action: "none", capabilityId: "", name: "", purpose: "", requirements: "", request: "" };
    const idea = (name: string, extra = {}) => ({ name, purpose: `${name} purpose`, requirements: "r", operations: [{ name: "add", sideEffect: "write" }], widgets: [], model: "none", uses: [], hosts: [], secrets: [], connection: none, ...extra });
    const base = { kind: "ideas", message: "Three for you", questions: [], name: "", purpose: "", requirements: "", request: "", operations: [], widgets: [], model: "none", uses: [], hosts: [], secrets: [], connection: none, proposals: [] };
    const spotify = { ...none, action: "create", name: "Spotify", purpose: "Wraps Spotify", requirements: "now_playing" };
    const r = parseIntake(JSON.stringify({ ...base, ideas: [idea("Coffee Log"), idea(""), idea("Listening Diary", { uses: ["spotify"], connection: spotify })] }), "create") as any;
    assert.equal(r.kind, "ideas");
    assert.equal(r.message, "Three for you");
    assert.deepEqual(r.ideas.map((d: any) => d.name), ["Coffee Log", "Listening Diary"]);
    assert.deepEqual(r.ideas[0].spec.operations, [{ name: "add", sideEffect: "write" }]);
    assert.deepEqual(r.ideas[1].connection, { mode: "create", name: "Spotify", purpose: "Wraps Spotify", requirements: "now_playing" });
    const many = parseIntake(JSON.stringify({ ...base, ideas: ["A", "B", "C", "D", "E", "F", "G"].map((n) => idea(n)) }), "create") as any;
    assert.equal(many.ideas.length, 5);
    assert.throws(() => parseIntake(JSON.stringify({ ...base, ideas: [idea("")] }), "create"), /ideas missing/);
    // Ideas only exist when creating.
    assert.throws(() => parseIntake(JSON.stringify({ ...base, ideas: [idea("A")] }), "modify"), /missing 'request'/);
    assert.match(intakePrompt({ mode: "create", messages: [{ role: "user", content: "suggest some tools" }] }), /reply kind "ideas"[^]*build on another idea[^]*Never a cycle/);
    assert.doesNotMatch(intakePrompt({ mode: "modify", messages: [{ role: "user", content: "x" }] }), /reply kind "ideas"/);
  });

  test("schedules: suggested with a draft or an idea, or alone for operations a tool already has", async () => {
    const { parseIntake, intakePrompt } = await import("@hewntools/cli/intake.ts");
    const none = { action: "none", capabilityId: "", name: "", purpose: "", requirements: "", request: "" };
    const base = { message: "", questions: [], name: "", purpose: "", requirements: "", request: "", operations: [], widgets: [], model: "none", uses: [], hosts: [], secrets: [], connection: none, proposals: [], ideas: [], schedules: [] };
    const fetch = { operation: "fetch_tonight@1", cadence: "daily 18:00", why: "fresh numbers every evening" };
    const d = parseIntake(JSON.stringify({ ...base, kind: "draft", name: "Aurora", purpose: "p", requirements: "r", schedules: [fetch, { operation: "", cadence: "hourly", why: "" }] }), "create") as any;
    assert.deepEqual(d.draft.schedules, [{ operation: "fetch_tonight", cadence: "daily 18:00", why: "fresh numbers every evening" }]);
    assert.equal((parseIntake(JSON.stringify({ ...base, kind: "draft", request: "r" }), "modify") as any).draft.schedules, undefined);
    const idea = { name: "Aurora", purpose: "p", requirements: "r", operations: [], widgets: [], model: "none", uses: [], hosts: [], secrets: [], connection: none, schedules: [fetch] };
    assert.equal((parseIntake(JSON.stringify({ ...base, kind: "ideas", ideas: [idea] }), "create") as any).ideas[0].schedules[0].operation, "fetch_tonight");
    const current = { id: "aurora", operations: [{ name: "fetch_tonight", version: 1 }] } as any;
    const only = parseIntake(JSON.stringify({ ...base, kind: "schedules", schedules: [fetch, { ...fetch, operation: "made_up" }] }), "modify", current) as any;
    assert.equal(only.kind, "schedules");
    assert.deepEqual(only.schedules.map((x: any) => x.operation), ["fetch_tonight"], "only operations it has");
    assert.throws(() => parseIntake(JSON.stringify({ ...base, kind: "schedules", schedules: [{ ...fetch, operation: "made_up" }] }), "modify", current), /no operation the capability has/);
    const p = intakePrompt({ mode: "modify", messages: [{ role: "user", content: "x" }] });
    assert.match(p, /suggest it yourself in "schedules"/);
    assert.match(p, /reply kind "schedules"/);
    assert.match(p, /revise it: change what they asked for and keep everything else/);
  });
});
