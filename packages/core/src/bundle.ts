// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool as a file (`<id>.hewn.zip`): the version's files as they are, plus one sidecar,
// hewn-bundle.json. Our own store-only zip (no compression, CRC32): bundles are small, and the
// core runs where node:zlib doesn't. Also the scan run before a tool is shared: personal data,
// key-shaped strings and the owner's own settings warn, the owner's own stored keys block.
import { SAMPLE_SCHEMA } from "@hewntools/spec/schemas.ts";
import type { SampleCall } from "@hewntools/spec/cases.ts";
import { compileSchema, schemaErrors } from "./manifest.ts";
import type { Files } from "./ports.ts";

export type { SampleCall };

export const BUNDLE_FORMAT = 1;
/** A bundle (zipped) may be at most this big. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
export const SIDECAR = "hewn-bundle.json";
export const SAMPLE_FILE = "sample/calls.json";

/** What the intake model wrote about a tool's code, shipped with a bundle Hewn publishes. */
export interface BundleSummary {
  message: string;
  keeps?: string;
  reaches?: string;
  findings?: { kind: "warn" | "ok"; title: string; detail?: string; file?: string; line?: number }[];
}

/** hewn-bundle.json: what the bundle is, never whose Hewn it came from. */
export interface Sidecar {
  format: number;
  /** The Hewn that made it. */
  hewn: string;
  /** The manifest's ABI. */
  abi: string;
  exportedAt: string;
  /** The tool and version it was exported from: becomes the installed tool's `source`. */
  tool: { id: string; version: number; hash: string };
  summary?: BundleSummary;
}

const checkSample = compileSchema(SAMPLE_SCHEMA);

/** sample/calls.json, checked: null when there's none; throws with the reason when it's malformed. */
export function readSample(files: Files): SampleCall[] | null {
  const raw = files[SAMPLE_FILE];
  if (!raw) return null;
  let calls: unknown;
  try {
    calls = JSON.parse(new TextDecoder().decode(raw));
  } catch (e) {
    throw new Error(`${SAMPLE_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  if (!checkSample(calls)) throw new Error(`${SAMPLE_FILE} ${schemaErrors(checkSample).join("; ")}`);
  return calls as SampleCall[];
}

/** sample/calls.json's calls, or null when there's none or it doesn't read (where the reason isn't needed). */
export function sampleOrNull(files: Files): SampleCall[] | null {
  try {
    return readSample(files);
  } catch {
    return null;
  }
}

// ---------- what npm may install for a tool ----------

/**
 * A version, range or tag npm resolves on the registry ("^1.2.0", "1.x", "latest"), or an alias
 * to one ("npm:other@^1"). Never a path or a link (npm would take the machine's own files), git
 * (cloned with the owner's keys), a URL, or GitHub shorthand.
 */
export function registrySpec(spec: unknown): boolean {
  if (typeof spec !== "string") return false;
  const alias = /^npm:(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@(.*))?$/i.exec(spec);
  const range = alias ? (alias[1] ?? "") : spec;
  return /^[\w.^~<>=*|+ -]*$/.test(range) && !range.startsWith(".") && !/\.(tgz|tar|tar\.gz)$/i.test(range);
}

const ONLY_REGISTRY = 'only versions from the npm registry are allowed (like "^1.2.0")';

/**
 * Why npm, which runs on the machine itself and not in the builder's sandbox, mustn't install a
 * tool's dependencies as they are: npm settings in the tool (`.npmrc`: npm reads the one at the
 * project's root, and its `git`, `cache` or `registry` would be the tool's to choose), a spec that
 * isn't the registry's (package.json's dependencies of any kind, and overrides), workspaces, or a
 * lockfile entry that is a link or isn't fetched over https. Every build is refused with these,
 * and so is a tool's file before it's staged; each says what to change.
 */
export function dependencyProblems(files: Files): string[] {
  const out: string[] = [];
  const json = (path: string): any => {
    try {
      return JSON.parse(dec.decode(files[path]));
    } catch {
      out.push(`${path} isn't valid JSON`);
      return null;
    }
  };
  for (const path of Object.keys(files)) if (path === ".npmrc" || path.endsWith("/.npmrc")) out.push(`${path}: tools can't carry npm settings (.npmrc); remove it`);
  const pkg = files["package.json"] ? json("package.json") : null;
  if (pkg) {
    if (pkg.workspaces !== undefined) out.push('package.json: tools can\'t use npm workspaces; remove "workspaces"');
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) if (!registrySpec(spec)) out.push(`package.json ${field}: ${name} is ${JSON.stringify(spec)}; ${ONLY_REGISTRY}`);
    }
    // Overrides nest ({ "a": { "b": "1.0.0" } }); "$a" points at a dependency's own spec.
    const overrides = (o: unknown, at: string) => {
      for (const [name, spec] of Object.entries(o ?? {})) {
        if (spec && typeof spec === "object") overrides(spec, `${at}${name} › `);
        else if (!(typeof spec === "string" && spec.startsWith("$")) && !registrySpec(spec)) out.push(`package.json overrides: ${at}${name} is ${JSON.stringify(spec)}; ${ONLY_REGISTRY}`);
      }
    };
    overrides(pkg.overrides, "");
  }
  for (const path of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const lock = files[path] ? json(path) : null;
    if (!lock) continue;
    // lockfileVersion 2 and 3 list `packages` by path; 1 nests `dependencies`.
    const entry = (name: string, e: any) => {
      if (!e || typeof e !== "object") return;
      if (e.link) out.push(`${path}: ${name} is a link; ${ONLY_REGISTRY} (or remove ${path})`);
      else if (e.resolved !== undefined && !/^https:\/\//.test(String(e.resolved))) out.push(`${path}: ${name} comes from ${JSON.stringify(e.resolved)}; ${ONLY_REGISTRY} (or remove ${path})`);
      else if (e.version !== undefined && !registrySpec(e.version)) out.push(`${path}: ${name} is ${JSON.stringify(e.version)}; ${ONLY_REGISTRY} (or remove ${path})`);
      for (const [n, d] of Object.entries(e.dependencies ?? {})) if (d && typeof d === "object") entry(n, d);
    };
    for (const [p, e] of Object.entries(lock.packages ?? {})) if (p) entry(p, e);
    for (const [n, e] of Object.entries(lock.dependencies ?? {})) entry(n, e);
  }
  return out;
}

