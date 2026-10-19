// SPDX-License-Identifier: AGPL-3.0-or-later
// The egress gate's rules, runtime-neutral (the Egress entrypoint in worker.ts applies them).

export const hostAllowed = (host: string, allowed: string[]) =>
  allowed.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));

const denied = (host: string) => new Response(`egress denied: ${host} is not in this capability's approved hosts`, { status: 403 });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 10;

/**
 * Fetch for a capability: every hop, redirects included, must be to an approved host (a followed
 * redirect would otherwise take it anywhere). Redirects are followed here, one checked hop at a
 * time, as fetch would: 303 (and 301/302 after a POST) turn into a GET without a body; credentials
 * aren't carried to another origin. A capability that asked for `redirect: "manual"` gets the
 * redirect itself.
 */
export async function gatedFetch(request: Request, hosts: string[], fetchFn: (req: Request) => Promise<Response> = fetch): Promise<Response> {
  const manual = request.redirect === "manual";
  let url = new URL(request.url);
  if (!hostAllowed(url.hostname, hosts)) return denied(url.hostname);
  let method = request.method;
  const headers = new Headers(request.headers);
  // Buffered, so a 307/308 can send it again.
  let body: ArrayBuffer | undefined = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(new Request(url, { method, headers, body, redirect: "manual", signal: request.signal }));
    const location = res.headers.get("location");
    if (manual || !REDIRECTS.has(res.status) || !location) return res;
    if (hop >= MAX_HOPS) return new Response("egress: too many redirects", { status: 508 });
    const next = new URL(location, url);
    if (!hostAllowed(next.hostname, hosts)) return denied(next.hostname);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      if (method !== "HEAD") method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    if (next.origin !== url.origin) for (const h of ["authorization", "cookie", "proxy-authorization"]) headers.delete(h);
    url = next;
  }
}
