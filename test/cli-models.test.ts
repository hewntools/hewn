// SPDX-License-Identifier: AGPL-3.0-or-later
// `hewn models <sub>` as typed: the real CLI against a stand-in for the running Hewn's admin channel.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));

test("hewn models: the subcommand right after models is the one that runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "hewn-cli-models-"));
  const calls: { method: string; args: unknown[] }[] = [];
  const models = { provider: "anthropic", providers: [{ id: "anthropic", keySet: true, check: { ok: true }, models: [], tiers: {} }] };
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { method, args } = JSON.parse(body);
      calls.push({ method, args });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result: models }));
    });
  }).listen(0, "127.0.0.1");
  try {
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(home, "supervisor.json"), JSON.stringify({ url, adminToken: "t", control: { url, token: "t" }, pid: 1 }));
    writeFileSync(join(home, "key.txt"), "sk-test\n");
    const hewn = (...a: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...a], { env: { ...process.env, HEWN_HOME: home } }, (e, out, err) =>
          e ? reject(new Error(`hewn ${a.join(" ")}: ${err || out}`)) : resolve(out),
        ),
      );

    assert.match(await hewn("models", "key", "anthropic", "--from", join(home, "key.txt")), /anthropic key works/);
    assert.deepEqual(calls.at(-1), { method: "setModelKey", args: ["anthropic", "sk-test"] });

    assert.match(await hewn("models", "use", "openai"), /tiers now run on openai/);
    assert.deepEqual(calls.at(-1), { method: "setModelSettings", args: [{ provider: "openai" }] });

    await assert.rejects(hewn("models", "nope"), /unknown: hewn models nope/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
