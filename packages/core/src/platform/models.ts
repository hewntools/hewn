// SPDX-License-Identifier: AGPL-3.0-or-later
// Models: the owner's providers, tiers, budget and prices, and the model port capabilities call
// (ctx.model.generate). The pure part (provider adapters, request checks, the catalog) is ../models.ts.
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import type { Deadline } from "../deadline.ts";
import { MODEL_PROVIDERS, MODEL_TIERS, modelGrant, type ModelProvider, type ModelRequirement, type ModelTier } from "../manifest.ts";
import {
  buildCall,
  CATALOG_URL,
  type CatalogEntry,
  costOf,
  estimateInputTokens,
  type GenerateRequest,
  type HostGenerateResult,
  type HostModels,
  inspectRequest,
  type ModelHandler,
  type ModelMessage,
  type ModelPrice,
  type ModelSettings,
  listModelsCall,
  normalizeModelSettings,
  parseCatalog,
  parseModelList,
  PROVIDER_LABEL,
  type ProviderModel,
  suggestTiers,
  type TierModels,
  parseReply,
  providerError,
  providerOf,
  resolveModel,
  saneCharge,
  cutOffMessage,
  structured,
} from "../models.ts";
import { randomToken } from "../sha256.ts";
import type { BuildView } from "./builds.ts";
import { Domain } from "./context.ts";

/** Where the owner's model provider API keys live in the secret store. */
export const MODEL_KEYS = "hewn:models";

export class Models extends Domain {
  private catalogIndex?: { fetchedAt: string; byId: Map<string, CatalogEntry> };
  private providerLists = new Map<string, { raw: string | undefined; list: ReturnType<Models["providerList"]> }>();

  /** The owner's model settings (provider, tiers, caps, price overrides). */
  modelSettings_(): ModelSettings {
    return normalizeModelSettings(this.registry.getKv<Record<string, any>>("models.settings"));
  }

  /** The catalog by model id. Readiness asks often: the large list is parsed again only when a refresh replaced it. */
  private catalog(): Map<string, CatalogEntry> {
    const at = this.registry.getKv<string>("models.catalogAt");
    if (!at) return new Map();
    if (this.catalogIndex?.fetchedAt !== at) {
      const stored = this.registry.getKv<{ entries: CatalogEntry[] }>("models.catalog");
      this.catalogIndex = { fetchedAt: at, byId: new Map((stored?.entries ?? []).map((e) => [e.id, e])) };
    }
    return this.catalogIndex.byId;
  }

  /** What a provider's key last listed (and so whether it works). Parsed once per write: lists can be long (OpenRouter). */
  providerList(p: ModelProvider): { checkedAt: string; ok: boolean; error?: string; models: ProviderModel[]; byId: Map<string, ProviderModel> } | undefined {
    const raw = this.registry.getKvRaw(`models.provider.${p}`);
    const hit = this.providerLists.get(p);
    if (hit && hit.raw === raw) return hit.list;
    const v = raw ? (JSON.parse(raw) as { checkedAt: string; ok: boolean; error?: string; models: ProviderModel[] } | null) : null;
    const list = v ? { ...v, byId: new Map(v.models.map((m) => [m.id, m])) } : undefined;
    this.providerLists.set(p, { raw, list });
    return list;
  }

  private priceOf(model: string, settings = this.modelSettings_()): ModelPrice | undefined {
    return settings.prices[model] ?? this.catalog().get(model)?.price;
  }

  /** Price and image support of "<provider>/<model-id>": the provider's own word first, then the catalog. */
  private modelInfo(model: string): { price?: ModelPrice; images?: boolean } {
    const p = providerOf(model)!;
    const id = model.slice(p.length + 1);
    const own = this.providerList(p)?.byId.get(id)?.images;
    const entry = this.catalog().get(model);
    return { price: this.priceOf(model), images: own ?? (entry ? entry.input.includes("image") : undefined) };
  }

