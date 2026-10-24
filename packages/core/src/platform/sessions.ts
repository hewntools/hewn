// SPDX-License-Identifier: AGPL-3.0-or-later
// Sessions: tool UIs as clients (tickets, sessions, their files), the owner's web sessions, the
// public URL and passkeys.
import { type Agent, requireOwner, WEB_USER } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { randomToken, sha256, utf8 } from "../sha256.ts";
import { type AssertionResponse, b64url, type RegistrationResponse, type StoredKey, SUPPORTED_ALGS, verifyAssertion, verifyRegistration } from "../webauthn.ts";
import { Domain } from "./context.ts";

export class Sessions extends Domain {
  /** Last sliding-expiry write per web session hash. */
  private webTouched = new Map<string, number>();
  /** Outstanding WebAuthn challenges (in memory: a restart only cancels sign-ins in progress). */
  private challenges = new Map<string, { kind: "create" | "get"; expires: number }>();

  /** One-time ticket for `hewn open` (user only). Exchanged by the browser for a session. */
  createUiTicket(capabilityId: string): string {
    const m = this.activeManifest(capabilityId);
    if (!m.ui?.available) throw new PlatformError("not_found", `${capabilityId} has no UI`);
    const ticket = randomToken();
    this.registry.insertUiToken(sha256(ticket), capabilityId, "ticket", Date.now() + 120_000);
    return ticket;
  }

  /** Exchange a ticket for a 12h session bound to that one capability. */
  redeemUiTicket(ticket: string, capabilityId: string): string | undefined {
    const bound = this.registry.useUiToken(sha256(ticket), "ticket");
    if (bound !== capabilityId) return undefined;
    const session = randomToken();
    this.registry.insertUiToken(sha256(session), capabilityId, "session", Date.now() + 12 * 3600_000);
    return session;
  }

  /**
   * The UI acts on behalf of the user, with authority attenuated to its own capability:
   * discover + invoke on that capability only. No grants, secrets, builds or other capabilities.
   */
  uiAgent(session: string | undefined, capabilityId: string): Agent | undefined {
    if (!session || this.registry.useUiToken(sha256(session), "session") !== capabilityId) return undefined;
    return { id: `ui:${capabilityId}`, kind: "ui", scopes: new Set(["discover", "invoke"]), capabilities: new Set([capabilityId]) };
  }

  /** One-time ticket for the owner's web client (`hewn open`, CLI = owner). */
  createWebTicket(owner: Agent): string {
    requireOwner(owner);
    const ticket = randomToken();
    this.registry.insertWebToken(sha256(ticket), "ticket", Date.now() + 120_000);
    return ticket;
  }

  /** Exchange a web ticket for a session: 30 days, sliding (every use pushes it out again). */
  redeemWebTicket(ticket: string, userAgent?: string): string | undefined {
    if (!this.registry.useWebToken(sha256(ticket), "ticket")) return undefined;
    return this.newWebSession(userAgent);
  }

  private newWebSession(userAgent?: string): string {
    const session = randomToken();
    this.registry.insertWebToken(sha256(session), "session", Date.now() + WEB_SESSION_MS, userAgent);
    return session;
  }

  webPrincipal(session: string | undefined): Agent | undefined {
    if (!session || !this.registry.useWebToken(sha256(session), "session")) return undefined;
    // Sliding expiry, written at most once a minute per session.
    const hash = sha256(session);
    const last = this.webTouched.get(hash) ?? 0;
    if (Date.now() - last > 60_000) {
      this.webTouched.set(hash, Date.now());
      this.registry.touchWebSession(hash, Date.now() + WEB_SESSION_MS);
    }
    return WEB_USER;
  }

  /** Signed-in browsers (owner only). `id` is a short, non-secret handle; `current` marks the caller's. */
  webSessions(owner: Agent, currentSession?: string) {
    requireOwner(owner);
    const current = currentSession ? sha256(currentSession) : undefined;
    return this.registry.webSessions().map((s) => ({ id: s.hash.slice(0, 16), createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, userAgent: s.userAgent, expiresAt: new Date(s.expiresAt).toISOString(), current: s.hash === current }));
  }

