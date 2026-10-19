// SPDX-License-Identifier: AGPL-3.0-or-later
// The model port (ABI 2.2): capabilities ask the platform to run a model, never holding a key or
// a provider host grant. This module is the pure part: request checks, image inspection, cost
// estimates, the model catalog, and one adapter per provider that turns a generate request into
// an HTTP request and the response back into text, usage and cost. The platform owns the rest
// (grants, budget, deadline). HTTP goes through an injected `fetch`, so tests never reach out.
import { compileSchema, MODEL_PROVIDERS, type ModelProvider, type ModelRequirement, type ModelTier, schemaErrors } from "./manifest.ts";
import { PlatformError } from "./errors.ts";

// ---------- what capability code sends and gets ----------

import type { ContentPart, GenerateRequest, GenerateResult, ModelMessage } from "@hewntools/spec/model.ts";
export type { ContentPart, GenerateRequest, GenerateResult, ModelMessage };

/** Called by the runtime when capability code calls ctx.model.generate. */
export type ModelHandler = (req: GenerateRequest) => Promise<GenerateResult>;

// ---------- limits ----------

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8000;
export const MAX_IMAGES = 20;
export const DEFAULT_MAX_TOKENS = 1024;
export const MAX_MAX_TOKENS = 16_000;
/** Total text in one request (system + prompts), characters. */
export const MAX_PROMPT_CHARS = 400_000;

export interface InspectedRequest {
  system?: string;
  messages: { role: "user" | "assistant"; parts: InspectedPart[] }[];
  schema?: Record<string, unknown>;
  maxTokens: number;
  textChars: number;
  images: { width: number; height: number }[];
}
export type InspectedPart = { type: "text"; text: string } | { type: "image"; data: string; mediaType: string; width: number; height: number };

const bad = (message: string) => new PlatformError("invalid_request", `ctx.model.generate: ${message}`);

