// SPDX-License-Identifier: AGPL-3.0-or-later
// The host's builder and intake (HEWN_BUILD_URL), against a fake build service: the workspace goes
// out and comes back, activity streams, refusals and a bad token stop at once, cancelling stops the
// request, and the intake's answer streams in and is read like a local one.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { remoteBuilder, remoteGenerate, remoteIntake, remoteJobsFromEnv, type RemoteJobs } from "@hewntools/cli/builders/remote.ts";
import { remoteCatalog } from "@hewntools/cli/builders/models.ts";
import type { BuildJob } from "@hewntools/cli/builders/types.ts";
import { initConfig, readConfig, writeConfig } from "@hewntools/cli/config.ts";
import { openHome } from "@hewntools/cli/home.ts";

type Handler = (body: any, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("remote builder and intake", () => {
  let server: Server;
  let remote: RemoteJobs;
  let handle: Handler = () => {};
  const seen: { path: string; auth?: string; body: any }[] = [];
  let closed = false;

  before(async () => {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ path: req.url!, auth: req.headers.authorization, body });
      res.on("close", () => (closed = true));
      if (req.url === "/v1/models") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [{ id: "fast", label: "Fast", kind: "family", efforts: ["low"] }], tiers: { light: "Haiku 5.5", strong: "Opus 5.5", odd: "ignored" } }));
      await handle(body, req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    remote = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, token: "hewn-token", label: "Test Cloud" };
  });
  after(() => server.close());

  const workspace = () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-remote-"));
    writeFileSync(join(dir, "BUILDER.md"), "brief");
    writeFileSync(join(dir, "old.txt"), "gone after the build");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "// old");
    return dir;
  };
  const job = (dir: string, extra: Partial<BuildJob> = {}): BuildJob & { activity: string[]; models: string[] } => {
    const activity: string[] = [];
    const models: string[] = [];
    return { buildId: "b-1", capabilityId: "notes", kind: "create", workspace: dir, attempt: 1, logPath: join(dir, "..", `${dir.split("/").pop()}.log`), onActivity: (l) => activity.push(l), onModel: (m) => models.push(m), activity, models, ...extra };
  };
  const ndjson = (res: ServerResponse, events: unknown[]) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const e of events) res.write(JSON.stringify(e) + "\n");
    res.end();
  };

  test("the workspace goes out with the brief; activity streams back; the returned tree replaces it", async () => {
    handle = (body, _req, res) =>
      ndjson(res, [
        { activity: "→ Write src/index.ts" },
        { model: "claude-fable-5-5" },
        { heartbeat: true },
        { charge: { amount: 12, unit: "points" } },
        { files: { "BUILDER.md": b64("brief"), "src/index.ts": b64("export const operations = {};"), "capability.json": b64("{}") } },
        { done: true },
      ]);
    const dir = workspace();
    const charges: unknown[] = [];
    const j = job(dir, { model: "fable", effort: "high", feedback: "1 test failed", onCharge: (c) => charges.push(c) });
    await remoteBuilder(remote).build(j);
    const sent = seen.at(-1)!;
    assert.equal(sent.path, "/v1/builds");
    assert.equal(sent.auth, "Bearer hewn-token");
    assert.equal(sent.body.model, "fable");
    assert.equal(sent.body.effort, "high");
    assert.equal(sent.body.feedback, "1 test failed");
    assert.match(sent.body.prompt, /builder for Hewn/);
    assert.equal(Buffer.from(sent.body.files["src/index.ts"], "base64").toString(), "// old");
    assert.deepEqual(j.activity, ["→ Write src/index.ts"]);
    assert.deepEqual(j.models, ["claude-fable-5-5"]);
    assert.deepEqual(charges, [{ amount: 12, unit: "points" }]);
    assert.equal(readFileSync(join(dir, "src", "index.ts"), "utf8"), "export const operations = {};");
    assert.ok(existsSync(join(dir, "capability.json")));
    assert.ok(!existsSync(join(dir, "old.txt")), "files it didn't return are gone");
    assert.match(readFileSync(j.logPath, "utf8"), /Test Cloud[\s\S]*→ Write src\/index.ts/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a refusal, as an event or as the status, is final and says why", async () => {
    const dir = workspace();
    handle = (_b, _r, res) => ndjson(res, [{ refused: "You've used this month's 40 builds." }]);
    await assert.rejects(remoteBuilder(remote).build(job(dir)), (e: Error & { refused?: boolean }) => e.refused === true && /40 builds/.test(e.message));
    handle = (_b, _r, res) => void res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ refused: "Five builds are running already." }));
    await assert.rejects(remoteBuilder(remote).build(job(dir)), (e: Error & { refused?: boolean }) => e.refused === true && /Five builds/.test(e.message));
    handle = (_b, _r, res) => void res.writeHead(401).end();
    await assert.rejects(remoteBuilder(remote).build(job(dir)), (e: Error & { unavailable?: boolean }) => e.unavailable === true && /token/.test(e.message));
    handle = (_b, _r, res) => ndjson(res, [{ error: "the builder crashed" }]);
    await assert.rejects(remoteBuilder(remote).build(job(dir)), (e: Error & { unavailable?: boolean; refused?: boolean }) => !e.unavailable && !e.refused && /crashed/.test(e.message));
    handle = (_b, _r, res) => ndjson(res, [{ done: true }]);
    await assert.rejects(remoteBuilder(remote).build(job(dir)), /without returning the workspace/);
    // The stream closing without "done" (the service crashed mid-way) is no finished build, files or not.
    handle = (_b, _r, res) => ndjson(res, [{ files: { "src/index.ts": b64("half") } }]);
    await assert.rejects(remoteBuilder(remote).build(job(dir)), /Test Cloud ended without finishing/);
    assert.equal(readFileSync(join(dir, "src", "index.ts"), "utf8"), "// old", "nothing was written");
    // Paths outside the workspace (or artefacts) are refused before anything is written.
    for (const bad of ["../escape.txt", "/etc/x", "a/../../b", "node_modules/x.js"]) {
      handle = (_b, _r, res) => ndjson(res, [{ files: { "src/index.ts": b64("new"), [bad]: b64("x") } }, { done: true }]);
      await assert.rejects(remoteBuilder(remote).build(job(dir)), /won't write/, bad);
      assert.equal(readFileSync(join(dir, "src", "index.ts"), "utf8"), "// old", "nothing was written");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a file sent mid-build (the icon) is in the workspace at once; the final tree still decides", async () => {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    handle = (_b, _r, res) =>
      ndjson(res, [
        { file: { path: "ui/icon.svg", content: b64(icon) } },
        { file: { path: "../escape.svg", content: b64("x") } },
        { file: { path: "ui", content: b64("x") } },
        { activity: "→ Write src/index.ts" },
        { files: { "BUILDER.md": b64("brief"), "ui/icon.svg": b64(icon), "src/index.ts": b64("export const operations = {};") } },
        { done: true },
      ]);
    const dir = workspace();
    let iconWhileBuilding: string | undefined;
    await remoteBuilder(remote).build(job(dir, { onActivity: () => (iconWhileBuilding = readFileSync(join(dir, "ui", "icon.svg"), "utf8")) }));
    assert.equal(iconWhileBuilding, icon, "written before the build ended");
    assert.ok(!existsSync(join(dir, "..", "escape.svg")), "a path outside the workspace is ignored");
    // "ui" is a directory by then: that file can't be written, and the build goes on.
    assert.equal(readFileSync(join(dir, "ui", "icon.svg"), "utf8"), icon);
    assert.ok(!existsSync(join(dir, "old.txt")));
    rmSync(dir, { recursive: true, force: true });
  });

  test("cancelling the build closes the request", async () => {
    closed = false;
    handle = (_b, _r, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ activity: "working" }) + "\n");
    };
    const dir = workspace();
    const abort = new AbortController();
    const run = remoteBuilder(remote).build(job(dir, { signal: abort.signal, onActivity: () => abort.abort() }));
    await assert.rejects(run, (e: Error & { cancelled?: boolean }) => e.cancelled === true);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(closed, "the service sees the connection close and stops");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the intake: one session per conversation, the answer streams, the reply is read like a local one", async () => {
    const reply = { kind: "questions", message: "A few things first.", questions: ["Daily or weekly?"] };
    const text = JSON.stringify(reply);
    handle = (_b, _r, res) => ndjson(res, [{ activity: "Searching the web" }, { text: text.slice(0, 20) }, { text: text.slice(20) }, { result: text }]);
    const progress: unknown[] = [];
    const got = await remoteIntake(remote, { model: "fast", effort: "low" })({ mode: "create", messages: [{ role: "user", content: "track my coffee" }], session: "s-1" }, (p) => progress.push(p));
    assert.deepEqual(got, reply);
    const sent = seen.at(-1)!;
    assert.equal(sent.path, "/v1/intake");
    assert.equal(sent.body.session, "s-1");
    assert.equal(sent.body.model, "fast");
    assert.equal(sent.body.effort, "low");
    assert.ok(sent.body.schema?.properties, "the reply's JSON schema goes with it");
    assert.match(sent.body.prompt, /track my coffee/);
    assert.deepEqual(progress[0], { activity: "Searching the web" });
    assert.ok(progress.some((p) => (p as { message?: string }).message === "A few things first."), "the message shows while it's written");
    handle = (_b, _r, res) => ndjson(res, [{ refused: "The intake is paused for this account." }]);
    await assert.rejects(remoteIntake(remote)({ mode: "create", messages: [{ role: "user", content: "x" }] }), (e: Error & { refused?: boolean }) => e.refused === true);
    handle = (_b, _r, res) => ndjson(res, [{ error: "no model key for this account", unavailable: true }]);
    await assert.rejects(remoteIntake(remote)({ mode: "create", messages: [{ role: "user", content: "x" }] }), (e: Error & { unavailable?: boolean }) => e.unavailable === true && /no model key/.test(e.message));
    handle = (_b, _r, res) => ndjson(res, [{ error: "the model timed out" }]);
    await assert.rejects(remoteIntake(remote)({ mode: "create", messages: [{ role: "user", content: "x" }] }), (e: Error & { unavailable?: boolean }) => !e.unavailable && /timed out/.test(e.message));
  });

  test("tools' model calls (hosted): the request goes as JSON; refusals, a bad token and a charged failure", async () => {
    const req = { capabilityId: "word-explainer", tier: "light" as const, messages: [{ role: "user" as const, content: "gruntled" }], maxTokens: 300 };
    const signal = new AbortController().signal;
    const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    handle = (_b, _r, res) => json(res, 200, { text: "Pleased.", usage: { inputTokens: 10, outputTokens: 2 }, model: "claude-haiku-5-5", charge: { amount: 0.37, unit: "Credits" } });
    const r = await remoteGenerate(remote)(req, signal);
    assert.deepEqual(r, { text: "Pleased.", usage: { inputTokens: 10, outputTokens: 2 }, model: "claude-haiku-5-5", charge: { amount: 0.37, unit: "Credits" } });
    const sent = seen.at(-1)!;
    assert.equal(sent.path, "/v1/generate");
    assert.equal(sent.auth, "Bearer hewn-token");
    assert.deepEqual(sent.body, req);
    for (const status of [402, 403, 429]) {
      handle = (_b, _r, res) => json(res, status, { refused: "This Hewn has used this month's 800 Credits." });
      await assert.rejects(remoteGenerate(remote)(req, signal), (e: Error & { refused?: boolean }) => e.refused === true && /800 Credits/.test(e.message));
    }
    handle = (_b, _r, res) => json(res, 401, {});
    await assert.rejects(remoteGenerate(remote)(req, signal), (e: Error & { unavailable?: boolean }) => e.unavailable === true && /token/.test(e.message));
    handle = (_b, _r, res) => json(res, 502, { error: "the model refused", charge: { amount: 0.12, unit: "Credits" } });
    await assert.rejects(remoteGenerate(remote)(req, signal), (e: Error & { charge?: unknown; refused?: boolean }) => !e.refused && /the model refused/.test(e.message) && (e.charge as { amount: number }).amount === 0.12);
    // An intake turn's charge goes to the caller as progress (recorded, not shown).
    const reply = JSON.stringify({ kind: "questions", message: "Which?", questions: ["A?"] });
    handle = (_b, _r, res) => ndjson(res, [{ charge: { amount: 4, unit: "Credits" } }, { result: reply }]);
    const progress: unknown[] = [];
    await remoteIntake(remote)({ mode: "create", messages: [{ role: "user", content: "x" }] }, (p) => progress.push(p));
    assert.deepEqual(progress, [{ charge: { amount: 4, unit: "Credits" } }]);
  });

  test("its model list, and the environment that turns it on", async () => {
    const c = await remoteCatalog(remote.url, remote.token);
    assert.deepEqual(c.models.map((m) => m.id), ["default", "fast"]);
    assert.deepEqual(c.tiers, { light: "Haiku 5.5", strong: "Opus 5.5" }, "what each tier runs on, for Settings");
    assert.equal(remoteJobsFromEnv({}), undefined);
    assert.deepEqual(remoteJobsFromEnv({ HEWN_BUILD_URL: "https://builds.example/", HEWN_BUILD_TOKEN: "t", HEWN_BUILD_NAME: "Test Cloud" }), { url: "https://builds.example/", token: "t", label: "Test Cloud" });
    assert.throws(() => remoteJobsFromEnv({ HEWN_BUILD_URL: "file:///etc" }), /https/);
    assert.throws(() => remoteJobsFromEnv({ HEWN_BUILD_URL: "http://builds.example/" }), /https/, "the token never goes in clear text");
    assert.ok(remoteJobsFromEnv({ HEWN_BUILD_URL: "http://127.0.0.1:9/" }));
  });

  test("platform.json: the host's builder and intake are the default; a save stores only what changed", (t) => {
    const home = openHome(mkdtempSync(join(tmpdir(), "hewn-remote-config-")));
    const file = () => JSON.parse(readFileSync(join(home.root, "platform.json"), "utf8"));
    const was = process.env.HEWN_BUILD_URL;
    delete process.env.HEWN_BUILD_URL;
    t.after(() => {
      if (was === undefined) delete process.env.HEWN_BUILD_URL;
      else process.env.HEWN_BUILD_URL = was;
      rmSync(home.root, { recursive: true, force: true });
    });
    initConfig(home);
    writeConfig(home, { timeZone: "Europe/Stockholm" });
    assert.deepEqual(file(), { timeZone: "Europe/Stockholm" }, "no defaults stored");
    assert.equal(readConfig(home).builder, "claude");
    process.env.HEWN_BUILD_URL = "http://127.0.0.1:9/";
    assert.deepEqual([readConfig(home).builder, readConfig(home).intake], ["remote", "remote"]);
    // Stored by 0.4.2 without the owner choosing it: the host's default applies.
    writeFileSync(join(home.root, "platform.json"), JSON.stringify({ builder: "claude", intake: "claude", maxBuildAttempts: 3 }));
    assert.equal(readConfig(home).builder, "remote");
    writeConfig(home, { builder: "codex", intake: "codex", jobsChosen: ["builder", "intake"] });
    assert.deepEqual([readConfig(home).builder, readConfig(home).intake], ["codex", "codex"]);
  });
});
