// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { crc32, dependencyProblems, MAX_BUNDLE_BYTES, packBundle, readZip, registrySpec, scanFiles, SIDECAR, type Sidecar, unpackBundle, writeZip } from "@hewntools/core/bundle.ts";
import { bytes, text } from "@hewntools/core/files.ts";
import { createZip } from "@hewntools/cli/zip.ts";
import { editJson, installFrom, installSeed, platformWith, SEED, setup } from "./helpers.ts";

const SAMPLE = JSON.stringify([
  { operation: "record_run", input: { distanceKm: 5.2, durationSeconds: 1700, date: "2026-10-01", notes: "Easy loop by the river" } },
  { operation: "record_run", version: 1, input: { distanceKm: 10, durationSeconds: 3300, date: "2026-10-04" } },
  { operation: "record_run", input: { distanceKm: 7.5, durationSeconds: 2550, date: "2026-10-08" } },
]);

const runs = async (t: ReturnType<typeof setup>, id = "running-log") => ((await t.platform.invoke(USER, { capabilityId: id, operation: "list_runs", input: {} })).result as { runs: unknown[] }).runs.length;

const FIX = resolve(import.meta.dirname, "fixtures");

/**
 * A zip written byte by byte as other tools write them (stored): extra fields in the headers,
 * directory entries, a data descriptor after an entry's data when asked, entries in the order
 * given. `central` lists names and the entry each points at (default: one per entry), so several
 * may point at one entry.
 */