/** Check a generate request before any spend: shape, sizes, images (decoded and measured). */
export function inspectRequest(req: GenerateRequest, allowImages: boolean): InspectedRequest {
  if (!req || typeof req !== "object") throw bad("takes an object { prompt | messages, system?, schema?, maxTokens? }");
  if ((req.prompt === undefined) === (req.messages === undefined)) throw bad('give either "prompt" or "messages"');
  if (req.system !== undefined && typeof req.system !== "string") throw bad('"system" must be a string');
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_MAX_TOKENS) throw bad(`"maxTokens" must be an integer from 1 to ${MAX_MAX_TOKENS}`);
  if (req.schema !== undefined) {
    if (!req.schema || typeof req.schema !== "object" || Array.isArray(req.schema) || (req.schema as { type?: unknown }).type !== "object") throw bad('"schema" must be a JSON Schema with "type": "object"');
    try {
      compileSchema(req.schema)(null);
    } catch (e) {
      throw bad(`"schema" is not a valid JSON Schema: ${(e as Error).message}`);
    }
  }
  const raw: ModelMessage[] = req.messages ?? [{ role: "user", content: req.prompt! }];
  if (!Array.isArray(raw) || !raw.length) throw bad('"messages" must be a non-empty list');
  if (raw[0].role !== "user") throw bad("the first message must be the user's");
  const images: InspectedRequest["images"] = [];
  let textChars = req.system?.length ?? 0;
  const messages = raw.map((m, i) => {
    if (m?.role !== "user" && m?.role !== "assistant") throw bad(`messages[${i}].role must be "user" or "assistant"`);
    const parts: InspectedPart[] = [];
    const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    if (!Array.isArray(content) || !content.length) throw bad(`messages[${i}].content must be a string or a non-empty list of parts`);
    for (const p of content) {
      if (p?.type === "text" && typeof p.text === "string") {
        textChars += p.text.length;
        parts.push({ type: "text", text: p.text });
      } else if (p?.type === "image") {
        if (!allowImages) throw bad('images need "input": ["image"] in requires.model');
        if (m.role !== "user") throw bad("images go in user messages only");
        if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(p.mediaType)) throw bad(`image mediaType must be one of ${IMAGE_MEDIA_TYPES.join(", ")}`);
        if (typeof p.data !== "string" || !p.data) throw bad("image data must be a base64 string");
        if (images.length >= MAX_IMAGES) throw bad(`at most ${MAX_IMAGES} images per call`);
        let bytes: Uint8Array;
        try {
          bytes = fromBase64(p.data);
        } catch {
          throw bad("image data is not valid base64");
        }
        if (bytes.length > MAX_IMAGE_BYTES) throw bad(`an image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB (shrink it first)`);
        const size = imageSize(bytes, p.mediaType);
        if (!size) throw bad(`image data isn't a readable ${p.mediaType}`);
        if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) throw bad(`an image is ${size.width}×${size.height}; the limit is ${MAX_IMAGE_SIDE} px per side`);
        images.push(size);
        parts.push({ type: "image", data: p.data, mediaType: p.mediaType, ...size });
      } else throw bad(`messages[${i}] has a part that isn't { type: "text", text } or { type: "image", data, mediaType }`);
    }
    return { role: m.role, parts };
  });
  if (textChars > MAX_PROMPT_CHARS) throw bad(`the prompt is ${textChars} characters; the limit is ${MAX_PROMPT_CHARS}`);
  return { system: req.system, messages, schema: req.schema, maxTokens, textChars, images };
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Pixel size from an image's header (PNG, JPEG, GIF, WebP), or undefined if it can't be read. */
export function imageSize(b: Uint8Array, mediaType: string): { width: number; height: number } | undefined {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  const ok = (s?: { width: number; height: number }) => (s && s.width > 0 && s.height > 0 ? s : undefined);
  if (mediaType === "image/png") return b.length >= 24 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR" ? ok({ width: u32be(16), height: u32be(20) }) : undefined;
  if (mediaType === "image/gif") return b.length >= 10 && ascii(0, 3) === "GIF" ? ok({ width: u16le(6), height: u16le(8) }) : undefined;
  if (mediaType === "image/webp") {
    if (b.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return undefined;
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return ok({ width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff });
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok({ width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 });
    }
    if (chunk === "VP8X") return ok({ width: u24le(24) + 1, height: u24le(27) + 1 });
    return undefined;
  }
  if (mediaType === "image/jpeg") {
    if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      const len = u16be(i + 2);
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return ok({ width: u16be(i + 7), height: u16be(i + 5) });
      i += 2 + len;
    }
    return undefined;
  }
  return undefined;
}

// ---------- cost ----------

/** Prices per token, USD. */
export interface ModelPrice {
  input: number;
  output: number;
}

export interface CatalogEntry {
  /** "<provider>/<model-id>". */
  id: string;
  price?: ModelPrice;
  contextTokens?: number;
  /** What the model takes ("text", "image"). */
  input: string[];
  /** When the vendor released it (epoch s), if the list says. */
  created?: number;
}

/**
 * Upper-bound input tokens for one image. Providers scale large images down and charge roughly
 * one token per 750 px²; Anthropic's high-resolution models cap at about 4,784 per image. The
 * reservation uses this bound; the call settles to the reported usage.
 */
export function imageTokens({ width, height }: { width: number; height: number }): number {
  const longEdge = Math.max(width, height);
  const scale = longEdge > 2576 ? 2576 / longEdge : 1;
  return Math.min(Math.ceil((width * scale * (height * scale)) / 750), 4784) + 85;
}

/** Worst-case input tokens: a conservative 1 token per 3 characters, plus images. */
export const estimateInputTokens = (r: InspectedRequest) => Math.ceil(r.textChars / 3) + r.images.reduce((n, i) => n + imageTokens(i), 0) + 50 * r.messages.length;

export const costOf = (price: ModelPrice, inputTokens: number, outputTokens: number) => inputTokens * price.input + outputTokens * price.output;

// ---------- catalog (from OpenRouter's public models list) ----------

export const CATALOG_URL = "https://openrouter.ai/api/v1/models";

