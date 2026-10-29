// SPDX-License-Identifier: AGPL-3.0-or-later
// Appearance (client-only): the owner's choice of light or dark, else the system's.
import { BRAND, enc } from "../kit.js";

export { applyTheme, isDark, shotUrl, THEME_KEY, themeNow, withTheme };

// ---------- appearance (client-only) ----------
/** Dark mode now: the owner's choice in Settings, else the system's. */
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
/** A build's validation screenshot in the current appearance. */
const shotUrl = (buildId) => `/api/builds/${enc(buildId)}/screenshot${isDark() ? "?scheme=dark" : ""}`;

const THEME_KEY = "hewn.theme";
function applyTheme(t = localStorage.getItem(THEME_KEY) ?? "system") {
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  // An open tool follows (tool.js tells its frame).
  dispatchEvent(new Event("hewn:theme"));
}
/**
 * The owner's light or dark for a tool's frame, where session.js puts it on the page's <html> for
 * ui.css (a sandboxed frame doesn't see the web client's choice). "system": the browser's.
 */
const themeNow = () => document.documentElement.dataset.theme ?? "system";
/**
 * A tool's way in (`<ui>/auth?ticket=…`) with that in its query: /auth hands it to the page in its
 * fragment, with the session, so its first paint is already in it.
 */
const withTheme = (url) => (themeNow() === "system" ? url : `${url}${url.includes("?") ? "&" : "?"}theme=${themeNow()}`);
applyTheme();
document.title = BRAND;
