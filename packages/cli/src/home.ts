// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_HOME } from "./app-dir.ts";

/** Filesystem layout of a platform installation. Platform-owned; agents never touch it. */
export interface Home {
  root: string;
  db: string;
  capabilities: string;
  builds: string;
}

export function openHome(root = process.env.HEWN_HOME ?? DEFAULT_HOME): Home {
  const home: Home = {
    root,
    db: join(root, "platform.db"),
    capabilities: join(root, "capabilities"),
    builds: join(root, "builds"),
  };
  mkdirSync(home.capabilities, { recursive: true });
  mkdirSync(home.builds, { recursive: true });
  return home;
}

export const capabilityDir = (home: Home, id: string) => join(home.capabilities, id);
export const versionDir = (home: Home, id: string, version: number) =>
  join(home.capabilities, id, "versions", String(version));
export const statePath = (home: Home, id: string) => join(home.capabilities, id, "state.db");
export const logsDir = (home: Home, id: string) => join(home.capabilities, id, "logs");
export const backupsDir = (home: Home, id: string) => join(home.capabilities, id, "backups");
export const buildDir = (home: Home, buildId: string) => join(home.builds, buildId);

/** Write a file whole or not at all: a reader, or a start after a crash mid-write, sees the old one or the new one, never half. */
export function writeFileAtomic(path: string, data: string, mode?: number) {
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, data, { mode });
  renameSync(partial, path);
}
