// SPDX-License-Identifier: AGPL-3.0-or-later
// Static files served by Hewn: the web client (`web/…`, from the host-workerd package), the UI kit
// (`platform-ui/…`, from the ui package) and the docs (`docs/…` and `spec/…`, for agents and the
// intake); in the npm package, their copies under dist/.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_NAME, docsReader } from "@hewntools/core/docs.ts";
import { assetDirs } from "./supervisor/bundle.ts";

/** A web client (`web/…`), UI kit (`platform-ui/…`) or docs page (`docs/<page>.md`, `spec/<page>.md`) file, or undefined. */
export async function sourceAsset(path: string): Promise<Uint8Array | undefined> {
  const [kind, ...rest] = path.split("/");
  const name = rest.join("/");
  if (!name || name.includes("..")) return undefined;
  const dirs = assetDirs();
  // Of the docs, only the pages themselves: not docs/internal/ or the spec's sources.
  if ((kind === "docs" || kind === "spec") && !DOC_NAME.test(name)) return undefined;
  const dir = kind === "web" ? dirs.web : kind === "platform-ui" ? dirs.ui : kind === "docs" ? dirs.docs : kind === "spec" ? dirs.spec : undefined;
  if (!dir) return undefined;
  const file = join(dir, name);
  return file.startsWith(dir + "/") && existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
}

/** Hewn's docs pages as this Hewn has them. */
export const hewnDocs = docsReader(sourceAsset);
