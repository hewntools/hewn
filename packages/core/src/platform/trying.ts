// SPDX-License-Identifier: AGPL-3.0-or-later
// Try it: a held build's screen in the owner's hands before they decide, on a fresh copy of their data. The copy is a
// scratch state of the tool (`try:<build>`), read-write, with exactly what validation gives the candidate (no hosts,
// no stored secrets or settings, no other tools, no model); no schedule ever runs on it (schedules run on the live
// state only). It goes when the owner decides (approve, turn down, a fix replacing the build) or an hour after it
// was opened, by the wall clock, so a Hewn suspended past the hour drops it before serving anything from it.
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { text } from "../files.ts";
import { type CapabilityManifest, opKey } from "../manifest.ts";
import { migrationsOf } from "../migrations.ts";
import type { CodeRef, StateRef } from "../ports.ts";
import { randomToken, sha256 } from "../sha256.ts";
import { Domain } from "./context.ts";
import { resolveOperation } from "./invocation.ts";

/** How long a Try it lasts, by the wall clock. */
export const TRY_MS = 3600_000;
/**
 * The open Try its, by build: when each ends, the key of its address, and its own tickets (hash → when it expires)
 * and sessions (hashes). Not the tools' UI sessions: one of those opens the live tool, and a Try it's must not.
 */
const OPEN = "try:open";
type OneTry = { capabilityId: string; startedAt: number; endsAt: number; key: string; tickets: Record<string, number>; sessions: string[] };
type Open = Record<string, OneTry>;
/** A Try it's tickets last two minutes; its sessions as long as it does. */
const TICKET_MS = 120_000;
const stateOf = (capabilityId: string, buildId: string): StateRef => ({ capabilityId, scratch: `try:${buildId}` });

export class Trying extends Domain {
  private open(): Open {
    return this.registry.getKv<Open>(OPEN) ?? {};
  }

  /** The Try it of a build, if it's open and within its hour; one past it ends here, before anything is served. */
  private async alive(buildId: string, now = Date.now()) {
    const t = this.open()[buildId];
    if (!t) return undefined;
    if (now < t.endsAt) return t;
    await this.end(buildId, "its hour was up");
    return undefined;
  }

  /** The held build and its candidate: what Try it runs. */
  private async candidate(buildId: string) {
    const b = this.mustBuild(buildId);
    if (b.status !== "review" || !b.review) throw new PlatformError("conflict", `build ${buildId} isn't waiting for your review`);
    const v = await this.d.builds.loadCandidate(b.review.contentHash);
    const manifest = JSON.parse(text(v.files["capability.json"])) as CapabilityManifest;
    return { b, files: v.files, manifest, code: { hash: b.review.contentHash, js: v.bundle } as CodeRef };
  }

  /**
   * Open (or go on with) a held build's Try it: a copy of the tool's own data as it is now (none for a new tool), with
   * the candidate's migrations applied. Returns a one-time ticket for its address and when it ends.
   */
  async start(owner: Agent, buildId: string): Promise<{ ticket: string; key: string; endsAt: number }> {
    requireOwner(owner);
    const { b, manifest, files, code } = await this.candidate(buildId);
    if (!manifest.ui?.available) throw new PlatformError("conflict", "it has no screen to try");
    let t = await this.alive(buildId);
    if (!t) {
      const state = stateOf(b.capabilityId, buildId);
      await this.runtime.dropState(state);
      if (b.kind !== "create" && (await this.runtime.hasState({ capabilityId: b.capabilityId }))) await this.runtime.copyState({ capabilityId: b.capabilityId }, state);
      await this.runtime.migrate(state, migrationsOf(files), code);
      const now = Date.now();
      t = { capabilityId: b.capabilityId, startedAt: now, endsAt: now + TRY_MS, key: randomToken(16), tickets: {}, sessions: [] };
      this.logger(`build ${buildId}: Try it opened on a copy of ${b.capabilityId}'s data, until ${new Date(t.endsAt).toISOString()}`);
    }
    const ticket = randomToken();
    const now = Date.now();
    // Tickets not used in time go as the next one is made.
    const tickets = Object.fromEntries(Object.entries(t.tickets).filter(([, until]) => until > now));
    this.save(buildId, { ...t, tickets: { ...tickets, [sha256(ticket)]: now + TICKET_MS } });
    return { ticket, key: t.key, endsAt: t.endsAt };
  }

