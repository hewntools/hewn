// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { backupLocation, backupNow, listBackups, restoreBackup, retained } from "@hewntools/cli/backup.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { rollbackProblems } from "@hewntools/core/migrations.ts";
import { nodePlatform } from "@hewntools/test-host/index.ts";
import { readZip } from "@hewntools/cli/zip.ts";
import { editJson, installSeed, setup } from "./helpers.ts";

/** A second version of Running Log, requested by the owner, with an extra migration. */
async function modifySeed(t: ReturnType<typeof setup>, migration?: string) {
  const done = await t.build(
    () => t.platform.modify(USER, { capabilityId: "running-log", request: "v2" }),
    (ws) => {
      editJson(join(ws, "capability.json"), (m) => (m.description = "v2"));
      if (migration) writeFileSync(join(ws, "migrations", "002_more.sql"), migration);
    },
  );
  assert.equal(done.status, "promoted", done.log.join("\n"));
}

describe("trust: rollback, export, purge", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("rollback to the previous version keeps the data; Undo rolls forward", async () => {
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 5, durationSeconds: 1500 } });
    await modifySeed(t, "ALTER TABLE runs ADD COLUMN heart_rate INTEGER;");
    assert.deepEqual(await t.platform.rollback(USER, "running-log"), { from: 2, to: 1 });
    assert.equal(t.platform.registry.getCapability("running-log")!.activeVersion, 1);
    const runs = await t.platform.invoke(USER, { capabilityId: "running-log", operation: "list_runs", input: {} });
    assert.equal((runs.result as any).runs.length, 1, "state untouched");
    assert.deepEqual(await t.platform.rollback(USER, "running-log", 2), { from: 1, to: 2 });
    assert.ok(t.platform.registry.lifecycleEvents().some((e) => e.action === "rollback" && e.detail === "v2 → v1"));
    await assert.rejects(t.platform.rollback(t.claude, "running-log"), /cannot perform owner actions/);
  });

  test("rollback is refused when newer migrations aren't safe for older code", async () => {
    await modifySeed(t, "CREATE UNIQUE INDEX runs_id_unique ON runs(id);");
    await assert.rejects(t.platform.rollback(USER, "running-log"), /unique index/);
    assert.equal(rollbackProblems([{ name: "002_x.sql", sql: "ALTER TABLE runs ADD COLUMN shoe TEXT NOT NULL" }]).length, 1);
    assert.deepEqual(rollbackProblems([{ name: "002_x.sql", sql: "ALTER TABLE runs ADD COLUMN shoe TEXT NOT NULL DEFAULT ''" }]), []);
    assert.equal(rollbackProblems([{ name: "003_x.sql", sql: "ALTER TABLE runs RENAME TO jogs" }]).length, 1);
  });

  test("export: a dump of the capability's state when it has no export operation", async () => {
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 7, durationSeconds: 2100, notes: "hi" } });
    const out = await t.platform.exportData(USER, "running-log");
    assert.equal(out.source, "state");
    const tables = out.data as Record<string, any[]>;
    assert.ok(!("_hewn_migrations" in tables));
    assert.ok(Object.values(tables).flat().some((r) => r.notes === "hi"));
  });

  test("data summary: rows per table, counted, and the last write from the call log", async () => {
    const empty = await t.platform.dataSummary(USER, "running-log");
    assert.equal(empty.rows, 0);
    assert.equal(empty.lastWriteAt, null);
    assert.ok(!("_hewn_migrations" in empty.tables));
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 7, durationSeconds: 2100 } });
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 3, durationSeconds: 900 } });
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "list_runs", input: {} });
    const after = await t.platform.dataSummary(USER, "running-log");
    assert.equal(after.tables.runs, 2);
    assert.equal(after.rows, Object.values(after.tables).reduce((n, x) => n + x, 0));
    assert.ok(after.lastWriteAt && Date.now() - Date.parse(after.lastWriteAt) < 60_000, "a write, not the later read");
    const reads = (await t.platform.dataSummary(USER, "running-log")).lastWriteAt;
    assert.equal(reads, after.lastWriteAt, "reads don't move it");
    assert.equal(after.callsChecked, 3);
    // Only the latest 500 calls are looked through: none of them wrote, and it says how many.
    const later = Date.now() + 1000;
    for (let i = 0; i < 500; i++) {
      const at = new Date(later + i).toISOString();
      t.platform.registry.addCapabilityLog("running-log", at, `${at} agent:claude-code list_runs@1 ok 2ms`, ["read the runs", "x".repeat(2000)]);
    }
    const busy = await t.platform.dataSummary(USER, "running-log");
    assert.equal(busy.lastWriteAt, null);
    assert.equal(busy.callsChecked, 500);
    await assert.rejects(t.platform.dataSummary(t.claude, "running-log"), /cannot perform owner actions/);
  });

  test("code browser: a version's files with what changed since the one before, owner only", async () => {
    await modifySeed(t, "ALTER TABLE runs ADD COLUMN heart_rate INTEGER;");
    const v1 = await t.platform.versionCode(USER, "running-log", 1);
    assert.equal(v1.base, null);
    assert.ok(v1.files.every((f) => f.status === "same"));
    const v2 = await t.platform.versionCode(USER, "running-log", 2);
    assert.equal(v2.base, 1);
    const changed = v2.files.filter((f) => f.status !== "same");
    assert.deepEqual(changed.map((f) => [f.path, f.status]), [["capability.json", "changed"], ["migrations/002_more.sql", "added"]], "changed first");
    assert.deepEqual([changed[1].added, changed[1].removed], [1, 0]);
    assert.ok(!v2.files.some((f) => f.path === "BUILDER.md"), "workspace-only files never in a version");
    const manifest = await t.platform.versionFile(USER, "running-log", 2, "capability.json");
    assert.equal(manifest.status, "changed");
    assert.ok(manifest.hunks.length >= 1);
    assert.ok(manifest.hunks[0].lines.some((l) => l.type === "+" && l.text.includes('"v2"')));
    assert.equal((await t.platform.versionFile(USER, "running-log", 1, "capability.json")).hunks.length, 0);
    await assert.rejects(t.platform.versionFile(USER, "running-log", 2, "nope.ts"), /no file/);
    await assert.rejects(t.platform.versionCode(t.claude, "running-log", 2), /cannot perform owner actions/);
  });

  test("code browser: a version made after a Restore shows what changed since the restored one; old versions aren't kept decoded", async () => {
    await modifySeed(t);
    await t.platform.rollback(USER, "running-log", 1);
    const done = await t.build(
      () => t.platform.modify(USER, { capabilityId: "running-log", request: "v3" }),
      (ws) => appendFileSync(join(ws, "src", "index.ts"), "// v3\n"),
    );
    assert.equal(done.status, "promoted", done.log.join("\n"));
    const v3 = await t.platform.versionCode(USER, "running-log", 3);
    assert.equal(v3.base, 1, "built on v1, not v2");
    assert.deepEqual(v3.files.filter((f) => f.status !== "same").map((f) => [f.path, f.status, f.added, f.removed]), [["src/index.ts", "changed", 1, 0]]);
    assert.equal((await t.platform.versionFile(USER, "running-log", 3, "capability.json")).status, "same", "v2's description isn't in v3");
    const loaded = (t.platform as any).d.data.loaded as Map<string, unknown>;
    loaded.clear();
    await t.platform.versionCode(USER, "running-log", 2);
    await t.platform.versionFile(USER, "running-log", 2, "capability.json");
    assert.equal(loaded.size, 0);
  });

  test("purge: only deleted capabilities, with the id typed; everything goes and the id is free", async () => {
    await assert.rejects(t.platform.purge(USER, "running-log", "running-log"), /isn't deleted/);
    t.platform.archive(USER, "running-log");
    await assert.rejects(t.platform.purge(USER, "running-log", "nope"), /type the id/);
    await t.platform.purge(USER, "running-log", "running-log");
    assert.equal(t.platform.registry.getCapability("running-log"), undefined);
    assert.ok(!existsSync(join(t.home.capabilities, "running-log", "state.db")), "state gone");
    assert.deepEqual(t.platform.archived(USER), []);
    await installSeed(t.platform); // the id can be used again
  });
});

