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
import { installSeed, SEED, setup } from "./helpers.ts";

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

  test("the setting: every time or only when asked", () => {
    const base = { builder: "claude", intake: "claude", maxBuildAttempts: 3, sandbox: true, logRetentionDays: 14 };
    assert.deepEqual(settingsProblems({ ...base, codeReading: "asked" }), []);
    assert.deepEqual(settingsProblems({ ...base, codeReading: "never" }), ['codeReading must be "always" or "asked"']);
  });
});
