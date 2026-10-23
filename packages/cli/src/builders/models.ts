// SPDX-License-Identifier: AGPL-3.0-or-later
// The models each agent's CLI offers, for Settings › AI and the model menu in the intake's chat box. Read from the CLI where it
// can say (Codex's catalog, OpenCode's list); Claude Code has no list, so its families stand in (they follow the newest).
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { ModelCatalog, ModelChoice } from "@hewntools/host-workerd/surface/host.ts";

/** Claude Code's `--effort` levels. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The "Default" entry every list starts with: the CLI (or the service) decides. */
const defaultChoice = (efforts: string[], description?: string): ModelChoice => ({ id: "default", label: "Default", kind: "default", ...(description ? { description } : {}), efforts });

/** A list with Default only, and any name may be typed: an agent whose list can't be read. */
export const defaultOnly = (agent: string): ModelCatalog => ({ agent, models: [defaultChoice(agent === "claude" ? CLAUDE_EFFORTS : [])], other: true });

/** Model lists without asking a CLI: Claude Code's families, Default only for the rest. */
export const offlineCatalog = async (agent: string): Promise<ModelCatalog> => (agent === "claude" ? claudeCatalog() : defaultOnly(agent));

/**
 * Claude Code: Default, and the families `--model` takes as an alias for the newest of each. A full
 * name ("claude-fable-5-1") is accepted too (`other`) and pins that model.
 */
