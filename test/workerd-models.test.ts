// SPDX-License-Identifier: AGPL-3.0-or-later
// The model port on the real workerd host: ctx.model crosses Durable Object RPC into the isolate.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FIXTURES } from "./helpers.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

describe("model port on the workerd host", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost();
  });
  after(() => h.stop());

  test("validation's fake replies reach the isolate's ctx.model (text, JSON, images, errors)", async () => {
    const r = await h.sv.admin("install", { name: "Word Explainer", purpose: "words", dir: join(FIXTURES, "word-explainer"), wait: true });
    assert.equal(r.status, "promoted", JSON.stringify(r.log));
    const st = (await h.sv.admin("call", { method: "readiness", args: ["word-explainer"] })).result;
    assert.deepEqual(st.pendingGrants, ["model:light"]);
    assert.match(st.missingModel, /no model provider is set up/);
  });

  test("code without requires.model has no ctx.model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-no-model-"));
    try {
      cpSync(join(FIXTURES, "word-explainer"), dir, { recursive: true });
      const m = JSON.parse(readFileSync(join(dir, "capability.json"), "utf8"));
      m.id = "no-model";
      m.name = "No Model";
      delete m.requires;
      writeFileSync(join(dir, "capability.json"), JSON.stringify(m));
      writeFileSync(join(dir, "tests/cases.json"), JSON.stringify([{ name: "no model", operation: "probe", input: {}, expect: { hasModel: false } }]));
      const r = await h.sv.admin("install", { name: "No Model", purpose: "p", dir, wait: true });
      assert.equal(r.status, "promoted", JSON.stringify(r.log));
      assert.deepEqual((await h.invoke("no-model", "probe")).result, { hasModel: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