// ---------- the zip (store only) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A zip of `files` (path → bytes), stored, sorted by path. */
export function writeZip(files: Files, now = new Date()): Uint8Array {
  const time = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | Math.floor(now.getUTCSeconds() / 2);
  const date = ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const paths = Object.keys(files).sort();
  for (const path of paths) {
    const name = enc.encode(path);
    const data = files[path];
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true); // UTF-8 names
    l.setUint16(8, 0, true); // stored
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const head = new Uint8Array(46 + name.length);
    const c = new DataView(head.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, (0o100644 << 16) >>> 0, true);
    c.setUint32(42, offset, true);
    head.set(name, 46);
    chunks.push(local, data);
    central.push(head);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, x) => n + x.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, paths.length, true);
  e.setUint16(10, paths.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);
  return concat([...chunks, ...central, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

/** Why a file isn't a bundle Hewn can read: thrown with a message for the owner. `newer`: a newer Hewn reads it. */
export class BundleError extends Error {
  newer: boolean;
  constructor(message: string, newer = false) {
    super(message);
    this.newer = newer;
  }
}

/** A bundle holds at most this many files. */
export const MAX_BUNDLE_FILES = 1000;

/**
 * The files in a zip. Stored entries only: a compressed one (a zip made by another tool) is
 * refused with the reason. Entries must follow one another without overlapping, so the files
 * together are never bigger than the zip (no entry read twice), and no two may name the same file
 * on a disk that ignores case or Unicode normalisation.
 */
export function readZip(zip: Uint8Array): Files {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new BundleError("This isn't a zip file.");
  const count = view.getUint16(end + 10, true);
  if (count > MAX_BUNDLE_FILES) throw new BundleError(`The zip holds ${count} files; a tool's file may hold at most ${MAX_BUNDLE_FILES.toLocaleString("en")}.`);
  let p = view.getUint32(end + 16, true);
  const out: Files = {};
  const seen = new Map<string, string>();
  let next = 0;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== 0x02014b50) throw new BundleError("The zip is damaged (its file list doesn't read).");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const unpacked = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const at = view.getUint32(p + 42, true);
    const path = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    // Each entry starts where the one before it ended, or later: none is read twice.
    if (at < next || at + 30 > zip.length || view.getUint32(at, true) !== 0x04034b50) throw new BundleError("The zip is damaged (its entries overlap or are out of order).");
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    next = start + size;
    if (path.endsWith("/")) continue;
    if (method !== 0) throw new BundleError(`${path} is compressed. Hewn reads bundles that Hewn made: share the tool again from Hewn and use that file.`);
    if (path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "") || path.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(path)) throw new BundleError(`${JSON.stringify(path)} isn't a path Hewn accepts.`);
    // On a disk that ignores case (or Unicode normalisation), SRC/index.ts would overwrite src/index.ts.
    const key = path.normalize("NFC").toLowerCase();
    const twin = seen.get(key);
    if (twin !== undefined) throw new BundleError(twin === path ? `${path} is in the zip twice.` : `${twin} and ${path} are in the zip: on many disks they're the same file.`);
    seen.set(key, path);
    total += unpacked;
    if (total > MAX_BUNDLE_BYTES) throw new BundleError("Its files come to more than 5 MB; a tool's file may be at most 5 MB.");
    if (unpacked !== size || next > zip.length) throw new BundleError(`${path} is damaged (its size doesn't match).`);
    const data = zip.subarray(start, next);
    if (crc32(data) !== crc) throw new BundleError(`${path} is damaged (its checksum doesn't match).`);
    out[path] = data;
  }
  return out;
}

