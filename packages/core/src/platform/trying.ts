// SPDX-License-Identifier: AGPL-3.0-or-later
// Try it: a held build's screen in the owner's hands before they decide, on a fresh copy of their data. The copy is a
// scratch state of the tool (`try:<build>`), read-write, with exactly what validation gives the candidate (no hosts,
// no stored secrets or settings, no other tools, no model); no schedule ever runs on it (schedules run on the live
// state only). It goes when the owner decides (approve, turn down, a fix replacing the build, a stop) or an hour after
// it was opened, by the wall clock, so a Hewn suspended past the hour drops it before serving anything from it.
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { text } from "../files.ts";
import { type CapabilityManifest, opKey } from "../manifest.ts";
import { migrationsOf } from "../migrations.ts";
import type { CodeRef, Files, StateRef } from "../ports.ts";
import { randomToken, sha256 } from "../sha256.ts";
import { Domain, type Shared } from "./context.ts";
import { resolveOperation } from "./invocation.ts";
import { readCases, refusedModel, standIns } from "./validation.ts";

/** How long a Try it lasts, by the wall clock. */
export const TRY_MS = 3600_000;
/**
 * The open Try its, by build: when each ends, the key of its address, and its own tickets (hash → when it expires)
 * and sessions (hashes). Not the tools' UI sessions: one of those opens the live tool, and a Try it's must not.
 * An entry is written before its copy is made (`ready` once it is) and goes only once its copy is dropped, so no copy
 * is ever left without one.
 */
const OPEN = "try:open";
type OneTry = { capabilityId: string; startedAt: number; endsAt: number; key: string; tickets: Record<string, number>; sessions: string[]; ready?: boolean };
type Open = Record<string, OneTry>;
/** A Try it's tickets last two minutes; its sessions as long as it does. */
const TICKET_MS = 120_000;
const stateOf = (capabilityId: string, buildId: string): StateRef => ({ capabilityId, scratch: `try:${buildId}` });
type Candidate = { hash: string; files: Files; manifest: CapabilityManifest; code: CodeRef };
/** An open Try it, as its opener gets it: a ticket (used once) for its address's session, its key, when it ends. */
export type TryOpened = { ticket: string; key: string; endsAt: number };

export class Trying extends Domain {
  /** A start in flight, by build: a second (another tab) waits for it, then shares its copy. */
  private starting = new Map<string, Promise<OneTry>>();
  /** The candidates of open Try its, read once (by build). */
  private candidates = new Map<string, Candidate>();
  /** The host's alarm covers the earliest end too (nextEndAt), so an untouched Try it goes on time. */
  private onAlarm: () => void;

  constructor(s: Shared, onAlarm?: () => void) {
    super(s);
    this.onAlarm = onAlarm ?? (() => {});
  }

  private open(): Open {
    return this.registry.getKv<Open>(OPEN) ?? {};
  }

  private save(buildId: string, t: OneTry) {
    this.registry.setKv(OPEN, { ...this.open(), [buildId]: t });
  }

  /**
   * The Try it of a build, if it's open, its copy made and within its hour, and the build still waits for the owner.
   * One past its hour, or whose build was decided some other way, ends here, before anything is served from it.
   */
  private async alive(buildId: string, now = Date.now()): Promise<OneTry | undefined> {
    const t = this.open()[buildId];
    if (!t) return undefined;
    if (!t.ready) {
      // Its copy is being made; or Hewn stopped while it was, and nothing will finish it.
      if (!this.starting.has(buildId)) await this.end(buildId, "its copy wasn't finished");
      return undefined;
    }
    if (now >= t.endsAt) {
      await this.end(buildId, "its hour was up");
      return undefined;
    }
    if (this.registry.getBuild(buildId)?.status !== "review") {
      await this.end(buildId, "the build isn't waiting for you any more");
      return undefined;
    }
    return t;
  }

