// SPDX-License-Identifier: AGPL-3.0-or-later
// Appearance (client-only): the owner's choice of light or dark, else the system's.
import { BRAND, enc } from "../kit.js";

export { applyTheme, isDark, shotUrl, THEME_KEY };

// ---------- appearance (client-only) ----------
/** Dark mode now: the owner's choice in Settings, else the system's. */
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
/** A build's validation screenshot in the current appearance. */
const shotUrl = (buildId) => `/api/builds/${enc(buildId)}/screenshot${isDark() ? "?scheme=dark" : ""}`;

const THEME_KEY = "hewn.theme";
function applyTheme(t = localStorage.getItem(THEME_KEY) ?? "system") {
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme();
document.title = BRAND;
