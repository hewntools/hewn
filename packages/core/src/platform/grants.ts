// SPDX-License-Identifier: AGPL-3.0-or-later
// Authority: whether a capability is ready, the grants it asks for and the owner approves, its
// secrets and config, delegated agents, and the owner's confirmation of agents' destructive calls.
import type { AgentDetails, PendingRequest } from "../agents.ts";
import { type Agent, requireOwner, requireScope, type Scope } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { abiOf, abiUnsupported, type CapabilityManifest, connectOperation, isConnection, modelGrant, opKey } from "../manifest.ts";
import { resolveModel } from "../models.ts";
import type { Confirmation, GrantKind } from "../registry.ts";
import { randomToken, sha256 } from "../sha256.ts";
import { Domain } from "./context.ts";

/** What stands between a capability and being usable. Only the user can resolve it. */
export interface Readiness {
  ready: boolean;
  missingSecrets: string[];
  /** Declared config (non-secret settings) the owner hasn't filled in. */
  missingConfig: string[];
  pendingGrants: string[];
  /** Declared callee operations that don't exist (callee missing, archived, or lacks that op@version). */
  missingDependencies: string[];
  /** Set when the active version needs a newer Hewn ABI than this Hewn has (e.g. after a downgrade). */
  unsupportedAbi?: string;
  /** Set when requires.model can't run yet (no model for the tier, no key, no known price …). */
  missingModel?: string;
  /** Set when a pinned model was retired: the platform's suggested successor, if it knows one. */
  retiredModel?: { model: string; successor?: string };
  /** For agents: what to ask the user to do. */
  userAction?: string;
}

export class Grants extends Domain {
  readiness(capabilityId: string): Readiness {
    const manifest = this.activeManifest(capabilityId);
    const req = manifest.requires ?? {};
    const granted = this.registry.grants(capabilityId);
    const wanted = wantedGrants(manifest);
    const pendingGrants = wanted.filter((g) => !granted.has(g));
    const missingSecrets = (req.secrets ?? []).map((s) => s.name).filter((n) => this.secrets.get(capabilityId, n) === undefined);
    const config = this.registry.config(capabilityId);
    // A value a host is derived from must name a host (it may predate the host declaration).
    const hostConfig = new Set((req.hosts ?? []).filter((h) => h.startsWith("config:")).map((h) => h.slice(7)));
    const missingConfig = (manifest.config ?? []).map((c) => c.name).filter((n) => config[n] === undefined || (hostConfig.has(n) && !hostOf(config[n])));
    const missingDependencies = (req.capabilities ?? []).flatMap((c) => c.operations.filter((op) => !this.offers(c.id, op)).map((op) => `${c.id}/${op}`));
    const unsupportedAbi = abiUnsupported(abiOf(manifest));
    const missingModel = req.model ? this.platform.modelProblem(req.model) : undefined;
    const ready = !pendingGrants.length && !missingSecrets.length && !missingConfig.length && !missingDependencies.length && !unsupportedAbi && !missingModel;
    return {
      ready,
      missingSecrets,
      missingConfig,
      pendingGrants,
      missingDependencies,
      ...(unsupportedAbi ? { unsupportedAbi } : {}),
      ...(missingModel ? { missingModel } : {}),
      ...(req.model?.model && this.platform.retiredModel(req.model.model) ? { retiredModel: { model: req.model.model, ...this.platform.retiredModel(req.model.model) } } : {}),
      ...(ready
        ? {}
        : {
            userAction: unsupportedAbi
              ? `It ${unsupportedAbi}: upgrade Hewn, or roll it back to a version this Hewn can run.`
              : missingModel && !pendingGrants.length
              ? `It needs a model: ${missingModel}. The owner sets that up under Settings › AI › Models in the Hewn web client.`
              : missingDependencies.length
              ? `It depends on operations that no longer exist (${missingDependencies.join(", ")}); it needs a change.`
              : connectOperation(manifest) && !pendingGrants.length && !missingConfig.length
                ? `Needs the owner to sign in to the service (never in an agent): Accounts in the Hewn web client.`
                : `Needs authorization by the owner (never paste secrets into an agent): open it in the Hewn web client. You can file a request with capabilities_request_access.`,
          }),
    };
  }

