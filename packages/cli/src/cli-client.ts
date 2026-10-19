// SPDX-License-Identifier: AGPL-3.0-or-later
// The CLI's view of the platform: the running host's admin channel (`hewn serve`).
import { existsSync, readFileSync } from "node:fs";
import type { Home } from "./home.ts";
import { supervisorFile } from "./supervisor/index.ts";

export interface PlatformClient {
  url: string;
  call<T = any>(method: string, ...args: unknown[]): Promise<T>;
  /** Supervisor control (backups, status). */
  control<T = any>(path: string, body?: unknown): Promise<T>;
  close(): void;
}

export interface SupervisorInfo {
  url: string;
  adminToken: string;
  control: { url: string; token: string };
  /** Where the reverse proxy or tunnel points (the public listener). */
  publicListener?: string;
  pid: number;
}

export function supervisorInfo(home: Home): SupervisorInfo | undefined {
  const file = supervisorFile(home);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SupervisorInfo) : undefined;
}

async function post(url: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(out.message ?? out.error ?? `HTTP ${res.status}`);
  return out;
}

export async function connect(home: Home): Promise<PlatformClient> {
  const info = supervisorInfo(home);
  if (info && (await fetch(`${info.url}/health`).then((r) => r.ok, () => false))) {
    return {
      url: info.url,
      call: async (method, ...args) => (await post(`${info.url}/_admin/call`, { "x-hewn-admin": info.adminToken }, { method, args })).result,
      control: (path, body) => post(`${info.control.url}${path}`, { "x-hewn-control": info.control.token }, body ?? {}),
      close: () => {},
    };
  }
  if (info) throw new Error(`hewn serve isn't answering at ${info.url} (pid ${info.pid}). Start it again, or remove ${supervisorFile(home)} if it's gone.`);
  throw new Error("Hewn isn't running: start it with hewn service start (or hewn serve)");
}
