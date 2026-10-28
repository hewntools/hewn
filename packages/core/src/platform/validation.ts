// SPDX-License-Identifier: AGPL-3.0-or-later
// Validation: a build's candidate checked step by step (manifest, bundle, contracts, migrations,
// tests, the UI and widgets, an upgrade dry run), frozen, and promoted, or held for the owner's review.
import { USER, WEB_USER } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { dependencyProblems, readSample, SAMPLE_FILE } from "../bundle.ts";
import { bytes, contentHash, encodeVersion, text, versionFiles } from "../files.ts";
import { abiAtLeast, type CapabilityManifest, contractBreaks, isConnection, type OperationManifest, opKey, stampSource, type ToolSource, validateManifest } from "../manifest.ts";
import { viewErrors, widgetsBuildProblems } from "../widgets.ts";
import { inspectRequest, type ModelHandler, structured } from "../models.ts";
import { migrationProblems, migrationsOf } from "../migrations.ts";
import type { CallHandler, CodeRef, ExecutionTarget, Files, StateRef } from "../ports.ts";
import type { BuildReview, BuildRow, GrantKind } from "../registry.ts";
import type { SampleCall, TestCase } from "@hewntools/spec/cases.ts";
import { wantedGrants } from "./grants.ts";
import { Domain } from "./context.ts";