/**
 * Catalog entries from OpenRouter's models list. Each model is listed under `openrouter/<id>`;
 * Anthropic and OpenAI models are also listed under their own provider (Anthropic's API ids use
 * dashes where OpenRouter's use dots: anthropic/claude-sonnet-5.5 → anthropic/claude-sonnet-5-5).
 */
export function parseCatalog(body: unknown): CatalogEntry[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("the models list has no data");
  const out: CatalogEntry[] = [];
  for (const m of data as Record<string, any>[]) {
    if (typeof m?.id !== "string") continue;
    const pIn = Number(m.pricing?.prompt);
    const pOut = Number(m.pricing?.completion);
    const price = Number.isFinite(pIn) && Number.isFinite(pOut) && pIn >= 0 && pOut >= 0 ? { input: pIn, output: pOut } : undefined;
    const input = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities.filter((x: unknown) => typeof x === "string") : ["text"];
    const base = { price, input, ...(Number.isFinite(Number(m.context_length)) ? { contextTokens: Number(m.context_length) } : {}), ...(Number.isFinite(Number(m.created)) ? { created: Number(m.created) } : {}) };
    out.push({ id: `openrouter/${m.id}`, ...base });
    const [vendor, ...rest] = m.id.split("/");
    const name = rest.join("/");
    if (vendor === "anthropic" && name) out.push({ id: `anthropic/${name.replace(/\./g, "-")}`, ...base });
    if (vendor === "openai" && name) out.push({ id: `openai/${name}`, ...base });
  }
  return out;
}

export const providerOf = (model: string): ModelProvider | undefined => {
  const p = model.split("/")[0];
  return (MODEL_PROVIDERS as readonly string[]).includes(p) ? (p as ModelProvider) : undefined;
};

// ---------- the owner's model settings ----------

/** Model ids within one provider, per tier. */
export type TierModels = Partial<Record<ModelTier, string>>;

export interface ModelSettings {
  /** The one provider tiers run on. Pinned models still use their own provider. */
  provider?: ModelProvider;
  /** Each provider's own tier → model id (kept when switching, so switching back is instant). */
  tiers: Partial<Record<ModelProvider, TierModels>>;
  /** Monthly cap for all tools together, USD. */
  monthlyCapUsd: number;
  /** Optional monthly caps per capability, USD. */
  capabilityCapsUsd: Record<string, number>;
  /** Owner-set prices (per token, USD) by "<provider>/<model-id>"; they win over the catalog. */
  prices: Record<string, ModelPrice>;
}

/** A safe start: no provider, a small monthly cap the owner raises in Settings. */
export const DEFAULT_MODEL_SETTINGS: ModelSettings = { tiers: {}, monthlyCapUsd: 5, capabilityCapsUsd: {}, prices: {} };

/** Settings as stored, over the defaults. */
export function normalizeModelSettings(stored: Record<string, any> | undefined): ModelSettings {
  return { ...DEFAULT_MODEL_SETTINGS, ...(stored ?? {}), tiers: stored?.tiers ?? {} };
}

/** The model a requirement resolves to, or why it can't run. */
export function resolveModel(r: ModelRequirement, settings: ModelSettings): { model: string } | { problem: string } {
  if (r.model) return { model: r.model };
  const p = settings.provider;
  if (!p) return { problem: "no model provider is set up yet (Settings › AI › Models)" };
  const id = r.tier ? settings.tiers[p]?.[r.tier] : undefined;
  if (!id) return { problem: `no ${PROVIDER_LABEL[p]} model is set for the "${r.tier}" tier (Settings › AI › Models)` };
  return { model: `${p}/${id}` };
}

export const PROVIDER_LABEL: Record<ModelProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };

// ---------- the models a provider's key can use ----------

export interface ProviderModel {
  /** Id within the provider ("claude-haiku-5-5", "anthropic/claude-haiku-5.5" on OpenRouter). */
  id: string;
  name?: string;
  /** Epoch s. */
  created?: number;
  /** Known from the provider itself (Anthropic says); otherwise the catalog decides. */
  images?: boolean;
}

