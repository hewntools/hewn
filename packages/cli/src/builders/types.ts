// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BuildKind } from "@hewntools/core/registry.ts";
import type { CheckResult } from "@hewntools/core/ports.ts";

export interface BuildJob {
  buildId: string;
  capabilityId: string;
  kind: BuildKind;
  /** The only directory the builder may change. Contains BUILDER.md. */
  workspace: string;
  attempt: number;
  /** The first build of the chain this one retries. Unset: not a retry. */
  retryOf?: string;
  /** Validation log from the previous attempt, if it failed. */
  feedback?: string;
  /** Append-only, human-readable transcript for this build, outside the workspace. */
  logPath: string;
  /** Called with each new activity line (e.g. "→ Edit src/index.ts"). */
  onActivity?: (line: string) => void;
  /** Builder name (for messages). */
  builderName?: string;
  /** Platform home: confined builders may not read it (except the workspace). Unset = unconfined. */
  platformRoot?: string;
  /** Aborted when the owner (or requester) cancels the build: stop and return/throw promptly. */
  signal?: AbortSignal;
  /** The model to build with, as the CLI takes it (an alias or a full name). Unset: the CLI's default. */
  model?: string;
  /** Reasoning effort, as the CLI names it. Unset: the model's default. */
  effort?: string;
  /** The model the run actually used (a family resolves to a full name), when the CLI says. */
  onModel?: (model: string) => void;
  /** What the builder's host charged for this attempt (the remote builder). */
  onCharge?: (charge: { amount: number; unit: string }) => void;
  /** Check the workspace as validation will, without promoting: the builder's `check` tool. Unset: not offered. */
  check?: (id: string) => Promise<CheckResult>;
}

/**
 * Turns a build request into a candidate implementation in the workspace.
 * A builder never validates, promotes, or talks to the platform. It writes files and returns (and
 * may check its work as it goes, through `check`).
 */
export interface CapabilityBuilder {
  name: string;
  build(job: BuildJob): Promise<void>;
}
