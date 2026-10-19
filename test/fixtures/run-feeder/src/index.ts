// SPDX-License-Identifier: AGPL-3.0-or-later
type Ctx = { call: (id: string, op: string, input?: unknown) => Promise<any> };
export const operations = {
  async "feed@1"(input: { runs: { date: string; distanceKm: number; durationSeconds: number }[] }, ctx: Ctx) {
    const { runs } = await ctx.call("running-log", "list_runs@1", {});
    let added = 0;
    for (const r of input.runs) {
      if (runs.some((x: any) => x.date === r.date && x.distanceKm === r.distanceKm)) continue;
      await ctx.call("running-log", "record_run@1", { ...r, notes: "source: run-feeder" });
      added++;
    }
    return { added };
  },
};