  /** The held build and its candidate: what Try it runs (read once per Try it). */
  private async candidate(buildId: string) {
    const b = this.mustBuild(buildId);
    if (b.status !== "review" || !b.review) throw new PlatformError("conflict", `build ${buildId} isn't waiting for your review`);
    let c = this.candidates.get(buildId);
    if (c?.hash !== b.review.contentHash) {
      const v = await this.d.builds.loadCandidate(b.review.contentHash);
      const manifest = JSON.parse(text(v.files["capability.json"])) as CapabilityManifest;
      c = { hash: b.review.contentHash, files: v.files, manifest, code: { hash: b.review.contentHash, js: v.bundle } };
      this.candidates.set(buildId, c);
    }
    return { ...c, b };
  }

  /**
   * Open (or go on with) a held build's Try it: a copy of the tool's own data as it is now (none for a new tool), with
   * the candidate's migrations applied. Returns a one-time ticket for its address and when it ends. `reopen`: only one
   * already open (a reload of its page), else `{ open: false }`; only the owner's Try it button makes a new copy.
   */
  async start(owner: Agent, buildId: string, opts: { reopen?: boolean } = {}): Promise<TryOpened | { open: false }> {
    requireOwner(owner);
    let t: OneTry | undefined;
    if (opts.reopen) {
      await this.starting.get(buildId)?.catch(() => {});
      t = await this.alive(buildId);
      if (!t) return { open: false };
    } else {
      // One start at a time per build: a second waits for the first's copy and gets a ticket for it.
      const mine = (this.starting.get(buildId) ?? Promise.resolve()).catch(() => {}).then(() => this.made(buildId));
      this.starting.set(buildId, mine);
      try {
        t = await mine;
      } finally {
        if (this.starting.get(buildId) === mine) this.starting.delete(buildId);
      }
    }
    const ticket = randomToken();
    const now = Date.now();
    // Tickets not used in time go as the next one is made.
    const tickets = Object.fromEntries(Object.entries(t.tickets).filter(([, until]) => until > now));
    this.save(buildId, { ...t, tickets: { ...tickets, [sha256(ticket)]: now + TICKET_MS } });
    return { ticket, key: t.key, endsAt: t.endsAt };
  }

  /** The build's open Try it, or a new one: its entry first, then its copy; a copy that fails goes, entry and all. */
  private async made(buildId: string): Promise<OneTry> {
    const { b, manifest, files, code } = await this.candidate(buildId);
    if (!manifest.ui?.available) throw new PlatformError("conflict", "it has no screen to try");
    const open = await this.alive(buildId);
    if (open) return open;
    const now = Date.now();
    const t: OneTry = { capabilityId: b.capabilityId, startedAt: now, endsAt: now + TRY_MS, key: randomToken(16), tickets: {}, sessions: [] };
    this.save(buildId, t);
    const state = stateOf(b.capabilityId, buildId);
    try {
      await this.runtime.dropState(state);
      if (b.kind !== "create" && (await this.runtime.hasState({ capabilityId: b.capabilityId }))) await this.runtime.copyState({ capabilityId: b.capabilityId }, state);
      await this.runtime.migrate(state, migrationsOf(files), code);
    } catch (e) {
      await this.end(buildId, `its copy couldn't be made: ${(e as Error).message}`);
      throw e;
    }
    const ready = { ...t, ready: true };
    this.save(buildId, ready);
    this.logger(`build ${buildId}: Try it opened on a copy of ${b.capabilityId}'s data, until ${new Date(t.endsAt).toISOString()}`);
    this.onAlarm();
    return ready;
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
    const data = (await this.candidate(buildId).catch(() => undefined))?.files[`ui/${rel}`];
    return data ? { path: rel, data } : undefined;
  }

  /** The candidate's manifest, as the screen asks for it. */
  async manifest(buildId: string): Promise<CapabilityManifest> {
    if (!(await this.alive(buildId))) throw new PlatformError("not_found", "this Try it has ended");
    return (await this.candidate(buildId)).manifest;
  }

