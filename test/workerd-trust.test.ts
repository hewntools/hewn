// SPDX-License-Identifier: AGPL-3.0-or-later
// Secrets, rollback, export and purge on the real workerd host.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { openHome } from "@hewntools/cli/home.ts";
import { startSupervisor } from "@hewntools/cli/supervisor/index.ts";
import { packBundle, unpackBundle } from "@hewntools/core/bundle.ts";
import { editJson, SEED } from "./helpers.ts";
import { freePort, startTestHost, type TestHost } from "./workerd-helpers.ts";

const FIX = resolve(import.meta.dirname, "fixtures");

/** Every file under a directory, concatenated (to search the data dir for plaintext). */
function allBytes(dir: string): Buffer {
  const parts: Buffer[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(readFileSync(p));
    }
  };
  walk(dir);
  return Buffer.concat(parts);
}

describe("trust on the workerd host", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost();
    for (const [name, dir] of [["Running Log", SEED], ["Secret Echo", join(FIX, "secret-echo")]] as const) {
      const b = await h.sv.admin("install", { name, purpose: "x", dir, wait: true });
      assert.equal(b.status, "promoted", b.log.join("\n"));
    }
  });
  after(() => h.stop());

  test("secrets: encrypted at rest, delivered to the capability, survive a restart; the key isn't in the data dir", async () => {
    const value = "TOPSECRET-" + "x".repeat(20);
    await h.sv.admin("secret", { capabilityId: "secret-echo", name: "API_TOKEN", value });
    await h.sv.admin("approve", { capabilityId: "secret-echo" });
    assert.equal((await h.invoke("secret-echo", "whoami")).result.tokenLength, value.length);
    // Rotation by the capability itself is persisted too.
    assert.equal((await h.invoke("secret-echo", "whoami", { rotate: true })).result.prefix, "TOPS");
    await h.sv.restart();
    assert.equal((await h.invoke("secret-echo", "whoami")).result.tokenLength, `${value}-rotated`.length, "decrypted after restart");
    const disk = allBytes(join(h.root, "workerd"));
    assert.ok(!disk.includes(Buffer.from("TOPSECRET")), "no plaintext secret anywhere in the workerd data dir");
    const key = readFileSync(join(h.root, "master.key"), "utf8").trim();
    assert.ok(!disk.includes(Buffer.from(key)), "the key is kept outside the data dir");
  });

  test("rollback keeps data; refused when newer migrations aren't safe for older code", async () => {
    await h.invoke("running-log", "record_run", { distanceKm: 5, durationSeconds: 1500 });
    h.queue((ws) => {
      editJson(join(ws, "capability.json"), (m) => (m.description = "v2"));
      writeFileSync(join(ws, "migrations", "002_shoe.sql"), "ALTER TABLE runs ADD COLUMN shoe TEXT;");
    });
    assert.equal((await h.sv.admin("modify", { capabilityId: "running-log", request: "v2", wait: true })).status, "promoted");
    assert.deepEqual(await h.sv.admin("rollback", { capabilityId: "running-log" }), { from: 2, to: 1 });
    assert.equal((await h.invoke("running-log", "list_runs")).result.runs.length, 1, "data kept, read by v1 code");
    assert.deepEqual(await h.sv.admin("rollback", { capabilityId: "running-log", version: 2 }), { from: 1, to: 2 });

    h.queue((ws) => writeFileSync(join(ws, "migrations", "003_unique.sql"), "CREATE UNIQUE INDEX runs_id_unique ON runs(id);"));
    assert.equal((await h.sv.admin("modify", { capabilityId: "running-log", request: "v3", wait: true })).status, "promoted");
    await assert.rejects(h.sv.admin("rollback", { capabilityId: "running-log" }), /unique index/);
  });

  test("export: a dump of the state through the active version", async () => {
    const out = await h.sv.admin("export", { capabilityId: "running-log" });
    assert.equal(out.source, "state");
    assert.equal(out.data.runs.length, 1);
    assert.ok(!("_hewn_migrations" in out.data));
  });

  test("sharing: install a shared file with its sample data, share it again, start over", async () => {
    const files: Record<string, Uint8Array> = {};
    const walk = (d: string, at = "") => {
      for (const e of readdirSync(d)) statSync(join(d, e)).isDirectory() ? walk(join(d, e), `${at}${e}/`) : (files[`${at}${e}`] = readFileSync(join(d, e)));
    };
    walk(SEED);
    files["sample/calls.json"] = Buffer.from(JSON.stringify([1, 2, 3].map((n) => ({ operation: "record_run", input: { distanceKm: n * 3, durationSeconds: n * 1000, date: `2026-10-0${n}` } }))));
    const zip = packBundle(files, { format: 1, hewn: "test", abi: "2.0", exportedAt: new Date().toISOString(), tool: { id: "running-log", version: 1, hash: "d".repeat(64) } });
    const done = await h.sv.admin("install", { bundle: Buffer.from(zip).toString("base64"), name: "Shared Log", wait: true });
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(done.builder, "bundle");
    assert.equal((await h.invoke("shared-log", "list_runs")).result.runs.length, 3, "sample data replayed by default from the CLI");
    const out = await h.sv.admin("share", { capabilityId: "shared-log" });
    assert.equal(out.check.blocked, null);
    const again = unpackBundle(Buffer.from(out.bundle, "base64"));
    assert.equal(again.sidecar.tool.id, "shared-log");
    assert.ok(!JSON.parse(Buffer.from(again.files["capability.json"]).toString()).source, "a shared-on file carries no source of its own");
    const r = (await h.sv.admin("call", { method: "startOver", args: ["shared-log", { confirm: "shared-log" }] })).result;
    assert.match(r.backup, /^backup:start-over-\d+$/);
    assert.equal((await h.invoke("shared-log", "list_runs")).result.runs.length, 0);
  });

  test("data summary: rows counted in the capability's Durable Object", async () => {
    const out = await h.sv.admin("data", { capabilityId: "running-log" });
    assert.equal(out.tables.runs, (await h.invoke("running-log", "list_runs")).result.runs.length);
    assert.ok(!("_hewn_migrations" in out.tables));
  });

  test("schedules: a Durable Object alarm runs a due schedule as schedule:<id>", async () => {
    const before = (await h.invoke("running-log", "list_runs")).result.runs.length;
    const s = await h.sv.admin("schedules", { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 2, durationSeconds: 600 }, cadence: "daily 06:00" });
    assert.equal(s.status, "active");
    assert.ok(s.nextRunAt > Date.now());
    await h.sv.admin("schedules/fire", { id: s.id });
    let after: any;
    for (let i = 0; i < 50; i++) {
      after = (await h.sv.admin("schedules", { capabilityId: "running-log" })).find((x: any) => x.id === s.id);
      if (after.lastOutcome) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(after.lastOutcome, "ok");
    assert.ok(after.nextRunAt > Date.now(), "re-armed for the next day");
    assert.equal((await h.invoke("running-log", "list_runs")).result.runs.length, before + 1);
    assert.match((await h.sv.admin("logs", { capabilityId: "running-log" })).lines.join("\n"), new RegExp(`schedule:${s.id} record_run@1 ok`));
  });

  test("visual check on the workerd host: the candidate UI renders (or the step says why it's skipped)", async () => {
    const b = await h.sv.admin("install", { name: "UI Counter", purpose: "x", dir: join(FIX, "ui-counter"), wait: true });
    assert.equal(b.status, "promoted", b.log.join("\n"));
    const line = b.log.find((l: string) => /UI renders without errors|visual check skipped/.test(l));
    assert.ok(line, "the visual step ran");
    if (/renders without errors/.test(line)) {
      assert.equal(b.screenshot, true);
      const png = readFileSync(join(h.root, "workerd", "blobs", "screenshots", `${b.buildId}.png`));
      assert.equal(png.subarray(1, 4).toString(), "PNG");
    }
  });

  test("purge: only after delete, with the id typed; state, versions and secrets go; the id is free again", async () => {
    await assert.rejects(h.sv.admin("purge", { capabilityId: "secret-echo", confirm: "secret-echo" }), /isn't deleted/);
    await h.sv.admin("archive", { capabilityId: "secret-echo" });
    await assert.rejects(h.sv.admin("purge", { capabilityId: "secret-echo", confirm: "nope" }), /type the id/);
    const versionsBefore = readdirSync(join(h.root, "workerd", "blobs", "versions")).length;
    await h.sv.admin("purge", { capabilityId: "secret-echo", confirm: "secret-echo" });
    assert.ok(readdirSync(join(h.root, "workerd", "blobs", "versions")).length < versionsBefore, "its version blobs are gone");
    const again = await h.sv.admin("install", { name: "Secret Echo", purpose: "x", dir: join(FIX, "secret-echo"), wait: true });
    assert.equal(again.status, "promoted", again.log.join("\n"));
    assert.deepEqual((await h.sv.admin("readiness", { capabilityId: "secret-echo" })).missingSecrets, ["API_TOKEN"], "secrets were purged");
  });
});

