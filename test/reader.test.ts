// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader on a client's submission: before it's held or goes live, the owner's builder reads its code
// (the intake's "summarize", as for a file the owner installs), and the reading is kept for the owner alone. It
// describes and warns, never gates: a read that's off, refused or failed is kept as why the code wasn't read.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import type { BundleSummary } from "@hewntools/core/bundle.ts";
import type { FileEntry, SummaryInput } from "@hewntools/core/platform.ts";
import { settingsProblems } from "@hewntools/host-workerd/surface/host.ts";
import { READS_PER_HOUR } from "@hewntools/core/platform/builds.ts";
import { installSeed, SEED, setup } from "./helpers.ts";
import { parse, startTestHost, waitBuild } from "./workerd-helpers.ts";

/** A folder's files as a client sends them. */
function entriesOf(dir: string, rel = ""): FileEntry[] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const path = rel ? `${rel}/${name}` : name;
    return statSync(join(dir, path)).isDirectory() ? entriesOf(dir, path) : [{ path, content: readFileSync(join(dir, path), "utf8") }];
  });
}
const reworded = () => entriesOf(SEED).map((f) => (f.path === "capability.json" ? { ...f, content: JSON.stringify({ ...JSON.parse(f.content), purpose: "Runs, reworded." }, null, 2) } : f));

const READING: BundleSummary = {
  message: "It keeps your runs and adds them up.",
  keeps: "Each run's date, distance and time.",
  reaches: "Nothing outside Hewn.",
  findings: [
    { kind: "warn", title: "It deletes nothing, but it never checks the distance", file: "src/index.ts", line: 3 },
    { kind: "ok", title: "A place the reading made up is dropped", file: "src/nowhere.ts", line: 9 },
  ],
};

