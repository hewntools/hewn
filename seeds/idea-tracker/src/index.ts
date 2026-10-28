// SPDX-License-Identifier: Apache-2.0
type Statement = {
  run(...p: unknown[]): { changes: number; lastInsertRowid: number };
  all(...p: unknown[]): any[];
  get(...p: unknown[]): any;
};
type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): T;
};
type Ctx = { db: DatabaseSync };
type Status = "raw" | "exploring" | "validating" | "active" | "parked" | "shipped" | "killed";
// Contract version: v1 predates 'shipped' and reports a shipped idea as 'parked'.
// v1 and v2 predate 'active' and report an active idea as 'validating'.
type Version = 1 | 2 | 3;

// Lifecycle order, used for sorting, pickers and the UI.
export const STATUSES: Status[] = ["raw", "exploring", "validating", "active", "parked", "shipped", "killed"];
const V2_STATUSES: Status[] = ["raw", "exploring", "validating", "parked", "killed", "shipped"];
const V1_STATUSES: Status[] = ["raw", "exploring", "validating", "parked", "killed"];
// v3: only killed and shipped are closed; parked is open but ranks below the live statuses.
export const CLOSED: Status[] = ["killed", "shipped"];
// v1/v2 keep their original open/closed split so existing callers behave the same.
const LEGACY_CLOSED: Status[] = ["parked", "killed", "shipped"];

export function isOpen(status: Status): boolean {
  return !CLOSED.includes(status);
}

// Status as reported by contract version v.
export function reportStatus(status: Status, v: Version): Status {
  if (v < 3 && status === "active") return "validating";
  if (v === 1 && status === "shipped") return "parked";
  return status;
}

// Stored statuses a v1/v2 status filter value matches (it sees them under that name).
function legacyFilterStatuses(statuses: Status[], v: Version): Status[] {
  const out = [...statuses];
  if (v < 3 && out.includes("validating")) out.push("active");
  if (v === 1 && out.includes("parked")) out.push("shipped");
  return [...new Set(out)];
}

const LIFECYCLE_SQL = `CASE i.status ${STATUSES.map((s, n) => `WHEN '${s}' THEN ${n}`).join(" ")} ELSE ${STATUSES.length} END`;
// 0 = live, 1 = parked, 2 = closed.
const GROUP_SQL = `CASE WHEN i.status = 'parked' THEN 1 WHEN i.status IN ('killed', 'shipped') THEN 2 ELSE 0 END`;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const MAX_URL_LEN = 500;

// The Hewn runtime crashes on raw U+2028/U+2029 in serialized output, and
// JSON.stringify leaves them unescaped. They can only occur inside JSON string
// literals, where the \u escape decodes to the identical character.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");

