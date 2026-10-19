// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Blobs } from "@hewntools/core/ports.ts";

/** The core's Blobs port over a directory. Keys are relative paths ("versions/<hash>.json"). */
export function dirBlobs(root: string): Blobs {
  const path = (key: string) => {
    const p = resolve(root, key);
    if (!p.startsWith(resolve(root) + "/")) throw new Error(`bad blob key ${key}`);
    return p;
  };
  return {
    async get(key) {
      try {
        return new Uint8Array(readFileSync(path(key)));
      } catch {
        return undefined;
      }
    },
    async put(key, data) {
      const p = path(key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    },
    async delete(key) {
      rmSync(path(key), { force: true });
    },
  };
}

export const blobsDir = (home: { root: string }) => join(home.root, "blobs");
