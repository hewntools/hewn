// SPDX-License-Identifier: AGPL-3.0-or-later
// A long validation (hundreds of test cases, some of them slow) lets the rest of Hewn run between cases: the
// supervisor's health check is answered behind it, and after 5 s without an answer workerd is restarted.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editJson, SEED } from "./helpers.ts";
import { startTestHost } from "./workerd-helpers.ts";

test("Hewn answers its health check all through a validation of hundreds of cases, a dozen of them slow", async () => {
  // The supervisor's own watchdog, as it runs for an owner (a test host's is tighter).
  const h = await startTestHost({ watchdog: { intervalMs: 1000, stallMs: 5000 } });
  const dir = mkdtempSync(join(tmpdir(), "hewn-many-cases-"));
  try {
    cpSync(SEED, dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) =>
      m.operations.push({
        name: "self_check",
        description: "Checks the runs table, slowly.",
        version: 1,
        sideEffect: "read",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      }),
    );
    // About 0.4 s of synchronous SQLite work, as a self-check inside a transaction can take.
    appendFileSync(
      join(dir, "src/index.ts"),
      `\nObject.assign(operations, {\n  "self_check@1"(_input: unknown, { db }: Ctx) {\n    const end = Date.now() + 400;\n    while (Date.now() < end) db.prepare("SELECT COUNT(*) AS n FROM runs").get();\n    return { ok: true };\n  },\n});\n`,
    );
    const cheap = Array.from({ length: 400 }, (_, i) => ({ name: `list ${i}`, operation: "list_runs", input: {}, expect: { runs: "$any" } }));
    const slow = Array.from({ length: 12 }, (_, i) => ({ name: `self-check ${i}`, operation: "self_check", input: {}, expect: { ok: true } }));
    writeFileSync(join(dir, "tests/cases.json"), JSON.stringify([...cheap.slice(0, 200), ...slow, ...cheap.slice(200)]));

    // The supervisor's own check, as often as a timer can: the longest wait for an answer.
    let longest = 0;
    let installing = true;
    const probe = (async () => {
      while (installing) {
        const at = Date.now();
        await fetch(`${h.sv.url}/health`).catch(() => {});
        longest = Math.max(longest, Date.now() - at);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    try {
      // Without a turn of the event loop between cases, workerd is restarted mid-install and the request is cut.
      const b = await h.sv.admin("install", { name: "Running Log", purpose: "x", dir, wait: true }).catch((e: Error) => ({ status: `cut off: ${e.message}`, log: [] as string[] }));
      assert.equal(b.status, "promoted", b.log.join("\n"));
      assert.ok(b.log.some((l: string) => l.includes("412 test cases passed")), b.log.join("\n"));
    } finally {
      installing = false;
      await probe;
    }
    assert.ok(longest < 1000, `the longest wait for /health was ${longest} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.stop();
  }
});
