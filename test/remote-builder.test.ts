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
import { remoteBuilder, remoteIntake, remoteJobsFromEnv, type RemoteJobs } from "@hewntools/cli/builders/remote.ts";
import { remoteCatalog } from "@hewntools/cli/builders/models.ts";
import type { BuildJob } from "@hewntools/cli/builders/types.ts";

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
      if (req.url === "/v1/models") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [{ id: "fast", label: "Fast", kind: "family", efforts: ["low"] }] }));
      await handle(body, req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    remote = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, token: "cell-token", label: "Test Cloud" };
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
        { files: { "BUILDER.md": b64("brief"), "src/index.ts": b64("export const operations = {};"), "capability.json": b64("{}") } },
        { done: true },
      ]);
    const dir = workspace();
    const j = job(dir, { model: "fable", effort: "high", feedback: "1 test failed" });
    await remoteBuilder(remote).build(j);
    const sent = seen.at(-1)!;
    assert.equal(sent.path, "/v1/builds");
    assert.equal(sent.auth, "Bearer cell-token");
    assert.equal(sent.body.model, "fable");
    assert.equal(sent.body.effort, "high");
    assert.equal(sent.body.feedback, "1 test failed");
    assert.match(sent.body.prompt, /builder for Hewn/);
    assert.equal(Buffer.from(sent.body.files["src/index.ts"], "base64").toString(), "// old");
    assert.deepEqual(j.activity, ["→ Write src/index.ts"]);
    assert.deepEqual(j.models, ["claude-fable-5-5"]);
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
    // Paths outside the workspace (or artefacts) are refused before anything is written.
    for (const bad of ["../escape.txt", "/etc/x", "a/../../b", "node_modules/x.js"]) {
      handle = (_b, _r, res) => ndjson(res, [{ files: { "src/index.ts": b64("new"), [bad]: b64("x") } }, { done: true }]);
      await assert.rejects(remoteBuilder(remote).build(job(dir)), /won't write/, bad);
      assert.equal(readFileSync(join(dir, "src", "index.ts"), "utf8"), "// old", "nothing was written");
    }
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
    const got = await remoteIntake(remote)({ mode: "create", messages: [{ role: "user", content: "track my coffee" }], session: "s-1", run: { model: "fast", effort: "low" } }, (p) => progress.push(p));
    assert.deepEqual(got, reply);
    const sent = seen.at(-1)!;
    assert.equal(sent.path, "/v1/intake");
    assert.equal(sent.body.session, "s-1");
    assert.equal(sent.body.model, "fast");
    assert.ok(sent.body.schema?.properties, "the reply's JSON schema goes with it");
    assert.match(sent.body.prompt, /track my coffee/);
    assert.deepEqual(progress[0], { activity: "Searching the web" });
    assert.ok(progress.some((p) => (p as { message?: string }).message === "A few things first."), "the message shows while it's written");
    handle = (_b, _r, res) => ndjson(res, [{ refused: "The intake is paused for this account." }]);
    await assert.rejects(remoteIntake(remote)({ mode: "create", messages: [{ role: "user", content: "x" }] }), (e: Error & { refused?: boolean }) => e.refused === true);
  });

  test("its model list, and the environment that turns it on", async () => {
    const c = await remoteCatalog(remote.url, remote.token);
    assert.deepEqual(c.models.map((m) => m.id), ["default", "fast"]);
    assert.equal(remoteJobsFromEnv({}), undefined);
    assert.deepEqual(remoteJobsFromEnv({ HEWN_BUILD_URL: "https://builds.example/", HEWN_BUILD_TOKEN: "t", HEWN_BUILD_NAME: "Hewn Cloud" }), { url: "https://builds.example/", token: "t", label: "Hewn Cloud" });
    assert.throws(() => remoteJobsFromEnv({ HEWN_BUILD_URL: "file:///etc" }), /https/);
    assert.throws(() => remoteJobsFromEnv({ HEWN_BUILD_URL: "http://builds.example/" }), /https/, "the token never goes in clear text");
    assert.ok(remoteJobsFromEnv({ HEWN_BUILD_URL: "http://127.0.0.1:9/" }));
  });
});
