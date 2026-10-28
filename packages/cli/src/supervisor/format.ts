// SPDX-License-Identifier: AGPL-3.0-or-later
// The Hewn home's data format. Each release knows which format it writes; starting on data written
// by a newer format is refused (a downgrade could silently lose data), and starting on an older
// format upgrades it after a backup. Schema changes inside the owner's database are applied by
// the core at start (idempotent), gated by this number.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Home, writeFileAtomic } from "../home.ts";
import { APP_DIR } from "../app-dir.ts";

/** The data format this code reads and writes. Bump when stored data changes incompatibly. */
export const DATA_FORMAT = 1;

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();

const file = (home: Home) => join(home.root, "format.json");

export interface FormatCheck {
  current: number;
  /** The format found, when it's older than this code's (an upgrade happens at start). */
  upgradeFrom?: number;
  /** Why this code must not start on this home (it was written by a newer Hewn). */
  refuse?: string;
  /** Whether the home has workerd-host data yet. */
  hasData: boolean;
}

export function checkFormat(home: Home, current = DATA_FORMAT): FormatCheck {
  const hasData = existsSync(join(home.root, "workerd", "do"));
  if (!existsSync(file(home))) return { current, hasData };
  const found = JSON.parse(readFileSync(file(home), "utf8")) as { format: number; writtenBy?: string };
  if (found.format > current) {
    return {
      current,
      hasData,
      refuse: `This Hewn home (${home.root}) was written by a newer Hewn (data format ${found.format}${found.writtenBy ? `, ${found.writtenBy}` : ""}); this one (${VERSION}) understands format ${current}. Install the newer version again, or restore a backup made before the upgrade.`,
    };
  }
  return found.format < current ? { current, hasData, upgradeFrom: found.format } : { current, hasData };
}

/**
 * The workerd Durable Object storage keys. workerd names the storage directories after them and
 * derives object ids from them, so they never change.
 */
export const STORAGE_KEYS = { owner: "hewn-owner", capability: "hewn-capability" } as const;

export function writeFormat(home: Home, current = DATA_FORMAT) {
  const out = { format: current, writtenBy: VERSION, at: new Date().toISOString() };
  writeFileAtomic(file(home), JSON.stringify(out, null, 2) + "\n");
}