  /** Why a model requirement can't run right now, or undefined if it can. */
  modelProblem(r: ModelRequirement): string | undefined {
    // Hosted: the host runs it, or says why not when it's called.
    if (this.platform.hostModels) return undefined;
    const resolved = resolveModel(r, this.modelSettings_());
    if ("problem" in resolved) return resolved.problem;
    const provider = providerOf(resolved.model);
    if (!provider) return `${resolved.model} names no known provider (anthropic, openai, openrouter)`;
    if (!this.platform.modelFetch) return "this Hewn host can't reach model providers";
    if (this.secrets.get(MODEL_KEYS, provider) === undefined) return `no ${PROVIDER_LABEL[provider]} API key is set (Settings › AI › Models)`;
    const retired = r.model ? this.retiredModel(r.model) : undefined;
    if (retired) return `${r.model} is no longer available${retired.successor ? `; replace it with ${retired.successor}` : "; choose a replacement"} (Settings › AI › Models)`;
    const info = this.modelInfo(resolved.model);
    if (r.input?.includes("image") && info.images === false) return `${resolved.model} doesn't take images`;
    if (!info.price) return `no price is known for ${resolved.model} (the model catalog doesn't list it; set a price under Settings › AI › Models)`;
    return undefined;
  }

  /** Settings › AI › Models: what the owner sees (key presence only, never values). */
  models(owner: Agent) {
    requireOwner(owner);
    const settings = this.modelSettings_();
    const stored = this.registry.getKv<{ fetchedAt: string; error?: string }>("models.catalog");
    const active = this.registry.listActiveCapabilities().map((c) => ({ id: c.id, name: c.displayName ?? c.name, model: this.activeManifest(c.id).requires?.model }));
    const providers = MODEL_PROVIDERS.map((p) => {
      const list = this.providerList(p);
      const keySet = this.secrets.get(MODEL_KEYS, p) !== undefined;
      const models = (list?.models ?? []).map((m) => ({ ...m, ...this.modelInfo(`${p}/${m.id}`) })).sort((a, b) => (a.price?.output ?? Infinity) - (b.price?.output ?? Infinity));
      const suggested = keySet && list?.ok ? suggestTiers(p, list.models, (id) => this.modelInfo(`${p}/${id}`)) : { tiers: {}, by: "family" as const };
      return { id: p, label: PROVIDER_LABEL[p], keySet, check: list ? { ok: list.ok, at: list.checkedAt, error: list.error ?? null } : null, models, tiers: settings.tiers[p] ?? {}, suggested };
    });
    return {
      provider: settings.provider ?? null,
      tierNames: MODEL_TIERS,
      providers,
      /** Capabilities on each tier (they follow the active provider). */
      usage: Object.fromEntries(MODEL_TIERS.map((t) => [t, active.filter((c) => c.model?.tier === t).map((c) => ({ id: c.id, name: c.name }))])),
      /** Capabilities that pin one model: they use its provider whatever is active. */
      pinned: active.filter((c) => c.model?.model).map((c) => ({ id: c.id, name: c.name, model: c.model!.model!, problem: this.modelProblem(c.model!) ?? null, retired: this.retiredModel(c.model!.model!) ?? null })),
      monthlyCapUsd: settings.monthlyCapUsd,
      capabilityCapsUsd: settings.capabilityCapsUsd,
      capabilityCapsHost: settings.capabilityCapsHost,
      // Hosted: each capped tool's use this month, in the cap's unit.
      hostCapUse: this.platform.hostModels ? Object.fromEntries(Object.keys(settings.capabilityCapsHost).map((id) => [id, this.hostCapUse(id)])) : {},
      prices: settings.prices,
      catalog: { fetchedAt: stored?.fetchedAt || null, error: stored?.error ?? null },
      spend: this.modelSpend(owner),
      // Hosted: the host runs tools' model calls; what it charged this month, per unit, as given.
      host: this.platform.hostModels ? { charges: this.hostCharges(owner) } : null,
    };
  }

