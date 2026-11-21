// SPDX-License-Identifier: AGPL-3.0-or-later
// A license on a shared tool (ABI 2.7): chosen on Share…, remembered per tool, written into the bundle when it's packed.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { packBundle, unpackBundle } from "@hewntools/core/bundle.ts";
import { bytes, text } from "@hewntools/core/files.ts";
import { KEPT_LICENSE, LICENSE_CHOICES, licenseFile } from "@hewntools/core/licenses.ts";
import { ABI_FEATURES, validateManifest } from "@hewntools/core/manifest.ts";
import { installFrom, SEED, setup } from "./helpers.ts";

const SAMPLE = JSON.stringify([{ operation: "record_run", input: { distanceKm: 5.2, durationSeconds: 1700, date: "2026-10-01" } }]);
const year = new Date().getUTCFullYear();
const manifestOf = (bundle: Uint8Array) => JSON.parse(text(unpackBundle(bundle).files["capability.json"]));
const licenseOf = (bundle: Uint8Array) => {
  const f = unpackBundle(bundle).files.LICENSE;
  return f ? text(f) : undefined;
};

describe("a license on a shared tool", () => {
  let t: ReturnType<typeof setup>;
  let other: ReturnType<typeof setup> | undefined;
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
    const b = await t.platform.settle((await t.platform.setSample(USER, "running-log", SAMPLE)).buildId);
    assert.equal(b.status, "promoted", b.log.join("\n"));
  });
  afterEach(() => (t.cleanup(), other?.cleanup(), (other = undefined)));

  test("a tool built here goes as MIT by default: the manifest's license (ABI 2.7) and a LICENSE file with the default copyright line", async () => {
    const check = await t.platform.shareCheck(USER, "running-log");
    assert.equal(check.license.id, "MIT");
    assert.equal(check.license.why, "built-here");
    assert.deepEqual(check.license.choices.map((c) => c.id), ["MIT", "Apache-2.0", "GPL-3.0-or-later", "CC0-1.0", "none"]);
    assert.ok(check.license.choices.every((c) => c.line.length > 20), "each with a line in plain words");
    assert.equal(check.license.copyright, `Copyright (c) ${year} the Running Log authors`);
    const versions = t.platform.registry.versions("running-log").length;
    const { bundle } = await t.platform.shareBundle(USER, "running-log");
    const m = manifestOf(bundle);
    assert.equal(m.license, "MIT");
    assert.equal(m.abi, "2.7", "the field needs ABI 2.7");
    const file = licenseOf(bundle)!;
    assert.match(file, /^MIT License\n\nCopyright \(c\) \d{4} the Running Log authors\n\nPermission is hereby granted/);
    assert.equal(t.platform.registry.versions("running-log").length, versions, "choosing a license never makes a version");
    assert.ok(t.platform.registry.lifecycleEvents().some((e) => e.action === "share" && /as a file, MIT$/.test(e.detail)));
    // On another Hewn: the install sheet shows it, the tool keeps it, and its next share offers it.
    other = setup();
    const preview = await other.platform.stageBundle(USER, bundle);
    assert.equal(preview.license, "MIT");
    const done = await other.platform.settle((await other.platform.installBundle(USER, preview.token, { name: "Running Log", sample: true })).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(other.platform.activeManifest("running-log").license, "MIT");
    const again = await other.platform.shareCheck(USER, "running-log");
    assert.deepEqual([again.license.id, again.license.why], ["MIT", "manifest"]);
  });

  test("all rights reserved writes neither the field nor a LICENSE file; the choice and the name are remembered, and a tool from elsewhere without one starts there", async () => {
    // Apache with the owner's own name, then all rights reserved.
    let l = t.platform.setShareLicense(USER, "running-log", { license: "Apache-2.0", holder: "  Ada Lovelace " });
    assert.deepEqual([l.id, l.why, l.holder, l.copyright], ["Apache-2.0", "chosen", "Ada Lovelace", `Copyright (c) ${year} Ada Lovelace`]);
    let bundle = (await t.platform.shareBundle(USER, "running-log")).bundle;
    assert.equal(manifestOf(bundle).license, "Apache-2.0");
    assert.match(licenseOf(bundle)!, /^Copyright \(c\) \d{4} Ada Lovelace\n\n {33}Apache License\n/);
    l = t.platform.setShareLicense(USER, "running-log", { license: "none", holder: "" });
    assert.deepEqual([l.id, l.holder], ["none", null]);
    bundle = (await t.platform.shareBundle(USER, "running-log")).bundle;
    assert.equal(manifestOf(bundle).license, undefined);
    assert.equal(licenseOf(bundle), undefined);
    assert.equal((await t.platform.shareCheck(USER, "running-log")).license.id, "none", "remembered: the sheet doesn't offer MIT again");
    assert.throws(() => t.platform.setShareLicense(USER, "running-log", { license: "WTFPL" }), /license must be one of MIT, Apache-2.0, GPL-3.0-or-later, CC0-1.0, none/);
    assert.throws(() => t.platform.setShareLicense(USER, "running-log", { holder: "two\nlines" }), /one line/);
    assert.throws(() => t.platform.setShareLicense(t.claude, "running-log", { license: "MIT" }), /owner/);
    // Shared as all rights reserved, it arrives without a license: another Hewn's sheet starts at all rights reserved, and says why.
    other = setup();
    const preview = await other.platform.stageBundle(USER, bundle);
    assert.equal(preview.license, null);
    await other.platform.settle((await other.platform.installBundle(USER, preview.token, { name: "Running Log", sample: true })).buildId);
    assert.deepEqual(((x) => [x.id, x.why])((await other.platform.shareCheck(USER, "running-log")).license), ["none", "arrived-without"]);
    // A purge forgets the choice.
    t.platform.registry.purgeCapability("running-log");
    assert.equal(t.platform.registry.getKv("share:license:running-log"), undefined);
  });

  test("a choice is no new version: the active version and its hash stay, and the choice outlives a new version; all rights reserved keeps the tool's ABI", async () => {
    const before = t.platform.registry.getCapability("running-log")!.activeVersion!;
    const hash = t.platform.registry.getVersion("running-log", before)!.contentHash;
    t.platform.setShareLicense(USER, "running-log", { license: "none" });
    let bundle = (await t.platform.shareBundle(USER, "running-log")).bundle;
    assert.equal(t.platform.registry.getCapability("running-log")!.activeVersion, before);
    assert.equal(t.platform.registry.getVersion("running-log", before)!.contentHash, hash);
    assert.equal(manifestOf(bundle).abi, "2.0", "no license, no ABI 2.7");
    // A new version (its sample data again): the choice stays.
    const b = await t.platform.settle((await t.platform.setSample(USER, "running-log", SAMPLE)).buildId);
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.deepEqual(((x) => [x.id, x.why])((await t.platform.shareCheck(USER, "running-log")).license), ["none", "chosen"]);
    bundle = (await t.platform.shareBundle(USER, "running-log")).bundle;
    assert.equal(manifestOf(bundle).license, undefined);
  });

  test("someone else's work: the LICENSE it came with travels on, never replaced, and the owner's name never goes on it", async () => {
    t.platform.setShareLicense(USER, "running-log", { license: "MIT" });
    const mit = (await t.platform.shareBundle(USER, "running-log")).bundle;
    const original = licenseOf(mit)!;
    other = setup();
    other.platform.setShareLicense(USER, (await (async () => {
      const p = await other!.platform.stageBundle(USER, mit);
      await other!.platform.settle((await other!.platform.installBundle(USER, p.token, { name: "Running Log", sample: true })).buildId);
      return "running-log";
    })()), { holder: "Ada Lovelace" });
    const check = (await other.platform.shareCheck(USER, "running-log")).license;
    assert.deepEqual([check.id, check.why, check.elsewhere, check.copyright], ["MIT", "manifest", true, `Copyright (c) ${year} the Running Log authors`], "not Ada's");
    // Under the same license: as it came.
    assert.equal(licenseOf((await other.platform.shareBundle(USER, "running-log")).bundle), original);
    // Under another: the new one first, the original after it, as it was.
    other.platform.setShareLicense(USER, "running-log", { license: "Apache-2.0" });
    const apache = licenseOf((await other.platform.shareBundle(USER, "running-log")).bundle)!;
    assert.match(apache, new RegExp(`^Copyright \\(c\\) ${year} the Running Log authors\n\n {33}Apache License\n`));
    assert.ok(apache.endsWith(`${KEPT_LICENSE}\n\n${original}`));
    assert.doesNotMatch(apache, /Ada/);
    // All rights reserved writes nothing, and drops nothing: the notice it came with stays.
    other.platform.setShareLicense(USER, "running-log", { license: "none" });
    const none = (await other.platform.shareBundle(USER, "running-log")).bundle;
    assert.equal(manifestOf(none).license, undefined);
    assert.equal(licenseOf(none), original);
  });

  test("a manifest's other id is offered as it is, and its own LICENSE goes as it came", async () => {
    t.platform.setShareLicense(USER, "running-log", { license: "MIT" });
    const { files, sidecar } = unpackBundle((await t.platform.shareBundle(USER, "running-log")).bundle);
    const m = JSON.parse(text(files["capability.json"]));
    const theirs = "BSD 3-Clause License\n\nCopyright (c) 2025, Grace Hopper\n";
    const bsd = packBundle({ ...files, "capability.json": bytes(JSON.stringify({ ...m, license: "BSD-3-Clause" }, null, 2)), LICENSE: bytes(theirs) }, sidecar);
    other = setup();
    const p = await other.platform.stageBundle(USER, bsd);
    assert.equal(p.license, "BSD-3-Clause");
    await other.platform.settle((await other.platform.installBundle(USER, p.token, { name: "Running Log", sample: true })).buildId);
    const l = (await other.platform.shareCheck(USER, "running-log")).license;
    assert.deepEqual([l.id, l.why], ["BSD-3-Clause", "manifest"]);
    assert.ok(l.choices.some((c) => c.id === "BSD-3-Clause"));
    const shared = (await other.platform.shareBundle(USER, "running-log")).bundle;
    assert.equal(manifestOf(shared).license, "BSD-3-Clause");
    assert.equal(licenseOf(shared), theirs);
  });

  test("one of Hewn's tools without a license in its manifest (installed before it said so) starts at Apache-2.0", async () => {
    t.platform.setShareLicense(USER, "running-log", { license: "none" });
    const bare = (await t.platform.shareBundle(USER, "running-log")).bundle;
    other = setup();
    const p = await other.platform.stageBundle(USER, bare, { from: "hub" });
    await other.platform.settle((await other.platform.installBundle(USER, p.token, { name: "Running Log", sample: true })).buildId);
    const l = (await other.platform.shareCheck(USER, "running-log")).license;
    assert.deepEqual([l.id, l.why, l.elsewhere], ["Apache-2.0", "hewn", true]);
  });

  test("a link serves the bundle under the license chosen for the tool", async () => {
    t.platform.setShareLicense(USER, "running-log", { license: "GPL-3.0-or-later" });
    const { token } = await t.platform.createShareLink(USER, "running-log", {});
    const { bundle } = await t.platform.sharedBundle(token);
    assert.equal(manifestOf(bundle).license, "GPL-3.0-or-later");
    assert.match(licenseOf(bundle)!, /^Copyright \(c\) \d{4} the Running Log authors\n\nThis program is free software: [^\n]*any later version\.\n\n {20}GNU GENERAL PUBLIC LICENSE\n/);
  });
});