/** The request that lists (and so checks) a provider key: free, no tokens spent. */
export function listModelsCall(provider: ModelProvider, key: string, after?: string): { url: string; init: RequestInit } {
  if (provider === "anthropic") return { url: `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, init: { method: "GET", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } } };
  if (provider === "openai") return { url: "https://api.openai.com/v1/models", init: { method: "GET", headers: { authorization: `Bearer ${key}` } } };
  return { url: "https://openrouter.ai/api/v1/key", init: { method: "GET", headers: { authorization: `Bearer ${key}` } } };
}

// OpenAI's list has every model the key can reach, chat or not; these aren't for generate.
const NOT_CHAT = /(embed|whisper|tts|dall-e|gpt-image|image|audio|realtime|moderation|transcribe|search|babbage|davinci|computer-use|instruct|sora)/i;

/** Models from one page of a provider's list. `next` is the cursor for Anthropic's next page. */
export function parseModelList(provider: ModelProvider, body: any, catalog: Map<string, CatalogEntry>): { models: ProviderModel[]; next?: string } {
  if (provider === "anthropic") {
    const models = (body?.data ?? []).filter((m: any) => typeof m?.id === "string").map((m: any) => ({
      id: m.id,
      ...(typeof m.display_name === "string" ? { name: m.display_name } : {}),
      ...(Date.parse(m.created_at) ? { created: Math.floor(Date.parse(m.created_at) / 1000) } : {}),
      ...(typeof m.capabilities?.image_input?.supported === "boolean" ? { images: m.capabilities.image_input.supported } : {}),
    }));
    return { models, ...(body?.has_more && body?.last_id ? { next: body.last_id } : {}) };
  }
  if (provider === "openai") {
    return { models: (body?.data ?? []).filter((m: any) => typeof m?.id === "string" && !NOT_CHAT.test(m.id)).map((m: any) => ({ id: m.id, ...(Number.isFinite(m.created) ? { created: m.created } : {}) })) };
  }
  // OpenRouter: the key call only checks the key; its models are the public catalog.
  return { models: [...catalog.values()].filter((e) => e.id.startsWith("openrouter/")).map((e) => ({ id: e.id.slice("openrouter/".length), ...(e.created ? { created: e.created } : {}) })) };
}

// ---------- suggested tiers ----------

const FAMILIES: [ModelTier, RegExp][] = [
  ["light", /claude-haiku/],
  ["standard", /claude-sonnet/],
  ["strong", /claude-opus/],
  ["max", /claude-fable/],
];

/**
 * Suggested tier models for a provider. Anthropic (and Anthropic's models on OpenRouter): the
 * newest Haiku, Sonnet, Opus, Fable. OpenAI: by price among chat models the catalog prices
 * (light: the cheapest that takes images; max: the dearest). Price only hints at strength.
 */
export function suggestTiers(provider: ModelProvider, models: ProviderModel[], info: (id: string) => { price?: ModelPrice; images?: boolean }): { tiers: TierModels; by: "family" | "price" } {
  const dated = (id: string) => /-\d{8}$/.test(id);
  const pool = provider === "openrouter" ? models.filter((m) => m.id.startsWith("anthropic/")) : models;
  if (provider !== "openai") {
    const tiers: TierModels = {};
    for (const [tier, re] of FAMILIES) {
      const best = pool.filter((m) => re.test(m.id) && !dated(m.id) && !/:/.test(m.id)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
      if (best) tiers[tier] = best.id;
    }
    if (!tiers.max && tiers.strong) tiers.max = tiers.strong;
    if (Object.keys(tiers).length) return { tiers, by: "family" };
  }
  const priced = models
    .map((m) => ({ m, ...info(m.id) }))
    .filter((x) => x.price && x.price.output > 0 && !/:free/.test(x.m.id))
    .sort((a, b) => a.price!.output - b.price!.output);
  if (!priced.length) return { tiers: {}, by: "price" };
  const at = (f: number) => priced[Math.floor(f * (priced.length - 1))].m.id;
  return { tiers: { light: (priced.find((x) => x.images) ?? priced[0]).m.id, standard: at(0.4), strong: at(0.75), max: at(1) }, by: "price" };
}

// ---------- provider adapters ----------

export interface ProviderCall {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
}
export interface ProviderReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Cost the provider reported (OpenRouter), USD. */
  cost?: number;
}

/** Strip JSON Schema keywords providers' structured output rejects; the platform checks them on the reply. */
export function providerSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(providerSchema);
  if (!schema || typeof schema !== "object") return schema;
  const drop = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "pattern", "format", "minProperties", "maxProperties", "$schema"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) if (!drop.has(k)) out[k] = k === "properties" || k === "$defs" || k === "definitions" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, providerSchema(pv)])) : providerSchema(v);
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

const SCHEMA_HINT = "Reply with only a JSON object that matches the requested schema.";

export function buildCall(provider: ModelProvider, modelId: string, key: string, r: InspectedRequest): ProviderCall {
  if (provider === "anthropic") {
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: r.maxTokens,
      ...(r.system ? { system: r.system } : {}),
      messages: r.messages.map((m) => ({
        role: m.role,
        content: m.parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } })),
      })),
      ...(r.schema ? { output_config: { format: { type: "json_schema", schema: providerSchema(r.schema) } } } : {}),
    };
    return { url: "https://api.anthropic.com/v1/messages", init: { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) } };
  }
  // OpenAI and OpenRouter: chat completions.
  const system = [r.system, r.schema ? SCHEMA_HINT : undefined].filter(Boolean).join("\n\n");
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...r.messages.map((m) => ({
      role: m.role,
      content: m.parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } })),
    })),
  ];
  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    ...(provider === "openai" ? { max_completion_tokens: r.maxTokens } : { max_tokens: r.maxTokens, usage: { include: true } }),
    ...(r.schema ? { response_format: { type: "json_schema", json_schema: { name: "output", schema: providerSchema(r.schema), strict: false } } } : {}),
  };
  const url = provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  return { url, init: { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) } };
}

/** Provider errors as platform errors: retryable ones say so; the key never appears. */
export function providerError(provider: ModelProvider, status: number, body: string): PlatformError {
  let message = "";
  try {
    const j = JSON.parse(body);
    message = String(j?.error?.message ?? j?.message ?? "");
  } catch {
    message = body.slice(0, 200);
  }
  const retryable = status === 429 || status === 529 || status >= 500;
  const what = status === 401 || status === 403 ? "the API key was refused (Settings › AI › Models)" : status === 429 ? "rate limited" : status === 529 ? "overloaded" : `HTTP ${status}`;
  return new PlatformError("operation_failed", `model provider ${provider}: ${what}${message ? `: ${message.slice(0, 300)}` : ""}`, { model: { provider, status, retryable } });
}

export function parseReply(provider: ModelProvider, body: any): ProviderReply {
  if (provider === "anthropic") {
    if (body?.stop_reason === "refusal") throw new PlatformError("operation_failed", "the model declined this request (refusal)", { model: { provider, refusal: true } });
    const text = (body?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    return { text, inputTokens: Number(body?.usage?.input_tokens ?? 0) + Number(body?.usage?.cache_creation_input_tokens ?? 0) + Number(body?.usage?.cache_read_input_tokens ?? 0), outputTokens: Number(body?.usage?.output_tokens ?? 0) };
  }
  const choice = body?.choices?.[0];
  if (choice?.message?.refusal) throw new PlatformError("operation_failed", "the model declined this request (refusal)", { model: { provider, refusal: true } });
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? "").join("") : "";
  const cost = Number(body?.usage?.cost);
  return { text, inputTokens: Number(body?.usage?.prompt_tokens ?? 0), outputTokens: Number(body?.usage?.completion_tokens ?? 0), ...(provider === "openrouter" && Number.isFinite(cost) ? { cost } : {}) };
}

/** Parse and check a structured reply against the capability's own schema. */
export function structured(text: string, schema: Record<string, unknown>): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new PlatformError("operation_failed", "the model's reply isn't valid JSON for the requested schema");
  }
  const check = compileSchema(schema);
  if (!check(json)) throw new PlatformError("operation_failed", `the model's reply doesn't match the requested schema: ${schemaErrors(check).slice(0, 3).join("; ")}`);
  return json;
}
