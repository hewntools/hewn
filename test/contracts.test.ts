// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import type { CapabilityManifest } from "@hewntools/core/manifest.ts";
import { callableOperations, contractFile, contractsIndex, INDEX_PURPOSE_CHARS } from "@hewntools/core/platform/builds.ts";
import { editJson, editText, FIXTURES, SEED, setup } from "./helpers.ts";

/** What the builder finds in its workspace about the owner's other capabilities. */
interface Seen {
  brief: string;
  index?: string;
  contracts: Record<string, string>;
}
const look = (ws: string): Seen => ({
  brief: readFileSync(join(ws, "BUILDER.md"), "utf8"),
  index: existsSync(join(ws, "CONTRACTS.md")) ? readFileSync(join(ws, "CONTRACTS.md"), "utf8") : undefined,
  contracts: existsSync(join(ws, "contracts")) ? Object.fromEntries(readdirSync(join(ws, "contracts")).map((f) => [f, readFileSync(join(ws, "contracts", f), "utf8")])) : {},
});

/** Running Log with `list_runs@2` next to `@1`, and, when given, a schema of `pad` characters on `record_run@1`. */
const runningLog =
  ({ pad = 0 } = {}) =>
  (ws: string) => {
    cpSync(SEED, ws, { recursive: true });
    editJson(join(ws, "capability.json"), (m) => {
      if (pad) m.operations[0].inputSchema.description = `HUGE${"x".repeat(pad)}`;
      m.operations.push({ name: "list_runs", version: 2, description: "Runs, newest first.", sideEffect: "read", inputSchema: { type: "object" }, outputSchema: { type: "object" } });
    });
    // @2 answers as @1 does (the seed's tests call list_runs unpinned, so the newest).
    editText(join(ws, "src", "index.ts"), (s) => s.replace("export const operations = {", 'export const operations = {\n  "list_runs@2"(input: any, ctx: any) {\n    return (operations as any)["list_runs@1"](input, ctx);\n  },'));
  };

/** Run Report: calls Running Log's `list_runs@1` (not the newest). */
const runReport = (ws: string) => {
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "tests"), { recursive: true });
  writeFileSync(
    join(ws, "capability.json"),
    JSON.stringify({
      id: "run-report",
      name: "Run Report",
      purpose: "Reports on runs.",
      abi: "2.0",
      requires: { capabilities: [{ id: "running-log", operations: ["list_runs@1"] }] },
      operations: [{ name: "report", description: "Report", version: 1, sideEffect: "read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
    }),
  );
  writeFileSync(join(ws, "src", "index.ts"), `export const operations = { async "report@1"(_i: unknown, ctx: any) { return { runs: await ctx.call("running-log", "list_runs@1", {}) }; } };`);
  writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "report", operation: "report", input: {}, calls: { "running-log/list_runs@1": { runs: [] } }, expect: { runs: { runs: [] } } }]));
};

