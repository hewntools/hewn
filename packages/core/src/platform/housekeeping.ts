// SPDX-License-Identifier: AGPL-3.0-or-later
// Housekeeping: the cleanup run at start and daily, and the aggregates for a host's metrics endpoint.
import { type Agent, requireOwner, USER } from "../auth.ts";
import { Domain } from "./context.ts";

/** Capability call logs older than this are pruned (owner setting; 0 keeps them forever). */
export const LOG_RETENTION_DAYS = 14;

export class Housekeeping extends Domain {
  /**
   * Aggregates for a host's metrics endpoint (HEWN_METRICS_PORT): counts and sums only, never what's in
   * the tools. Calls come from the call logs, so they reach back as far as those are kept (14 days by default).
   */
  metrics(owner: Agent) {
    requireOwner(owner);
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const snap = this.registry.metricsSnapshot(iso(86_400_000), iso(7 * 86_400_000), new Date(now).toISOString().slice(0, 7));
    // A call-log entry: "<iso> <caller[ → caller…]> <operation> <ok | ERROR …> <n>ms". The first caller is the origin.
    const parse = (e: string) => {
      const rest = e.slice(e.indexOf(" ") + 1);
      return { agent: rest.split(" ")[0] || "unknown", ok: !/ ERROR /.test(` ${rest} `) };
    };
    const tally = (entries: string[]) => {
      const byAgent: Record<string, { ok: number; error: number }> = {};
      for (const e of entries) {
        const { agent, ok } = parse(e);
        const t = (byAgent[agent] ??= { ok: 0, error: 0 });
        ok ? t.ok++ : t.error++;
      }
      return byAgent;
    };
    const agents = this.agentStore.list();
    const weekAgo = iso(7 * 86_400_000);
    const schedules = this.platform.listSchedules(owner);
    return {
      tools: { active: snap.tools.active ?? 0, archived: snap.tools.archived ?? 0, unversioned: snap.tools.unversioned ?? 0 },
      builds: Object.fromEntries(snap.builds.map((b) => [b.status, b.n])),
      buildSeconds7d: { count: snap.buildTime.n, sum: Math.round(snap.buildTime.seconds ?? 0) },
      calls24h: tally(snap.calls24h),
      calls7d: tally(snap.calls7d),
      model: { month: new Date(now).toISOString().slice(0, 7), usd: snap.model.usd ?? 0, inputTokens: snap.model.input ?? 0, outputTokens: snap.model.output ?? 0, calls: snap.model.calls },
      agents: { connected: agents.length, active7d: agents.filter((a) => a.lastUsedAt && a.lastUsedAt >= weekAgo).length },
      schedules: schedules.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {}),
      schedulesFailing: schedules.filter((x) => (x.failures ?? 0) > 0).length,
    };
  }

  /**
   * Remove what abandoned builds leave behind: workspaces of finished builds (after a day, so a
   * failure can still be looked at), transcripts (after 30 days), and capability ids that never got
   * a version (after 7 days with no build running). Also: capability call logs after the owner's
   * retention (14 days by default), and
   * confirmations after a day. Call at start and daily.
   */
  async cleanup(now = Date.now()): Promise<{ workspaces: number; transcripts: number; releasedIds: string[]; logs: number }> {
    const iso = (days: number) => new Date(now - days * 86400_000).toISOString();
    let workspaces = 0;
    let transcripts = 0;
    for (const b of this.registry.finishedBuildsBefore(iso(1))) {
      if (this.platform.isRunning(b.id)) continue;
      await this.workbench.remove(b.id).catch(() => {});
      workspaces++;
    }
    // Attachments of conversations that never led to a build.
    for (const ref of this.registry.staleAttachments(iso(1))) {
      await this.blobs.delete(`attachments/${ref}`);
      this.registry.deleteAttachment(ref);
    }
    for (const b of this.registry.finishedBuildsBefore(iso(30))) {
      // Kept with the build before the workbench's copy goes (builds from before 0.4.6 are kept now too).
      const key = `transcripts/${b.id}.log`;
      const left = await this.workbench.transcript(b.id).catch(() => undefined);
      if (left && !(await this.blobs.get(key))) await this.blobs.put(key, left);
      await this.workbench.removeTranscript(b.id).catch(() => {});
      transcripts++;
    }
    const releasedIds: string[] = [];
    const stale = iso(7);
    for (const id of this.registry.unpromotedCapabilities()) {
      const builds = this.registry.buildIdsFor(id).map((b) => this.registry.getBuild(b)!);
      if (builds.some((b) => this.platform.isRunning(b.id) || !["failed", "cancelled"].includes(b.status) || b.updatedAt >= stale)) continue;
      // Released before anything is awaited: a new create of the name in between would take the id
      // over (createBuild) and go with it, mid-build. One after it reserves the id afresh.
      this.registry.purgeCapability(id);
      releasedIds.push(id);
      for (const b of builds) {
        await this.workbench.remove(b.id).catch(() => {});
        await this.workbench.removeTranscript(b.id).catch(() => {});
        await this.blobs.delete(`transcripts/${b.id}.log`);
      }
    }
    if (releasedIds.length) this.logger(`cleanup: released ids that never got a version: ${releasedIds.join(", ")}`);
    this.agentStore.cleanup();
    // Reservations a crash left open (an hour is far past any call's deadline).
    this.registry.settleStaleModelSpend(new Date(now - 3600_000).toISOString());
    // The model catalog: refreshed at start and daily; not awaited (a slow list never holds cleanup).
    const fetched = this.registry.getKv<{ fetchedAt: string }>("models.catalog")?.fetchedAt;
    if (this.platform.modelFetch && (!fetched || now - Date.parse(fetched) > 20 * 3600_000)) void this.platform.refreshModelCatalog();
    // And what the active provider's key can use (models come and go).
    const active = this.platform.modelSettings_().provider;
    const listed = active ? this.d.models.providerList(active)?.checkedAt : undefined;
    if (this.platform.modelFetch && active && (!listed || now - Date.parse(listed) > 20 * 3600_000)) void this.platform.checkModelProvider(USER, active).catch(() => {});
    const keep = this.platform.logRetentionDays();
    const logs = keep > 0 ? this.registry.pruneCapabilityLogs(iso(keep)) : 0;
    this.registry.expireConfirmations(iso(1));
    return { workspaces, transcripts, releasedIds, logs };
  }
}
