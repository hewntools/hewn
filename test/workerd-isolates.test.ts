// SPDX-License-Identifier: AGPL-3.0-or-later
// Which isolate a tool's code runs in, on the real workerd host: the owner's data ops share the live
// tool's (so they never stop a call in progress), and a build's code runs in isolates of its own.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

/** Counts its calls in the isolate (module scope), and waits when asked. */
const CODE = `
let calls = 0;
export const operations = {
  async "bump@1"(input: { ms?: number }, { db }: { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } }) {
    db.prepare("INSERT INTO bumps (at) VALUES (?)").run(Date.now());
    if (input.ms) await new Promise((r) => setTimeout(r, input.ms));
    return { calls: ++calls };
  },
};
`;

function toolDir(root: string, id: string, hosts: string[]): string {
  const dir = join(root, id);
  for (const d of ["src", "migrations", "tests"]) mkdirSync(join(dir, d), { recursive: true });
  const bump = { name: "bump", description: "bump", version: 1, sideEffect: "write", inputSchema: { type: "object", additionalProperties: false, properties: { ms: { type: "integer" } } }, outputSchema: { type: "object" } };
  writeFileSync(join(dir, "capability.json"), JSON.stringify({ id, name: id, purpose: "Counts.", description: "Counts its calls.", abi: "2.0", operations: [bump], ...(hosts.length ? { requires: { hosts } } : {}) }, null, 2));
  writeFileSync(join(dir, "migrations", "001_init.sql"), "CREATE TABLE bumps (id INTEGER PRIMARY KEY, at INTEGER NOT NULL);\n");
  writeFileSync(join(dir, "src", "index.ts"), CODE);
  writeFileSync(join(dir, "tests", "cases.json"), JSON.stringify([1, 2, 3].map((n) => ({ name: `bump ${n}`, operation: "bump", input: {}, expect: { calls: "$any" } }))));
  return dir;
}

describe("a tool's isolates (workerd)", () => {
  let h: TestHost;
  let dirs: string;
  const install = async (id: string, hosts: string[] = []) => {
    const build = await h.sv.admin("install", { name: id, purpose: "counts", dir: toolDir(dirs, id, hosts), wait: true });
    assert.equal(build.status, "promoted", build.log.join("\n"));
    if (hosts.length) await h.sv.admin("approve", { capabilityId: id });
  };
  const bump = (id: string, ms?: number) => h.invoke(id, "bump", ms ? { ms } : {}).then((r) => r.result.calls as number);

  before(async () => {
    h = await startTestHost();
    dirs = mkdtempSync(join(tmpdir(), "hewn-isolates-"));
  });
  after(async () => {
    await h?.stop();
    rmSync(dirs, { recursive: true, force: true });
  });

  test("the owner's data ops during a running call don't stop it (a tool with hosts)", async () => {
    await install("reacher", ["example.com"]);
    const first = await bump("reacher");
    // The call waits; meanwhile the owner opens the tool's data and exports it.
    const running = bump("reacher", 1500);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual((await h.sv.admin("data", { capabilityId: "reacher" })).tables, { bumps: 2 });
    assert.equal((await h.sv.admin("export", { capabilityId: "reacher" })).data.bumps.length, 2);
    assert.equal(await running, first + 1, "the call ran to its end, in the same isolate");
  });

  test("a build's code runs in isolates of its own: the live tool starts fresh, and keeps one", async () => {
    // Validation ran bump three times (tests) and more (sample, real data); none of that is in the live tool's isolate.
    await install("counter");
    assert.equal(await bump("counter"), 1);
    await h.sv.admin("data", { capabilityId: "counter" });
    assert.equal(await bump("counter"), 2, "its calls and data ops share one isolate");
    // A candidate that fails its tests leaves the live tool's isolate alone.
    h.queue((ws) => writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "wrong", operation: "bump", input: {}, expect: { calls: -1 } }])));
    const failed = await h.sv.admin("modify", { capabilityId: "counter", request: "break its tests", wait: true });
    assert.equal(failed.status, "failed", failed.log.join("\n"));
    assert.equal(await bump("counter"), 3);
  });
});
