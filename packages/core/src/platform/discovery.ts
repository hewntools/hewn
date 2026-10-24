// SPDX-License-Identifier: AGPL-3.0-or-later
// Discovery: the capabilities an agent (or the owner) can see, and what each offers.
import { type Agent, canSee, requireScope } from "../auth.ts";
import { abiAtLeast, type CapabilityManifest, isConnection, opKey } from "../manifest.ts";
import type { Readiness } from "./grants.ts";
import { Domain } from "./context.ts";

export interface CapabilitySummary {
  id: string;
  name: string;
  purpose: string;
  tags: string[];
  operations: string[];
  /** False until the user has provided required secrets and approved requested grants. */
  ready: boolean;
  /** Set for connections: they wrap an external service and hold its credentials. */
  kind?: "connection";
  /** Widget names (ABI 2.3), for widgets_show. */
  widgets?: string[];
}

export class Discovery extends Domain {
  list(agent: Agent, filter: { name?: string; operation?: string; tag?: string } = {}): CapabilitySummary[] {
    requireScope(agent, "discover");
    return this.registry
      .listActiveCapabilities()
      .filter((c) => canSee(agent, c.id))
      .map((c) => this.summary(this.activeManifest(c.id)))
      .filter(
        (s) =>
          (!filter.name || `${s.id} ${s.name}`.toLowerCase().includes(filter.name.toLowerCase())) &&
          (!filter.operation || s.operations.some((o) => o.split("@")[0] === filter.operation)) &&
          (!filter.tag || s.tags.includes(filter.tag)),
      );
  }

  get(agent: Agent, capabilityId: string): CapabilityManifest & { status: Readiness } {
    requireScope(agent, "discover");
    const cap = this.visibleActive(agent, capabilityId);
    const m = this.activeManifest(capabilityId);
    return { ...m, name: cap.displayName ?? m.name, status: this.platform.readiness(capabilityId) };
  }

  private summary(m: CapabilityManifest): CapabilitySummary {
    return {
      id: m.id,
      name: this.registry.getCapability(m.id)?.displayName ?? m.name,
      purpose: m.purpose,
      tags: m.tags ?? [],
      operations: m.operations.map((o) => `${opKey(o.name, o.version)}${o.deprecated ? ` (deprecated${o.deprecated.replacement ? ` → ${o.deprecated.replacement}` : ""})` : ""}`),
      ready: this.platform.readiness(m.id).ready,
      ...(isConnection(m) ? { kind: "connection" as const } : {}),
      ...(m.widgets?.length && abiAtLeast(m, "2.3") ? { widgets: m.widgets.map((w) => w.name) } : {}),
    };
  }
}
