// SPDX-License-Identifier: AGPL-3.0-or-later
// The code browser's view of a set of files against a base (the version it was built on): each
// file's status and lines +n −n, and one file's text with its git-style hunks. Pure: any files.
import { diffLines, diffStats, type Hunk, splitLines, toHunks } from "./diff.ts";
import { PlatformError } from "./errors.ts";
import type { Files } from "./ports.ts";

export interface CodeFile {
  path: string;
  size: number;
  binary: boolean;
  /** Against the base: "same" when there's no base. */
  status: "added" | "changed" | "removed" | "same";
  added: number;
  removed: number;
}

export interface CodeText {
  path: string;
  binary: boolean;
  /** The file as it is (empty for a removed one). */
  text: string;
  /** Against the base. None for "same", and none for a change only in line endings or the final newline. */
  hunks: Hunk[];
  status: CodeFile["status"];
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
/** Text, or null for a file that isn't (images, fonts). */
function asText(b: Uint8Array | undefined): string | null {
  if (!b) return "";
  if (b.includes(0)) return null;
  try {
    return strict.decode(b);
  } catch {
    return null;
  }
}

/** A file by its path: its own entries only (a path such as `toString` is no file). */
const fileAt = (files: Files | null, path: string) => (files && Object.hasOwn(files, path) ? files[path] : undefined);

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Byte for byte: a file whose only change is its line endings is "changed" (its lines may show none). */
const statusOf = (now: Uint8Array | undefined, before: Uint8Array | undefined, base: Files | null): CodeFile["status"] =>
  !base ? "same" : !before ? "added" : !now ? "removed" : same(now, before) ? "same" : "changed";

/** Every file (and every file the base had that's gone), sorted with the changed ones first. */
export function codeFiles(files: Files, base: Files | null): CodeFile[] {
  const paths = [...new Set([...Object.keys(files), ...Object.keys(base ?? {})])].sort();
  const out = paths.map((path): CodeFile => {
    const now = fileAt(files, path);
    const before = fileAt(base, path);
    const status = statusOf(now, before, base);
    const t = asText(now);
    const binary = t === null || asText(before) === null;
    const stats = status === "same" || binary ? { added: 0, removed: 0 } : diffStats(diffLines(splitLines(asText(before) ?? ""), splitLines(t ?? "")));
    return { path, size: (now ?? before)!.length, binary, status, ...stats };
  });
  return [...out.filter((f) => f.status !== "same"), ...out.filter((f) => f.status === "same")];
}

/** One file's text and its hunks against the base. */
export function codeText(path: string, files: Files, base: Files | null): CodeText {
  const now = fileAt(files, path);
  const before = fileAt(base, path);
  if (!now && !before) throw new PlatformError("not_found", `no file ${path}`);
  const t = asText(now);
  const b = asText(before);
  const status = statusOf(now, before, base);
  if (t === null || b === null) return { path, binary: true, text: "", hunks: [], status };
  return { path, binary: false, text: t, hunks: status === "same" ? [] : toHunks(diffLines(splitLines(b), splitLines(t))), status };
}
