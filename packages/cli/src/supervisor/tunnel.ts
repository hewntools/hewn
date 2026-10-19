// SPDX-License-Identifier: AGPL-3.0-or-later
// `hewn tunnel`: cloud agents (claude.ai, ChatGPT) reach Hewn through a tunnel to the public
// listener, which only answers MCP and OAuth (see surface/public.ts). The supervisor runs the
// tunnel as a child process next to workerd and restarts it if it dies.
//   quick:       cloudflared quick tunnel (random https://….trycloudflare.com, new on every start; no account)
//   cloudflared: a named cloudflared tunnel routed to the owner's hostname (stable)
//   tailscale:   Tailscale Funnel (https://<machine>.<tailnet>.ts.net)
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Home } from "../home.ts";
import type { TunnelStatus } from "@hewntools/host-workerd/surface/host.ts";

export type TunnelConfig = { kind: "quick" } | { kind: "cloudflared"; name: string; hostname: string } | { kind: "tailscale" };

const file = (home: Home) => join(home.root, "tunnel.json");

export function readTunnelConfig(home: Home): TunnelConfig | undefined {
  return existsSync(file(home)) ? (JSON.parse(readFileSync(file(home), "utf8")) as TunnelConfig) : undefined;
}

export function validTunnelConfig(c: any): TunnelConfig {
  if (c?.kind === "quick" || c?.kind === "tailscale") return { kind: c.kind };
  if (c?.kind === "cloudflared" && typeof c.name === "string" && /^[\w.-]+$/.test(c.name) && typeof c.hostname === "string" && /^[a-z0-9.-]+$/i.test(c.hostname)) {
    return { kind: "cloudflared", name: c.name, hostname: c.hostname.toLowerCase() };
  }
  throw new Error("tunnel must be {kind: quick | tailscale} or {kind: cloudflared, name, hostname}");
}

/** The command for a tunnel to the public listener on `port`. */
export function tunnelCommand(c: TunnelConfig, port: number): string[] {
  const origin = `http://127.0.0.1:${port}`;
  if (c.kind === "quick") return ["cloudflared", "tunnel", "--no-autoupdate", "--url", origin];
  if (c.kind === "cloudflared") return ["cloudflared", "tunnel", "--no-autoupdate", "run", "--url", origin, c.name];
  return ["tailscale", "funnel", String(port)];
}

const INSTALL: Record<string, string> = {
  cloudflared: "install cloudflared (macOS: brew install cloudflared; Linux: see developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads)",
  tailscale: "install Tailscale and run tailscale up (Funnel must be enabled for the tailnet)",
};

/**
 * Reads the tunnel's output for its public URL and for "connected". Returns the patch to apply
 * to the status, if the line tells us something.
 */
export function parseTunnelLine(c: TunnelConfig, line: string): Partial<TunnelStatus> | undefined {
  if (c.kind === "quick") {
    const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0];
    if (url) return { url };
  }
  if (c.kind !== "tailscale" && /Registered tunnel connection/i.test(line)) return { state: "up" };
  if (c.kind === "tailscale") {
    const url = /https:\/\/[a-z0-9.-]+\.ts\.net/i.exec(line)?.[0];
    if (url) return { url, state: "up" };
    if (/Funnel is not enabled|not available|requires/i.test(line)) return { error: line.trim() };
  }
  if (/failed to unmarshal quick Tunnel|error="?Unauthorized|tunnel credentials file|Cannot determine default origin certificate/i.test(line)) return { error: line.replace(/^\S+\s+\S+\s+/, "").trim() };
  return undefined;
}

export class Tunnel {
  private status: TunnelStatus = { kind: null, state: "off", url: null };
  private child: ChildProcess | undefined;
  private config: TunnelConfig | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private home: Home;
  private port: number;
  private log: (line: string) => void;
  private spawnFn: typeof spawn;

  constructor(home: Home, port: number, log: (line: string) => void, spawnFn: typeof spawn = spawn) {
    this.home = home;
    this.port = port;
    this.log = log;
    this.spawnFn = spawnFn;
  }

  current(): TunnelStatus {
    return { ...this.status };
  }

  /** Start the configured tunnel, if any (at supervisor start). */
  resume() {
    const c = readTunnelConfig(this.home);
    if (c) this.run(c);
  }

  /** Configure and start (persisted: it comes back with Hewn). */
  start(c: TunnelConfig): TunnelStatus {
    writeFileSync(file(this.home), JSON.stringify(c, null, 2) + "\n");
    this.halt();
    this.failures = 0;
    this.run(c);
    return this.current();
  }

  /** Stop and forget the configuration. */
  stop(): TunnelStatus {
    rmSync(file(this.home), { force: true });
    this.halt();
    this.status = { kind: null, state: "off", url: null };
    return this.current();
  }

  /** Stop the process, keep the configuration (Hewn shutting down). */
  halt() {
    this.config = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGTERM");
  }

  private run(c: TunnelConfig) {
    this.config = c;
    const argv = tunnelCommand(c, this.port);
    this.status = { kind: c.kind, state: "starting", url: c.kind === "cloudflared" ? `https://${c.hostname}` : null };
    this.log(`tunnel: starting ${c.kind} (${argv.join(" ")})`);
    const child = this.spawnFn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const onLine = (line: string) => {
      const patch = parseTunnelLine(c, line);
      if (!patch || this.child !== child) return;
      const wasUp = this.status.state === "up";
      this.status = { ...this.status, ...patch };
      if (this.status.state === "up" && !wasUp) {
        this.failures = 0;
        this.log(`tunnel: up at ${this.status.url}/mcp (only MCP and OAuth are reachable)`);
      }
    };
    let buf = "";
    const take = (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      lines.forEach(onLine);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.status = { ...this.status, state: "failed", error: e.code === "ENOENT" ? `${argv[0]} isn't installed: ${INSTALL[argv[0]]}` : e.message };
      this.log(`tunnel: ${this.status.error}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failures++;
      // Comes back on its own (network change, sleep), backing off when it keeps failing.
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.failures - 1, 5));
      this.status = { ...this.status, state: "failed", error: this.status.error ?? `${argv[0]} exited (${signal ?? code})` };
      this.log(`tunnel: ${argv[0]} exited (${signal ?? code}); retrying in ${Math.round(delay / 1000)}s`);
      this.retry = setTimeout(() => this.config === c && this.run(c), delay);
    });
  }
}
