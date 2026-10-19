// SPDX-License-Identifier: AGPL-3.0-or-later
// How setup reaches the local agent harnesses (real, or faked in tests).
import { homedir } from "node:os";
import type { LoginRunner } from "./connect.ts";
import type { Harness } from "./harnesses.ts";

export interface SetupHooks {
  harnesses: () => Harness[];
  /** Runs the harness's OAuth login (default: the real command). */
  login?: LoginRunner;
  /** User's home directory (agent config and shell profile files). */
  userHome: string;
  /** Whether a desktop app is installed (default: /Applications or ~/Applications on macOS). */
  appInstalled?: (name: string) => boolean;
}

export const realSetupHooks = async (): Promise<SetupHooks> => {
  const { harnesses } = await import("./harnesses.ts");
  return { harnesses: () => harnesses(), userHome: homedir() };
};

