// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's builder and intake run by the host (HEWN_BUILD_URL), on its own model keys: the host can run
// them elsewhere, so this Hewn holds no model key, only its token for the service. The protocol is in
// docs/internal/remote-builder.md. Validation, tests and promotion stay in Hewn, as for any builder.
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fromBase64, isArtefact, toBase64 } from "@hewntools/core/files.ts";
import { builderPrompt } from "./cli.ts";
import type { BuildJob, CapabilityBuilder } from "./types.ts";
import { readTree, writeTree } from "../workbench.ts";
import { intakePrompt, parseIntake, partialReply, SCHEMA } from "../intake.ts";
import type { Intake } from "../intake.ts";
import type { JobModel } from "@hewntools/host-workerd/surface/host.ts";

export interface RemoteJobs {
  /** The service's base URL, e.g. https://builds.example.com/ (HEWN_BUILD_URL). */
  url: string;
  /** This Hewn's token for it (HEWN_BUILD_TOKEN): the only credential the cell holds. */
  token: string;
  /** What the owner sees it called (HEWN_BUILD_NAME). */
  label: string;
  fetch?: typeof fetch;
}

/** The remote builder and intake, when the environment names a service. */
export function remoteJobsFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteJobs | undefined {
  if (!env.HEWN_BUILD_URL) return undefined;
  // The token goes with every request: https, except to this machine (a service beside Hewn, tests).
  const url = URL.canParse(env.HEWN_BUILD_URL) ? new URL(env.HEWN_BUILD_URL) : undefined;
  const local = url && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && local))) throw new Error("HEWN_BUILD_URL must be an https URL (http only to localhost)");
  return { url: env.HEWN_BUILD_URL, token: env.HEWN_BUILD_TOKEN ?? "", label: env.HEWN_BUILD_NAME || "Remote builder" };
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const endpoint = (r: RemoteJobs, path: string) => new URL(path, r.url.endsWith("/") ? r.url : `${r.url}/`);

/** A service failure: refused (it declined, e.g. over quota) or unavailable (bad token, gone) never retry. */
const failure = (message: string, kind?: "refused" | "unavailable") => Object.assign(new Error(message), kind ? { [kind]: true } : {});

/** A path the service may write: relative, inside the workspace, and not an artefact (node_modules …). */
const writable = (p: string) => !!p && !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === "" || s === "." || s === "..") && !isArtefact(p);

/**
 * POST a JSON body and read the NDJSON events back as they come. A refusal may also arrive as the
 * status (402, 403 or 429 with `{ "refused": "…" }`).
 */
