// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { callableOperations, type CapabilityManifest } from "@hewntools/core/manifest.ts";
import { catalogNote, CONTRACTS_DIR, contractsIndex, contractText, INDEX_PURPOSE_CHARS, LINE_CHARS, shortLines } from "@hewntools/core/platform/builds.ts";
import { editJson, editText, FIXTURES, OPENCODE_READ, SEED, setup } from "./helpers.ts";

/** What the builder finds in its workspace about the owner's other capabilities. */
interface Seen {
  /** BUILDER.md. */
  request: string;
  /** BRIEF.md. */
  brief: string;
  index?: string;
  contracts: Record<string, string>;
}
const inWorkspace = (ws: string): Seen => ({
  request: readFileSync(join(ws, "BUILDER.md"), "utf8"),
  brief: readFileSync(join(ws, "BRIEF.md"), "utf8"),
  index: existsSync(join(ws, "CONTRACTS.md")) ? readFileSync(join(ws, "CONTRACTS.md"), "utf8") : undefined,
  contracts: existsSync(join(ws, CONTRACTS_DIR)) ? Object.fromEntries(readdirSync(join(ws, CONTRACTS_DIR)).map((f) => [f, readFileSync(join(ws, CONTRACTS_DIR, f), "utf8")])) : {},
});
/** A version's files hold none of it. */
const noContracts = (files: string[]) => !files.some((f) => f === "CONTRACTS.md" || f.startsWith(`${CONTRACTS_DIR}/`));

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
    let seen: Seen = { request: "", brief: "", contracts: {} };
    const first = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), (ws) => ((seen = inWorkspace(ws)), runningLog()(ws)));
    assert.equal(first.status, "promoted", first.log.join("\n"));
    assert.equal(seen.index, undefined, "no other capabilities: no CONTRACTS.md");
    assert.deepEqual(seen.contracts, {}, "and no contracts folder");
    assert.doesNotMatch(seen.request, /## The owner's other capabilities/);
    assert.match(seen.brief, /named at (?:the )?end of `BUILDER\.md`/, "the brief points to the catalog");
    assert.match(seen.brief, /`CONTRACTS\.md`[^\n]*lists their (?:operations|ops)/, "the brief points to the operation index");
    assert.match(seen.brief, /`\.hewn-contracts\/<id>\.md`[^\n]*full contract/, "the brief points to the complete schemas");

    // A connection's build gets them too: nothing stops a connection calling another capability.
    const conn = await t.build(() => t.platform.create(USER, { name: "Site Connection", purpose: "the site", requirements: "r", kind: "connection" }), (ws) => ((seen = inWorkspace(ws)), cpSync(join(FIXTURES, "site-connection"), ws, { recursive: true })));
    assert.equal(conn.status, "promoted", conn.log.join("\n"));
    assert.ok(seen.index && seen.contracts["running-log.md"]);

    const report = await t.build(() => t.platform.create(USER, { name: "Run Report", purpose: "reports", requirements: "r" }), (ws) => ((seen = inWorkspace(ws)), runReport(ws)));
    assert.equal(report.status, "promoted", report.log.join("\n"));
    assert.match(seen.request, /## The owner's other capabilities\n\nYou can compose with these via ctx.call \(see "Calling other capabilities" in `BRIEF\.md`\): Running Log \(`running-log`\), Site Connection \(`site-connection`\)\. `CONTRACTS.md` in your workspace lists the operations each one offers/);
    const catalog = seen.request.slice(seen.request.indexOf("## The owner's other capabilities"), seen.request.lastIndexOf("Now read `BRIEF.md`"));
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
    assert.ok(noContracts(files), `never part of a version: ${files.join(", ")}`);

    // A change: the operations its tool calls today stay, an older version too, and say so.
    await t.build(() => t.platform.modify(USER, { capabilityId: "run-report", request: "add totals" }), (ws) => {
      seen = inWorkspace(ws);
      throw new Error("the builder gave up");
    });
    assert.match(seen.index!, /read: `list_runs@1`, `get_summary@1`, `list_runs@2`/);
    assert.match(seen.contracts["running-log.md"], /^## `list_runs@1` \(read; this tool calls it today; the newest is list_runs@2\)$/m);
    assert.match(seen.contracts["running-log.md"], /the newest version of each, and the ones this tool calls today/);
    assert.ok(!("run-report.md" in seen.contracts), "never its own");
  });

  test("BUILDER.md doesn't grow with the others' schemas: a huge contract stays in its own file", async () => {
    const sizes: number[] = [];
    let seen: Seen = { request: "", brief: "", contracts: {} };
    const read = (ws: string) => ((seen = inWorkspace(ws)), sizes.push(Buffer.byteLength(seen.request)));
    await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), runningLog());
    await t.build(() => t.platform.create(USER, { name: "Run Report", purpose: "reports", requirements: "r" }), (ws) => (read(ws), runReport(ws)));
    // Running Log gets a 400 KB schema; a build that sees it reads a BUILDER.md of the same size.
    const changed = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "document it" }), (ws) => {
      assert.ok(existsSync(join(ws, "CONTRACTS.md")) && existsSync(join(ws, CONTRACTS_DIR, "run-report.md")), "a change's workspace has them");
      runningLog({ pad: 400_000 })(ws);
    });
    assert.equal(changed.status, "promoted", changed.log.join("\n"));
    const files = Object.keys((await t.platform.loadVersion("running-log", changed.resultVersion!)).files);
    assert.ok(noContracts(files), `a promoted change holds none of it either: ${files.join(", ")}`);
    await t.build(() => t.platform.modify(USER, { capabilityId: "run-report", request: "add totals" }), (ws) => {
      read(ws);
      throw new Error("the builder gave up");
    });
    assert.ok(seen.contracts["running-log.md"].includes("HUGE") && seen.contracts["running-log.md"].length > 400_000, "the contract is whole in its file");
    assert.doesNotMatch(seen.request, /HUGE/);
    assert.ok(seen.index!.length < 2_000, `CONTRACTS.md stays small too: ${seen.index!.length}`);
    // The two briefs differ only in their requests.
    assert.ok(Math.abs(sizes[1] - sizes[0]) < 200, `BUILDER.md: ${sizes.join(" → ")} bytes`);
    assert.ok(sizes[1] < OPENCODE_READ, `within OpenCode's read: ${sizes[1]}`);
  });

  test("every line a builder reads is short: a huge schema goes over several lines, a long list or request is wrapped, nothing is lost", async () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    // Running Log with a long description in a schema and 150 more operations, each with a big schema.
    const fields = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`field_${i}`, { type: "string", description: `the field number ${i}` }]));
    const log = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), (ws) => {
      runningLog()(ws);
      editJson(join(ws, "capability.json"), (m) => {
        m.operations[0].inputSchema.description = words(800);
        for (let i = 0; i < 150; i++) m.operations.push({ name: `extra_${i}`, version: 1, description: `Extra ${i}.`, sideEffect: "read", inputSchema: { type: "object", properties: fields }, outputSchema: { type: "object" } });
      });
      editText(join(ws, "src", "index.ts"), (s) => s.replace("export const operations = {", `export const operations = {\n${Array.from({ length: 150 }, (_, i) => `  "extra_${i}@1"() { return {}; },`).join("\n")}`));
    });
    assert.equal(log.status, "promoted", log.log.join("\n"));
    let files: Record<string, string> = {};
    const read = (ws: string) => {
      const all = (dir: string): string[] => readdirSync(join(ws, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(dir, e.name)) : [join(dir, e.name)]));
      files = Object.fromEntries(all(".").map((f) => [f, readFileSync(join(ws, f), "utf8")]));
      throw new Error("the builder gave up");
    };
    await t.build(() => t.platform.create(USER, { name: "Run Report", purpose: "reports", requirements: `Report on runs. ${words(1000)}`, conversation: [{ role: "user", content: words(500) }] }), read);
    for (const [f, text] of Object.entries(files)) {
      const longest = Math.max(...text.split("\n").map((l) => l.length));
      assert.ok(longest <= LINE_CHARS, `${f}: a line of ${longest} characters`);
    }
    const contract = files[join(CONTRACTS_DIR, "running-log.md")];
    assert.match(contract, /^## `record_run@1` \(write\)\n\n[^\n]*\n\ninput: \{\n "type": "object",\n/m, "a schema too long for a line goes over several");
    assert.match(contract, /^ "description": "word0 word1 /m);
    assert.match(contract, /^## `extra_0@1` \(read\)\n\nExtra 0\.\n\ninput: \{\n "type": "object",\n "properties": \{\n {2}"field_0": \{/m);
    assert.match(contract, /^output: \{"type":"object"\}$/m, "a short one stays on one");
    assert.match(contract, /word799"/, "nothing is lost");
    assert.match(files["CONTRACTS.md"], /`extra_149@1`/);
    assert.match(files["BUILDER.md"], /word999/);
    assert.match(files["OWNERS_WORDS.md"], /word499/);
  });

  test("BUILDER.md and BRIEF.md each leave room in OpenCode's 50 KB read: the request (the longest so far, a conversation, instructions, 60 other tools) 2.5 KB, the brief 5 KB", async () => {
    // The longest request on the owner's Hewn so far: 6,521 characters.
    const longest = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ").slice(0, 6_521);
    t.platform.setInstructions(USER, undefined, ["Metric units, and dates as 1 Nov 2026.", "Keep screens calm: no confetti."]);
    let request = "";
    let brief = "";
    await t.build(() => t.platform.create(USER, { name: "Run Report", purpose: "reports", requirements: longest, conversation: [{ role: "user", content: "a report on my runs" }] }), (ws) => {
      request = readFileSync(join(ws, "BUILDER.md"), "utf8");
      brief = readFileSync(join(ws, "BRIEF.md"), "utf8");
      throw new Error("the builder gave up");
    });
    // 60 others, named about as long as the owner's tools are on average (32 bytes each in the list): "Habit Logs 12 (`habit-logs-12`)".
    const others = Array.from({ length: 60 }, (_, i) => ({ id: `habit-logs-${i}`, manifest: { name: `Habit Logs ${i}` } as CapabilityManifest, calls: [] }));
    const size = Buffer.byteLength(request) + Buffer.byteLength(catalogNote(others));
    assert.ok(
      size <= OPENCODE_READ - 2_560,
      `BUILDER.md comes to ${size} bytes with the longest request so far (6,521 characters) and 60 other tools: ${OPENCODE_READ - size} to spare of OpenCode's ${OPENCODE_READ}, under the 2,560 this test keeps. What Hewn adds to the request has grown (the notes, the instructions, the names): cut it, or move a part into a file of its own.`,
    );
    const briefSize = Buffer.byteLength(brief);
    assert.ok(
      briefSize <= OPENCODE_READ - 5_120,
      `BRIEF.md (spec/builder-brief.md) comes to ${briefSize} bytes: ${OPENCODE_READ - briefSize} to spare of OpenCode's ${OPENCODE_READ}, under the 5,120 this test keeps. The brief has grown: cut it, or split it.`,
    );
  });

  test("shortLines: a long line is wrapped at a space, a list item's further lines under its text; anything else as it is", () => {
    const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    assert.equal(shortLines(`# Title\n\n- short\n${"y".repeat(LINE_CHARS)}\n`), `# Title\n\n- short\n${"y".repeat(LINE_CHARS)}\n`);
    const item = shortLines(`  - ${long}`).split("\n");
    assert.ok(item.length > 1 && item.every((l) => l.length <= LINE_CHARS), item.map((l) => l.length).join(", "));
    assert.ok(item.slice(1).every((l) => /^ {4}w\d/.test(l)), "under the item's text");
    assert.equal(item.map((l) => l.trim()).join(" "), `- ${long}`);
    assert.equal(shortLines("z".repeat(2500)), "z".repeat(2500).match(/z{1,1000}/g)!.join("\n"), "no space: cut anywhere, nothing added");
    assert.equal(shortLines(`${"a".repeat(999)}😀b`), `${"a".repeat(999)}\n😀b`, "never inside a character");
    // However deep its indent, a line is wrapped (one past half a line isn't kept).
    for (const line of [" ".repeat(1500), `${"\t".repeat(1200)}${long}`, `${" ".repeat(600)}${long}`]) {
      const lines = shortLines(line).split("\n");
      assert.ok(lines.every((l) => l.length <= LINE_CHARS), lines.map((l) => l.length).join(", "));
    }
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
    const text = contractText({ id: "x", manifest: m, calls: ["old@1", "widget_today@1"] });
    assert.match(text, /^## `old@1` \(read; this tool calls it today; deprecated: use list@3\)$/m);
    assert.match(text, /^## `widget_today@1` \(read; this tool calls it today\)$/m, "no newer version is named that it isn't offered");
    const conn: CapabilityManifest = { id: "c", name: "C", purpose: "c", abi: "2.1", kind: "connection", operations: [op("health", 1), op("connect", 1, { sideEffect: "write" }), op("fetch", 1)] };
    assert.deepEqual(names(callableOperations(conn)), ["health@1", "fetch@1"], "a connection's sign-in is the owner's alone");
    const purpose = contractsIndex([{ id: "x", manifest: m, calls: [] }]).match(/^- \*\*X\*\* \(`x`\): (.*)$/m)![1];
    assert.equal(purpose.length, INDEX_PURPOSE_CHARS, "a long purpose is cut short");
    assert.ok(purpose.endsWith("…"));
  });
});