  /** Whether an active, non-archived capability offers `name@version`. */
  offers(capabilityId: string, opRef: string): boolean {
    const cap = this.registry.getCapability(capabilityId);
    if (!cap?.activeVersion || cap.archivedAt) return false;
    const [name, v] = opRef.split("@");
    return this.activeManifest(capabilityId).operations.some((o) => o.name === name && o.version === Number(v));
  }

  /** What the platform knows still uses `capabilityId`'s `op@N`: capabilities that declare it, schedules that run it. */
  operationUsers(capabilityId: string, key: string): string[] {
    const caps = this.usedBy(capabilityId).filter((u) => u.operations.includes(key)).map((u) => u.id);
    const schedules = this.schedules.list(capabilityId).filter((s) => opKey(s.operation, s.operationVersion) === key).map((s) => `schedule ${s.id}`);
    return [...caps, ...schedules];
  }

  /** Capabilities whose active version calls this one (for "Used by" and delete warnings). */
  usedBy(capabilityId: string): { id: string; name: string; operations: string[] }[] {
    return this.registry
      .listActiveCapabilities()
      .map((c) => ({ c, ops: (this.activeManifest(c.id).requires?.capabilities ?? []).filter((d) => d.id === capabilityId).flatMap((d) => d.operations) }))
      .filter((x) => x.ops.length)
      .map(({ c, ops }) => ({ id: c.id, name: c.displayName ?? c.name, operations: [...new Set(ops)] }));
  }

  /**
   * Everything the active version asks for, shaped for an authorization screen
   * ("Weekly Review wants to: read Running Log list_runs@1 …").
   */
  authorization(capabilityId: string) {
    const manifest = this.activeManifest(capabilityId);
    const req = manifest.requires ?? {};
    const granted = this.registry.grants(capabilityId);
    const items: { grant: string; kind: "capability" | "host" | "secret" | "model"; approved: boolean; label: string; sideEffect?: string; target?: string; description?: string }[] = [];
    for (const c of req.capabilities ?? []) {
      const callee = this.registry.getCapability(c.id);
      const calleeName = callee?.displayName ?? callee?.name ?? c.id;
      for (const op of c.operations) {
        const [name, v] = op.split("@");
        const m = this.offers(c.id, op) ? this.activeManifest(c.id).operations.find((o) => o.name === name && o.version === Number(v)) : undefined;
        items.push({
          grant: `capability:${c.id}/${op}`,
          kind: "capability",
          approved: granted.has(`capability:${c.id}/${op}`),
          label: `${m?.sideEffect === "read" ? "read" : m?.sideEffect ?? "use"} ${calleeName}: ${op}`,
          sideEffect: m?.sideEffect ?? "missing",
          target: c.id,
          description: m?.description ?? "(not available)",
        });
      }
    }
    const values = this.registry.config(capabilityId);
    for (const h of req.hosts ?? []) {
      const derived = h.startsWith("config:") ? h.slice(7) : undefined;
      const label = derived ? `connect to the host in ${derived} (${hostOf(values[derived] ?? "") ?? "not set yet"})` : `connect to ${h}`;
      items.push({ grant: `host:${h}`, kind: "host", approved: granted.has(`host:${h}`), label });
    }
    for (const s of req.secrets ?? []) {
      items.push({ grant: `secret:${s.name}`, kind: "secret", approved: granted.has(`secret:${s.name}`), label: `use secret ${s.name}`, description: s.description });
    }
    if (req.model) {
      const g = modelGrant(req.model);
      const r = resolveModel(req.model, this.platform.modelSettings_());
      const images = req.model.input?.includes("image") ? ", with images" : "";
      const label = req.model.tier ? `use a ${req.model.tier} model${images} (${"model" in r ? r.model : "not set yet"})` : `use ${req.model.model}${images}`;
      items.push({ grant: g, kind: "model", approved: granted.has(g), label, description: "Spends from your model budget (Settings › AI › Models)" });
    }
    const config = (manifest.config ?? []).map((c) => ({ name: c.name, description: c.description, value: values[c.name] ?? null }));
    return { items, config, requests: this.registry.accessRequests(capabilityId) };
  }

