// SPDX-License-Identifier: AGPL-3.0-or-later
// Where this Hewn is installed. Two ways: a git checkout run from TypeScript (install.sh, for
// contributors), or the npm package, bundled to JavaScript at publish time (scripts/build-npm.ts).
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Defined (true) by the publish build only. */
declare const __HEWN_BUNDLED__: boolean | undefined;
/** This is the npm package (dist/cli.js), not a checkout. */
export const BUNDLED = typeof __HEWN_BUNDLED__ !== "undefined" && __HEWN_BUNDLED__;

/**
 * A checkout: the repo root, with its data/, node_modules/ and package.json (this file is
 * packages/cli/src/app-dir.ts). The npm package: its root, with dist/ and package.json (this code is
 * dist/cli.js).
 */
export const APP_DIR = fileURLToPath(new URL(BUNDLED ? "../" : "../../../", import.meta.url));

/**
 * The default data folder (HEWN_HOME overrides): data/ in a checkout (gitignored), ~/.hewn for the
 * npm package, whose own folder an upgrade replaces.
 */
export const DEFAULT_HOME = BUNDLED ? join(homedir(), ".hewn") : join(APP_DIR, "data");

/**
 * The npm prefix this package was installed into (`<prefix>/lib/node_modules/@hewntools/cli` on
 * macOS and Linux): upgrades and uninstall use the same one, e.g. ~/.local when the global folder
 * needed sudo.
 */
export const NPM_PREFIX = BUNDLED ? join(APP_DIR, "..", "..", "..", "..") : undefined;

/** The workerd binary for this platform (the workerd package resolves it; not its Node launcher). */
export const workerdBinary = (): string => createRequire(import.meta.url)("workerd").default as string;
