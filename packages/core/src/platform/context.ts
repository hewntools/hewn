// SPDX-License-Identifier: AGPL-3.0-or-later
// What the platform's domains share. Platform (../platform.ts) is the facade every surface calls;
// each domain in this folder extends Domain and gets, once, the facade, the ports, the event bus,
// the cache of loaded versions and the other domains.
import type { AgentStore } from "../agents.ts";
import { type Agent, canSee } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { contentHash, decodeVersion } from "../files.ts";
import type { CapabilityManifest } from "../manifest.ts";
import type { Blobs, CapabilityRuntime, CodeRef, Files, SecretStore, Workbench } from "../ports.ts";
import type { BuildRow, Registry, VersionRow } from "../registry.ts";
import type { ScheduleStore } from "../schedules.ts";
import type { Discovery } from "./discovery.ts";
import type { Presentation } from "./presentation.ts";
import type { Data } from "./data.ts";
import type { Sessions } from "./sessions.ts";
import type { Attachments } from "./attachments.ts";
import type { Instructions } from "./instructions.ts";
import type { Grants } from "./grants.ts";
import type { Connections } from "./connections.ts";
import type { Models } from "./models.ts";
import type { Invocation } from "./invocation.ts";
import type { Schedules } from "./schedules.ts";
import type { Builds } from "./builds.ts";
import type { Validation } from "./validation.ts";
import type { Widgets } from "./widgets.ts";
import type { Housekeeping } from "./housekeeping.ts";
import type { Platform } from "../platform.ts";

/** Minimal event emitter (no node:events in the core). */
export class Events {
  private handlers = new Map<string, Set<(arg: any) => void>>();
  on(name: string, fn: (arg: any) => void) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(fn);
  }
  off(name: string, fn: (arg: any) => void) {
    this.handlers.get(name)?.delete(fn);
  }
  once(name: string, fn: (arg: any) => void) {
    const wrap = (arg: any) => (this.off(name, wrap), fn(arg));
    this.on(name, wrap);
  }
  emit(name: string, arg?: unknown) {
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(arg);
  }
}

export interface LoadedVersion {
  row: VersionRow;
  files: Files;
  code: CodeRef;
}

/** One of each domain, set up by Platform's constructor. */
export interface Domains {
  attachments: Attachments;
  builds: Builds;
  connections: Connections;
  data: Data;
  discovery: Discovery;
  grants: Grants;
  housekeeping: Housekeeping;
  instructions: Instructions;
  invocation: Invocation;
  models: Models;
  presentation: Presentation;
  schedules: Schedules;
  sessions: Sessions;
  validation: Validation;
  widgets: Widgets;
}

/** What Platform hands each domain. */
export interface Shared {
  platform: Platform;
  /** Per-build live events: `${buildId}` → line; `${buildId}:done` → final view. */
  events: Events;
  /** Verified, decoded versions by content hash (immutable, so safe to keep). */
  loaded: Map<string, { files: Files; bundle: string }>;
  d: Domains;
}

/**
 * The base of every domain: the ports (Platform's own), the event bus, the loaded versions, and the
 * lookups they all make. A domain calls another's public methods through the facade
 * (`this.platform.readiness()`), as Platform's own `this.readiness()` did, so a wrapper put on a
 * Platform method still sees every call from another domain (a domain's calls to its own methods
 * stay inside it); what Platform doesn't offer it reaches through `this.d`
 * (`this.d.grants.offers()`). Settings a host or a test may change after start (`confirmWaitMs`,
 * `heartbeatMs` …) are read from the facade each time.
 */
export class Domain {
  protected platform: Platform;
  protected d: Domains;
  protected registry: Registry;
  protected blobs: Blobs;
  protected runtime: CapabilityRuntime;
  protected workbench: Workbench;
  protected agentStore: AgentStore;
  protected secrets: SecretStore;
  protected schedules: ScheduleStore;
  protected logger: (message: string) => void;
  protected events: Events;
  protected loaded: Map<string, { files: Files; bundle: string }>;

  constructor(s: Shared) {
    const p = (this.platform = s.platform);
    this.d = s.d;
    this.registry = p.registry;
    this.blobs = p.blobs;
    this.runtime = p.runtime;
    this.workbench = p.workbench;
    this.agentStore = p.agentStore;
    this.secrets = p.secrets;
    this.schedules = p.schedules;
    this.logger = p.logger;
    this.events = s.events;
    this.loaded = s.loaded;
  }

  /** A stored version, its integrity checked against the hash it was promoted with. */
  async loadVersion(capabilityId: string, version: number): Promise<LoadedVersion> {
    const row = this.registry.getVersion(capabilityId, version);
    if (!row) throw new PlatformError("not_found", `${capabilityId} has no version ${version}`);
    let v = this.loaded.get(row.contentHash);
    if (!v) {
      const raw = await this.blobs.get(`versions/${row.contentHash}.json`);
      if (!raw) throw new PlatformError("operation_failed", `v${version} of ${capabilityId} is missing from storage`);
      let decoded: { files: Files; bundle: string };
      try {
        decoded = decodeVersion(raw);
      } catch {
        throw new PlatformError("operation_failed", `v${version} of ${capabilityId} failed its integrity check`);
      }
      if (contentHash(decoded.files, decoded.bundle) !== row.contentHash) {
        throw new PlatformError("operation_failed", `v${version} of ${capabilityId} failed its integrity check`);
      }
      this.loaded.set(row.contentHash, (v = decoded));
    }
    return { row, files: v.files, code: { hash: row.contentHash, js: v.bundle } };
  }

  protected visibleActive(agent: Agent, capabilityId: string) {
    const cap = this.registry.getCapability(capabilityId);
    if (!cap || cap.activeVersion === null || cap.archivedAt || !canSee(agent, cap.id)) {
      throw new PlatformError("not_found", `no capability '${capabilityId}'`);
    }
    return cap;
  }

  activeManifest(capabilityId: string): CapabilityManifest {
    const cap = this.registry.getCapability(capabilityId)!;
    return this.registry.getVersion(capabilityId, cap.activeVersion!)!.manifest;
  }

  protected mustBuild(buildId: string): BuildRow {
    const build = this.registry.getBuild(buildId);
    if (!build) throw new PlatformError("not_found", `no build '${buildId}'`);
    return build;
  }
}
