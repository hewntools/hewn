// SPDX-License-Identifier: AGPL-3.0-or-later
// An example scenario: what the owner would try by hand after "Retry carries on" (#107), done in the web client.
// A slow change to one of the copy's tools; Cancel build on its page; Start again; the new build carries on from the
// stopped one's workspace (the stub builder finds the note it left there) and goes live.
import type { Scenario } from "../scenario.ts";

export default {
  name: "Stop then Retry carries on (in the web client)",
  async run(s) {
    const tool = s.tool;
    if (!tool) throw new Error("the copy has no tool to change (ready, its own code only)");
    const before = (await s.copy.admin("status")).capabilities.find((c: { id: string }) => c.id === tool).version as number;
    let first = "";
    let second = "";

    await s.step(`ask for a slow change to ${tool}`, async () => {
      first = (await s.copy.admin("modify", { capabilityId: tool, request: "Smoke scenario [smoke:slow]: work slowly until stopped." })).buildId;
      await s.stub.waitFor(first, "waiting");
    });

    await s.step("its page shows it building, with Cancel build", async () => {
      const page = await s.page(`#/b/${first}`);
      await page.getByRole("button", { name: "Cancel build" }).waitFor({ timeout: 15_000 });
      await s.shot("building");
    });

    await s.step("Cancel build, confirmed: the build stops, its builder too", async () => {
      const page = await s.page(`#/b/${first}`);
      await page.getByRole("button", { name: "Cancel build" }).click();
      await page.getByRole("button", { name: "Cancel build" }).last().click();
      await page.getByText("Build cancelled").waitFor({ timeout: 15_000 });
      await s.stub.waitFor(first, "stopped", 10_000);
      await s.shot("stopped");
    });

    await s.step("Start again: a new build, which carries on from the stopped one", async () => {
      const page = await s.page(`#/b/${first}`);
      await page.getByRole("button", { name: "Start again" }).click();
      await page.waitForURL((u: URL) => /#\/b\/b-/.test(u.hash) && !u.hash.includes(first), { timeout: 15_000 });
      second = new URL(page.url()).hash.replace("#/b/", "");
      const start = await s.stub.waitFor(second, "start");
      if (start.carriesOn !== "stopped" || !start.foundProgress) throw new Error(`it started afresh: carriesOn ${start.carriesOn}, the stopped build's work ${start.foundProgress ? "found" : "not found"}`);
    });

    await s.step("it goes live, and the page says so", async () => {
      const b = await s.waitBuild(second);
      if (b.status !== "promoted") throw new Error(`${b.status}: ${b.failure?.message ?? ""}`);
      const page = await s.page(`#/b/${first}`);
      await page.getByText("Started again as").waitFor({ timeout: 15_000 });
      await s.shot("started-again");
    });

    await s.step(`back to v${before}`, async () => {
      await s.copy.admin("rollback", { capabilityId: tool, version: before });
    });
  },
} satisfies Scenario;
