// SPDX-License-Identifier: Apache-2.0
type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): { changes: number; lastInsertRowid: number }; all(...p: unknown[]): any[]; get(...p: unknown[]): any };
  transaction<T>(fn: () => T): T;
};
type Ctx = { db: Db };

type KidRow = { id: number; name: string; birthdate: string | null };
type QuoteRow = {
  id: number;
  kid_id: number;
  kid_name: string;
  birthdate: string | null;
  text: string;
  context: string | null;
  said_on: string;
  created_at: string;
};

const TZ: string | undefined = undefined; // the runtime's own zone: tools don't get the owner's time zone yet
const WIDGET_MAX = 280;
// A medium widget has room for about two lines next to its button.
const MEDIUM_MAX = 56;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ---------- dates ----------

function today(): string {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const s = `${get("year")}-${get("month")}-${get("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch {
    // no time zone data: fall back to UTC
  }
  return now.toISOString().slice(0, 10);
}

function parts(s: string): [number, number, number] {
  return [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayNumber(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parts(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function checkDate(s: string, field: string): string {
  if (!isDate(s)) throw new Error(`${field} must be a real date (YYYY-MM-DD), got '${s}'`);
  return s;
}

/** Whole years and months from birth to `on`. A birthday on a day the month doesn't have
 *  (Feb 29, the 31st) falls on that month's last day. null when `on` is before birth. */
export function ageAt(birth: string, on: string): { years: number; months: number } | null {
  const [by, bm, bd] = parts(birth);
  const [oy, om, od] = parts(on);
  let months = (oy - by) * 12 + (om - bm);
  if (od < Math.min(bd, daysInMonth(oy, om))) months--;
  if (months < 0) return null;
  return { years: Math.floor(months / 12), months: months % 12 };
}

export function formatAge(birth: string | null, on: string): string | null {
  if (!birth) return null;
  const a = ageAt(birth, on);
  if (!a) return null;
  if (a.years > 0 && a.months > 0) return `${a.years} y ${a.months} m`;
  if (a.years > 0) return `${a.years} y`;
  return `${a.months} m`;
}

/** Years between `said` and `date` when `said` is within ±3 days of the same month-day in an earlier year. */
export function yearsAgoOnThisDay(said: string, date: string): number | null {
  const [sy, sm, sd] = parts(said);
  const [y, m, d] = parts(date);
  const s = dayNumber(sy, sm, sd);
  let best: { k: number; diff: number } | null = null;
  for (const k of [y - sy - 1, y - sy, y - sy + 1]) {
    if (k < 1) continue;
    const ay = y - k;
    const diff = Math.abs(s - dayNumber(ay, m, Math.min(d, daysInMonth(ay, m))));
    if (diff <= 3 && (!best || diff < best.diff)) best = { k, diff };
  }
  return best ? best.k : null;
}

// ---------- rows ----------

const QUOTE_SELECT = `SELECT q.id, q.kid_id, k.name AS kid_name, k.birthdate, q.text, q.context, q.said_on, q.created_at
  FROM quotes q JOIN kids k ON k.id = q.kid_id`;

function toQuote(r: QuoteRow) {
  return {
    id: r.id,
    kid_id: r.kid_id,
    kid: r.kid_name,
    text: r.text,
    context: r.context,
    said_on: r.said_on,
    created_at: r.created_at,
    age_at_time: formatAge(r.birthdate, r.said_on),
  };
}

function getQuoteRow(db: Db, id: number): QuoteRow | undefined {
  return db.prepare(`${QUOTE_SELECT} WHERE q.id = ?`).get(id);
}

function findKid(db: Db, kid: string | number): KidRow {
  if (typeof kid === "number") {
    const row = db.prepare("SELECT id, name, birthdate FROM kids WHERE id = ?").get(kid);
    if (!row) throw new Error(`No kid with id ${kid}`);
    return row;
  }
  const name = kid.trim();
  const row =
    db.prepare("SELECT id, name, birthdate FROM kids WHERE name = ? COLLATE NOCASE").get(name) ??
    (/^\d+$/.test(name) ? db.prepare("SELECT id, name, birthdate FROM kids WHERE id = ?").get(Number(name)) : undefined);
  if (!row) {
    const names = db.prepare("SELECT name FROM kids ORDER BY name").all().map((k: any) => k.name);
    const known = names.length ? `Known kids: ${names.join(", ")}.` : "No kids added yet.";
    throw new Error(`No kid named '${name}'. Add them with add_kid first. ${known}`);
  }
  return row;
}

function cleanText(text: string): string {
  const t = text.trim();
  if (!t) throw new Error("text can't be empty");
  if (t.length > 500) throw new Error("text can be at most 500 characters");
  return t;
}

function cleanContext(context: string | null | undefined): string | null {
  const c = (context ?? "").trim();
  return c ? c : null;
}

function checkAge(kid: KidRow, saidOn: string) {
  if (kid.birthdate && saidOn < kid.birthdate) {
    throw new Error(`${saidOn} is before ${kid.name}'s birthdate (${kid.birthdate})`);
  }
}

