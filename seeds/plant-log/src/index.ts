// Plant Log: houseplants per window, when each was last watered, fed and repotted,
// and which ones need water today.

type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...p: unknown[]): any[];
    get(...p: unknown[]): any;
  };
  transaction<T>(fn: () => T): T;
};
type Ctx = {
  db: Db;
  model?: { generate(req: object): Promise<{ text: string; json?: unknown }> };
};

type EventType = "watered" | "fed" | "repotted" | "note";
type Status = "overdue" | "today" | "ok";

type PlantRow = {
  id: number;
  name: string;
  species: string | null;
  location: string | null;
  water_every_days: number;
  feed_every_days: number | null;
  notes: string | null;
  created_at: string;
};

type EventRow = {
  id: number;
  plant_id: number;
  type: EventType;
  date: string;
  text: string | null;
  created_at: string;
};

type Lasts = { watered: string | null; fed: string | null; repotted: string | null };

// ---------- dates (owner's local calendar days) ----------

const TIME_ZONE: string | undefined = undefined; // the runtime's own zone: tools don't get the owner's time zone yet
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Days since 1970-01-01 for a YYYY-MM-DD date; throws on anything that isn't a real date. */
export function dayNumber(date: string): number {
  if (typeof date !== "string" || !DATE_RE.test(date)) {
    throw new Error(`"${date}" is not a date. Use YYYY-MM-DD.`);
  }
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new Error(`"${date}" is not a real date.`);
  }
  return Math.round(t / DAY_MS);
}

export function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return fromDayNumber(dayNumber(date) + n);
}

/** The calendar date of an instant in the owner's time zone. */
export function localDate(at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const s = `${get("year")}-${get("month")}-${get("day")}`;
    if (DATE_RE.test(s)) return s;
  } catch {
    // fall through to UTC
  }
  return at.toISOString().slice(0, 10);
}

function resolveToday(today?: string): string {
  if (today === undefined || today === null) return localDate();
  dayNumber(today);
  return today;
}

// ---------- due logic (pure) ----------

export type Schedule = { next: string; status: Status; days_overdue: number; days_until: number };

/**
 * When something is next due: the last time it was done plus the interval. Never done means
 * due from the day the plant was added (never later than today, so an injected past 'today'
 * still reads as due today).
 */
export function schedule(lastDone: string | null, everyDays: number, addedOn: string, today: string): Schedule {
  const t = dayNumber(today);
  const next = lastDone ? dayNumber(lastDone) + everyDays : Math.min(dayNumber(addedOn), t);
  const diff = next - t;
  return {
    next: fromDayNumber(next),
    status: diff < 0 ? "overdue" : diff === 0 ? "today" : "ok",
    days_overdue: Math.max(0, -diff),
    days_until: Math.max(0, diff),
  };
}

const STATUS_RANK: Record<Status, number> = { overdue: 0, today: 1, ok: 2 };

function compareText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // no location sorts last
  if (b === null) return -1;
  return a.localeCompare(b, "sv", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Due order: most overdue first, then due today, then soonest; ties by location, then name. */
export function compareDue(
  a: { status: Status; days_overdue: number; days_until: number; location: string | null; name: string; id: number },
  b: { status: Status; days_overdue: number; days_until: number; location: string | null; name: string; id: number },
): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.days_overdue - a.days_overdue ||
    a.days_until - b.days_until ||
    compareText(a.location, b.location) ||
    compareText(a.name, b.name) ||
    a.id - b.id
  );
}

export function computePlant(row: PlantRow, last: Lasts, today: string) {
  const added = localDate(new Date(row.created_at));
  const t = dayNumber(today);
  const water = schedule(last.watered, row.water_every_days, added, today);
  const feed = row.feed_every_days ? schedule(last.fed, row.feed_every_days, added, today) : null;
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    location: row.location,
    water_every_days: row.water_every_days,
    feed_every_days: row.feed_every_days,
    notes: row.notes,
    created_at: row.created_at,
    added_on: added,
    last_watered: last.watered,
    watered_days_ago: last.watered ? t - dayNumber(last.watered) : null,
    next_water: water.next,
    status: water.status,
    days_overdue: water.days_overdue,
    days_until: water.days_until,
    last_fed: last.fed,
    fed_days_ago: last.fed ? t - dayNumber(last.fed) : null,
    next_feed: feed ? feed.next : null,
    feed_status: feed ? feed.status : null,
    feed_days_overdue: feed ? feed.days_overdue : null,
    feed_days_until: feed ? feed.days_until : null,
    last_repotted: last.repotted,
    repotted_days_ago: last.repotted ? t - dayNumber(last.repotted) : null,
  };
}