  /** Agents may ask the owner for access on a capability's behalf; only the owner can approve. */
  requestAccess(agent: Agent, capabilityId: string, note: string) {
    requireScope(agent, "invoke", "create", "modify");
    this.visibleActive(agent, capabilityId);
    this.registry.addAccessRequest(capabilityId, agent.id, note.slice(0, 500));
    this.registry.addGrantEvent(capabilityId, "request", this.readiness(capabilityId).pendingGrants.join(", "), agent.id);
    this.logger(`${agent.id} requests access for ${capabilityId}: ${note.slice(0, 120)}`);
    return { ...this.readiness(capabilityId), requested: true };
  }

  /** Approve everything the active version requests (owner only). Returns what was newly approved. */
  approveGrants(owner: Agent, capabilityId: string): string[] {
    requireOwner(owner);
    const by = owner.id;
    const { pendingGrants } = this.readiness(capabilityId);
    for (const g of pendingGrants) {
      const [kind, ...rest] = g.split(":");
      this.registry.approveGrant(capabilityId, kind as GrantKind, rest.join(":"), by);
      this.registry.addGrantEvent(capabilityId, "approve", g, by);
    }
    if (pendingGrants.length) this.logger(`grants approved for ${capabilityId} by ${by}: ${pendingGrants.join(", ")}`);
    this.registry.clearAccessRequests(capabilityId);
    return pendingGrants;
  }

  /** Approve one requested grant (owner only), e.g. "host:api.example.com". Must be one the active version asks for. */
  approveGrant(owner: Agent, capabilityId: string, grant: string) {
    requireOwner(owner);
    const { pendingGrants } = this.readiness(capabilityId);
    if (!pendingGrants.includes(grant)) throw new PlatformError("invalid_request", `${capabilityId} doesn't request '${grant}' (or it's already approved)`);
    const [kind, ...rest] = grant.split(":");
    this.registry.approveGrant(capabilityId, kind as GrantKind, rest.join(":"), owner.id);
    this.registry.addGrantEvent(capabilityId, "approve", grant, owner.id);
    this.logger(`grant ${grant} approved for ${capabilityId} by ${owner.id}`);
    if (!this.readiness(capabilityId).pendingGrants.length) this.registry.clearAccessRequests(capabilityId);
  }

  /** Revoke one approved grant ("secret:NAME" / "host:x"), owner only. The capability goes not ready. */
  revokeGrant(owner: Agent, capabilityId: string, grant: string) {
    requireOwner(owner);
    const [kind, ...rest] = grant.split(":");
    if (kind !== "secret" && kind !== "host" && kind !== "capability" && kind !== "model") throw new PlatformError("invalid_request", `bad grant '${grant}'`);
    this.registry.revokeGrant(capabilityId, kind, rest.join(":"));
    this.registry.addGrantEvent(capabilityId, "revoke", grant, owner.id);
    this.logger(`grant ${grant} revoked for ${capabilityId} by ${owner.id}`);
  }

  /**
   * Removing a connection's secret disconnects the account: the capabilities granted to call it
   * lose those grants too, so signing in again later doesn't quietly restore them (the owner
   * approves each again).
   */
  deleteSecret(owner: Agent, capabilityId: string, name: string) {
    requireOwner(owner);
    this.secrets.delete(capabilityId, name);
    this.d.connections.forgetHealth(capabilityId);
    this.registry.addAuthorityEvent({ actor: owner.id, action: "secret_removed", subject: name, capabilityId });
    this.logger(`secret ${name} removed for ${capabilityId} by ${owner.id}`);
    if (!isConnection(this.activeManifest(capabilityId))) return;
    for (const [holder, grant] of this.registry.grantsTo(capabilityId)) {
      this.registry.revokeGrant(holder, "capability", grant.slice("capability:".length));
      this.registry.addGrantEvent(holder, "revoke", grant, owner.id);
      this.logger(`grant ${grant} revoked for ${holder}: ${capabilityId} was disconnected`);
    }
  }

  /** Delegated agents (owner only). */
  agents(owner: Agent): AgentDetails[] {
    requireOwner(owner);
    return this.agentStore.list();
  }

