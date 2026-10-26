// SPDX-License-Identifier: AGPL-3.0-or-later
// The owner's web client: http://hewn.localhost:<port>, and https://hewn.example.com once a public
// URL is set (see site.ts; passkey sign-in exists only there). Principal = the owner (kind "user"), so
// owner actions (secrets, grants, agents, settings, connecting local agent harnesses) are
// available here, unlike for agents. Install and service management stay CLI-only.
import type { Agent, Scope } from "@hewntools/core/auth.ts";
import { AGENT_POINTER } from "../pointer.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { ABI } from "@hewntools/core/manifest.ts";
import { fromBase64 } from "@hewntools/core/files.ts";
import { cellsFromRows, cellsFromSvg } from "@hewntools/core/glyph.ts";
import type { Platform, Readiness } from "@hewntools/core/platform.ts";
import type { IntakeProgress, IntakeReply, IntakeRequest } from "./intake-types.ts";
import { agentModels, jobModel, type Hosted, type SurfaceHost } from "./host.ts";
import { body, cookieValue, errorBody, esc, json, readJson, sse, STATUS, typeOf } from "./http.ts";
import { dnsRecords, localSite, type Site } from "./site.ts";
import { platformAsset, sameOrigin, signedIn } from "./ui.ts";

/** Served without a session: branding and install metadata only (browsers fetch manifests without cookies). */
const PUBLIC_FILES = new Set(["app.css", "passkey.js", "hewn-mark.svg", "hewn-glyph.svg", "manifest.webmanifest", "icons/hewn-180.png", "icons/hewn-192.png", "icons/hewn-512.png"]);
const SESSION_MAX_AGE = 30 * 86400;
// On the public URL the cookie is __Host- (Secure, this exact host, Path=/). Capability UIs under
// /tools/ run on opaque origins: they can neither read it nor send it (their requests are cross-site).
const cookieName = (site: Site) => (site.secure ? "__Host-hewn_web" : "hewn_web");
/**
 * Where to go after signing in, when it wasn't Home: set by the signed-out /approve page (an agent
 * waits for approval), read once by /auth. Lax, so it comes back from the host's sign-in page.
 */
const nextName = (site: Site) => (site.secure ? "__Host-hewn_next" : "hewn_next");
const nextCookie = (site: Site, maxAge: number) => `${nextName(site)}=agents; HttpOnly;${site.secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const withNext = (site: Site, res: Response) => (res.headers.append("set-cookie", nextCookie(site, 15 * 60)), res);
const sessionCookie = (site: Site, session: string, maxAge = SESSION_MAX_AGE) =>
  `${cookieName(site)}=${session}; HttpOnly;${site.secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=${maxAge}`;

// No inline scripts: the owner surface holds owner authority, so XSS must have nowhere to run.
const webCsp = (site: Site) =>
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${site.web}/tools/; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`;
export const WEB_CSP = webCsp(localSite(0));

export const webOrigin = (port: number) => localSite(port).web;

// JSON never renders, so API answers carry the same policy on either site; HTML pages get their site's.
const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  json(status, body, { "content-security-policy": WEB_CSP, "cache-control": "no-store", ...headers });

/**
 * The page a signed-out browser sees: what to do, nothing else. A moment screen (the ASCII H behind
 * a bottom-anchored column, phone-width first), static HTML on the design system; no inline script,
 * so the strict CSP holds (and on this machine no script at all). On the public URL with a passkey it offers passkey sign-in (passkey.js);
 * a sign-in link from the server is the other way in.
 */
function signedOutPage(site: Site, status: number, title: string, line: string, command = "hewn open", passkey = false, hosted?: Hosted): Response {
  // Hosted: the owner has no terminal; the host signs them in (a link, when it gives one).
  const fromHost = hosted?.signInUrl ? `<a class="btn primary lg wide" href="${esc(hosted.signInUrl)}">Sign in</a>` : "";
  const action = passkey
    ? `<button id="passkey" class="primary lg wide" type="button">Sign in with a passkey</button>
      <div id="passkey-error" class="small danger-text" role="alert" hidden></div>
      ${hosted ? `<div class="small faint center">New device? ${hosted.signInUrl ? `<a href="${esc(hosted.signInUrl)}">Sign in from your account</a>.` : "Open Hewn again from your account."}</div>` : `<div class="small faint center">New device? On the server run <span class="mono">${command}</span> and scan the code.</div>`}`
    : hosted
      ? `<div class="muted">${line}</div>
      ${fromHost}`
      : `<div class="muted">${line}</div>
      <div class="command-block"><span>${command}</span></div>`;
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hewn</title>
  <link rel="icon" href="/hewn-mark.svg" type="image/svg+xml">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/_platform/ui.css">
  <link rel="stylesheet" href="/app.css">${site.kind === "public" ? '\n  <script src="/_platform/ascii.js" defer></script>\n  <script type="module" src="/passkey.js"></script>' : ""}
</head>
<body>
  <div class="wallpaper dim" aria-hidden="true"><i class="signin-spot"></i></div>
  <div id="app">
    <div class="ascii-field" aria-hidden="true"><pre id="ascii" class="signin-ascii"></pre></div>
    <main class="signin">
      <div class="signin-brand"><img src="/hewn-mark.svg" alt="" width="36" height="36"><span class="brand-name">Hewn</span></div>
      ${passkey ? "" : `<div class="display signin-title">${title}</div>`}
      ${action}
    </main>
  </div>
</body>
</html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": webCsp(site), "cache-control": "no-store" } },
  );
}

/** Signed out on the public URL: passkey sign-in if one exists for this host, else the link. */
function publicSignIn(platform: Platform, site: Site, status: number, title?: string, hosted?: Hosted): Response {
  if (platform.hasPasskeys(site.rpId!)) return signedOutPage(site, status, title ?? "Sign in to Hewn.", "Use the passkey you added on this device.", "hewn open --print", true, hosted);
  if (hosted) return signedOutPage(site, status, title ?? "Sign in to Hewn.", hostedLine(hosted), "", false, hosted);
  return signedOutPage(site, status, title ?? "Sign in to Hewn.", "Sign in once with a link from the server (run this there over SSH), then add a passkey so this device can sign in on its own:", "hewn open --print");
}

/** What a signed-out hosted owner does: sign in through the host (they have no terminal). */
const hostedLine = (hosted: Hosted) => (hosted.signInUrl ? "Sign in from your account." : "Open Hewn again from your account.");

/**
 * A fingerprint of the web client's code, sent on every API response (x-hewn-web) so a page that
 * stays open across an upgrade notices it is running old code and offers a reload. The host can't
 * list its files, so every one is named here, the client's modules in app/ too (`test/web.test.ts`
 * checks none is missing).
 */
