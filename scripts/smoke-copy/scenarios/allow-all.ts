// SPDX-License-Identifier: AGPL-3.0-or-later
// What the owner would try by hand after "Allow all" (#80): an agent calls one destructive operation three times with
// different input; the tab's title counts them; the sheet offers Allow all 3, and each call runs with its own input.
// A counter with a destructive reset is installed on the copy for it, and archived afterwards.
import { resolve } from "node:path";
import { readTree } from "@hewntools/cli/workbench.ts";
import type { Agent } from "../client.ts";
import type { Scenario } from "../scenario.ts";

const ID = "smoke-set-counter";
const FIXTURE = resolve(import.meta.dirname, "../../../test/fixtures/ui-counter");
const CODE = `const count = (db: any) => db.prepare("SELECT n FROM counter WHERE id = 1").get().n;
export const operations = {
  "increment@1": (_: unknown, { db }: any) => (db.prepare("UPDATE counter SET n = n + 1 WHERE id = 1").run(), { count: count(db) }),
  "get@1": (_: unknown, { db }: any) => ({ count: count(db) }),
  "reset@1": (i: { to?: number }, { db }: any) => (db.prepare("UPDATE counter SET n = ? WHERE id = 1").run(i.to ?? 0), { count: count(db) }),
};
`;

/** The fixture's files as the admin install takes them (path → base64), with a destructive reset that takes a value. */
function files(): Record<string, string> {
  const tree = readTree(FIXTURE);
  const m = JSON.parse(Buffer.from(tree["capability.json"]).toString("utf8"));
  Object.assign(m, { id: ID, name: "Smoke Set Counter" });
  m.operations.push({ name: "reset", description: "Set the count", version: 1, sideEffect: "destructive", inputSchema: { type: "object", additionalProperties: false, properties: { to: { type: "integer" } } }, outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } });
  tree["capability.json"] = new TextEncoder().encode(JSON.stringify(m, null, 2));
  tree["src/index.ts"] = new TextEncoder().encode(CODE);
  return Object.fromEntries(Object.entries(tree).map(([p, b]) => [p, Buffer.from(b).toString("base64")]));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "Allow all: an agent's waiting calls of one operation",
  async run(s) {
    let page: any;
    let agent: Agent | undefined;
    let calls: Promise<any>[] = [];

    await s.step("install a counter with a destructive reset", async () => {
      const b = await s.copy.admin("install", { name: "Smoke Set Counter", purpose: "Counts", files: files(), wait: true });
      if (b.status !== "promoted") throw new Error(`${b.status}: ${b.failure?.message ?? ""}`);
    });

    await s.step("an agent resets it three times, each with its own value: the tab's title says (3)", async () => {
      agent = await s.copy.agent("smoke-allow-all", ["discover", "invoke"]);
      calls = [7, 8, 9].map((to) => agent!.tool("capabilities_invoke", { capabilityId: ID, operation: "reset", input: { to } }).then((r) => r.result?.count, (e: Error) => e.message));
      for (let i = 0; i < 40 && (await s.copy.call("confirmations")).filter((c: { capabilityId: string }) => c.capabilityId === ID).length < 3; i++) await sleep(250);
      page = await s.page("#/activity");
      await page.waitForFunction(() => /^\(\d+\) /.test(document.title), undefined, { timeout: 20_000 });
      const title = await page.title();
      if (!/^\(3\) /.test(title)) throw new Error(`the title says "${title}" (other calls waiting on the copy?)`);
    });

    await s.step("the sheet offers Allow all 3, beside Allow once", async () => {
      await page.locator(".blocking-banner:not([hidden])").getByRole("button", { name: "Review" }).click();
      const sheet = page.locator("dialog[open]", { hasText: "wants to reset" });
      await sheet.getByText("2 more calls like it waiting").waitFor({ timeout: 10_000 });
      await sheet.getByRole("button", { name: "Allow once" }).waitFor();
      await s.shot("allow-all");
      await sheet.getByRole("button", { name: "Allow all 3" }).click();
    });

    await s.step("each call runs with its own value", async () => {
      const counts = await Promise.all(calls);
      if (counts.join() !== "7,8,9") throw new Error(`the calls answered ${counts.join(" · ")}`);
    });

    await s.step("archive it", async () => {
      // The page first: an open page would redraw at the change, and its redraw counts as the owner's.
      await page.context().close();
      await agent?.close();
      await s.copy.admin("archive", { capabilityId: ID });
    });
  },
} satisfies Scenario;