function rawZip(entries: { path: string; data?: Uint8Array; descriptor?: boolean }[], central?: { path: string; entry: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const at: number[] = [];
  let offset = 0;
  const push = (b: Uint8Array) => (parts.push(b), (offset += b.length));
  for (const e of entries) {
    const name = bytes(e.path);
    const data = e.data ?? new Uint8Array();
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 10, true);
    h.setUint16(6, e.descriptor ? 0x0808 : 0x0800, true);
    if (!e.descriptor) (h.setUint32(14, crc32(data), true), h.setUint32(18, data.length, true), h.setUint32(22, data.length, true));
    h.setUint16(26, name.length, true);
    h.setUint16(28, 28, true);
    at.push(offset);
    push(new Uint8Array(h.buffer));
    push(name);
    push(new Uint8Array(28)); // extra fields (timestamps, owner): skipped by readers
    push(data);
    if (e.descriptor) {
      const d = new DataView(new ArrayBuffer(16));
      d.setUint32(0, 0x08074b50, true);
      d.setUint32(4, crc32(data), true);
      d.setUint32(8, data.length, true);
      d.setUint32(12, data.length, true);
      push(new Uint8Array(d.buffer));
    }
  }
  const cdStart = offset;
  const list = central ?? entries.map((e, entry) => ({ path: e.path, entry }));
  for (const c of list) {
    const name = bytes(c.path);
    const data = entries[c.entry].data ?? new Uint8Array();
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(4, 0x031e, true);
    h.setUint16(6, 10, true);
    h.setUint16(8, 0x0800, true);
    h.setUint32(16, crc32(data), true);
    h.setUint32(20, data.length, true);
    h.setUint32(24, data.length, true);
    h.setUint16(28, name.length, true);
    h.setUint16(30, 24, true);
    h.setUint32(42, at[c.entry], true);
    push(new Uint8Array(h.buffer));
    push(name);
    push(new Uint8Array(24));
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, list.length, true);
  end.setUint16(10, list.length, true);
  end.setUint32(12, offset - cdStart, true);
  end.setUint32(16, cdStart, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let p = 0;
  for (const b of parts) (out.set(b, p), (p += b.length));
  return out;
}

describe("bundles: the zip and the scan", () => {
  test("a store-only zip round-trips; a deflated entry (another tool's zip) is refused with the reason", () => {
    const files = { "capability.json": bytes("{}"), "src/index.ts": bytes("export const operations = {};\n") };
    assert.deepEqual(Object.keys(readZip(writeZip(files))).sort(), ["capability.json", "src/index.ts"]);
    assert.equal(text(readZip(writeZip(files))["src/index.ts"]), "export const operations = {};\n");
    const deflated = createZip([{ path: "capability.json", data: Buffer.from("x".repeat(500)) }]);
    assert.throws(() => readZip(deflated), /compressed\. Hewn reads bundles that Hewn made/);
    assert.throws(() => readZip(bytes("not a zip at all")), /isn't a zip file/);
  });

  test("overlapping entries (a zip bomb) are refused, and so are more than 1,000 files", () => {
    const big = new Uint8Array(1024 * 1024).fill(97);
    const bomb = rawZip([{ path: "a.txt", data: big }], Array.from({ length: 300 }, (_, i) => ({ path: `f${i}.txt`, entry: 0 })));
    assert.ok(bomb.length < 1.1 * 1024 * 1024, "1 MB that would read as 300 MB");
    assert.throws(() => readZip(bomb), /entries overlap or are out of order/);
    const backwards = rawZip([{ path: "a.txt", data: bytes("a") }, { path: "b.txt", data: bytes("b") }], [{ path: "b.txt", entry: 1 }, { path: "a.txt", entry: 0 }]);
    assert.throws(() => readZip(backwards), /overlap or are out of order/);
    const many = rawZip(Array.from({ length: 1001 }, (_, i) => ({ path: `f${i}`, data: bytes("x") })));
    assert.throws(() => readZip(many), /holds 1001 files; a tool's file may hold at most 1,000/);
  });

  test("one file under two names (case, Unicode normalisation, or the same name twice) is refused, and so are control characters", () => {
    const one = bytes("export const operations = {};\n");
    assert.throws(() => readZip(writeZip({ "src/index.ts": one, "SRC/index.ts": one })), /SRC\/index\.ts and src\/index\.ts are in the zip: on many disks they're the same file/);
    assert.throws(() => readZip(writeZip({ "src/caf\u00e9.ts": one, "src/cafe\u0301.ts": one })), /the same file/);
    assert.throws(() => readZip(rawZip([{ path: "a.ts", data: one }, { path: "a.ts", data: one }])), /a\.ts is in the zip twice/);
    assert.throws(() => readZip(writeZip({ "src/a\nb.ts": one })), /"src\/a\\nb\.ts" isn't a path Hewn accepts/);
  });

  test("a bundle needs its sidecar, a format this Hewn reads, and at most 5 MB", () => {
    const tool = { id: "x", version: 1, hash: "a".repeat(64) };
    const sidecar: Sidecar = { format: 1, hewn: "test", abi: "2.0", exportedAt: "2026-10-26T00:00:00Z", tool };
    const ok = unpackBundle(packBundle({ "capability.json": bytes("{}") }, sidecar));
    assert.ok(!("hewn-bundle.json" in ok.files), "the sidecar isn't one of the tool's files");
    assert.throws(() => unpackBundle(writeZip({ "capability.json": bytes("{}") })), /isn't a Hewn tool/);
    assert.throws(() => unpackBundle(packBundle({ "capability.json": bytes("{}") }, { ...sidecar, format: 2 })), /newer Hewn \(bundle format 2/);
    assert.throws(() => unpackBundle(new Uint8Array(MAX_BUNDLE_BYTES + 1)), /at most 5 MB/);
  });

  test("the scan: personal data and key shapes warn, the owner's own values block, everyday text passes", () => {
    const files = {
      "tests/cases.json": bytes(['{ "email": "anna.berg@example.com", "phone": "+46 70 123 45 67", "at": "63.8258, 20.2630" }', '{ "date": "2026-10-20", "id": "1234567890", "time": "07:30" }'].join("\n")),
      "src/index.ts": bytes(['const key = "sk-abcdefghijklmnopqrstuvwxyz";', 'const mine = "my-own-todoist-token-123";', "const plain = 'running is good for you';"].join("\n")),
    };
    const found = scanFiles(files, ["my-own-todoist-token-123", "km"]);
    const at = (file: string, line: number) => found.filter((f) => f.file === file && f.line === line).map((f) => f.kind);
    assert.deepEqual(at("tests/cases.json", 1), ["pii", "pii", "pii"]);
    assert.deepEqual(at("tests/cases.json", 2), [], "dates, ids and times aren't personal data");
    assert.deepEqual(at("src/index.ts", 1), ["key"]);
    assert.deepEqual(at("src/index.ts", 2), ["secret"]);
    assert.deepEqual(at("src/index.ts", 3), []);
    const email = found.find((f) => f.label.includes("email"))!;
    assert.equal(email.masked, "a••••@e••••.com");
    assert.equal(email.text, "anna.berg@example.com");
  });
});

describe("sharing: a tool as a file", () => {
  let t: ReturnType<typeof setup>;
  let other: ReturnType<typeof setup> | undefined;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => (t.cleanup(), other?.cleanup(), (other = undefined)));

  const withSample = async () => {
    const b = await t.platform.setSample(USER, "running-log", SAMPLE);
    const done = await t.platform.settle(b.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(done.log.some((l) => /sample data replays \(3 calls\)/.test(l)));
    return done;
  };

  test("sharing needs sample data: blocked without, the check and the file with it", async () => {
    const before = await t.platform.shareCheck(USER, "running-log");
    assert.deepEqual(before.blocked, { kind: "no-sample" });
    await assert.rejects(t.platform.shareBundle(USER, "running-log"), /no sample data/);
    await withSample();
    const check = await t.platform.shareCheck(USER, "running-log");
    assert.equal(check.blocked, null);
    assert.deepEqual(check.sample, { calls: 3 });
    assert.deepEqual(check.versions, [2, 1]);
    const { name, bundle } = await t.platform.shareBundle(USER, "running-log");
    assert.equal(name, "running-log.hewn.zip");
    const { files, sidecar } = unpackBundle(bundle);
    assert.deepEqual(sidecar.tool, { id: "running-log", version: 2, hash: t.platform.registry.getVersion("running-log", 2)!.contentHash });
    assert.ok(files["sample/calls.json"] && files["src/index.ts"]);
    assert.ok(!Object.keys(files).some((p) => p === "BUILDER.md" || p.startsWith("attachments/")), "workspace-only files never travel");
    // Any version, not only the active one: v1 has no sample data.
    assert.deepEqual((await t.platform.shareCheck(USER, "running-log", 1)).blocked, { kind: "no-sample" });
    await assert.rejects(t.platform.shareCheck(t.claude, "running-log"), /cannot perform owner actions/);
  });

  test("one of the owner's own stored values blocks sharing, with where it is", async () => {
    await withSample();
    t.platform.registry.setConfig("running-log", "SITE", "https://my-private-site.example", "user");
    const b = await t.build(
      () => t.platform.modify(USER, { capabilityId: "running-log", request: "hardcode the site" }),
      (ws) => editJson(join(ws, "capability.json"), (m) => (m.description = "Posts to https://my-private-site.example")),
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));
    const check = await t.platform.shareCheck(USER, "running-log");
    assert.deepEqual(check.blocked, { kind: "secret", file: "capability.json", line: check.blocked!.kind === "secret" ? check.blocked!.line : 0, label: "your Running Log setting SITE" });
    await assert.rejects(t.platform.shareBundle(USER, "running-log"), /capability\.json:\d+ is your Running Log setting SITE\. Remove it/);
  });

  test("a connection shares without sample data, and installs signed out", async () => {
    await installFrom(t.platform, resolve(FIX, "site-connection"));
    t.platform.setConfig(USER, "site-connection", "SITE_URL", "https://my-site.example");
    const check = await t.platform.shareCheck(USER, "site-connection");
    assert.equal(check.connection, true);
    assert.equal(check.sample, null);
    assert.equal(check.blocked, null, "no sample data needed");
    const { bundle } = await t.platform.shareBundle(USER, "site-connection");
    other = setup();
    const preview = await other.platform.stageBundle(USER, bundle);
    assert.equal(preview.kind, "connection");
    const done = await other.platform.settle((await other.platform.installBundle(USER, preview.token, { name: preview.suggestedName, sample: true })).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    const st = other.platform.readiness("site-connection");
    assert.equal(st.ready, false);
    assert.deepEqual(st.missingConfig, ["SITE_URL"], "the owner's settings never travel");
    assert.deepEqual(st.missingSecrets, ["API_KEY"]);
  });

  test("round trip: share, then install on another Hewn with its sample data; source is set and stays", async () => {
    await withSample();
    const { bundle } = await t.platform.shareBundle(USER, "running-log");
    other = setup();
    const preview = await other.platform.stageBundle(USER, bundle);
    assert.equal(preview.name, "Running Log");
    assert.equal(preview.suggestedName, "Running Log");
    assert.equal(preview.sample, 3);
    assert.equal(preview.version, 2);
    assert.ok((await other.platform.bundleCode(USER, preview.token)).files.some((f) => f.path === "src/index.ts"));
    const started = await other.platform.installBundle(USER, preview.token, { name: "Running Log", sample: true });
    const done = await other.platform.settle(started.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(done.log.some((l) => /sample data: 3 calls$/.test(l)), done.log.join("\n"));
    assert.equal(await runs(other), 3, "the sample data was replayed");
    const source = { id: "running-log", name: "Running Log", version: 2, hash: t.platform.registry.getVersion("running-log", 2)!.contentHash, from: "file" };
    assert.deepEqual(other.platform.registry.getCapability("running-log")!.source, source);
    const installed = other.platform.activeManifest("running-log");
    assert.deepEqual(installed.source, source);
    assert.equal(installed.abi, "2.5", "an older Hewn refuses it with the reason");
    assert.equal(other.platform.registry.getBuild(started.buildId)!.builder, "bundle", "no builder ran");
    assert.ok(other.platform.registry.lifecycleEvents().some((e) => e.action === "sample" && e.detail === "Sample data: 3 calls"));
    // The files are the exporter's, but for the manifest the install stamps.
    const exported = unpackBundle(bundle).files;
    const v1 = await other.platform.loadVersion("running-log", 1);
    for (const p of Object.keys(exported)) if (p !== "capability.json") assert.deepEqual(v1.files[p], exported[p], p);
    // A builder's later edit to source (or a hub dependency) is replaced at promote.
    const b = await other.build(
      () => other!.platform.modify(USER, { capabilityId: "running-log", request: "v2" }),
      (ws) =>
        editJson(join(ws, "capability.json"), (m) => {
          m.source = { id: "elsewhere", version: 9, hash: "b".repeat(64), from: "hub" };
          m.requires = { capabilities: [] };
        }),
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.deepEqual(other.platform.activeManifest("running-log").source, source);
  });

  test("a zip made by another tool installs when its entries are stored (directory entries, extra fields, data descriptors)", async () => {
    await withSample();
    const { files, sidecar } = unpackBundle((await t.platform.shareBundle(USER, "running-log")).bundle);
    const dirs = [...new Set(Object.keys(files).flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => `${a.slice(0, i + 1).join("/")}/`)))];
    const entries = [...dirs.map((path) => ({ path })), ...Object.entries({ [SIDECAR]: bytes(JSON.stringify(sidecar)), ...files }).reverse().map(([path, data]) => ({ path, data, descriptor: true }))];
    other = setup();
    const preview = await other.platform.stageBundle(USER, rawZip(entries));
    assert.equal(preview.sample, 3);
    const done = await other.platform.settle((await other.platform.installBundle(USER, preview.token, { name: preview.suggestedName })).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
  });

  test("install: a taken name is offered as \"<name> 2\" and refused as it is; the id comes from the name", async () => {
    await withSample();
    const { bundle } = await t.platform.shareBundle(USER, "running-log");
    const preview = await t.platform.stageBundle(USER, bundle);
    assert.equal(preview.suggestedName, "Running Log 2");
    await assert.rejects(t.platform.installBundle(USER, preview.token, { name: "Running Log" }), /already have a tool called Running Log/);
    const done = await t.platform.settle((await t.platform.installBundle(USER, preview.token, { name: "Running Log 2" })).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(t.platform.activeManifest("running-log-2").name, "Running Log 2");
    assert.equal(await runs(t, "running-log-2"), 0, "no sample data unless asked");
    await assert.rejects(t.platform.stagedBundle(USER, preview.token), /is gone/, "installed: no longer staged");
  });

  test("an agent can't say where a tool came from: source and sample in its request are dropped", async () => {
    const fake = { id: "elsewhere", name: "Elsewhere", version: 1, hash: "d".repeat(64), from: "hub" };
    const created = await t.build(
      () => t.platform.create(t.claude, { name: "Faked Log", purpose: "p", requirements: "r", source: fake, sample: true } as any),
      (ws) => (cpSync(SEED, ws, { recursive: true }), editJson(join(ws, "capability.json"), (m) => ((m.id = "faked-log"), (m.name = "Faked Log")))),
    );
    assert.equal(created.status, "promoted", created.log.join("\n"));
    assert.ok(!("source" in created.request) && !("sample" in created.request), JSON.stringify(created.request));
    assert.equal(t.platform.registry.getCapability("faked-log")!.source, null);
    assert.equal(t.platform.activeManifest("faked-log").source, undefined, "not shown as from Hub");
    const changed = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "faked-log", request: "say more", source: fake, retryOf: created.buildId } as any),
      (ws) => editJson(join(ws, "capability.json"), (m) => (m.description = "More")),
    );
    assert.equal(changed.status, "promoted", changed.log.join("\n"));
    assert.deepEqual(Object.keys(changed.request).sort(), ["capabilityId", "request"]);
    assert.equal(t.platform.activeManifest("faked-log").source, undefined);
  });

  test("an install from a file is never retried with a builder: by hand it's refused, and a restart leaves it failed", async () => {
    const failed = await t.platform.settle((await t.platform.install(USER, { name: "Broken", purpose: "x", builder: "bundle", id: "broken", seed: { "capability.json": bytes("{}") } })).buildId);
    assert.equal(failed.status, "failed");
    await assert.rejects(t.platform.retryBuild(USER, failed.buildId), /install the file again/);
    // One cut off by a restart: no builder runs it from an empty tool.
    t.platform.registry.insertCapability({ id: "half", name: "Half", purpose: "x", createdBy: "web" });
    t.platform.registry.insertBuild({ id: "b-half", capabilityId: "half", kind: "create", request: { name: "Half", purpose: "x", requirements: "Installed from a file", source: { id: "half", name: "Half", version: 1, hash: "e".repeat(64), from: "file" } }, requestedBy: "web", baseVersion: null, builder: "bundle" });
    const restarted = platformWith(t.home, () => ({ name: "script", build: async () => assert.fail("no builder runs an install from a file") }));
    assert.deepEqual(await restarted.recoverInterruptedBuilds(), []);
    assert.equal(restarted.registry.getBuild("b-half")!.status, "failed");
    restarted.close();
  });

  test("install refuses a tool that needs a newer Hewn, with the reason", async () => {
    const sidecar: Sidecar = { format: 1, hewn: "9.9.9", abi: "2.9", exportedAt: "2026-10-26T00:00:00Z", tool: { id: "future", version: 1, hash: "c".repeat(64) } };
    const manifest = { id: "future", name: "Future Tool", purpose: "x", abi: "2.9", operations: [] };
    const zip = packBundle({ "capability.json": bytes(JSON.stringify(manifest)) }, sidecar);
    await assert.rejects(t.platform.stageBundle(USER, zip), (e: any) => /Future Tool needs Hewn ABI 2\.9; this Hewn has 2\.5\. Upgrade Hewn/.test(e.message) && e.details?.refusal === "newer");
    // A newer bundle format is the same case: the sheet offers hewn upgrade, not "unreadable".
    const format2 = packBundle({ "capability.json": bytes(JSON.stringify({ ...manifest, abi: "2.0" })) }, { ...sidecar, format: 2 });
    await assert.rejects(t.platform.stageBundle(USER, format2), (e: any) => /shared from a newer Hewn \(bundle format 2/.test(e.message) && e.details?.refusal === "newer");
  });

  test("a malformed manifest or sidecar is refused with the reason before anything is kept", async () => {
    const sidecar: Sidecar = { format: 1, hewn: "test", abi: "2.0", exportedAt: "2026-10-26T00:00:00Z", tool: { id: "odd", version: 1, hash: "c".repeat(64) } };
    const op = { name: "get", description: "x", version: 1, sideEffect: "read", inputSchema: { type: "object" }, outputSchema: { type: "object" } };
    const manifest = { id: "odd", name: "Odd Tool", purpose: "x", abi: "2.0", operations: [op] };
    const noOps = packBundle({ "capability.json": bytes(JSON.stringify({ ...manifest, operations: undefined })) }, sidecar);
    await assert.rejects(t.platform.stageBundle(USER, noOps), (e: any) => /capability\.json isn't one Hewn can install: manifest .*operations/.test(e.message) && e.details?.refusal === "unreadable");
    for (const tool of [{ id: 7, version: 1, hash: "c".repeat(64) }, { id: "Not An Id", version: 1, hash: "c".repeat(64) }, { id: "odd", version: 0, hash: "c".repeat(64) }]) {
      await assert.rejects(t.platform.stageBundle(USER, packBundle({ "capability.json": bytes(JSON.stringify(manifest)) }, { ...sidecar, tool } as any)), /doesn't say which tool and version it is/);
    }
    assert.ok(!existsSync(join(t.home.root, "blobs", "bundles")), "no file kept of what was refused");
  });

  test("a builder's hub or minVersion on a tool it calls is removed at promote (Hewn writes them)", async () => {
    await installFrom(t.platform, resolve(FIX, "run-feeder"));
    const b = await t.build(
      () => t.platform.modify(USER, { capabilityId: "run-feeder", request: "pin running log from the hub" }),
      (ws) => editJson(join(ws, "capability.json"), (m) => Object.assign(m.requires.capabilities[0], { hub: "hewn/running-log", minVersion: 3 })),
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.ok(b.log.some((l) => /removed fields the platform writes/.test(l)), b.log.join("\n"));
    assert.deepEqual(t.platform.activeManifest("run-feeder").requires!.capabilities, [{ id: "running-log", operations: ["record_run@1", "list_runs@1"] }]);
    assert.equal(t.platform.activeManifest("run-feeder").abi, "2.0", "and the ABI isn't raised for them");
  });

  test("Start over: a backup is kept, the data is empty, the sample data comes back on request", async () => {
    await withSample();
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 3, durationSeconds: 900 } });
    await assert.rejects(t.platform.startOver(USER, "running-log", { confirm: "nope" }), /type the id/);
    await assert.rejects(t.platform.startOver(t.claude, "running-log", { confirm: "running-log" }), /cannot perform owner actions/);
    const r = await t.platform.startOver(USER, "running-log", { confirm: "running-log" });
    assert.match(r.backup!, /^backup:start-over-\d+$/);
    assert.ok((await t.platform.runtime.listStates("running-log", "backup:start-over-")).length === 1);
    assert.equal(await runs(t), 0);
    const again = await t.platform.startOver(USER, "running-log", { confirm: "running-log", sample: true });
    assert.deepEqual(again.sample, { calls: 3, of: 3 });
    assert.equal(await runs(t), 3);
    assert.ok(t.platform.registry.lifecycleEvents().some((e) => e.action === "start-over"));
  });

  test("sample data that doesn't replay fails the version, and says which call", async () => {
    const bad = JSON.stringify([{ operation: "record_run", input: { distanceKm: 5, durationSeconds: 100 } }, { operation: "record_run", input: { distanceKm: -1, durationSeconds: 1 } }]);
    const done = await t.platform.settle((await t.platform.setSample(USER, "running-log", bad)).buildId);
    assert.equal(done.status, "failed");
    assert.ok(done.log.some((l) => /sample\/calls\.json doesn't replay/.test(l) && /call 2 \(record_run\)/.test(l)), done.log.join("\n"));
    await assert.rejects(t.platform.setSample(USER, "running-log", "[{ nope"), /not valid JSON/);
    await assert.rejects(t.platform.setSample(USER, "running-log", "[]"), /sample\/calls\.json/);
  });
});

describe("code from outside stays outside", () => {
  let t: ReturnType<typeof setup>;
  let outside: string;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
    // A file of the machine's that isn't the tool's: what Hewn's settings or a key would be.
    outside = mkdtempSync(join(tmpdir(), "hewn-outside-"));
    writeFileSync(join(outside, "conf.json"), JSON.stringify({ adminToken: "not-for-tools" }));
    writeFileSync(join(outside, "key.txt"), "-----BEGIN PRIVATE KEY-----");
  });
  afterEach(() => (t.cleanup(), rmSync(outside, { recursive: true, force: true })));

  const importing = (line: string) => (ws: string) => writeFileSync(join(ws, "src/index.ts"), `${line}\nexport const operations = { leak: () => ({ x }) };\n`);

  test("a tool importing a file outside its own (an absolute path, or ../ out of it) fails validation, saying so", async () => {
    for (const line of [`import x from ${JSON.stringify(join(outside, "conf.json"))};`, `import x from "${"../".repeat(12)}${outside.slice(1)}/conf.json";`]) {
      const b = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "read a file" }), importing(line));
      assert.equal(b.status, "failed");
      assert.ok(b.log.some((l) => /bundling failed: .*is outside the tool's files/.test(l)), b.log.join("\n"));
    }
  });

  test("an import attribute other than json is refused, wherever the file is", async () => {
    const b = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "read a key" }), importing(`import x from ${JSON.stringify(join(outside, "key.txt"))} with { type: "text" };`));
    assert.equal(b.status, "failed");
    assert.ok(b.log.some((l) => /bundling failed: .*with \{ type: "text" \}: a tool may import JSON/.test(l)), b.log.join("\n"));
  });

  test("dependencies: registry versions and ranges pass; paths, links, git, URLs and GitHub shorthand don't", () => {
    for (const ok of ["1.2.3", "^1.2.0", "~1.2", ">=1 <2", "1.x", "*", "", "latest", "npm:other@^1", "npm:@scope/other@2.0.0"]) assert.ok(registrySpec(ok), ok);
    for (const no of ["file:../x", "link:/etc", "git+ssh://git@github.com/a/b.git", "github:a/b", "a/b", "https://example.com/x.tgz", "../x", ".", "~/x", "/abs", "x.tgz", "npm:other@file:../x", "workspace:*"]) assert.ok(!registrySpec(no), no);
    const pkg = (p: object) => ({ "package.json": bytes(JSON.stringify(p)) });
    assert.deepEqual(dependencyProblems(pkg({ dependencies: { zod: "^3.0.0" }, devDependencies: { typescript: "5.x" } })), []);
    assert.equal(dependencyProblems(pkg({ optionalDependencies: { x: "git+ssh://git@github.com/a/b.git" } })).length, 1);
    assert.equal(dependencyProblems(pkg({ overrides: { a: { b: "file:../b" } } })).length, 1);
    assert.equal(dependencyProblems(pkg({ workspaces: ["../../elsewhere"] })).length, 1);
    const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1.0.0", resolved: "git+ssh://git@github.com/a/a.git#abc" }, "node_modules/b": { link: true, resolved: "../../b" }, "node_modules/c": { version: "1.0.0", resolved: "https://registry.npmjs.org/c/-/c-1.0.0.tgz" } } };
    assert.equal(dependencyProblems({ "package-lock.json": bytes(JSON.stringify(lock)) }).length, 2);
  });

  test("a shared tool with a file: dependency is refused, before and at install", async () => {
    await t.platform.setSample(USER, "running-log", SAMPLE).then((b) => t.platform.settle(b.buildId));
    const { files, sidecar } = unpackBundle((await t.platform.shareBundle(USER, "running-log")).bundle);
    const withDep = { ...files, "package.json": bytes(JSON.stringify({ dependencies: { secrets: "file:/etc" } })) };
    await assert.rejects(t.platform.stageBundle(USER, packBundle(withDep, sidecar)), (e: any) => /isn't on the npm registry.*secrets is "file:\/etc"/.test(e.message) && e.details?.refusal === "dependencies");
    // Installed with no builder from given files, the same rule holds in validation.
    const manifest = { ...JSON.parse(text(files["capability.json"])), id: "dep-tool", name: "Dep Tool" };
    const b = await t.platform.settle((await t.platform.install(USER, { name: "Dep Tool", purpose: "x", builder: "bundle", id: "dep-tool", seed: { ...withDep, "capability.json": bytes(JSON.stringify(manifest)) } })).buildId);
    assert.equal(b.status, "failed");
    assert.ok(b.log.some((l) => /aren't all from the npm registry/.test(l) && /secrets is "file:\/etc"/.test(l)), b.log.join("\n"));
  });
});
