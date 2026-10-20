// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plain-language reading of a build log, for the owner's build screen ("2 of 6 tests didn't pass").
 * Derived from the persisted log, so it works for old builds too. Wording is UI copy: keep it short.
 */

export interface BuildFailure {
  /** One line, e.g. "2 of 6 tests didn't pass". */
  title: string;
  /** One sentence: the first concrete cause. */
  detail: string;
  /** Builder attempts used, when the platform's builder ran it. */
  attempt?: number;
  maxAttempts?: number;
}

const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** "- foo" continuation lines of a multi-line failure message. */
const problems = (msg: string) => msg.split("\n").slice(1).map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
const first = (msg: string) => problems(msg)[0] ?? msg.split("\n")[0];
/** "test 'adds': expected {…}, got {…}" → "adds didn't return what its test expected." */
function testDetail(line: string): string {
  const m = /^test '([^']+)': ([\s\S]*)$/.exec(line);
  if (!m) return line;
  const [, name, rest] = m;
  if (/^expected an error/.test(rest)) return `${name} should have been rejected, but wasn't.`;
  if (/^expected /.test(rest)) return `${name} didn't return what its test expected.`;
  return `${name}: ${rest}`;
}

/** Passed / total test cases from the latest validation in the log. */
export function testCounts(log: string[]): { passed: number; total: number } | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const failed = /(\d+) of (\d+) test cases failed/.exec(log[i]);
    if (failed) return { passed: Number(failed[2]) - Number(failed[1]), total: Number(failed[2]) };
    const passed = /(\d+) test cases passed/.exec(log[i]);
    if (passed) return { passed: Number(passed[1]), total: Number(passed[1]) };
  }
  return undefined;
}

export function explainFailure(log: string[]): BuildFailure {
  // The cause is the last FAILED line that isn't the attempts summary.
  const failures = log.map((l, i) => ({ i, m: /FAILED: ([\s\S]*)$/.exec(l)?.[1] })).filter((x) => x.m);
  const summary = failures.map((f) => /no valid candidate after (\d+) attempts/.exec(f.m!)).find(Boolean);
  const cause = [...failures].reverse().find((f) => !/no valid candidate after/.test(f.m!))?.m;
  const attempts = log.map((l) => Number(/^attempt (\d+):/.exec(l)?.[1] ?? 0));
  const attempt = Math.max(0, ...attempts) || undefined;
  const maxAttempts = summary ? Number(summary[1]) : undefined;
  const builderFailed = [...log].reverse().map((l) => /builder (\S+) failed: (.*)$/.exec(l)).find(Boolean);
  const meta = { ...(attempt ? { attempt } : {}), ...(maxAttempts ? { maxAttempts } : {}) };

  const msg = cause ?? "";
  const say = (title: string, detail: string): BuildFailure => ({ title, detail: clip(detail), ...meta });
  if (/interrupted by platform restart/.test(msg)) return say("Interrupted by a restart", "The platform restarted while this was building.");
  const noModel = /^model unavailable: ([\s\S]*)$/.exec(msg);
  if (noModel) return say("Model not available", noModel[1].trim());
  const refused = /^refused: ([\s\S]*)$/.exec(msg);
  if (refused) return say("Not built", refused[1].trim() || "The builder declined it.");
  if (/is unavailable/.test(msg)) {
    const name = /builder (\S+) is unavailable/.exec(msg)?.[1] ?? "The builder";
    return say("The builder isn't available", `${name} couldn't start. Check that it's installed and signed in.`);
  }
  const tests = /(\d+) of (\d+) test cases failed/.exec(msg);
  if (tests) return say(`${tests[1]} of ${tests[2]} tests didn't pass`, testDetail(first(msg)));
  if (/^test '/.test(msg)) return say("A test didn't pass", testDetail(msg));
  if (/must contain at least one case/.test(msg)) return say("It came without tests", "The builder didn't write any test cases.");
  if (/^UI didn't render cleanly/.test(msg)) return say("Its screen shows errors", first(msg));
  if (/^manifest invalid/.test(msg)) return say("Its description is invalid", first(msg));
  if (/capability\.json/.test(msg)) return say("The build produced nothing usable", first(msg));
  if (/does not export declared operations/.test(msg)) return say("Some operations are missing", `Not implemented: ${problems(msg).join(", ")}.`);
  if (/breaking change/.test(msg)) return say("It would break existing callers", first(msg));
  if (/requires\.capabilities/.test(msg)) return say("It needs operations that don't exist", first(msg));
  if (/migrations rejected/.test(msg)) return say("Its data changes were rejected", first(msg));
  if (/capability changed since this build started/.test(msg)) return say("The capability changed meanwhile", "Another version was promoted while this one was building.");
  if (!cause && builderFailed) return say("The builder stopped", builderFailed[2]);
  if (msg) return say("The build didn't pass", first(msg));
  return say("The build didn't pass", "No cause was recorded.");
}
