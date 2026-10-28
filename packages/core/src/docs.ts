// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's own docs, for agents (the hewn_docs MCP tool) and the intake (answers to the owner's
// questions about Hewn): the pages split into sections by heading, and a small term search over
// them. Pure: each host hands over the pages, read through its asset lookup (`readDocs`).
import { PlatformError } from "./errors.ts";

/** The pages, as the hosts serve them (`asset("docs/…")`, `asset("spec/…")`), in reading order: the user docs, then the spec. */
export const DOC_PAGES = [
  "docs/README.md",
  "docs/quickstart.md",
  "docs/concepts.md",
  "docs/using-hewn.md",
  "docs/building-tools.md",
  "docs/agents.md",
  "docs/connections.md",
  "docs/models.md",
  "docs/data.md",
  "docs/sharing.md",
  "docs/remote-access.md",
  "docs/capabilities.md",
  "docs/threat-model.md",
  "docs/troubleshooting.md",
  "spec/README.md",
  "spec/tools.md",
  "spec/agents.md",
  "spec/capability-model.md",
  "spec/builder-brief.md",
];

/** A page's file name within `docs/` or `spec/`: the hosts serve those and nothing else there (not docs/internal/, not the spec's sources). */
export const DOC_NAME = /^[\w-]+\.md$/;

export interface DocPage {
  /** Its path in the repo, e.g. "docs/concepts.md": what links between the pages point at. */
  name: string;
  text: string;
}

/** One heading and what follows it, up to the next heading. */
export interface DocSection {
  page: string;
  /** The page's title: its first "# " heading. */
  title: string;
  heading: string;
  /** 1 for "#", 2 for "##" …; 0 for text before the first heading. */
  level: number;
  /** The heading's anchor, as links write it ("concepts.md#hewns-two-jobs"). */
  slug: string;
  /** The markdown, the heading line included. */
  text: string;
}

/** The pages a host serves (one it can't find is left out). */
export async function readDocs(asset: (path: string) => Promise<Uint8Array | undefined>): Promise<DocPage[]> {
  const pages = await Promise.all(
    DOC_PAGES.map(async (name) => {
      const data = await asset(name).catch(() => undefined);
      return data ? { name, text: new TextDecoder().decode(data) } : undefined;
    }),
  );
  return pages.filter((p): p is DocPage => !!p);
}

/** `readDocs` once, kept for the host's life; read again next time if some pages were missing (a host still starting). */
export function docsReader(asset: (path: string) => Promise<Uint8Array | undefined>): () => Promise<DocPage[]> {
  let docs: Promise<DocPage[]> | undefined;
  return () => (docs ??= readDocs(asset).then((pages) => (pages.length < DOC_PAGES.length && (docs = undefined), pages)));
}

/** A heading's anchor, as GitHub makes it: "Widgets (since 2.3)" → "widgets-since-23". */
export const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** A page cut at every heading (not inside code blocks). */
export function docSections(page: DocPage): DocSection[] {
  const lines = page.text.split("\n");
  const heads: { line: number; level: number; heading: string }[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    const h = fence === null && /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (h) heads.push({ line: i, level: h[1].length, heading: h[2] });
  });
  const title = (heads.find((h) => h.level === 1) ?? heads[0])?.heading ?? page.name;
  const starts = [{ line: 0, level: 0, heading: "" }, ...heads];
  // A heading repeated on the page gets "-1", "-2" … after its anchor, as on GitHub.
  const seen = new Map<string, number>();
  const anchor = (heading: string) => {
    const s = slug(heading);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  };
  return starts
    .map((h, i) => ({ page: page.name, title, heading: h.heading || title, level: h.level, slug: anchor(h.heading), text: lines.slice(h.line, starts[i + 1]?.line ?? lines.length).join("\n").trim() }))
    .filter((s, i) => i > 0 || s.text);
}

