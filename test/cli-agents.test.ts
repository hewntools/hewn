// SPDX-License-Identifier: AGPL-3.0-or-later
// `hewn agents tool` and `hewn agents` as typed: the real CLI against a stand-in for the running Hewn's admin channel.
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

test("hewn agents tool: switches an agent on or off for one tool; hewn agents names what it was switched off for", async () => {
  const home = mkdtempSync(join(tmpdir(), "hewn-cli-agents-"));
  const calls: { method: string; args: unknown[] }[] = [];
  const agents = [
    { id: "codex", name: "Codex", scopes: ["discover", "invoke"], capabilities: "*", except: ["gift-ideas", "running-log"], via: "local", lastUsedAt: null },
    { id: "claude", name: "claude.ai", scopes: ["discover"], capabilities: ["running-log"], except: [], via: "tunnel", lastUsedAt: null },
  ];
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { method, args } = JSON.parse(body);
      calls.push({ method, args });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result: method === "agents" ? agents : method === "pendingAgents" ? [] : null }));
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

    assert.match(await hewn("agents", "tool", "codex", "gift-ideas", "off"), /codex can no longer use gift-ideas/);
    assert.deepEqual(calls.at(-1), { method: "setCapabilityAgent", args: ["gift-ideas", "codex", false] });
    assert.match(await hewn("agents", "tool", "claude", "gift-ideas", "on"), /claude can use gift-ideas/);
    assert.deepEqual(calls.at(-1), { method: "setCapabilityAgent", args: ["gift-ideas", "claude", true] });
    await assert.rejects(hewn("agents", "tool", "codex", "gift-ideas"), /usage: hewn agents tool <agent> <tool> on\|off/);

    const list = await hewn("agents");
    assert.match(list, /codex .* · every tool except gift-ideas, running-log ·/);
    assert.match(list, /claude .* · only running-log ·/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