describe("a backup restored on another machine (a different secrets key)", () => {
  test("Hewn starts; the secrets it can't read count as not set, and setting them again works", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-newkey-"));
    const start = async () => startSupervisor({ home: openHome(root), port: await freePort(), publicPort: await freePort(), builders: {}, log: () => {}, keySource: "file" });
    let sv = await start();
    try {
      const b = await sv.admin("install", { name: "Secret Echo", purpose: "x", dir: join(FIX, "secret-echo"), wait: true });
      assert.equal(b.status, "promoted", b.log.join("\n"));
      await sv.admin("secret", { capabilityId: "secret-echo", name: "API_TOKEN", value: "old-machine" });
      await sv.admin("approve", { capabilityId: "secret-echo" });
      await sv.stop();
      writeFileSync(join(root, "master.key"), randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
      sv = await start();
      assert.ok(await fetch(`${sv.url}/health`).then((r) => r.ok), "up despite the unreadable secret");
      assert.deepEqual((await sv.admin("call", { method: "unreadableSecrets", args: [] })).result, [{ capabilityId: "secret-echo", name: "API_TOKEN" }]);
      await assert.rejects(sv.admin("invoke", { capabilityId: "secret-echo", operation: "whoami", input: {} }), /API_TOKEN|not ready|authoriz/i);
      await sv.admin("secret", { capabilityId: "secret-echo", name: "API_TOKEN", value: "new-machine" });
      assert.equal((await sv.admin("invoke", { capabilityId: "secret-echo", operation: "whoami", input: {} })).result.tokenLength, "new-machine".length);
      assert.deepEqual((await sv.admin("call", { method: "unreadableSecrets", args: [] })).result, []);
    } finally {
      await sv.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