  updateAgent(owner: Agent, id: string, change: { scopes?: Scope[]; capabilities?: "*" | string[] } | "revoke") {
    requireOwner(owner);
    this.agentStore.update(id, change);
    if (change === "revoke") this.registry.addAuthorityEvent({ actor: owner.id, action: "agent_revoked", subject: id });
    else {
      if (change.scopes) this.registry.addAuthorityEvent({ actor: owner.id, action: "agent_scopes", subject: id, detail: change.scopes.join(" ") });
      if (change.capabilities) this.registry.addAuthorityEvent({ actor: owner.id, action: "agent_capabilities", subject: id, detail: change.capabilities === "*" ? "*" : change.capabilities.join(" ") });
    }
    const what = change === "revoke" ? "revoked" : [change.scopes && `scopes set to ${change.scopes.join(", ") || "none"}`, change.capabilities && `capabilities set to ${change.capabilities === "*" ? "all" : change.capabilities.join(", ") || "none"}`].filter(Boolean).join(", ");
    this.logger(`agent ${id} ${what} by ${owner.id}`);
  }

  /** Agents waiting for the owner's approval (OAuth authorization requests). */
  pendingAgents(owner: Agent): PendingRequest[] {
    requireOwner(owner);
    return this.agentStore.pending();
  }

  decideAgent(owner: Agent, requestId: string, d: { approve: false } | { approve: true; name?: string; scopes?: Scope[]; capabilities?: "*" | string[] }): { agentId?: string } {
    requireOwner(owner);
    const request = this.agentStore.pending().find((p) => p.id === requestId);
    const r = this.agentStore.decide(requestId, d);
    if (d.approve) {
      const agent = this.agentStore.list().find((a) => a.id === r.agentId);
      this.registry.addAuthorityEvent({ actor: owner.id, action: "agent_connected", subject: r.agentId!, detail: `${agent?.scopes.join(" ") ?? ""}${agent && agent.capabilities !== "*" ? ` · only ${agent.capabilities.join(" ")}` : ""}${request?.via === "tunnel" ? " · via tunnel" : ""}` });
    } else this.registry.addAuthorityEvent({ actor: owner.id, action: "agent_declined", subject: request?.clientName ?? "agent" });
    this.logger(d.approve ? `agent ${r.agentId} approved (${(d.scopes ?? []).join(", ") || "requested scopes"}) by ${owner.id}` : `agent connection request declined by ${owner.id}`);
    return r;
  }

  /** Secrets stored under another key (a backup from another machine): they count as not set until set again. */
  unreadableSecrets(owner: Agent): { capabilityId: string; name: string }[] {
    requireOwner(owner);
    return (this.secrets.unreadable?.() ?? []).map((k) => ({ capabilityId: k.slice(0, k.indexOf("/")), name: k.slice(k.indexOf("/") + 1) }));
  }

  /** Store a secret the active version declares (owner only). Values never pass through agents. */
  setSecret(owner: Agent, capabilityId: string, name: string, value: string) {
    requireOwner(owner);
    const declared = (this.activeManifest(capabilityId).requires?.secrets ?? []).some((s) => s.name === name);
    if (!declared) throw new PlatformError("invalid_request", `${capabilityId} does not declare secret ${name}`);
    this.secrets.set(capabilityId, name, value);
    this.d.connections.forgetHealth(capabilityId);
    this.registry.addAuthorityEvent({ actor: owner.id, action: "secret_set", subject: name, capabilityId });
    this.logger(`secret ${name} set for ${capabilityId}`);
  }

  /**
   * Set a value for declared config (owner only). Config is not secret: agents never set it, but
   * it may be shown and exported. A value a host is derived from must name a host.
   */
  setConfig(owner: Agent, capabilityId: string, name: string, value: string) {
    requireOwner(owner);
    const m = this.activeManifest(capabilityId);
    if (!(m.config ?? []).some((c) => c.name === name)) throw new PlatformError("invalid_request", `${capabilityId} does not declare config ${name}`);
    const clean = value.trim();
    if (!clean || clean.length > 2000) throw new PlatformError("invalid_request", `${name} must be 1–2000 characters`);
    if ((m.requires?.hosts ?? []).includes(`config:${name}`) && !hostOf(clean)) throw new PlatformError("invalid_request", `${name} must be a URL or host name (its host is what ${capabilityId} may connect to)`);
    this.registry.setConfig(capabilityId, name, clean, owner.id);
    this.d.connections.forgetHealth(capabilityId);
    // The trail records what a host config lets the capability reach, not the value itself.
    const host = (m.requires?.hosts ?? []).includes(`config:${name}`) ? hostOf(clean) : null;
    this.registry.addAuthorityEvent({ actor: owner.id, action: "config_set", subject: name, capabilityId, detail: host ? `host ${host}` : `${clean.length} characters` });
    this.logger(`config ${name} set for ${capabilityId} by ${owner.id}`);
  }

