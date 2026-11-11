// SPDX-License-Identifier: AGPL-3.0-or-later
// A new tool on the id of a deleted one (kept with its data): one error from the core, said three ways. An agent is
// told to use another id or ask the owner; the web client says where to bring it back (no commands); `hewn install`
// names the commands.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { installSeed, SEED, setup } from "./helpers.ts";

test("the core: installing or creating on a deleted tool's id is a conflict that names it, in an agent's words", async () => {
  const t = setup();
  try {
    await installSeed(t.platform);
    t.platform.archive(USER, "running-log");
    const refused = (e: unknown) =>
      e instanceof PlatformError &&
      e.code === "conflict" &&
      /'running-log' was deleted by the owner and is kept with its data; use another id, or ask the owner to restore it/.test(e.message) &&
      (e.details as any)?.archived?.id === "running-log" &&
      (e.details as any)?.archived?.name === "Running Log";
    await assert.rejects(t.platform.install(USER, { name: "Running Log", purpose: "x", builder: `copy:${SEED}` }), refused);
    await assert.rejects(t.platform.create(t.claude, { name: "Running Log", purpose: "x", requirements: "x" }), refused);
  } finally {
    t.cleanup();
  }
});

test("the web client says where to bring it back, and names no command", async () => {
  Object.assign(globalThis, { document: { addEventListener() {} }, window: { addEventListener() {} } });
  const body = { error: "conflict", message: "'running-log' was deleted by the owner and is kept with its data; use another id, or ask the owner to restore it", details: { archived: { id: "running-log", name: "Running Log" } } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const { api } = (await import(join(import.meta.dirname, "../packages/host-workerd/web/kit.js"))) as { api: (path: string, o?: unknown) => Promise<unknown> };
    await assert.rejects(api("/bundles/x/install", { method: "POST", body: {} }), (e: Error) => {
      assert.equal(e.message, "Running Log was deleted and is kept with its data. Bring it back or delete it for good in Settings › Data › Deleted tools, or install this one under another name.");
      assert.doesNotMatch(e.message, /hewn |ask the owner/);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("hewn install names the commands: restore, purge, or --name", async () => {
  const CLI = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "hewn-cli-archived-"));
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "conflict", message: "'running-log' was deleted by the owner", details: { archived: { id: "running-log", name: "Running Log" } } }));
    });
  }).listen(0, "127.0.0.1");
  try {
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(home, "supervisor.json"), JSON.stringify({ url, adminToken: "t", control: { url, token: "t" }, pid: 1 }));
    const err = await new Promise<string>((resolve) =>
      execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "install", SEED], { env: { ...process.env, HEWN_HOME: home } }, (_e, out, stderr) => resolve(stderr + out)),
    );
    assert.match(err, /Running Log \(running-log\) was deleted and is kept with its data: hewn restore running-log brings it back, hewn purge running-log deletes it for good, or install this one under another name with --name <name>/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