  /**
   * Change model settings (owner only): the active provider (it must have a key; its tiers start
   * from the suggestion), a provider's tiers (ids within that provider; null clears one), caps, prices.
   */
  setModelSettings(owner: Agent, change: { provider?: string; tiers?: Record<string, Record<string, string | null>>; monthlyCapUsd?: unknown; capabilityCapsUsd?: Record<string, unknown>; capabilityCapsHost?: Record<string, unknown>; prices?: Record<string, unknown> }) {
    requireOwner(owner);
    const next = this.modelSettings_();
    const usd = (v: unknown, what: string) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) throw new PlatformError("invalid_request", `${what} must be a number of USD from 0 to 100000`);
      return v;
    };
    const provider = (p: string) => {
      if (!(MODEL_PROVIDERS as readonly string[]).includes(p)) throw new PlatformError("invalid_request", `unknown provider ${p} (anthropic, openai, openrouter)`);
      return p as ModelProvider;
    };
    if (change.tiers !== undefined) {
      for (const [p, tiers] of Object.entries(change.tiers ?? {})) {
        const pr = provider(p);
        const cur: TierModels = { ...(next.tiers[pr] ?? {}) };
        for (const [tier, id] of Object.entries(tiers ?? {})) {
          if (!(MODEL_TIERS as readonly string[]).includes(tier)) throw new PlatformError("invalid_request", `unknown tier ${tier}`);
          if (id === null || id === "") delete cur[tier as ModelTier];
          else if (typeof id !== "string" || !/^[A-Za-z0-9._:\/-]+$/.test(id) || id.startsWith(`${pr}/`)) throw new PlatformError("invalid_request", `${tier}: expected a ${PROVIDER_LABEL[pr]} model id (without "${pr}/")`);
          else cur[tier as ModelTier] = id;
        }
        next.tiers[pr] = cur;
      }
    }
    if (change.provider !== undefined) {
      const pr = provider(change.provider);
      if (this.secrets.get(MODEL_KEYS, pr) === undefined) throw new PlatformError("invalid_request", `set the ${PROVIDER_LABEL[pr]} API key first`);
      next.provider = pr;
      if (!Object.keys(next.tiers[pr] ?? {}).length) next.tiers[pr] = this.suggestedTiers(pr);
    }
    if (change.monthlyCapUsd !== undefined) next.monthlyCapUsd = usd(change.monthlyCapUsd, "the monthly cap");
    if (change.capabilityCapsHost !== undefined)
      next.capabilityCapsHost = Object.fromEntries(
        Object.entries(change.capabilityCapsHost ?? {}).map(([id, v]) => {
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000) throw new PlatformError("invalid_request", `${id}'s cap must be a number from 0 to 1000000`);
          return [id, v];
        }),
      );
    if (change.capabilityCapsUsd !== undefined) next.capabilityCapsUsd = Object.fromEntries(Object.entries(change.capabilityCapsUsd ?? {}).map(([id, v]) => [id, usd(v, `${id}'s cap`)]));
    if (change.prices !== undefined) {
      next.prices = Object.fromEntries(
        Object.entries(change.prices ?? {}).map(([model, p]) => {
          if (!providerOf(model)) throw new PlatformError("invalid_request", `price for ${model}: expected "<provider>/<model-id>"`);
          const perM = (x: unknown) => usd(x, `${model}'s price per million tokens`) / 1_000_000;
          return [model, { input: perM((p as { input?: unknown })?.input), output: perM((p as { output?: unknown })?.output) }];
        }),
      );
    }
    this.saveModelSettings(owner, next);
    return this.models(owner);
  }

  private saveModelSettings(owner: Agent, next: ModelSettings) {
    this.registry.setKv("models.settings", next);
    const tiers = next.provider ? Object.entries(next.tiers[next.provider] ?? {}).map(([t, m]) => `${t}=${m}`).join(", ") : "";
    this.registry.addAuthorityEvent({ actor: owner.id, action: "models_set", subject: "models", detail: `${next.provider ? `${PROVIDER_LABEL[next.provider]}: ${tiers || "no tiers"}` : "no provider"}; cap $${next.monthlyCapUsd}/month` });
    this.logger(`model settings changed by ${owner.id}`);
  }

  private suggestedTiers(p: ModelProvider): TierModels {
    const list = this.providerList(p);
    return list?.ok ? suggestTiers(p, list.models, (id) => this.modelInfo(`${p}/${id}`)).tiers : {};
  }

  /**
   * Set a provider's API key (owner only; stored like secrets, never shown). The key is checked
   * with the provider's free models list first; a refused key isn't stored. With no provider
   * active yet, this one becomes active with its suggested tiers.
   */
  async setModelKey(owner: Agent, provider: string, key: string | null) {
    requireOwner(owner);
    if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) throw new PlatformError("invalid_request", `unknown provider ${provider} (anthropic, openai, openrouter)`);
    const p = provider as ModelProvider;
    if (key === null) {
      this.secrets.delete(MODEL_KEYS, p);
      this.registry.setKv(`models.provider.${p}`, null);
      const s = this.modelSettings_();
      if (s.provider === p) {
        delete s.provider;
        this.saveModelSettings(owner, s);
      }
      this.registry.addAuthorityEvent({ actor: owner.id, action: "model_key_removed", subject: p });
      this.logger(`${p} model key removed by ${owner.id}`);
      return this.models(owner);
    }
    const clean = key.trim();
    if (clean.length < 8 || clean.length > 500 || /\s/.test(clean)) throw new PlatformError("invalid_request", "that doesn't look like an API key");
    const checked = await this.listProviderModels(p, clean);
    if (!checked.ok && checked.refused) throw new PlatformError("invalid_request", `${PROVIDER_LABEL[p]} refused that key: ${checked.error}`);
    this.secrets.set(MODEL_KEYS, p, clean);
    this.registry.setKv(`models.provider.${p}`, { checkedAt: new Date().toISOString(), ok: checked.ok, ...(checked.ok ? {} : { error: checked.error }), models: checked.models });
    this.registry.addAuthorityEvent({ actor: owner.id, action: "model_key_set", subject: p });
    this.logger(`${p} model key set by ${owner.id}`);
    this.noteRetiredModels();
    const s = this.modelSettings_();
    if (!s.provider) {
      s.provider = p;
      if (!Object.keys(s.tiers[p] ?? {}).length) s.tiers[p] = this.suggestedTiers(p);
      this.saveModelSettings(owner, s);
    }
    return this.models(owner);
  }

  /**
   * A pinned model that is gone: the provider's own list (which the key can use) no longer has it,
   * or for OpenRouter, the catalog doesn't. Unknown (no list yet) is not retired. Returns the
   * suggested successor (the newest model of the same Claude family), if any.
   */
  retiredModel(model: string): { successor?: string } | undefined {
    const p = providerOf(model);
    if (!p) return undefined;
    const id = model.slice(p.length + 1);
    let ids: string[] | undefined;
    if (p === "openrouter") {
      const stored = this.registry.getKv<{ error?: string }>("models.catalog");
      if (!this.catalog().size || stored?.error) return undefined;
      ids = [...this.catalog().keys()].filter((k) => k.startsWith("openrouter/")).map((k) => k.slice("openrouter/".length));
    } else {
      const list = this.providerList(p);
      if (!list?.ok || !list.models.length) return undefined;
      ids = list.models.map((m) => m.id);
    }
    if (ids.includes(id)) return undefined;
    const family = /claude-(haiku|sonnet|opus|fable)/.exec(id)?.[0];
    const models = p === "openrouter" ? [...this.catalog().values()].filter((e) => e.id.startsWith("openrouter/")).map((e) => ({ id: e.id.slice(11), created: e.created })) : this.providerList(p)!.models;
    const successor = family ? models.filter((m) => m.id.includes(family) && !/-\d{8}$/.test(m.id) && !m.id.includes(":")).sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]?.id : undefined;
    return successor ? { successor: `${p}/${successor}` } : {};
  }

  /**
   * Change the model a capability uses (owner only): another tier, or one pinned model. A new
   * version whose manifest says so, same code, no builder; the new model grant comes with it (the
   * owner chose it). Also how a retired pinned model is replaced.
   */
  async setCapabilityModel(owner: Agent, capabilityId: string, to: { tier?: string; model?: string }): Promise<BuildView> {
    requireOwner(owner);
    this.d.builds.noChangeOnItsWay(capabilityId, "change its model");
    const cur = this.activeManifest(capabilityId).requires?.model;
    if (!cur) throw new PlatformError("invalid_request", `${capabilityId} doesn't use a model (that takes a change by the builder)`);
    if ((to.tier === undefined) === (to.model === undefined)) throw new PlatformError("invalid_request", 'give either "tier" or "model"');
    let next: ModelRequirement;
    if (to.tier !== undefined) {
      if (!(MODEL_TIERS as readonly string[]).includes(to.tier)) throw new PlatformError("invalid_request", `unknown tier ${to.tier} (${MODEL_TIERS.join(", ")})`);
      next = { tier: to.tier as ModelTier, ...(cur.input ? { input: cur.input } : {}) };
    } else {
      const model = to.model!;
      const p = providerOf(model);
      if (!p || !/^[a-z]+\/[A-Za-z0-9._:\/-]+$/.test(model)) throw new PlatformError("invalid_request", `expected "<provider>/<model-id>" (anthropic, openai or openrouter), not ${model}`);
      const list = p === "openrouter" ? undefined : this.providerList(p);
      if (list?.ok && !list.byId.has(model.slice(p.length + 1))) throw new PlatformError("invalid_request", `${PROVIDER_LABEL[p]} doesn't list ${model} for your key`);
      next = { model, ...(cur.input ? { input: cur.input } : {}) };
    }
    if (modelGrant(next) === modelGrant(cur)) throw new PlatformError("invalid_request", `${capabilityId} already uses ${next.tier ? `the ${next.tier} tier` : next.model}`);
    const grant = modelGrant(next);
    this.registry.approveGrant(capabilityId, "model", grant.slice("model:".length), owner.id);
    this.registry.addGrantEvent(capabilityId, "approve", grant, owner.id);
    const what = next.tier ? `the ${next.tier} tier` : next.model;
    return this.d.builds.manifestOnlyModify(owner, capabilityId, (m) => (m.requires!.model = next), `use ${what} instead of ${cur.tier ? `the ${cur.tier} tier` : cur.model}`);
  }

  /** A retired (or any) pinned model replaced by another pinned model. */
  replacePinnedModel(owner: Agent, capabilityId: string, model: string): Promise<BuildView> {
    if (!this.activeManifest(capabilityId).requires?.model?.model) throw new PlatformError("invalid_request", `${capabilityId} doesn't pin a model`);
    return this.setCapabilityModel(owner, capabilityId, { model });
  }

  /** Once per retired pinned model: an authority event, so Activity says why a capability stopped. */
  private noteRetiredModels() {
    for (const c of this.registry.listActiveCapabilities()) {
      const pinned = this.activeManifest(c.id).requires?.model?.model;
      const r = pinned ? this.retiredModel(pinned) : undefined;
      const flag = `models.retiredNoted.${c.id}.${pinned}`;
      if (!r || this.registry.getKv<boolean>(flag)) continue;
      this.registry.setKv(flag, true);
      this.registry.addAuthorityEvent({ actor: "platform", action: "model_retired", subject: pinned!, capabilityId: c.id, detail: r.successor ? `suggested: ${r.successor}` : "" });
      this.logger(`${c.id}: pinned model ${pinned} is no longer available${r.successor ? ` (suggested: ${r.successor})` : ""}`);
    }
  }

  /** Check a provider's stored key again (and refresh what it can use). */
  async checkModelProvider(owner: Agent, provider: string) {
    requireOwner(owner);
    const p = provider as ModelProvider;
    const key = this.secrets.get(MODEL_KEYS, p);
    if (key === undefined) throw new PlatformError("invalid_request", `no ${PROVIDER_LABEL[p] ?? provider} key is set`);
    const checked = await this.listProviderModels(p, key);
    const prev = this.providerList(p);
    this.registry.setKv(`models.provider.${p}`, { checkedAt: new Date().toISOString(), ok: checked.ok, ...(checked.ok ? {} : { error: checked.error }), models: checked.ok ? checked.models : (prev?.models ?? []) });
    this.noteRetiredModels();
    return this.models(owner);
  }

  /** List the models a key can use (this is also the key check). Never throws for network or provider trouble. */
  private async listProviderModels(p: ModelProvider, key: string): Promise<{ ok: true; models: ProviderModel[] } | { ok: false; refused: boolean; error: string; models: ProviderModel[] }> {
    if (!this.platform.modelFetch) return { ok: false, refused: false, error: "this Hewn host can't reach model providers", models: [] };
    if (p === "openrouter" && !this.catalog().size) await this.refreshModelCatalog();
    const models: ProviderModel[] = [];
    let after: string | undefined;
    try {
      for (let page = 0; page < 20; page++) {
        const call = listModelsCall(p, key, after);
        const res = await this.platform.modelFetch(call.url, { ...call.init, signal: AbortSignal.timeout(15_000) });
        const body = await res.text();
        if (!res.ok) {
          const err = providerError(p, res.status, body);
          return { ok: false, refused: res.status === 401 || res.status === 403, error: err.message.replace(/^model provider \w+: /, ""), models: [] };
        }
        const parsed = parseModelList(p, JSON.parse(body), this.catalog());
        models.push(...parsed.models);
        if (!parsed.next) break;
        after = parsed.next;
      }
      return { ok: true, models };
    } catch (e) {
      return { ok: false, refused: false, error: `couldn't reach ${PROVIDER_LABEL[p]}: ${(e as Error).message}`, models: [] };
    }
  }

  /** Refresh the model catalog (prices, context, input kinds) from OpenRouter's public list. A failure keeps the last good copy. */
  async refreshModelCatalog(): Promise<{ models: number } | { error: string }> {
    if (!this.platform.modelFetch) return { error: "no network for models on this host" };
    const stored = this.registry.getKv<{ fetchedAt: string; entries: CatalogEntry[]; error?: string }>("models.catalog");
    try {
      const res = await this.platform.modelFetch(CATALOG_URL, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entries = parseCatalog(await res.json());
      if (!entries.length) throw new Error("the list was empty");
      const fetchedAt = new Date().toISOString();
      this.registry.setKv("models.catalog", { fetchedAt, entries });
      this.registry.setKv("models.catalogAt", fetchedAt);
      this.noteRetiredModels();
      this.events.emit("changed");
      return { models: entries.length };
    } catch (e) {
      const error = `model catalog refresh failed: ${(e as Error).message}`;
      this.registry.setKv("models.catalog", { fetchedAt: stored?.fetchedAt ?? "", entries: stored?.entries ?? [], error });
      this.logger(error);
      return { error };
    }
  }

  /** What the host charged this month (builds, the intake, model calls), per unit: amounts as given, summed as decimals. */
  hostCharges(owner: Agent, month = new Date().toISOString().slice(0, 7)) {
    requireOwner(owner);
    const rows = this.registry.hostCharges(month);
    const units = [...new Set(rows.map((r) => r.unit))];
    return { month, totals: units.map((unit) => ({ unit, amount: Math.round(rows.filter((r) => r.unit === unit).reduce((n, r) => n + r.amount, 0) * 100) / 100 })), rows, byCapability: this.registry.hostChargesByCapability(month) };
  }

  /**
   * What a tool's model calls were charged this month, against its hosted cap: in the unit its latest
   * charge used (a cap has no unit of its own; a host keeps one), rounded to the hundredth.
   */
  hostCapUse(capabilityId: string, month = new Date().toISOString().slice(0, 7)): { spent: number; unit: string } {
    const used = this.registry.hostChargesByCapability(month).filter((x) => x.capabilityId === capabilityId);
    const unit = this.registry.latestHostChargeUnit(capabilityId) ?? used[0]?.unit ?? "Credits";
    return { spent: Math.round(used.filter((x) => x.unit === unit).reduce((n, x) => n + x.amount, 0) * 100) / 100, unit };
  }

  /** Record a charge the host made for something Hewn didn't run itself (an intake turn). */
  recordHostCharge(owner: Agent, kind: "intake", c: unknown) {
    requireOwner(owner);
    if (saneCharge(c)) this.registry.addHostCharge(kind, c);
  }

  /** This month's model spend (owner only). */
  modelSpend(owner: Agent, month = new Date().toISOString().slice(0, 7)) {
    requireOwner(owner);
    const rows = this.registry.modelSpend(month);
    return { month, totalUsd: rows.reduce((n, r) => n + r.costUsd, 0), capUsd: this.modelSettings_().monthlyCapUsd, rows };
  }

  /** ctx.model.generate for one call chain: checks, reserves budget, calls the provider, settles. */
  modelHandler(capabilityId: string, requirement: ModelRequirement, deadline: Deadline, caller: string): ModelHandler {
    if (this.platform.hostModels) return this.hostModelHandler(this.platform.hostModels, capabilityId, requirement, deadline, caller);
    return async (raw: GenerateRequest) => {
      const problem = this.modelProblem(requirement);
      if (problem) throw new PlatformError("not_ready", `${capabilityId} can't use a model: ${problem}`);
      const r = inspectRequest(raw, requirement.input?.includes("image") ?? false);
      const settings = this.modelSettings_();
      const model = (resolveModel(requirement, settings) as { model: string }).model;
      const provider = providerOf(model)!;
      const price = this.priceOf(model)!;
      const key = this.secrets.get(MODEL_KEYS, provider)!;
      const budgetMs = deadline.modelBudget();
      if (budgetMs < 1000) throw new PlatformError("operation_failed", "no time left in this call chain for a model call (an async operation suits long work)");

      const month = new Date().toISOString().slice(0, 7);
      const reserve = costOf(price, estimateInputTokens(r), r.maxTokens);
      const id = `m-${randomToken().slice(0, 16)}`;
      const caps = { total: settings.monthlyCapUsd, capability: settings.capabilityCapsUsd[capabilityId] };
      const held = this.registry.reserveModelSpend({ id, capabilityId, model, month, usd: reserve, caller }, caps);
      if (!held.ok) {
        throw new PlatformError(
          "operation_failed",
          `model budget: this call could cost up to $${reserve.toFixed(4)}, and ${held.scope === "all" ? `all tools together have spent $${held.spent.toFixed(2)} of the $${held.cap.toFixed(2)} monthly budget` : `${capabilityId} has spent $${held.spent.toFixed(2)} of its $${held.cap.toFixed(2)} this month`} (raise it under Settings › AI › Models)`,
          { model: { budget: true } },
        );
      }
      const modelId = model.slice(provider.length + 1);
      const call = buildCall(provider, modelId, key, r);
      let reply: ReturnType<typeof parseReply> | undefined;
      deadline.beginWait();
      try {
        for (let attempt = 0; ; attempt++) {
          const res = await this.platform.modelFetch!(call.url, { ...call.init, signal: AbortSignal.timeout(Math.max(1000, deadline.modelBudget())) });
          const body = await res.text();
          if (res.ok) {
            reply = parseReply(provider, JSON.parse(body));
            break;
          }
          const err = providerError(provider, res.status, body);
          const retryable = (err.details as { model: { retryable: boolean } }).model.retryable;
          if (!retryable || attempt >= 1 || deadline.modelBudget() < 5000) throw err;
          await new Promise((ok) => setTimeout(ok, 1000));
        }
      } catch (e) {
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        const err = e instanceof PlatformError ? e : new PlatformError("operation_failed", timedOut ? `model provider ${provider}: no reply in time` : `model provider ${provider}: ${(e as Error).message}`);
        // A failed request isn't billed by the providers; nothing is spent.
        this.registry.settleModelSpend(id, { costUsd: 0, inputTokens: 0, outputTokens: 0, error: err.message.slice(0, 300) });
        throw err;
      } finally {
        deadline.endWait();
      }
      const cost = reply.cost ?? costOf(price, reply.inputTokens, reply.outputTokens);
      // Billed all the same; half a reply is no reply.
      this.registry.settleModelSpend(id, { costUsd: cost, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, ...(reply.cutOff ? { error: cutOffMessage(r.maxTokens) } : {}) });
      this.warnNearCap(capabilityId, month, settings);
      if (reply.cutOff) throw new PlatformError("operation_failed", cutOffMessage(r.maxTokens), { model: { stop: "max_tokens" } });
      const json = r.schema ? structured(reply.text, r.schema) : undefined;
      return { text: reply.text, ...(json !== undefined ? { json } : {}), usage: { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens }, cost, model };
    };
  }

  /**
   * Hosted: ctx.model.generate goes to the host. The request is checked here as for a provider; the
   * host picks the model and charges in its own unit. The call is logged (Activity) at $0.
   */
  private hostModelHandler(host: HostModels, capabilityId: string, requirement: ModelRequirement, deadline: Deadline, caller: string): ModelHandler {
    return async (raw: GenerateRequest) => {
      const r = inspectRequest(raw, requirement.input?.includes("image") ?? false);
      if (deadline.modelBudget() < 1000) throw new PlatformError("operation_failed", "no time left in this call chain for a model call (an async operation suits long work)");
      // The tool's own cap, in the host's unit: checked before the call (a call's charge is known only
      // after, so calls running at once may each pass it; the month's total is the host's to enforce).
      const cap = this.modelSettings_().capabilityCapsHost[capabilityId];
      if (cap !== undefined) {
        const { spent, unit } = this.hostCapUse(capabilityId);
        if (spent >= cap) throw new PlatformError("operation_failed", `model budget: ${capabilityId} has used ${spent} of its ${cap} ${unit} this month (raise it in the tool's model settings)`, { model: { budget: true } });
      }
      const id = `m-${randomToken().slice(0, 16)}`;
      const asked = requirement.model ?? `tier:${requirement.tier ?? "standard"}`;
      this.registry.reserveModelSpend({ id, capabilityId, model: asked, month: new Date().toISOString().slice(0, 7), usd: 0, caller }, { total: Infinity });
      const recordCharge = (c: unknown) => saneCharge(c) && this.registry.addHostCharge("model", c, capabilityId);
      const messages: ModelMessage[] = raw.messages ?? [{ role: "user", content: raw.prompt! }];
      let reply: HostGenerateResult;
      deadline.beginWait();
      try {
        reply = await host(
          { capabilityId, ...(requirement.model ? { model: requirement.model } : { tier: requirement.tier ?? "standard" }), ...(raw.system !== undefined ? { system: raw.system } : {}), messages, ...(r.schema ? { schema: r.schema } : {}), maxTokens: r.maxTokens },
          AbortSignal.timeout(Math.max(1000, deadline.modelBudget())),
        );
      } catch (e) {
        recordCharge((e as { charge?: unknown }).charge);
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        const cutOff = (e as { stop?: string }).stop === "max_tokens";
        // A refusal, or a reply cut off at the tool's limit, is worded for the owner: kept as is.
        const message = timedOut ? "the model: no reply in time" : cutOff ? cutOffMessage(r.maxTokens) : (e as { refused?: boolean }).refused ? (e as Error).message : `the model: ${(e as Error).message}`;
        this.registry.settleModelSpend(id, { costUsd: 0, inputTokens: 0, outputTokens: 0, error: message.slice(0, 300) });
        throw new PlatformError("operation_failed", message, cutOff ? { model: { stop: "max_tokens" } } : undefined);
      } finally {
        deadline.endWait();
      }
      recordCharge(reply.charge);
      const usage = { inputTokens: Number(reply.usage?.inputTokens) || 0, outputTokens: Number(reply.usage?.outputTokens) || 0 };
      this.registry.settleModelSpend(id, { costUsd: 0, ...usage });
      const text = String(reply.text ?? "");
      const json = r.schema ? structured(text, r.schema) : undefined;
      return { text, ...(json !== undefined ? { json } : {}), usage, cost: 0, model: String(reply.model ?? asked) };
    };
  }

  /** Once a month per cap: an authority event when spend passes 80 % of it. */
  private warnNearCap(capabilityId: string, month: string, settings: ModelSettings) {
    const rows = this.registry.modelSpend(month);
    const checks: [string, number, number][] = [["all", rows.reduce((n, r) => n + r.costUsd, 0), settings.monthlyCapUsd]];
    const own = settings.capabilityCapsUsd[capabilityId];
    if (own !== undefined) checks.push([capabilityId, rows.filter((r) => r.capabilityId === capabilityId).reduce((n, r) => n + r.costUsd, 0), own]);
    for (const [scope, spent, cap] of checks) {
      const flag = `models.warned.${month}.${scope}`;
      if (cap > 0 && spent >= 0.8 * cap && !this.registry.getKv<boolean>(flag)) {
        this.registry.setKv(flag, true);
        this.registry.addAuthorityEvent({ actor: "platform", action: "model_budget_80", subject: scope, ...(scope === "all" ? {} : { capabilityId }), detail: `$${spent.toFixed(2)} of $${cap.toFixed(2)} this month` });
        this.logger(`model spend for ${scope} passed 80% of its cap ($${spent.toFixed(2)} of $${cap.toFixed(2)})`);
      }
    }
  }
}