  // ---------- confirmations: agents' destructive calls ----------

  /**
   * An agent's call to a destructive operation runs only once the owner confirms exactly that
   * call (same agent, operation and input). It waits a while for the decision; if none comes,
   * it fails with awaiting_confirmation and stays on the owner's list, and calling again with
   * the same input after the owner confirms goes through. A rejection is reported once.
   */
  async confirmDestructive(agent: Agent, capabilityId: string, operation: string, input: unknown, via: string[] = []) {
    const hash = sha256(JSON.stringify(input));
    const existing = this.registry.findConfirmation(agent.id, capabilityId, operation, hash);
    const take = (c: Confirmation) => {
      if (c.status === "approved") return void this.registry.setConfirmation(c.id, "used");
      this.registry.setConfirmation(c.id, "reported");
      throw new PlatformError("forbidden", `the owner rejected ${capabilityId}/${operation} with this input`);
    };
    if (existing && existing.status !== "pending") return take(existing);
    let id = existing?.id;
    if (!id) {
      if (this.registry.pendingConfirmations().length >= 50) throw new PlatformError("conflict", "too many calls are waiting for the owner's confirmation");
      id = randomToken(12);
      this.registry.addConfirmation({ id, agentId: agent.id, capabilityId, operation, inputHash: hash, input });
      this.logger(`${agent.id} asks to run destructive ${capabilityId}/${operation}${via.length ? ` (through ${via.join(" → ")})` : ""}: waiting for the owner`);
    }
    const decided = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => (this.events.off(`confirm:${id}`, done), resolve(false)), this.platform.confirmWaitMs);
      const done = () => (clearTimeout(timer), resolve(true));
      this.events.once(`confirm:${id}`, done);
    });
    const c = this.registry.getConfirmation(id)!;
    if (decided && c.status !== "pending") return take(c);
    const through = via.length ? ` (reached through ${via.join(" → ")})` : "";
    throw new PlatformError("awaiting_confirmation", `${capabilityId}/${operation}${through} is destructive: the owner must confirm it in Hewn first. Tell them; once they confirm, call it again with the same input.`, { confirmationId: id });
  }

  /** Agents' destructive calls waiting for the owner (owner only). */
  confirmations(owner: Agent): Confirmation[] {
    requireOwner(owner);
    return this.registry.pendingConfirmations();
  }

  decideConfirmation(owner: Agent, id: string, approve: boolean) {
    requireOwner(owner);
    const c = this.registry.getConfirmation(id);
    if (!c || c.status !== "pending") throw new PlatformError("not_found", "no such call waiting for confirmation");
    this.registry.setConfirmation(id, approve ? "approved" : "rejected");
    this.registry.addAuthorityEvent({ actor: owner.id, action: approve ? "destructive_confirmed" : "destructive_rejected", subject: c.agentId, capabilityId: c.capabilityId, detail: c.operation });
    this.logger(`${approve ? "confirmed" : "rejected"} ${c.agentId}'s ${c.capabilityId}/${c.operation} (by ${owner.id})`);
    this.events.emit(`confirm:${id}`);
    return { ok: true };
  }
}

/** The host name in a URL or bare host ("https://example.com/blog" → "example.com"), if valid. */
export function hostOf(value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host : undefined;
}

/** Hosts a call may reach: declared hosts, with "config:NAME" replaced by the host in that value. */
export function resolveHosts(m: CapabilityManifest, config: Record<string, string>): string[] {
  return (m.requires?.hosts ?? []).flatMap((h) => {
    if (!h.startsWith("config:")) return [h];
    const host = hostOf(config[h.slice(7)] ?? "");
    return host ? [host] : [];
  });
}

/** Every grant a manifest asks for ("secret:NAME", "host:…", "capability:id/op@v", "model:…"). */
export function wantedGrants(manifest: CapabilityManifest): string[] {
  const req = manifest.requires ?? {};
  return [
    ...(req.secrets ?? []).map((s) => `secret:${s.name}`),
    ...(req.hosts ?? []).map((h) => `host:${h}`),
    ...(req.capabilities ?? []).flatMap((c) => c.operations.map((op) => `capability:${c.id}/${op}`)),
    ...(req.model ? [modelGrant(req.model)] : []),
  ];
}