  revokeWebSession(owner: Agent, id: string) {
    requireOwner(owner);
    const s = this.registry.webSessions().find((x) => x.hash.startsWith(id) && id.length >= 16);
    if (!s) throw new PlatformError("not_found", "no such session");
    this.registry.deleteWebSession(s.hash);
    this.logger(`web session ${id} revoked by ${owner.id}`);
  }

  /** Sign this browser out (the session behind the cookie). */
  signOut(session: string) {
    this.registry.deleteWebSession(sha256(session));
  }

  /** Where the owner reaches Hewn from anywhere (https://hewn.example.com), if set. */
  publicUrl(): string | undefined {
    return this.registry.getKv<string>("web.publicUrl") ?? undefined;
  }

  /** Set (or clear, with null) the public URL. Passkeys work only on the host they were made for. */
  setPublicUrl(owner: Agent, url: string | null): { url: string | null; passkeysElsewhere: number } {
    requireOwner(owner);
    const next = url === null ? null : normalizePublicUrl(url);
    this.registry.setKv("web.publicUrl", next);
    this.registry.addAuthorityEvent({ actor: owner.id, action: "public_url_set", subject: next ?? "none" });
    const host = next ? new URL(next).hostname : undefined;
    return { url: next, passkeysElsewhere: this.registry.passkeys().filter((p) => p.rpId !== host).length };
  }

  /** A single-use WebAuthn challenge, good for two minutes. */
  passkeyChallenge(kind: "create" | "get"): string {
    const now = Date.now();
    for (const [c, x] of this.challenges) if (x.expires < now) this.challenges.delete(c);
    if (this.challenges.size > 200) throw new PlatformError("conflict", "too many sign-ins in progress; try again in a minute");
    const challenge = randomToken(32);
    this.challenges.set(challenge, { kind, expires: now + 120_000 });
    return challenge;
  }

