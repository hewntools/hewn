// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool as a file (`<id>.hewn.zip`): the version's files as they are, plus one sidecar,
// hewn-bundle.json. Our own store-only zip (no compression, CRC32): bundles are small, and the
// core runs where node:zlib doesn't. Also the scan run before a tool is shared: personal data and
// key-shaped strings warn, the owner's own stored secret and config values block.
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

/** What the intake model wrote about a tool's code (decision 29), shipped with a bundle Hewn publishes. */
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

/** Why a file isn't a bundle Hewn can read: thrown with a message for the owner. */
export class BundleError extends Error {}

/** The files in a zip. Stored entries only: a compressed one (a zip made by another tool) is refused with the reason. */
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
  let p = view.getUint32(end + 16, true);
  const out: Files = {};
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== 0x02014b50) throw new BundleError("The zip is damaged (its file list doesn't read).");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const at = view.getUint32(p + 42, true);
    const path = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue;
    if (method !== 0) throw new BundleError(`${path} is compressed. Hewn reads bundles that Hewn made: share the tool again from Hewn and use that file.`);
    if (path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "") || path.includes("\\")) throw new BundleError(`${path} isn't a path Hewn accepts.`);
    if (at + 30 > zip.length) throw new BundleError("The zip is damaged.");
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const data = zip.slice(start, start + size);
    if (data.length !== size || crc32(data) !== crc) throw new BundleError(`${path} is damaged (its checksum doesn't match).`);
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
  if (sidecar.format > BUNDLE_FORMAT) throw new BundleError(`This tool was shared from a newer Hewn (bundle format ${sidecar.format}; this Hewn reads ${BUNDLE_FORMAT}).`);
  if (!files["capability.json"]) throw new BundleError("This zip has no capability.json.");
  delete files[SIDECAR];
  return { files, sidecar };
}

// ---------- the scan before sharing ----------

export interface Finding {
  file: string;
  line: number;
  /** "pii": personal data (warns); "key": a key shape or a long random string (warns); "secret": one of the owner's own stored values (blocks). */
  kind: "pii" | "key" | "secret";
  label: string;
  /** The match with most of it hidden. */
  masked: string;
  /** The match itself, for Show. */
  text: string;
}

/** A phone number: 9–15 digits, written with a leading + or with spaces, dashes or brackets; never a date. */
const phoneLike = (m: string) => {
  const digits = m.replace(/\D/g, "").length;
  return digits >= 9 && digits <= 15 && !/^\d{4}-\d\d-\d\d/.test(m) && (m.startsWith("+") || /[ ()-]/.test(m));
};
const PII: [string, RegExp, ((m: string) => boolean)?][] = [
  ["Looks like an email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["Looks like a phone number", /(?<![\w.:])\+?\d[\d ()-]{7,}\d(?![\w.:])/g, phoneLike],
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

/**
 * What's in the files to share: personal data and key shapes (warnings), and exact matches of
 * the owner's own stored secret and config values (`own`: these block). Values shorter than 6
 * characters are left out of the exact match: too common to mean anything.
 */
export function scanFiles(files: Files, own: (string | { value: string; label: string })[] = []): Finding[] {
  const out: Finding[] = [];
  const named = new Map<string, string>();
  for (const o of own) {
    const [value, label] = typeof o === "string" ? [o, "One of your own stored values"] : [o.value, o.label];
    if (value.length >= 6 && !named.has(value)) named.set(value, label);
  }
  const mine = [...named.keys()].sort((a, b) => b.length - a.length);
  for (const [file, data] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (data.includes(0)) continue;
    const lines = dec.decode(data).split("\n");
    lines.forEach((text, i) => {
      const line = i + 1;
      const seen = new Set<string>();
      const add = (kind: Finding["kind"], label: string, match: string) => {
        if (seen.has(match)) return;
        seen.add(match);
        out.push({ file, line, kind, label, masked: mask(match), text: match });
      };
      for (const v of mine) if (text.includes(v)) add("secret", named.get(v)!, v);
      for (const [label, re] of KEYS) for (const m of text.matchAll(re)) add("key", label, m[0]);
      for (const m of text.matchAll(LONG)) if (!seen.has(m[0]) && !/^[a-z_]+$/i.test(m[0]) && entropy(m[0]) > 3.5) add("key", "Long random string", m[0]);
      for (const [label, re, keep] of PII) for (const m of text.matchAll(re)) if (!keep || keep(m[0].trim())) add("pii", label, m[0].trim());
    });
  }
  return out;
}
