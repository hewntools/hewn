// SPDX-License-Identifier: AGPL-3.0-or-later
// Where a browser request is addressed. Two sites, same layout:
//   local:  http://hewn.localhost:<port>, capability UIs at http://hewn.localhost:<port>/tools/<id>/
//   public: https://hewn.example.com,     capability UIs at https://hewn.example.com/tools/<id>/
// One host per site: capability UIs are isolated by the browser's sandbox (an opaque origin, see
// ui.ts), not by a host of their own. The public site exists once the owner sets a public URL
// (`hewn url`), and only answers on the public listener, behind the owner's reverse proxy or
// tunnel (which provides HTTPS).

export interface Site {
  kind: "local" | "public";
  /** The web client's origin. */
  web: string;
  /** Where a capability UI lives: `<web>/tools/<id>` (no trailing slash). */
  ui(capabilityId: string): string;
  /** Whether a request's Host is this site's. */
  isWeb(host: string | null | undefined): boolean;
  /** HTTPS: cookies are Secure (and __Host-). */
  secure: boolean;
  /** Passkeys' relying party id: the web client's host name (public site only). */
  rpId?: string;
}

const ID = "[a-z0-9][a-z0-9-]*";

/** `/tools/<id>/<rest>` → the capability and the path inside its UI (`/` and below). */
export function uiPath(pathname: string): { capabilityId: string; path: string } | undefined {
  const m = new RegExp(`^/tools/(${ID})(/.*)?$`).exec(pathname);
  return m ? { capabilityId: m[1], path: m[2] ?? "" } : undefined;
}

export function localSite(port: number): Site {
  const web = `http://hewn.localhost:${port}`;
  return {
    kind: "local",
    web,
    ui: (id) => `${web}/tools/${id}`,
    isWeb: (host) => /^hewn\.localhost(:\d+)?$/.test(host ?? ""),
    secure: false,
  };
}

/** `url` as stored by the platform (normalizePublicUrl): https://host[:port]. */
export function publicSite(url: string): Site {
  const u = new URL(url);
  return {
    kind: "public",
    web: u.origin,
    ui: (id) => `${u.origin}/tools/${id}`,
    isWeb: (host) => (host ?? "").toLowerCase() === u.host,
    secure: true,
    rpId: u.hostname,
  };
}

/** The host a public request was addressed to (the Node public listener forwards it as x-forwarded-host). */
export const requestHost = (req: Request) => (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host).split(",")[0].trim().toLowerCase();

/** The DNS record the public URL needs (printed by `hewn url`, shown in Settings). */
export function dnsRecords(url: string): { name: string; type: string; value: string; why: string }[] {
  return [{ name: new URL(url).hostname, type: "A", value: "<your public IP>", why: "the web client, capability apps, sign-in and MCP" }];
}
