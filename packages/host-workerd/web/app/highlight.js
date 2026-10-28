// SPDX-License-Identifier: AGPL-3.0-or-later
// Syntax highlighting for the code browser: a small tokenizer per language a tool is made of
// (TypeScript and JavaScript, JSON, SQL, CSS, HTML, Markdown), line by line, carrying what spans
// lines (a block comment, a template string) to the next; a / is a regex or a division by what
// comes before it. Text only: no HTML is parsed.
import { h } from "../kit.js";

export { highlighter };

const JS_KEYWORDS = new Set(
  "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield".split(" "),
);
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const SQL_KEYWORDS = new Set(
  "add alter and as asc autoincrement begin between by case cascade check collate column commit constraint create default delete desc distinct drop else end exists foreign from group having if in index inner insert integer into is join key left like limit not null numeric offset on or order primary real references rename replace returning select set table text then transaction trigger union unique update using values view when where blob without rowid".split(" "),
);

/** The language of a file, from its name. */
const langOf = (path) => {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return { ts: "js", tsx: "js", js: "js", mjs: "js", cjs: "js", jsx: "js", json: "json", sql: "sql", css: "css", html: "html", htm: "html", svg: "html", md: "md" }[ext] ?? null;
};

const NUMBER = /^(0x[\da-f_]+n?|\d[\d_]*(\.\d+)?(e[+-]?\d+)?n?|\.\d+)/i;
const WORD = /^[A-Za-z_$][\w$]*/;
/** After these (or at a line's start) an expression may start, so a / opens a regex, not a division. */
const BEFORE_REGEX = new Set([..."(,=:[!&|?{};+-*%~^", "=>", ..."return typeof case do else in instanceof new delete void throw yield await of".split(" ")]);

