// SPDX-License-Identifier: AGPL-3.0-or-later
// The platform and the tools run in separate workerd processes: what each holds, the channel between
// them (its tokens, code by hash), and a tool that won't stop when its call's deadline comes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { request } from "node:http";
import { platform as osPlatform } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { config as platformConfig, sandboxed, toolsConfig, toolsSandbox } from "@hewntools/cli/supervisor/index.ts";
import { workerdBinary } from "@hewntools/cli/app-dir.ts";
import { STORAGE_KEYS } from "@hewntools/cli/supervisor/format.ts";
import { toolsChannel, type ToolsSocket, ToolsUnreachable } from "@hewntools/host-workerd/tools-channel.ts";
import { CALL_DEADLINE_MS } from "@hewntools/core/platform.ts";
import { FIXTURES } from "./helpers.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

const channel = { tools: "unix:/h/workerd/run/tools.sock", calls: "unix:/h/workerd/run/calls.sock" };

describe("what each process holds", () => {
  const platform = platformConfig({ dir: "/h/workerd", keys: STORAGE_KEYS, port: 7000, publicPort: 7001, supervisorPort: 1, data: "/h/workerd", assets: { web: "/w", ui: "/u", docs: "/d", spec: "/s" }, channel });
  const tools = toolsConfig({ keys: STORAGE_KEYS, data: "/h/workerd", channel });

  test("the tools' process has the tools' storage, the loader and the network; nothing of the owner's", () => {
    for (const held of ['className = "CapabilityHost"', "workerLoader", '(name = "internet"', `address = "${channel.tools}"`]) assert.ok(tools.includes(held), held);
    for (const owners of ["SECRETS_KEY", "ADMIN_TOKEN", "SUPERVISOR_TOKEN", "HewnDO", "blobs", "assets", "supervisor", 'embed "worker.js"', "builder-brief"]) assert.ok(!tools.includes(owners), owners);
  });

  test("the platform's process has the owner's DO and calls the tools over their socket; it runs no tool code", () => {
    for (const held of ['className = "HewnDO"', "SECRETS_KEY", `address = "${channel.tools}"`, `address = "${channel.calls}", http = (), service = (name = "main", entrypoint = "ToolCalls")`]) assert.ok(platform.includes(held), held);
    for (const tools of ["CapabilityHost", "workerLoader", "capability-runtime", "capability-guard"]) assert.ok(!platform.includes(tools), tools);
  });

  test("both keep their data in the same do/ directory, each in its own namespace: a home carries over as it is", () => {
    for (const c of [platform, tools]) assert.match(c, /\(name = "do-storage", disk = \(path = "\/h\/workerd\/do", writable = true\)\)/);
    assert.match(platform, new RegExp(`uniqueKey = "${STORAGE_KEYS.owner}"`));
    assert.match(tools, new RegExp(`uniqueKey = "${STORAGE_KEYS.capability}"`));
  });

  test("the tools' sandbox hides the data dir but for their storage and the sockets", () => {
    const cmd = sandboxed(["workerd"], { readable: ["/bin/wd", "/h/workerd/tools.capnp"], listable: ["/h/workerd/do"], writable: ["/h/workerd/do/hewn-capability", "/h/workerd/run"], hidden: ["/h/workerd"], profile: join(process.env.TMPDIR ?? "/tmp", `hewn-tools-${process.pid}.sb`) });
    if (osPlatform() === "darwin") {
      const profile = readFileSync(cmd[2], "utf8");
      assert.match(profile, /\(deny file-read\* \(subpath "[^"]+"\) \(subpath "\/h\/workerd"\)\)/);
      assert.match(profile, /\(allow file-write\* \(subpath "\/h\/workerd\/do\/hewn-capability"\) \(subpath "\/h\/workerd\/run"\)/);
      // do/ itself, to open it; not what's in it (the owner's DO).
      assert.match(profile, /\(literal "\/h\/workerd\/do"\)/);
      assert.ok(!profile.includes('(subpath "/h/workerd/do")'));
    } else {
      const binds = cmd.flatMap((a, i) => (a === "--bind" ? [cmd[i + 1]] : []));
      assert.deepEqual(binds, ["/h/workerd/do/hewn-capability", "/h/workerd/run"]);
    }
  });
});

describe("the channel's code by hash", () => {
  const recorder = (answer: (body: any, n: number) => Response) => {
    const bodies: any[] = [];
    const fetcher = { fetch: async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), answer(bodies.at(-1), bodies.length)) } as unknown as ToolsSocket;
    return { bodies, fetcher };
  };
  const code = { hash: "h1", js: "export const operations = {};" };

  test("a bundle's text goes once; after that its hash, and the text again when the tools process asks", async () => {
    let forgot = false;
    const { bodies, fetcher } = recorder((b) => (forgot && !b.code.js ? Response.json({ missing: b.code.hash }, { status: 409 }) : Response.json({ result: ["x@1"] })));
    const host = toolsChannel(fetcher, "t")("cap");
    assert.deepEqual(await host.describe({ code }), ["x@1"]);
    await host.describe({ code });
    forgot = true;
    await host.describe({ code });
    assert.deepEqual(bodies.map((b) => !!b.code.js), [true, false, false, true]);
    assert.ok(bodies.every((b) => b.capabilityId === "cap"));
  });

  test("the tools process gone, or not answering in time, is told apart from a tool's error", async () => {
    const gone = toolsChannel({ fetch: async () => Promise.reject(new TypeError("Network connection lost.")) } as unknown as ToolsSocket, "t")("cap");
    const e = await gone.hasState({ scratch: null }).catch((x) => x);
    assert.ok(e instanceof ToolsUnreachable && !e.timeout);
    const stuck = toolsChannel({ fetch: async () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })) } as unknown as ToolsSocket, "t")("cap");
    const t = await stuck.stop({ scratch: null, reason: "r" }, { timeoutMs: 1000 }).catch((x) => x);
    assert.ok(t instanceof ToolsUnreachable && t.timeout);
    const failing = toolsChannel({ fetch: async () => Response.json({ error: "no such table: runs" }, { status: 500 }) } as unknown as ToolsSocket, "t")("cap");
    const f = await failing.hasState({ scratch: null }).catch((x) => x);
    assert.ok(!(f instanceof ToolsUnreachable) && /no such table/.test(f.message));
  });
});

