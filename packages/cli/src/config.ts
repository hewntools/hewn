// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PlatformError } from "@hewntools/core/errors.ts";
import { ownerPrefProblems } from "@hewntools/host-workerd/surface/host.ts";
import type { Home } from "./home.ts";

/** User-owned platform settings. Agents have no API to change them. */
export interface PlatformConfig {
  /** Who builds candidates: a platform-assigned builder, or the requesting agent itself. */
  builder: "codex" | "claude";
  maxBuildAttempts: number;
  /** Confine capability code (Seatbelt + egress proxy). Turn off only to debug. */
  sandbox: boolean;
  /** Turns rough intent from non-agent clients (the web) into structured create/modify requests. */
  intake: "claude" | "codex";
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
}

export const DEFAULT_CONFIG: PlatformConfig = { builder: "claude", maxBuildAttempts: 3, sandbox: true, intake: "claude", logRetentionDays: 14 };

const path = (home: Home) => join(home.root, "platform.json");

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Re-read on every call so edits apply without restarting Hewn. */
export function readConfig(home: Home): PlatformConfig {
  const p = path(home);
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  // Unknown keys (e.g. the retired "discovery") are ignored.
  const { builder, maxBuildAttempts, sandbox, intake, backupDir, firstRunDone, logRetentionDays, publicListen, timeZone, jobsChosen } = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf8")) };
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
  };
}

/** Validate and persist a partial change (owner only: the web Settings page and the CLI). */
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
  if (!["codex", "claude"].includes(next.builder)) bad.push("builder must be codex or claude");
  if (next.firstRunDone !== undefined && typeof next.firstRunDone !== "boolean") bad.push("firstRunDone must be true or false");
  if (!Number.isInteger(next.logRetentionDays) || next.logRetentionDays < 0 || next.logRetentionDays > 3650) bad.push("logRetentionDays must be 0 (forever) to 3650");
  if (!["claude", "codex"].includes(next.intake)) bad.push("intake must be claude or codex");
  if (!Number.isInteger(next.maxBuildAttempts) || next.maxBuildAttempts < 1 || next.maxBuildAttempts > 5) bad.push("maxBuildAttempts must be 1–5");
  if (typeof next.sandbox !== "boolean") bad.push("sandbox must be true or false");
  bad.push(...ownerPrefProblems(next));
  if (bad.length) throw new PlatformError("invalid_request", bad.join("; "));
  writeFileSync(path(home), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function initConfig(home: Home) {
  if (!existsSync(path(home))) writeFileSync(path(home), JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
}
