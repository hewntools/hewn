// SPDX-License-Identifier: Apache-2.0
// tests/cases.json: the cases a host runs against a new version before promoting it. Validation
// never touches real secrets, other tools or models: each case brings fakes.

export interface TestCase {
  name: string;
  operation: string;
  /** The operation's version; default the latest in the manifest. */
  version?: number;
  input?: unknown;
  /** Fake secret values for this case. */
  secrets?: Record<string, string>;
  /** Fake config values for this case (ABI 2.1). */
  config?: Record<string, string>;
  /** Mocked callee outputs, keyed "capability-id/operation@version". */
  calls?: Record<string, unknown>;
  /** Fake `ctx.model` replies, served in order (ABI 2.2). */
  model?: ({ text?: string; json?: unknown } | { error: string })[];
  /** Subset match on the output: every key here must match; "$any" matches any present value. */
  expect?: unknown;
  /** The operation must throw. */
  expectError?: boolean;
}
