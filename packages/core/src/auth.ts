// SPDX-License-Identifier: AGPL-3.0-or-later
import { PlatformError } from "./errors.ts";

import { SCOPES, type Scope } from "@hewntools/spec/agents.ts";
export { SCOPES, type Scope };

/**
 * Principal kinds. "user" is the owner acting directly (local CLI, web session);
 * "agent" is a delegated MCP client; "ui" is a capability UI; "widget" is a widget on Home
 * (read-only, one operation). Owner-only actions require "user".
 */
export type PrincipalKind = "user" | "agent" | "ui" | "capability" | "schedule" | "widget";

export interface Agent {
  id: string;
  kind: PrincipalKind;
  scopes: ReadonlySet<Scope>;
  /** Capability ids this agent may see, or "*" for all. */
  capabilities: "*" | ReadonlySet<string>;
}

export interface AgentInfo {
  id: string;
  scopes: Scope[];
  capabilities: "*" | string[];
}

/** The user is root authority. Only local admin tooling (the CLI) acts as the user. */
export const USER: Agent = { id: "user", kind: "user", scopes: new Set(SCOPES), capabilities: "*" };

/** The owner in a web session (logged as "web"). */
export const WEB_USER: Agent = { id: "web", kind: "user", scopes: new Set(SCOPES), capabilities: "*" };

export function requireScope(agent: Agent, ...anyOf: Scope[]): void {
  if (!anyOf.some((s) => agent.scopes.has(s))) {
    throw new PlatformError("forbidden", `agent '${agent.id}' lacks scope: ${anyOf.join(" or ")}`);
  }
}

/** Owner-only: grants, secrets, delegated agents. Never reachable by agents, whatever their scopes. */
export function requireOwner(principal: Agent): void {
  if (principal.kind !== "user") throw new PlatformError("forbidden", `'${principal.id}' cannot perform owner actions`);
}

export function canSee(agent: Agent, capabilityId: string): boolean {
  return agent.capabilities === "*" || agent.capabilities.has(capabilityId);
}

export function validScopes(scopes: string[]): Scope[] {
  const bad = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new PlatformError("invalid_request", `unknown scopes: ${bad.join(", ")}`);
  return scopes as Scope[];
}