describe("the reader on a submission", () => {
  let t: ReturnType<typeof setup>;
  afterEach(() => t.cleanup());
  /** A Hewn whose reader answers `answer` (or throws it), counting what it was given. */
  const withReader = async (answer: BundleSummary | Error | undefined, reads = () => true) => {
    const asked: SummaryInput[] = [];
    t = setup({
      ...(answer !== undefined
        ? {
            readCode: async (input: SummaryInput) => {
              asked.push(input);
              if (answer instanceof Error) throw answer;
              return answer;
            },
          }
        : {}),
      readsCode: reads,
    });
    await installSeed(t.platform);
    return asked;
  };
  const submit = async () => t.platform.settle((await t.platform.submitFiles(t.claude, { files: reworded(), capabilityId: "running-log", request: "reword" })).buildId);

  test("read before it's held, its code numbered as the intake reads it; the reading is the owner's alone", async () => {
    const asked = await withReader(READING);
    const b = await submit();
    assert.equal(b.status, "review", b.log.join("\n"));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].manifest.purpose, "Runs, reworded.");
    assert.ok(asked[0].files.some((f) => f.path === "src/index.ts" && /^\s*1\| /.test(f.text)), "lines numbered");
    const reading = t.platform.buildContext(USER, b.buildId).reading as { summary: BundleSummary };
    assert.equal(reading.summary.message, READING.message);
    assert.deepEqual(reading.summary.findings?.map((f) => f.file), ["src/index.ts", undefined], "a place it made up is dropped");
    assert.deepEqual(t.platform.buildsInReview(USER).find((x) => x.buildId === b.buildId)?.reading, reading);
    // The agent that wrote it sees that it was read, never what was said.
    const seen = JSON.stringify(t.platform.getBuild(t.claude, b.buildId));
    assert.ok(!seen.includes(READING.message) && !seen.includes("never checks the distance"), seen);
    assert.ok(b.log.some((l) => l.endsWith("code read by the owner's reader")), b.log.join("\n"));
  });

  test("a read that fails, or no reader here, is kept as why the code wasn't read, and the submission is held all the same", async () => {
    await withReader(new Error("429 the month's reads are used up"));
    const failed = await submit();
    assert.equal(failed.status, "review", failed.log.join("\n"));
    assert.match((t.platform.buildContext(USER, failed.buildId).reading as { unread: string }).unread, /^the read didn't finish: 429 the month's reads are used up/);
    assert.ok(failed.log.some((l) => l.endsWith("the code wasn't read")), failed.log.join("\n"));
    assert.ok(!JSON.stringify(t.platform.getBuild(t.claude, failed.buildId)).includes("429"), "nor why, to the agent");
    t.cleanup();
    await withReader(undefined);
    const none = await submit();
    assert.equal(none.status, "review");
    assert.match((t.platform.buildContext(USER, none.buildId).reading as { unread: string }).unread, /no builder is set up to read it/);
  });

  test("only when the owner asks: nothing is read by itself; Check it yourself reads once and keeps it", async () => {
    const asked = await withReader(READING, () => false);
    const b = await submit();
    assert.equal(b.status, "review");
    assert.equal(asked.length, 0, "no model call");
    assert.match((t.platform.buildContext(USER, b.buildId).reading as { unread: string }).unread, /only when you ask/);
    await assert.rejects(t.platform.readHeldBuild(t.claude, b.buildId), (e: { code?: string }) => e.code === "forbidden");
    const read = await t.platform.readHeldBuild(USER, b.buildId);
    assert.equal(asked.length, 1);
    assert.equal((read as { summary: BundleSummary }).summary.message, READING.message);
    assert.equal((t.platform.buildContext(USER, b.buildId).reading as { summary: BundleSummary }).summary.message, READING.message);
  });

  test("the owner's installs and the builder's builds aren't read here: an install has its own reading, on the sheet", async () => {
    const asked = await withReader(READING);
    assert.equal(asked.length, 0, "the seed's install wasn't read");
  });

  test("the reader is told who wrote it, what it says, and for a change which files differ", async () => {
    const asked = await withReader(READING);
    await submit();
    assert.deepEqual(asked[0].submitted, { by: "claude-code", says: "reword", changed: ["capability.json"] });
  });

  test("the same files are read once; an agent gets at most READS_PER_HOUR reads, then the code isn't read", async () => {
    const asked = await withReader(READING);
    const first = await submit();
    await t.platform.rejectBuild(USER, first.buildId);
    const again = await submit();
    assert.equal(asked.length, 1, "read once");
    assert.equal((t.platform.buildContext(USER, again.buildId).reading as { summary: BundleSummary }).summary.message, READING.message);
    await t.platform.rejectBuild(USER, again.buildId);
    for (let i = 1; i < READS_PER_HOUR; i++) {
      const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: reworded().map((f) => (f.path === "capability.json" ? { ...f, content: f.content.replace("Runs, reworded.", `Runs, reworded ${i}.`) } : f)), capabilityId: "running-log", request: "reword" })).buildId);
      await t.platform.rejectBuild(USER, b.buildId);
    }
    assert.equal(asked.length, READS_PER_HOUR);
    const over = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: reworded().map((f) => (f.path === "capability.json" ? { ...f, content: f.content.replace("Runs, reworded.", "Runs, once more.") } : f)), capabilityId: "running-log", request: "reword" })).buildId);
    assert.equal(over.status, "review");
    assert.equal(asked.length, READS_PER_HOUR, "no model call past the cap");
    assert.match((t.platform.buildContext(USER, over.buildId).reading as { unread: string }).unread, new RegExp(`more than ${READS_PER_HOUR} tools to read this hour`));
  });

  test("Check it yourself: one read at a time a build; a read that fails keeps, and answers with, the earlier one", async () => {
    let fail = false;
    let calls = 0;
    let release!: () => void;
    t = setup({
      readCode: async () => {
        calls++;
        if (fail) throw new Error("the model is down");
        await new Promise<void>((r) => (release = r));
        return READING;
      },
      readsCode: () => false,
    });
    await installSeed(t.platform);
    const b = await submit();
    const both = Promise.all([t.platform.readHeldBuild(USER, b.buildId), t.platform.readHeldBuild(USER, b.buildId)]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [one, two] = await both;
    assert.equal(calls, 1, "one read for both");
    assert.equal((one as { summary: BundleSummary }).summary.message, READING.message);
    assert.deepEqual(one, two);
    fail = true;
    const after = await t.platform.readHeldBuild(USER, b.buildId);
    assert.equal(calls, 2);
    assert.equal((after as { summary: BundleSummary }).summary.message, READING.message, "the earlier reading, kept and returned");
  });

  test("a read is stopped at its time limit, and when the build is cancelled; either way the build carries on or ends as asked", async () => {
    let seen: AbortSignal | undefined;
    t = setup({ readCode: (_input, signal) => ((seen = signal), new Promise<never>(() => {})) });
    await installSeed(t.platform);
    t.platform.readMs = 300;
    const slow = await submit();
    assert.equal(slow.status, "review", slow.log.join("\n"));
    assert.match((t.platform.buildContext(USER, slow.buildId).reading as { unread: string }).unread, /^the read didn't finish: it took longer than/);
    await t.platform.rejectBuild(USER, slow.buildId);
    t.platform.readMs = 60_000;
    const started = await t.platform.submitFiles(t.claude, { files: reworded().map((f) => (f.path === "capability.json" ? { ...f, content: f.content.replace("Runs, reworded.", "Runs, cancelled.") } : f)), capabilityId: "running-log", request: "reword" });
    for (let i = 0; i < 200 && !t.platform.getBuild(USER, started.buildId).log.some((l) => l.endsWith("reading the code (usually under a minute)")); i++) await new Promise((r) => setTimeout(r, 25));
    t.platform.cancelBuild(t.claude, started.buildId);
    const ended = await t.platform.settle(started.buildId);
    assert.equal(ended.status, "cancelled", ended.log.join("\n"));
    assert.equal(seen?.aborted, true, "the reader was told to stop");
  });

  test("the setting: every time or only when asked", () => {
    const base = { builder: "claude", intake: "claude", maxBuildAttempts: 3, sandbox: true, logRetentionDays: 14 };
    assert.deepEqual(settingsProblems({ ...base, codeReading: "asked" }), []);
    assert.deepEqual(settingsProblems({ ...base, codeReading: "never" }), ['codeReading must be "always" or "asked"']);
  });
});

