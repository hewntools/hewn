// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's schema fuzz (0.4.13): each operation called with inputs its schema accepts, the edges a tool's code most often
// forgets, after the no-loss check on the candidate's sample data.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { FUZZ_INPUTS_PER_OPERATION, FUZZ_LONG_STRING, fuzz, fuzzInputs, keysChanged } from "@hewntools/core/fuzz.ts";
import { compileSchema, type OperationManifest } from "@hewntools/core/manifest.ts";
import { editJson, editText, installSeed, setup } from "./helpers.ts";

describe("the fuzz's inputs", () => {
  const schema = {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 1 },
      count: { type: "integer", minimum: 1, maximum: 100 },
      note: { type: ["string", "null"] },
      tags: { type: "array", items: { type: "string" } },
      when: { type: "string", format: "date" },
    },
  };

  test("only inputs the schema accepts, at most 12, the minimal input and every field set first, each edge named with its property", () => {
    const inputs = fuzzInputs(schema);
    assert.ok(inputs.length <= FUZZ_INPUTS_PER_OPERATION);
    const check = compileSchema(schema);
    for (const i of inputs) assert.ok(check(i.input), `${i.label}: ${check.errors.join("; ")}`);
    assert.deepEqual(inputs[0], { label: "the minimal input", input: { title: "sample" } });
    assert.deepEqual(inputs[1], { label: "the input with every field set", input: { title: "sample", count: 1, note: "sample", tags: ["sample"], when: "2026-01-31" } });
    // One edge of each property before the next of any, so every property gets some within the 12; an edge the schema
    // refuses (the empty title, 0 and -1 for a count from 1, any other string as a date) doesn't take a turn.
    assert.deepEqual(
      inputs.slice(2).map((i) => i.label),
      ["the 10 KB input in `title`", "the maximum in `count` (100)", "null in `note`", "an empty list in `tags`", "unicode and emoji in `title`", "the empty string in `note`", "the 10 KB input in `note`", "unicode and emoji in `note`"],
    );
    assert.equal((inputs[2].input.title as string).length, FUZZ_LONG_STRING);
    assert.deepEqual(inputs[4].input, { title: "sample", count: 1, note: null, tags: ["sample"], when: "2026-01-31" });
  });

  test("at most 12, however many properties", () => {
    const many = { type: "object", properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, { type: ["string", "null"] }])) };
    const inputs = fuzzInputs(many);
    assert.equal(inputs.length, FUZZ_INPUTS_PER_OPERATION);
    assert.deepEqual(inputs.slice(2, 4).map((i) => i.label), ["null in `p0`", "null in `p1`"]);
  });

  test("the same schema gives the same inputs", () => {
    assert.deepEqual(fuzzInputs(schema), fuzzInputs(schema));
  });

  test("an operation without properties is called with {} once", () => {
    assert.deepEqual(fuzzInputs({ type: "object" }), [{ label: "the minimal input", input: {} }]);
  });

  test("the schema's own examples come first; a string with a maxLength gets its longest, not 10 KB", () => {
    const inputs = fuzzInputs({ type: "object", examples: [{ q: "bikes" }], properties: { q: { type: "string", maxLength: 50 } } });
    assert.deepEqual(inputs[0], { label: "the schema's example", input: { q: "bikes" } });
    const longest = inputs.find((i) => i.label === "the longest string in `q` (50 characters)");
    assert.equal((longest!.input.q as string).length, 50);
    assert.ok(!inputs.some((i) => /10 KB/.test(i.label)));
  });

  test("a property with a pattern takes its example; an edge the pattern refuses is left out", () => {
    const inputs = fuzzInputs({ type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^r-[0-9]+$", examples: ["r-1"] } } });
    assert.deepEqual(inputs.map((i) => i.input), [{ id: "r-1" }]);
  });

  test("enum values each get a turn; a required property that can't be made leaves only what can", () => {
    const inputs = fuzzInputs({ type: "object", required: ["mode"], properties: { mode: { enum: ["a", "b", "c"] } } });
    assert.deepEqual(inputs.map((i) => i.input.mode), ["a", "b", "c"]);
    assert.deepEqual(fuzzInputs({ type: "object", required: ["x"], properties: { x: { not: {} } } }), []);
  });
});

