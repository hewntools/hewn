// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { ABI, type AbiFeature, abiErrors, abiUnsupported, type CapabilityManifest, validateManifest } from "@hewntools/core/manifest.ts";
import { installFrom, SEED, setup } from "./helpers.ts";

const manifest = (extra: Partial<CapabilityManifest> & Record<string, unknown> = {}): CapabilityManifest => ({
  id: "x",
  name: "X",
  purpose: "p",
  operations: [{ name: "op", description: "d", version: 1, inputSchema: { type: "object" }, outputSchema: {}, sideEffect: "read" }],
  ...extra,
});

describe("ABI versions", () => {
  test("this Hewn implements 2.5", () => assert.equal(ABI, "2.5"));

  test("a capability may need the same or an older minor, never a newer one or another major", () => {
    assert.equal(abiUnsupported("2.0", "2.0"), undefined);
    assert.equal(abiUnsupported("2.0", "2.3"), undefined);
    assert.equal(abiUnsupported("2.1", "2.0"), "needs Hewn ABI 2.1; this Hewn has 2.0");
    assert.equal(abiUnsupported("3.0", "2.0"), "needs Hewn ABI 3.0; this Hewn has 2.0");
    assert.equal(abiUnsupported("1.0", "2.0"), "needs Hewn ABI 1.0; this Hewn has 2.0");
    assert.match(abiUnsupported("2", "2.0")!, /not a version/);
  });

  test("a tile's saturation needs 2.4, and is 0–150", () => {
    assert.match(validateManifest(manifest({ saturation: 0 }), "x").join(), /"saturation" needs ABI 2\.4/);
    assert.deepEqual(validateManifest(manifest({ abi: "2.4", saturation: 0 }), "x"), []);
    assert.deepEqual(validateManifest(manifest({ abi: "2.4", saturation: 150 }), "x"), []);
    assert.notDeepEqual(validateManifest(manifest({ abi: "2.4", saturation: 151 }), "x"), []);
    assert.notDeepEqual(validateManifest(manifest({ abi: "2.4", saturation: 50.5 }), "x"), []);
  });

  test("source and the hub fields need 2.5", () => {
    const source = { id: "plant-log", name: "Plant Log", version: 7, hash: "a".repeat(64), from: "file" as const };
    assert.match(validateManifest(manifest({ abi: "2.4", source }), "x").join(), /"source" needs ABI 2\.5/);
    assert.deepEqual(validateManifest(manifest({ abi: "2.5", source }), "x"), []);
    assert.notDeepEqual(validateManifest(manifest({ abi: "2.5", source: { ...source, from: "somewhere" as "file" } }), "x"), []);
    const requires = { capabilities: [{ id: "sky-log", operations: ["get_night@1"], hub: "hewn/sky-log", minVersion: 2 }] };
    assert.match(validateManifest(manifest({ abi: "2.4", requires }), "x").join(), /"hub" and "minVersion" in requires\.capabilities needs ABI 2\.5/);
    assert.deepEqual(validateManifest(manifest({ abi: "2.5", requires }), "x"), []);
  });

  test("a manifest without abi needs 2.0", () => {
    assert.deepEqual(abiErrors(manifest(), "2.0"), []);
    assert.deepEqual(abiErrors(manifest({ abi: "2.1" }), "2.0"), ["needs Hewn ABI 2.1; this Hewn has 2.0"]);
  });

  test("using a feature from a newer minor than declared fails", () => {
    const features: AbiFeature[] = [{ name: '"kind"', since: "2.1", used: (m) => "kind" in m }];
    const withKind = { kind: "connection" as const };
    assert.deepEqual(abiErrors(manifest(withKind), "2.1", features), ['"kind" needs ABI 2.1, but the manifest declares 2.0 (no "abi"): set "abi": "2.1"']);
    assert.deepEqual(abiErrors(manifest({ ...withKind, abi: "2.0" }), "2.1", features), ['"kind" needs ABI 2.1, but the manifest declares 2.0: set "abi": "2.1"']);
    assert.deepEqual(abiErrors(manifest({ ...withKind, abi: "2.1" }), "2.1", features), []);
    assert.deepEqual(abiErrors(manifest({ abi: "2.0" }), "2.1", features), []);
  });
});

describe("ABI on install and run", () => {
  let t: ReturnType<typeof setup>;
  let dir: string;
  beforeEach(() => {
    t = setup();
    dir = mkdtempSync(join(tmpdir(), "hewn-abi-"));
    cpSync(SEED, dir, { recursive: true });
  });
  afterEach(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const editManifest = (edit: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(readFileSync(join(dir, "capability.json"), "utf8"));
    edit(m);
    writeFileSync(join(dir, "capability.json"), JSON.stringify(m));
  };

  test("install refuses a capability that needs a newer ABI", async () => {
    editManifest((m) => (m.abi = "2.9"));
    const started = await t.platform.install(USER, { name: "Running Log", purpose: "p", builder: `copy:${dir}` });
    const result = await t.platform.settle(started.buildId);
    assert.equal(result.status, "failed");
    assert.match(result.log.join("\n"), /needs Hewn ABI 2\.9; this Hewn has 2\.5/);
  });

  test("an installed version that needs a newer ABI (Hewn downgraded) is not ready", async () => {
    await installFrom(t.platform, dir);
    const db = new DatabaseSync(t.home.db);
    const row = db.prepare("SELECT manifest FROM capability_versions WHERE capability_id = 'running-log'").get() as { manifest: string };
    db.prepare("UPDATE capability_versions SET manifest = ? WHERE capability_id = 'running-log'").run(JSON.stringify({ ...JSON.parse(row.manifest), abi: "2.9" }));
    db.close();
    const st = t.platform.readiness("running-log");
    assert.equal(st.ready, false);
    assert.equal(st.unsupportedAbi, "needs Hewn ABI 2.9; this Hewn has 2.5");
    assert.match(st.userAction!, /upgrade Hewn/);
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "list_runs" }), /not ready/);
  });
});
