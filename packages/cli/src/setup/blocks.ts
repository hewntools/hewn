// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Idempotent managed blocks in user-owned files (shell profiles, agent instruction files).
 * Re-running setup replaces the block; nothing outside the markers is touched.
 */
export interface BlockStyle {
  begin: string;
  end: string;
}

export const MARKDOWN: BlockStyle = {
  begin: "<!-- hewn:begin (managed by `hewn setup`) -->",
  end: "<!-- hewn:end -->",
};
export const SHELL: BlockStyle = {
  begin: "# hewn:begin (managed by `hewn setup`)",
  end: "# hewn:end",
};

export function upsertBlock(text: string, body: string, style: BlockStyle): string {
  const block = `${style.begin}\n${body.trim()}\n${style.end}`;
  const start = text.indexOf(style.begin);
  const stop = text.indexOf(style.end, start);
  if (start !== -1 && stop > start) return text.slice(0, start) + block + text.slice(stop + style.end.length);
  const sep = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}${block}\n`;
}

export function hasBlock(path: string, style: BlockStyle): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(style.begin);
}

export function writeBlock(path: string, body: string, style: BlockStyle): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, upsertBlock(text, body, style));
}

/** Remove the managed block (and the blank line before it), if present. Returns whether it was there. */
export function removeBlock(path: string, style: BlockStyle): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(style.begin);
  const stop = text.indexOf(style.end, start);
  if (start === -1 || stop < start) return false;
  const before = text.slice(0, start).replace(/\n\n$/, "\n");
  const after = text.slice(stop + style.end.length).replace(/^\n/, "");
  writeFileSync(path, before + after);
  return true;
}
