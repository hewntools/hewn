// SPDX-License-Identifier: AGPL-3.0-or-later
// ui://hewn/widget: the MCP Apps UI resource that draws a widget inside an agent chat (Claude,
// ChatGPT and other MCP Apps hosts render it in a sandboxed iframe). It is platform code, versioned
// with Hewn: the design system, chart.js and widgets.js inlined (no network at all) plus a small
// bridge that takes the widgets_show result from the host and draws its view model. Capability
// code never reaches the chat; only the view model does.
import { text } from "@hewntools/core/files.ts";

import { WIDGET_APP_MIME, WIDGET_APP_URI } from "@hewntools/spec/agents.ts";
export { WIDGET_APP_MIME, WIDGET_APP_URI };

/** The host side of MCP Apps (JSON-RPC over postMessage): initialize, then draw each tool result. */
const BRIDGE = `
const root = document.getElementById("w");
let nextId = 1;
const pending = new Map();
const post = (m) => window.parent.postMessage({ jsonrpc: "2.0", ...m }, "*");
const request = (method, params) => new Promise((ok) => { const id = nextId++; pending.set(id, ok); post({ id, method, params }); });
const theme = (ctx) => { if (ctx && (ctx.theme === "dark" || ctx.theme === "light")) document.documentElement.dataset.theme = ctx.theme; };
// Nothing drawn yet is not a size: a host that shrinks the frame to 0 may stop laying it out.
const size = () => root.scrollHeight > 0 && post({ method: "ui/notifications/size-changed", params: { width: Math.ceil(root.scrollWidth), height: Math.ceil(document.body.scrollHeight) } });
function draw(result) {
  const s = result && result.structuredContent;
  if (!s || !s.view) {
    const t = result && Array.isArray(result.content) ? result.content.find((c) => c.type === "text") : null;
    root.replaceChildren(Object.assign(document.createElement("pre"), { className: "jw-fallback", textContent: t ? t.text : "" }));
  } else renderWidget(root, s.view, { size: s.size || "medium", title: s.title || "", icon: s.icon, onButton: (b, btn) => press(s, b, btn) });
  setTimeout(size, 0);
}
new ResizeObserver(size).observe(root);
// A button runs the capability's operation through the host (as the chat's agent, under its
// grants; destructive ones wait for the owner in Hewn), then the widget is shown again, fresh.
async function press(s, b, btn) {
  const [operation, version] = b.operation.split("@");
  btn.disabled = true;
  const r = await request("tools/call", { name: "capabilities_invoke", arguments: { capabilityId: s.capabilityId, operation, operationVersion: Number(version), input: b.input || {} } });
  if (r && r.isError) {
    btn.disabled = false;
    const t = Array.isArray(r.content) ? r.content.find((c) => c.type === "text") : null;
    let message = "That didn't work.";
    try { message = JSON.parse(t.text).message || message; } catch {}
    btn.title = message;
    btn.textContent = "! " + b.label;
    return;
  }
  draw(await request("tools/call", { name: "widgets_show", arguments: { capabilityId: s.capabilityId, widget: s.widget, input: s.input || {}, size: s.size } }));
}
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "ui/notifications/tool-result") draw(m.params);
  if (m.method === "ui/notifications/host-context-changed") theme(m.params);
});
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "hewn-widget", version: "1" }, appCapabilities: {} }).then((r) => {
  theme(r && r.hostContext);
  post({ method: "ui/notifications/initialized", params: {} });
});
`;

const CSS = `
/* Transparent on the host's chat; "normal" so a dark frame in a light page isn't painted opaque. */
html, html[data-theme], body { background: transparent; color-scheme: normal; }
body { margin: 0; padding: 4px; }
#w { width: 100%; max-width: 420px; }
#w .jw { height: auto; min-height: 120px; }
#w .jw-large { min-height: 300px; }
.jw-fallback { margin: 0; white-space: pre-wrap; font: var(--fs-sm)/1.4 var(--font); }
`;

/** ES module source as a plain script body: imports dropped (everything is inlined), exports made local. */
const inline = (src: string) => src.replace(/^import .*$/gm, "").replace(/^export /gm, "");

/** The resource's HTML, built from the same files Home serves at /_platform/*. */
export async function widgetAppHtml(asset: (path: string) => Promise<Uint8Array | undefined>): Promise<string> {
  const [css, chart, widgets] = await Promise.all(["platform-ui/ui.css", "platform-ui/chart.js", "platform-ui/widgets.js"].map(async (p) => {
    const data = await asset(p);
    if (!data) throw new Error(`missing platform asset ${p}`);
    return text(data);
  }));
  const script = [inline(chart), inline(widgets), BRIDGE].join("\n");
  if (/<\/(script|style)/i.test(script + css)) throw new Error("widget app sources must not contain closing script/style tags");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hewn widget</title>
<style>${css}
@layer hewn {${CSS}}</style>
</head>
<body>
<div id="w"></div>
<script type="module">${script}</script>
</body>
</html>`;
}