async function stream(r: RemoteJobs, path: string, body: unknown, onEvent: (e: Record<string, any>) => void, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await (r.fetch ?? fetch)(endpoint(r, path), { method: "POST", headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
    throw new Error(`${r.label} couldn't be reached: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (typeof j.refused === "string") throw failure(j.refused, "refused");
    if (res.status === 401 || res.status === 403) throw failure(`${r.label} didn't accept this Hewn's token (HTTP ${res.status})`, "unavailable");
    throw new Error(`${r.label}: HTTP ${res.status}${typeof j.error === "string" ? `: ${j.error}` : ""}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read().catch((e) => {
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
      throw new Error(`${r.label} went away mid-way: ${(e as Error).message}`);
    });
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      let e: Record<string, any>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      onEvent(e);
    }
  }
  if (pending.trim()) {
    try {
      onEvent(JSON.parse(pending));
    } catch {
      // a torn last line
    }
  }
}

/**
 * The builder: the workspace goes to the service, the builder's activity streams back into the
 * transcript, and the workspace it returns replaces this one. Then Hewn validates it as always.
 */
export function remoteBuilder(r: RemoteJobs): CapabilityBuilder {
  return {
    name: "remote",
    build: async (job: BuildJob) => {
      const write = (line: string) => appendFileSync(job.logPath, `${stamp()} ${line}\n`);
      write(`===== attempt ${job.attempt}: ${r.label} =====`);
      const files = Object.fromEntries(Object.entries(readTree(job.workspace)).map(([p, b]) => [p, toBase64(b)]));
      let result: Record<string, string> | undefined;
      let error: Record<string, any> | undefined;
      let done = false;
      await stream(
        r,
        "v1/builds",
        { buildId: job.buildId, capabilityId: job.capabilityId, kind: job.kind, attempt: job.attempt, ...(job.feedback ? { feedback: job.feedback } : {}), ...(job.model ? { model: job.model } : {}), ...(job.effort ? { effort: job.effort } : {}), prompt: builderPrompt(job), files },
        (e) => {
          if (typeof e.activity === "string") {
            write(e.activity);
            job.onActivity?.(e.activity);
          }
          if (typeof e.model === "string") job.onModel?.(e.model);
          // What the host charged for this attempt, in its own unit; shown as given.
          if (e.charge && typeof e.charge.amount === "number" && typeof e.charge.unit === "string") job.onCharge?.({ amount: e.charge.amount, unit: e.charge.unit });
          // One file mid-build (the icon, written first), so Home and the build page show it while it builds.
          // The final `files` event still replaces the whole tree.
          if (e.file && typeof e.file.path === "string" && typeof e.file.content === "string" && writable(e.file.path)) writeTree(job.workspace, { [e.file.path]: fromBase64(e.file.content) });
          if (e.files && typeof e.files === "object") result = e.files;
          if (e.done === true) done = true;
          if (typeof e.refused === "string") error = { refused: e.refused };
          else if (typeof e.error === "string") error = e;
        },
        job.signal,
      );
      if (error?.refused) throw failure(error.refused, "refused");
      if (error) throw failure(error.error, error.unavailable ? "unavailable" : undefined);
      // The stream closing early (the service crashed, a proxy cut it) isn't a finished build.
      if (!done) throw new Error(`${r.label} ended without finishing`);
      if (!result) throw new Error(`${r.label} finished without returning the workspace`);
      // Every path checked before anything is written: relative, inside the workspace, no artefacts.
      const returned = new Map<string, Uint8Array>();
      for (const [p, b] of Object.entries(result)) {
        if (typeof b !== "string" || !writable(p)) throw new Error(`${r.label} returned a path Hewn won't write: ${p.slice(0, 120)}`);
        returned.set(p, fromBase64(b));
      }
      // The returned tree is the whole candidate: files it doesn't list are gone.
      for (const p of Object.keys(readTree(job.workspace))) if (!returned.has(p)) rmSync(join(job.workspace, p), { force: true });
      writeTree(job.workspace, Object.fromEntries(returned));
    },
  };
}

/**
 * The intake: one session per conversation (`session`), each turn a request whose answer streams
 * back as it is written. Hewn writes the prompt and reads the reply, as with a local CLI; the service
 * runs the model on its keys, with web lookup.
 */
export function remoteIntake(r: RemoteJobs, run: JobModel = {}): Intake {
  return async (req, onProgress, signal) => {
    let text = "";
    let result: string | undefined;
    let error: Record<string, any> | undefined;
    await stream(
      r,
      "v1/intake",
      { session: req.session ?? null, mode: req.mode, prompt: intakePrompt(req, { web: true }), schema: SCHEMA, ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) },
      (e) => {
        if (typeof e.text === "string") {
          text += e.text;
          onProgress?.(partialReply(text));
        }
        if (typeof e.activity === "string") onProgress?.({ activity: e.activity });
        if (typeof e.result === "string") result = e.result;
        if (typeof e.refused === "string") error = { refused: e.refused };
        else if (typeof e.error === "string") error = e;
      },
      signal,
    );
    if (error?.refused) throw failure(error.refused, "refused");
    if (error) throw failure(`intake failed: ${error.error}`, error.unavailable ? "unavailable" : undefined);
    if (!result) throw new Error(`intake failed: ${r.label} returned no reply`);
    return parseIntake(result, req.mode, req.current);
  };
}
