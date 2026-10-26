// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool as a file (sharing, step 1). Share…: what a version would ship (its files, the scan,
// sample data), and the bundle. Install from a file: staged first so the owner can read it, then
// a create build with no builder ("bundle") through the normal validation. Sample data: replayed
// after an install or Start over, and written by the owner as a new version. Owner only.
import { type Agent, requireOwner } from "../auth.ts";
import { BundleError, type Finding, packBundle, readSample, SAMPLE_FILE, type SampleCall, scanFiles, type Sidecar, unpackBundle } from "../bundle.ts";
import { PlatformError } from "../errors.ts";
import { type Cells, cellsFromSvg } from "../glyph.ts";
import { bytes, text } from "../files.ts";
import { abiOf, abiUnsupported, type CapabilityManifest, isConnection, MODEL_PROVIDERS, stampSource, type ToolSource } from "../manifest.ts";
import type { Files } from "../ports.ts";
import type { BuildRow } from "../registry.ts";
import { randomToken } from "../sha256.ts";
import { type BuildView, RESERVED_IDS, slugify } from "./builds.ts";
import { Domain } from "./context.ts";
import { type CodeFile, codeFiles, type CodeText, codeText } from "./data.ts";
import { MODEL_KEYS } from "./models.ts";

/** A staged bundle (uploaded, not installed) is dropped after a day. */
const STAGED_MS = 24 * 3600_000;

export interface ShareCheck {
  id: string;
  name: string;
  version: number;
  versions: number[];
  files: number;
  findings: Finding[];
  sample: { calls: number } | null;
  /** A connection: it shares without sample data. */
  connection: boolean;
  /** Why it can't be shared: one of the owner's own values in it, or no sample data. */
  blocked: { kind: "secret"; file: string; line: number; label: string } | { kind: "no-sample" } | null;
}

/** What the install sheet shows before anything is installed. */
export interface BundlePreview {
  token: string;
  id: string;
  name: string;
  purpose: string;
  description: string | null;
  kind: "capability" | "connection";
  /** The version it was exported from. */
  version: number;
  from: ToolSource["from"];
  host: string | null;
  summary: Sidecar["summary"] | null;
  /** What it will ask for once installed (grants still happen then). */
  asks: { hosts: string[]; model: { tier?: string; model?: string; images: boolean } | null; tools: { id: string; operations: string[] }[]; secrets: string[]; config: string[] };
  /** Sample calls it ships with. */
  sample: number | null;
  files: number;
  /** Its name, or the first free "Name 2", "Name 3"… */
  suggestedName: string;
  operations: { name: string; description: string; sideEffect: string }[];
  /** Its tile: the manifest's hue and saturation, and its 5×5 glyph (ui/icon.svg) when it has one. */
  icon: { hue: number | null; saturation: number | null; glyph: Cells | null };
}

interface Staged {
  at: number;
  from: ToolSource["from"];
  host?: string;
}

export class Sharing extends Domain {
  // ---------- Share… ----------

  /** What sharing a version would ship, before it ships: the scan's findings and the sample data; blocked, and why. */
  async shareCheck(owner: Agent, capabilityId: string, version?: number): Promise<ShareCheck> {
    requireOwner(owner);
    const cap = this.visibleActive(owner, capabilityId);
    const v = version ?? cap.activeVersion!;
    const files = await this.shareFiles(capabilityId, v);
    const findings = scanFiles(files, this.ownValues());
    let sample: SampleCall[] | null = null;
    try {
      sample = readSample(files);
    } catch {
      sample = null;
    }
    const secret = findings.find((f) => f.kind === "secret");
    // A connection has no data of its own to show (its sign-in never travels), so it shares without sample data.
    const connection = isConnection(this.registry.getVersion(capabilityId, v)!.manifest);
    return {
      id: capabilityId,
      name: cap.displayName ?? cap.name,
      version: v,
      versions: this.registry.versions(capabilityId).map((x) => x.version),
      files: Object.keys(files).length,
      findings,
      sample: sample ? { calls: sample.length } : null,
      connection,
      blocked: secret ? { kind: "secret", file: secret.file, line: secret.line, label: secret.label } : !sample && !connection ? { kind: "no-sample" } : null,
    };
  }