  private takeChallenge(challenge: string, kind: "create" | "get") {
    const c = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!c || c.kind !== kind || c.expires < Date.now()) throw new PlatformError("unauthenticated", "this sign-in took too long or was already used; try again");
  }

  /** The owner's passkeys and the WebAuthn options for adding one on `rpId` (signed in only). */
  passkeyCreateOptions(owner: Agent, rpId: string) {
    requireOwner(owner);
    return {
      challenge: this.passkeyChallenge("create"),
      rp: { id: rpId, name: "Hewn" },
      // One owner: a fixed user handle, so a device keeps one Hewn passkey per host.
      user: { id: b64url(utf8("owner")), name: "owner", displayName: "Hewn owner" },
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key", alg })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
      excludeCredentials: this.registry.passkeys().filter((p) => p.rpId === rpId).map((p) => ({ type: "public-key", id: p.credentialId })),
      timeout: 120_000,
    };
  }

  async addPasskey(owner: Agent, site: { origin: string; rpId: string }, body: { challenge: string; response: RegistrationResponse; name?: string }) {
    requireOwner(owner);
    this.takeChallenge(String(body.challenge ?? ""), "create");
    let r: Awaited<ReturnType<typeof verifyRegistration>>;
    try {
      r = await verifyRegistration(body.response, { challenge: body.challenge, origin: site.origin, rpId: site.rpId });
    } catch (e) {
      throw new PlatformError("invalid_request", `passkey not added: ${(e as Error).message}`);
    }
    if (this.registry.passkey(r.credentialId)) throw new PlatformError("conflict", "that passkey is already added");
    const name = String(body.name ?? "").trim().slice(0, 60) || "Passkey";
    this.registry.insertPasskey({ credentialId: r.credentialId, rpId: site.rpId, publicKey: JSON.stringify(r.key), signCount: r.signCount, name });
    this.registry.addAuthorityEvent({ actor: owner.id, action: "passkey_added", subject: name, detail: site.rpId });
    this.logger(`passkey "${name}" added for ${site.rpId}`);
    return { id: r.credentialId, name };
  }

  /** Whether any passkey was made for `rpId` (the sign-in page offers them only then). */
  hasPasskeys(rpId: string): boolean {
    return this.registry.passkeys().some((p) => p.rpId === rpId);
  }

  /** WebAuthn options for signing in on `rpId` (no session needed; the device offers its passkey). */
  passkeyGetOptions(rpId: string) {
    return { challenge: this.passkeyChallenge("get"), rpId, userVerification: "required", timeout: 120_000, allowCredentials: [] };
  }

  /** Verify a passkey sign-in; returns a new web session. */
  async passkeySignIn(site: { origin: string; rpId: string }, body: { challenge: string; response: AssertionResponse }, userAgent?: string): Promise<string> {
    this.takeChallenge(String(body.challenge ?? ""), "get");
    const stored = this.registry.passkey(String(body.response?.id ?? ""));
    if (!stored || stored.rpId !== site.rpId) throw new PlatformError("unauthenticated", "this passkey isn't one of Hewn's (it may have been removed): sign in another way, then add a new one");
    try {
      const { signCount } = await verifyAssertion(body.response, { challenge: body.challenge, origin: site.origin, rpId: site.rpId }, { key: JSON.parse(stored.publicKey) as StoredKey, signCount: stored.signCount });
      this.registry.usePasskey(stored.credentialId, signCount);
    } catch (e) {
      throw new PlatformError("unauthenticated", `passkey sign-in failed: ${(e as Error).message}`);
    }
    this.logger(`signed in with passkey "${stored.name}"`);
    return this.newWebSession(userAgent);
  }

  passkeys(owner: Agent) {
    requireOwner(owner);
    const host = this.publicUrl() ? new URL(this.publicUrl()!).hostname : undefined;
    return this.registry.passkeys().map((p) => ({ id: p.credentialId, name: p.name, host: p.rpId, works: p.rpId === host, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));
  }

  removePasskey(owner: Agent, id: string) {
    requireOwner(owner);
    const p = this.registry.passkey(id);
    if (!p) throw new PlatformError("not_found", "no such passkey");
    this.registry.deletePasskey(id);
    this.registry.addAuthorityEvent({ actor: owner.id, action: "passkey_removed", subject: p.name, detail: p.rpId });
  }

  /** A file from the active version's ui/ directory (index.html for "/"), or undefined (incl. traversal attempts). */
  async uiFile(capabilityId: string, path: string): Promise<{ path: string; data: Uint8Array } | undefined> {
    const cap = this.registry.getCapability(capabilityId);
    if (!cap?.activeVersion || cap.archivedAt || !this.activeManifest(capabilityId).ui?.available) return undefined;
    const rel = path === "/" || path === "" ? "index.html" : path.replace(/^\/+/, "");
    if (rel.split("/").some((part) => part === ".." || part === "." || part === "")) return undefined;
    const data = (await this.loadVersion(capabilityId, cap.activeVersion)).files[`ui/${rel}`];
    return data ? { path: rel, data } : undefined;
  }

  /**
   * The secret path segment a capability's UI is served under (`/tools/<id>/~<key>/`): its files are
   * code, not data, but which tools exist and how they work is the owner's business. Only the
   * signed-in web client and `hewn open` (through a UI ticket) lead there. Undefined for an
   * unknown capability.
   */
  uiKey(capabilityId: string): string | undefined {
    return this.registry.getCapability(capabilityId) ? this.registry.uiKey(capabilityId, () => randomToken(16)) : undefined;
  }
}

/** Web sessions last 30 days from last use. */
export const WEB_SESSION_MS = 30 * 86400_000;

/**
 * The public URL as Hewn stores it: https, a host name (passkeys can't be made for an IP
 * address), optionally a port, nothing else. Capability UIs are on <id>.<host>.
 */
export function normalizePublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new PlatformError("invalid_request", "the public URL must look like https://hewn.example.com");
  }
  if (u.protocol !== "https:") throw new PlatformError("invalid_request", "the public URL must be https:// (passkeys and secure cookies need it; your reverse proxy or tunnel provides the certificate)");
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) throw new PlatformError("invalid_request", "the public URL is just the address, e.g. https://hewn.example.com (no path)");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(u.hostname) || /^[0-9.]+$/.test(u.hostname)) throw new PlatformError("invalid_request", "the public URL needs a domain name, not an IP address (e.g. https://hewn.example.com)");
  return u.origin;
}
