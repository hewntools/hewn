// SPDX-License-Identifier: AGPL-3.0-or-later
// What the owner would try by hand after "MCP requests up to 8 MB" (#100), on the copy's real workerd host: an agent's
// capabilities_check with 4.5 MB of files as base64 (about 6 MB as it travels) gets to Hewn, which answers about the
// files; a 9 MB request is refused in Hewn's words, naming both limits. Nothing is installed.
import type { Agent } from "../client.ts";
import type { Scenario } from "../scenario.ts";

export default {
  name: "An agent's request up to 8 MB gets to Hewn; over that, both limits are named",
  async run(s) {
    let agent: Agent | undefined;

    await s.step("4.5 MB of files as base64 (about 6 MB sent): Hewn reads them and answers about the files", async () => {
      agent = await s.copy.agent("smoke-submit-size", ["discover", "invoke", "create", "modify"]);
      const blob = Buffer.alloc(4.5 * 1024 * 1024, 7).toString("base64");
      // A file Hewn never keeps, so the answer is Hewn's own, fast, and nothing is built.
      const err = await agent.tool("capabilities_check", { files: [{ path: "capability.json", content: "{}" }, { path: "assets/data.bin", content: blob, encoding: "base64" }, { path: ".npmrc", content: "x" }] }).then(
        () => "",
        (e: Error) => e.message,
      );
      if (!/\.npmrc/.test(err)) throw new Error(`not Hewn's answer about the files: ${err.slice(0, 300)}`);
    });

    await s.step("9 MB: refused before Hewn reads it, naming both limits", async () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capabilities_check", arguments: { files: [{ path: "assets/data.bin", content: "A".repeat(9 * 1024 * 1024), encoding: "base64" }] } } });
      // The agent's own session and token, as its client would send it.
      const transport = (agent!.client as any).transport;
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(transport._requestInit?.headers ?? {}) };
      if (transport.sessionId) headers["mcp-session-id"] = transport.sessionId;
      const res = await fetch(transport._url, { method: "POST", headers, body });
      const message = (await res.json().catch(() => ({})))?.error?.message ?? "";
      if (res.status !== 413 || !/at most 8 MB/.test(message) || !/5 MB/.test(message)) throw new Error(`HTTP ${res.status}: ${message.slice(0, 300)}`);
      s.log(message);
    });

    await s.step("close the agent", async () => {
      await agent?.close();
    });
  },
} satisfies Scenario;