  /** The bundle (`<id>.hewn.zip`): refused while the check blocks it. */
  async shareBundle(owner: Agent, capabilityId: string, version?: number): Promise<{ name: string; bundle: Uint8Array }> {
    const check = await this.shareCheck(owner, capabilityId, version);
    if (check.blocked?.kind === "secret") throw new PlatformError("conflict", `${check.blocked.file}:${check.blocked.line} is ${check.blocked.label}. Remove it, then share again.`, { blocked: check.blocked });
    if (check.blocked?.kind === "no-sample") throw new PlatformError("conflict", `${capabilityId} has no sample data (${SAMPLE_FILE}), and a tool needs it to be shared. Ask the builder to add some, or write it yourself.`, { blocked: check.blocked });
    const files = await this.shareFiles(capabilityId, check.version);
    const row = this.registry.getVersion(capabilityId, check.version)!;
    const manifest = JSON.parse(text(files["capability.json"])) as CapabilityManifest;
    const sidecar: Sidecar = { format: 1, hewn: this.platform.version ?? "dev", abi: abiOf(manifest), exportedAt: new Date().toISOString(), tool: { id: capabilityId, version: check.version, hash: row.contentHash } };
    this.registry.addLifecycleEvent(capabilityId, "share", `v${check.version} as a file`, owner.id);
    return { name: `${capabilityId}.hewn.zip`, bundle: packBundle(files, sidecar) };
  }

  /** A version's files as they travel: its own `source` goes (an install writes its own). */
  private async shareFiles(capabilityId: string, version: number): Promise<Files> {
    const v = await this.loadVersion(capabilityId, version);
    const manifest = JSON.parse(text(v.files["capability.json"])) as CapabilityManifest;
    if (!manifest.source) return { ...v.files };
    const { source: _, ...rest } = manifest;
    return { ...v.files, "capability.json": bytes(JSON.stringify(rest, null, 2) + "\n") };
  }

  /** The owner's own stored values, each named: every tool's secrets and settings, and the model providers' keys. */
  private ownValues(): { value: string; label: string }[] {
    const out: { value: string; label: string }[] = [];
    for (const c of [...this.registry.listActiveCapabilities(), ...this.registry.listArchivedCapabilities()]) {
      const name = c.displayName ?? c.name;
      for (const [k, value] of Object.entries(this.registry.config(c.id))) out.push({ value, label: `your ${name} setting ${k}` });
      const m = this.registry.getVersion(c.id, c.activeVersion!)?.manifest;
      for (const s of m?.requires?.secrets ?? []) {
        const value = this.secrets.get(c.id, s.name);
        if (value) out.push({ value, label: `your ${name} key (${s.name})` });
      }
    }
    for (const p of MODEL_PROVIDERS) {
      const value = this.secrets.get(MODEL_KEYS, p);
      if (value) out.push({ value, label: `your ${p === "openai" ? "OpenAI" : p === "openrouter" ? "OpenRouter" : "Anthropic"} API key` });
    }
    return out;
  }

  // ---------- Install from a file ----------

  /** Stage an uploaded bundle: checked (format, size, ABI), kept until installed or a day old. */
  async stageBundle(owner: Agent, zip: Uint8Array, origin: { from: ToolSource["from"]; host?: string } = { from: "file" }): Promise<BundlePreview> {
    requireOwner(owner);
    const { files, sidecar, manifest } = refuseUnreadable(zip);
    await this.dropOldStaged();
    const token = randomToken(24);
    await this.blobs.put(`bundles/${token}.zip`, zip);
    const staged = this.registry.getKv<Record<string, Staged>>("bundles:staged") ?? {};
    staged[token] = { at: Date.now(), from: origin.from, ...(origin.host ? { host: origin.host } : {}) };
    this.registry.setKv("bundles:staged", staged);
    return this.preview(token, files, sidecar, manifest, staged[token]);
  }

  /** A staged bundle's preview again (the install sheet, reopened). */
  async stagedBundle(owner: Agent, token: string): Promise<BundlePreview> {
    requireOwner(owner);
    const s = await this.loadStaged(token);
    return this.preview(token, s.files, s.sidecar, s.manifest, s.staged);
  }

  /** The code browser on a staged bundle: its files, as they are (nothing to compare with). */
  async bundleCode(owner: Agent, token: string): Promise<{ version: number; base: null; files: CodeFile[] }> {
    requireOwner(owner);
    const s = await this.loadStaged(token);
    return { version: s.sidecar.tool?.version ?? 1, base: null, files: codeFiles(s.files, null) };
  }

  async bundleFile(owner: Agent, token: string, path: string): Promise<CodeText> {
    requireOwner(owner);
    return codeText(path, (await this.loadStaged(token)).files, null);
  }

  /** Forget a staged bundle (the sheet was cancelled). */
  async dropStaged(owner: Agent, token: string) {
    requireOwner(owner);
    await this.blobs.delete(`bundles/${token}.zip`);
    const staged = this.registry.getKv<Record<string, Staged>>("bundles:staged") ?? {};
    delete staged[token];
    this.registry.setKv("bundles:staged", staged);
  }