/** A page by its name, forgiving: "concepts", "../spec/tools.md", "agents.md" (the user docs' page first). */
export function findPage(pages: DocPage[], name: string): DocPage | undefined {
  let n = name.trim().toLowerCase().replace(/^(\.{1,2}\/)+/, "").replace(/^\/+/, "");
  if (!n.endsWith(".md")) n += ".md";
  const exact = pages.find((p) => p.name.toLowerCase() === n) ?? pages.find((p) => p.name.toLowerCase() === `docs/${n}`);
  if (exact) return exact;
  const base = n.split("/").pop();
  const same = pages.filter((p) => p.name.toLowerCase().split("/").pop() === base);
  return same.length === 1 ? same[0] : undefined;
}

/** One section of a page with the sections under it, by its anchor or heading text (its anchor, the text, and the anchors in it); undefined if it has none such. */
export function sectionText(page: DocPage, heading: string): { slug: string; text: string; slugs: Set<string> } | undefined {
  const all = docSections(page);
  const want = slug(heading);
  let i = all.findIndex((s) => s.level > 0 && s.slug === want);
  if (i < 0 && want) i = all.findIndex((s) => s.level > 0 && s.slug.includes(want));
  if (i < 0) return undefined;
  let end = i + 1;
  while (end < all.length && all[end].level > all[i].level) end++;
  return {
    slug: all[i].slug,
    text: all
      .slice(i, end)
      .map((s) => s.text)
      .join("\n\n"),
    slugs: new Set(all.slice(i, end).map((s) => s.slug)),
  };
}

// The search: terms weighted by how rare they are across sections, a heading's terms above the body's.
const STOP = new Set(
  "a an and any are as at be but by can could did do does doing for from had has have how i if in into is it its me my no not of on or our should so some than that the their them then there these they this those to too us was we were what when where which who why will with would you your hewn md work".split(" "),
);
const stem = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
/** The words that count: lower case, without link targets, stop words or plurals. */
const words = (text: string) =>
  text
    .replace(/\]\([^)]*\)/g, "]")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);

interface Indexed {
  section: DocSection;
  heading: Set<string>;
  title: Set<string>;
  body: Map<string, number>;
}
const indexes = new WeakMap<DocPage[], Indexed[]>();
function index(pages: DocPage[]): Indexed[] {
  let idx = indexes.get(pages);
  if (idx) return idx;
  idx = pages.flatMap((p) =>
    docSections(p).map((section) => {
      const body = new Map<string, number>();
      for (const w of words(section.level ? section.text.slice(section.text.indexOf("\n") + 1) : section.text)) body.set(w, (body.get(w) ?? 0) + 1);
      return { section, heading: new Set(words(section.level ? section.heading : "")), title: new Set(words(section.title)), body };
    }),
  );
  indexes.set(pages, idx);
  return idx;
}

/** The sections that best match `query`, best first; none when no word of it (but stop words) is in the docs. */
export function searchDocs(pages: DocPage[], query: string, limit = 5): DocSection[] {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  const idx = index(pages);
  const df = new Map(terms.map((t) => [t, idx.filter((s) => s.heading.has(t) || s.body.has(t)).length]));
  return idx
    .map((s, i) => {
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const tf = s.body.get(t) ?? 0;
        const inHeading = s.heading.has(t);
        if (tf || inHeading) matched++;
        const weight = (tf ? 1 + Math.log(tf) : 0) + (inHeading ? 3 : 0) + (s.title.has(t) ? 1.5 : 0);
        if (weight) score += weight * Math.log(1 + idx.length / Math.max(1, df.get(t)!));
      }
      // More of the query's words matched beats one word matched often.
      return { section: s.section, i, score: (score * (1 + matched)) / (1 + terms.length), body: s.body.size > 0 };
    })
    .filter((x) => x.score > 0 && x.body)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.section);
}

const ref = (s: DocSection) => (s.level ? `${s.page}#${s.slug}` : s.page);
const label = (s: DocSection) => `--- ${ref(s)} (${s.level > 1 ? `${s.title} › ${s.heading}` : s.title}) ---`;