describe("trust: backups", () => {
  let t: ReturnType<typeof setup>;
  let dir: string;
  beforeEach(async () => {
    t = setup();
    dir = mkdtempSync(join(tmpdir(), "hewn-backups-"));
    await installSeed(t.platform);
  });
  afterEach(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  test("retention: 7 daily, then the newest of each of 4 weeks", () => {
    const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 9, 5) - i * 86400000).toISOString().slice(0, 10));
    const keep = [...retained(days)].sort().reverse();
    assert.equal(keep.length, 11);
    assert.deepEqual(keep.slice(0, 7), days.slice(0, 7));
  });

  test("now → list → restore: data comes back, secrets and agent tokens are never in the zip", async () => {
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 3, durationSeconds: 900 } });
    const b = backupNow(t.home, dir, new Date(2026, 9, 5, 3));
    assert.equal(b.name, "hewn-backup-2026-10-05.zip");
    assert.deepEqual(listBackups(dir).map((x) => x.date), ["2026-10-05"]);
    const names = readZip(readFileSync(b.file)).map((e) => e.path);
    assert.ok(names.includes("platform.db") && names.some((n) => n.endsWith("running-log/state.db")));
    assert.ok(!names.some((n) => n.includes("agents.json")), "no agent tokens");

    // Lose the data, then restore.
    t.platform.close();
    rmSync(join(t.home.capabilities, "running-log"), { recursive: true });
    const { aside } = restoreBackup(t.home, b.file);
    const restored = nodePlatform(openHome(t.home.root));
    const runs = await restored.invoke(USER, { capabilityId: "running-log", operation: "list_runs", input: {} });
    assert.equal((runs.result as any).runs.length, 1);
    restored.close();
    t.platform = nodePlatform(openHome(t.home.root)); // for cleanup
    rmSync(aside, { recursive: true, force: true });
  });

  test("backups go next to the data folder unless configured; two homes in one folder don't share", () => {
    const at = (root: string) => backupLocation({ root } as any).dir;
    assert.equal(at("/u/hewn/data"), "/u/hewn/backups", "the standard layout: ~/hewn/data, ~/hewn/backups");
    assert.equal(at("/u/hewn-data"), "/u/hewn-data-backups", "not the user's own ~/backups");
    assert.notEqual(at("/u/hewn-data"), at("/u/hewn-dev"));
    assert.deepEqual(backupLocation(t.home), { dir: `${t.home.root}-backups` });
    assert.deepEqual(backupLocation(t.home, "/somewhere"), { dir: "/somewhere" });
    assert.equal(readdirSync(dir).length, 0);
  });

});