test("on the workerd host: the setting reaches the reader, and an agent's builds_wait never carries the reading", async () => {
  let reads = 0;
  const intake = async (req: { mode: string }) => {
    if (req.mode !== "summarize") throw new Error("only summaries here");
    reads++;
    return { kind: "summary", ...READING } as never;
  };
  const h = await startTestHost({ intake: intake as never });
  try {
    await h.sv.admin("settings", { builder: "claude", intake: "claude" });
    const seed = await h.sv.admin("install", { name: "Running Log", purpose: "runs", dir: SEED, wait: true });
    assert.equal(seed.status, "promoted");
    const claude = await h.agent("claude-code", ["discover", "invoke", "create", "modify"]);
    const submitted = parse(await claude.callTool({ name: "capabilities_submit", arguments: { files: reworded(), capabilityId: "running-log", request: "reword" } }));
    const waited = await waitBuild(claude, submitted.buildId, 180);
    assert.equal(waited.status, "review");
    assert.equal(reads, 1);
    assert.ok(!JSON.stringify(waited).includes(READING.message), "the agent's view has no reading");
    await h.sv.admin("call", { method: "rejectBuild", args: [submitted.buildId] });
    await h.sv.admin("settings", { codeReading: "asked" });
    const asked = parse(await claude.callTool({ name: "capabilities_submit", arguments: { files: reworded().map((f) => (f.path === "capability.json" ? { ...f, content: f.content.replace("Runs, reworded.", "Runs, asked.") } : f)), capabilityId: "running-log", request: "reword" } }));
    assert.equal((await waitBuild(claude, asked.buildId, 180)).status, "review");
    assert.equal(reads, 1, "When I ask: no read");
    const held = (await h.sv.admin("call", { method: "buildsInReview", args: [] })).result.find((x: { buildId: string }) => x.buildId === asked.buildId);
    assert.match(held.reading.unread, /only when you ask/);
  } finally {
    await h.stop();
  }
});