  /**
   * Install a staged bundle under `name` (its id comes from the name): a create build whose files
   * are the bundle's, with `source` set to where it came from, through the normal validation.
   * `sample`: replay its sample data once it's live.
   */
  async installBundle(owner: Agent, token: string, req: { name: string; sample?: boolean }): Promise<BuildView> {
    requireOwner(owner);
    const s = await this.loadStaged(token);
    const name = String(req.name ?? "").trim();
    if (!name) throw new PlatformError("invalid_request", "give it a name");
    const id = slugify(name);
    if (!id) throw new PlatformError("invalid_request", "the name needs a letter or a digit");
    if (RESERVED_IDS.has(id)) throw new PlatformError("invalid_request", `'${id}' is reserved; choose another name`);
    if (this.registry.getCapability(id)) throw new PlatformError("conflict", `You already have a tool called ${name}. Pick another name.`);
    const source: ToolSource = { id: s.sidecar.tool.id, name: s.manifest.name, version: s.sidecar.tool.version, hash: s.sidecar.tool.hash, from: s.staged.from, ...(s.staged.host ? { host: s.staged.host } : {}) };
    const manifest = stampSource({ ...s.manifest, id, name }, source);
    const seed: Files = { ...s.files, "capability.json": bytes(JSON.stringify(manifest, null, 2) + "\n") };
    const sample = !!req.sample && !!s.files[SAMPLE_FILE];
    const where = s.staged.from === "hub" ? "from Hub" : s.staged.from === "link" ? `from ${s.staged.host}` : "from a file";
    const build = await this.d.builds.install(owner, { name, purpose: manifest.purpose, builder: "bundle", id, seed, requirements: `Installed ${where}: ${s.manifest.name} v${source.version}`, source, sample });
    await this.dropStaged(owner, token);
    return build;
  }

  private preview(token: string, files: Files, sidecar: Sidecar, m: CapabilityManifest, staged: Staged): BundlePreview {
    let sample: SampleCall[] | null = null;
    try {
      sample = readSample(files);
    } catch {
      sample = null;
    }
    const model = m.requires?.model;
    return {
      token,
      id: m.id,
      name: m.name,
      purpose: m.purpose,
      description: m.description ?? null,
      kind: isConnection(m) ? "connection" : "capability",
      version: sidecar.tool?.version ?? 1,
      from: staged.from,
      host: staged.host ?? null,
      summary: sidecar.summary ?? null,
      asks: {
        hosts: (m.requires?.hosts ?? []).filter((x) => !x.startsWith("config:")),
        model: model ? { ...(model.tier ? { tier: model.tier } : {}), ...(model.model ? { model: model.model } : {}), images: !!model.input?.includes("image") } : null,
        tools: (m.requires?.capabilities ?? []).map((c) => ({ id: c.id, operations: c.operations })),
        secrets: (m.requires?.secrets ?? []).map((x) => x.name),
        config: (m.config ?? []).map((x) => x.name),
      },
      sample: sample?.length ?? null,
      files: Object.keys(files).length,
      suggestedName: this.freeName(m.name),
      operations: m.operations.filter((o) => !o.deprecated).map((o) => ({ name: o.name, description: o.description ?? "", sideEffect: o.sideEffect })),
      icon: { hue: m.hue ?? null, saturation: m.saturation ?? null, glyph: files["ui/icon.svg"] ? (cellsFromSvg(text(files["ui/icon.svg"])) ?? null) : null },
    };
  }

