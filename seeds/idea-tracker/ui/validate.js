// SPDX-License-Identifier: Apache-2.0
// Client-side checks that mirror the operations' input limits, so the form can say what's wrong
// before saving. No DOM access, so they can be unit-tested (tests/validate.test.mjs).
// Each check returns an error message, or null when the value is fine.

export const LIMITS = { title: 200, pitch: 500, url: 500, note: 5000, tags: 20, tag: 40 };

export function checkTitle(raw) {
  const t = String(raw ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!t) return "Give the idea a title.";
  if (t.length > LIMITS.title) return `Keep the title to ${LIMITS.title} characters (now ${t.length}).`;
  return null;
}

export function checkPitch(raw) {
  const p = String(raw ?? "").replace(/\r\n|\r|\n/g, " ").trim();
  if (p.length > LIMITS.pitch) return `Keep the pitch to ${LIMITS.pitch} characters (now ${p.length}).`;
  return null;
}

export function checkUrl(raw) {
  const u = String(raw ?? "").trim();
  if (!u) return null;
  if (u.length > LIMITS.url) return `Keep the link to ${LIMITS.url} characters (now ${u.length}).`;
  if (/\s/.test(u) || !/^https?:\/\//i.test(u)) return "Links start with http:// or https://.";
  try {
    const parsed = new URL(u);
    if (!parsed.hostname) return "That link is missing a site name.";
  } catch {
    return "That doesn't look like a valid link.";
  }
  return null;
}

export function checkNote(raw) {
  const n = String(raw ?? "").trim();
  if (!n) return "Write something first.";
  if (n.length > LIMITS.note) return `Keep a note to ${LIMITS.note} characters (now ${n.length}).`;
  return null;
}

// Same normalization the server applies: trimmed, lowercase, spaces become hyphens.
export function normalizeTag(raw) {
  return String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

// Splits typed text on commas into normalized, de-duplicated tags.
export function splitTags(text) {
  const out = [];
  for (const part of String(text ?? "").split(",")) {
    const t = normalizeTag(part);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function checkTag(tag) {
  const t = normalizeTag(tag);
  if (t.length > LIMITS.tag) return `Tags can be up to ${LIMITS.tag} characters.`;
  return null;
}

export function checkTags(tags) {
  for (const t of tags) {
    const e = checkTag(t);
    if (e) return e;
  }
  if (tags.length > LIMITS.tags) return `Up to ${LIMITS.tags} tags per idea.`;
  return null;
}