/** A bundle's bytes: the files and the sidecar. */
export const packBundle = (files: Files, sidecar: Sidecar): Uint8Array => writeZip({ ...files, [SIDECAR]: enc.encode(JSON.stringify(sidecar, null, 2) + "\n") });

/** A bundle's files and sidecar. Refuses what isn't one, a newer format, or one over the size limit. */
export function unpackBundle(zip: Uint8Array): { files: Files; sidecar: Sidecar } {
  if (zip.length > MAX_BUNDLE_BYTES) throw new BundleError(`The file is ${Math.round(zip.length / 104857.6) / 10} MB; a tool's file may be at most 5 MB.`);
  const files = readZip(zip);
  const raw = files[SIDECAR];
  if (!raw) throw new BundleError(`This zip isn't a Hewn tool (it has no ${SIDECAR}).`);
  let sidecar: Sidecar;
  try {
    sidecar = JSON.parse(dec.decode(raw));
  } catch {
    throw new BundleError(`${SIDECAR} isn't valid JSON.`);
  }
  if (typeof sidecar?.format !== "number") throw new BundleError(`${SIDECAR} has no format.`);
  if (sidecar.format > BUNDLE_FORMAT) throw new BundleError(`This tool was shared from a newer Hewn (bundle format ${sidecar.format}; this Hewn reads ${BUNDLE_FORMAT}).`, true);
  if (!files["capability.json"]) throw new BundleError("This zip has no capability.json.");
  delete files[SIDECAR];
  return { files, sidecar };
}

// ---------- the scan before sharing ----------

export interface Finding {
  file: string;
  line: number;
  /**
   * "pii": personal data; "key": a key shape or a long random string; "setting": one of the
   * owner's own settings (all three warn); "secret": one of the owner's own stored keys (blocks).
   */
  kind: "pii" | "key" | "setting" | "secret";
  label: string;
  /** The match with most of it hidden. */
  masked: string;
  /** The match itself, for Show. */
  text: string;
}

/** One of the owner's own stored values: a key ("secret", blocks a share) or a setting (warns). A plain string is a key. */
export type OwnValue = string | { value: string; label: string; kind?: "secret" | "setting" };

