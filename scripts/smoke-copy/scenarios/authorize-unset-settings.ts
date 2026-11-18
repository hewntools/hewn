// SPDX-License-Identifier: AGPL-3.0-or-later
// What the owner would try by hand after "Authorize grants whatever the settings" (#74): a tool that asks for two hosts
// and two settings, installed on the copy; Authorize works with the settings empty, names them, and so does the Inbox;
// the tool stays not ready. The tool is archived afterwards.
import { resolve } from "node:path";
import { readTree } from "@hewntools/cli/workbench.ts";
import type { Scenario } from "../scenario.ts";

const ID = "smoke-upstream-counter";
const FIXTURE = resolve(import.meta.dirname, "../../../test/fixtures/ui-counter");

/** The fixture's files as the admin install takes them (path → base64), with the manifest changed. */
function files(): Record<string, string> {
  const tree = readTree(FIXTURE);
  const m = JSON.parse(Buffer.from(tree["capability.json"]).toString("utf8"));
  Object.assign(m, { id: ID, name: "Smoke Upstream Counter", abi: "2.6", requires: { hosts: ["api.example.com", "status.example.com"] }, config: [{ name: "UPSTREAM_REPO", description: "The upstream repository" }, { name: "MAINTAINER", description: "Who maintains it" }] });
  tree["capability.json"] = new TextEncoder().encode(JSON.stringify(m, null, 2));
  return Object.fromEntries(Object.entries(tree).map(([p, b]) => [p, Buffer.from(b).toString("base64")]));
}

export default {
  name: "Authorize works with settings empty, and names them",
  async run(s) {
    let page: any;

    await s.step("install a tool that asks for two hosts and two settings", async () => {
      const b = await s.copy.admin("install", { name: "Smoke Upstream Counter", purpose: "Counts, for an upstream", files: files(), wait: true });
      if (b.status !== "promoted") throw new Error(`${b.status}: ${b.failure?.message ?? ""}`);
    });

    await s.step("its request: Authorize is enabled with the settings empty, and the line under it names them", async () => {
      page = await s.page(`#/c/${ID}`);
      await page.getByRole("button", { name: "Give it what it needs" }).click();
      const authorize = page.locator("dialog").getByRole("button", { name: "Authorize" });
      await authorize.waitFor({ timeout: 10_000 });
      if (!(await authorize.isEnabled())) throw new Error("Authorize is disabled");
      await page.locator("dialog").getByText("Set UPSTREAM_REPO and MAINTAINER before it runs.").waitFor();
      await s.shot("request");
    });

    await s.step("Authorize: the grants are approved, the tool isn't ready, the toast names the settings", async () => {
      await page.locator("dialog").getByRole("button", { name: "Authorize" }).click();
      await page.getByText("Authorized. Set UPSTREAM_REPO and MAINTAINER before it runs.").waitFor({ timeout: 10_000 });
      const r = await s.copy.admin("readiness", { capabilityId: ID });
      if (r.ready || r.pendingGrants.length || r.missingConfig.join() !== "UPSTREAM_REPO,MAINTAINER") throw new Error(JSON.stringify(r));
    });

    await s.step("the Inbox names them, with Set…", async () => {
      const need = (await s.copy.api("GET", "/api/inbox")).needs.find((n: { capabilityId?: string }) => n.capabilityId === ID);
      if (need?.detail !== "Set UPSTREAM_REPO and MAINTAINER before it runs" || need.action !== "Set…") throw new Error(`the Inbox says ${JSON.stringify(need)}`);
      page = await s.page("#/");
      await page.locator(".inbox-btn").click();
      await page.locator(".inbox-row", { hasText: "Set UPSTREAM_REPO and MAINTAINER" }).waitFor({ timeout: 10_000 });
      await s.shot("inbox");
    });

    await s.step("archive it", async () => {
      // The page first: an open Home would redraw at the change, and its redraw counts as the owner's (the next
      // scenario may be watching for quiet).
      await page.context().close();
      await s.copy.admin("archive", { capabilityId: ID });
    });
  },
} satisfies Scenario;