// ---------- widget ----------

function attribution(r: QuoteRow): string {
  const [y, m] = parts(r.said_on);
  const age = formatAge(r.birthdate, r.said_on);
  return [r.kid_name, age, `${MONTHS[m - 1]} ${y}`].filter(Boolean).join(", ");
}

/** The widget line: '"…" — Name, 4 y 7 m, March 2025'. */
export function widgetText(r: QuoteRow): string {
  return `"${r.text}" — ${attribution(r)}`;
}

export function fitsWidget(r: QuoteRow): boolean {
  return widgetText(r).length <= WIDGET_MAX;
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "") + "…";
}

/** The medium widget: the full line when it fits, otherwise the quote (shortened if need be) and the name. */
function mediumText(r: QuoteRow): string {
  const full = widgetText(r);
  if (full.length <= MEDIUM_MAX) return full;
  const tail = `" — ${r.kid_name}`;
  return `"${shorten(r.text, Math.max(12, MEDIUM_MAX - tail.length - 1))}${tail}`;
}

function fittingQuotes(db: Db): QuoteRow[] {
  return (db.prepare(`${QUOTE_SELECT} ORDER BY q.said_on DESC, q.id DESC`).all() as QuoteRow[]).filter(fitsWidget);
}

function currentQuoteId(db: Db): number | null {
  const s = db.prepare("SELECT current_quote_id FROM widget_state WHERE id = 1").get();
  return s?.current_quote_id ?? null;
}

function pickRandom<T>(items: T[]): T {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return items[buf[0] % items.length];
}

// ---------- operations ----------

