// SPDX-License-Identifier: AGPL-3.0-or-later
// Install from a link: a tool's file fetched from a URL the owner gave. https only, at most 5 MB,
// and every redirect checked as the first address is. On the workerd host, workerd's own network
// rule (public addresses only) stands behind this, also for a name that resolves to a private one.
import { MAX_BUNDLE_BYTES } from "@hewntools/core/bundle.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import type { BundleOrigin } from "@hewntools/core/platform/sharing.ts";

const MAX_HOPS = 5;
const TIMEOUT_MS = 30_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const refuse = (message: string) => new PlatformError("invalid_request", message, { refusal: "link" });

/**
 * Fetch a tool's file from `raw`: its bytes, and where they came from to stage them with: `host`, the
 * last redirect's host (what "From <host>" and the tool's `source` say), and `linkHost`, the link's
 * own host, when that's another.
 */
export async function fetchLink(raw: string, fetchFn: typeof fetch = fetch): Promise<{ bytes: Uint8Array; origin: BundleOrigin }> {
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
    let bytes: Uint8Array;
    try {
      bytes = await capped(res);
    } catch (e) {
      if (e instanceof PlatformError) throw e;
      throw refuse(signal.aborted ? `${url.host} didn't send the whole file within ${TIMEOUT_MS / 1000} seconds.` : `The download from ${url.host} broke off (${(e as Error).message}).`);
    }
    return { bytes, origin: { from: "link", host: url.host, ...(linkHost !== url.host ? { linkHost } : {}) } };
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
  const g = v6Groups(h.slice(1, -1));
  if (!g) return true;
  const v4of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // An IPv4 address inside: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d, :: and ::1 among them), NAT64 (64:ff9b::a.b.c.d), 6to4 (2002:aabb:ccdd::).
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return privateV4(v4of(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return privateV4(v4of(g[6], g[7]));
  if (g[0] === 0x2002) return privateV4(v4of(g[1], g[2]));
  // Local-use NAT64, unique local, link-local, site-local and multicast.
  return (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

/** An IPv6 address's eight 16-bit groups (a dotted IPv4 tail read as two), or null if it doesn't read as one. */
function v6Groups(v6: string): number[] | null {
  const halves = v6.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => {
    if (!s) return [];
    const parts = s.split(":");
    const dotted = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(parts.at(-1)!);
    const tail = dotted ? dotted.slice(1).map(Number) : null;
    const hex = (dotted ? parts.slice(0, -1) : parts).map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
    return tail ? [...hex, (tail[0] << 8) | tail[1], (tail[2] << 8) | tail[3]] : hex;
  };
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  const all = halves.length === 2 ? (fill >= 1 ? [...head, ...Array(fill).fill(0), ...rest] : null) : head;
  return all && all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null;
}

const privateV4 = ([a, b]: number[]) => a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;

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
