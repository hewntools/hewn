// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PlatformError } from "@hewntools/core/errors.ts";
import { type JobModel, modelPrefProblems, ownerPrefProblems, settingsProblems } from "@hewntools/host-workerd/surface/host.ts";
import type { Home } from "./home.ts";

/** User-owned platform settings. Agents have no API to change them. */
export interface PlatformConfig {
  /** Who builds candidates: Claude Code, Codex or OpenCode on this machine, or "remote" (the host's, HEWN_BUILD_URL). */
  builder: string;
  maxBuildAttempts: number;
  /** Confine capability code (Seatbelt + egress proxy). Turn off only to debug. */
  sandbox: boolean;
  /** Turns rough intent from non-agent clients (the web) into structured create/modify requests. */
  intake: string;
  /** Where nightly backups go. Unset: backups/ next to the platform home (data/). */
  backupDir?: string;
  /** The owner finished (or skipped) the web client's first run. */
  firstRunDone?: boolean;
  /** Days to keep capability call logs; 0 = forever. */
  logRetentionDays: number;
  /**
   * An IPv4 address of this machine where the public listener also answers, for a reverse proxy
   * on another machine (`hewn url --listen`). Unset: loopback only. Read when Hewn starts.
   */
  publicListen?: string;
  /** The owner's time zone (IANA), the default for new schedules. Unset: the machine's. */
  timeZone?: string;
  /** Hewn's jobs the owner has picked an agent for ("builder", "intake"). */
  jobsChosen?: string[];
  /** Model and effort per job, remembered per agent (see Settings in surface/host.ts). */
  jobModels?: { builder?: Record<string, JobModel>; intake?: Record<string, JobModel> };
  /** Model names agents may ask builds to use, per builder agent. */
  agentModels?: Record<string, string[]>;
}

export const DEFAULT_CONFIG: PlatformConfig = { builder: "claude", maxBuildAttempts: 3, sandbox: true, intake: "claude", logRetentionDays: 14 };

/** The defaults here: a host that runs the builder and intake (HEWN_BUILD_URL) makes them the default. */
const defaults = (): PlatformConfig => ({ ...DEFAULT_CONFIG, ...(process.env.HEWN_BUILD_URL ? { builder: "remote", intake: "remote" } : {}) });

const KEYS = ["builder", "maxBuildAttempts", "sandbox", "intake", "backupDir", "firstRunDone", "logRetentionDays", "publicListen", "timeZone", "jobsChosen", "jobModels", "agentModels"] as const;

const path = (home: Home) => join(home.root, "platform.json");

/**
 * What platform.json holds. Up to 0.4.2 every write (and setup) stored the defaults too; with
 * HEWN_BUILD_URL set, a builder or intake the owner didn't choose (jobsChosen) is one of those.
 */
function stored(home: Home): Partial<Record<(typeof KEYS)[number], unknown>> {
  const p = path(home);
  const raw: Record<string, unknown> = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const out = Object.fromEntries(KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  const chosen = Array.isArray(raw.jobsChosen) ? raw.jobsChosen : [];
  // Hosted (HEWN_HOSTED): the host builds, whatever was chosen before.
  if (process.env.HEWN_BUILD_URL) for (const k of ["builder", "intake"] as const) if (out[k] !== "remote" && (!chosen.includes(k) || process.env.HEWN_HOSTED === "1")) delete out[k];
  return out;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Re-read on every call so edits apply without restarting Hewn. */
export function readConfig(home: Home): PlatformConfig {
  // Unknown keys (e.g. the retired "discovery") are ignored.
  const { builder, maxBuildAttempts, sandbox, intake, backupDir, firstRunDone, logRetentionDays, publicListen, timeZone, jobsChosen, jobModels, agentModels } = { ...defaults(), ...stored(home) } as Record<string, any>;
  return {
    builder,
    maxBuildAttempts,
    sandbox,
    intake,
    logRetentionDays,
    ...(typeof backupDir === "string" && backupDir ? { backupDir } : {}),
    ...(firstRunDone === true ? { firstRunDone } : {}),
    ...(typeof publicListen === "string" && IPV4.test(publicListen) ? { publicListen } : {}),
    ...(typeof timeZone === "string" && timeZone && !ownerPrefProblems({ timeZone }).length ? { timeZone } : {}),
    ...(Array.isArray(jobsChosen) && !ownerPrefProblems({ jobsChosen }).length ? { jobsChosen } : {}),
    ...(jobModels !== undefined && !modelPrefProblems({ jobModels }).length ? { jobModels } : {}),
    ...(agentModels !== undefined && !modelPrefProblems({ agentModels }).length ? { agentModels } : {}),
  };
}

/**
 * Validate a partial change and persist it (owner only: the web Settings page and the CLI). Only
 * the changed keys are stored: settings left alone keep following their defaults.
 */
export function writeConfig(home: Home, change: Partial<Omit<PlatformConfig, "backupDir" | "publicListen">> & { backupDir?: string | null; publicListen?: string | null }): PlatformConfig {
  const { backupDir, publicListen, ...rest } = change;
  const next: PlatformConfig = { ...readConfig(home), ...rest };
  const bad: string[] = [];
  if (publicListen !== undefined) {
    if (!publicListen) delete next.publicListen;
    else if (typeof publicListen !== "string" || !IPV4.test(publicListen)) bad.push("publicListen must be an IPv4 address of this machine (e.g. 192.168.1.50), or 0.0.0.0 for every interface");
    else if (publicListen.startsWith("127.")) delete next.publicListen;
    else next.publicListen = publicListen;
  }
  // backupDir: "" or null goes back to the default; otherwise an absolute folder we can write to.
  if (backupDir !== undefined) {
    if (!backupDir) delete next.backupDir;
    else if (typeof backupDir !== "string" || !isAbsolute(backupDir)) bad.push("backupDir must be an absolute path");
    else {
      try {
        mkdirSync(backupDir, { recursive: true });
        const probe = join(backupDir, ".hewn-write-test");
        writeFileSync(probe, "");
        rmSync(probe);
        next.backupDir = backupDir;
      } catch (e) {
        bad.push(`can't write to ${backupDir}: ${(e as Error).message}`);
      }
    }
  }
  bad.push(...settingsProblems(next as unknown as Record<string, unknown>, { remote: !!process.env.HEWN_BUILD_URL, changed: Object.keys(rest) }));
  if (bad.length) throw new PlatformError("invalid_request", bad.join("; "));
  const out: Record<string, unknown> = stored(home);
  for (const k of [...Object.keys(rest), ...(backupDir !== undefined ? ["backupDir"] : []), ...(publicListen !== undefined ? ["publicListen"] : [])] as (keyof PlatformConfig)[]) {
    if (next[k] === undefined) delete out[k];
    else out[k] = next[k];
  }
  writeFileSync(path(home), JSON.stringify(out, null, 2) + "\n");
  return next;
}

/** An empty platform.json: every setting starts at its default. */
export function initConfig(home: Home) {
  if (!existsSync(path(home))) writeFileSync(path(home), "{}\n");
}
