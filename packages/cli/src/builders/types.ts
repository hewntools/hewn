// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BuildNote } from "@hewntools/core/ports.ts";
import type { BuildKind } from "@hewntools/core/registry.ts";

export interface BuildJob {
  buildId: string;
  capabilityId: string;
  kind: BuildKind;
  /** The only directory the builder may change. Contains BUILDER.md. */
  workspace: string;
  attempt: number;
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
  /** Something the owner should know about the run (it fell back to the default model). */
  onNote?: (note: BuildNote) => void;
}

export type { BuildNote } from "@hewntools/core/ports.ts";

/**
 * Turns a build request into a candidate implementation in the workspace.
 * A builder never validates, promotes, or talks to the platform. It writes files and returns.
 */
export interface CapabilityBuilder {
  name: string;
  build(job: BuildJob): Promise<void>;
}