export class Validation extends Domain {
  async validateAndPromote(build: BuildRow, step: (message: string) => void, onTests: (passed: number, total: number) => void = () => {}): Promise<{ version: number } | { review: BuildReview }> {
    const id = build.capabilityId;
    const fail = (msg: string, problems: string[] = []): never => {
      throw new Error(problems.length ? `${msg}:\n  - ${problems.join("\n  - ")}` : msg);
    };
    const workspace = await this.workbench.read(build.id);

    // 1. manifest
    if (!workspace["capability.json"]) fail("capability.json missing");
    let manifest: CapabilityManifest;
    try {
      manifest = JSON.parse(text(workspace["capability.json"]));
    } catch (e) {
      return fail(`capability.json is not valid JSON: ${(e as Error).message}`);
    }
    // The platform's own fields come from its record (or, installing from a file, the install's), never the builder.
    const source = this.registry.getCapability(id)?.source ?? installedFrom(build) ?? null;
    const stamped = stampSource(manifest, source);
    if (JSON.stringify(stamped) !== JSON.stringify(manifest)) {
      manifest = stamped;
      workspace["capability.json"] = bytes(JSON.stringify(manifest, null, 2) + "\n");
      step(source ? `source kept: ${source.id} v${source.version}, from ${source.from === "hub" ? "Hub" : `a ${source.from}`}` : "removed fields the platform writes (source, hub, minVersion)");
    }
    const manifestErrors = validateManifest(manifest, id);
    if (manifest?.ui?.available && !workspace["ui/index.html"]) manifestErrors.push("ui.available but ui/index.html is missing");
    if (manifestErrors.length) fail("manifest invalid", manifestErrors);
    step("manifest valid");

    // 2. bundle (src/index.ts + npm dependencies), then: it exports exactly what the manifest declares
    const files = versionFiles(workspace);
    // Installed from a file: npm installs from the registry only (no paths, links, git or URLs).
    if (build.builder === "bundle") {
      const problems = dependencyProblems(files);
      if (problems.length) fail("its dependencies aren't all from the npm registry", problems);
    }
    let bundled: { js: string; log: string[] };
    try {
      bundled = await this.workbench.bundle(build.id);
    } catch (e) {
      return fail(`bundling failed: ${(e as Error).message}`);
    }
    for (const line of bundled.log) step(line);
    const code: CodeRef = { hash: contentHash(files, bundled.js), js: bundled.js };
    let exportedKeys: string[];
    try {
      exportedKeys = await this.runtime.describe(code);
    } catch (e) {
      return fail(`implementation failed to load: ${(e as Error).message}`);
    }
    const exported = new Set(exportedKeys);
    const missing = manifest.operations.map((o) => opKey(o.name, o.version)).filter((k) => !exported.has(k));
    if (missing.length) fail("implementation does not export declared operations", missing);
    step(`implementation exports ${[...exported].join(", ")}`);

    // 3. contract compatibility with the active version
    const base = build.baseVersion ? await this.loadVersion(id, build.baseVersion) : undefined;
    if (base) {
      const breaks = contractBreaks(base.row.manifest, manifest, (key) => this.d.grants.operationUsers(id, key));
      if (breaks.length) fail("breaking change to a published operation contract (add a new operation version instead)", breaks);
      const removed = base.row.manifest.operations.map((o) => opKey(o.name, o.version)).filter((k) => !manifest.operations.some((o) => opKey(o.name, o.version) === k));
      step(`operation contracts compatible with active version${removed.length ? ` (removed deprecated ${removed.join(", ")})` : ""}`);
    }
    // 3a. a widgets build changes widgets only: the capability's own contract, data and UI stay as they are
    if (build.kind === "widgets") {
      if (!base) fail("a widgets build needs an active version to add widgets to");
      const problems = widgetsBuildProblems({ manifest: base!.row.manifest, files: base!.files }, { manifest, files });
      if (problems.length) fail("a widgets build changed more than widgets", problems);
      step(`widgets only: ${manifest.widgets!.map((w) => w.name).join(", ")}`);
    }

    // 3b. declared callees exist and offer the pinned operation versions
    const deps = (manifest.requires?.capabilities ?? []).flatMap((d) => d.operations.map((op) => ({ id: d.id, op })));
    const badDeps = deps.filter((d) => d.id === id || !this.d.grants.offers(d.id, d.op)).map((d) => (d.id === id ? `${d.id}: a capability cannot call itself` : `${d.id}/${d.op} does not exist`));
    if (badDeps.length) fail("requires.capabilities references unavailable operations", badDeps);
    if (deps.length) step(`calls ${deps.map((d) => `${d.id}/${d.op}`).join(", ")}`);

    // 4. migrations are append-only and non-destructive
    const migrations = migrationsOf(files);
    const migrationErrors = migrationProblems(migrations, base ? migrationsOf(base.files) : []);
    if (migrationErrors.length) fail("migrations rejected", migrationErrors);

    // 5. candidate test cases against fresh state
    const testState: StateRef = { capabilityId: id, scratch: `test:${build.id}` };
    const visualState: StateRef = { capabilityId: id, scratch: `visual:${build.id}` };
    const dryRun: StateRef = { capabilityId: id, scratch: `dryrun:${build.id}` };
    const sampleState: StateRef = { capabilityId: id, scratch: `sample:${build.id}` };
    // Each operation's first passing result in the tests: the widget sheet draws these, and a review shows them.
    const views = new Map<string, unknown>();
    try {
      await this.runtime.dropState(testState);
      await this.runtime.migrate(testState, migrations, code);
      const cases = readCases(workspace);
      if (!cases.length) fail("tests/cases.json must contain at least one case");
      const untested = (manifest.widgets ?? []).filter((w) => !cases.some((c) => !c.expectError && `${c.operation}@${c.version ?? manifest.operations.filter((o) => o.name === c.operation).reduce((n, o) => Math.max(n, o.version), 0)}` === w.operation));
      if (untested.length) fail("every widget needs a test case for its operation (the case's output must match a template)", untested.map((w) => `${w.name}: no case calls ${w.operation}`));
      // Run every case (not just up to the first failure) so the owner and the builder see the whole picture.
      const failed: string[] = [];
      onTests(0, cases.length);
      for (const [i, c] of cases.entries()) {
        try {
          const result = await this.runCase(manifest, { capabilityId: id, code, state: testState, secrets: c.secrets, config: c.config }, c);
          const op = manifest.operations.filter((o) => o.name === c.operation && (c.version === undefined || o.version === c.version)).sort((a, b) => b.version - a.version)[0];
          if (op && !c.expectError && !views.has(opKey(op.name, op.version))) views.set(opKey(op.name, op.version), result);
        } catch (e) {
          failed.push((e as Error).message);
        }
        onTests(i + 1 - failed.length, cases.length);
      }
      if (failed.length) fail(`${failed.length} of ${cases.length} test cases failed`, failed);
      step(`${cases.length} test cases passed`);

      // 5a. sample data replays on a fresh state, as installing (or starting over) with it does
      let sample;
      try {
        sample = readSample(files);
      } catch (e) {
        fail((e as Error).message);
      }
      if (sample) {
        await this.runtime.dropState(sampleState);
        await this.runtime.migrate(sampleState, migrations, code);
        for (const [i, c] of sample.entries()) {
          try {
            await this.replayCall(manifest, { capabilityId: id, code, state: sampleState, secrets: {}, config: {}, caller: { kind: "test", id: "sample" } }, c);
          } catch (e) {
            fail(`${SAMPLE_FILE} doesn't replay`, [`call ${i + 1} (${c.operation}): ${(e as Error).message}`, "sample calls run before anything is granted: plain writes only, no network, other tools or model"]);
          }
        }
        step(`sample data replays (${sample.length} calls)`);
      }

      // 5b. the UI renders without errors (on fresh, empty state), with a screenshot for the owner
      let shot = false;
      if (manifest.ui?.available && this.workbench.visualCheck && build.kind !== "widgets") {
        await this.runtime.dropState(visualState);
        await this.runtime.migrate(visualState, migrations, code);
        const secrets = cases.find((c) => c.secrets)?.secrets ?? Object.fromEntries((manifest.requires?.secrets ?? []).map((x) => [x.name, "visual-check"]));
        const config = cases.find((c) => c.config)?.config ?? Object.fromEntries((manifest.config ?? []).map((x) => [x.name, "visual-check"]));
        const v = await this.workbench.visualCheck(build.id, {
          manifest: { ...manifest, status: { ready: true, missingSecrets: [], missingConfig: [], pendingGrants: [], missingDependencies: [] } },
          invoke: async (body) => {
            const { result } = await this.d.invocation.execute(
              manifest,
              { capabilityId: id, code, state: visualState, secrets, config, caller: { kind: "test", id: "visual-check" } },
              { capabilityId: id, operation: body.operation, operationVersion: body.operationVersion, input: body.input },
              async (call) => {
                throw new PlatformError("operation_failed", `calls to ${call.capabilityId} aren't available in the visual check`);
              },
              manifest.requires?.model && abiAtLeast(manifest, "2.2")
                ? async () => {
                    throw new PlatformError("operation_failed", "model calls aren't available in the visual check");
                  }
                : undefined,
            );
            return { result };
          },
        });
        if (v.skipped) step(`visual check skipped: ${v.skipped}`);
        else {
          if (v.screenshot) await this.blobs.put(`screenshots/${build.id}.png`, v.screenshot);
          if (v.screenshotDark) await this.blobs.put(`screenshots/${build.id}-dark.png`, v.screenshotDark);
          if (v.errors.length) fail("UI didn't render cleanly", v.errors);
          step("UI renders without errors (screenshot attached)");
          shot = true;
        }
      }

      // 5c. changed widgets, drawn in every size they offer (the screenshot, unless the UI's was taken)
      const widgetsChanged = !!manifest.widgets?.length && (build.kind === "widgets" || JSON.stringify(manifest.widgets) !== JSON.stringify(base?.row.manifest.widgets));
      if (widgetsChanged && !shot && this.workbench.visualCheck && abiAtLeast(manifest, "2.3")) {
        const widgets = manifest.widgets!.map((w) => ({ name: w.name, title: w.title, sizes: w.sizes, view: views.get(w.operation) ?? null }));
        const v = await this.workbench.visualCheck(build.id, { manifest, widgets, invoke: async () => ({ result: null }) });
        if (v.skipped) step(`widget check skipped: ${v.skipped}`);
        else {
          if (v.screenshot) await this.blobs.put(`screenshots/${build.id}.png`, v.screenshot);
          if (v.screenshotDark) await this.blobs.put(`screenshots/${build.id}-dark.png`, v.screenshotDark);
          if (v.errors.length) fail("widgets didn't render cleanly", v.errors);
          step(`widgets render in every size (screenshot attached)`);
        }
      }

      // 6. dry-run migrations against a copy of real state
      if (await this.runtime.hasState({ capabilityId: id })) {
        await this.runtime.copyState({ capabilityId: id }, dryRun);
        const applied = await this.runtime.migrate(dryRun, migrations, code);
        step(`upgrade dry-run ok (${applied.length ? applied.join(", ") : "no new migrations"})`);
      }
    } finally {
      for (const s of [testState, visualState, dryRun, sampleState]) await this.runtime.dropState(s).catch(() => {});
    }

    // 7. freeze; an agent's change that adds operations or changes a connection waits for the owner
    await this.blobs.put(`versions/${code.hash}.json`, encodeVersion(code.hash, files, code.js));
    this.loaded.set(code.hash, { files, bundle: code.js });
    // A follow-up chained to the creation of the same capability (create with widgets) is part of that creation.
    const dep = build.dependsOn ? this.registry.getBuild(build.dependsOn) : undefined;
    const partOfCreate = dep?.kind === "create" && dep.capabilityId === id;
    const review = partOfCreate || !base ? undefined : reviewFor(build, { manifest: base.row.manifest, files: base.files }, { manifest, files }, code.hash, views);
    if (review) {
      await this.workbench.remove(build.id);
      return { review };
    }
    return { version: await this.promoteVersion(build, manifest, files, code, step) };
  }