export type Plant = ReturnType<typeof computePlant>;

// ---------- storage helpers ----------

function cleanText(v: unknown, max: number, field: string): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if ([...s].length > max) throw new Error(`${field} is too long (at most ${max} characters).`);
  return s;
}

function cleanName(v: unknown): string {
  const s = cleanText(v, 80, "Name");
  if (!s) throw new Error("A plant needs a name.");
  return s;
}

function cleanInterval(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`${field} must be a whole number of days, at least 1.`);
  }
  return v;
}

function pastDate(date: string, field: string): string {
  const n = dayNumber(date);
  if (n > dayNumber(localDate())) throw new Error(`${field} can't be in the future (${date}).`);
  return date;
}

function plantRow(db: Db, id: unknown): PlantRow {
  const row = db.prepare("SELECT * FROM plants WHERE id = ?").get(id) as PlantRow | undefined;
  if (!row) throw new Error(`No plant with id ${id}.`);
  return row;
}

function lastsFor(db: Db, plantId?: number): Map<number, Lasts> {
  const rows = (
    plantId === undefined
      ? db.prepare(
          "SELECT plant_id, type, MAX(date) AS last FROM events WHERE type IN ('watered','fed','repotted') GROUP BY plant_id, type",
        ).all()
      : db.prepare(
          "SELECT plant_id, type, MAX(date) AS last FROM events WHERE plant_id = ? AND type IN ('watered','fed','repotted') GROUP BY plant_id, type",
        ).all(plantId)
  ) as { plant_id: number; type: "watered" | "fed" | "repotted"; last: string }[];
  const map = new Map<number, Lasts>();
  for (const r of rows) {
    const l = map.get(r.plant_id) ?? { watered: null, fed: null, repotted: null };
    l[r.type] = r.last;
    map.set(r.plant_id, l);
  }
  return map;
}

const NO_LASTS: Lasts = { watered: null, fed: null, repotted: null };

function loadPlant(db: Db, id: number, today: string): Plant {
  const row = plantRow(db, id);
  return computePlant(row, lastsFor(db, id).get(id) ?? NO_LASTS, today);
}

function loadPlants(db: Db, today: string): Plant[] {
  const rows = db.prepare("SELECT * FROM plants").all() as PlantRow[];
  const lasts = lastsFor(db);
  return rows.map((r) => computePlant(r, lasts.get(r.id) ?? NO_LASTS, today)).sort(compareDue);
}

function isDue(p: Plant): boolean {
  return p.status === "overdue" || p.status === "today";
}

/** Records an event. A repeat of the same watering/feeding/repotting on the same day is not stored twice. */
function recordEvent(db: Db, plantId: number, type: EventType, date: string, text: string | null): EventRow {
  if (type !== "note" && !text) {
    const existing = db
      .prepare("SELECT * FROM events WHERE plant_id = ? AND type = ? AND date = ? ORDER BY id LIMIT 1")
      .get(plantId, type, date) as EventRow | undefined;
    if (existing) return existing;
  }
  const res = db
    .prepare("INSERT INTO events (plant_id, type, date, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(plantId, type, date, text, new Date().toISOString());
  return db.prepare("SELECT * FROM events WHERE id = ?").get(Number(res.lastInsertRowid)) as EventRow;
}

function waterPlants(db: Db, ids: number[], date: string, today: string) {
  return db.transaction(() => {
    const unique = [...new Set(ids)];
    const rows = unique.map((id) => plantRow(db, id));
    for (const r of rows) recordEvent(db, r.id, "watered", date, null);
    return rows.map((r) => {
      const p = loadPlant(db, r.id, today);
      return { id: p.id, name: p.name, next_water: p.next_water };
    });
  });
}

// ---------- widget (pure) ----------

const WIDGET = {
  medium: { rows: 3, title: 14, detail: 16, button: 13 },
  large: { rows: 5, title: 14, detail: 16, button: 18 },
};

export function clip(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, max - 1).join("").trimEnd() + "…";
}

function lateLabel(p: Plant): string {
  if (p.status === "today") return "today";
  return `${p.days_overdue} day${p.days_overdue === 1 ? "" : "s"} late`;
}

