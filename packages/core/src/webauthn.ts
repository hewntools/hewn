// SPDX-License-Identifier: AGPL-3.0-or-later
// Passkeys (WebAuthn), verified with WebCrypto so it runs in workerd and Node alike. Only what
// a single owner signing in needs: attestation "none" (no authenticator allow-lists), user
// verification required, ES256 / EdDSA / RS256 keys.
import { sha256 } from "./sha256.ts";

export const b64url = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromB64url = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

export class WebAuthnError extends Error {}

const fail = (message: string): never => {
  throw new WebAuthnError(message);
};

// ---------- CBOR (the subset WebAuthn uses) ----------

/** Decode one CBOR item at `at`; returns it and where the next item starts. */
export function cborDecode(b: Uint8Array, at = 0): { value: unknown; end: number } {
  if (at >= b.length) fail("truncated CBOR");
  const major = b[at] >> 5;
  const info = b[at] & 0x1f;
  let i = at + 1;
  let n: number;
  if (info < 24) n = info;
  else if (info <= 27) {
    const size = 1 << (info - 24);
    if (i + size > b.length) fail("truncated CBOR");
    n = 0;
    for (let k = 0; k < size; k++) n = n * 256 + b[i + k];
    i += size;
  } else return fail("unsupported CBOR (indefinite length)");
  switch (major) {
    case 0:
      return { value: n, end: i };
    case 1:
      return { value: -1 - n, end: i };
    case 2:
    case 3: {
      if (i + n > b.length) fail("truncated CBOR");
      const raw = b.slice(i, i + n);
      return { value: major === 2 ? raw : new TextDecoder().decode(raw), end: i + n };
    }
    case 4: {
      const out: unknown[] = [];
      for (let k = 0; k < n; k++) {
        const item = cborDecode(b, i);
        out.push(item.value);
        i = item.end;
      }
      return { value: out, end: i };
    }
    case 5: {
      const out = new Map<unknown, unknown>();
      for (let k = 0; k < n; k++) {
        const key = cborDecode(b, i);
        const val = cborDecode(b, key.end);
        out.set(key.value, val.value);
        i = val.end;
      }
      return { value: out, end: i };
    }
    case 7:
      if (info === 20) return { value: false, end: i };
      if (info === 21) return { value: true, end: i };
      if (info === 22) return { value: null, end: i };
      return fail("unsupported CBOR simple value");
    default:
      return fail("unsupported CBOR (tags)");
  }
}

// ---------- authenticator data ----------

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

interface AuthData {
  rpIdHash: string;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  coseKey?: Map<unknown, unknown>;
}

function parseAuthData(b: Uint8Array): AuthData {
  if (b.length < 37) fail("authenticator data too short");
  const hex = [...b.slice(0, 32)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const flags = b[32];
  const signCount = ((b[33] << 24) | (b[34] << 16) | (b[35] << 8) | b[36]) >>> 0;
  if (!(flags & FLAG_AT)) return { rpIdHash: hex, flags, signCount };
  if (b.length < 55) fail("attested credential data too short");
  const idLen = (b[53] << 8) | b[54];
  const credentialId = b.slice(55, 55 + idLen);
  const key = cborDecode(b, 55 + idLen).value;
  if (!(key instanceof Map)) fail("credential public key is not a COSE key");
  return { rpIdHash: hex, flags, signCount, credentialId, coseKey: key as Map<unknown, unknown> };
}

// ---------- keys ----------

/** A stored public key: a JWK plus the COSE algorithm it signs with. */
export interface StoredKey {
  alg: number;
  jwk: JsonWebKey;
}

const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;
export const SUPPORTED_ALGS = [ES256, EDDSA, RS256];

function jwkOf(cose: Map<unknown, unknown>): StoredKey {
  const kty = cose.get(1);
  const alg = cose.get(3) as number;
  const bytes = (k: number) => {
    const v = cose.get(k);
    return v instanceof Uint8Array ? b64url(v) : fail("malformed COSE key");
  };
  if (kty === 2 && alg === ES256 && cose.get(-1) === 1) return { alg, jwk: { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) } };
  if (kty === 1 && alg === EDDSA && cose.get(-1) === 6) return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: bytes(-2) } };
  if (kty === 3 && alg === RS256) return { alg, jwk: { kty: "RSA", n: bytes(-1), e: bytes(-2) } };
  return fail(`unsupported key type (COSE kty ${String(kty)}, alg ${String(alg)})`);
}

