// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { editJson, FIXTURES, installFrom, installSeed, setup } from "./helpers.ts";

describe("deprecating and removing operations", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  const change = (edit: (m: any) => void) =>
    t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "change" }),
      (ws) => {
        editJson(join(ws, "capability.json"), (m) => ((m.abi = "2.1"), edit(m)));
        // A removed operation's test cases go with it.
        const ops = new Set(JSON.parse(readFileSync(join(ws, "capability.json"), "utf8")).operations.map((o: any) => o.name));
        editJson(join(ws, "tests", "cases.json"), (cs) => cs.splice(0, cs.length, ...cs.filter((c: any) => ops.has(c.operation))));
      },
    );
  const op = (m: any, name: string) => m.operations.find((o: any) => o.name === name);
  const remove = (name: string) => (m: any) => (m.operations = m.operations.filter((o: any) => o.name !== name));

  test("an operation that isn't deprecated can't be removed", async () => {
    const r = await change(remove("get_summary"));
    assert.equal(r.status, "failed");
    assert.match(r.log.join("\n"), /get_summary@1: removed \(mark it "deprecated" with its replacement first/);
  });

  test("deprecate first: it keeps working, with a notice for callers; then it can be removed", async () => {
    const d = await change((m) => (op(m, "get_summary").deprecated = { replacement: "weekly-review/summary@1", note: "moving" }));
    assert.equal(d.status, "promoted", d.log.join("\n"));
    const r = await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "get_summary" });
    assert.equal((r as any).deprecated, "get_summary@1 is deprecated; use weekly-review/summary@1 (moving)");
    assert.ok(t.platform.list(t.claude)[0].operations.includes("get_summary@1 (deprecated → weekly-review/summary@1)"));
    assert.equal(t.platform.list(t.claude, { operation: "get_summary" }).length, 1);

    const gone = await change(remove("get_summary"));
    assert.equal(gone.status, "promoted", gone.log.join("\n"));
    assert.ok(gone.log.some((l) => /removed deprecated get_summary@1/.test(l)));
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "get_summary" }), /has no operation get_summary/);
  });

  test("a deprecated operation still in use by a capability or a schedule stays", async () => {
    await installFrom(t.platform, join(FIXTURES, "run-feeder"));
    assert.equal((await change((m) => ((op(m, "record_run").deprecated = {}), (op(m, "get_summary").deprecated = {})))).status, "promoted");
    const used = await change(remove("record_run"));
    assert.equal(used.status, "failed");
    assert.match(used.log.join("\n"), /record_run@1: removed, but run-feeder still uses it/);

    const s = t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "daily 07:00" });
    const scheduled = await change(remove("get_summary"));
    assert.match(scheduled.log.join("\n"), new RegExp(`get_summary@1: removed, but schedule ${s.id} still uses it`));
  });

  test("deprecated needs ABI 2.1; the replacement must name an operation", async () => {
    const old = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "change" }),
      (ws) => editJson(join(ws, "capability.json"), (m) => (op(m, "get_summary").deprecated = {})),
    );
    assert.match(old.log.join("\n"), /deprecated operations needs ABI 2\.1/);
    const bad = await change((m) => (op(m, "get_summary").deprecated = { replacement: "not an op" }));
    assert.match(bad.log.join("\n"), /deprecated\/replacement/);
  });
});
