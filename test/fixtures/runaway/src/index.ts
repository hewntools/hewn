// SPDX-License-Identifier: AGPL-3.0-or-later
// Code that doesn't stop on its own: a timer left behind, a call that runs past its deadline, a loop
// that never yields. A version with SPIN_IN_TESTS set never gets through its tests. Called by Hewn's schema fuzz (its
// caller "fuzz"), each returns at once: the fuzz has a fixture of its own, and these are here for the tests that call them.
type Db = { prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): any[] } };
type Ctx = { db: Db; caller?: { kind: string; id: string } };
const fuzzed = (ctx: Ctx) => ctx.caller?.id === "fuzz";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = (db: Db, tag: string) => db.prepare("INSERT INTO ticks (tag) VALUES (?)").run(tag);
const rows = (db: Db): Record<string, number> => Object.fromEntries(db.prepare("SELECT tag, count(*) AS n FROM ticks GROUP BY tag").all().map((r) => [r.tag, r.n]));
const SPIN_IN_TESTS = false;

export const operations = {
  "tick@1": (input: { tag?: string }, { db }: Ctx) => {
    if (SPIN_IN_TESTS) for (;;) {}
    tick(db, input.tag ?? "tick");
    return {};
  },
  "count@1": (_: unknown, { db }: Ctx) => ({ rows: rows(db) }),
  "linger@1": (_: unknown, ctx: Ctx) => {
    if (fuzzed(ctx)) return { started: false };
    const { db } = ctx;
    setInterval(() => tick(db, "linger"), 100);
    return { started: true };
  },
  async "overrun@1"(_: unknown, ctx: Ctx) {
    if (fuzzed(ctx)) return {};
    const { db } = ctx;
    for (;;) {
      tick(db, "overrun");
      await sleep(200);
    }
  },
  async "slow@1"(input: { ms?: number }, ctx: Ctx) {
    if (fuzzed(ctx)) return {};
    const { db } = ctx;
    await sleep(input.ms ?? 1000);
    tick(db, "slow");
    return {};
  },
  "spin@1": (_: unknown, ctx: Ctx) => {
    if (fuzzed(ctx)) return {};
    for (;;) {}
  },
  "widget_rows@1": (_: unknown, { db }: Ctx) => ({ template: "stat", value: Object.values(rows(db)).reduce((a, b) => a + b, 0), caption: "rows" }),
};
