// SPDX-License-Identifier: AGPL-3.0-or-later
// Install from a link: a tool's file fetched from a URL the owner gave. https only, at most 5 MB,
// and every redirect checked as the first address is. On the workerd host, workerd's own network
// rule (public addresses only) stands behind this, also for a name that resolves to a private one.
import { MAX_BUNDLE_BYTES } from "@hewntools/core/bundle.ts";
import { PlatformError } from "@hewntools/core/errors.ts";

const MAX_HOPS = 5;
const TIMEOUT_MS = 30_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const refuse = (message: string) => new PlatformError("invalid_request", message, { refusal: "link" });

/**
 * Fetch a tool's file from `raw`: its bytes, `host` where they came from (the last redirect's host:
 * what "From <host>" and the tool's `source` say), and `linkHost`, the host of the link as given.
 */
export async function fetchLink(raw: string, fetchFn: typeof fetch = fetch): Promise<{ bytes: Uint8Array; host: string; linkHost: string }> {
  let url = linkUrl(raw, "The link");
  const linkHost = url.host;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchFn(new Request(url, { redirect: "manual", signal, headers: { accept: "application/zip, application/octet-stream" } }));
    } catch (e) {
      throw refuse(signal.aborted ? `${url.host} didn't answer within ${TIMEOUT_MS / 1000} seconds.` : `Hewn couldn't reach ${url.host} (${(e as Error).message}).`);
    }
    const location = res.headers.get("location");
    if (REDIRECTS.has(res.status) && location) {
      await res.body?.cancel();
      if (hop >= MAX_HOPS) throw refuse(`The link redirects more than ${MAX_HOPS} times.`);
      url = linkUrl(new URL(location, url).href, "It redirects to a link that");
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw refuse(res.status === 404 || res.status === 410 ? `There's nothing at that link (${res.status}): it may have expired or been revoked.` : `${url.host} answered ${res.status}.`);
    }
    return { bytes: await capped(res), host: url.host, linkHost };
  }
}

/** A link Hewn will fetch: https, no user name or password, and not an address on this machine or its network. */
function linkUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw refuse("That isn't a link: paste the whole address, starting with https://.");
  }
  if (url.protocol !== "https:") throw refuse(`${what} isn't https. Hewn fetches only https links.`);
  if (url.username || url.password) throw refuse(`${what} has a user name or password in it. Hewn doesn't fetch those.`);
  if (privateHost(url.hostname)) throw refuse(`${what} points at ${url.hostname}, an address on this machine or its own network. Hewn fetches only public addresses.`);
  return url;
}

/** Names and IP addresses that aren't on the public internet. */
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(h) || (!h.includes(".") && !h.startsWith("["))) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) return privateV4(v4.slice(1).map(Number));
  if (!h.startsWith("[")) return false;
  const v6 = h.slice(1, -1);
  const mapped = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v6) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapped) return mapped.length === 5 ? privateV4(mapped.slice(1).map(Number)) : privateV4([parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255]);
  return v6 === "::" || v6 === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
}

const privateV4 = ([a, b]: number[]) => a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;

/** The body, refused once it's over 5 MB (whatever Content-Length says). */
async function capped(res: Response): Promise<Uint8Array> {
  const tooBig = () => refuse(`The file at that link is over ${MAX_BUNDLE_BYTES / 1024 / 1024} MB; a tool's file may be at most ${MAX_BUNDLE_BYTES / 1024 / 1024} MB.`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BUNDLE_BYTES) {
    await res.body?.cancel();
    throw tooBig();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  for (;;) {
    const r = await reader?.read();
    if (!r || r.done) break;
    total += r.value.length;
    if (total > MAX_BUNDLE_BYTES) {
      await reader!.cancel();
      throw tooBig();
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.length));
  return out;
}