  /** "Plant Log", or "Plant Log 2", "Plant Log 3"… when the id is taken. */
  private freeName(name: string): string {
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? name : `${name} ${n}`;
      const id = slugify(candidate);
      if (id && !RESERVED_IDS.has(id) && !this.registry.getCapability(id)) return candidate;
    }
    return `${name} ${Date.now()}`;
  }

  private async loadStaged(token: string) {
    const staged = (this.registry.getKv<Record<string, Staged>>("bundles:staged") ?? {})[token];
    const zip = staged && Date.now() - staged.at < STAGED_MS ? await this.blobs.get(`bundles/${token}.zip`) : undefined;
    if (!staged || !zip) throw new PlatformError("not_found", "That file is gone (it's kept for a day). Choose it again.");
    return { ...refuseUnreadable(zip), staged };
  }

  private async dropOldStaged() {
    const staged = this.registry.getKv<Record<string, Staged>>("bundles:staged") ?? {};
    let changed = false;
    for (const [token, s] of Object.entries(staged)) {
      if (Date.now() - s.at < STAGED_MS) continue;
      await this.blobs.delete(`bundles/${token}.zip`);
      delete staged[token];
      changed = true;
    }
    if (changed) this.registry.setKv("bundles:staged", staged);
  }

  // ---------- sample data ----------

  /** After an install build went live: replay its sample data if the owner asked for it. Never fails the build. */
  async afterInstall(build: BuildRow, step: (message: string) => void) {
    if (build.kind !== "create" || !(build.request as { sample?: boolean }).sample) return;
    const r = await this.replaySample(build.capabilityId, build.requestedBy).catch((e) => ({ calls: 0, of: 0, failed: { index: 0, operation: "", error: (e as Error).message } }));
    step(r.failed ? `sample data stopped at call ${r.failed.index + 1} (${r.failed.operation}): ${r.failed.error}` : `sample data: ${r.calls} calls`);
  }

  /**
   * Replay the active version's sample data on its live state, in order, with nothing granted
   * (as validation checked it). A failing call stops it and says which; the tool stays. One entry
   * in Activity, not one per call.
   */
  async replaySample(capabilityId: string, actor: string): Promise<{ calls: number; of: number; failed?: { index: number; operation: string; error: string } }> {
    const cap = this.registry.getCapability(capabilityId);
    if (!cap?.activeVersion) throw new PlatformError("not_found", `${capabilityId} is not active`);
    const v = await this.loadVersion(capabilityId, cap.activeVersion);
    const calls = readSample(v.files);
    if (!calls) throw new PlatformError("not_found", `${capabilityId} has no sample data`);
    const target = { capabilityId, code: v.code, state: { capabilityId }, secrets: {}, config: {}, caller: { kind: "user", id: actor } };
    for (const [i, c] of calls.entries()) {
      try {
        await this.d.validation.replayCall(v.row.manifest, target, c);
      } catch (e) {
        const failed = { index: i, operation: c.operation, error: (e as Error).message };
        this.registry.addLifecycleEvent(capabilityId, "sample", `Sample data: ${i} of ${calls.length} calls; ${c.operation} failed: ${failed.error}`, actor);
        return { calls: i, of: calls.length, failed };
      }
    }
    this.registry.dropWidgetCache(capabilityId);
    this.registry.addLifecycleEvent(capabilityId, "sample", `Sample data: ${calls.length} calls`, actor);
    return { calls: calls.length, of: calls.length };
  }

  /** Write it yourself: sample/calls.json as a new version (no builder; validation replays it). */
  async setSample(owner: Agent, capabilityId: string, json: string): Promise<BuildView> {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    try {
      readSample({ [SAMPLE_FILE]: bytes(json) });
    } catch (e) {
      throw new PlatformError("invalid_request", (e as Error).message);
    }
    return this.d.builds.filesOnlyModify(owner, capabilityId, { [SAMPLE_FILE]: bytes(json.trimEnd() + "\n") }, "sample data, written by you");
  }
}

/** A bundle's files, sidecar and manifest, or the reason it can't be installed here. */
function refuseUnreadable(zip: Uint8Array): { files: Files; sidecar: Sidecar; manifest: CapabilityManifest } {
  let unpacked;
  try {
    unpacked = unpackBundle(zip);
  } catch (e) {
    if (e instanceof BundleError) throw new PlatformError("invalid_request", e.message, { refusal: "unreadable" });
    throw e;
  }
  let manifest: CapabilityManifest;
  try {
    manifest = JSON.parse(text(unpacked.files["capability.json"]));
  } catch {
    throw new PlatformError("invalid_request", "Its capability.json isn't valid JSON.", { refusal: "unreadable" });
  }
  if (typeof manifest?.id !== "string" || typeof manifest?.name !== "string") throw new PlatformError("invalid_request", "Its capability.json has no id or name.", { refusal: "unreadable" });
  const tooNew = abiUnsupported(abiOf(manifest));
  if (tooNew) throw new PlatformError("invalid_request", `${manifest.name} ${tooNew.replace(/^needs/, "needs")}. Upgrade Hewn to install it.`, { refusal: "newer", abi: abiOf(manifest) });
  if (!unpacked.sidecar.tool?.id || !Number.isInteger(unpacked.sidecar.tool?.version) || !/^[0-9a-f]{64}$/.test(unpacked.sidecar.tool?.hash ?? "")) throw new PlatformError("invalid_request", "Its hewn-bundle.json doesn't say which tool and version it is.", { refusal: "unreadable" });
  return { ...unpacked, manifest };
}