export const operations = {
  "add_kid@1": (input: { name: string; birthdate?: string | null }, ctx: Ctx) => {
    const { db } = ctx;
    const name = input.name.trim().replace(/\s+/g, " ");
    if (!name) throw new Error("name can't be empty");
    const birthdate = input.birthdate ? checkDate(input.birthdate, "birthdate") : null;
    if (birthdate && birthdate > today()) throw new Error("birthdate can't be in the future");
    if (db.prepare("SELECT 1 FROM kids WHERE name = ? COLLATE NOCASE").get(name)) {
      throw new Error(`A kid named '${name}' already exists`);
    }
    const r = db.prepare("INSERT INTO kids (name, birthdate, created_at) VALUES (?, ?, ?)").run(name, birthdate, new Date().toISOString());
    return { id: Number(r.lastInsertRowid), name, birthdate };
  },

  "list_kids@1": (_input: {}, ctx: Ctx) => {
    const kids = ctx.db
      .prepare(
        `SELECT k.id, k.name, k.birthdate, COUNT(q.id) AS quote_count, MAX(q.created_at) AS last_quote_at
         FROM kids k LEFT JOIN quotes q ON q.kid_id = k.id
         GROUP BY k.id ORDER BY k.name COLLATE NOCASE`,
      )
      .all();
    return kids.map((k: any) => ({
      id: k.id,
      name: k.name,
      birthdate: k.birthdate,
      quote_count: k.quote_count,
      last_quote_at: k.last_quote_at ?? null,
      age: formatAge(k.birthdate, today()),
    }));
  },

  "add_quote@1": (input: { text: string; kid: string | number; said_on?: string; context?: string | null }, ctx: Ctx) => {
    const { db } = ctx;
    const text = cleanText(input.text);
    const kid = findKid(db, input.kid);
    const saidOn = input.said_on ? checkDate(input.said_on, "said_on") : today();
    checkAge(kid, saidOn);
    const r = db
      .prepare("INSERT INTO quotes (kid_id, text, context, said_on, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(kid.id, text, cleanContext(input.context), saidOn, new Date().toISOString());
    return toQuote(getQuoteRow(db, Number(r.lastInsertRowid))!);
  },

  "update_quote@1": (
    input: { id: number; text?: string; kid?: string | number; said_on?: string; context?: string | null },
    ctx: Ctx,
  ) => {
    const { db } = ctx;
    const row = getQuoteRow(db, input.id);
    if (!row) throw new Error(`No quote with id ${input.id}`);
    const text = input.text !== undefined ? cleanText(input.text) : row.text;
    const kid = input.kid !== undefined ? findKid(db, input.kid) : { id: row.kid_id, name: row.kid_name, birthdate: row.birthdate };
    const saidOn = input.said_on !== undefined ? checkDate(input.said_on, "said_on") : row.said_on;
    const context = input.context !== undefined ? cleanContext(input.context) : row.context;
    checkAge(kid, saidOn);
    db.prepare("UPDATE quotes SET text = ?, kid_id = ?, said_on = ?, context = ? WHERE id = ?").run(text, kid.id, saidOn, context, row.id);
    return toQuote(getQuoteRow(db, row.id)!);
  },

  "delete_quote@1": (input: { id: number }, ctx: Ctx) => {
    const { db } = ctx;
    return db.transaction(() => {
      const r = db.prepare("DELETE FROM quotes WHERE id = ?").run(input.id);
      if (!r.changes) throw new Error(`No quote with id ${input.id}`);
      db.prepare("DELETE FROM widget_shown WHERE quote_id = ?").run(input.id);
      db.prepare("UPDATE widget_state SET current_quote_id = NULL, shown_at = NULL WHERE current_quote_id = ?").run(input.id);
      return { deleted: true as const, id: input.id };
    });
  },

  "list_quotes@1": (input: { kid?: string | number; q?: string; year?: number; limit?: number; offset?: number }, ctx: Ctx) => {
    const { db } = ctx;
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.kid !== undefined) {
      where.push("q.kid_id = ?");
      params.push(findKid(db, input.kid).id);
    }
    const search = input.q?.trim();
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      where.push("(q.text LIKE ? ESCAPE '\\' OR IFNULL(q.context, '') LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (input.year !== undefined) {
      where.push("substr(q.said_on, 1, 4) = ?");
      params.push(String(input.year).padStart(4, "0"));
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM quotes q${clause}`).get(...params).n;
    const rows = db
      .prepare(`${QUOTE_SELECT}${clause} ORDER BY q.said_on DESC, q.id DESC LIMIT ? OFFSET ?`)
      .all(...params, input.limit ?? 50, input.offset ?? 0) as QuoteRow[];
    return { quotes: rows.map(toQuote), total };
  },

  "on_this_day@1": (input: { date?: string }, ctx: Ctx) => {
    const date = input.date ? checkDate(input.date, "date") : today();
    const rows = ctx.db.prepare(`${QUOTE_SELECT} WHERE q.said_on < ? ORDER BY q.said_on DESC, q.id DESC`).all(date) as QuoteRow[];
    const quotes = rows
      .map((r) => ({ r, years_ago: yearsAgoOnThisDay(r.said_on, date) }))
      .filter((x) => x.years_ago !== null)
      .map((x) => ({ ...toQuote(x.r), years_ago: x.years_ago as number }));
    return { date, count: quotes.length, quotes };
  },

  "next_widget_quote@1": (input: { date?: string }, ctx: Ctx) => {
    const { db } = ctx;
    const date = input.date ? checkDate(input.date, "date") : today();
    return db.transaction(() => {
      const current = currentQuoteId(db);
      const fitting = fittingQuotes(db);
      const shownToday = new Set(
        db.prepare("SELECT quote_id FROM widget_shown WHERE shown_on = ?").all(date).map((r: any) => r.quote_id),
      );
      const onThisDay = fitting.filter((r) => r.id !== current && !shownToday.has(r.id) && yearsAgoOnThisDay(r.said_on, date) !== null);
      const others = fitting.filter((r) => r.id !== current);
      let pick: QuoteRow | undefined;
      let pool: number;
      if (onThisDay.length) {
        pool = onThisDay.length;
        pick = pickRandom(onThisDay);
      } else if (others.length) {
        pool = others.length;
        pick = pickRandom(others);
      } else {
        // Nothing else to show: keep the current quote (if there is one).
        pool = 0;
        pick = fitting.find((r) => r.id === current);
      }
      if (!pick) {
        db.prepare("UPDATE widget_state SET current_quote_id = NULL, shown_at = NULL WHERE id = 1").run();
        return { quote: null, on_this_day: false, repeated: false, pool: 0 };
      }
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO widget_state (id, current_quote_id, shown_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET current_quote_id = excluded.current_quote_id, shown_at = excluded.shown_at`,
      ).run(pick.id, now);
      db.prepare("INSERT OR IGNORE INTO widget_shown (quote_id, shown_on) VALUES (?, ?)").run(pick.id, date);
      return {
        quote: toQuote(pick),
        on_this_day: yearsAgoOnThisDay(pick.said_on, date) !== null,
        repeated: pick.id === current,
        pool,
      };
    });
  },

  "widget_kid_quote@1": (input: { date?: string }, ctx: Ctx) => {
    const { db } = ctx;
    const date = input.date && isDate(input.date) ? input.date : today();
    const current = currentQuoteId(db);
    let row = current !== null ? getQuoteRow(db, current) : undefined;
    if (row && !fitsWidget(row)) row = undefined;
    if (!row) row = fittingQuotes(db)[0];
    if (!row) {
      const empty = { template: "text", text: "Add the first quote" };
      return { medium: empty, large: empty };
    }
    const buttons = [{ label: "Another", operation: "next_widget_quote@1" }];
    const years = yearsAgoOnThisDay(row.said_on, date);
    const total = db.prepare("SELECT COUNT(*) AS n FROM quotes").get().n;
    const caption =
      years !== null
        ? `On this day, ${years} ${years === 1 ? "year" : "years"} ago`
        : `${total} ${total === 1 ? "quote" : "quotes"} saved`;
    return {
      medium: { template: "text", text: mediumText(row), buttons },
      large: { template: "text", text: widgetText(row), caption, buttons },
    };
  },
};