  /** 8. promote a frozen candidate: back up live state, migrate it, make the version active. */
  async promoteVersion(build: BuildRow, manifest: CapabilityManifest, files: Files, code: CodeRef, step: (message: string) => void): Promise<number> {
    const id = build.capabilityId;
    const migrations = migrationsOf(files);
    const next = this.registry.latestVersionNumber(id) + 1;
    const live: StateRef = { capabilityId: id };
    if (await this.runtime.hasState(live)) {
      await this.runtime.copyState(live, { capabilityId: id, scratch: `backup:before-v${next}-${Date.now()}` });
      // Per-promotion backups are a safety net for this step; nightly backups are the archive. Keep 3.
      const backups = (await this.runtime.listStates(id, "backup:before-v")).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
      for (const old of backups.slice(3)) await this.runtime.dropState({ capabilityId: id, scratch: old });
      step(`state backed up`);
    }
    const applied = await this.runtime.migrate(live, migrations, code);
    if (applied.length) step(`migrations applied: ${applied.join(", ")}`);

    const before = this.registry.getCapability(id)?.activeVersion ?? null;
    const installed = installedFrom(build);
    this.registry.transaction(() => {
      this.registry.insertVersion({ capabilityId: id, version: next, manifest, contentHash: code.hash, buildId: build.id });
      this.registry.promote({ id, name: manifest.name, purpose: manifest.purpose, version: next });
      // Installed from a file: where it came from becomes the record every later version is stamped from.
      if (installed && !this.registry.getCapability(id)?.source) this.registry.setSource(id, installed);
    });
    // Grants this version no longer asks for go: asking again later means asking the owner again.
    const wanted = new Set(wantedGrants(manifest));
    for (const g of this.registry.grants(id)) {
      if (wanted.has(g)) continue;
      const [kind, ...rest] = g.split(":");
      this.registry.revokeGrant(id, kind as GrantKind, rest.join(":"));
      this.registry.addGrantEvent(id, "revoke", g, "platform");
      step(`grant ${g} dropped: v${next} doesn't ask for it`);
    }
    // A quick change (the manifest only, no builder: another tier, a widget removed) isn't a new
    // ask: what the owner said no to stays said no to, for what this version still asks for.
    if (build.kind === "modify" && build.request.manifestOnly && before) this.registry.carryDeclines(id, before, next, wanted);
    await this.workbench.remove(build.id).catch(() => {});
    return next;
  }

