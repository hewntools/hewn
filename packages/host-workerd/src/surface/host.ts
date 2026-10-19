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
  /**
   * The model and effort for each job, remembered per agent, so switching back restores them:
   * `jobModels.builder.claude = { model: "fable", effort: "high" }`. Unset: the agent's default.
   */
  jobModels?: { builder?: Record<string, JobModel>; intake?: Record<string, JobModel> };
  /** Model names agents may ask a build to use, per builder agent. Unset: Default and the families. */
  agentModels?: Record<string, string[]>;
}

/** What one job runs on with one agent: a model name the agent's CLI takes, and an effort. */
export interface JobModel {
  model?: string;
  effort?: string;
}

/** Hewn's two jobs; the owner sees one ("Builds tools"), with the split under Advanced. */
export const JOBS = ["builder", "intake"] as const;
export type Job = (typeof JOBS)[number];

/** The agents that can do Hewn's jobs: the CLIs on this machine, and the host's builder when it offers one. */
export const jobAgents = (remote: boolean) => ["claude", "codex", ...(remote ? ["remote"] : [])];

/** Models agents may ask for until the owner changes it: the default and Claude Code's families (they follow the newest). */
export const DEFAULT_AGENT_MODELS: Record<string, string[]> = { claude: ["default", "fable", "opus", "sonnet", "haiku"], codex: ["default"], remote: ["default"] };

/** The owner's model and effort for `job` on `agent`. */
export const jobModel = (s: Pick<Settings, "jobModels">, job: Job, agent: string): JobModel => s.jobModels?.[job]?.[agent] ?? {};

/** Model names agents may pass for builds by `agent`. */
export const agentModels = (s: Pick<Settings, "agentModels">, agent: string): string[] => s.agentModels?.[agent] ?? DEFAULT_AGENT_MODELS[agent] ?? ["default"];

/** One option in an agent's model list (Settings › AI, the intake's model menu). */
export interface ModelChoice {
  /** What Hewn passes to the CLI: "default" (nothing), an alias ("fable"), or a full name. */
  id: string;
  label: string;
  /** default: the CLI decides; family: the newest of it; pinned: exactly this one. */
  kind: "default" | "family" | "pinned";
  description?: string;
  /** Effort levels it takes; empty when it has none. */
  efforts: string[];
  defaultEffort?: string;
  /** A pinned model's successor, when its CLI names one (Codex's catalog). */
  upgrade?: string;
}

/** An agent's model list, read from its CLI (or the host's builder). `other`: full names beyond the list are accepted. */
export interface ModelCatalog {
  agent: string;
  models: ModelChoice[];
  other?: boolean;
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
  tools?: () => Promise<{ name: string; label: string; found: boolean; loggedIn?: boolean; fix?: string; remote?: boolean }[]>;
  /** The models an agent offers (its CLI's list, or the host's builder's). Absent: only Default. */
  modelCatalog?: (agent: string) => Promise<ModelCatalog>;
  /** Backup and version status (Settings). */
  status?: () => Promise<{ machine?: string; version: string; dataFormat: number; lastBackup: string | null; backupDir: string; latest?: string | null; notes?: { version: string; date?: string; items: string[] }[] }>;
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

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;
const EFFORT = /^[a-z]{2,12}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Every setting's problems, for both settings stores (the workerd host's and platform.json).
 * `remote`: the host offers its own builder ("remote").
 */
export function settingsProblems(next: Record<string, unknown>, opts: { remote?: boolean; changed?: string[] } = {}): string[] {
  const agents = jobAgents(!!opts.remote);
  const bad: string[] = [];
  // Only what changes: a saved "remote" stays valid if the host stops offering it (it fails at build time instead).
  const checks = (k: string) => !opts.changed || opts.changed.includes(k);
  if (checks("builder") && !agents.includes(next.builder as string)) bad.push(`builder must be ${agents.join(", ")}`);
  if (checks("intake") && !agents.includes(next.intake as string)) bad.push(`intake must be ${agents.join(", ")}`);
  const n = next.maxBuildAttempts as number;
  if (!Number.isInteger(n) || n < 1 || n > 5) bad.push("maxBuildAttempts must be 1–5");
  if (typeof next.sandbox !== "boolean") bad.push("sandbox must be true or false");
  if (next.firstRunDone !== undefined && typeof next.firstRunDone !== "boolean") bad.push("firstRunDone must be true or false");
  const days = next.logRetentionDays as number;
  if (!Number.isInteger(days) || days < 0 || days > 3650) bad.push("logRetentionDays must be 0 (forever) to 3650");
  bad.push(...ownerPrefProblems(next), ...modelPrefProblems(next));
  return bad;
}

/** Problems with the owner's model choices (jobModels, agentModels). */
export function modelPrefProblems(s: { jobModels?: unknown; agentModels?: unknown }): string[] {
  const bad: string[] = [];
  if (s.jobModels !== undefined) {
    const ok =
      isObj(s.jobModels) &&
      Object.entries(s.jobModels).every(
        ([job, perAgent]) =>
          (JOBS as readonly string[]).includes(job) &&
          isObj(perAgent) &&
          Object.values(perAgent).every((m) => isObj(m) && Object.keys(m).every((k) => k === "model" || k === "effort") && (m.model === undefined || (typeof m.model === "string" && MODEL_NAME.test(m.model))) && (m.effort === undefined || (typeof m.effort === "string" && EFFORT.test(m.effort)))),
      );
    if (!ok) bad.push('jobModels must look like { "builder": { "claude": { "model": "fable", "effort": "high" } } }');
  }
  if (s.agentModels !== undefined) {
    const ok = isObj(s.agentModels) && Object.values(s.agentModels).every((list) => Array.isArray(list) && list.length <= 50 && list.every((m) => typeof m === "string" && MODEL_NAME.test(m)));
    if (!ok) bad.push('agentModels must look like { "claude": ["default", "fable"] }');
  }
  return bad;
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
