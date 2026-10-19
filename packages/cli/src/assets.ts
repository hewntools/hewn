// SPDX-License-Identifier: AGPL-3.0-or-later
// Static files served by Hewn: the web client (`web/…`, from the host-workerd package) and the UI kit
// (`platform-ui/…`, from the ui package); in the npm package, their copies under dist/.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assetDirs } from "./supervisor/bundle.ts";

/** A web client (`web/…`) or UI kit (`platform-ui/…`) file, or undefined. */
export async function sourceAsset(path: string): Promise<Uint8Array | undefined> {
  const [kind, ...rest] = path.split("/");
  const name = rest.join("/");
  if (!name || name.includes("..")) return undefined;
  const dirs = assetDirs();
  const dir = kind === "web" ? dirs.web : kind === "platform-ui" ? dirs.ui : undefined;
  if (!dir) return undefined;
  const file = join(dir, name);
  return file.startsWith(dir + "/") && existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
}
