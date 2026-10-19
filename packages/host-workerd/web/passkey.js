// SPDX-License-Identifier: AGPL-3.0-or-later
// Passkeys in the browser (public URL only). Served without a session: the signed-out page uses
// it to sign in, and the web client imports addPasskey() to enrol this device.

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-hewn-ui": "1" }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || res.statusText);
  return data;
}

export const passkeysSupported = () => !!window.PublicKeyCredential && !!navigator.credentials?.create;

/** What a WebAuthn failure means to the owner. */
export function passkeyError(e) {
  if (e?.name === "NotAllowedError") return "Cancelled, or this device has no passkey for Hewn.";
  if (e?.name === "InvalidStateError") return "This device already has a passkey for Hewn.";
  if (e?.name === "SecurityError") return "Passkeys need the public URL over HTTPS.";
  return e?.message ?? String(e);
}

/** Make a passkey on this device and add it to Hewn (signed in). */
export async function addPasskey(name) {
  const o = await post("/api/passkeys/options");
  const cred = await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: fromB64(o.challenge),
      user: { ...o.user, id: fromB64(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: fromB64(c.id) })),
    },
  });
  return post("/api/passkeys", {
    challenge: o.challenge,
    name,
    response: { id: cred.id, clientDataJSON: toB64(cred.response.clientDataJSON), attestationObject: toB64(cred.response.attestationObject) },
  });
}

/** Sign in with this device's passkey (signed out). */
export async function signIn() {
  const o = await post("/passkey/options");
  const cred = await navigator.credentials.get({ publicKey: { challenge: fromB64(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout, allowCredentials: [] } });
  const r = cred.response;
  await post("/passkey/signin", { challenge: o.challenge, response: { id: cred.id, clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature) } });
}

// The signed-out page: the ASCII H behind it (a moment screen), and the passkey button.
const ascii = document.getElementById("ascii");
if (ascii) addEventListener("DOMContentLoaded", () => window.hewnAscii?.(ascii, { cols: 64, rows: 40 }));

const button = document.getElementById("passkey");
if (button) {
  const error = document.getElementById("passkey-error");
  const show = (text) => ((error.textContent = text), (error.hidden = false));
  if (!passkeysSupported()) {
    button.disabled = true;
    show("This browser can't use passkeys. Sign in with a link instead.");
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    error.hidden = true;
    try {
      await signIn();
      // Back to where the sign-in was needed (an agent's approval), else Home.
      location.replace(location.pathname === "/approve" ? location.href : "/");
    } catch (e) {
      show(passkeyError(e));
      button.disabled = false;
    }
  });
}