/** A request on a Unix socket. */
const onSocket = (socketPath: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new Promise<{ status: number; body: string }>((done, fail) => {
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    const r = request({ socketPath, path, method: o.method ?? "GET", headers: { host: "x", ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}), ...o.headers } }, (m) => {
      let b = "";
      m.on("data", (d) => (b += d));
      m.on("end", () => done({ status: m.statusCode!, body: b }));
    });
    r.on("error", fail);
    if (body) r.write(body);
    r.end();
  });

describe("two processes on the real host", () => {
  let h: TestHost;
  let run: string;
  before(async () => {
    h = await startTestHost();
    run = join(h.root, "workerd", "run");
    const r = await h.sv.admin("install", { name: "Runaway", purpose: "runs on", dir: join(FIXTURES, "runaway"), wait: true });
    assert.equal(r.status, "promoted", r.log.join("\n"));
  });
  after(() => h?.stop());

  test("the sockets are in a directory only this user can enter, and the data dir holds the same two namespaces as before", async () => {
    assert.equal(statSync(run).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(run).sort(), ["calls.sock", "tools.sock"]);
    await h.invoke("runaway", "tick", { tag: "here" });
    assert.deepEqual(readdirSync(join(h.root, "workerd", "do")).sort(), [STORAGE_KEYS.capability, STORAGE_KEYS.owner].sort());
  });

  test("the tools' socket takes the platform's calls only with the tools' token", async () => {
    assert.equal((await onSocket(join(run, "tools.sock"), "/health")).status, 200);
    const r = await onSocket(join(run, "tools.sock"), "/hasState", { method: "POST", headers: { "x-hewn-tools": "x".repeat(48) }, body: { capabilityId: "runaway", scratch: null } });
    assert.equal(r.status, 401);
  });

  test("a callback for a call that isn't running is refused", async () => {
    const r = await onSocket(join(run, "calls.sock"), "/call", { method: "POST", headers: { "x-hewn-call": "y".repeat(48) }, body: { capabilityId: "runaway", operation: "count", input: {} } });
    assert.equal(r.status, 403);
    assert.match(r.body, /isn't running/);
    // Nor is the platform's own API on that socket.
    assert.equal((await onSocket(join(run, "calls.sock"), "/api/capabilities")).status, 404);
  });

  test("the tools' process doesn't get the platform's secrets in its environment", async (t) => {
    const status = await (await fetch(`${h.sv.control.url}/control/status`, { method: "POST", headers: { "x-hewn-control": h.sv.control.token } })).json();
    assert.ok(status.toolsPid && status.toolsPid !== status.workerdPid);
    let env: string;
    try {
      env = osPlatform() === "linux" ? readFileSync(`/proc/${status.toolsPid}/environ`, "utf8").replaceAll("\0", " ") : execFileSync("ps", ["eww", "-o", "command=", "-p", String(status.toolsPid)], { encoding: "utf8" });
    } catch {
      return t.skip("can't read the process's environment here");
    }
    assert.match(env, /HEWN_TOOLS_TOKEN=/);
    for (const secret of ["HEWN_SECRETS_KEY", "HEWN_ADMIN_TOKEN", "HEWN_SUPERVISOR_TOKEN", "HEWN_PROXY_SECRET"]) assert.ok(!env.includes(`${secret}=`), secret);
  });
});

describe("a tool that won't stop when its call's deadline comes", () => {
  let h: TestHost;
  before(async () => {
    // The watchdog looks away (its stall is longer than the deadline): only the deadline's stop is left.
    h = await startTestHost({ watchdog: { intervalMs: 200, stallMs: CALL_DEADLINE_MS * 3 } });
    const r = await h.sv.admin("install", { name: "Runaway", purpose: "runs on", dir: join(FIXTURES, "runaway"), wait: true });
    assert.equal(r.status, "promoted", r.log.join("\n"));
  });
  after(() => h?.stop());

  test("the stop goes unanswered, so the tools are restarted: the call times out, the tool is told, the platform runs on", { timeout: CALL_DEADLINE_MS + 30_000 }, async () => {
    const before = { platform: h.sv.restarts(), tools: h.sv.toolsRestarts() };
    const e = await h.invoke("runaway", "spin").then(() => assert.fail("spin returned"), (x: Error) => x);
    assert.match(e.message, /spin@1 timed out/);
    assert.equal(h.sv.toolsRestarts(), before.tools + 1, "the tools were restarted once");
    assert.equal(h.sv.restarts(), before.platform, "the platform wasn't");
    const log: string[] = (await h.sv.admin("logs", { capabilityId: "runaway", n: 20 })).lines;
    assert.equal(log.filter((l) => / spin@1 ERROR stalled: Hewn's tools stopped responding while this ran/.test(l)).length, 1, log.join("\n"));
    assert.equal(log.filter((l) => / spin@1 ERROR operation_failed/.test(l)).length, 0, "told once, as a stall");
    await h.invoke("runaway", "tick", { tag: "after" });
    assert.equal((await h.invoke("runaway", "count")).result.rows.after, 1, "the tool runs again");
  });
});

const canSandbox = osPlatform() === "darwin" ? existsSync("/usr/bin/sandbox-exec") : spawnSync("bwrap", ["--version"]).status === 0;

describe("both processes in their sandboxes", { skip: !canSandbox && "no OS sandbox here (sandbox-exec, bwrap)" }, () => {
  let h: TestHost;
  let data: string;
  before(async () => {
    h = await startTestHost({ sandbox: true });
    data = realpathSync(join(h.root, "workerd"));
    const r = await h.sv.admin("install", { name: "Runaway", purpose: "runs on", dir: join(FIXTURES, "runaway"), wait: true });
    assert.equal(r.status, "promoted", r.log.join("\n"));
  });
  after(() => h?.stop());

  test("a tool is built, checked and called with both sandboxed", async () => {
    await h.invoke("runaway", "tick", { tag: "boxed" });
    assert.equal((await h.invoke("runaway", "count")).result.rows.boxed, 1);
  });

  test("in the tools' sandbox the owner's data, the blobs and the platform's files can't be read; the tools' own can", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const rules = { ...toolsSandbox(data, realpathSync(join(workerdBinary(), "..", ".."))), profile: join(data, "workerd-tools-test.sb") };
    const readable = (file: string) => spawnSync(sandboxed(["/bin/cat", file], rules)[0], sandboxed(["/bin/cat", file], rules).slice(1)).status === 0;
    const own = files(join(data, "do", STORAGE_KEYS.capability)).find((f) => f.endsWith(".sqlite"))!;
    assert.ok(readable(own), own);
    for (const theirs of [files(join(data, "do", STORAGE_KEYS.owner)).find((f) => f.endsWith(".sqlite"))!, files(join(data, "blobs"))[0], join(data, "config.capnp"), join(data, "worker.js")]) {
      assert.ok(theirs && existsSync(theirs), theirs);
      assert.ok(!readable(theirs), theirs);
    }
  });
});

