// SPDX-License-Identifier: AGPL-3.0-or-later
// Small web-standard helpers shared by the surface handlers.
import { PlatformError } from "@hewntools/core/errors.ts";

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function readJson(req: Request): Promise<any> {
  const raw = await req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Never echo the body: it may hold a password (a sign-in step's input).
    throw new PlatformError("invalid_request", "the request body is not valid JSON");
  }
}

export const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, not_ready: 409, conflict: 409, unauthenticated: 401, awaiting_confirmation: 409 };

export const errorBody = (e: unknown) =>
  e instanceof PlatformError ? { error: e.code, message: e.message, details: e.details } : { error: "internal", message: (e as Error).message };

/**
 * Server-sent events as a Response. `run` writes events; the stream ends when it settles.
 * `signal` aborts when the client goes away.
 */
export function sse(headers: Record<string, string>, run: (event: (name: string, data: unknown) => void, signal: AbortSignal) => Promise<void>, clientSignal?: AbortSignal): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const abort = new AbortController();
  clientSignal?.addEventListener("abort", () => abort.abort(), { once: true });
  let open = true;
  const event = (name: string, data: unknown) => {
    if (!open) return;
    writer.write(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {
      open = false;
      abort.abort();
    });
  };
  run(event, abort.signal)
    .catch((e) => event("error", { message: (e as Error).message }))
    .finally(() => {
      open = false;
      writer.close().catch(() => {});
    });
  return new Response(readable, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...headers } });
}

export const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
};
export const typeOf = (path: string) => TYPES[path.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream";

export const cookieValue = (req: Request, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];

/** Bytes as a Response body (TS's DOM typings don't accept every Uint8Array buffer kind). */
/** HTML-escape text for the server-rendered pages. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const body = (b: Uint8Array | string): BodyInit => b as unknown as BodyInit;
