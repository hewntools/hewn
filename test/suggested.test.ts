// SPDX-License-Identifier: AGPL-3.0-or-later
// A suggested value on a config entry (ABI 2.6, hewn #66): the setup form is prefilled with it and the owner confirms;
// Hewn never fills a setting in by itself.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { type CapabilityManifest, validateManifest } from "@hewntools/core/manifest.ts";
import { editJson, FIXTURES, installFrom, setup } from "./helpers.ts";

const op = { name: "get", description: "d", version: 1, inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read" };
const manifest = (extra: Record<string, unknown> = {}): CapabilityManifest => ({ id: "x", name: "X", purpose: "p", abi: "2.6", operations: [op], ...extra }) as CapabilityManifest;
const repo = { name: "REPO", description: "The repository to review, owner/name", suggested: "hewntools/hewn" };

describe("a suggested value on a config entry", () => {
  test("validates at ABI 2.6; refused at 2.5, naming the feature", () => {
    assert.deepEqual(validateManifest(manifest({ config: [repo] }), "x"), []);
    assert.deepEqual(validateManifest(manifest({ abi: "2.5", config: [repo] }), "x"), ['"suggested" in config needs ABI 2.6, but the manifest declares 2.5: set "abi": "2.6"']);
    assert.deepEqual(validateManifest(manifest({ abi: "2.5", config: [{ name: "REPO", description: "r" }] }), "x"), [], "config without it stays 2.1");
  });

  test('"default" is refused, and the message names "suggested"', () => {
    assert.deepEqual(validateManifest(manifest({ config: [{ name: "REPO", description: "r", default: "hewntools/hewn" }] }), "x"), ['manifest /config/0 unexpected property "default": use "suggested" (prefilled in the setup form; the owner confirms it)']);
  });

  test("a secret can't carry one", () => {
    const errors = validateManifest(manifest({ kind: "connection", operations: [{ ...op, name: "health", outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["connected", "expired", "broken"] } } } }], requires: { secrets: [{ name: "API_TOKEN", description: "t", suggested: "x" }] } }), "x");
    assert.deepEqual(errors, ['requires.secrets API_TOKEN: a secret can\'t carry "suggested" (only a config entry can)']);
  });
});

describe("the setup form's suggested value", () => {
  let t: ReturnType<typeof setup>;
  let dir: string;
  beforeEach(async () => {
    t = setup();
    dir = mkdtempSync(join(tmpdir(), "hewn-suggested-"));
    cpSync(join(FIXTURES, "ui-counter"), dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => Object.assign(m, { abi: "2.6", config: [repo, { name: "REVIEWER", description: "Who reviews" }] }));
    await installFrom(t.platform, dir);
  });
  afterEach(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the form gets it; nothing is stored, so the tool stays not ready and a call names what's missing, until the owner saves", async () => {
    const auth = t.platform.authorization("ui-counter");
    assert.deepEqual(auth.config, [
      { name: "REPO", description: repo.description, value: null, suggested: "hewntools/hewn" },
      { name: "REVIEWER", description: "Who reviews", value: null },
    ]);
    assert.deepEqual(t.platform.readiness("ui-counter").missingConfig, ["REPO", "REVIEWER"]);
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "ui-counter", operation: "get" }), (e: any) => e.code === "not_ready" && e.details.missingConfig.includes("REPO"));
    t.platform.setConfig(USER, "ui-counter", "REPO", "hewntools/hewn");
    t.platform.setConfig(USER, "ui-counter", "REVIEWER", "Ada");
    assert.equal(t.platform.readiness("ui-counter").ready, true);
  });
});