function nextLabel(p: Plant, nameMax: number): string {
  const when = p.days_until === 1 ? "tomorrow" : `in ${p.days_until} days`;
  return `Next: ${clip(p.name, nameMax)}, ${when}`;
}

export function widgetViews(plants: Plant[]) {
  if (plants.length === 0) {
    return {
      small: { template: "text", text: "Add your first plant" },
      medium: { template: "text", text: "Add your first plant", caption: "With its window and how often it needs water" },
      large: { template: "text", text: "Add your first plant", caption: "With its window and how often it needs water" },
    };
  }
  const due = plants.filter(isDue);
  const upcoming = plants.find((p) => p.status === "ok") ?? null;

  const small = {
    template: "stat",
    value: due.length,
    caption: due.length === 0 ? "All watered" : due.length === 1 ? "needs water" : "need water",
  };

  const list = (size: "medium" | "large") => {
    const lim = WIDGET[size];
    if (due.length === 0) {
      return {
        template: "list",
        items: [],
        empty: upcoming ? nextLabel(upcoming, 20) : "All watered",
      };
    }
    const items = due.slice(0, lim.rows).map((p) => {
      const item: { title: string; detail?: string; value: string } = { title: clip(p.name, lim.title), value: lateLabel(p) };
      if (p.location) item.detail = clip(p.location, lim.detail);
      return item;
    });
    const named = `Watered ${due[0].name}`;
    return {
      template: "list",
      items,
      buttons: [
        { label: "Watered all", operation: "water_due@1" },
        { label: [...named].length <= lim.button ? named : "Watered next", operation: "water_next@1" },
      ],
    };
  };

  return { small, medium: list("medium"), large: list("large") };
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeHead(data: string, maxBytes: number): Uint8Array {
  const out = new Uint8Array(maxBytes);
  let buffer = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < data.length && n < maxBytes; i++) {
    const ch = data.charAt(i);
    if (ch === "=") break;
    const value = B64_ALPHABET.indexOf(ch);
    if (value < 0) break;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

const IDENTIFY_SCHEMA = {
  type: "object",
  required: ["not_a_plant", "candidates"],
  properties: {
    not_a_plant: { type: "boolean", description: "True only when the photo shows no plant." },
    candidates: {
      type: "array",
      description: "Likely plants, best first.",
      items: {
        type: "object",
        required: ["common_name", "species", "confidence", "water_every_days", "feed_every_days", "care_note"],
        properties: {
          common_name: { type: "string" },
          species: { type: "string", description: "Botanical name." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          water_every_days: { type: "integer", minimum: 1, maximum: 3650 },
          feed_every_days: { type: ["integer", "null"], minimum: 1, maximum: 3650 },
          care_note: { type: "string", description: "One short line covering light and watering." },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

function imageMime(bytes: Uint8Array): MediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function readImage(image: unknown, mediaType: MediaType): string {
  if (typeof image !== "string" || !image.trim()) throw new Error("Choose a photo to identify.");
  let b64 = image.trim().replace(/\s+/g, "");
  if (b64.startsWith("data:")) {
    const comma = b64.indexOf(",");
    if (comma >= 0) b64 = b64.slice(comma + 1);
  }
  if (!b64) throw new Error("Choose a photo to identify.");
  if (b64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error("That image couldn't be read. Try a JPEG, PNG or WebP photo.");
  }
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const padding = padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0;
  const size = (padded.length / 4) * 3 - padding;
  if (size > MAX_IMAGE_BYTES) {
    throw new Error("That photo is too large (over 5 MB). Try a smaller one.");
  }
  const actual = imageMime(decodeHead(padded, 12));
  if (actual && actual !== mediaType) {
    const label = actual === "image/jpeg" ? "JPEG" : actual === "image/png" ? "PNG" : "WebP";
    throw new Error(`That photo is a ${label} file, not the format it was labelled with. Try uploading it again.`);
  }
  return padded;
}

function modelText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const chars = [...value.trim().replace(/\s+/g, " ")];
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : chars.join("");
}

function modelConfidence(value: unknown): number {
  let n = typeof value === "number" ? value : Number.parseFloat(String(value ?? "").replace("%", "").trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return 0;
  if (n > 1) n = n / 100;
  return n;
}

function modelDays(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return fallback;
  const days = Math.round(n);
  if (days < 1) return fallback;
  return Math.min(3650, days);
}

type Candidate = {
  common_name: string;
  species: string;
  confidence: number;
  water_every_days: number;
  feed_every_days: number | null;
  care_note: string;
};

export function normalizeIdentification(raw: unknown): { not_a_plant: boolean; candidates: Candidate[] } {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (data.not_a_plant === true) return { not_a_plant: true, candidates: [] };
  const list = Array.isArray(data.candidates) ? data.candidates : [];
  const candidates: Candidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const species = modelText(c.species, 120);
    const common = modelText(c.common_name, 80) || species;
    if (!common) continue;
    candidates.push({
      common_name: common,
      species,
      confidence: modelConfidence(c.confidence),
      water_every_days: modelDays(c.water_every_days, 7) ?? 7,
      feed_every_days: modelDays(c.feed_every_days, null),
      care_note: modelText(c.care_note, 240),
    });
    if (candidates.length === 3) break;
  }
  return { not_a_plant: false, candidates };
}

const IDENTIFY_SYSTEM = [
  "You identify houseplants from photos for a plant-care log.",
  "Only name what the photo supports. Never invent certainty: if the plant is unclear, small in the frame or hard to tell apart, give a low confidence (0 to 1).",
  "If there is no plant in the photo, set not_a_plant to true and return no candidates.",
  "Otherwise return at most three candidates, best first.",
  "For each candidate give the common name, botanical species, confidence, a typical indoor watering interval in days, a typical feeding interval in days (or null when feeding is not usually needed) and one short care line covering light and watering.",
].join(" ");

// ---------- operations ----------

type PlantFields = {
  name?: string;
  species?: string | null;
  location?: string | null;
  water_every_days?: number;
  feed_every_days?: number | null;
  notes?: string | null;
};

export const operations = {
  "add_plant@1": (input: PlantFields & { name: string; last_watered?: string }, ctx: Ctx) => {
    const db = ctx.db;
    const name = cleanName(input.name);
    const species = cleanText(input.species, 120, "Species");
    const location = cleanText(input.location, 80, "Location");
    const notes = cleanText(input.notes, 500, "Notes");
    const water = input.water_every_days === undefined ? 7 : cleanInterval(input.water_every_days, "Water every");
    const feed =
      input.feed_every_days === undefined || input.feed_every_days === null
        ? null
        : cleanInterval(input.feed_every_days, "Feed every");
    const lastWatered = input.last_watered ? pastDate(input.last_watered, "Last watered") : null;
    const today = localDate();
    return db.transaction(() => {
      const res = db
        .prepare(
          "INSERT INTO plants (name, species, location, water_every_days, feed_every_days, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(name, species, location, water, feed, notes, new Date().toISOString());
      const id = Number(res.lastInsertRowid);
      if (lastWatered) recordEvent(db, id, "watered", lastWatered, null);
      return loadPlant(db, id, today);
    });
  },

  "update_plant@1": (input: PlantFields & { id: number }, ctx: Ctx) => {
    const db = ctx.db;
    plantRow(db, input.id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (input.name !== undefined) set("name", cleanName(input.name));
    if (input.species !== undefined) set("species", cleanText(input.species, 120, "Species"));
    if (input.location !== undefined) set("location", cleanText(input.location, 80, "Location"));
    if (input.notes !== undefined) set("notes", cleanText(input.notes, 500, "Notes"));
    if (input.water_every_days !== undefined) set("water_every_days", cleanInterval(input.water_every_days, "Water every"));
    if (input.feed_every_days !== undefined) {
      set("feed_every_days", input.feed_every_days === null ? null : cleanInterval(input.feed_every_days, "Feed every"));
    }
    if (sets.length) db.prepare(`UPDATE plants SET ${sets.join(", ")} WHERE id = ?`).run(...params, input.id);
    return loadPlant(db, input.id, localDate());
  },

  "delete_plant@1": (input: { id: number }, ctx: Ctx) => {
    const db = ctx.db;
    plantRow(db, input.id);
    db.transaction(() => {
      db.prepare("DELETE FROM events WHERE plant_id = ?").run(input.id);
      db.prepare("DELETE FROM plants WHERE id = ?").run(input.id);
    });
    return { deleted: true };
  },

  "log_event@1": (input: { plant_id: number; type: EventType; date?: string; text?: string }, ctx: Ctx) => {
    const db = ctx.db;
    plantRow(db, input.plant_id);
    const text = cleanText(input.text, 500, "Text");
    if (input.type === "note" && !text) throw new Error("A note needs some text.");
    const date = input.date ? pastDate(input.date, "Date") : localDate();
    return recordEvent(db, input.plant_id, input.type, date, text);
  },

  "water@1": (input: { plant_ids: number[]; date?: string }, ctx: Ctx) => {
    if (!input.plant_ids.length) throw new Error("Pick at least one plant to water.");
    const today = localDate();
    const date = input.date ? pastDate(input.date, "Date") : today;
    return { watered: waterPlants(ctx.db, input.plant_ids, date, today) };
  },

  "water_due@1": (input: { today?: string }, ctx: Ctx) => {
    const today = resolveToday(input?.today);
    const due = loadPlants(ctx.db, today).filter(isDue);
    waterPlants(
      ctx.db,
      due.map((p) => p.id),
      today,
      today,
    );
    return { count: due.length, names: due.map((p) => p.name) };
  },

  "water_next@1": (input: { today?: string }, ctx: Ctx) => {
    const today = resolveToday(input?.today);
    const first = loadPlants(ctx.db, today).find(isDue);
    if (!first) return { plant: null };
    const [watered] = waterPlants(ctx.db, [first.id], today, today);
    return { plant: watered };
  },

  "delete_event@1": (input: { id: number }, ctx: Ctx) => {
    const res = ctx.db.prepare("DELETE FROM events WHERE id = ?").run(input.id);
    if (res.changes === 0) throw new Error(`No history entry with id ${input.id}.`);
    return { deleted: true };
  },

  "list_plants@1": (input: { location?: string; today?: string }, ctx: Ctx) => {
    const today = resolveToday(input?.today);
    const all = loadPlants(ctx.db, today);
    const locations = [...new Set(all.map((p) => p.location).filter((l): l is string => !!l))].sort((a, b) =>
      compareText(a, b),
    );
    const want = input?.location?.trim().toLowerCase();
    const plants = want ? all.filter((p) => (p.location ?? "").toLowerCase() === want) : all;
    return { today, plants, locations, due_count: plants.filter(isDue).length };
  },

  "get_plant@1": (input: { id: number; today?: string }, ctx: Ctx) => {
    const today = resolveToday(input.today);
    const plant = loadPlant(ctx.db, input.id, today);
    const events = ctx.db
      .prepare("SELECT * FROM events WHERE plant_id = ? ORDER BY date DESC, id DESC")
      .all(input.id) as EventRow[];
    return { ...plant, today, events };
  },

  "identify_plant@1": async (input: { image: string; media_type: MediaType }, ctx: Ctx) => {
    const model = ctx.model;
    if (!model) throw new Error("The plant recognizer isn't available right now.");
    const image = readImage(input.image, input.media_type);
    let reply: { text: string; json?: unknown };
    try {
      reply = await model.generate({
        system: IDENTIFY_SYSTEM,
        prompt: [
          { type: "text", text: "Identify the houseplant in this photo and suggest care defaults." },
          { type: "image", data: image, mediaType: input.media_type },
        ],
        schema: IDENTIFY_SCHEMA,
        maxTokens: 1200,
      });
    } catch (e) {
      const message = String((e && (e as Error).message) || e || "").toLowerCase();
      if (/busy|overload|overloaded|heavy load|high load|capacity|throttl|rate.?limit|too many|timeout|timed out|unavailable/.test(message)) {
        throw new Error("The plant recognizer is busy right now. Try again in a moment.");
      }
      if (/budget|quota|credit|spend/.test(message)) {
        throw new Error("The plant recognizer isn't available right now (the model budget is used up). Try again later.");
      }
      if (/cut off|too long/.test(message)) {
        throw new Error("The plant recognizer's answer was cut off. Try again in a moment.");
      }
      if (/image|media|decode|encode|format|unsupported/.test(message)) {
        throw new Error("That image couldn't be read. Try a JPEG, PNG or WebP photo.");
      }
      throw new Error("Couldn't identify the plant right now. Try again in a moment.");
    }
    if (!reply || !reply.json || typeof reply.json !== "object") {
      throw new Error("The plant recognizer didn't return an answer. Try again.");
    }
    return normalizeIdentification(reply.json);
  },

  "widget_due@1": (input: { today?: string }, ctx: Ctx) => {
    const today = resolveToday(input?.today);
    return widgetViews(loadPlants(ctx.db, today));
  },
};
