// SPDX-License-Identifier: AGPL-3.0-or-later
// What the owner would try by hand after "a Retry waits for the stopped builder" (0.4.12): Stop a build whose builder is
// slow to stop, then Retry at once (two quick clicks); the retry carries on from the workspace as the stopped builder
// left it, its last writes included, and goes live.
import type { Scenario } from "../scenario.ts";

export default {
  name: "Stop, then Retry at once: the retry waits for the stopped builder",
  async run(s) {
    const tool = s.tool;
    if (!tool) throw new Error("the copy has no tool to change (ready, its own code only)");
    const before = (await s.copy.admin("status")).capabilities.find((c: { id: string }) => c.id === tool).version as number;
    let first = "";
    let second = "";

    await s.step(`a slow change to ${tool}, its builder slow to stop`, async () => {
      first = (await s.copy.admin("modify", { capabilityId: tool, request: "Smoke scenario [smoke:slow-exit]: work slowly until stopped, and stop slowly." })).buildId;
      await s.stub.waitFor(first, "waiting");
    });

    await s.step("Stop and Retry back to back", async () => {
      await s.copy.api("POST", `/api/builds/${first}/cancel`);
      second = (await s.copy.api("POST", `/api/builds/${first}/retry`)).buildId;
    });

    await s.step("the retry carries on with the stopped builder's last writes, and goes live", async () => {
      const start = await s.stub.waitFor(second, "start", 30_000);
      if (start.carriesOn !== "stopped" || !start.foundProgress || !start.foundLate) throw new Error(`carriesOn ${start.carriesOn}, its work ${start.foundProgress ? "found" : "not found"}, the writes after the Stop ${start.foundLate ? "found" : "not found"}`);
      const b = await s.waitBuild(second);
      if (b.status !== "promoted") throw new Error(`${b.status}: ${b.failure?.message ?? ""}`);
    });

    await s.step(`back to v${before}`, async () => {
      await s.copy.admin("rollback", { capabilityId: tool, version: before });
    });
  },
} satisfies Scenario;
