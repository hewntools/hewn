// SPDX-License-Identifier: Apache-2.0
// In-memory stand-in for the idea operations, used only when the page is opened with
// ?preview=demo (sample ideas in every status, with and without optional fields, and max-length
// text), ?preview=empty (no ideas) or ?preview=error (every call fails, as when Hewn is unreachable). Mirrors the latest contract versions closely enough to
// exercise every view; it never touches real data.
import { LIVE, CLOSED, statusRank } from "./statuses.js";

const DAY = 86400000;

function sampleIdeas(now) {
  const at = (days) => new Date(now - days * DAY).toISOString();
  const longTitle = ("A very long idea title that keeps going to test wrapping and truncation in rows and dialogs ").repeat(3).slice(0, 200);
  const longPitch = ("A pitch at the maximum length, describing in great detail who it is for, why now, and how it makes money. ").repeat(5).slice(0, 500);
  const base = [
    { id: "d-active", title: "Invoice chaser for freelancers", pitch: "Polite automated reminders that get small studios paid on time.", url: "https://example.com/chaser", status: "active", rating: 5, tags: ["saas", "b2b"], notes: ["Talked to three designers; all chase invoices by hand.", "Landing page draft done."], age: 1 },
    { id: "d-validating", title: "Sauna booking for housing co-ops", pitch: "Replace the paper list on the laundry room door.", url: null, status: "validating", rating: 4, tags: ["local", "saas"], notes: ["Board meeting on Thursday."], age: 3 },
    { id: "d-exploring", title: "Trail-run route generator", pitch: null, url: "http://example.org/routes", status: "exploring", rating: 3, tags: ["running"], notes: [], age: 6 },
    { id: "d-raw", title: "Kids' weather wardrobe app", pitch: null, url: null, status: "raw", rating: null, tags: [], notes: [], age: 0.02 },
    { id: "d-long", title: longTitle, pitch: longPitch, url: "https://example.com/" + "x".repeat(480), status: "raw", rating: 2, tags: Array.from({ length: 20 }, (_, i) => `tag-${String(i + 1).padStart(2, "0")}-${"t".repeat(30)}`), notes: ["n".repeat(5000)], age: 12 },
    { id: "d-parked", title: "Newsletter about Nordic startups", pitch: "Weekly digest of funding rounds and launches.", url: null, status: "parked", rating: 2, tags: ["writing"], notes: ["On hold until autumn."], age: 40 },
    { id: "d-shipped", title: "Recipe scaler for home bakers", pitch: "Rescales a recipe to the tin or the number of guests you have.", url: "https://example.com/scaler", status: "shipped", rating: 4, tags: ["cooking"], notes: ["Launched; a few hundred weekly users."], age: 90 },
    { id: "d-killed", title: "Crypto tip jar", pitch: "Nobody wanted it.", url: null, status: "killed", rating: 1, tags: [], notes: [], age: 200 },
  ];
  return base.map((b) => ({
    id: b.id, title: b.title, pitch: b.pitch, url: b.url, status: b.status, rating: b.rating, tags: b.tags,
    created_at: at(b.age + 5), updated_at: at(b.age), status_changed_at: at(b.age),
    notes: b.notes.map((body, i) => ({ id: `${b.id}.${i + 1}`, body, created_at: at(b.age + i) })).reverse(),
  }));
}

function fail(message) {
  return { error: "INVALID_INPUT", message };
}

export function createFakeBackend(mode, now = Date.now()) {
  const ideas = mode === "demo" ? sampleIdeas(now) : [];
  let seq = 0;
  const find = (id) => ideas.find((i) => i.id === id);
  const full = (i) => ({ ...i, tags: [...i.tags], note_count: i.notes.length, notes: [...i.notes] });
  const summary = (i) => { const { notes, ...rest } = full(i); return rest; };
  const touch = (i) => { i.updated_at = new Date().toISOString(); };
  const group = (s) => (LIVE.includes(s) ? 0 : s === "parked" ? 1 : 2);

  const ops = {
    add_idea(input) {
      const t = new Date().toISOString();
      const idea = {
        id: input.id || `new-${++seq}`, title: input.title.trim(), pitch: input.pitch?.trim() || null, url: input.url?.trim() || null,
        status: input.status || "raw", rating: input.rating ?? null, tags: input.tags || [], created_at: t, updated_at: t, status_changed_at: t,
        notes: input.note ? [{ id: `n${++seq}`, body: input.note.trim(), created_at: t }] : [],
      };
      ideas.push(idea);
      return full(idea);
    },
    update_idea(input) {
      const i = find(input.id);
      if (!i) return fail("No such idea");
      for (const k of ["title", "pitch", "url", "tags", "rating"]) if (k in input) i[k] = input[k] === "" ? null : input[k];
      if (input.status && input.status !== i.status) { i.status = input.status; i.status_changed_at = new Date().toISOString(); }
      touch(i);
      return full(i);
    },
    add_note(input) {
      const i = find(input.id);
      if (!i) return fail("No such idea");
      i.notes.unshift({ id: `n${++seq}`, body: input.body.trim(), created_at: new Date().toISOString() });
      touch(i);
      return full(i);
    },
    delete_note(input) {
      const i = find(input.id);
      if (!i) return fail("No such idea");
      i.notes = i.notes.filter((n) => n.id !== input.note_id);
      return { deleted: true };
    },
    get_idea(input) {
      const i = find(input.id);
      return i ? full(i) : fail("No such idea");
    },
    delete_idea(input) {
      const ix = ideas.findIndex((i) => i.id === input.id);
      if (ix === -1) return fail("No such idea");
      ideas.splice(ix, 1);
      return { deleted: true };
    },
    list_tags() {
      const counts = new Map();
      for (const i of ideas) for (const t of i.tags) counts.set(t, (counts.get(t) || 0) + 1);
      return { tags: [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) };
    },
    list_ideas(input) {
      let rows = ideas.filter((i) => (input.status?.length ? input.status.includes(i.status) : input.include_closed || !CLOSED.includes(i.status)));
      if (input.tag) rows = rows.filter((i) => i.tags.includes(input.tag));
      if (input.min_rating) rows = rows.filter((i) => (i.rating ?? 0) >= input.min_rating);
      if (input.query) {
        const q = input.query.toLowerCase();
        rows = rows.filter((i) => [i.title, i.pitch || "", ...i.notes.map((n) => n.body)].some((s) => s.toLowerCase().includes(q)));
      }
      const byUpdated = (a, b) => b.updated_at.localeCompare(a.updated_at);
      const sort = input.sort || "rating";
      rows.sort(
        sort === "updated" ? byUpdated
        : sort === "created" ? (a, b) => b.created_at.localeCompare(a.created_at)
        : sort === "status" ? (a, b) => statusRank(a.status) - statusRank(b.status) || byUpdated(a, b)
        : (a, b) => group(a.status) - group(b.status) || (b.rating ?? 0) - (a.rating ?? 0) || byUpdated(a, b),
      );
      const offset = input.offset || 0;
      return { ideas: rows.slice(offset, offset + (input.limit || 100)).map(summary), total: rows.length };
    },
  };

  return async (operation, input = {}) => {
    await new Promise((r) => setTimeout(r, 150));
    if (mode === "error") return { error: "UNAVAILABLE", message: "Couldn't reach Hewn. Check the connection and try again." };
    const fn = ops[operation];
    if (!fn) return { error: "UNKNOWN_OPERATION", message: `Unknown: ${operation}` };
    const out = fn(structuredClone(input));
    return out && out.error ? out : { result: out };
  };
}