/** A regex literal from the / at `i`: up to its closing / (not one escaped or in a [class]), then its flags; else 0. */
function regexEnd(line, i) {
  let inClass = false;
  for (let j = i + 1; j < line.length; j++) {
    const c = line[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1 + /^[a-z]*/.exec(line.slice(j + 1))[0].length;
  }
  return 0;
}

/** Up to the closing `quote` (or the end of the line); escapes skipped. */
function quoted(line, i, quote) {
  let j = i + 1;
  while (j < line.length && line[j] !== quote) j += line[j] === "\\" ? 2 : 1;
  return Math.min(j + 1, line.length);
}

/**
 * One line as [class, text] tokens (class null for plain), and the state the next line starts in.
 * `state`: null, "comment" (inside /* … *\/ or <!-- … -->) or "template" (inside a `…` string).
 */
function tokenize(line, lang, state) {
  const out = [];
  const push = (cls, text) => text && (out.length && out.at(-1)[0] === cls ? (out.at(-1)[1] += text) : out.push([cls, text]));
  let i = 0;
  // JavaScript: the last token that wasn't space or a comment (null at the line's start), for what a / is.
  let prev = null;
  const closeOf = lang === "html" ? "-->" : "*/";
  if (state === "comment") {
    const end = line.indexOf(closeOf);
    if (end < 0) return { tokens: [["com", line]], state };
    push("com", line.slice(0, end + closeOf.length));
    i = end + closeOf.length;
    state = null;
  } else if (state === "template") {
    let j = 0;
    while (j < line.length && line[j] !== "`") j += line[j] === "\\" ? 2 : 1;
    if (j >= line.length) return { tokens: [["str", line]], state };
    push("str", line.slice(0, j + 1));
    i = j + 1;
    state = null;
    prev = "`";
  }
  if (lang === "md") {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return { tokens: [["kw", line]], state: null };
    while (i < line.length) {
      if (line[i] === "`") {
        const j = line.indexOf("`", i + 1);
        const end = j < 0 ? line.length : j + 1;
        push("str", line.slice(i, end));
        i = end;
      } else push(null, line[i++]);
    }
    return { tokens: out, state: null };
  }
  let tag = false;
  while (i < line.length) {
    const rest = line.slice(i);
    const c = line[i];
    if (lang === "html") {
      if (rest.startsWith("<!--")) {
        const end = rest.indexOf("-->");
        if (end < 0) return push("com", rest), { tokens: out, state: "comment" };
        push("com", rest.slice(0, end + 3));
        i += end + 3;
        continue;
      }
      const open = /^<\/?[A-Za-z][\w:-]*/.exec(rest);
      if (open) {
        push("tag", open[0]);
        i += open[0].length;
        tag = true;
        continue;
      }
      if (tag && /^\/?>/.test(rest)) {
        const m = /^\/?>/.exec(rest)[0];
        push("tag", m);
        i += m.length;
        tag = false;
        continue;
      }
      if (tag && (c === '"' || c === "'")) {
        const end = quoted(line, i, c);
        push("str", line.slice(i, end));
        i = end;
        continue;
      }
      const attr = tag && /^[A-Za-z_:][\w:.-]*/.exec(rest);
      if (attr) {
        push("attr", attr[0]);
        i += attr[0].length;
        continue;
      }
      push(null, c);
      i++;
      continue;
    }
    if ((lang === "js" || lang === "css") && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end < 0) return push("com", rest), { tokens: out, state: "comment" };
      push("com", rest.slice(0, end + 2));
      i += end + 2;
      continue;
    }
    if ((lang === "js" && rest.startsWith("//")) || (lang === "sql" && rest.startsWith("--"))) {
      push("com", rest);
      break;
    }
    // A regex literal where an expression may start (s.replace(/\/*$/, "") opens no comment); else a division.
    const regex = lang === "js" && c === "/" && (prev === null || BEFORE_REGEX.has(prev)) && regexEnd(line, i);
    if (regex) {
      push("str", (prev = line.slice(i, regex)));
      i = regex;
      continue;
    }
    if (lang === "js" && c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== "`") j += line[j] === "\\" ? 2 : 1;
      if (j >= line.length) return push("str", rest), { tokens: out, state: "template" };
      push("str", (prev = line.slice(i, j + 1)));
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = quoted(line, i, c);
      const text = (prev = line.slice(i, end));
      // A JSON key (a string before its colon) reads as a name, not a value.
      push(lang === "json" && /^\s*:/.test(line.slice(end)) ? "prop" : "str", text);
      i = end;
      continue;
    }
    if (lang === "css" && c === "#" && /^#[\da-f]{3,8}\b/i.test(rest)) {
      const m = /^#[\da-f]{3,8}/i.exec(rest)[0];
      push("num", m);
      i += m.length;
      continue;
    }
    if (lang === "css" && c === "@") {
      const m = /^@[\w-]+/.exec(rest)?.[0] ?? "@";
      push("kw", m);
      i += m.length;
      continue;
    }
    const num = /[\d.]/.test(c) && !/[\w$]/.test(line[i - 1] ?? "") && NUMBER.exec(rest);
    if (num) {
      const unit = lang === "css" ? (/^[a-z%]+/i.exec(rest.slice(num[0].length))?.[0] ?? "") : "";
      push("num", (prev = num[0] + unit));
      i += num[0].length + unit.length;
      continue;
    }
    const word = (lang === "css" ? /^-?[A-Za-z_][\w-]*/ : WORD).exec(rest);
    if (word) {
      const w = word[0];
      const after = line.slice(i + w.length);
      // After a dot it's a member (map.get, x.type), never a keyword; after ... (spread) it may be one.
      const member = line[i - 1] === "." && line[i - 2] !== ".";
      prev = member ? `.${w}` : w;
      let cls = null;
      if (lang === "js") cls = !member && JS_KEYWORDS.has(w) ? "kw" : !member && LITERALS.has(w) ? "lit" : /^\s*\(/.test(after) ? "fn" : /^[A-Z]/.test(w) ? "type" : null;
      else if (lang === "json") cls = LITERALS.has(w) ? "lit" : null;
      else if (lang === "sql") cls = SQL_KEYWORDS.has(w.toLowerCase()) ? "kw" : LITERALS.has(w.toLowerCase()) ? "lit" : null;
      else if (lang === "css") cls = /^\s*:(?!:)/.test(after) && !/^\s*:[\w-]+\s*[,{]/.test(after) ? "prop" : null;
      push(cls, w);
      i += w.length;
      continue;
    }
    if (c.trim()) prev = c === ">" && line[i - 1] === "=" ? "=>" : c;
    push(null, c);
    i++;
  }
  return { tokens: out, state };
}

/**
 * A highlighter for one file (or one run of lines, as a diff's hunk): `line(text)` returns the
 * line's nodes, carrying state to the next call; `skip(lines)` carries it over lines not drawn.
 * `state` is where it stands (inside a block comment, a template string), so a diff's hunk can
 * start where the file above it leaves off. Plain text for a language it doesn't know.
 */
function highlighter(path) {
  const lang = langOf(path);
  let state = null;
  return {
    line(text) {
      if (!lang) return [text];
      const r = tokenize(text, lang, state);
      state = r.state;
      return r.tokens.map(([cls, t]) => (cls ? h("span", { class: `tk-${cls}` }, t) : t));
    },
    skip(lines) {
      if (lang) for (const t of lines) state = tokenize(t, lang, state).state;
    },
    get state() {
      return state;
    },
    set state(s) {
      state = s;
    },
  };
}