/** A phone number: 9–15 digits, written with a leading + or with spaces, dashes or brackets; never a date. */
const phoneLike = (m: string) => {
  const digits = m.replace(/\D/g, "").length;
  return digits >= 9 && digits <= 15 && !/^\d{4}-\d\d-\d\d/.test(m) && (m.startsWith("+") || /[ ()-]/.test(m));
};
// Bounded, and anchored where a run starts, so no line makes them backtrack for long.
const PII: [string, RegExp, ((m: string) => boolean)?][] = [
  ["Looks like an email", /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g],
  ["Looks like a phone number", /(?<![\w.:])\+?\d[\d ()-]{7,24}\d(?![\w.:])/g, phoneLike],
  ["Looks like a place (coordinates)", /\b-?\d{1,2}\.\d{3,},\s*-?\d{1,3}\.\d{3,}\b/g],
];
const KEYS: [string, RegExp][] = [
  ["Looks like an API key", /\bsk-[A-Za-z0-9_-]{16,}/g],
  ["Looks like a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ["Looks like an AWS key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Looks like a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["Looks like a JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["A private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];
/** Long runs of base64/hex-ish characters: hashes in fixtures make false positives, so they only warn. */
const LONG = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
/** The patterns look at a line this much at a time (overlapping by OVERLAP), however long it is (minified code). */
const SCAN_PIECE = 4096;
const OVERLAP = 256;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** "a••••@g••••.com", "sk-a••••", "Tod••••": enough to recognise, not enough to use. */
export function mask(s: string): string {
  const email = /^([^@])[^@]*@([^.])[^.]*(\..+)$/.exec(s);
  if (email) return `${email[1]}••••@${email[2]}••••${email[3]}`;
  const keep = s.length > 12 ? 4 : 1;
  return `${s.slice(0, keep)}••••`;
}

/** Where `needle` is in `data`, byte for byte. */
function indexOfBytes(data: Uint8Array, needle: Uint8Array, from = 0): number {
  for (let i = data.indexOf(needle[0], from); i >= 0 && i + needle.length <= data.length; i = data.indexOf(needle[0], i + 1)) {
    let j = 1;
    while (j < needle.length && data[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/**
 * What's in the files to share: personal data and key shapes, and exact matches of the owner's
 * own stored values (`own`: keys block, settings warn). Values shorter than 6 characters are left
 * out of the exact match: too common to mean anything. A binary file (one with a NUL byte) is
 * searched for the owner's own values only, byte for byte.
 */
export function scanFiles(files: Files, own: OwnValue[] = []): Finding[] {
  const out: Finding[] = [];
  const named = new Map<string, { label: string; kind: "secret" | "setting" }>();
  for (const o of own) {
    const v = typeof o === "string" ? { value: o, label: "One of your own stored values", kind: "secret" as const } : { value: o.value, label: o.label, kind: o.kind ?? "secret" };
    // The same value as a key and as a setting: a key, so it blocks.
    if (v.value.length >= 6 && (!named.has(v.value) || (v.kind === "secret" && named.get(v.value)!.kind !== "secret"))) named.set(v.value, { label: v.label, kind: v.kind });
  }
  const mine = [...named.keys()].sort((a, b) => b.length - a.length);
  for (const [file, data] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (data.includes(0)) {
      for (const v of mine) {
        const at = indexOfBytes(data, enc.encode(v));
        if (at < 0) continue;
        let line = 1;
        for (let i = data.indexOf(10); i >= 0 && i < at; i = data.indexOf(10, i + 1)) line++;
        const { label, kind } = named.get(v)!;
        out.push({ file, line, kind, label, masked: mask(v), text: v });
      }
      continue;
    }
    const lines = dec.decode(data).split("\n");
    lines.forEach((text, i) => {
      const line = i + 1;
      const seen = new Set<string>();
      const add = (kind: Finding["kind"], label: string, match: string) => {
        if (seen.has(match)) return;
        seen.add(match);
        out.push({ file, line, kind, label, masked: mask(match), text: match });
      };
      for (const v of mine) if (text.includes(v)) add(named.get(v)!.kind, named.get(v)!.label, v);
      for (let at = 0; at === 0 || at + OVERLAP < text.length; at += SCAN_PIECE - OVERLAP) {
        const piece = text.slice(at, at + SCAN_PIECE);
        for (const [label, re] of KEYS) for (const m of piece.matchAll(re)) add("key", label, m[0]);
        for (const m of piece.matchAll(LONG)) if (!seen.has(m[0]) && !/^[a-z_]+$/i.test(m[0]) && entropy(m[0]) > 3.5) add("key", "Long random string", m[0]);
        for (const [label, re, keep] of PII) for (const m of piece.matchAll(re)) if (!keep || keep(m[0].trim())) add("pii", label, m[0].trim());
      }
    });
  }
  return out;
}