describe("the license texts and the field", () => {
  test("each of the four licenses has its text; CC0 its waiver; GPL its or-later notice; all rights reserved none", () => {
    const o = { year: 2026, toolName: "Plant Care" };
    assert.match(licenseFile("MIT", o)!, /Copyright \(c\) 2026 the Plant Care authors/);
    assert.match(licenseFile("MIT", { ...o, holder: "A $& B" })!, /Copyright \(c\) 2026 A \$& B\n/, "a name is written as it is");
    assert.match(licenseFile("GPL-3.0-or-later", o)!, /^Copyright \(c\) 2026 the Plant Care authors\n\nThis program is free software: .*either version 3 of the License, or \(at your option\) any later version\.\n\n {20}GNU GENERAL PUBLIC LICENSE/);
    assert.doesNotMatch(licenseFile("MIT", o)!, /\[year\]|\[fullname\]/);
    assert.match(licenseFile("CC0-1.0", o)!, /^To the extent possible under law, the Plant Care authors have waived all copyright and related or neighboring rights to Plant Care\.\n\nCreative Commons Legal Code/);
    assert.match(licenseFile("CC0-1.0", { ...o, holder: "Ada" })!, /^To the extent possible under law, Ada has waived/);
    assert.match(licenseFile("GPL-3.0-or-later", o)!, /TERMS AND CONDITIONS/);
    assert.equal(licenseFile("none", o), undefined);
    assert.equal(licenseFile("BSD-3-Clause", o), undefined, "an id Hewn has no text for: none written");
    assert.equal(LICENSE_CHOICES.length, 5);
  });

  test("a manifest's license needs ABI 2.7, and is an SPDX id or expression", () => {
    const f = ABI_FEATURES.find((x) => x.name === '"license"')!;
    assert.equal(f.since, "2.7");
    assert.ok(f.used({ license: "MIT" } as never));
    const m = JSON.parse(readFileSync(join(resolve(import.meta.dirname, "fixtures/running-log"), "capability.json"), "utf8"));
    assert.ok(validateManifest({ ...m, abi: "2.6", license: "MIT" }, m.id).some((e) => /"license".*2\.7/.test(e)), "refused below 2.7");
    assert.deepEqual(validateManifest({ ...m, abi: "2.7", license: "(MIT AND BSD-2-Clause) OR GPL-3.0-or-later" }, m.id), []);
    assert.ok(validateManifest({ ...m, abi: "2.7", license: "MIT; rm -rf" }, m.id).length > 0);
  });

  test("Hewn's own tools say Apache-2.0, as seeds/LICENSE does", () => {
    const seeds = resolve(import.meta.dirname, "../seeds");
    assert.match(readFileSync(join(seeds, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
    for (const id of readdirSync(seeds, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      const m = JSON.parse(readFileSync(join(seeds, id, "capability.json"), "utf8"));
      assert.equal(m.license, "Apache-2.0", id);
      assert.equal(m.abi, "2.7", id);
    }
  });
});