export const WEB_CODE = [
  ...["index.html", "app.js", "kit.js", "passkey.js", "app.css"],
  ...["accounts", "activity", "add-passkey", "agents", "appearance", "build", "connect", "files", "frame", "glyphs", "grants", "home", "inbox", "info", "install", "intake", "models", "palette", "review", "router", "schedules", "settings", "share", "tool", "tool-actions", "tool-model", "versions", "widgets"].map((m) => `app/${m}.js`),
];
let webBuild: Promise<string> | undefined;
function webBuildOf(host: SurfaceHost): Promise<string> {
  return (webBuild ??= (async () => {
    const parts = await Promise.all(WEB_CODE.map((f) => host.asset(`web/${f}`)));
    const all = new Uint8Array(parts.reduce((n, p) => n + (p?.length ?? 0), 0));
    let at = 0;
    for (const p of parts) {
      if (!p) continue;
      all.set(p, at);
      at += p.length;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  })());
}

async function serveStatic(host: SurfaceHost, site: Site, path: string, setCookie?: string): Promise<Response> {
  const name = path === "/" ? "index.html" : path.slice(1);
  const data = name.includes("..") ? undefined : await host.asset(`web/${name}`);
  if (!data) return new Response("not found", { status: 404, headers: { "content-security-policy": webCsp(site) } });
  return new Response(body(data), {
    status: 200,
    headers: { "content-type": typeOf(name), "content-security-policy": webCsp(site), "x-content-type-options": "nosniff", "cache-control": "no-store", ...(setCookie ? { "set-cookie": setCookie } : {}) },
  });
}

/** Header lines of the call logs: "<iso> <caller> <op> <outcome…> <ms>ms". */
function recentCalls(platform: Platform, owner: Agent, limit: number, perCapability = 400) {
  const calls: { at: string; capabilityId: string; caller: string; via: string[]; operation: string; outcome: string; ms: number }[] = [];
  for (const c of platform.list(owner)) {
    for (const line of platform.logLines(c.id, perCapability)) {
      // The caller is the call path ("codex → weekly-review"); the origin is who made it.
      const m = /^(\S+) (.+?) ([a-z][a-z0-9_]*(?:@\d+)?) (ok|ERROR .*) (\d+)ms$/.exec(line);
      if (m) calls.push({ at: m[1], capabilityId: c.id, caller: m[2].split(" → ")[0], via: m[2].split(" → ").slice(1), operation: m[3], outcome: m[4], ms: Number(m[5]) });
    }
  }
  return calls.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export async function handleWeb(platform: Platform, host: SurfaceHost, site: Site, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const asset = await platformAsset(host, path);
  if (asset) return asset;
  const command = site.kind === "public" ? "hewn open --print" : "hewn open";
  /** Signed out: the command to run, or (hosted) the host's sign-in, after `hostedLead`. */
  const signIn = (status: number, title: string, line: string, cmd: string, hostedLead = "") =>
    host.hosted ? signedOutPage(site, status, title, `${hostedLead}${hostedLine(host.hosted)}`, "", false, host.hosted) : signedOutPage(site, status, title, line, cmd);

  if (path === "/auth") {
    const session = platform.redeemWebTicket(url.searchParams.get("ticket") ?? "", req.headers.get("user-agent") ?? undefined);
    if (!session) return signIn(401, "This link has expired.", "Sign-in links work once, for two minutes. Get a new one in a terminal:", command, "Sign-in links work once, for two minutes. ");
    // Signed in to approve an agent: to Agents, where its request waits.
    if (cookieValue(req, nextName(site)) === "agents") return signedIn([sessionCookie(site, session), nextCookie(site, 0)], "/#/agents");
    // On the public URL a link is how a device gets in the first time: offer it a passkey.
    return signedIn(sessionCookie(site, session), site.kind === "public" ? "/#/passkey" : "/");
  }
  if (PUBLIC_FILES.has(path.slice(1))) return serveStatic(host, site, path);

  // Passkey sign-in (public URL only): options, then the device's signed answer.
  if (path.startsWith("/passkey/")) {
    if (site.kind !== "public") return send(404, { error: "not_found", message: "passkeys work on the public URL only" });
    if (req.method !== "POST" || req.headers.get("x-hewn-ui") !== "1" || (req.headers.get("origin") && req.headers.get("origin") !== site.web)) return send(403, { error: "cross-origin or missing X-Hewn-UI header" });
    try {
      if (path === "/passkey/options") return send(200, platform.passkeyGetOptions(site.rpId!));
      if (path === "/passkey/signin") {
        const session = await platform.passkeySignIn({ origin: site.web, rpId: site.rpId! }, await readJson(req), req.headers.get("user-agent") ?? undefined);
        return send(200, { ok: true }, { "set-cookie": sessionCookie(site, session) });
      }
      return send(404, { error: "not_found" });
    } catch (e) {
      if (e instanceof PlatformError) return send(STATUS[e.code] ?? 400, errorBody(e));
      throw e;
    }
  }

  const current = cookieValue(req, cookieName(site));
  const owner = platform.webPrincipal(current);
  // From an agent's sign-in page ("Open Hewn to approve"). That page may open in a browser that
  // isn't signed in to Hewn: then say how to approve from a terminal instead of a dead end.
  if (path === "/approve") {
    if (owner) return new Response(null, { status: 302, headers: { location: "/#/agents" } });
    if (site.kind === "public" && (platform.hasPasskeys(site.rpId!) || host.hosted)) return withNext(site, publicSignIn(platform, site, 401, "Sign in to approve it.", host.hosted));
    const code = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(url.searchParams.get("code") ?? "") ? url.searchParams.get("code")! : undefined;
    if (host.hosted) return withNext(site, signIn(401, "Sign in to approve it.", "", ""));
    return signedOutPage(site, 401, "Approve it in a terminal.", "This browser isn't signed in to Hewn. Approve the agent with:", code ? `hewn agents approve ${code}` : "hewn agents pending");
  }
  if (!owner) {
    if (path.startsWith("/api/")) return send(401, { error: host.hosted ? "not signed in" : `not signed in; run: ${command}` });
    if (site.kind === "public") return publicSignIn(platform, site, 401, undefined, host.hosted);
    return signIn(401, "Signed out.", "To sign in, run this in a terminal:", command);
  }

  // Loading the app renews the cookie, matching the session's sliding 30 days.
  if (!path.startsWith("/api/")) return serveStatic(host, site, path, path === "/" ? sessionCookie(site, current!) : undefined);

  // Defence in depth: capability UIs run on opaque origins (no cookies), and anything not
  // same-origin is refused: Origin (sent cross-origin), Sec-Fetch-Site, and a custom header on
  // state-changing requests.
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  const crossOrigin = (origin && !sameOrigin(site, origin)) || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none");
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (crossOrigin || (mutating && req.headers.get("x-hewn-ui") !== "1")) return send(403, { error: "cross-origin or missing X-Hewn-UI header" });

  if (!path.endsWith("/events") && !(req.method === "GET" && /\/(logs|icon)/.test(path))) host.log(`web ${req.method} ${path}`);
  const res = await answer(platform, host, site, owner, req, url, current!);
  res.headers.set("x-hewn-web", await webBuildOf(host));
  return res;
}

async function answer(platform: Platform, host: SurfaceHost, site: Site, owner: Agent, req: Request, url: URL, current: string): Promise<Response> {
  try {
    const result = await route(platform, host, site, owner, req, url, current);
    return result instanceof Response ? result : send(200, result ?? { ok: true });
  } catch (e) {
    if (e instanceof PlatformError) return send(STATUS[e.code] ?? 400, errorBody(e));
    host.log(`web error: ${(e as Error).stack ?? e}`);
    return send(500, errorBody(e));
  }
}

async function route(platform: Platform, host: SurfaceHost, site: Site, owner: Agent, req: Request, url: URL, current: string): Promise<unknown> {
  const [, , resource, id, sub, arg] = url.pathname.split("/").map(decodeURIComponent); // /api/<resource>/<id>/<sub>/<arg>
  const method = req.method;
  const n = Number(url.searchParams.get("n") ?? 100);

  if (resource === "capabilities" && !id) {
    if (method === "POST") return platform.create(owner, pick(await readJson(req), ["name", "purpose", "requirements", "kind", "after", "widgets", "schedules", "model", "effort", "conversation"]) as any);
    if (url.searchParams.get("archived") === "1") return platform.archived(owner);
    return capabilityList(platform, owner);
  }

  if (resource === "capabilities" && id) {
    switch (`${method} ${sub ?? ""}`) {
      case "GET ":
        return {
          ...platform.get(owner, id),
          versions: platform.registry.versions(id),
          grants: [...platform.registry.grants(id)],
          authorization: platform.authorization(id),
          usedBy: platform.usedBy(id),
        };
      case "POST invoke": {
        const body = await readJson(req);
        return platform.invoke(owner, { capabilityId: id, operation: body.operation, operationVersion: body.operationVersion, input: body.input });
      }
      // Its last failed calls, for "Ask builder to fix this".
      case "GET failures":
        return platform.recentFailures(owner, id);
      // The owner's standing rules for building this tool (one per line); the ones for every tool are /api/instructions.
      case "GET instructions":
        return { lines: platform.instructions(owner, id) };
      case "PUT instructions":
        return { lines: platform.setInstructions(owner, id, (await readJson(req)).text) };
      case "POST modify": {
        const body = await readJson(req);
        return platform.modify(owner, { capabilityId: id, request: body.request, ...(body.after ? { after: String(body.after) } : {}), ...(body.schedules !== undefined ? { schedules: body.schedules } : {}), ...pick(body, ["model", "effort", "conversation"]) });
      }
      case "DELETE widgets":
        return platform.removeWidget(owner, id, arg);
      case "POST widgets": {
        const body = await readJson(req);
        return platform.addWidgets(owner, { capabilityId: id, ...(body.request ? { request: String(body.request) } : {}), ...(body.after ? { after: String(body.after) } : {}), ...pick(body, ["model", "effort", "conversation"]) });
      }
      case "POST open": {
        platform.get(owner, id); // visibility
        // `section`: where a widget's tap lands ("ui#today" → the UI opens at #today).
        const section = /^[A-Za-z0-9_-]{1,40}$/.exec(String((await readJson(req)).section ?? ""))?.[0];
        return { url: `${site.ui(id)}/auth?ticket=${platform.createUiTicket(id)}${section ? `&section=${section}` : ""}` };
      }
      case "GET logs":
        return { lines: platform.logLines(id, n) };
      case "GET icon": {
        platform.get(owner, id);
        // ?default=1: the builder's glyph, without the owner's (what Use default goes back to).
        const icon = await platform.icon(id, { owner: url.searchParams.get("default") !== "1" });
        if (!icon) throw new PlatformError("not_found", "no icon");
        // Uploaded SVGs are untrusted: sandboxed, no scripts, even if opened directly on this origin.
        return new Response(body(icon.data), {
          status: 200,
          headers: { "content-type": icon.type, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "x-content-type-options": "nosniff", "cache-control": "no-store" },
        });
      }
      case "PUT icon": {
        const body = await readJson(req);
        if (body.hue !== undefined) platform.setHue(owner, id, body.hue);
        if (body.saturation !== undefined) platform.setSaturation(owner, id, body.saturation);
        if (body.glyph !== undefined) {
          const cells = typeof body.glyph === "string" ? cellsFromSvg(body.glyph) : cellsFromRows(body.glyph);
          if (!cells) throw new PlatformError("invalid_request", 'glyph must be five rows like ".##.." or a 5×5 SVG');
          await platform.setIcon(owner, id, { glyph: cells });
        } else if (body.emoji !== undefined) throw new PlatformError("invalid_request", "emoji icons are gone: send { glyph } (a 5×5 glyph) or { dataUrl } (an image)");
        else if (body.dataUrl !== undefined) {
          const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,(.+)$/.exec(String(body.dataUrl ?? ""));
          if (!m) throw new PlatformError("invalid_request", "send { glyph } or { dataUrl: data:image/...;base64,... }");
          await platform.setIcon(owner, id, { type: m[1], data: fromBase64(m[2]) });
        }
        return { ok: true };
      }
      case "DELETE icon":
        await platform.setIcon(owner, id, null);
        platform.setHue(owner, id, null);
        platform.setSaturation(owner, id, null);
        return { ok: true };
      case "POST rename":
        platform.rename(owner, id, String((await readJson(req)).name ?? ""));
        return { ok: true };
      case "POST restore":
        platform.restore(owner, id);
        return { ok: true };
      case "POST rollback":
        return platform.rollback(owner, id, (await readJson(req)).version);
      case "POST purge":
        await platform.purge(owner, id, String((await readJson(req)).confirm ?? ""));
        return { ok: true };
      // The code browser: a version's files with what changed since the one before (?version=N), or one file (&path=…).
      case "GET code": {
        const version = Number(url.searchParams.get("version"));
        if (!Number.isInteger(version) || version < 1) throw new PlatformError("invalid_request", "version must be a version number");
        const path = url.searchParams.get("path");
        return path ? platform.versionFile(owner, id, version, path) : platform.versionCode(owner, id, version);
      }
      // Share…: what a version would ship (?version=N), or the file itself (share/download).
      case "GET share": {
        const v = url.searchParams.get("version");
        const version = v ? Number(v) : undefined;
        if (arg !== "download") return platform.shareCheck(owner, id, version);
        const { name, bundle } = await platform.shareBundle(owner, id, version);
        return new Response(body(bundle), { status: 200, headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      // Info › Data › Start over: empty the data, keep the tool (a backup is kept).
      case "POST start-over": {
        const b = await readJson(req);
        return platform.startOver(owner, id, { confirm: String(b.confirm ?? ""), sample: !!b.sample });
      }
      // Write it yourself: sample/calls.json as a new version.
      case "POST sample":
        return platform.setSample(owner, id, String((await readJson(req)).text ?? ""));
      // Info › Data: rows per table and the last write.
      case "GET data":
        return platform.dataSummary(owner, id);
      case "GET export": {
        const data = await platform.exportData(owner, id);
        return new Response(JSON.stringify(data, null, 2), {
          status: 200,
          headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${id}-${data.exportedAt.slice(0, 10)}.json"`, "content-security-policy": WEB_CSP, "cache-control": "no-store" },
        });
      }
      case "DELETE ": {
        if ((await readJson(req)).confirm !== id) throw new PlatformError("invalid_request", `to delete, confirm with the id '${id}'`);
        platform.archive(owner, id);
        return { ok: true };
      }
      case "PUT secrets":
        platform.setSecret(owner, id, arg, String((await readJson(req)).value ?? ""));
        return { ok: true };
      case "GET health":
        return platform.connectionHealth(owner, id);
      case "POST model": {
        const body = await readJson(req);
        return platform.setCapabilityModel(owner, id, { ...(body.tier !== undefined ? { tier: String(body.tier) } : {}), ...(body.model !== undefined ? { model: String(body.model) } : {}) });
      }
      case "POST connect":
        return platform.connect(owner, id, ((await readJson(req)).input ?? {}) as Record<string, unknown>);
      case "PUT config":
        platform.setConfig(owner, id, arg, String((await readJson(req)).value ?? ""));
        return { ok: true };
      case "DELETE secrets":
        platform.deleteSecret(owner, id, arg);
        return { ok: true };
      case "GET schedules":
        return platform.listSchedules(owner, id);
      case "POST schedules": {
        const body = await readJson(req);
        return platform.createSchedule(owner, { capabilityId: id, operation: body.operation, operationVersion: body.operationVersion, input: body.input, cadence: String(body.cadence ?? "") });
      }
      case "POST grants":
        if (arg === "approve") {
          // A body names one grant; no body approves everything the version requests.
          const { grant } = await readJson(req);
          if (grant === undefined) return { approved: platform.approveGrants(owner, id) };
          platform.approveGrant(owner, id, String(grant));
          return { approved: [String(grant)] };
        }
        if (arg === "revoke") return platform.revokeGrant(owner, id, String((await readJson(req)).grant ?? ""));
        if (arg === "decline") return (platform.declineGrant(owner, id, String((await readJson(req)).grant ?? "")), { declined: true });
    }
  }

  if (resource === "accounts") return platform.accounts(owner);

  // Install from a file: upload (staged, read before anything is installed), its code, install, or drop it.
  if (resource === "bundles") {
    if (!id && method === "POST") return platform.stageBundle(owner, fromBase64(String((await readJson(req)).data ?? "")), { from: "file" });
    if (id && !sub && method === "GET") return platform.stagedBundle(owner, id);
    if (id && sub === "code" && method === "GET") {
      const path = url.searchParams.get("path");
      return path ? platform.bundleFile(owner, id, path) : platform.bundleCode(owner, id);
    }
    if (id && sub === "install" && method === "POST") {
      const b = await readJson(req);
      return platform.installBundle(owner, id, { name: String(b.name ?? ""), sample: !!b.sample });
    }
    if (id && !sub && method === "DELETE") {
      await platform.dropStaged(owner, id);
      return { ok: true };
    }
  }

  if (resource === "inbox" && method === "GET") return inbox(platform, host, owner, url.searchParams.get("recent") === "1");

  // Images and files for the intake's box: uploaded as they're added, fetched back for thumbnails. Owner only.
  if (resource === "attachments") {
    if (!id && method === "POST") return platform.addAttachment(owner, pick(await readJson(req), ["session", "kind", "name", "mediaType", "data"]));
    if (id && method === "GET") {
      const { meta, bytes: data } = await platform.attachmentBytes(owner, id);
      return new Response(body(data), {
        status: 200,
        headers: {
          "content-type": meta.kind === "image" ? meta.mediaType : "text/plain; charset=utf-8",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          "content-disposition": `inline; filename="${meta.name.replace(/["\\]/g, "")}"`,
          "cache-control": "private, max-age=3600",
        },
      });
    }
  }

  // The owner's standing rules for building, for every tool (one per line; the intake adds to them, the builder reads them).
  if (resource === "instructions" && !id) {
    if (method === "PUT") return { lines: platform.setInstructions(owner, undefined, (await readJson(req)).text) };
    return { lines: platform.instructions(owner) };
  }

  if (resource === "builds") {
    // ?brief=1: without the logs (the Builds page lists up to 200).
    if (!id) return platform.registry.recentBuilds(Math.min(n, 200)).map((b) => platform.getBuild(owner, b)).map((v) => (url.searchParams.get("brief") === "1" ? { ...v, log: [] } : v));
    if (sub === "events") return streamBuild(platform, owner, id, req.signal);
    // What led to it (the conversation, the instructions, the brief) and the builder's log: kept for the tool's life.
    if (sub === "context") return platform.buildContext(owner, id);
    if (sub === "transcript") return { text: (await platform.buildTranscript(owner, id)) ?? null };
    // "Got what you asked for?": yes, no (with a note), or skip. Stays here.
    if (sub === "feedback" && method === "POST") return platform.setBuildFeedback(owner, id, pick(await readJson(req), ["score", "note"]));
    if (sub === "retry" && method === "POST") return platform.retryBuild(owner, id);
    if (sub === "fix" && method === "POST") return platform.retryBuild(owner, id, { fix: true });
    if (sub === "cancel" && method === "POST") return platform.cancelBuild(owner, id);
    if (sub === "approve" && method === "POST") return platform.approveBuild(owner, id);
    if (sub === "reject" && method === "POST") return platform.rejectBuild(owner, id);
    if (sub === "screenshot") {
      platform.getBuild(owner, id);
      // ?scheme=dark: the dark-mode render, if the build has one (older builds have only light).
      const png = (url.searchParams.get("scheme") === "dark" ? await platform.blobs.get(`screenshots/${id}-dark.png`) : undefined) ?? (await platform.blobs.get(`screenshots/${id}.png`));
      if (!png) throw new PlatformError("not_found", "no screenshot for this build");
      return new Response(body(png), { status: 200, headers: { "content-type": "image/png", "x-content-type-options": "nosniff", "cache-control": "no-store" } });
    }
    if (sub === "icon") {
      platform.getBuild(owner, id);
      const g = await platform.buildGlyph(id);
      if (!g) throw new PlatformError("not_found", "no icon yet");
      return new Response(g.svg, { status: 200, headers: { "content-type": "image/svg+xml", "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff", "cache-control": "no-store" } });
    }
    return platform.getBuild(owner, id);
  }

  if (resource === "schedules") {
    if (!id && method === "POST") return platform.createSchedule(owner, pick(await readJson(req), ["capabilityId", "operation", "operationVersion", "input", "cadence"]) as any);
    if (!id) return platform.listSchedules(owner);
    if (method === "PUT") return platform.updateSchedule(owner, id, pick(await readJson(req), ["status", "cadence", "input"]) as any);
    if (method === "DELETE") return platform.deleteSchedule(owner, id), { ok: true };
  }

  if (resource === "confirmations") {
    if (id && method === "POST") return platform.decideConfirmation(owner, id, !!(await readJson(req)).approve);
    return platform.confirmations(owner);
  }

  if (resource === "activity") {
    return activity(platform, owner, {
      capability: url.searchParams.get("capability") || undefined,
      agent: url.searchParams.get("agent") || undefined,
      before: url.searchParams.get("before") || undefined,
      kinds: url.searchParams.get("kinds")?.split(",").filter(Boolean),
      limit: Math.min(Number(url.searchParams.get("limit") ?? 100), 300),
    });
  }

  if (resource === "settings") {
    platform.agents(owner); // owner only
    if (method === "PUT") {
      const next = await host.settings.write(pick(await readJson(req), ["builder", "intake", "maxBuildAttempts", "sandbox", "backupDir", "firstRunDone", "logRetentionDays", "timeZone", "jobsChosen", "jobModels", "agentModels"]));
      host.log(`web settings changed: ${JSON.stringify(next)}`);
      return { ...next, ...(host.hosted ? { hosted: true } : {}) };
    }
    return { ...(await host.settings.read()), ...(host.hosted ? { hosted: true } : {}) };
  }

  // Settings → Models: provider keys (write-only), tiers, budget, the model catalog, spend.
  if (resource === "models") {
    if (!id && method === "GET") return platform.models(owner);
    if (!id && method === "PUT") return platform.setModelSettings(owner, pick(await readJson(req), ["provider", "tiers", "monthlyCapUsd", "capabilityCapsHost", "capabilityCapsUsd", "prices"]));
    if (id === "keys" && sub && method === "PUT") return platform.setModelKey(owner, sub, String((await readJson(req)).key ?? ""));
    if (id === "keys" && sub && method === "DELETE") return platform.setModelKey(owner, sub, null);
    if (id === "check" && sub && method === "POST") return platform.checkModelProvider(owner, sub);
    if (id === "catalog" && method === "POST") {
      platform.models(owner); // owner only
      return platform.refreshModelCatalog();
    }
    if (id === "spend" && method === "GET") return platform.modelSpend(owner, url.searchParams.get("month") ?? undefined);
  }

  if (resource === "setup") return setupRoute(platform, host, owner, req, id, sub);

  if (resource === "tools") {
    platform.agents(owner); // owner only
    // /api/tools/<agent>/models: what that agent's CLI (or the host's builder) offers, and the
    // names agents may ask a build by it to use, as the platform checks them.
    if (id && sub === "models") {
      const catalog = host.modelCatalog ? await host.modelCatalog(id, url.searchParams.get("fresh") === "1") : { agent: id, models: [{ id: "default", label: "Default", kind: "default", efforts: [] }] };
      return { ...catalog, agentModels: agentModels(await host.settings.read(), id) };
    }
    return host.tools ? host.tools() : [];
  }

  if (resource === "status") {
    platform.agents(owner); // owner only
    const firstRun = !platform.list(owner).length && !(await host.settings.read()).firstRunDone;
    return { ...(host.status ? await host.status() : {}), abi: ABI, firstRun, agents: platform.agents(owner).length };
  }

  // Home: a layout of icons and widgets. Widgets draw their cached view first, then refresh one by one.
  if (resource === "home" && !id && method === "GET") return { layout: platform.homeLayout(owner), gallery: platform.widgetGallery(owner) };
  if (resource === "home" && id === "layout" && method === "PUT") return { layout: platform.setHomeLayout(owner, (await readJson(req)).entries) };
  if (resource === "home" && id === "widgets" && sub && arg === "refresh" && method === "POST") return platform.refreshHomeWidget(owner, sub);
  // A widget's current view without placing it (the Widgets dialog's preview).
  if (resource === "home" && id === "preview" && method === "POST") {
    const b = await readJson(req);
    return platform.widget(owner, String(b.id ?? ""), String(b.widget ?? ""), b.input && typeof b.input === "object" ? b.input : {});
  }
  if (resource === "home" && id === "widgets" && !sub && method === "POST") return { layout: platform.placeWidget(owner, pick(await readJson(req), ["id", "widget", "size", "input"]) as any) };

  if (resource === "home" && id === "order" && method === "PUT") {
    platform.agents(owner); // owner only
    const ids = (await readJson(req)).ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new PlatformError("invalid_request", "send { ids: [...] }");
    platform.registry.setHomeOrder(ids.filter((x) => platform.registry.getCapability(x)));
    return { ok: true };
  }

  if (resource === "sessions") {
    if (id === "signout" && method === "POST") {
      platform.signOut(current);
      return send(200, { ok: true }, { "set-cookie": sessionCookie(site, "", 0) });
    }
    if (id && method === "DELETE") {
      platform.revokeWebSession(owner, id);
      return { ok: true };
    }
    return platform.webSessions(owner, current);
  }

  if (resource === "passkeys") {
    if (method === "GET" && !id) return platform.passkeys(owner);
    if (method === "DELETE" && id) return platform.removePasskey(owner, id), { ok: true };
    if (site.kind !== "public") throw new PlatformError("invalid_request", "passkeys are added on the public address, from the device that will use them");
    if (method === "POST" && id === "options") return platform.passkeyCreateOptions(owner, site.rpId!);
    if (method === "POST" && !id) return platform.addPasskey(owner, { origin: site.web, rpId: site.rpId! }, await readJson(req));
  }

  if (resource === "remote" && method === "GET") {
    platform.agents(owner); // owner only
    const url = platform.publicUrl() ?? null;
    // Where a reverse proxy on this machine forwards to (the public listener); `hewn url` says the same.
    return { url, here: site.kind, records: url ? dnsRecords(url) : [], proxyTo: `127.0.0.1:${host.port + 1}`, passkeys: platform.passkeys(owner) };
  }

  if (resource === "backups") {
    platform.agents(owner); // owner only
    if (!host.backups) throw new PlatformError("not_found", "backups are not available here");
    if (method === "POST") {
      const b = await host.backups.now();
      host.log(`web backup: ${b.file} (${b.bytes} bytes)`);
      return b;
    }
    return { dir: await host.backups.location(), backups: await host.backups.list(), sameDisk: (await host.backups.sameDisk?.()) ?? null };
  }

  if (resource === "agents") {
    if (id === "pending") {
      // OAuth connection requests waiting for the owner.
      if (sub && method === "POST") {
        const b = await readJson(req);
        return platform.decideAgent(owner, sub, b.approve ? { approve: true, name: b.name, scopes: b.scopes as Scope[], capabilities: b.capabilities } : { approve: false });
      }
      return platform.pendingAgents(owner);
    }
    if (!id) {
      // Last call per agent, for "Last used …" and the live dot (calls are newer than the token check's minute).
      const last = new Map<string, string>();
      for (const c of recentCalls(platform, owner, 5000, 2000)) if (!last.has(c.caller)) last.set(c.caller, c.at);
      return platform.agents(owner).map((a) => {
        const call = last.get(a.id) ?? null;
        return { ...a, lastUsedAt: [call, a.lastUsedAt].filter(Boolean).sort().at(-1) ?? null };
      });
    }
    if (method === "PUT") {
      const b = await readJson(req);
      return platform.updateAgent(owner, id, { ...(b.scopes ? { scopes: b.scopes as Scope[] } : {}), ...(b.capabilities ? { capabilities: b.capabilities } : {}) });
    }
    if (method === "DELETE") return platform.updateAgent(owner, id, "revoke");
  }

  if (resource === "intake" && method === "POST") {
    if (!host.intake) throw new PlatformError("not_found", "intake is not configured");
    const intake = host.intake;
    const body = (await readJson(req)) as IntakeRequest;
    const catalog = platform.list(owner).map((c) => ({ id: c.id, name: c.name, purpose: c.purpose, operations: c.operations, ...(c.kind ? { kind: c.kind } : {}) }));
    if (body.mode === "modify" && !body.capabilityId) throw new PlatformError("invalid_request", "a change needs a capabilityId");
    if (body.session !== undefined && (typeof body.session !== "string" || !/^[\w-]{1,80}$/.test(body.session))) throw new PlatformError("invalid_request", "session must be a short id");
    // "Continue from here" on a version: that build's conversation, from the platform (the client only names the build).
    const earlier = body.earlier !== undefined ? earlierConversation(platform, owner, body.earlier?.buildId) : undefined;
    const currentManifest = body.mode !== "create" && body.capabilityId ? platform.get(owner, body.capabilityId) : undefined;
    const started = Date.now();
    const finish = (reply?: IntakeReply, error?: string) => {
      const turn = body.messages.filter((m) => m.role === "user").length;
      const outcome = !reply ? `ERROR ${error}` : reply.kind === "questions" ? `${reply.questions.length} question(s)` : reply.kind === "widgets" ? `${reply.proposals.length} widget proposal(s)` : reply.kind === "ideas" ? `${reply.ideas.length} idea(s)` : reply.kind === "schedules" ? `${reply.schedules.length} schedule(s)` : reply.kind === "answer" ? "answer" : "draft";
      host.log(
        `web intake ${body.mode}${body.capabilityId ? ` ${body.capabilityId}` : ""} turn ${turn} → ${outcome} (${Math.round((Date.now() - started) / 1000)}s)`,
      );
      // The owner's intake conversations, for their own reference/debugging (never shown to agents).
      host.intakeLog?.({ at: new Date().toISOString(), mode: body.mode, capabilityId: body.capabilityId, messages: body.messages, reply, error }).catch(() => {});
    };
    // The owner's standing rules, for the intake to follow (and add to: what it remembers is saved below, and shown as saved).
    const instructions = { global: platform.instructions(owner), ...(currentManifest ? { tool: platform.instructions(owner, body.capabilityId!) } : {}) };
    // What the owner attached (the client sends refs): the bytes come from the store, for the intake to read.
    if (!Array.isArray(body.messages)) throw new PlatformError("invalid_request", "messages must be a list");
    const messages = await Promise.all(body.messages.map(async (m) => (m?.attachments?.length ? { ...m, attachments: await platform.attachmentsWithData(owner, m.attachments) } : { ...m })));
    // Changes on their way: this one lands after them, so the intake builds on them rather than repeating them.
    const coming = currentManifest ? platform.changesComing(owner, body.capabilityId!).map((b) => b.request || `(${b.kind})`) : [];
    const request = { ...body, messages, catalog, current: currentManifest, coming: coming.length ? coming : undefined, instructions, ...(earlier ? { earlier } : {}) } as IntakeRequest;
    const kept = (reply: IntakeReply): IntakeReply => {
      const { remember, forget, ...rest } = reply;
      const saved = platform.applyIntakeMemory(owner, body.capabilityId, remember, forget);
      return saved.remember.length || saved.forget.length ? { ...rest, saved } : rest;
    };
    // With Accept: text/event-stream the answer streams as it is written: progress events, then reply (or error).
    if (!/text\/event-stream/.test(req.headers.get("accept") ?? "")) {
      try {
        const reply = await intake(request);
        finish(reply);
        return kept(reply);
      } catch (e) {
        finish(undefined, (e as Error).message);
        throw e;
      }
    }
    // The owner can stop it (Stop in the chat closes the request): the intake's CLI is stopped too.
    return sse(
      { "content-security-policy": WEB_CSP },
      async (event, signal) => {
        try {
          const reply = await intake(request, (p) => ((p as IntakeProgress).charge !== undefined ? platform.recordHostCharge(owner, "intake", (p as IntakeProgress).charge) : event("progress", p)), signal);
          event("reply", kept(reply));
          finish(reply);
        } catch (e) {
          const message = signal.aborted ? "stopped" : (e as Error).message;
          event("error", { message });
          finish(undefined, message);
        }
      },
      req.signal,
    );
  }

  throw new PlatformError("not_found", `no route ${method} ${url.pathname}`);
}

/** The conversation that led to a build (and the version it made), for the intake to continue from. */
function earlierConversation(platform: Platform, owner: Agent, buildId: unknown): NonNullable<IntakeRequest["earlier"]> {
  if (typeof buildId !== "string") throw new PlatformError("invalid_request", "earlier.buildId must be a build id");
  const b = platform.getBuild(owner, buildId);
  return { buildId, ...(b.resultVersion ? { version: b.resultVersion } : {}), messages: platform.buildContext(owner, buildId).conversation ?? [] };
}

/** Server-sent events: replay the build transcript, then follow live until promoted/failed. */
function streamBuild(platform: Platform, owner: Agent, buildId: string, clientSignal: AbortSignal): Response {
  platform.getBuild(owner, buildId); // exists
  return sse(
    { "content-security-policy": WEB_CSP },
    async (event, signal) => {
      const transcript = (await platform.buildTranscript(owner, buildId).catch(() => undefined)) ?? "";
      for (const line of transcript.split("\n").filter(Boolean).slice(-500)) event("line", line);
      const stamp = () => new Date().toTimeString().slice(0, 8);
      const now = platform.stepState(buildId);
      if (now) event("step", now);
      const final = await platform.waitForBuild(owner, buildId, {
        timeoutMs: 30 * 60_000,
        signal,
        onEvent: (line) => event("line", `${stamp()} ${line}`),
        onStep: (step) => event("step", step),
      });
      if (!signal.aborted) event("done", final);
    },
    clientSignal,
  );
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in (o ?? {})).map((k) => [k, o[k]]));

/** Home: active capabilities plus capabilities whose first build is still in flight. */
async function capabilityList(platform: Platform, owner: Agent) {
  const active = platform.activeBuilds();
  const latest = platform.registry.latestBuilds();
  const building = (capId: string) => {
    const b = active.find((x) => x.capabilityId === capId);
    return b ? { buildId: b.buildId, progress: b.state.progress, step: b.state.step, tests: b.state.tests ?? null } : null;
  };
  const order = (id: string) => platform.registry.getCapability(id)?.homeOrder ?? Number.MAX_SAFE_INTEGER;
  const caps: Record<string, any>[] = [];
  // Unplaced tiles follow in creation order, so a new capability lands last (next to "New").
  const created = (id: string) => platform.registry.getCapability(id)?.createdAt ?? "";
  for (const c of platform.list(owner).sort((a, b) => order(a.id) - order(b.id) || created(a.id).localeCompare(created(b.id)))) {
    const m = platform.get(owner, c.id);
    const icon = await platform.icon(c.id).catch(() => undefined);
    const row = platform.registry.getCapability(c.id);
    const last = latest.get(c.id);
    caps.push({
      ...c,
      hasIcon: !!icon,
      // "image": an owner upload (shown as is); "glyph": a 5×5 glyph, the owner's or the builder's ui/icon.svg (tinted by the tile).
      iconKind: !icon ? null : icon.glyph ? "glyph" : "image",
      hue: platform.hueOf(c.id),
      saturation: platform.saturationOf(c.id),
      ui: !!m.ui?.available,
      version: row?.activeVersion ?? null,
      requests: platform.registry.accessRequests(c.id).length,
      // Not ready only because the owner said no (Deny) to what it asks: nothing to nag about.
      saidNo: !c.ready && saidNoOnly(platform.readiness(c.id)),
      lastBuild: last ? { buildId: last.id, status: last.status } : null,
      building: building(c.id),
    });
  }
  const pending: Record<string, any>[] = [];
  for (const b of active.filter((b) => b.kind === "create" && !caps.some((c) => c.id === b.capabilityId))) {
    // The builder writes the icon first, so a new capability has its own tile while it builds.
    const glyph = await platform.buildGlyph(b.buildId);
    pending.push({
      id: b.capabilityId,
      name: b.name,
      purpose: b.purpose,
      tags: [],
      operations: [],
      ready: false,
      hasIcon: !!glyph,
      iconKind: glyph ? "glyph" : null,
      iconUrl: glyph ? `/api/builds/${b.buildId}/icon` : null,
      hue: glyph?.hue ?? null,
      saturation: glyph?.saturation ?? null,
      ui: false,
      version: null,
      requests: 0,
      lastBuild: { buildId: b.buildId, status: "building" },
      building: building(b.capabilityId),
      // A new connection belongs under Accounts while it builds, not on Home.
      ...(b.connection ? { kind: "connection" } : {}),
    });
  }
  return [...caps, ...pending];
}

const LIVE = new Set(["waiting", "open", "building", "validating"]);

/**
 * Failed builds nobody has dealt with: not retried, and nothing of that capability promoted since
 * (a later change replaced it).
 */
export function unresolvedFailures<T extends { buildId: string; capabilityId: string; kind: string; status: string; createdAt: string; request: Record<string, unknown> }>(builds: T[]): T[] {
  return builds.filter(
    (b) =>
      b.status === "failed" &&
      !builds.some((x) => x.request?.retryOf === b.buildId || x.request?.autoRetryOf === b.buildId) &&
      !builds.some((x) => x.capabilityId === b.capabilityId && (x.kind === b.kind || b.kind === "create") && x.status === "promoted" && x.createdAt > b.createdAt),
  );
}

/**
 * A failed build's reason in one line, as its build page leads with it: the failure's title ("1 of
 * 3 tests didn't pass"), or, when the title only says the builder stopped, what it stopped on.
 */
export const failureReason = (f?: { title: string; detail: string }) => (!f ? "" : f.title === "The builder stopped" && f.detail ? f.detail : f.title);

export interface InboxItem {
  /** "builder-model": the model the owner picked for building has a successor. */
  kind: "grant" | "build" | "review" | "agent" | "confirmation" | "schedule" | "model" | "spend" | "connection" | "builder-model";
  id: string;
  capabilityId?: string;
  agentId?: string;
  buildId?: string;
  title: string;
  detail: string;
  severity: "warn" | "danger";
  action: string;
  at?: string;
}

const usdText = (n: number) => `$${n >= 10 ? Math.round(n) : n.toFixed(2).replace(/\.00$/, "")}`;

/**
 * Everything that waits for the owner, in one list (the Inbox's "Needs you"), what's building,
 * and (with `recent`) the last few Activity rows. Each "needs" row opens its own sheet.
 */
/** Whether the only thing between a tool and running is what the owner said no to (Deny). */
const saidNoOnly = (st: Readiness) =>
  !!st.declinedGrants?.length && st.declinedGrants.length === st.pendingGrants.length && !st.missingConfig.length && !st.missingSecrets.length && !st.missingDependencies.length && !st.missingModel && !st.unsupportedAbi;

async function inbox(platform: Platform, host: SurfaceHost, owner: Agent, recent: boolean) {
  const needs: InboxItem[] = [];
  const caps = platform.list(owner);
  // A tool in its first build isn't listed yet: its reserved name, not its id.
  const nameOf = (id: string) => platform.registry.getCapability(id)?.displayName ?? caps.find((c) => c.id === id)?.name ?? platform.registry.getCapability(id)?.name ?? id;
  const builds = platform.registry.recentBuilds(60).map((id) => platform.getBuild(owner, id));
  const live = new Set(builds.filter((b) => LIVE.has(b.status)).map((b) => b.capabilityId));
  const agents = new Map(platform.agents(owner).map((a) => [a.id, a.name]));
  const who = (id: string) => (id === "web" || id === "user" || id.startsWith("ui:") ? "You" : agents.get(id) ?? id);

  // An agent's destructive call blocks that agent: the most urgent.
  for (const c of platform.confirmations(owner))
    needs.push({ kind: "confirmation", id: c.id, capabilityId: c.capabilityId, agentId: c.agentId, title: nameOf(c.capabilityId), detail: `${who(c.agentId)} wants to run ${c.operation.split("@")[0]}`, severity: "danger", action: "Review", at: c.createdAt });
  for (const p of platform.pendingAgents(owner))
    needs.push({ kind: "agent", id: p.id, title: p.clientName, detail: p.reconnects ? `wants to connect again as ${p.reconnects}` : "wants to connect", severity: "warn", action: "Review", at: p.createdAt });
  for (const b of builds.filter((x) => x.status === "review"))
    needs.push({ kind: "review", id: b.buildId, buildId: b.buildId, capabilityId: b.capabilityId, title: nameOf(b.capabilityId), detail: `${who(b.requestedBy)} changed it: it waits for you`, severity: "warn", action: "Review", at: b.updatedAt });
  for (const b of unresolvedFailures(builds))
    needs.push({ kind: "build", id: b.buildId, buildId: b.buildId, capabilityId: b.capabilityId, title: platform.registry.getCapability(b.capabilityId) ? nameOf(b.capabilityId) : String(b.request?.name ?? b.capabilityId), detail: `Build failed${b.failure ? ` · ${failureReason(b.failure)}` : ""}`, severity: "danger", action: "Show", at: b.updatedAt });
  for (const x of platform.listSchedules(owner).filter((s) => s.status === "proposed"))
    needs.push({ kind: "schedule", id: x.id, capabilityId: x.capabilityId, agentId: x.createdBy, title: nameOf(x.capabilityId), detail: `${who(x.createdBy)} wants to run ${x.operation.split("@")[0]} ${x.cadence}`, severity: "warn", action: "Review", at: x.createdAt });
  // A schedule that stopped itself after failing in a row: whatever it keeps fresh goes stale quietly otherwise.
  for (const x of platform.listSchedules(owner).filter((s) => s.status === "paused" && s.pausedReason))
    needs.push({ kind: "schedule", id: x.id, capabilityId: x.capabilityId, title: nameOf(x.capabilityId), detail: `${x.operation.split("@")[0]} stopped running ${x.cadence}: it failed ${x.failures} times in a row`, severity: "danger", action: "Resume…", at: x.lastRunAt ?? x.createdAt });

  // Tools (and connections) that can't run until the owner does something.
  let modelUsers = false;
  for (const c of caps) {
    const m = platform.activeManifest(c.id);
    if (m.requires?.model) modelUsers = true;
    if (live.has(c.id)) continue;
    const st = platform.readiness(c.id);
    const connection = m.kind === "connection";
    // What the owner said no to (Deny) isn't asked again.
    const asking = st.pendingGrants.filter((g) => !st.declinedGrants?.includes(g));
    if (asking.length || st.missingConfig.length || (st.missingSecrets.length && !connection)) {
      const first = platform.authorization(c.id).items.find((i) => !i.approved && asking.includes(i.grant));
      const words = !first
        ? connection ? "needs setting up" : "needs your authorization"
        : first.kind === "capability"
          ? `wants to ${first.sideEffect === "read" ? "read" : "write to"} ${first.target ? nameOf(first.target) : "another tool"}`
          : first.kind === "host"
            ? `wants to reach ${first.grant.slice(5).replace(/^config:/, "")}`
            : first.kind === "secret"
              ? `needs ${first.grant.slice(7)}`
              : "wants to use a model";
      needs.push({ kind: connection ? "connection" : "grant", id: c.id, capabilityId: c.id, title: nameOf(c.id), detail: words, severity: "warn", action: connection ? "Set up" : "Review" });
    } else if (st.retiredModel) {
      needs.push({ kind: "model", id: c.id, capabilityId: c.id, title: nameOf(c.id), detail: "its pinned model was retired", severity: "danger", action: "Replace…" });
    } else if (st.missingModel && !connection) {
      needs.push({ kind: "model", id: c.id, capabilityId: c.id, title: nameOf(c.id), detail: "needs a model", severity: "warn", action: "Set up" });
    }
  }
  for (const x of (await platform.accounts(owner)).connections) {
    if (live.has(x.id) || needs.some((n) => n.capabilityId === x.id) || x.health.status === "connected") continue;
    needs.push({ kind: "connection", id: x.id, capabilityId: x.id, title: x.name, detail: x.health.detail ?? x.health.status, severity: x.health.status === "broken" ? "danger" : "warn", action: x.signIn ? "Sign in" : "Set up" });
  }

  // Model spend: 80% of the month's cap, and caps that refuse calls now.
  if (modelUsers) {
    const m = platform.models(owner);
    const { totalUsd, capUsd, rows } = m.spend;
    if (capUsd > 0 && totalUsd >= capUsd)
      needs.push({ kind: "spend", id: "all", title: "Models", detail: `${usdText(totalUsd)} of ${usdText(capUsd)}: calls are refused until you raise the cap`, severity: "danger", action: "Raise cap…" });
    else if (capUsd > 0 && totalUsd >= 0.8 * capUsd) needs.push({ kind: "spend", id: "all", title: "Models", detail: `${Math.round((totalUsd / capUsd) * 100)}% of this month's ${usdText(capUsd)}`, severity: "warn", action: "Open" });
    // Hosted: a tool over its own cap (in the host's unit).
    for (const [id, cap] of Object.entries(m.host ? m.capabilityCapsHost : {})) {
      const { spent, unit } = m.hostCapUse[id] ?? { spent: 0, unit: "Credits" };
      // As for the USD caps: 0 is "none for this tool", not something to flag.
      if (cap > 0 && spent >= cap && caps.some((c) => c.id === id)) needs.push({ kind: "spend", id, capabilityId: id, title: nameOf(id), detail: `calls refused: over its cap of ${cap} ${unit}`, severity: "danger", action: "Raise cap…" });
    }
    for (const [id, cap] of Object.entries(m.capabilityCapsUsd)) {
      const spent = rows.filter((r) => r.capabilityId === id).reduce((n, r) => n + r.costUsd, 0);
      if (cap > 0 && spent >= cap && caps.some((c) => c.id === id)) needs.push({ kind: "spend", id, capabilityId: id, title: nameOf(id), detail: `calls refused: over its ${usdText(cap)} cap`, severity: "danger", action: "Raise cap…" });
    }
  }
  needs.push(...(await modelNotices(host)));

  const order = { danger: 0, warn: 1 };
  needs.sort((a, b) => (a.kind === "confirmation" ? -1 : b.kind === "confirmation" ? 1 : 0) || order[a.severity] - order[b.severity] || (b.at ?? "").localeCompare(a.at ?? ""));

  const building = builds
    .filter((b) => LIVE.has(b.status))
    .map((b) => ({ buildId: b.buildId, capabilityId: b.capabilityId, name: platform.registry.getCapability(b.capabilityId) ? nameOf(b.capabilityId) : String(b.request?.name ?? b.capabilityId), kind: b.kind, status: b.status, step: b.step ?? null, tests: b.tests ?? b.step?.tests ?? null, dependsOn: b.dependsOn ?? null, queued: !!b.queued }));
  return { needs, building, ...(recent ? { recent: activity(platform, owner, { limit: 6 }).items } : {}) };
}

/** The model the owner picked for a job, when its CLI names a successor. Gone once the owner picks another. */
async function modelNotices(host: SurfaceHost): Promise<InboxItem[]> {
  const s = await host.settings.read();
  const pinned = jobModel(s, "builder", s.builder).model;
  if (!pinned || !host.modelCatalog) return [];
  const upgrade = (await host.modelCatalog(s.builder).catch(() => undefined))?.models.find((m) => m.id === pinned)?.upgrade;
  return upgrade ? [{ kind: "builder-model", id: "builder", title: "Builds tools", detail: `${upgrade} replaces ${pinned}`, severity: "warn", action: "Change…" }] : [];
}

export interface ActivityItem {
  kind: "build" | "call" | "grant" | "lifecycle" | "authority" | "model";
  at: string;
  capabilityId: string;
  /** Who did it: an agent id, "web"/"user" (the owner), "ui:<id>" (the owner via an app), or "capability:<id>". */
  actor: string;
  outcome: string;
  [k: string]: unknown;
}

/** "you" is the owner however they acted: web, CLI, or an opened app (ui:<id>). */
const actorIs = (actor: string, filter: string) => (filter === "you" ? actor === "web" || actor === "user" || actor.startsWith("ui:") : actor === filter);

/** One merged, time-sorted timeline of builds, calls, grant and other authority changes (newest first), paginated by `before`. */
function activity(platform: Platform, owner: Agent, q: { capability?: string; agent?: string; before?: string; kinds?: string[]; limit: number }) {
  const items: ActivityItem[] = [];
  for (const id of platform.registry.recentBuilds(500)) {
    const b = platform.getBuild(owner, id);
    const row = platform.registry.getBuild(id)!;
    items.push({
      kind: "build",
      at: b.status === "promoted" || b.status === "failed" ? row.updatedAt : row.createdAt,
      capabilityId: b.capabilityId,
      actor: b.requestedBy,
      outcome: b.status,
      buildId: b.buildId,
      buildKind: b.kind,
      builder: b.builder,
      ...(b.model ? { buildModel: b.model } : {}),
      ...(b.charge ? { charge: b.charge } : {}),
      version: row.resultVersion,
      ...(b.failure ? { failure: b.failure, reason: failureReason(b.failure) } : {}),
    });
  }
  for (const c of recentCalls(platform, owner, 5000, 2000)) {
    // Home's widgets refreshing themselves: kept in the tool's own call log, not in Activity.
    if (c.caller.startsWith("widget:")) continue;
    items.push({ kind: "call", at: c.at, capabilityId: c.capabilityId, actor: c.caller, outcome: c.outcome, operation: c.operation, ms: c.ms, via: c.via });
  }
  for (const m of platform.registry.recentModelCalls(2000)) {
    items.push({ kind: "model", at: m.at, capabilityId: m.capabilityId, actor: m.caller, outcome: m.status, model: m.model, costUsd: m.costUsd, inputTokens: m.inputTokens, outputTokens: m.outputTokens, ...(m.error ? { error: m.error } : {}) });
  }
  for (const e of platform.registry.lifecycleEvents(500)) {
    items.push({ kind: "lifecycle", at: e.at, capabilityId: e.capabilityId, actor: e.actor, outcome: e.action, detail: e.detail });
  }
  for (const g of platform.registry.grantEvents(1000)) {
    items.push({ kind: "grant", at: g.at, capabilityId: g.capabilityId, actor: g.actor, outcome: g.action, grant: g.grant });
  }
  for (const e of platform.registry.authorityEvents(1000)) {
    items.push({ kind: "authority", at: e.at, capabilityId: e.capabilityId ?? "", actor: e.actor, outcome: e.action, subject: e.subject, detail: e.detail });
  }
  const filtered = items
    .filter((i) => (!q.kinds?.length || q.kinds.includes(i.kind)) && (!q.capability || i.capabilityId === q.capability) && (!q.agent || actorIs(i.actor, q.agent) || (i.kind === "authority" && i.subject === q.agent)) && (!q.before || i.at < q.before))
    .sort((a, b) => b.at.localeCompare(a.at));
  const page = filtered.slice(0, q.limit);
  return { items: page, next: filtered.length > page.length ? page.at(-1)!.at : null };
}

/**
 * Connect an agent (owner only). `manual`: the addresses an MCP client connects to (it signs
 * in with OAuth, approved here). `agents/<id>`: registers Hewn with a local harness and starts its
 * OAuth login, streaming each step; the approval card shows up in Agents.
 */
async function setupRoute(platform: Platform, host: SurfaceHost, owner: Agent, req: Request, id: string, sub: string): Promise<unknown> {
  platform.agents(owner); // owner only
  const mcpUrl = `http://127.0.0.1:${host.port}/mcp`;
  const method = req.method;
  if (id === "manual") {
    const tunnel = host.tunnel ? await host.tunnel().catch(() => null) : null;
    const reachable = platform.publicUrl() ?? (tunnel?.state === "up" && tunnel.url ? tunnel.url : null);
    return { url: mcpUrl, publicUrl: reachable ? `${reachable}/mcp` : null, tunnel, pointer: AGENT_POINTER };
  }
  if (!host.setup) throw new PlatformError("not_found", host.hosted ? "there are no local agents to connect here: connect claude.ai, ChatGPT or another agent through your address" : "connecting agents from the web is not available here; run: hewn setup");
  const setup = host.setup;
  if (id !== "agents") throw new PlatformError("not_found", `no route ${method} /api/setup/${id ?? ""}`);
  const all = await setup.list();
  if (!sub) return all;
  const row = all.find((x) => x.agentId === sub);
  if (!row) throw new PlatformError("not_found", `no agent harness '${sub}'`);
  if (method !== "POST") return row;
  if (row.cloud) throw new PlatformError("invalid_request", `${row.label} connects through your tunnel, like claude.ai: add Hewn under Settings → Connectors`);
  // A desktop app that shares a harness's settings (Codex Desktop → Codex) connects through it.
  const h = row.via ? all.find((x) => x.agentId === row.via) : row;
  if (!h?.found) throw new PlatformError("not_found", row.via ? `${row.label} uses the ${h?.label ?? row.via} CLI's settings to connect; install it, then connect again` : `${row.label} was not found on this computer`);
  return sse({ "content-security-policy": WEB_CSP }, (event) => setup.connect(h.agentId, mcpUrl, event));
}