  /**
   * A call from the screen, on the copy, with what validation gives the candidate: its test cases' settings and
   * secrets or placeholders, nothing reaching out (no hosts, other tools or model). It counts as the owner's activity
   * while it runs; it never asks for a backup (the copy isn't kept).
   */
  async invoke(buildId: string, req: { operation: string; operationVersion?: number; input?: unknown }) {
    if (!(await this.alive(buildId))) throw new PlatformError("not_found", "this Try it has ended");
    const { manifest, code, files, b } = await this.candidate(buildId);
    const op = resolveOperation(manifest, req.operation, req.operationVersion);
    let cases: ReturnType<typeof readCases> = [];
    try {
      cases = readCases(files);
    } catch {
      // as validation: placeholders
    }
    const { secrets, config } = standIns(manifest, cases, "try-it");
    // Ended while the candidate was read: nothing may make its copy again.
    if (!(await this.alive(buildId))) throw new PlatformError("not_found", "this Try it has ended");
    const state = stateOf(b.capabilityId, buildId);
    const end = this.platform.activity.call();
    try {
      const out = await this.d.invocation.execute(
        manifest,
        { capabilityId: b.capabilityId, code, state, secrets, config, caller: { kind: "ui", id: "try-it" } },
        { capabilityId: b.capabilityId, operation: op.name, operationVersion: op.version, input: req.input ?? {} },
        async (call) => {
          throw new PlatformError("operation_failed", `calls to ${call.capabilityId} aren't available in Try it`);
        },
        refusedModel(manifest, "the model isn't available in Try it"),
        `try-it ${opKey(op.name, op.version)}`,
      );
      // What a tool's own screen gets back from a call (secret updates are dropped: the copy has none).
      return { capabilityId: out.capabilityId, operation: out.operation, result: out.result };
    } finally {
      end();
      // It ended while this call ran: the call may have made the copy again.
      if (!this.open()[buildId]) await this.runtime.dropState(state).catch(() => {});
    }
  }

  /**
   * The copy goes: the owner decided, the build was stopped, or its hour was up. Its entry goes once the copy has;
   * if the drop fails, the entry stays, ended, and the next look or sweep tries again.
   */
  async end(buildId: string, why: string) {
    const t = this.open()[buildId];
    this.candidates.delete(buildId);
    const capabilityId = t?.capabilityId ?? this.registry.getBuild(buildId)?.capabilityId;
    if (!capabilityId) return;
    try {
      await this.runtime.dropState(stateOf(capabilityId, buildId));
    } catch (e) {
      if (t) this.save(buildId, { ...t, endsAt: 0, tickets: {}, sessions: [] });
      this.logger(`build ${buildId}: Try it ended (${why}), but its copy couldn't be dropped yet: ${(e as Error).message}`);
      return;
    }
    if (!t) return;
    const { [buildId]: _gone, ...rest } = this.open();
    this.registry.setKv(OPEN, rest);
    this.logger(`build ${buildId}: Try it ended (${why}); its copy is gone`);
    this.onAlarm();
  }

  /** Every Try it that is over ends (past its hour, its build decided, its copy never finished): at start, with each alarm or resume, at each cleanup. */
  async sweep(now = Date.now()) {
    for (const buildId of Object.keys(this.open())) await this.alive(buildId, now);
  }

  /** Whether the copy `try:<build>` is one an open Try it uses (the start's sweep keeps it). */
  keeps(buildId: string): boolean {
    const t = this.open()[buildId];
    return !!t?.ready && Date.now() < t.endsAt && this.registry.getBuild(buildId)?.status === "review";
  }

  /** The tools with a Try it entry (the start's sweep looks at their scratch states too). */
  tools(): string[] {
    return [...new Set(Object.values(this.open()).map((t) => t.capabilityId))];
  }

  /** When the next Try it ends, for the host's alarm. */
  nextEndAt(): number | null {
    const ends = Object.values(this.open()).map((t) => t.endsAt);
    return ends.length ? Math.min(...ends) : null;
  }

  /** Its candidate's code held Hewn's tools (a stall): the Try it ends, and the review card's log says why. No strike on the tool. */
  stalled(buildId: string, line: string) {
    const b = this.registry.getBuild(buildId);
    if (b) this.registry.updateBuild(buildId, { log: [...b.log, `Try it: ${line}, so Hewn's tools were restarted and the Try it ended`] });
    this.logger(`build ${buildId}: Try it stopped Hewn's tools: ${line}`);
    void this.end(buildId, "its code held Hewn's tools").catch(() => {});
  }
}