describe("the owner's other capabilities' contracts", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("BUILDER.md names them; CONTRACTS.md lists their newest operations; contracts/<id>.md has each in full; none of it reaches a version", async () => {
    let seen: Seen = { brief: "", contracts: {} };
    const first = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), (ws) => ((seen = look(ws)), runningLog()(ws)));
    assert.equal(first.status, "promoted", first.log.join("\n"));
    assert.equal(seen.index, undefined, "no other capabilities: no CONTRACTS.md");
    assert.deepEqual(seen.contracts, {}, "and no contracts/");
    assert.doesNotMatch(seen.brief, /## The owner's other capabilities/);
    assert.match(seen.brief, /`CONTRACTS.md` in your workspace lists their operations, and `contracts\/<id>.md`\nhas each one's full contract/, "the brief says where they are");

    // A connection's build gets them too: nothing stops a connection calling another capability.
    const conn = await t.build(() => t.platform.create(USER, { name: "Site Connection", purpose: "the site", requirements: "r", kind: "connection" }), (ws) => ((seen = look(ws)), cpSync(join(FIXTURES, "site-connection"), ws, { recursive: true })));
    assert.equal(conn.status, "promoted", conn.log.join("\n"));
    assert.ok(seen.index && seen.contracts["running-log.md"]);

    const report = await t.build(() => t.platform.create(USER, { name: "Run Report", purpose: "reports", requirements: "r" }), (ws) => ((seen = look(ws)), runReport(ws)));
    assert.equal(report.status, "promoted", report.log.join("\n"));
    assert.match(seen.brief, /## The owner's other capabilities\n\nYou can compose with these via ctx.call \(see "Calling other capabilities"\): Running Log \(`running-log`\), Site Connection \(`site-connection`\)\. `CONTRACTS.md` in your workspace lists the operations each one offers/);
    const catalog = seen.brief.slice(seen.brief.indexOf("## The owner's other capabilities"));
    assert.equal(catalog.split("\n").filter(Boolean).length, 2, `a heading and a line: ${catalog}`);
    assert.doesNotMatch(catalog, /"type":"object"|list_runs|record_run/, "no operations or schemas in BUILDER.md");
    assert.match(seen.index!, /^- \*\*Running Log\*\* \(`running-log`\): .*\n {2}read: `get_summary@1`, `list_runs@2` · write: `record_run@1`$/m, "the newest version of each, by side effect, in the manifest's order");
    assert.doesNotMatch(seen.index!, /list_runs@1/, "a superseded version is left out");
    assert.match(seen.index!, /^- \*\*Site Connection\*\* \(`site-connection`\)/m, "a connection is among them");
    assert.deepEqual(Object.keys(seen.contracts).sort(), ["running-log.md", "site-connection.md"]);
    const rl = seen.contracts["running-log.md"];
    assert.match(rl, /^# Running Log \(`running-log`\)\n/);
    assert.match(rl, /^## `list_runs@2` \(read\)\n\nRuns, newest first\.\n\ninput: \{"type":"object"\}\noutput: \{"type":"object"\}$/m, "the full contract");
    assert.doesNotMatch(rl, /list_runs@1/);
    const files = Object.keys((await t.platform.loadVersion("run-report", report.resultVersion!)).files);
    assert.ok(!files.some((f) => f === "CONTRACTS.md" || f.startsWith("contracts/")), `never part of a version: ${files.join(", ")}`);

    // A change: the operations its tool calls today stay, an older version too, and say so.
    await t.build(() => t.platform.modify(USER, { capabilityId: "run-report", request: "add totals" }), (ws) => {
      seen = look(ws);
      throw new Error("the builder gave up");
    });
    assert.match(seen.index!, /read: `list_runs@1`, `get_summary@1`, `list_runs@2`/);
    assert.match(seen.contracts["running-log.md"], /^## `list_runs@1` \(read; this tool calls it today; the newest is list_runs@2\)$/m);
    assert.match(seen.contracts["running-log.md"], /the newest version of each, and the ones this tool calls today/);
    assert.ok(!("run-report.md" in seen.contracts), "never its own");
  });

  test("BUILDER.md doesn't grow with the others' schemas: a huge contract stays in its own file", async () => {
    const sizes: number[] = [];
    let seen: Seen = { brief: "", contracts: {} };
    const read = (ws: string) => ((seen = look(ws)), sizes.push(Buffer.byteLength(seen.brief)));
    await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), runningLog());
    await t.build(() => t.platform.create(USER, { name: "Run Report", purpose: "reports", requirements: "r" }), (ws) => (read(ws), runReport(ws)));
    // Running Log gets a 400 KB schema; a build that sees it reads a BUILDER.md of the same size.
    await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "document it" }), runningLog({ pad: 400_000 }));
    await t.build(() => t.platform.modify(USER, { capabilityId: "run-report", request: "add totals" }), (ws) => {
      read(ws);
      throw new Error("the builder gave up");
    });
    assert.ok(seen.contracts["running-log.md"].includes("HUGE") && seen.contracts["running-log.md"].length > 400_000, "the contract is whole in its file");
    assert.doesNotMatch(seen.brief, /HUGE/);
    assert.ok(seen.index!.length < 2_000, `CONTRACTS.md stays small too: ${seen.index!.length}`);
    // The two briefs differ only in their requests.
    assert.ok(Math.abs(sizes[1] - sizes[0]) < 200, `BUILDER.md: ${sizes.join(" → ")} bytes`);
    assert.ok(sizes[1] < 50_000, `under OpenCode's 50 KB read: ${sizes[1]}`);
  });

  test("what another capability may call: the newest of each, not deprecated, not a widget's or a sign-in; and what the tool calls today", () => {
    const op = (name: string, version: number, extra: object = {}) => ({ name, version, description: `${name}@${version}`, sideEffect: "read" as const, inputSchema: { type: "object" as const }, outputSchema: { type: "object" }, ...extra });
    const m: CapabilityManifest = {
      id: "x",
      name: "X",
      purpose: "p ".repeat(300),
      abi: "2.3",
      operations: [op("list", 1), op("list", 3), op("list", 2), op("old", 1, { deprecated: { replacement: "list@3" } }), op("widget_today", 1), op("stats", 1)],
      widgets: [{ name: "today", version: 1, title: "Today", operation: "widget_today@1", sizes: ["s"] } as any],
    };
    const names = (ops: { name: string; version: number }[]) => ops.map((o) => `${o.name}@${o.version}`);
    assert.deepEqual(names(callableOperations(m)), ["list@3", "stats@1"], "in the manifest's order");
    assert.deepEqual(names(callableOperations(m, ["list@1", "old@1"])), ["list@1", "list@3", "old@1", "stats@1"], "and what the tool calls today, deprecated or not");
    assert.match(contractFile({ id: "x", manifest: m, calls: ["old@1"] }), /^## `old@1` \(read; this tool calls it today; deprecated: use list@3\)$/m);
    const conn: CapabilityManifest = { id: "c", name: "C", purpose: "c", abi: "2.1", kind: "connection", operations: [op("health", 1), op("connect", 1, { sideEffect: "write" }), op("fetch", 1)] };
    assert.deepEqual(names(callableOperations(conn)), ["health@1", "fetch@1"], "a connection's sign-in is the owner's alone");
    const purpose = contractsIndex([{ id: "x", manifest: m, calls: [] }]).match(/^- \*\*X\*\* \(`x`\): (.*)$/m)![1];
    assert.equal(purpose.length, INDEX_PURPOSE_CHARS, "a long purpose is cut short");
    assert.ok(purpose.endsWith("…"));
  });
});
