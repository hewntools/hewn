// SPDX-License-Identifier: AGPL-3.0-or-later
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
}

/**
 * Turns a build request into a candidate implementation in the workspace.
 * A builder never validates, promotes, or talks to the platform. It writes files and returns.
 */
export interface CapabilityBuilder {
  name: string;
  build(job: BuildJob): Promise<void>;
}
