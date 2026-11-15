// SPDX-License-Identifier: AGPL-3.0-or-later
// The channel between the platform and the tools: they run in separate workerd processes, and talk
// HTTP over Unix sockets in the data dir. The platform calls the tools process (one route per
// CapabilityHost method, with the tools' token); the tools process calls back for a running call's
// `call` and `model` (with that call's own token, good only while it runs). A tool's code sees
// neither token.
import type { GenerateRequest, GenerateResult } from "@hewntools/core/models.ts";
import type { Migration } from "@hewntools/core/migrations.ts";
import type { CodeRef } from "@hewntools/core/ports.ts";

/** The tools process's token, on every call the platform makes to it. */
export const TOOLS_TOKEN_HEADER = "x-hewn-tools";
/** A running call's token, on its callbacks to the platform. */
export const CALL_TOKEN_HEADER = "x-hewn-call";

/** Code by hash: the bundle's text only goes when the tools process hasn't got it (it answers 409). */
export type SentCode = { hash: string; js?: string };

/** What each route takes (the platform → the tools process). */
export interface HostCalls {
  invoke: { code: SentCode; scratch: string | null; key: string; input: unknown; secrets: Record<string, string>; hosts: string[]; caller: { kind: string; id: string } | undefined; config: Record<string, string>; readOnly: boolean; limit: number; call: string; model: boolean };
  stop: { scratch: string | null; reason: string };
  describe: { code: SentCode; limit: number };
  migrate: { scratch: string | null; migrations: Migration[]; code: SentCode; limit: number };
  dump: { scratch: string | null; code: SentCode; limit: number };
  count: { scratch: string | null; code: SentCode; limit: number };
  load: { scratch: string | null; tables: Record<string, Record<string, unknown>[]>; code: SentCode; limit: number };
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
  [M in HostMethod]: (body: Omit<HostCalls[M], "code"> & ("code" extends keyof HostCalls[M] ? { code: CodeRef } : unknown), o?: { timeoutMs?: number }) => Promise<any>;
};

/**
 * The platform's side: `tools` is the tools process's socket, `token` its token. Code goes by hash once the tools
 * process has it; a tools process started since gets the text again.
 */
export function toolsChannel(tools: ToolsSocket, token: string): (capabilityId: string) => ToolsHost {
  const sent = new Set<string>();
  const post = async (capabilityId: string, method: HostMethod, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> => {
    const code = body.code as CodeRef | undefined;
    const send = async (withJs: boolean) => {
      const payload = code ? { ...body, code: withJs ? { hash: code.hash, js: code.js } : { hash: code.hash } } : body;
      try {
        return await tools.fetch(`http://tools/${method}`, {
          method: "POST",
          headers: { [TOOLS_TOKEN_HEADER]: token, "content-type": "application/json", "x-hewn-capability": capabilityId },
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
    const out = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { result?: unknown; error?: string };
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    if (code) sent.add(code.hash);
    return out.result;
  };
  return (capabilityId) => Object.fromEntries(HOST_METHODS.map((m) => [m, (body: Record<string, unknown>, o?: { timeoutMs?: number }) => post(capabilityId, m, body, o?.timeoutMs)])) as unknown as ToolsHost;
}
