// SPDX-License-Identifier: AGPL-3.0-or-later
// The Official shelf: Hewn's own tools, shipped in the release under seeds/ (no network). Each is a
// tool's source directory plus a .hub/ folder (its listing and card images) that never becomes
// part of a version; seeds/shelf.json says which are on the shelf, in order, and which three the
// hosted first run shows.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HubListing, ShelfTool } from "@hewntools/core/bundle.ts";
import { versionFiles } from "@hewntools/core/files.ts";
import { assetDirs } from "./supervisor/bundle.ts";
import { readTree } from "./workbench.ts";

export interface Shelf {
  tools: ShelfTool[];
  firstRun: string[];
}

/** The shelf in `dir` (default: the release's seeds/): tools listed in shelf.json that have a listing. */
export function readShelf(dir = assetDirs().seeds): Shelf {
  const index = join(dir, "shelf.json");
  if (!existsSync(index)) return { tools: [], firstRun: [] };
  const { tools, firstRun } = JSON.parse(readFileSync(index, "utf8")) as { tools: string[]; firstRun?: string[] };
  const out: ShelfTool[] = [];
  for (const id of tools) {
    const hub = join(dir, id, ".hub");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !existsSync(join(hub, "listing.json"))) continue;
    const listing = JSON.parse(readFileSync(join(hub, "listing.json"), "utf8")) as HubListing;
    out.push({ id, listing, files: versionFiles(readTree(join(dir, id))), images: readdirSync(hub).filter((f) => /^[a-z]+\.png$/.test(f)).map((f) => f.slice(0, -4)) });
  }
  return { tools: out, firstRun: (firstRun ?? []).filter((id) => out.some((t) => t.id === id)) };
}

/** A card image (`screen`, `widget`) of a tool on the shelf. */
export function shelfImage(id: string, name: string, dir = assetDirs().seeds): Uint8Array | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !/^[a-z]+$/.test(name)) return undefined;
  const file = join(dir, id, ".hub", `${name}.png`);
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
}
