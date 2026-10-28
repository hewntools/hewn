// SPDX-License-Identifier: AGPL-3.0-or-later
// `hewn grants deny` as typed: the real CLI against a stand-in for the running Hewn's admin channel.
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

test("hewn grants deny: says no to a host, never to a secret", async () => {
  const home = mkdtempSync(join(tmpdir(), "hewn-cli-grants-"));
  const calls: { method: string; args: unknown[] }[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { method, args } = JSON.parse(body);
      calls.push({ method, args });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result: method === "list" ? [{ id: "weather" }] : null }));
    });
  }).listen(0, "127.0.0.1");
  try {
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(home, "supervisor.json"), JSON.stringify({ url, adminToken: "t", control: { url, token: "t" }, pid: 1 }));
    const hewn = (...a: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...a], { env: { ...process.env, HEWN_HOME: home } }, (e, out, err) =>
          e ? reject(new Error(`hewn ${a.join(" ")}: ${err || out}`)) : resolve(out),
        ),
      );

    assert.match(await hewn("grants", "deny", "weather", "host:api.met.no"), /said no to host:api\.met\.no/);
    assert.deepEqual(calls.at(-1), { method: "declineGrant", args: ["weather", "host:api.met.no"] });

    await assert.rejects(hewn("grants", "deny", "weather", "secret:API_KEY"), /a secret can't be denied/);
    assert.ok(!calls.some((c) => c.method === "declineGrant" && c.args[1] === "secret:API_KEY"), "never sent");
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
