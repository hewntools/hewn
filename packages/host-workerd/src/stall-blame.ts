// SPDX-License-Identifier: AGPL-3.0-or-later
// Who held up the tools. When the tools' process stops responding (a tool's code never yields), which calls' code may
// be what held it, as the platform can see it: whether a call started there, and whether it's waiting on Hewn (a
// callback) or on the network (a fetch out of its isolate). A wait inside a tool's isolate (a timer) can't be seen,
// and a tool can make itself look like it's waiting (a fetch or a callback it doesn't await, then a loop).
import type { Doing, StallRole } from "@hewntools/core/platform/stalls.ts";

/** A tool call running in the tools process, as the platform sees it. */
export interface CallInFlight {
  /** The call's token (its callbacks carry it). */
  token: string;
  capabilityId: string;
  /** The state it runs on: "" for the tool's own data, else the scratch state's name (as in `running_code`). */
  state: string;
  /** Its answer's headers came: it started there (else it was waiting behind whatever held the process). */
  started: boolean;
  /** The isolate it runs in (from those headers). */
  isolate?: string;
  /** Callbacks (`call`, `model`) it's waiting on. */
  waiting: number;
}

/**
 * What each call was doing. Queued: its answer's headers never came. Waiting on Hewn: a callback in progress. Waiting on
 * a fetch: its isolate has at least as many fetches out as calls there that could be waiting on one (fetches are
 * counted per isolate: with more such calls than fetches out, one of them is running, and so they all count as
 * running). Else running.
 */
export function doingOf(calls: CallInFlight[], fetchesOut: ReadonlyMap<string, number>): Map<CallInFlight, Doing> {
  const free = calls.filter((c) => c.started && c.waiting === 0);
  const perIsolate = new Map<string, number>();
  for (const c of free) if (c.isolate) perIsolate.set(c.isolate, (perIsolate.get(c.isolate) ?? 0) + 1);
  const fetching = (c: CallInFlight) => !!c.isolate && (fetchesOut.get(c.isolate) ?? 0) >= (perIsolate.get(c.isolate) ?? 0);
  return new Map(calls.map((c): [CallInFlight, Doing] => [c, !c.started ? "queued" : c.waiting > 0 ? "waiting on Hewn" : fetching(c) ? "waiting on a fetch" : "running"]));
}

/**
 * The stall's suspects (the calls that were running), and each running row's role for `recoverStall`. No suspects when
 * it can't be told: other work was running tool code (loading, migrating, reading or loading a tool's data:
 * `otherWork`), or no call was running; then every row may have caused it.
 */
export function stallRoles(calls: CallInFlight[], fetchesOut: ReadonlyMap<string, number>, otherWork: number): { suspects?: Set<string>; role: StallRole } {
  const doing = doingOf(calls, fetchesOut);
  const running = otherWork > 0 ? [] : calls.filter((c) => doing.get(c) === "running");
  const suspects = running.length ? new Set(running.map((c) => c.token)) : undefined;
  const role: StallRole = (row) => {
    const mine = calls.filter((c) => c.capabilityId === row.capabilityId && c.state === row.state);
    const what = mine.map((c) => doing.get(c)!);
    return { caused: !suspects || mine.some((c) => suspects.has(c.token)), doing: what.includes("running") ? "running" : (what[0] ?? "running") };
  };
  return { ...(suspects ? { suspects } : {}), role };
}