describe("the fuzz's run", () => {
  const op = (name: string, sideEffect: OperationManifest["sideEffect"]): OperationManifest => ({ name, description: name, version: 1, sideEffect, inputSchema: { type: "object", properties: { s: { type: "string" } } }, outputSchema: { type: "object" } });
  const thrown = (name: string, extra: object = {}) => new PlatformError("operation_failed", `x@1 failed: boom`, { logs: [], thrown: name, ...extra });
  /** A run where `fail` says how a call fails (or nothing), each call taking `ms` on a fake clock. */
  /** `rows`: the tool's rows per table now (a fake of the copy the fuzz runs on). */
  const run = async (ops: OperationManifest[], fail: (op: string, label: string, n: number) => unknown = () => undefined, ms = 0, rows: () => Record<string, number> = () => ({})) => {
    let marked: Record<string, number> = {};
    let clock = 0;
    const calls: string[] = [];
    const report = await fuzz(ops, {
      call: async (o, f) => {
        calls.push(`${o.name} ${f.label}`);
        clock += ms;
        const e = fail(o.name, f.label, calls.length);
        if (e) throw e;
        return {};
      },
      mark: async () => void (marked = rows()),
      since: async () => {
        const now = rows();
        const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
        return { tables: Object.fromEntries(Object.entries(marked).filter(([, n]) => n).map(([t, n]) => [t, { before: n, after: now[t] ?? 0, kept: Math.min(n, now[t] ?? 0) }])), added: Object.fromEntries(Object.entries(now).filter(([t]) => !(t in marked))), rows: { before: sum(marked), now: sum(now) } };
      },
      between: async () => {},
      now: () => clock,
    });
    return { report, calls };
  };

  test("reads first, each input twice, then writes, destructive ones last", async () => {
    const { report, calls } = await run([op("d", "destructive"), op("w", "write"), op("r", "read")]);
    assert.deepEqual(calls.slice(0, 3), ["r the minimal input", "r the minimal input", "r the input with every field set"]);
    assert.deepEqual([...new Set(calls.map((c) => c.split(" ")[0]))], ["r", "w", "d"]);
    assert.deepEqual(report.problems, []);
    assert.equal(report.calls, calls.length);
  });

  test("what counts: a crash, an output its schema refuses, a call past its deadline; not: a refusal, an error after reaching for a setting, another tool's stall", async () => {
    const cases: [unknown, string | undefined][] = [
      [thrown("TypeError"), "x@1 crashed on the minimal input: TypeError: boom"],
      [thrown("SyntaxError"), "x@1 crashed on the minimal input: SyntaxError: boom"],
      [new PlatformError("invalid_output", "implementation returned output violating x@1 outputSchema", ["$.n must be integer"]), "x@1 returned output its outputSchema refuses, on the minimal input: $.n must be integer"],
      [new PlatformError("operation_failed", "x@1 timed out (call chain deadline)"), "x@1 ran past its deadline (30 s), on the minimal input"],
      [thrown("Error"), undefined],
      [new PlatformError("operation_failed", "x@1 failed: no such run", { logs: [] }), undefined],
      [thrown("TypeError", { reached: true }), undefined],
      [new PlatformError("operation_failed", "x@1 failed: another tool's code held up Hewn's tools", { heldUp: true, thrown: "TypeError" }), undefined],
      [new Error("Hewn's own"), undefined],
    ];
    for (const [e, problem] of cases) {
      const { report } = await run([op("x", "write")], (_, label) => (label === "the minimal input" ? e : undefined));
      assert.deepEqual(report.problems, problem ? [problem] : [], String((e as Error).message));
    }
    const { report } = await run([op("x", "write")], () => thrown("TypeError", { reached: true }));
    assert.deepEqual(report.notes, ["x@1 reached for the network, a secret, a setting, another tool or the model, which the fuzz doesn't give it: an error after that isn't judged"]);
  });

  test("one problem per operation, then the next operation", async () => {
    const { report, calls } = await run([op("a", "write"), op("b", "write")], (name) => (name === "a" ? new PlatformError("operation_failed", "a@1 failed: boom", { thrown: "TypeError" }) : undefined));
    assert.deepEqual(report.problems, ["a@1 crashed on the minimal input: TypeError: boom"]);
    assert.equal(calls.filter((c) => c.startsWith("a ")).length, 1);
    assert.ok(calls.filter((c) => c.startsWith("b ")).length > 1);
  });

  test("a read that changes the tool's data when called again isn't idempotent; one that fills a cache once is", async () => {
    let rows = 0;
    const visits = await run([op("visit", "read")], () => void rows++, 0, () => ({ visits: rows }));
    assert.deepEqual(visits.report.problems, ["visit@1 isn't idempotent: called again with the minimal input, it changed the tool's data (`visits` went from 1 to 2 rows)"]);
    let cached = false;
    const cache = await run([op("cache", "read")], () => void (cached = true), 0, () => ({ cache: cached ? 1 : 0 }));
    assert.deepEqual(cache.report.problems, []);
  });

  test("what a second call changed, in words: a table without a key is judged by its rows", () => {
    const rows = { before: 3, now: 3 };
    assert.deepEqual(keysChanged({ tables: { log: { before: 3, after: 3, kept: null } }, added: {}, rows }), [], "no key: the same rows");
    assert.deepEqual(keysChanged({ tables: { runs: { before: 3, after: 3, kept: 2 } }, added: {}, rows }), ["`runs`'s keys changed"]);
    assert.deepEqual(keysChanged({ tables: { runs: { before: 3, after: 4, kept: 3 } }, added: { cache: 1 }, rows }), ["`runs` went from 3 to 4 rows", "`cache` went from 0 to 1 rows"]);
  });

  test("its bounds stop it, naming what wasn't tried, and fail nothing: 5 s an operation, 60 s the tool", async () => {
    const one = await run([op("slow", "write")], undefined, 2000);
    assert.deepEqual(one.report.notes, ["slow@1: 2 of its 5 inputs not tried (the fuzz's 5 s for an operation)"]);
    assert.deepEqual(one.report.problems, []);
    const many = await run(Array.from({ length: 14 }, (_, i) => op(`w${i}`, "write")), undefined, 1000);
    assert.equal(many.report.operations, 12);
    assert.deepEqual(many.report.notes.at(-1), "not reached within the fuzz's 60 s for the tool: w12@1, w13@1");
    assert.deepEqual(many.report.problems, []);
  });

  test("a stall stops it there", async () => {
    const { report, calls } = await run([op("a", "write"), op("b", "write")], (name) => (name === "a" ? new PlatformError("operation_failed", "a@1 failed: stalled", { stalled: true }) : undefined));
    assert.equal(report.stalled, true);
    assert.deepEqual(calls, ["a the minimal input"]);
  });
});

