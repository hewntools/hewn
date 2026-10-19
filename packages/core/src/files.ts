// SPDX-License-Identifier: AGPL-3.0-or-later
// Implementation file maps: the unit the core validates, hashes and stores.
import type { Files } from "./ports.ts";
import { Sha256, utf8 } from "./sha256.ts";

const decoder = new TextDecoder();
export const text = (b: Uint8Array | undefined) => (b ? decoder.decode(b) : "");
export const bytes = (s: string) => utf8(s);

/** Files that are build/runtime artefacts, never part of a version's identity. */
export const ARTEFACTS = new Set([".venv", "__pycache__", "node_modules", ".DS_Store", ".pytest_cache"]);
/** Workspace-only files (the build brief) that never become part of a version. */
export const WORKSPACE_ONLY = new Set(["BUILDER.md", "PLATFORM_UI.css"]);

export const isArtefact = (path: string) => path.split("/").some((part) => ARTEFACTS.has(part));

/**
 * Files a builder agent reads as its own configuration or instructions: dotfiles and dot-dirs
 * (`.claude/settings.json` hooks run shell commands), CLAUDE.md, AGENTS.md. Kept in a version, they
 * would steer (or run code in) the next build of it, so they never become part of one.
 */
export const isBuilderConfig = (path: string) => path.split("/").some((part) => part.startsWith(".") || /^(CLAUDE|CLAUDE\.local|AGENTS)\.md$/i.test(part));

/** The files that make up a version: no artefacts, no workspace-only files, no builder configuration. */
export function versionFiles(files: Files): Files {
  const out: Files = {};
  for (const [p, b] of Object.entries(files)) if (!isArtefact(p) && !WORKSPACE_ONLY.has(p) && !isBuilderConfig(p)) out[p] = b;
  return out;
}

/** Content hash of a version: every file (sorted by path) plus the bundle that runs. */
export function contentHash(files: Files, bundle: string): string {
  const h = new Sha256();
  for (const p of Object.keys(files).sort()) h.update(p).update("\0").update(files[p]).update("\0");
  return h.update("bundle\0").update(bundle).hex();
}

export const toBase64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Stored version blob: everything needed to run, show and modify a version. */
export interface VersionBlob {
  hash: string;
  bundle: string;
  files: Record<string, string>; // base64
}

export function encodeVersion(hash: string, files: Files, bundle: string): string {
  return JSON.stringify({ hash, bundle, files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, toBase64(b)])) } satisfies VersionBlob);
}

export function decodeVersion(raw: Uint8Array | string): { hash: string; bundle: string; files: Files } {
  const v = JSON.parse(typeof raw === "string" ? raw : text(raw)) as VersionBlob;
  return { hash: v.hash, bundle: v.bundle, files: Object.fromEntries(Object.entries(v.files).map(([p, b]) => [p, fromBase64(b)])) };
}
