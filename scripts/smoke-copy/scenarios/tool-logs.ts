// SPDX-License-Identifier: AGPL-3.0-or-later
// What the owner would try by hand after "Tool logs" (§4): an agent calls a tool and reads its call log over MCP;
// Activity shows the read and opens the call; the tool's Info page lists it under Recent calls; an agent that can't
// see the tool gets not_found.
import type { Scenario } from "../scenario.ts";

export default {
  name: "Tool logs: capabilities_logs, Activity and the tool's page",
  async run(s) {
    // A ready tool with a read operation that takes no input: called the way an agent would.
    const status = await s.copy.admin<{ capabilities: { id: string; ready: boolean }[] }>("status");
    let tool = "";
    let op = "";
    for (const c of status.capabilities.filter((x) => x.ready)) {
      const m = await s.copy.call<{ kind?: string; operations: { name: string; sideEffect: string; inputSchema?: { required?: string[] } }[] }>("get", c.id);
      const read = m.operations.find((o) => o.sideEffect === "read" && !o.inputSchema?.required?.length && !o.name.startsWith("widget_") && o.name !== "health");
      if (read && m.kind !== "connection") {
        tool = c.id;
        op = read.name;
        break;
      }
    }
    if (!tool) throw new Error("the copy has no ready tool with a read operation that takes no input");
    const reader = await s.copy.agent("Smoke log reader", ["discover", "invoke"]);
    let at = "";

    await s.step(`an agent calls ${tool} ${op}, then reads its call log`, async () => {
      await reader.tool("capabilities_invoke", { capabilityId: tool, operation: op, input: {} });
      const r = await reader.tool("capabilities_logs", { capabilityId: tool, n: 5 });
      const last = r.entries?.[0];
      if (!last || last.operation.split("@")[0] !== op || last.outcome !== "ok") throw new Error(`its last entry isn't the call: ${JSON.stringify(last)}`);
      at = last.at;
      s.log(`${tool}: ${r.entries.length} entries, the last ${last.operation} ${last.outcome} ${last.ms}ms, ${last.lines.length} line(s)`);
      const only = await reader.tool("capabilities_logs", { capabilityId: tool, operation: op, n: 3 });
      if (!only.entries.every((e: { operation: string }) => e.operation.split("@")[0] === op)) throw new Error("operation didn't narrow it");
    });

    await s.step("Activity shows the read, by the agent, and the call", async () => {
      const items = (await s.copy.api<{ items: any[] }>("GET", `/api/activity?capability=${encodeURIComponent(tool)}`)).items;
      if (!items.some((i) => i.kind === "lifecycle" && i.outcome === "logs")) throw new Error("no 'read the call log' in Activity");
      if (!items.some((i) => i.kind === "call" && i.at === at)) throw new Error("the call isn't in Activity");
      const page = await s.page(`#/activity?capability=${encodeURIComponent(tool)}`);
      await page.getByText("read the call log").first().waitFor({ timeout: 15_000 });
      await s.shot("activity");
    });

    await s.step("the tool's Info page lists it under Recent calls", async () => {
      const page = await s.page(`#/c/${encodeURIComponent(tool)}`);
      const recent = page.locator(".info-section", { hasText: "Recent calls" });
      await recent.getByText(op).first().waitFor({ timeout: 15_000 });
      await recent.locator("li.link").first().click({ position: { x: 40, y: 12 } });
      await s.shot("info-recent-calls");
    });

    await s.step("an agent switched off for the tool can't read its log", async () => {
      const other = await s.copy.agent("Smoke log outsider", ["discover", "invoke"]);
      const id = (await s.copy.call<{ id: string; name: string }[]>("agents")).find((a) => a.name === "Smoke log outsider")?.id;
      if (!id) throw new Error("the outsider agent isn't listed");
      await s.copy.call("setCapabilityAgent", tool, id, false);
      const r = await other.tool("capabilities_logs", { capabilityId: tool }).then(
        () => "read",
        (e: Error) => e.message,
      );
      await other.close();
      if (!/not_found/.test(r)) throw new Error(`expected not_found, got ${r}`);
    });
    await reader.close();
  },
} satisfies Scenario;