  /**
   * One sample call (sample/calls.json), through the contract, with nothing granted: the target
   * has no hosts (no network), and other tools and the model refuse. Validation and installs both
   * replay sample data this way.
   */
  async replayCall(manifest: CapabilityManifest, target: ExecutionTarget, c: SampleCall) {
    return this.d.invocation.execute(
      manifest,
      target,
      { capabilityId: manifest.id, operation: c.operation, operationVersion: c.version, input: c.input ?? {} },
      async (call) => {
        throw new PlatformError("forbidden", `sample data can't call other tools (${call.capabilityId})`);
      },
      manifest.requires?.model && abiAtLeast(manifest, "2.2")
        ? async () => {
            throw new PlatformError("forbidden", "sample data can't use the model");
          }
        : undefined,
    );
  }

  private async runCase(manifest: CapabilityManifest, target: ExecutionTarget, c: TestCase) {
    const label = `test '${c.name}'`;
    try {
      const declared = manifest.requires?.capabilities ?? [];
      // A widget's operation is tested as it runs: read-only, read calls only, no model, and its output drawable.
      const op = manifest.operations.find((o) => o.name === c.operation && (c.version === undefined || o.version === c.version));
      const widget = op && abiAtLeast(manifest, "2.3") ? (manifest.widgets ?? []).find((w) => w.operation === opKey(op.name, op.version)) : undefined;
      const mock: CallHandler = async (call) => {
        const key = `${call.capabilityId}/${call.operation}`;
        if (!declared.some((d) => d.id === call.capabilityId && d.operations.includes(call.operation))) {
          throw new PlatformError("forbidden", `${manifest.id} did not declare ${key} in requires.capabilities`);
        }
        if (widget && this.registry.getCapability(call.capabilityId)?.activeVersion) {
          const [name, v] = call.operation.split("@");
          const callee = this.activeManifest(call.capabilityId).operations.find((o) => o.name === name && o.version === Number(v));
          if (callee && callee.sideEffect !== "read") throw new PlatformError("forbidden", `widgets are read-only: ${key} is a ${callee.sideEffect} operation`);
        }
        if (!c.calls || !(key in c.calls)) throw new PlatformError("operation_failed", `no mock for ${key} in test case '${c.name}' ("calls")`);
        return c.calls[key];
      };
      const replies = [...(c.model ?? [])];
      const requirement = manifest.requires?.model;
      const fakeModel: ModelHandler | undefined =
        requirement && abiAtLeast(manifest, "2.2") && !widget
          ? async (raw) => {
              const r = inspectRequest(raw, requirement.input?.includes("image") ?? false);
              const next = replies.shift();
              if (!next) throw new PlatformError("operation_failed", `no model reply left in test case '${c.name}' ("model": a list of { "text" } or { "json" } replies)`);
              if ("error" in next) throw new PlatformError("operation_failed", next.error);
              const text = next.text ?? JSON.stringify(next.json ?? null);
              const json = r.schema ? structured(text, r.schema) : next.json;
              return { text, ...(json !== undefined ? { json } : {}), usage: { inputTokens: 0, outputTokens: 0 }, cost: 0, model: "test/fake" };
            }
          : undefined;
      const { result } = await this.d.invocation.execute(
        manifest,
        { ...target, caller: { kind: "test", id: "validation" }, ...(widget ? { readOnly: true } : {}) },
        { capabilityId: manifest.id, operation: c.operation, operationVersion: c.version, input: c.input },
        mock,
        fakeModel,
      );
      if (c.expectError) throw new Error(`${label}: expected an error, got ${JSON.stringify(result)}`);
      const problems = widget ? viewErrors(result) : [];
      if (problems.length) throw new Error(`${label}: widget ${widget!.name} returned something no template can draw: ${problems.join("; ")}`);
      if (c.expect !== undefined && !matches(c.expect, result)) {
        throw new Error(`${label}: expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(result)}`);
      }
      return result;
    } catch (e) {
      if (e instanceof PlatformError && c.expectError) return undefined;
      if (e instanceof PlatformError) {
        throw new Error(`${label}: ${e.code}: ${e.message}${e.details ? " " + JSON.stringify(e.details) : ""}`);
      }
      throw e;
    }
  }
}

