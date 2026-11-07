// SPDX-License-Identifier: AGPL-3.0-or-later
// What can be counted without judging: how much UI there is and what it's made of, and what the builder spent.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export interface UiMetrics {
  files: number;
  /** HTML, JS and CSS the builder wrote, without the icon. */
  bytes: number;
  /** The tool's own CSS: <style> blocks, style= attributes and .css files. */
  cssBytes: number;
  /** Places that draw SVG (inline <svg> or createElementNS): custom visuals and icons. */
  svgSites: number;
  canvas: number;
  /** Uses of the platform's charts. */
  platformCharts: number;
  /** Transitions, keyframes and Web Animations. */
  motion: number;
  reducedMotion: boolean;
  /** Distinct colour literals (hex, rgb, hsl, oklch…) in the tool's own code. */
  colours: number;
  /** Font stacks the tool sets itself (not the platform's tokens). */
  fonts: string[];
}

const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)])) : []);

export function uiMetrics(uiDir: string): UiMetrics {
  const files = walk(uiDir).filter((f) => !f.endsWith("/icon.svg"));
  const text = files.filter((f) => [".html", ".js", ".mjs", ".css", ".svg"].includes(extname(f))).map((f) => readFileSync(f, "utf8"));
  const all = text.join("\n");
  const count = (re: RegExp) => all.match(re)?.length ?? 0;
  const css =
    [...all.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].reduce((n, m) => n + m[1].length, 0) +
    [...all.matchAll(/\sstyle="([^"]*)"/g)].reduce((n, m) => n + m[1].length, 0) +
    files.filter((f) => f.endsWith(".css")).reduce((n, f) => n + statSync(f).size, 0);
  const colours = new Set((all.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\([^)]*\)/g) ?? []).map((c) => c.toLowerCase().replace(/\s+/g, "")));
  // Font stacks wherever they're set: font-family, the font shorthand, or a custom property (--display: ui-serif, …).
  const GENERIC = /\b(serif|sans-serif|monospace|ui-serif|ui-sans-serif|ui-rounded|ui-monospace|system-ui|cursive|fantasy)\b/;
  const fonts = [
    ...new Set(
      [...all.matchAll(/(?:font-family|font|--[\w-]+)\s*:\s*([^;}{]+)/g)]
        .map((m) => m[1].replace(/\s+/g, " ").trim())
        .filter((f) => GENERIC.test(f.replace(/var\([^)]*\)/g, "")) && f.length < 200),
    ),
  ];
  return {
    files: files.length,
    bytes: text.reduce((n, t) => n + t.length, 0),
    cssBytes: css,
    svgSites: count(/<svg\b|createElementNS\(/g),
    canvas: count(/getContext\(/g),
    platformCharts: count(/\b(?:barChart|lineChart)\(/g),
    motion: count(/@keyframes|transition\s*:|\.animate\(/g),
    reducedMotion: /prefers-reduced-motion/.test(all),
    colours: colours.size,
    fonts,
  };
}

export interface BuilderUsage {
  attempts: number;
  model?: string;
  minutes: number;
  turns: number;
  usd: number;
  outputTokens: number;
  thinkingTokens: number;
}

/**
 * Sum what the builder's runs reported (Claude Code's result events in each attempt's .jsonl). Each
 * run counts once: an attempt's copy of a build's transcript holds the attempts before it too (the
 * builder appends to one file per build). Time, turns and tokens are per run; the cost of a resumed
 * session (a later attempt, Hewn's own passes) is the session's so far, so a session counts its last.
 */
export function builderUsage(jsonlFiles: string[]): BuilderUsage {
  const u: BuilderUsage = { attempts: jsonlFiles.length, minutes: 0, turns: 0, usd: 0, outputTokens: 0, thinkingTokens: 0 };
  const seen = new Set<string>();
  const sessions = new Map<string, number>();
  for (const f of jsonlFiles) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") u.model = e.model;
      if (e.type === "result") {
        const key = typeof e.uuid === "string" ? e.uuid : line;
        if (seen.has(key)) continue;
        seen.add(key);
        u.minutes += (e.duration_ms ?? 0) / 60_000;
        u.turns += e.num_turns ?? 0;
        if (typeof e.session_id === "string") sessions.set(e.session_id, Math.max(sessions.get(e.session_id) ?? 0, e.total_cost_usd ?? 0));
        else u.usd += e.total_cost_usd ?? 0;
        u.outputTokens += e.usage?.output_tokens ?? 0;
        u.thinkingTokens += e.usage?.output_tokens_details?.thinking_tokens ?? 0;
      }
    }
  }
  for (const usd of sessions.values()) u.usd += usd;
  u.minutes = Math.round(u.minutes * 10) / 10;
  u.usd = Math.round(u.usd * 100) / 100;
  return u;
}
