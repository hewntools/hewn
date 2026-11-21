// SPDX-License-Identifier: AGPL-3.0-or-later
// The channel between the platform and the tools: they run in separate workerd processes, and talk
// HTTP over Unix sockets in the data dir. The platform calls the tools process (one route per
// CapabilityHost method, with the tools' token); the tools process calls back for a running call's
// `call` and `model` (with that call's own token, good only while it runs), and tells the platform
// when a tool's fetch goes out and comes back (`/egress`, with the tools' token). A tool's code sees
// neither token.
import type { GenerateRequest } from "@hewntools/core/models.ts";
import type { Migration } from "@hewntools/core/migrations.ts";
import type { CodeRef } from "@hewntools/core/ports.ts";

/** The tools' token: on every call the platform makes to the tools process, and on Egress's marks back. */
export const TOOLS_TOKEN_HEADER = "x-hewn-tools";
/** A running call's token, on its callbacks to the platform. */
export const CALL_TOKEN_HEADER = "x-hewn-call";
/** On an invoke's answer, sent when the call starts (its result follows in the body). */
export const STARTED_HEADER = "x-hewn-started";
/** With it: the key of the isolate the call runs in (Egress tells the platform about that isolate's fetches). */
export const ISOLATE_HEADER = "x-hewn-isolate";

/** Code by hash: the bundle's text only goes when the tools process hasn't got it (it answers 409). */
export type SentCode = { hash: string; js?: string };

/** What each route takes (the platform → the tools process). */
export interface HostCalls {
  // `hosts`: what the code may reach (a data op on the live tool gets its calls' hosts); `named`: it runs in
  // the live tool's own isolate (CapabilityHost.worker).
  invoke: { code: SentCode; scratch: string | null; key: string; input: unknown; secrets: Record<string, string>; hosts: string[]; caller: { kind: string; id: string } | undefined; config: Record<string, string>; readOnly: boolean; limit: number; named: boolean; call: string; model: boolean };
  stop: { scratch: string | null; reason: string };
  describe: { code: SentCode };
  migrate: { scratch: string | null; migrations: Migration[]; code: SentCode; limit: number; hosts: string[]; named: boolean };
  dump: { scratch: string | null; code: SentCode; limit: number; hosts: string[]; named: boolean };
  count: { scratch: string | null; code: SentCode; limit: number; hosts: string[]; named: boolean };
  load: { scratch: string | null; tables: Record<string, Record<string, unknown>[]>; code: SentCode; limit: number; hosts: string[]; named: boolean };
  hasState: { scratch: string | null };
  copyState: { from: string | null; to: string | null };
  dropState: { scratch: string | null };
  listStates: { prefix: string };
}
export type HostMethod = keyof HostCalls;
export const HOST_METHODS: HostMethod[] = ["invoke", "stop", "describe", "migrate", "dump", "count", "load", "hasState", "copyState", "dropState", "listStates"];

/** The callbacks a running call makes (the tools process → the platform). */
export interface Callbacks {
  call: { capabilityId: string; operation: string; input: unknown };
  model: GenerateRequest;
}
export type CallbackKind = keyof Callbacks;

/** Bundles the tools process keeps by hash. */
export const CODES_KEPT = 200;

/**
 * Egress's mark to the platform (POST `/egress`): a fetch out of `isolate` went out (1) or is over (-1);
 * or one was refused, and to which host (`denied`).
 */
export const EGRESS_PATH = "/egress";
export type EgressMark = { isolate: string; delta: 1 | -1 } | { build: string; denied: string };

/** The build a scratch state is one of ("test:<build>", "visual:<build>" …): its isolates are its own, and report the hosts they're refused. */
export const buildOf = (scratch: string | null | undefined) => (scratch ? scratch.slice(scratch.indexOf(":") + 1) : undefined);

/** A refused host as it's reported: a host name is at most 253 characters, so anything longer is cut there. */
export const reportedHost = (host: string) => (host.length > 253 ? `${host.slice(0, 252)}…` : host);

/** How a call to the tools process is sent: a bound on its answer, and `started` (an invoke started there, in this isolate). */
export type SendOptions = { timeoutMs?: number; started?: (isolate: string) => void };

/** The tools process didn't answer: it stopped, was restarted, or is stuck (`timeout`). */
export class ToolsUnreachable extends Error {
  readonly timeout: boolean;
  constructor(message: string, timeout = false) {
    super(message);
    this.timeout = timeout;
  }
}

/** The tools process's socket, as a service binding (workerd's Fetcher). */
export type ToolsSocket = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** A call to one capability's host in the tools process. */
export type ToolsHost = {
  [M in HostMethod]: (body: Omit<HostCalls[M], "code"> & ("code" extends keyof HostCalls[M] ? { code: CodeRef } : unknown), o?: SendOptions) => Promise<any>;
};

/**
 * The platform's side: `tools` is the tools process's socket, `token` its token. Code goes by hash once the tools
 * process has it; a tools process started since gets the text again.
 */
export function toolsChannel(tools: ToolsSocket, token: string): (capabilityId: string) => ToolsHost {
  /** Hashes the tools process has the text of (as far as the platform knows: it says 409 when it hasn't). */
  const sent = new Set<string>();
  const post = async (capabilityId: string, method: HostMethod, body: Record<string, unknown>, o: SendOptions = {}): Promise<unknown> => {
    const { timeoutMs } = o;
    const code = body.code as CodeRef | undefined;
    const send = async (withJs: boolean) => {
      const payload = code ? { ...body, code: withJs ? { hash: code.hash, js: code.js } : { hash: code.hash } } : body;
      try {
        return await tools.fetch(`http://tools/${method}`, {
          method: "POST",
          headers: { [TOOLS_TOKEN_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ capabilityId, ...payload }),
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
      } catch (e) {
        const timeout = (e as Error).name === "TimeoutError";
        throw new ToolsUnreachable(timeout ? `Hewn's tools didn't answer within ${timeoutMs}ms` : `Hewn's tools stopped (${(e as Error).message})`, timeout);
      }
    };
    let res = await send(!!code && !sent.has(code.hash));
    if (res.status === 409 && code) {
      sent.delete(code.hash);
      res = await send(true);
    }
    if (res.headers.has(STARTED_HEADER)) o.started?.(res.headers.get(ISOLATE_HEADER) ?? "");
    // An invoke's result comes after its headers: the process going meanwhile is the process going.
    const text = await res.text().catch((e: Error) => {
      throw new ToolsUnreachable(`Hewn's tools stopped (${e.message})`);
    });
    const out = ((): { result?: unknown; error?: string } => {
      try {
        return JSON.parse(text);
      } catch {
        return { error: `HTTP ${res.status}` };
      }
    })();
    if (!res.ok || out.error !== undefined) throw new Error(out.error ?? `HTTP ${res.status}`);
    if (code) {
      // As many as the tools process keeps: past that, the text goes again rather than a 409 and a resend.
      if (sent.size >= CODES_KEPT) sent.delete(sent.values().next().value!);
      sent.add(code.hash);
    }
    return out.result;
  };
  return (capabilityId) => Object.fromEntries(HOST_METHODS.map((m) => [m, (body: Record<string, unknown>, o?: SendOptions) => post(capabilityId, m, body, o)])) as unknown as ToolsHost;
}