export function escapeLineSeparators(json: string): string {
  return json.replace(LINE_SEPARATORS, (c) => (c.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029"));
}

const SAFE_STRINGIFY = Symbol.for("idea-tracker.safe-stringify");
const jsonGlobal = JSON as typeof JSON & { [SAFE_STRINGIFY]?: true };
if (!jsonGlobal[SAFE_STRINGIFY]) {
  const original = JSON.stringify;
  JSON.stringify = function (value: unknown, replacer?: any, space?: any) {
    const out = original.call(JSON, value, replacer, space);
    return typeof out === "string" ? escapeLineSeparators(out) : out;
  } as typeof JSON.stringify;
  jsonGlobal[SAFE_STRINGIFY] = true;
}

function fail(code: string, message: string): never {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  throw e;
}

const notFound = (what: string, id: string): never => fail("NOT_FOUND", `${what} not found: ${id}`);
const invalid = (message: string): never => fail("INVALID_INPUT", message);

function newId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// Monotonic clock: never returns a timestamp at or before the latest one stored,
// so "most recently updated" ordering is stable even within the same millisecond.
function now(db: DatabaseSync): string {
  const row = db
    .prepare(
      "SELECT MAX(t) AS t FROM (SELECT MAX(updated_at) AS t FROM ideas UNION ALL SELECT MAX(created_at) FROM notes)",
    )
    .get() as { t: string | null } | undefined;
  let ms = Date.now();
  if (row && row.t) {
    const last = Date.parse(row.t);
    if (!Number.isNaN(last) && ms <= last) ms = last + 1;
  }
  return new Date(ms).toISOString();
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  // The platform's transaction nests safely and rolls back on throw.
  return db.transaction(fn);
}

// ---- normalization (pure) ----

export function normalizeTitle(raw: string): string {
  const t = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (t.length === 0) invalid("title must not be empty");
  if (t.length > 200) invalid("title must be at most 200 characters");
  return t;
}

export function normalizePitch(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const p = String(raw).replace(/\r\n|\r|\n/g, " ").trim();
  if (p.length === 0) return null;
  if (p.length > 500) invalid("pitch must be at most 500 characters");
  return p;
}

export function normalizeTag(raw: string): string {
  return String(raw).trim().toLowerCase().replace(/\s+/g, "-");
}

export function normalizeTags(raw: string[] | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const r of raw) {
    const t = normalizeTag(r);
    if (!t) continue;
    if (t.length > MAX_TAG_LEN) invalid(`tag '${t}' is longer than ${MAX_TAG_LEN} characters`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) invalid(`at most ${MAX_TAGS} tags per idea`);
  return out;
}

function normalizeRating(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 5) {
    invalid("rating must be an integer from 1 to 5");
  }
  return raw as number;
}

export function normalizeUrl(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const u = String(raw).trim();
  if (u.length === 0) return null;
  if (u.length > MAX_URL_LEN) invalid(`url must be at most ${MAX_URL_LEN} characters`);
  if (/\s/.test(u) || !/^https?:\/\//i.test(u)) invalid("url must be an http or https URL");
  let parsed: URL | null = null;
  try {
    parsed = new URL(u);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    invalid("url must be an http or https URL");
  }
  return u;
}

function normalizeStatus(raw: unknown, v: Version = 3): Status {
  const allowed = v === 1 ? V1_STATUSES : v === 2 ? V2_STATUSES : STATUSES;
  if (!allowed.includes(raw as Status)) invalid(`status must be one of ${allowed.join(", ")}`);
  return raw as Status;
}

function normalizeBody(raw: string): string {
  const b = String(raw).trim();
  if (b.length === 0) invalid("note body must not be empty");
  if (b.length > 5000) invalid("note body must be at most 5000 characters");
  return b;
}

// ---- reads ----

type IdeaRow = {
  id: string;
  title: string;
  pitch: string | null;
  url: string | null;
  status: Status;
  rating: number | null;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
  note_count: number;
};

const SUMMARY_COLS = `i.id, i.title, i.pitch, i.url, i.status, i.rating, i.created_at, i.updated_at, i.status_changed_at,
  (SELECT COUNT(*) FROM notes n WHERE n.idea_id = i.id) AS note_count`;

function tagsFor(db: DatabaseSync, id: string): string[] {
  return (db.prepare("SELECT tag FROM idea_tags WHERE idea_id = ? ORDER BY rowid").all(id) as { tag: string }[]).map(
    (r) => r.tag,
  );
}

function toSummary(db: DatabaseSync, r: IdeaRow, v: Version) {
  return {
    id: r.id,
    title: r.title,
    pitch: r.pitch ?? null,
    url: r.url ?? null,
    status: reportStatus(r.status, v),
    rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
    tags: tagsFor(db, r.id),
    note_count: Number(r.note_count),
    created_at: r.created_at,
    updated_at: r.updated_at,
    status_changed_at: r.status_changed_at,
  };
}

function requireRow(db: DatabaseSync, id: string): IdeaRow {
  const row = db.prepare(`SELECT ${SUMMARY_COLS} FROM ideas i WHERE i.id = ?`).get(id) as IdeaRow | undefined;
  if (!row) notFound("idea", id);
  return row as IdeaRow;
}

function loadIdea(db: DatabaseSync, id: string, v: Version) {
  const summary = toSummary(db, requireRow(db, id), v);
  const notes = (
    db
      .prepare("SELECT id, body, created_at FROM notes WHERE idea_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(id) as { id: string; body: string; created_at: string }[]
  ).map((n) => ({ id: n.id, body: n.body, created_at: n.created_at }));
  return { ...summary, notes };
}

function setTags(db: DatabaseSync, id: string, tags: string[]) {
  db.prepare("DELETE FROM idea_tags WHERE idea_id = ?").run(id);
  const ins = db.prepare("INSERT INTO idea_tags (idea_id, tag) VALUES (?, ?)");
  for (const t of tags) ins.run(id, t);
}

// Note ids are "<idea id>.<n>" with n from a per-idea counter that never goes back.
function insertNote(db: DatabaseSync, ideaId: string, body: string, ts: string) {
  db.prepare("UPDATE ideas SET note_seq = note_seq + 1 WHERE id = ?").run(ideaId);
  const { note_seq } = db.prepare("SELECT note_seq FROM ideas WHERE id = ?").get(ideaId) as { note_seq: number };
  db.prepare("INSERT INTO notes (id, idea_id, body, created_at) VALUES (?, ?, ?, ?)").run(
    `${ideaId}.${note_seq}`,
    ideaId,
    body,
    ts,
  );
}

function touch(db: DatabaseSync, id: string, ts: string) {
  db.prepare("UPDATE ideas SET updated_at = ? WHERE id = ?").run(ts, id);
}

// ---- operations ----

type AddIdeaInput = {
  id?: string;
  title: string;
  pitch?: string;
  url?: string;
  tags?: string[];
  rating?: number;
  status?: Status;
  note?: string;
};

function addIdea(input: AddIdeaInput, ctx: Ctx, v: Version) {
  const db = ctx.db;
  const title = normalizeTitle(input.title);
  const pitch = normalizePitch(input.pitch);
  const url = normalizeUrl(input.url);
  const tags = normalizeTags(input.tags);
  const rating = normalizeRating(input.rating);
  const status = input.status === undefined ? "raw" : normalizeStatus(input.status, v);
  const note = input.note === undefined ? null : normalizeBody(input.note);

  let id = newId();
  if (input.id !== undefined) {
    id = input.id;
    if (db.prepare("SELECT 1 FROM ideas WHERE id = ?").get(id)) fail("CONFLICT", `idea id already exists: ${id}`);
  }
  tx(db, () => {
    const ts = now(db);
    db.prepare(
      `INSERT INTO ideas (id, title, pitch, url, status, rating, created_at, updated_at, status_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, pitch, url, status, rating, ts, ts, ts);
    setTags(db, id, tags);
    if (note !== null) insertNote(db, id, note, ts);
  });
  return loadIdea(db, id, v);
}

type UpdateIdeaInput = {
  id: string;
  title?: string;
  pitch?: string;
  url?: string | null;
  tags?: string[];
  rating?: number | null;
  status?: Status;
};

function updateIdea(input: UpdateIdeaInput, ctx: Ctx, v: Version) {
  const db = ctx.db;
  const current = requireRow(db, input.id);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.title !== undefined) {
    sets.push("title = ?");
    params.push(normalizeTitle(input.title));
  }
  if (input.pitch !== undefined) {
    sets.push("pitch = ?");
    params.push(normalizePitch(input.pitch));
  }
  if (input.url !== undefined) {
    sets.push("url = ?");
    params.push(normalizeUrl(input.url));
  }
  if (input.rating !== undefined) {
    sets.push("rating = ?");
    params.push(normalizeRating(input.rating));
  }
  let statusChanged = false;
  if (input.status !== undefined) {
    const status = normalizeStatus(input.status, v);
    // v1/v2 see an active idea as 'validating', so setting that is a no-op for them.
    const keepActive = v < 3 && status === "validating" && current.status === "active";
    if (status !== current.status && !keepActive) {
      statusChanged = true;
      sets.push("status = ?");
      params.push(status);
    }
  }
  const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);

  tx(db, () => {
    const ts = now(db);
    sets.push("updated_at = ?");
    params.push(ts);
    if (statusChanged) {
      sets.push("status_changed_at = ?");
      params.push(ts);
    }
    params.push(input.id);
    db.prepare(`UPDATE ideas SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (tags !== undefined) setTags(db, input.id, tags);
  });
  return loadIdea(db, input.id, v);
}

function addNote(input: { id: string; body: string }, ctx: Ctx, v: Version) {
  const db = ctx.db;
  requireRow(db, input.id);
  const body = normalizeBody(input.body);
  tx(db, () => {
    const ts = now(db);
    insertNote(db, input.id, body, ts);
    touch(db, input.id, ts);
  });
  return loadIdea(db, input.id, v);
}

function deleteNote(input: { id: string; note_id: string }, ctx: Ctx) {
  const db = ctx.db;
  requireRow(db, input.id);
  const note = db.prepare("SELECT id FROM notes WHERE id = ? AND idea_id = ?").get(input.note_id, input.id);
  if (!note) notFound("note", input.note_id);
  tx(db, () => {
    const ts = now(db);
    db.prepare("DELETE FROM notes WHERE id = ? AND idea_id = ?").run(input.note_id, input.id);
    touch(db, input.id, ts);
  });
  return { deleted: true as const };
}

function getIdea(input: { id: string }, ctx: Ctx, v: Version) {
  return loadIdea(ctx.db, input.id, v);
}

type ListInput = {
  status?: Status[];
  include_closed?: boolean;
  tag?: string;
  min_rating?: number;
  query?: string;
  sort?: "rating" | "updated" | "created" | "status";
  limit?: number;
  offset?: number;
};

function listIdeas(input: ListInput, ctx: Ctx, v: Version) {
  const db = ctx.db;
  const where: string[] = [];
  const params: (string | number)[] = [];

  let statuses: Status[];
  if (input.status && input.status.length > 0) {
    // v1/v2 report active as 'validating' (and v1 shipped as 'parked'), so those filters match them too.
    statuses = legacyFilterStatuses([...new Set(input.status.map((s) => normalizeStatus(s, v)))], v);
  } else if (input.include_closed) {
    statuses = STATUSES;
  } else {
    statuses = STATUSES.filter((s) => (v < 3 ? !LEGACY_CLOSED.includes(s) : isOpen(s)));
  }
  where.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
  params.push(...statuses);

  if (input.tag !== undefined && input.tag.trim() !== "") {
    where.push("EXISTS (SELECT 1 FROM idea_tags t WHERE t.idea_id = i.id AND t.tag = ?)");
    params.push(normalizeTag(input.tag));
  }
  if (input.min_rating !== undefined && input.min_rating !== null) {
    const r = normalizeRating(input.min_rating) as number;
    where.push("i.rating IS NOT NULL AND i.rating >= ?");
    params.push(r);
  }
  const q = (input.query ?? "").trim().toLowerCase();
  if (q) {
    where.push(`(instr(lower(i.title), ?) > 0 OR instr(lower(COALESCE(i.pitch, '')), ?) > 0
      OR EXISTS (SELECT 1 FROM notes n WHERE n.idea_id = i.id AND instr(lower(n.body), ?) > 0))`);
    params.push(q, q, q);
  }

  const sort = input.sort ?? "rating";
  if (sort === "status" && v < 3) invalid("sort must be one of rating, updated, created");
  const best = "(i.rating IS NULL) ASC, i.rating DESC, i.updated_at DESC, i.rowid DESC";
  const order =
    sort === "updated"
      ? "i.updated_at DESC, i.rowid DESC"
      : sort === "created"
        ? "i.created_at DESC, i.rowid DESC"
        : sort === "status"
          ? `${LIFECYCLE_SQL} ASC, ${best}`
          : v < 3
            ? best
            : // v3 best first: live ideas, then parked, then closed.
              `${GROUP_SQL} ASC, ${best}`;

  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM ideas i ${whereSql}`).get(...params) as { c: number };
  const rows = db
    .prepare(`SELECT ${SUMMARY_COLS} FROM ideas i ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as IdeaRow[];

  return { ideas: rows.map((r) => toSummary(db, r, v)), total: Number(totalRow.c) };
}

function listTags(_input: Record<string, never>, ctx: Ctx) {
  const rows = ctx.db
    .prepare("SELECT tag, COUNT(*) AS count FROM idea_tags GROUP BY tag ORDER BY count DESC, tag ASC")
    .all() as { tag: string; count: number }[];
  return { tags: rows.map((r) => ({ tag: r.tag, count: Number(r.count) })) };
}

function deleteIdea(input: { id: string }, ctx: Ctx) {
  const db = ctx.db;
  requireRow(db, input.id);
  tx(db, () => {
    db.prepare("DELETE FROM notes WHERE idea_id = ?").run(input.id);
    db.prepare("DELETE FROM idea_tags WHERE idea_id = ?").run(input.id);
    db.prepare("DELETE FROM ideas WHERE id = ?").run(input.id);
  });
  return { deleted: true as const };
}

export const operations = {
  "add_idea@1": (input: AddIdeaInput, ctx: Ctx) => addIdea(input, ctx, 1),
  "add_idea@2": (input: AddIdeaInput, ctx: Ctx) => addIdea(input, ctx, 2),
  "add_idea@3": (input: AddIdeaInput, ctx: Ctx) => addIdea(input, ctx, 3),
  "update_idea@1": (input: UpdateIdeaInput, ctx: Ctx) => updateIdea(input, ctx, 1),
  "update_idea@2": (input: UpdateIdeaInput, ctx: Ctx) => updateIdea(input, ctx, 2),
  "update_idea@3": (input: UpdateIdeaInput, ctx: Ctx) => updateIdea(input, ctx, 3),
  "add_note@1": (input: { id: string; body: string }, ctx: Ctx) => addNote(input, ctx, 1),
  "add_note@2": (input: { id: string; body: string }, ctx: Ctx) => addNote(input, ctx, 2),
  "add_note@3": (input: { id: string; body: string }, ctx: Ctx) => addNote(input, ctx, 3),
  "delete_note@1": deleteNote,
  "get_idea@1": (input: { id: string }, ctx: Ctx) => getIdea(input, ctx, 1),
  "get_idea@2": (input: { id: string }, ctx: Ctx) => getIdea(input, ctx, 2),
  "get_idea@3": (input: { id: string }, ctx: Ctx) => getIdea(input, ctx, 3),
  "list_ideas@1": (input: ListInput, ctx: Ctx) => listIdeas(input, ctx, 1),
  "list_ideas@2": (input: ListInput, ctx: Ctx) => listIdeas(input, ctx, 2),
  "list_ideas@3": (input: ListInput, ctx: Ctx) => listIdeas(input, ctx, 3),
  "list_tags@1": listTags,
  "delete_idea@1": deleteIdea,
};
