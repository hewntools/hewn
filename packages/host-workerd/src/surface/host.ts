// SPDX-License-Identifier: AGPL-3.0-or-later
// What the HTTP surface (web client, capability UIs, MCP) needs from its host, beyond the core.
// Node implements these in-process; the workerd host forwards the machine-bound ones
// (intake, connecting local agents, backups) to the supervisor.
import type { IntakeReply, IntakeRequest } from "./intake-types.ts";

export interface Settings {
  builder: string;
  maxBuildAttempts: number;
  sandbox: boolean;
  intake: string;
  backupDir?: string;
  /** The owner finished (or skipped) the first run. */
  firstRunDone?: boolean;
  /** Days to keep capability call logs; 0 = forever. */
  logRetentionDays: number;
  /** The owner's time zone (IANA), the default for new schedules. Unset: the machine's. */
  timeZone?: string;
  /** Hewn's jobs the owner has picked an agent for ("builder", "intake"); first run asks until both are. */
  jobsChosen?: string[];
}

export interface HarnessStatus {
  agentId: string;
  label: string;
  found: boolean;
  connected: boolean;
  /** A desktop app that shares another harness's MCP settings (Codex Desktop → codex): connecting that connects both. */
  via?: string;
  /** A desktop app whose connectors are cloud-side (Claude Desktop): it connects through the tunnel, like claude.ai. */
  cloud?: boolean;
}

export interface TunnelStatus {
  /** cloudflared quick/named tunnel, or Tailscale Funnel; null when not configured. */
  kind: "quick" | "cloudflared" | "tailscale" | null;
  state: "off" | "starting" | "up" | "failed";
  /** e.g. https://hewn.example.com (MCP is at <url>/mcp). */
  url: string | null;
  error?: string;
}

export interface SurfaceHost {
  /** Port the browser uses (the web client is http://hewn.localhost:<port>). */
  port: number;
  log(line: string): void;
  /** Static files: web client (`web/<path>`) and the design system (`platform-ui/<name>`). */
  asset(path: string): Promise<Uint8Array | undefined>;
  settings: {
    read(): Promise<Settings>;
    write(change: Record<string, unknown>): Promise<Settings>;
  };
  /** Turns rough owner intent into a create/modify draft. Absent: intake unavailable. */
  intake?: (req: IntakeRequest, onProgress?: (p: unknown) => void, signal?: AbortSignal) => Promise<IntakeReply>;
  /** The owner's intake conversations, kept for their own reference. */
  intakeLog?(entry: unknown): Promise<void>;
  /** Connecting local agent harnesses (Claude Code, Codex …). Absent: CLI only. */
  setup?: {
    list(): Promise<HarnessStatus[]>;
    /** Register Hewn with the harness and start its OAuth login; `event` streams plan/step/login/done. */
    connect(agentId: string, mcpUrl: string, event: (name: string, data: unknown) => void): Promise<void>;
  };
  /** Builder / intake CLIs on this machine: installed, signed in (first run, Settings). */
  tools?: () => Promise<{ name: string; label: string; found: boolean; loggedIn?: boolean; fix?: string }[]>;
  /** Backup and version status (Settings). */
  status?: () => Promise<{ machine?: string; version: string; dataFormat: number; lastBackup: string | null; backupDir: string; latest?: string | null }>;
  /** The public address agents in the cloud use (hewn tunnel). Absent: no tunnel support here. */
  tunnel?: () => Promise<TunnelStatus>;
  backups?: {
    location(): Promise<string>;
    list(): Promise<unknown[]>;
    now(): Promise<{ file: string; bytes: number }>;
    /** Whether the backup folder is on the same disk as the data (null: can't tell). */
    sameDisk?(): Promise<boolean | null>;
  };
}

/** Problems with the owner's time zone and chosen jobs, for both settings stores. */
export function ownerPrefProblems(s: { timeZone?: unknown; jobsChosen?: unknown }): string[] {
  const bad: string[] = [];
  if (s.timeZone !== undefined) {
    try {
      if (typeof s.timeZone !== "string" || !s.timeZone) throw new Error();
      new Intl.DateTimeFormat("en-US", { timeZone: s.timeZone });
    } catch {
      bad.push("timeZone must be an IANA time zone, like Europe/Stockholm");
    }
  }
  if (s.jobsChosen !== undefined && (!Array.isArray(s.jobsChosen) || !s.jobsChosen.every((j) => j === "builder" || j === "intake"))) bad.push('jobsChosen must list "builder" and/or "intake"');
  return bad;
}