/** How many sections a prompt's excerpts take at most. */
const EXCERPT_SECTIONS = 6;

/**
 * The best sections for `query` as one text of at most `maxChars`, for a prompt: each under a line
 * naming its page and heading. Empty when nothing matches.
 */
export function docExcerpts(pages: DocPage[], query: string, maxChars: number): string {
  let out = "";
  for (const s of searchDocs(pages, query, EXCERPT_SECTIONS)) {
    // Two line breaks before it, one after its label, and "…" if it is cut.
    const room = maxChars - out.length - label(s).length - 4;
    if (room < 200) break;
    out += `${out ? "\n\n" : ""}${label(s)}\n${s.text.length > room ? `${s.text.slice(0, room)}…` : s.text}`;
  }
  return out;
}

/** The longest section a search shows whole; the rest is a page read away. */
const SECTION_CHARS = 4000;

/**
 * What `hewn_docs` answers, as text for a model: without input the pages and their sections; with
 * `query` the best sections (within `page`, or its section, if given too); with `page` that page, or
 * one section of it ("docs/concepts.md#grants").
 */
export function docsText(pages: DocPage[], input: { query?: string; page?: string }): string {
  if (!pages.length) throw new PlatformError("not_found", "Hewn's docs aren't available on this host");
  const query = input.query?.trim();
  const pageRef = input.page?.trim();
  const names = pages.map((p) => p.name).join(", ");
  let scope = pages;
  let within: Set<string> | undefined;
  if (pageRef) {
    const hash = pageRef.indexOf("#");
    const name = hash < 0 ? pageRef : pageRef.slice(0, hash);
    const page = findPage(pages, name);
    if (!page) throw new PlatformError("not_found", `No page "${name}" in Hewn's docs. The pages: ${names}.`);
    const heading = hash < 0 ? "" : pageRef.slice(hash + 1).trim();
    if (!heading) {
      if (!query) return `${page.name}\n\n${page.text.trim()}`;
      scope = [page];
    } else {
      const section = sectionText(page, heading);
      if (!section) throw new PlatformError("not_found", `No section "${heading}" in ${page.name}. Its sections: ${docSections(page).filter((s) => s.level > 1).map((s) => `#${s.slug}`).join(", ")}.`);
      if (!query) return `${page.name}#${section.slug}\n\n${section.text}`;
      scope = [page];
      within = section.slugs;
    }
  }
  if (query) {
    const hits = within ? searchDocs(scope, query, Infinity).filter((s) => within.has(s.slug)).slice(0, 5) : searchDocs(scope, query);
    if (!hits.length) return `Nothing in Hewn's docs${pageRef ? ` (${pageRef})` : ""} matches "${query}". Try other words, or read a page: ${names}.`;
    const shown = hits.map((s) => `${label(s)}\n${s.text.length > SECTION_CHARS ? `${s.text.slice(0, SECTION_CHARS)}…\n(cut here; the whole section: hewn_docs { page: "${ref(s)}" })` : s.text}`);
    return [`The sections of Hewn's docs that best match "${query}". For a whole page or section: hewn_docs { page: "<page>" } or { page: "<page>#<section>" }.`, ...shown].join("\n\n");
  }
  const list = pages.map((p) => {
    const all = docSections(p);
    const sections = all.filter((s) => s.level === 2).map((s) => s.heading);
    return `${p.name}: ${all[0]?.title ?? p.name}${sections.length ? `\n  ${sections.join(" · ")}` : ""}`;
  });
  return [
    `Hewn's docs: ${pages.length} pages, the user docs (docs/) and the tool and agent spec (spec/). Search them with hewn_docs { query: "…" }; read a page with { page: "docs/concepts.md" }, or one section with { page: "docs/concepts.md#grants" }.`,
    ...list,
  ].join("\n\n");
}