  private save(buildId: string, t: OneTry) {
    this.registry.setKv(OPEN, { ...this.open(), [buildId]: t });
  }

  /** The page's way in: a ticket (used once) for a session as long as the Try it. */
  async redeem(ticket: string, buildId: string): Promise<string | undefined> {
    const t = await this.alive(buildId);
    const hash = sha256(ticket);
    if (!t || !((t.tickets[hash] ?? 0) > Date.now())) return undefined;
    const { [hash]: _used, ...tickets } = t.tickets;
    const session = randomToken();
    this.save(buildId, { ...t, tickets, sessions: [...t.sessions, sha256(session)] });
    return session;
  }

  /** The key of an open Try it's address (`/try/<build>/~<key>/`). */
  async key(buildId: string): Promise<string | undefined> {
    return (await this.alive(buildId))?.key;
  }

  /** Whether a session is this Try it's. */
  async signedIn(session: string | undefined, buildId: string): Promise<boolean> {
    const t = session ? await this.alive(buildId) : undefined;
    return !!t && t.sessions.includes(sha256(session!));
  }

  /** One of the candidate's screen files. */
  async file(buildId: string, path: string): Promise<{ path: string; data: Uint8Array } | undefined> {
    if (!(await this.alive(buildId))) return undefined;
    const rel = path === "/" || path === "" ? "index.html" : path.replace(/^\/+/, "");
    if (rel.split("/").some((part) => part === ".." || part === "." || part === "")) return undefined;
    const data = (await this.candidate(buildId)).files[`ui/${rel}`];
    return data ? { path: rel, data } : undefined;
  }

  /** The candidate's manifest, as the screen asks for it. */
  async manifest(buildId: string): Promise<CapabilityManifest> {
    if (!(await this.alive(buildId))) throw new PlatformError("not_found", "this Try it has ended");
    return (await this.candidate(buildId)).manifest;
  }

  /**
   * A call from the screen, on the copy, with what validation gives the candidate: settings and secrets it declares
   * get placeholder values, nothing reaches out (no hosts, other tools or model). It counts as the owner's activity
   * while it runs; it never asks for a backup (the copy isn't kept).
   */
  async invoke(buildId: string, req: { operation: string; operationVersion?: number; input?: unknown }) {
    const t = await this.alive(buildId);
    if (!t) throw new PlatformError("not_found", "this Try it has ended");
    const { manifest, code } = await this.candidate(buildId);
    const op = resolveOperation(manifest, req.operation, req.operationVersion);
    const placeholder = (names: { name: string }[] | undefined) => Object.fromEntries((names ?? []).map((x) => [x.name, "try-it"]));
    const end = this.platform.activity.call();
    try {
      const out = await this.d.invocation.execute(
        manifest,
        { capabilityId: t.capabilityId, code, state: stateOf(t.capabilityId, buildId), secrets: placeholder(manifest.requires?.secrets), config: placeholder(manifest.config), caller: { kind: "ui", id: "try-it" } },
        { capabilityId: t.capabilityId, operation: op.name, operationVersion: op.version, input: req.input ?? {} },
        async (call) => {
          throw new PlatformError("operation_failed", `calls to ${call.capabilityId} aren't available in Try it`);
        },
        async () => {
          throw new PlatformError("operation_failed", "the model isn't available in Try it");
        },
        `try-it ${opKey(op.name, op.version)}`,
      );
      // What a tool's own screen gets back from a call (secret updates are dropped: the copy has none).
      return { capabilityId: out.capabilityId, operation: out.operation, result: out.result };
    } finally {
      end();
    }
  }

  /** The copy goes: the owner decided, or its hour was up. */
  async end(buildId: string, why: string) {
    const all = this.open();
    const t = all[buildId];
    if (!t) return;
    delete all[buildId];
    this.registry.setKv(OPEN, all);
    await this.runtime.dropState(stateOf(t.capabilityId, buildId)).catch(() => {});
    this.logger(`build ${buildId}: Try it ended (${why}); its copy is gone`);
  }

  /** Every Try it past its hour ends: at start, after a resume, and at each cleanup. */
  async sweep(now = Date.now()) {
    for (const [buildId, t] of Object.entries(this.open())) if (now >= t.endsAt) await this.end(buildId, "its hour was up");
  }
}
