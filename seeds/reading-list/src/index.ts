// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Ctx = { db: DatabaseSync };
type Status = "want" | "reading" | "finished";
type BookRow = {
  id: string;
  title: string;
  author: string | null;
  status: Status;
  pages: number | null;
  page: number;
  rating: number | null;
  finished_on: string | null;
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function book(db: DatabaseSync, bookId: string): BookRow {
  const row = db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as BookRow | undefined;
  if (!row) throw new Error(`no book with id ${bookId}`);
  return row;
}

const percent = (b: Pick<BookRow, "page" | "pages">) => (b.pages ? Math.min(100, Math.round((b.page / b.pages) * 100)) : null);

export const operations = {
  "add_book@1"(input: { title: string; author?: string; pages?: number; status?: "want" | "reading" }, { db }: Ctx) {
    const bookId = randomUUID();
    db.prepare("INSERT INTO books (id, title, author, status, pages, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      bookId,
      input.title,
      input.author ?? null,
      input.status ?? "want",
      input.pages ?? null,
      new Date().toISOString(),
    );
    return { bookId };
  },

  "set_progress@1"(input: { bookId: string; page: number }, { db }: Ctx) {
    const b = book(db, input.bookId);
    if (b.status === "finished") throw new Error(`"${b.title}" is already finished`);
    const page = b.pages ? Math.min(input.page, b.pages) : input.page;
    db.prepare("UPDATE books SET page = ?, status = 'reading' WHERE id = ?").run(page, b.id);
    return { bookId: b.id, page, percent: percent({ page, pages: b.pages }) };
  },

  "finish_book@1"(input: { bookId: string; rating?: number; date?: string }, { db }: Ctx) {
    const b = book(db, input.bookId);
    const finishedOn = input.date ?? today();
    db.prepare("UPDATE books SET status = 'finished', page = COALESCE(pages, page), rating = ?, finished_on = ? WHERE id = ?").run(
      input.rating ?? null,
      finishedOn,
      b.id,
    );
    return { bookId: b.id, finishedOn };
  },

  "list_books@1"(input: { status?: Status }, { db }: Ctx) {
    const rows = (
      input.status
        ? db.prepare("SELECT * FROM books WHERE status = ? ORDER BY added_at DESC, rowid DESC").all(input.status)
        : db.prepare("SELECT * FROM books ORDER BY added_at DESC, rowid DESC").all()
    ) as BookRow[];
    return {
      books: rows.map((r) => ({
        bookId: r.id,
        title: r.title,
        status: r.status,
        page: r.page,
        ...(r.author !== null ? { author: r.author } : {}),
        ...(r.pages !== null ? { pages: r.pages } : {}),
        ...(r.rating !== null ? { rating: r.rating } : {}),
        ...(r.finished_on !== null ? { finishedOn: r.finished_on } : {}),
      })),
    };
  },

  "remove_book@1"(input: { bookId: string }, { db }: Ctx) {
    const r = db.prepare("DELETE FROM books WHERE id = ?").run(input.bookId);
    return { removed: Number(r.changes) > 0 };
  },

  // Widgets get a read-only database: compute from what's stored, write nothing.
  "widget_nightstand@1"(_input: Record<string, never>, { db }: Ctx) {
    const reading = db.prepare("SELECT * FROM books WHERE status = 'reading' ORDER BY added_at DESC, rowid DESC").all() as BookRow[];
    const first = reading[0];
    const small =
      first && first.pages
        ? { template: "progress", value: first.page, max: first.pages, label: first.title.slice(0, 40), caption: `${percent(first)}%` }
        : { template: "stat", value: reading.length, caption: reading.length === 1 ? "book on the nightstand" : "books on the nightstand" };
    const medium = {
      template: "list",
      items: reading.slice(0, 5).map((b) => ({
        title: b.title.slice(0, 80),
        ...(b.author ? { detail: b.author.slice(0, 80) } : {}),
        ...(percent(b) !== null ? { value: `${percent(b)}%` } : {}),
      })),
      empty: "Nothing on the nightstand",
    };
    return { small, medium };
  },
};