describe("the schema fuzz in validation", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());
  const op = (name: string, sideEffect: string, inputSchema: object, outputSchema: object = { type: "object" }) => ({ name, description: name, version: 1, sideEffect, inputSchema, outputSchema });
  /** The running log with one operation more (its manifest entry and its code), and maybe a migration. */
  const withOp = (entry: object, code: string, migration?: [string, string]) => (ws: string) => {
    editJson(join(ws, "capability.json"), (m) => m.operations.push(entry));
    editText(join(ws, "src/index.ts"), (s) => s.replace(/\n};\s*$/, `\n  ${code}\n};\n`));
    if (migration) writeFileSync(join(ws, "migrations", migration[0]), migration[1]);
  };
  const change = async (edit: (ws: string) => void) => {
    t.queue(edit);
    return t.platform.settle((await t.platform.modify(USER, { capabilityId: "running-log", request: "change" })).buildId);
  };
  const active = () => t.platform.registry.getCapability("running-log")!.activeVersion;
  const tagRun = withOp(op("tag_run", "write", { type: "object", properties: { note: { type: ["string", "null"] } } }), `"tag_run@1"(input: any) { return input.note === undefined ? {} : { note: input.note.trim() }; },`);

  test("a crash on a value its schema allows stops the build, naming the operation and the input; not caught (the tool's data was never at risk)", async () => {
    const before = active();
    const b = await change(tagRun);
    assert.equal(b.status, "failed", b.log.join("\n"));
    assert.match(b.log.join("\n"), /Hewn's own tests called each operation with inputs its inputSchema accepts, and found problems:\n {2}- tag_run@1 crashed on null in `note`: TypeError: Cannot read properties of null \(reading 'trim'\)/);
    assert.equal(b.failure?.title, "Hewn's own tests found a problem");
    assert.match(b.failure!.detail, /^tag_run@1 crashed on null in `note`: TypeError/);
    assert.equal(b.failure?.caught, undefined);
    assert.equal(active(), before, "nothing went live");
  });

  test("an output its outputSchema refuses stops it, on the input that gave it", async () => {
    const b = await change(withOp(op("count_runs", "read", { type: "object", properties: { from: { type: "string" } } }, { type: "object", required: ["n"], properties: { n: { type: "integer" } } }), `"count_runs@1"(input: any, { db }: Ctx) { const n = (db.prepare("SELECT count(*) AS n FROM runs").get() as any).n; return { n: input.from === "" ? String(n) : n }; },`));
    assert.equal(b.status, "failed", b.log.join("\n"));
    assert.match(b.log.join("\n"), /- count_runs@1 returned output its outputSchema refuses, on the empty string in `from`: /);
  });

  test("a read that writes again each time isn't idempotent; one that fills a cache once goes live", async () => {
    const table: [string, string] = ["002_visits.sql", "CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT);\n"];
    const cache = await change(withOp(op("cached", "read", { type: "object" }), `"cached@1"(_: unknown, { db }: Ctx) { db.prepare("INSERT OR IGNORE INTO visits (id, at) VALUES (1, 'cache')").run(); return {}; },`, table));
    assert.equal(cache.status, "promoted", cache.log.join("\n"));
    const b = await change(withOp(op("visit", "read", { type: "object" }), `"visit@1"(_: unknown, { db }: Ctx) { db.prepare("INSERT INTO visits (at) VALUES ('now')").run(); return {}; },`));
    assert.equal(b.status, "failed", b.log.join("\n"));
    assert.match(b.log.join("\n"), /- visit@1 isn't idempotent: called again with the minimal input, it changed the tool's data \(`visits` went from \d+ to \d+ rows\)/);
  });

  test("an error the tool throws is its refusal, and one after reading a setting isn't judged: the build goes live, its log says what the fuzz did", async () => {
    const b = await change((ws) => {
      withOp(op("find_run", "read", { type: "object", properties: { id: { type: "string" } } }), `"find_run@1"() { throw new Error("no such run"); },`)(ws);
      withOp(op("site", "read", { type: "object" }), `"site@1"(_: unknown, ctx: any) { return { title: ctx.config.SITE.trim() }; },`)(ws);
    });
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.ok(b.log.some((l) => /schema fuzz: site@1 reached for the network, a secret, a setting, another tool or the model, which the fuzz doesn't give it: an error after that isn't judged/.test(l)), b.log.join("\n"));
    assert.ok(b.log.some((l) => /schema fuzz: \d+ calls on 5 operations, nothing found/.test(l)), b.log.join("\n"));
  });

  test("an agent's check runs it too", async () => {
    const pack = await t.platform.pack(t.claude, { kind: "modify", capabilityId: "running-log" });
    const files = pack.files.filter((f) => !/^(CONTRACTS\.md|OTHER_TOOLS\.md|PLATFORM_UI\.css|\.hewn-contracts\/)/.test(f.path));
    const edited = files.map((f) => {
      if (f.path === "capability.json") {
        const m = JSON.parse(f.content);
        m.operations.push(op("tag_run", "write", { type: "object", properties: { note: { type: ["string", "null"] } } }));
        return { ...f, content: JSON.stringify(m) };
      }
      if (f.path === "src/index.ts") return { ...f, content: f.content.replace(/\n};\s*$/, `\n  "tag_run@1"(input: any) { return input.note === undefined ? {} : { note: input.note.trim() }; },\n};\n`) };
      return f;
    });
    const checked = await t.platform.checkFiles(t.claude, { files: edited, capabilityId: "running-log" });
    assert.equal(checked.passed, false, checked.text);
    assert.match(checked.failures.join("\n"), /- tag_run@1 crashed on null in `note`: TypeError/);
  });
});
