// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { MAX_BUNDLE_BYTES, packBundle, readZip, scanFiles, type Sidecar, unpackBundle, writeZip } from "@hewntools/core/bundle.ts";
import { bytes, text } from "@hewntools/core/files.ts";
import { createZip } from "@hewntools/cli/zip.ts";
import { editJson, installFrom, SEED, setup } from "./helpers.ts";

const SAMPLE = JSON.stringify([
  { operation: "record_run", input: { distanceKm: 5.2, durationSeconds: 1700, date: "2026-10-01", notes: "Easy loop by the river" } },
  { operation: "record_run", version: 1, input: { distanceKm: 10, durationSeconds: 3300, date: "2026-10-04" } },
  { operation: "record_run", input: { distanceKm: 7.5, durationSeconds: 2550, date: "2026-10-08" } },
]);

const runs = async (t: ReturnType<typeof setup>, id = "running-log") => ((await t.platform.invoke(USER, { capabilityId: id, operation: "list_runs", input: {} })).result as { runs: unknown[] }).runs.length;

describe("bundles: the zip and the scan", () => {
  test("a store-only zip round-trips; a deflated entry (another tool's zip) is refused with the reason", () => {
    const files = { "capability.json": bytes("{}"), "src/index.ts": bytes("export const operations = {};\n") };
    assert.deepEqual(Object.keys(readZip(writeZip(files))).sort(), ["capability.json", "src/index.ts"]);
    assert.equal(text(readZip(writeZip(files))["src/index.ts"]), "export const operations = {};\n");
    const deflated = createZip([{ path: "capability.json", data: Buffer.from("x".repeat(500)) }]);
    assert.throws(() => readZip(deflated), /compressed\. Hewn reads bundles that Hewn made/);
    assert.throws(() => readZip(bytes("not a zip at all")), /isn't a zip file/);
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
  // Running Log as a tool from before builders wrote sample data: the seed without sample/.
  let seed: string;
  before(() => {
    seed = mkdtempSync(join(tmpdir(), "hewn-seed-"));
    cpSync(SEED, seed, { recursive: true });
    rmSync(join(seed, "sample"), { recursive: true });
  });
  after(() => rmSync(seed, { recursive: true, force: true }));
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, seed);
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

  test("install refuses a tool that needs a newer Hewn, with the reason", async () => {
    const sidecar: Sidecar = { format: 1, hewn: "9.9.9", abi: "2.9", exportedAt: "2026-10-26T00:00:00Z", tool: { id: "future", version: 1, hash: "c".repeat(64) } };
    const manifest = { id: "future", name: "Future Tool", purpose: "x", abi: "2.9", operations: [] };
    const zip = packBundle({ "capability.json": bytes(JSON.stringify(manifest)) }, sidecar);
    await assert.rejects(t.platform.stageBundle(USER, zip), (e: any) => /Future Tool needs Hewn ABI 2\.9; this Hewn has 2\.5\. Upgrade Hewn/.test(e.message) && e.details?.refusal === "newer");
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
