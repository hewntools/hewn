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
  /** Not a failure: the builder's host paused it part-way with its work kept, for the owner to Continue (a retry) or Stop. */
  paused?: true;
  /**
   * Hewn's checks on a copy stopped it for the tool's data: it would have lost rows (the no-loss check), a migration
   * didn't apply to the data it holds, or an operation deletes rows without saying so. The build-quality count of how
   * often the copy saved the owner's data.
   */
  caught?: true;
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

/** The steps a new tool's passes show as (the build page's words), for a failure in one of them. */
const PASS_STEPS: Record<string, string> = { critique: "Reviewing the design", craft: "Fixing details" };

/**
 * Why a build failed, from its log. A failure in one of a new tool's passes after its tests says which
 * ("Reviewing the design: 1 of 6 tests didn't pass").
 */
export function explainFailure(log: string[]): BuildFailure {
  const f = explainLog(log);
  if (f.paused) return f;
  const last = [...log].reverse().find((l) => /^(FAILED|PAUSED): /.test(l)) ?? "";
  const cause = [...log].reverse().find((l) => /FAILED: /.test(l) && !/no valid candidate after/.test(l)) ?? "";
  const pass = / of the (critique|craft) pass$/.exec(last)?.[1] ?? /^(critique|craft) pass\b/.exec(cause)?.[1];
  return pass ? { ...f, title: `${PASS_STEPS[pass]}: ${f.title}` } : f;
}

function explainLog(log: string[]): BuildFailure {
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
  // Paused by the builder's host (the last word on the build): its own message says why and what's kept.
  const last = [...log].reverse().find((l) => /^(FAILED|PAUSED): /.test(l));
  if (last?.startsWith("PAUSED: ")) return { ...say("Paused", last.slice("PAUSED: ".length).trim() || "The builder paused it."), paused: true };
  if (/interrupted by platform restart; not started again: schedules are off/.test(msg)) return say("Interrupted by a restart", "Hewn restarted before this finished, and didn't start it again: schedules are off in this Hewn (a copy), so it starts no build by itself.");
  if (/interrupted by platform restart/.test(msg)) return say("Interrupted by a restart", "The platform restarted while this was building.");
  // The stall rule (since 0.4.13): the operation and what it ran on, as validation said it.
  const stalled = /^(.+ worked for more than \d+ seconds without a pause.*?), so Hewn's tools were restarted/.exec(msg);
  if (stalled) return say("It worked too long without a pause", `${clip(stalled[1], 110)}, so Hewn's tools were restarted. Split the work across calls. It wasn't tried again: it would do the same.`);
  // Builds failed before 0.4.13 say "kept Hewn's tools from responding", and before 0.4.12 "kept Hewn from responding".
  const hung = /^its code kept Hewn(?:'s tools)? from responding \((.+)\)/.exec(msg);
  if (hung) return say("Its code kept Hewn's tools from responding", `${hung[1][0].toUpperCase()}${hung[1].slice(1)} never let go (an endless loop?), so Hewn's tools were restarted. It wasn't tried again: it would do the same.`);
  const noModel = /^model unavailable: ([\s\S]*)$/.exec(msg);
  if (noModel) return say("Model not available", noModel[1].trim());
  const refused = /^refused: ([\s\S]*)$/.exec(msg);
  if (refused) return say("Not built", refused[1].trim() || "The builder declined it.");
  if (/is unavailable/.test(msg)) {
    const name = /builder (\S+) is unavailable/.exec(msg)?.[1] ?? "The builder";
    return say("The builder isn't available", `${name} couldn't start. Check that it's installed and signed in.`);
  }
  // An agent's build told only that (the owner's build log has which rows): still the copy saving the owner's data.
  if (/^the migrations would lose data on a copy of the tool's data: rows would be gone/.test(msg)) return { ...say("Stopped before it went live", "Rows of the tool's data would have been lost or changed their keys; its build log says which."), caught: true };
  // Caught on a copy: what the tool's data would have suffered, in words.
  const lost = /would lose data on /.test(msg) ? first(msg) : "";
  if (lost) {
    const table = /^`([^`]+)` would lose (\d+) of its/.exec(lost);
    const total = /^(\d+) fewer rows across/.exec(lost);
    const read = /^(\S+) would no longer return (\d+) of the/.exec(lost);
    const words = table ? `${table[2]} ${table[2] === "1" ? "row" : "rows"} of ${table[1]} would have been lost.` : total ? `${total[1]} rows would have been lost.` : read ? `${read[1]} would no longer have returned ${read[2]} of its records.` : `${lost}.`;
    return { ...say("Stopped before it went live", words), caught: true };
  }
  // On the old version's sample data (Hewn holds none of the tool's): the migration's fault, but no data was at risk.
  const sampleRun = /^the upgrade dry run failed on its sample data in the version it replaces: ([\s\S]*)$/.exec(msg);
  if (sampleRun) return say("A migration didn't apply", `To the tool's sample data: ${first(sampleRun[1])}`);
  const dryRun = /^the upgrade dry run failed: ([\s\S]*)$/.exec(msg);
  if (dryRun) return { ...say("Stopped before it went live", `A migration didn't apply to the data the tool holds now: ${first(dryRun[1])}`), caught: true };
  if (/the upgrade dry run failed/.test(msg)) return { ...say("Stopped before it went live", "A migration didn't apply to the data the tool holds now."), caught: true };
  const deletes = /(\S+) leaves .+ with fewer rows and adds none: declare it destructive/.exec(msg);
  if (deletes) return { ...say("Stopped before it went live", `${deletes[1]} deletes rows without saying so: it must be declared destructive, so the owner confirms it.`), caught: true };
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
