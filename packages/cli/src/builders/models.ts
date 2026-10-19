// SPDX-License-Identifier: AGPL-3.0-or-later
// The models each agent's CLI offers, for Settings › AI and the intake's +. Read from the CLI where it
// can say (Codex's catalog); Claude Code has no list, so its families stand in (they follow the newest).
import { execFile } from "node:child_process";
import type { ModelCatalog, ModelChoice } from "@hewntools/host-workerd/surface/host.ts";

/** Claude Code's `--effort` levels. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Claude Code: Default, and the families `--model` takes as an alias for the newest of each. A full
 * name ("claude-fable-5-1") is accepted too (`other`) and pins that model.
 */
export function claudeCatalog(): ModelCatalog {
  const family = (id: string, label: string, description: string): ModelChoice => ({ id, label, kind: "family", description, efforts: CLAUDE_EFFORTS });
  return {
    agent: "claude",
    models: [
      { id: "default", label: "Default", kind: "default", description: "Claude Code's own choice", efforts: CLAUDE_EFFORTS },
      family("fable", "Fable", "The newest Fable"),
      family("opus", "Opus", "The newest Opus"),
      family("sonnet", "Sonnet", "The newest Sonnet"),
      family("haiku", "Haiku", "The newest Haiku"),
    ],
    other: true,
  };
}

const CODEX_EFFORTS = ["low", "medium", "high"];

/**
 * Codex's own catalog (`codex debug models`, JSON): the models it lists, in its order, each with the
 * efforts it takes and its successor if it names one. Every Codex model name is versioned, so each
 * is pinned. Unreadable (an older Codex): Default only, and any name may be typed.
 */
export function codexCatalogFrom(raw: string): ModelCatalog {
  const parsed = JSON.parse(raw);
  const list: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
  const models = list
    .filter((m) => m && typeof m.slug === "string" && (m.visibility === undefined || m.visibility === "list"))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m): ModelChoice => {
      const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((e: any) => (typeof e === "string" ? e : e?.effort)).filter((e: unknown) => typeof e === "string") : [];
      const upgrade = typeof m.upgrade === "string" ? m.upgrade : typeof m.upgrade?.model === "string" ? m.upgrade.model : typeof m.upgrade?.slug === "string" ? m.upgrade.slug : undefined;
      return {
        id: m.slug,
        label: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
        kind: "pinned",
        ...(typeof m.description === "string" && m.description ? { description: m.description } : {}),
        efforts,
        ...(typeof m.default_reasoning_level === "string" ? { defaultEffort: m.default_reasoning_level } : {}),
        ...(upgrade ? { upgrade } : {}),
      };
    });
  return { agent: "codex", models: [{ id: "default", label: "Default", kind: "default", description: "Codex's own choice", efforts: CODEX_EFFORTS }, ...models], other: !models.length };
}

const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile(cmd, args, { timeout: 15_000, encoding: "utf8", maxBuffer: 8 << 20 }, (e, out) => (e ? reject(e) : resolve(out))));

/** A remote builder's catalog: `GET <url>/v1/models` (see docs/internal/remote-builder.md). */
export async function remoteCatalog(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ModelCatalog> {
  const res = await fetchImpl(new URL("v1/models", url.endsWith("/") ? url : `${url}/`), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`models: HTTP ${res.status}`);
  const body = (await res.json()) as { models?: ModelChoice[] };
  const models = (body.models ?? []).filter((m) => m && typeof m.id === "string" && typeof m.label === "string").map((m) => ({ ...m, efforts: Array.isArray(m.efforts) ? m.efforts : [] }));
  return { agent: "remote", models: models.some((m) => m.id === "default") ? models : [{ id: "default", label: "Default", kind: "default", efforts: [] }, ...models] };
}

/**
 * Model catalogs, kept for 10 minutes (Settings › AI, every intake and the Inbox ask). A failed read
 * gives Default only, and is retried on the next ask.
 */
export function modelCatalogs(o: { remote?: { url: string; token: string }; codexModels?: () => Promise<string>; fetch?: typeof fetch } = {}) {
  const cache = new Map<string, { at: number; catalog: ModelCatalog }>();
  const read = async (agent: string): Promise<ModelCatalog> => {
    if (agent === "claude") return claudeCatalog();
    if (agent === "codex") return codexCatalogFrom(await (o.codexModels ?? (() => run("codex", ["debug", "models"])))());
    if (agent === "remote" && o.remote) return remoteCatalog(o.remote.url, o.remote.token, o.fetch);
    throw new Error(`no models for ${agent}`);
  };
  return async (agent: string): Promise<ModelCatalog> => {
    const hit = cache.get(agent);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.catalog;
    try {
      const catalog = await read(agent);
      cache.set(agent, { at: Date.now(), catalog });
      return catalog;
    } catch {
      return { agent, models: [{ id: "default", label: "Default", kind: "default", efforts: agent === "claude" ? CLAUDE_EFFORTS : [] }], other: true };
    }
  };
}

/**
 * Output meaning the CLI won't run the model it was given (retired, misspelled, or not on this
 * account): the build goes on with the default instead.
 */
export const MODEL_REJECTED = /issue with the selected model|selected model .{0,80}(not exist|access)|model[^\n]{0,60}\b(not found|does not exist|doesn't exist|is not available|isn't available|not supported|is not supported)|unknown model|invalid model|not_found_error[^\n]*model/i;
