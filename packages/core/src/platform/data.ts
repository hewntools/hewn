// SPDX-License-Identifier: AGPL-3.0-or-later
// A capability's lifecycle and data, owner only: delete (archive) and restore, roll back to an earlier
// version, purge for good, export and import its data, and its versions' code for the code browser
// (each file against the version it was built on; the diffing itself is in code.ts).
import { type Agent, requireOwner } from "../auth.ts";
import { type CodeFile, codeFiles, type CodeText, codeText } from "../code.ts";
import { PlatformError } from "../errors.ts";
import { type CapabilityManifest, opKey } from "../manifest.ts";
import { migrationsOf, rollbackProblems } from "../migrations.ts";
import { Domain, type Domains } from "./context.ts";

/** How many of a capability's latest calls Info › Data looks through for its last write. */
const WRITE_LOOKBACK = 500;

/** Info › Data: rows per table, and the last write found in the call log. */
export interface DataSummary {
  tables: Record<string, number>;
  rows: number;
  lastWriteAt: string | null;
  /** How many calls were looked through: fewer than 500 is the whole log. */
  callsChecked: number;
}

export class Data extends Domain {
  /**
   * "Delete" archives: the capability disappears for the owner and every agent, its state and
   * versions are kept, and the id stays reserved. `hewn restore <id>` brings it back.
   */
  archive(owner: Agent, capabilityId: string) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    this.registry.setOwnerPrefs(capabilityId, { archivedAt: new Date().toISOString() });
    this.registry.addLifecycleEvent(capabilityId, "delete", "", owner.id);
    this.logger(`${capabilityId} deleted (archived, data kept) by ${owner.id}`);
  }

  /**
   * Make an earlier version active again (default: the one before the active version). Refused if
   * the newer migrations aren't safe for older code, or if a capability that uses this one relies
   * on an operation the target version doesn't have. State is kept as is (migrations are additive).
   */
  async rollback(owner: Agent, capabilityId: string, version?: number): Promise<{ from: number; to: number }> {
    requireOwner(owner);
    const cap = this.visibleActive(owner, capabilityId);
    const from = cap.activeVersion!;
    const to = version ?? from - 1;
    if (!this.registry.getVersion(capabilityId, to)) throw new PlatformError("not_found", `${capabilityId} has no version ${to}`);
    if (to === from) throw new PlatformError("conflict", `v${to} is already active`);
    const target = await this.loadVersion(capabilityId, to);
    const current = await this.loadVersion(capabilityId, from);
    const applied = new Set(migrationsOf(target.files).map((m) => m.name));
    const later = migrationsOf(current.files).filter((m) => !applied.has(m.name));
    const problems = rollbackProblems(later);
    const offered = new Set(target.row.manifest.operations.map((o) => opKey(o.name, o.version)));
    for (const u of this.platform.usedBy(capabilityId)) for (const op of u.operations) if (!offered.has(op)) problems.push(`${u.name} calls ${op}, which v${to} doesn't have`);
    if (problems.length) throw new PlatformError("conflict", `can't roll back to v${to}: ${problems.join("; ")}`, { problems });
    this.registry.activate(capabilityId, to);
    this.registry.addLifecycleEvent(capabilityId, "rollback", `v${from} → v${to}`, owner.id);
    this.logger(`${capabilityId} rolled back v${from} → v${to} by ${owner.id}`);
    return { from, to };
  }

  /**
   * Permanently delete an archived capability: code, versions, state, logs, grants, builds and
   * secrets. Owner only, with the id typed as confirmation. The id becomes free again.
   */
  async purge(owner: Agent, capabilityId: string, confirm: string) {
    requireOwner(owner);
    const cap = this.registry.getCapability(capabilityId);
    if (!cap?.archivedAt) throw new PlatformError("conflict", `${capabilityId} isn't deleted; delete it first (purge only removes deleted capabilities)`);
    if (confirm !== capabilityId) throw new PlatformError("invalid_request", `type the id '${capabilityId}' to confirm`);
    const secrets = new Set<string>();
    const hashes = new Set<string>();
    for (let v = 1; v <= this.registry.latestVersionNumber(capabilityId); v++) {
      const row = this.registry.getVersion(capabilityId, v);
      if (!row) continue;
      hashes.add(row.contentHash);
      for (const s of row.manifest.requires?.secrets ?? []) secrets.add(s.name);
    }
    for (const s of secrets) this.secrets.delete(capabilityId, s);
    const builds = this.registry.buildIdsFor(capabilityId);
    // Its attachments go, unless a sibling build from the same conversation (an ideas draft that became several tools) still shows them.
    for (const ref of this.registry.releaseAttachments(builds)) await this.blobs.delete(`attachments/${ref}`);
    for (const b of builds) {
      await this.workbench.remove(b).catch(() => {});
      await this.workbench.removeTranscript(b).catch(() => {});
      await this.blobs.delete(`transcripts/${b}.log`);
      await this.blobs.delete(`screenshots/${b}.png`);
      await this.blobs.delete(`screenshots/${b}-dark.png`);
    }
    for (const h of hashes) await this.blobs.delete(`versions/${h}.json`);
    await this.blobs.delete(`icons/${capabilityId}`);
    this.schedules.deleteFor(capabilityId);
    this.registry.dropWidgetCache(capabilityId);
    for (const name of await this.runtime.listStates(capabilityId, "")) await this.runtime.dropState({ capabilityId, scratch: name });
    await this.runtime.dropState({ capabilityId });
    // Others' grants to call it go too: a new capability under the same id starts with none.
    for (const [holder, grant] of this.registry.grantsTo(capabilityId)) {
      this.registry.revokeGrant(holder, "capability", grant.slice("capability:".length));
      this.registry.addGrantEvent(holder, "revoke", grant, owner.id);
    }
    this.registry.purgeCapability(capabilityId);
    this.registry.addLifecycleEvent(capabilityId, "purge", "", owner.id);
    this.logger(`${capabilityId} permanently deleted by ${owner.id}`);
  }

  /**
   * The owner's data, as JSON: the capability's own `export` operation (read) if it has one,
   * otherwise a platform dump of its state tables.
   */
  async exportData(owner: Agent, capabilityId: string): Promise<{ capability: string; version: number; exportedAt: string; source: "operation" | "state"; data: unknown }> {
    requireOwner(owner);
    const cap = this.visibleActive(owner, capabilityId);
    const op = latestOp(this.activeManifest(capabilityId), "export");
    const base = { capability: capabilityId, version: cap.activeVersion!, exportedAt: new Date().toISOString() };
    if (op && op.sideEffect === "read" && this.platform.readiness(capabilityId).ready) {
      const r = await this.platform.invoke(owner, { capabilityId, operation: "export", operationVersion: op.version, input: {} });
      return { ...base, source: "operation", data: r.result };
    }
    const active = await this.loadVersion(capabilityId, cap.activeVersion!);
    return { ...base, source: "state", data: await this.runtime.dumpState({ capabilityId }, active.code) };
  }

  /**
   * Info › Data: rows per table (counted, not read) and when an operation last wrote, from the
   * call log's last `WRITE_LOOKBACK` calls (so null once the log has been pruned past it, or when
   * none of them wrote). `callsChecked`: how many calls that was, so "none" can say "in the last 500".
   */
  async dataSummary(owner: Agent, capabilityId: string): Promise<DataSummary> {
    requireOwner(owner);
    const cap = this.visibleActive(owner, capabilityId);
    const active = await this.loadVersion(capabilityId, cap.activeVersion!);
    const tables = await this.runtime.countState({ capabilityId }, active.code);
    const writes = new Set(active.row.manifest.operations.filter((o) => o.sideEffect !== "read").flatMap((o) => [o.name, opKey(o.name, o.version)]));
    const headers = this.registry.capabilityLogHeaders(capabilityId, WRITE_LOOKBACK);
    let lastWriteAt: string | null = null;
    for (const header of headers) {
      // The caller may hold spaces ("agent:x → tool"), so read from the end: "… <op> ok <ms>ms".
      const m = /^(\S+) .* (\S+) ok \d+ms$/.exec(header);
      if (m && writes.has(m[2])) {
        lastWriteAt = m[1];
        break;
      }
    }
    return { tables, rows: Object.values(tables).reduce((n, x) => n + x, 0), lastWriteAt, callsChecked: headers.length };
  }

  /**
   * Load exported data into a capability's live state (owner only): the inverse of exportData's
   * state dump. Its tables must exist (migrations applied) and be empty.
   */
  async importData(owner: Agent, capabilityId: string, tables: Record<string, Record<string, unknown>[]>): Promise<{ rows: number }> {
    requireOwner(owner);
    const cap = this.visibleActive(owner, capabilityId);
    const active = await this.loadVersion(capabilityId, cap.activeVersion!);
    try {
      const rows = await this.runtime.loadState({ capabilityId }, tables, active.code);
      this.logger(`${capabilityId}: imported ${rows} rows by ${owner.id}`);
      return { rows };
    } catch (e) {
      throw new PlatformError("conflict", `import into ${capabilityId} failed: ${(e as Error).message}`);
    }
  }

  /**
   * The code browser (U4): a version's files, each with what changed since its base (added,
   * changed, removed, and lines +n −n). Owner only.
   */
  async versionCode(owner: Agent, capabilityId: string, version: number): Promise<{ version: number; base: number | null; files: CodeFile[] }> {
    const { files, base, baseFiles } = await this.codeOf(owner, capabilityId, version);
    return { version, base, files: codeFiles(files, baseFiles) };
  }

  /** One file of a version: its text, and the hunks against its base (none for a first version). */
  async versionFile(owner: Agent, capabilityId: string, version: number, path: string): Promise<CodeText> {
    const { files, baseFiles } = await this.codeOf(owner, capabilityId, version);
    return codeText(path, files, baseFiles);
  }

  /**
   * A version's files and its base's: the version its build started from (after a Restore, the
   * restored one), else the one before. Read without keeping them decoded: only what runs stays
   * in memory, and the owner may look through every version a tool ever had.
   */
  private async codeOf(owner: Agent, capabilityId: string, version: number) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    const v = await this.loadVersion(capabilityId, version, { keep: false });
    const n = this.registry.getBuild(v.row.buildId)?.baseVersion ?? version - 1;
    const base = n >= 1 && n < version && this.registry.getVersion(capabilityId, n) ? n : null;
    return { files: v.files, base, baseFiles: base ? (await this.loadVersion(capabilityId, base, { keep: false })).files : null };
  }

  /**
   * Start over (U2): empty a tool's data and keep the tool. The live state is copied to a
   * `backup:start-over-<time>` state first (the newest three are kept, like the ones a promote
   * keeps), then dropped and migrated again from scratch. Owner only, confirmed with the id.
   * `sample`: replay its sample data after.
   */
  async startOver(owner: Agent, capabilityId: string, req: { confirm: string; sample?: boolean }): Promise<{ backup: string | null; sample: Awaited<ReturnType<Domains["sharing"]["replaySample"]>> | null }> {
    requireOwner(owner);
    const cap = this.visibleActive(owner, capabilityId);
    if (req.confirm !== capabilityId) throw new PlatformError("invalid_request", `type the id '${capabilityId}' to confirm`);
    const active = await this.loadVersion(capabilityId, cap.activeVersion!);
    const live = { capabilityId };
    let backup: string | null = null;
    if (await this.runtime.hasState(live)) {
      backup = `backup:start-over-${Date.now()}`;
      await this.runtime.copyState(live, { capabilityId, scratch: backup });
      const old = (await this.runtime.listStates(capabilityId, "backup:start-over-")).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
      for (const name of old.slice(3)) await this.runtime.dropState({ capabilityId, scratch: name });
    }
    await this.runtime.dropState(live);
    await this.runtime.migrate(live, migrationsOf(active.files), active.code);
    this.registry.dropWidgetCache(capabilityId);
    this.registry.addLifecycleEvent(capabilityId, "start-over", backup ? `data emptied; kept as ${backup}` : "data emptied", owner.id);
    this.logger(`${capabilityId}: started over by ${owner.id}${backup ? ` (backup ${backup})` : ""}`);
    const sample = req.sample ? await this.d.sharing.replaySample(capabilityId, owner.id) : null;
    return { backup, sample };
  }

  /** Deleted (archived) capabilities, newest first: what the owner can restore. */
  archived(owner: Agent): { id: string; name: string; archivedAt: string }[] {
    requireOwner(owner);
    return this.registry
      .listArchivedCapabilities()
      .map((c) => ({ id: c.id, name: c.displayName ?? c.name, archivedAt: c.archivedAt! }));
  }

  restore(owner: Agent, capabilityId: string) {
    requireOwner(owner);
    if (!this.registry.getCapability(capabilityId)?.archivedAt) throw new PlatformError("not_found", `${capabilityId} is not archived`);
    this.registry.setOwnerPrefs(capabilityId, { archivedAt: null });
    this.registry.addLifecycleEvent(capabilityId, "restore", "", owner.id);
    this.logger(`${capabilityId} restored by ${owner.id}`);
  }
}

const latestOp = (m: CapabilityManifest, name: string) => m.operations.filter((o) => o.name === name).sort((a, b) => b.version - a.version)[0];
