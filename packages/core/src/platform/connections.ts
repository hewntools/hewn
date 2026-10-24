// SPDX-License-Identifier: AGPL-3.0-or-later
// Accounts: connections, their sign-in step and their health.
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { connectOperation, isConnection, opKey } from "../manifest.ts";
import { Domain } from "./context.ts";

/** What Accounts shows for a connection: its own health@1, or "needs_setup" when it isn't ready yet. */
export interface ConnectionHealth {
  status: "connected" | "expired" | "broken" | "needs_setup";
  detail?: string;
  checkedAt: string;
}

export class Connections extends Domain {
  /** Last live health@1 result per connection version, for Accounts (dropped when its setup changes). */
  private healthCache = new Map<string, { at: number; health: ConnectionHealth }>();

  /**
   * Run a connection's sign-in step (owner only): the input holds credentials, so it never goes
   * through agents and is never logged. Returns the step's output ("connected", or "needs_input"
   * with the next fields).
   */
  async connect(owner: Agent, capabilityId: string, input: Record<string, unknown>) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    const op = connectOperation(this.activeManifest(capabilityId));
    if (!op) throw new PlatformError("invalid_request", `${capabilityId} has no sign-in step (its secrets are set directly)`);
    const r = await this.platform.invoke(owner, { capabilityId, operation: op.name, operationVersion: op.version, input });
    this.forgetHealth(capabilityId);
    const status = (r.result as { status?: string }).status;
    this.registry.addAuthorityEvent({ actor: owner.id, action: "signed_in", subject: capabilityId, capabilityId, detail: status ?? "" });
    return r.result as { status: "connected" | "needs_input"; message?: string; inputSchema?: Record<string, unknown>; state?: string };
  }

  /**
   * A connection's health, from its health@1 (called as the owner, with a short deadline). Not
   * set up yet ("needs_setup") when it isn't ready; "broken" when the check itself fails.
   * `cached` reuses a live result younger than HEALTH_CACHE_MS (Accounts); a direct check is always fresh.
   */
  async connectionHealth(owner: Agent, capabilityId: string, o: { cached?: boolean } = {}): Promise<ConnectionHealth> {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    if (!isConnection(this.activeManifest(capabilityId))) throw new PlatformError("invalid_request", `${capabilityId} is not a connection`);
    const checkedAt = new Date().toISOString();
    const status = this.platform.readiness(capabilityId);
    if (!status.ready) {
      const signIn = !!connectOperation(this.activeManifest(capabilityId));
      const detail = status.unsupportedAbi
        ? `this version ${status.unsupportedAbi}`
        : status.missingDependencies.length
          ? "it depends on operations that no longer exist"
          : status.pendingGrants.length
            ? "waiting for your approval"
            : status.missingConfig.length
              ? `needs ${status.missingConfig.join(", ")}`
              : signIn
                ? "not signed in"
                : `needs ${status.missingSecrets.join(", ")}`;
      return { status: "needs_setup", detail, checkedAt };
    }
    const key = `${capabilityId}@${this.registry.getCapability(capabilityId)!.activeVersion}`;
    const hit = this.healthCache.get(key);
    if (o.cached && hit && Date.now() - hit.at < HEALTH_CACHE_MS) return hit.health;
    let health: ConnectionHealth;
    try {
      const r = await this.platform.invoke(owner, { capabilityId, operation: "health", operationVersion: 1, input: {} }, [owner.id], Date.now() + HEALTH_DEADLINE_MS, { record: false });
      const out = r.result as { status: "connected" | "expired" | "broken"; detail?: unknown };
      health = { status: out.status, ...(typeof out.detail === "string" ? { detail: out.detail.slice(0, 300) } : {}), checkedAt };
    } catch (e) {
      health = { status: "broken", detail: (e as Error).message.slice(0, 300), checkedAt };
    }
    this.healthCache.set(key, { at: Date.now(), health });
    return health;
  }

  forgetHealth(capabilityId: string) {
    for (const key of this.healthCache.keys()) if (key.startsWith(`${capabilityId}@`)) this.healthCache.delete(key);
  }

  /** Accounts (owner only): every connection with its health and users. */
  async accounts(owner: Agent) {
    requireOwner(owner);
    const all = this.registry.listActiveCapabilities();
    const connections = await Promise.all(
      all
        .filter((c) => isConnection(this.activeManifest(c.id)))
        .map(async (c) => {
          const m = this.activeManifest(c.id);
          const auth = this.platform.authorization(c.id);
          const signIn = connectOperation(m);
          return {
            id: c.id,
            name: c.displayName ?? m.name,
            purpose: m.purpose,
            version: c.activeVersion!,
            health: await this.connectionHealth(owner, c.id, { cached: true }),
            status: this.platform.readiness(c.id),
            usedBy: this.platform.usedBy(c.id),
            config: auth.config,
            secrets: (m.requires?.secrets ?? []).map((x) => ({ name: x.name, description: x.description, set: this.secrets.get(c.id, x.name) !== undefined })),
            signIn: signIn ? { operation: opKey(signIn.name, signIn.version), inputSchema: signIn.inputSchema } : null,
          };
        }),
    );
    return { connections };
  }
}

/** How long Accounts waits for a connection's health@1. */
export const HEALTH_DEADLINE_MS = 10_000;
/** How long Accounts reuses a connection's last live health result. */
export const HEALTH_CACHE_MS = 2 * 60_000;
