// SPDX-License-Identifier: AGPL-3.0-or-later
// Add a passkey on this device (after a sign-in link on the public address).
import { api, h, toast } from "../kit.js";
import { addPasskey, passkeyError, passkeysSupported } from "../passkey.js";
import { go, onLeave, stillHere, view } from "./frame.js";

export { deviceName, passkeyPage };

// ---------- M3: add a passkey (after a sign-in link on the public address) ----------

async function passkeyPage() {
  const here = stillHere();
  const remote = await api("/remote").catch(() => null);
  if (!here()) return;
  if (remote?.here !== "public") return go("#/");
  const name = h("input", { type: "text", value: deviceName(navigator.userAgent), "aria-label": "Name", maxLength: 40 });
  const status = h("div", { class: "small danger-text", role: "status" });
  const add = h("button", { class: "primary lg wide" }, "Add passkey");
  add.addEventListener("click", async () => {
    add.disabled = true;
    status.textContent = "";
    try {
      await addPasskey(name.value.trim() || deviceName(navigator.userAgent));
      toast("Passkey added");
      go("#/");
    } catch (e) {
      status.textContent = passkeyError(e);
      add.disabled = false;
    }
  });
  const device = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "phone" : "device";
  const unlock = /iPhone|iPad/.test(navigator.userAgent) ? "Face ID" : /Mac/.test(navigator.userAgent) ? "Touch ID" : "a fingerprint or the screen lock";
  // The art takes the room above the form, in the page's flow: on a phone it would run under the heading.
  const art = h("pre", {});
  if (window.hewnAscii) onLeave(window.hewnAscii(art, { cols: 64, rows: 40 }));
  view(
    h(
      "div",
      { class: "moment" },
      h(
        "main",
        { class: "signin" },
        h("div", { class: "signin-art", "aria-hidden": "true" }, art),
        h("div", { class: "display signin-title" }, `Add this ${device}`),
        h("div", { class: "muted" }, `Next time it signs in with ${unlock}.`),
        passkeysSupported() ? [h("label", { class: "field" }, h("span", { class: "label" }, "Name"), name), add, h("a", { class: "btn ghost wide", href: "#/" }, "Not now"), status] : [h("div", { class: "muted" }, "This browser can't make passkeys."), h("a", { class: "btn lg wide", href: "#/" }, "Continue")],
      ),
    ),
  );
}

/** "iPhone", "Chrome on macOS": a default name for this device, good enough to tell your own apart. */
function deviceName(ua = "") {
  if (!ua) return "A browser";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
