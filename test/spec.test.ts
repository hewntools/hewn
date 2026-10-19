// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ABI, ABI_HISTORY } from "@hewntools/spec/abi.ts";
import { CTX_MEMBERS } from "@hewntools/spec/ctx.ts";
import { SCHEMA_FILES } from "@hewntools/spec/schemas.ts";
import { runOperation } from "@hewntools/core/abi.ts";
import { ABI_CTX, ABI_FEATURES, compileSchema, schemaErrors, ABI as HOST_ABI } from "@hewntools/core/manifest.ts";
import { USER } from "@hewntools/core/auth.ts";
import { AGENT_TOOLS, SCOPES } from "@hewntools/spec/agents.ts";
import { toolsFor } from "@hewntools/host-workerd/mcp.ts";
import { setup } from "./helpers.ts";

// The spec (Apache-2.0, spec/) is the contract; the host (AGPL) implements it. These keep them in step.
const ROOT = join(import.meta.dirname, "..");
const SPEC = join(ROOT, "spec");

test("spec/schemas/*.json are generated from spec/src/schemas.ts (npm run spec:schemas)", () => {
  for (const [name, schema] of Object.entries(SCHEMA_FILES)) {
    assert.equal(readFileSync(join(SPEC, "schemas", name), "utf8"), JSON.stringify(schema, null, 2) + "\n", name);
  }
});

test("every seed and fixture tool matches the published schemas", () => {
  const manifest = compileSchema(SCHEMA_FILES["capability.schema.json"]);
  const cases = compileSchema(SCHEMA_FILES["cases.schema.json"]);
  const tools = [join(ROOT, "seeds"), join(ROOT, "test", "fixtures")].flatMap((d) => readdirSync(d).map((t) => join(d, t))).filter((d) => existsSync(join(d, "capability.json")));
  assert.ok(tools.length >= 5);
  for (const dir of tools) {
    assert.ok(manifest(JSON.parse(readFileSync(join(dir, "capability.json"), "utf8"))), `${dir}/capability.json: ${schemaErrors(manifest).join("; ")}`);
    if (existsSync(join(dir, "tests", "cases.json"))) assert.ok(cases(JSON.parse(readFileSync(join(dir, "tests", "cases.json"), "utf8"))), `${dir}/tests/cases.json: ${schemaErrors(cases).join("; ")}`);
  }
});

test("ctx: the spec lists exactly what the host hands an operation", async () => {
  let seen: string[] = [];
  const mod = { operations: { "probe@1": (_: unknown, ctx: object) => void (seen = Object.keys(ctx).sort()) } };
  const db = { exec() {}, prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), all: () => [], get: () => undefined }), transaction: <T>(fn: () => T) => fn() };
  await runOperation(mod, "probe@1", {}, { db, call: async () => null, caller: { kind: "agent", id: "a" }, model: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, cost: 0, model: "x/y" }) });
  assert.deepEqual(seen, CTX_MEMBERS.map((m) => m.name).sort());
  for (const c of ABI_CTX) assert.equal(CTX_MEMBERS.find((m) => m.name === c.name)?.since, c.since, `ctx.${c.name}`);
});

test("versions: the spec, its package and the host agree", () => {
  assert.equal(HOST_ABI, ABI);
  assert.equal(ABI_HISTORY.at(-1)!.version, ABI, "the history ends at the current ABI");
  const versions = new Set(ABI_HISTORY.map((h) => h.version));
  for (const f of ABI_FEATURES) assert.ok(versions.has(f.since), `${f.name} (since ${f.since}) is in the history`);
  for (const m of CTX_MEMBERS) assert.ok(versions.has(m.since), `ctx.${m.name} (since ${m.since}) is in the history`);
  const pkg = JSON.parse(readFileSync(join(SPEC, "package.json"), "utf8")).version as string;
  assert.equal(pkg.split(".").slice(0, 2).join("."), ABI, "@hewntools/spec is versioned by the ABI (major.minor.patch)");
});

test("agents: the MCP server offers exactly the spec's tools, with its scopes and input schemas", () => {
  const t = setup();
  try {
    const offered = toolsFor(t.platform, USER);
    assert.deepEqual(offered.map((x) => x.name), AGENT_TOOLS.map((x) => x.name));
    for (const spec of AGENT_TOOLS) {
      const tool = offered.find((x) => x.name === spec.name)!;
      assert.deepEqual(tool.scopes, spec.scopes, spec.name);
      assert.deepEqual(tool.inputSchema, spec.inputSchema, spec.name);
      assert.ok(tool.description.startsWith(spec.description), `${spec.name}: the description is the spec's (plus the catalog)`);
      for (const s of spec.scopes) assert.ok((SCOPES as readonly string[]).includes(s));
    }
  } finally {
    t.cleanup();
  }
});
