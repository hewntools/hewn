// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Registry } from "@hewntools/core/registry.ts";
import { nodeSql } from "@hewntools/test-host/sql.ts";

test("a home from before a column was added gets it, and keeps its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "hewn-registry-"));
  try {
    const sql = nodeSql(join(dir, "hewn.db"));
    // The capabilities table as 0.4.7 left it: no saturation.
    sql.exec(`CREATE TABLE capabilities (id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL, active_version INTEGER, created_by TEXT NOT NULL, created_at TEXT NOT NULL, display_name TEXT, icon_type TEXT, archived_at TEXT, hue TEXT, home_order TEXT, ui_key TEXT)`);
    sql.prepare("INSERT INTO capabilities (id, name, purpose, created_by, created_at, hue) VALUES ('ghost', 'Ghost', 'p', 'user', '2026-10-24', '0')").run();
    const registry = new Registry(sql);
    assert.equal(registry.getCapability("ghost")!.saturation, null);
    registry.setOwnerPrefs("ghost", { saturation: 0 });
    assert.equal(registry.getCapability("ghost")!.saturation, 0);
    assert.equal(registry.getCapability("ghost")!.hue, 0);
    new Registry(sql); // opening it again changes nothing
    assert.equal(registry.getCapability("ghost")!.saturation, 0);
    sql.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version is read from the database once, shared, and forgotten with its tool", () => {
  const dir = mkdtempSync(join(tmpdir(), "hewn-registry-"));
  try {
    const sql = nodeSql(join(dir, "hewn.db"));
    const registry = new Registry(sql);
    const add = (name: string) => {
      registry.insertCapability({ id: "log", name, purpose: "p", createdBy: "user" });
      registry.insertVersion({ capabilityId: "log", version: 1, manifest: { id: "log", name, purpose: "p", operations: [] } as any, contentHash: name, buildId: "b" });
    };
    add("Log");
    const v = registry.getVersion("log", 1)!;
    assert.equal(registry.getVersion("log", 1), v, "the same object, not decoded again");
    // A new tool under a purged id starts again at version 1: its own, not the old one's.
    registry.purgeCapability("log");
    assert.equal(registry.getVersion("log", 1), undefined);
    add("Log again");
    assert.equal(registry.getVersion("log", 1)!.manifest.name, "Log again");
    sql.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
