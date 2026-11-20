// SPDX-License-Identifier: AGPL-3.0-or-later
// A license on a shared tool (ABI 2.7): chosen on Share…, remembered per tool, written into the bundle when it's packed.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { unpackBundle } from "@hewntools/core/bundle.ts";
import { text } from "@hewntools/core/files.ts";
import { LICENSE_CHOICES, licenseFile } from "@hewntools/core/licenses.ts";
import { ABI_FEATURES } from "@hewntools/core/manifest.ts";
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

  test("a link serves the bundle under the license chosen for the tool", async () => {
    t.platform.setShareLicense(USER, "running-log", { license: "GPL-3.0-or-later" });
    const { token } = await t.platform.createShareLink(USER, "running-log", {});
    const { bundle } = await t.platform.sharedBundle(token);
    assert.equal(manifestOf(bundle).license, "GPL-3.0-or-later");
    assert.match(licenseOf(bundle)!, /^Copyright \(c\) \d{4} the Running Log authors\n\n {20}GNU GENERAL PUBLIC LICENSE\n/);
  });
});

describe("the license texts and the field", () => {
  test("each of the four licenses has its text; CC0 its waiver; all rights reserved none", () => {
    const o = { year: 2026, toolName: "Plant Care" };
    assert.match(licenseFile("MIT", o)!, /Copyright \(c\) 2026 the Plant Care authors/);
    assert.doesNotMatch(licenseFile("MIT", o)!, /\[year\]|\[fullname\]/);
    assert.match(licenseFile("CC0-1.0", o)!, /^To the extent possible under law, the Plant Care authors have waived all copyright and related or neighboring rights to Plant Care\.\n\nCreative Commons Legal Code/);
    assert.match(licenseFile("CC0-1.0", { ...o, holder: "Ada" })!, /^To the extent possible under law, Ada has waived/);
    assert.match(licenseFile("GPL-3.0-or-later", o)!, /TERMS AND CONDITIONS/);
    assert.equal(licenseFile("none", o), undefined);
    assert.equal(licenseFile("BSD-3-Clause", o), undefined, "an id Hewn has no text for: none written");
    assert.equal(LICENSE_CHOICES.length, 5);
  });

  test("a manifest's license needs ABI 2.7", () => {
    const f = ABI_FEATURES.find((x) => x.name === '"license"')!;
    assert.equal(f.since, "2.7");
    assert.ok(f.used({ license: "MIT" } as never));
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