export function claudeCatalog(): ModelCatalog {
  const family = (id: string, label: string, description: string): ModelChoice => ({ id, label, kind: "family", description, efforts: CLAUDE_EFFORTS });
  return {
    agent: "claude",
    models: [
      defaultChoice(CLAUDE_EFFORTS, "Claude Code's own choice"),
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
  return { agent: "codex", models: [defaultChoice(CODEX_EFFORTS, "Codex's own choice"), ...models], other: !models.length };
}

/**
 * OpenCode's list (`opencode models --verbose`: each model's `provider/id` line, then its record as
 * JSON): what its logins, its config and the free tier offer, in its order, each with the reasoning
 * levels it takes (`variants`). Every id names one model, so each is pinned; `other` always, since any
 * `provider/model` may be typed. The plain list (ids only) reads too.
 */
export function opencodeCatalogFrom(raw: string): ModelCatalog {
  const models: ModelChoice[] = [];
  const choice = (id: string, m: any = {}): ModelChoice => ({
    id,
    label: typeof m.name === "string" && m.name ? m.name : id.split("/").slice(1).join("/") || id,
    kind: "pinned",
    description: id.split("/")[0],
    efforts: m.variants && typeof m.variants === "object" ? Object.keys(m.variants) : [],
  });
  let id: string | undefined;
  let json: string[] | undefined;
  for (const line of raw.split("\n")) {
    if (json) {
      json.push(line);
      if (line === "}") {
        try {
          const m = JSON.parse(json.join("\n"));
          if (id && m?.status !== "retired") models.push(choice(id, m));
        } catch {
          // a record that isn't JSON: the id alone, when its line comes
        }
        id = undefined;
        json = undefined;
      }
      continue;
    }
    if (line === "{") {
      json = [line];
      continue;
    }
    const t = line.trim();
    if (!t || !/^[\w.-]+\/\S+$/.test(t)) continue;
    if (id) models.push(choice(id));
    id = t;
  }
  if (id) models.push(choice(id));
  return { agent: "opencode", models: [defaultChoice([], "OpenCode's own choice"), ...models], other: true };
}

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => execFile(cmd, args, { timeout: 15_000, encoding: "utf8", maxBuffer: 8 << 20, ...(env ? { env, cwd: tmpdir() } : {}) }, (e, out) => (e ? reject(e) : resolve(out))));
/** `opencode models`, in your own OpenCode (its logins and providers), with plugins and the update check off. */
const opencodeModels = () => run("opencode", ["models", "--verbose", "--pure"], { ...process.env, OPENCODE_CONFIG_CONTENT: '{"autoupdate":false}' });

/** A remote builder's catalog: `GET <url>/v1/models` (see docs/internal/remote-builder.md). */
export async function remoteCatalog(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ModelCatalog> {
  const res = await fetchImpl(new URL("v1/models", url.endsWith("/") ? url : `${url}/`), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`models: HTTP ${res.status}`);
  const body = (await res.json()) as { models?: ModelChoice[]; tiers?: Record<string, unknown> };
  const models = (body.models ?? []).filter((m) => m && typeof m.id === "string" && typeof m.label === "string").map((m) => ({ ...m, efforts: Array.isArray(m.efforts) ? m.efforts : [] }));
  // What each tier runs on for tools' model calls (hosted), as the host labels it.
  const tiers = Object.fromEntries(["light", "standard", "strong", "max"].flatMap((t) => (typeof body.tiers?.[t] === "string" ? [[t, (body.tiers[t] as string).slice(0, 60)]] : [])));
  return { agent: "remote", models: models.some((m) => m.id === "default") ? models : [defaultChoice([]), ...models], ...(Object.keys(tiers).length ? { tiers } : {}) };
}

/**
 * Model catalogs, kept for 10 minutes (Settings › AI, every intake and the Inbox ask). A failed read
 * gives Default only, and is retried on the next ask.
 */
export function modelCatalogs(o: { remote?: { url: string; token: string }; codexModels?: () => Promise<string>; opencodeModels?: () => Promise<string>; fetch?: typeof fetch } = {}) {
  const cache = new Map<string, { at: number; catalog: ModelCatalog }>();
  const read = async (agent: string): Promise<ModelCatalog> => {
    if (agent === "claude") return claudeCatalog();
    if (agent === "codex") return codexCatalogFrom(await (o.codexModels ?? (() => run("codex", ["debug", "models"])))());
    if (agent === "opencode") return opencodeCatalogFrom(await (o.opencodeModels ?? opencodeModels)());
    if (agent === "remote" && o.remote) return remoteCatalog(o.remote.url, o.remote.token, o.fetch);
    throw new Error(`no models for ${agent}`);
  };
  return async (agent: string): Promise<ModelCatalog> => {
    const hit = cache.get(agent);
    if (hit && Date.now() - hit.at < 10 * 60_000) return withFailures(hit.catalog);
    try {
      const catalog = await read(agent);
      cache.set(agent, { at: Date.now(), catalog });
      return withFailures(catalog);
    } catch {
      return withFailures(defaultOnly(agent));
    }
  };
}

/**
 * Output meaning the CLI won't run the model it was given (retired, misspelled, not on this
 * account, or gone upstream: OpenCode's free tier says "Model is unavailable" for one it still
 * lists): the build stops, saying so (never a quiet switch to the default).
 */
export const MODEL_REJECTED = /issue with the selected model|selected model .{0,80}(not exist|access)|model[^\n]{0,60}\b(not found|does not exist|doesn't exist|is not available|isn't available|is unavailable|not supported|is not supported)|unknown model|invalid model|not_found_error[^\n]*model|(Provider)?ModelNotFound|provider[^\n]{0,40}\bnot found/i;

/**
 * Why the CLI wouldn't run the model, in its own words, from what it printed: the message inside an
 * error event (JSON), a stderr line, or Hewn's own check against `opencode models`.
 */
export function modelRejectReason(text: string): string {
  let t = text.trim().replace(/^(intake failed|intake): /, "");
  if (/not in opencode models/.test(t)) return "OpenCode doesn't list it";
  if (t.startsWith("{")) {
    try {
      const e = JSON.parse(t);
      const m = [e?.error?.data?.message, e?.error?.message, e?.message, e?.result, e?.error].find((s) => typeof s === "string" && s.trim());
      if (m) t = m.trim();
    } catch {
      // not JSON after all: the text as it is
    }
  }
  return t.replace(/\.$/, "").slice(0, 200);
}

/**
 * Models that wouldn't run lately, per agent, with the CLI's reason: the lists say so for an hour,
 * since a list can't tell on its own (OpenCode's free tier changes which models it serves, and its
 * list can lag behind). A run that goes through clears the mark.
 */
const failed = new Map<string, { at: string; reason: string }>();
const FAILED_FOR_MS = 60 * 60_000;
export const noteModelFailure = (agent: string, model: string, reason: string): void => void failed.set(`${agent} ${model}`, { at: new Date().toISOString(), reason: reason.slice(0, 200) });
export const noteModelRan = (agent: string, model: string): void => void failed.delete(`${agent} ${model}`);
const withFailures = (c: ModelCatalog): ModelCatalog => ({
  ...c,
  models: c.models.map((m) => {
    const f = failed.get(`${c.agent} ${m.id}`);
    return f && Date.now() - Date.parse(f.at) < FAILED_FOR_MS ? { ...m, failed: f } : m;
  }),
});