function readCases(files: Files): TestCase[] {
  const raw = files["tests/cases.json"];
  if (!raw) return [];
  const cases = JSON.parse(text(raw));
  if (!Array.isArray(cases)) throw new Error("tests/cases.json must be an array");
  return cases;
}

/** Subset match: every key in `expected` must match in `actual`; "$any" matches any present value. */
export function matches(expected: unknown, actual: unknown): boolean {
  if (expected === "$any") return actual !== undefined;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(e, actual[i]));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches(v, (actual as Record<string, unknown>)[k]));
  }
  return expected === actual;
}

/**
 * Whether a candidate waits for the owner: an agent's change (not the owner's, and not a new
 * capability, which has no data yet) to a connection, or one that adds operations. An agent with
 * `modify` otherwise decides what the code does with the capability's data and credentials.
 */
function reviewFor(build: BuildRow, base: { manifest: CapabilityManifest; files: Files }, candidate: { manifest: CapabilityManifest; files: Files }, contentHash: string, views: Map<string, unknown>): BuildReview | undefined {
  if (build.requestedBy === USER.id || build.requestedBy === WEB_USER.id) return undefined;
  const key = (o: OperationManifest) => opKey(o.name, o.version);
  const had = new Map(base.manifest.operations.map((o) => [key(o), o]));
  const newOperations = candidate.manifest.operations
    .filter((o) => !had.has(key(o)))
    .map((o) => ({ key: key(o), description: o.description, sideEffect: o.sideEffect, inputs: Object.keys((o.inputSchema as { properties?: object }).properties ?? {}), ...(views.has(key(o)) ? { example: shortJson(views.get(key(o))) } : {}) }));
  const connection = isConnection(candidate.manifest);
  if (!connection && !newOperations.length) return undefined;
  const ui = (f: Files) => Object.keys(f).filter((p) => p.startsWith("ui/")).sort();
  const sameBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  const uiChanged = JSON.stringify(ui(base.files)) !== JSON.stringify(ui(candidate.files)) || ui(candidate.files).some((p) => !sameBytes(base.files[p], candidate.files[p]));
  const oldMigrations = new Set(migrationsOf(base.files).map((m) => m.name));
  const oldGrants = new Set(wantedGrants(base.manifest));
  const strip = (o: OperationManifest) => JSON.stringify({ description: o.description, inputSchema: o.inputSchema, outputSchema: o.outputSchema });
  const now = new Set(candidate.manifest.operations.map(key));
  return {
    contentHash,
    connection,
    newOperations,
    changes: {
      ui: uiChanged,
      migrations: migrationsOf(candidate.files).map((m) => m.name).filter((n) => !oldMigrations.has(n)),
      newGrants: wantedGrants(candidate.manifest).filter((g) => !oldGrants.has(g)),
      changedOperations: candidate.manifest.operations.filter((o) => had.has(key(o)) && strip(had.get(key(o))!) !== strip(o)).map(key),
      removedOperations: [...had.keys()].filter((k) => !now.has(k)),
    },
  };
}

/** A value as indented JSON, cut to a readable size (long arrays to their first items). */
function shortJson(v: unknown, max = 1200): string {
  const trim = (x: unknown, depth: number): unknown => {
    if (Array.isArray(x)) return [...x.slice(0, 3).map((y) => trim(y, depth + 1)), ...(x.length > 3 ? [`… ${x.length - 3} more`] : [])];
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, depth > 3 ? "…" : trim(y, depth + 1)]));
    return typeof x === "string" && x.length > 120 ? `${x.slice(0, 120)}…` : x;
  };
  const out = JSON.stringify(trim(v, 0), null, 2) ?? "null";
  return out.length > max ? `${out.slice(0, max)}\n…` : out;
}

/**
 * Where a build's tool came from: only an install from a file (builder "bundle", which only the
 * owner's install makes) says, never what an agent put in its request.
 */
function installedFrom(build: BuildRow): ToolSource | undefined {
  return build.builder === "bundle" ? (build.request as { source?: ToolSource }).source : undefined;
}