// Typed loosely: Node's and workerd's WebCrypto typings name these parameter types differently.
const ALGORITHMS: Record<number, { key: { name: string; namedCurve?: string; hash?: string }; verify: { name: string; hash?: string } }> = {
  [ES256]: { key: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  [EDDSA]: { key: { name: "Ed25519" }, verify: { name: "Ed25519" } },
  [RS256]: { key: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
};

/** WebAuthn ECDSA signatures are DER; WebCrypto wants r || s, 32 bytes each. */
function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) fail("malformed ECDSA signature");
  let i = 2;
  const out = new Uint8Array(64);
  for (const at of [0, 32]) {
    if (der[i] !== 0x02) fail("malformed ECDSA signature");
    let len = der[i + 1];
    let start = i + 2;
    i = start + len;
    while (len > 32 && der[start] === 0) {
      start++;
      len--;
    }
    if (len > 32) fail("malformed ECDSA signature");
    out.set(der.slice(start, start + len), at + 32 - len);
  }
  return out;
}

async function verifySignature(key: StoredKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const a = ALGORITHMS[key.alg] ?? fail("unsupported algorithm");
  const k = await crypto.subtle.importKey("jwk", key.jwk, a.key, false, ["verify"]);
  const sig = key.alg === ES256 ? derToRaw(signature) : signature;
  return crypto.subtle.verify(a.verify, k, sig as BufferSource, data as BufferSource);
}

// ---------- the two ceremonies ----------

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function checkClientData(raw: Uint8Array, type: string, challenge: string, origin: string): void {
  let c: ClientData;
  try {
    c = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return fail("client data is not JSON");
  }
  if (c.type !== type) fail(`wrong ceremony (${c.type})`);
  if (c.challenge !== challenge) fail("challenge mismatch");
  if (c.origin !== origin) fail(`made for ${c.origin}, not ${origin}`);
  if (c.crossOrigin) fail("made in a cross-origin frame");
}

function checkAuthData(a: AuthData, rpId: string) {
  if (a.rpIdHash !== sha256(rpId)) fail(`made for another site, not ${rpId}`);
  if (!(a.flags & FLAG_UP)) fail("user presence missing");
  if (!(a.flags & FLAG_UV)) fail("user verification missing (the device must check it's you)");
}

export interface Expected {
  challenge: string;
  /** e.g. https://hewn.example.com */
  origin: string;
  /** e.g. hewn.example.com */
  rpId: string;
}

/** navigator.credentials.create() result, base64url fields. */
export interface RegistrationResponse {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
}

export async function verifyRegistration(r: RegistrationResponse, e: Expected): Promise<{ credentialId: string; key: StoredKey; signCount: number }> {
  checkClientData(fromB64url(r.clientDataJSON), "webauthn.create", e.challenge, e.origin);
  const att = cborDecode(fromB64url(r.attestationObject)).value;
  const authData = att instanceof Map ? att.get("authData") : undefined;
  if (!(authData instanceof Uint8Array)) return fail("attestation has no authenticator data");
  const a = parseAuthData(authData);
  checkAuthData(a, e.rpId);
  if (!a.credentialId || !a.coseKey) return fail("no credential in the attestation");
  const credentialId = b64url(a.credentialId);
  if (credentialId !== r.id) fail("credential id mismatch");
  return { credentialId, key: jwkOf(a.coseKey), signCount: a.signCount };
}

/** navigator.credentials.get() result, base64url fields. */
export interface AssertionResponse {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** Verifies a sign-in; returns the new signature counter. */
export async function verifyAssertion(r: AssertionResponse, e: Expected, stored: { key: StoredKey; signCount: number }): Promise<{ signCount: number }> {
  const clientData = fromB64url(r.clientDataJSON);
  checkClientData(clientData, "webauthn.get", e.challenge, e.origin);
  const authData = fromB64url(r.authenticatorData);
  const a = parseAuthData(authData);
  checkAuthData(a, e.rpId);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", clientData as BufferSource));
  const signed = new Uint8Array(authData.length + digest.length);
  signed.set(authData);
  signed.set(digest, authData.length);
  if (!(await verifySignature(stored.key, fromB64url(r.signature), signed))) fail("signature does not verify");
  // A counter that goes backwards means a cloned authenticator. Synced passkeys always send 0.
  if (stored.signCount > 0 && a.signCount <= stored.signCount) fail("signature counter went backwards (cloned authenticator?)");
  return { signCount: a.signCount };
}
