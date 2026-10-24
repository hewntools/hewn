// SPDX-License-Identifier: AGPL-3.0-or-later
// Widgets (ABI 2.3) and Home: running a widget, the gallery, and the owner's layout. The templates
// and their checks are ../widgets.ts.
import { type Agent, requireOwner, requireScope } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { abiAtLeast, compileSchema, opKey, refreshMs, schemaErrors, WIDGET_SIZES, type WidgetManifest, type WidgetSize, widgetOf } from "../manifest.ts";
import { viewErrors, type WidgetOutput } from "../widgets.ts";
import { randomToken, sha256 } from "../sha256.ts";
import type { BuildView } from "./builds.ts";
import { Domain } from "./context.ts";

export class Widgets extends Domain {
  /**
   * Run a widget: its read operation, read-only, without a model, and its output checked against
   * the template it names. The owner's widgets (Home) run as the widget's own identity
   * (`widget:<capability>/<name>`, that one operation only); an agent's run under its own grants.
   * The view is cached per widget and input, so Home can draw the last one at once.
   */
  async widget(agent: Agent, capabilityId: string, name: string, input: Record<string, unknown> = {}): Promise<WidgetResult> {
    requireScope(agent, "invoke");
    this.visibleActive(agent, capabilityId);
    const manifest = this.activeManifest(capabilityId);
    const w = widgetOf(manifest, name);
    if (!w || !abiAtLeast(manifest, "2.3")) throw new PlatformError("not_found", `${capabilityId} has no widget ${name}`);
    const [op, v] = w.operation.split("@");
    const principal: Agent = agent.kind === "user" ? { id: `widget:${capabilityId}/${name}`, kind: "widget", scopes: new Set(["invoke"]), capabilities: new Set([capabilityId]) } : agent;
    const key = widgetKey(capabilityId, name, input);
    try {
      const r = await this.platform.invoke(principal, { capabilityId, operation: op, operationVersion: Number(v), input }, [principal.id], Date.now() + WIDGET_DEADLINE_MS, { readOnly: true });
      const problems = viewErrors(r.result);
      if (problems.length) throw new PlatformError("invalid_output", `widget ${name} returned something no template can draw`, problems);
      this.registry.putWidgetView(key, capabilityId, r.result);
      return { capabilityId, widget: name, title: w.title, view: r.result as WidgetOutput, at: new Date().toISOString() };
    } catch (e) {
      this.registry.putWidgetError(key, capabilityId, (e as Error).message);
      throw e;
    }
  }

  /** The widget's last view for this input (and the last refresh's error, if it failed). */
  cachedWidget(owner: Agent, capabilityId: string, name: string, input: Record<string, unknown> = {}) {
    requireOwner(owner);
    return this.registry.widgetCache(widgetKey(capabilityId, name, input));
  }

  /** Every visible capability's widgets, for the "Add widget" gallery and agents' discovery. */
  widgetGallery(agent: Agent): { capabilityId: string; name: string; widgets: (WidgetManifest & { inputSchema: Record<string, unknown> })[] }[] {
    return this.platform.list(agent)
      .map((c) => {
        const m = this.activeManifest(c.id);
        if (!abiAtLeast(m, "2.3")) return { capabilityId: c.id, name: c.name, widgets: [] };
        return { capabilityId: c.id, name: c.name, widgets: (m.widgets ?? []).map((w) => ({ ...w, inputSchema: m.operations.find((o) => opKey(o.name, o.version) === w.operation)?.inputSchema ?? {} })) };
      })
      .filter((c) => c.widgets.length);
  }

  /**
   * Home: an ordered layout of capability icons and placed widgets. Icons the layout doesn't name
   * (new capabilities, or no layout yet) are left for the client to append; widgets whose
   * capability is gone are dropped, and those whose widget is gone are kept as `missing`.
   */
  homeLayout(owner: Agent): HomeEntryView[] {
    requireOwner(owner);
    const visible = new Set(this.platform.list(owner).filter((c) => c.kind !== "connection").map((c) => c.id));
    const out: HomeEntryView[] = [];
    for (const e of this.registry.getKv<HomeEntry[]>(HOME_LAYOUT) ?? []) {
      if (!visible.has(e.id)) continue;
      if (e.type === "icon") {
        out.push(e);
        continue;
      }
      const m = this.activeManifest(e.id);
      const w = abiAtLeast(m, "2.3") ? widgetOf(m, e.widget) : undefined;
      const cached = this.registry.widgetCache(widgetKey(e.id, e.widget, e.input ?? {}));
      out.push({
        ...e,
        ...(w ? { title: w.title, sizes: w.sizes, refreshMs: refreshMs(w), ...(w.open ? { open: w.open } : {}) } : { missing: true }),
        // A widget that no longer offers the placed size (a change made it large-only) shows at its biggest.
        ...(w && !w.sizes.includes(e.size) ? { size: [...WIDGET_SIZES].reverse().find((s) => w.sizes.includes(s))! } : {}),
        view: cached?.view ?? null,
        at: cached?.at ?? null,
        error: cached?.error ?? null,
      });
    }
    return out;
  }

  setHomeLayout(owner: Agent, entries: unknown): HomeEntryView[] {
    requireOwner(owner);
    if (!Array.isArray(entries) || entries.length > 200) throw new PlatformError("invalid_request", "send { entries: [...] } (at most 200)");
    const visible = new Set(this.platform.list(owner).map((c) => c.id));
    const keys = new Set<string>();
    const clean: HomeEntry[] = [];
    // Widgets already placed, by key: one whose options a later version no longer takes still saves
    // (it shows its error until the owner sets new options), so it can't block moving everything else.
    const placed = new Map((this.registry.getKv<HomeEntry[]>(HOME_LAYOUT) ?? []).flatMap((e) => (e.type === "widget" ? [[e.key, e] as const] : [])));
    for (const raw of entries as Record<string, unknown>[]) {
      const id = String(raw?.id ?? "");
      if (!visible.has(id)) continue; // gone since the page loaded
      if (raw.type === "icon") {
        // hidden: off Home (Edit Home's ×); it still shows in search, and keeps its place.
        if (!clean.some((e) => e.type === "icon" && e.id === id)) clean.push({ type: "icon", id, ...(raw.hidden === true ? { hidden: true as const } : {}) });
        continue;
      }
      if (raw.type !== "widget") throw new PlatformError("invalid_request", 'each entry is { type: "icon", id, hidden? } or { type: "widget", key, id, widget, size, input? }');
      const key = String(raw.key ?? "");
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || keys.has(key)) throw new PlatformError("invalid_request", "each placed widget needs its own key");
      keys.add(key);
      const widget = String(raw.widget ?? "");
      const m = this.activeManifest(id);
      const w = widgetOf(m, widget);
      const size = String(raw.size ?? "");
      const input = raw.input === undefined ? undefined : raw.input;
      if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) throw new PlatformError("invalid_request", `widget ${id}/${widget}: input must be an object`);
      if (w) {
        if (!(w.sizes as string[]).includes(size)) throw new PlatformError("invalid_request", `widget ${id}/${widget} comes in ${w.sizes.join(", ")}, not ${size}`);
        const op = m.operations.find((o) => opKey(o.name, o.version) === w.operation)!;
        const check = compileSchema(op.inputSchema);
        const prev = placed.get(key);
        // Compared as JSON: what the client sends back is what it was given, in the same key order.
        const unchanged = prev?.id === id && prev.widget === widget && JSON.stringify(prev.input ?? {}) === JSON.stringify(input ?? {});
        if (!unchanged && !check(input ?? {})) throw new PlatformError("invalid_request", `widget ${id}/${widget}: input doesn't match ${w.operation}`, schemaErrors(check));
      } else if (!(WIDGET_SIZES as readonly string[]).includes(size)) throw new PlatformError("invalid_request", `unknown size ${size}`);
      // A widget that no longer exists may stay where it is (shown as missing) but can't be placed anew.
      else if (!this.homeLayout(owner).some((e) => e.type === "widget" && e.key === key)) throw new PlatformError("not_found", `${id} has no widget ${widget}`);
      clean.push({ type: "widget", key, id, widget, size: size as WidgetSize, ...(input ? { input: input as Record<string, unknown> } : {}) });
    }
    this.registry.setKv(HOME_LAYOUT, clean);
    // Icons keep their place in the capability order too (search, agents' lists).
    this.registry.setHomeOrder(clean.filter((e) => e.type === "icon").map((e) => e.id));
    return this.homeLayout(owner);
  }

  /**
   * Put one widget on Home, at the end. Without a stored layout yet, the icons are placed first in
   * Home's current order, so the widget lands after them (next to "New").
   */
  placeWidget(owner: Agent, entry: { id: string; widget: string; size: string; input?: Record<string, unknown> }): HomeEntryView[] {
    requireOwner(owner);
    const stored = this.registry.getKv<HomeEntry[]>(HOME_LAYOUT);
    const order = (id: string) => this.registry.getCapability(id)?.homeOrder ?? Number.MAX_SAFE_INTEGER;
    const created = (id: string) => this.registry.getCapability(id)?.createdAt ?? "";
    const icons = this.platform.list(owner)
      .filter((c) => c.kind !== "connection")
      .sort((a, b) => order(a.id) - order(b.id) || created(a.id).localeCompare(created(b.id)))
      .map((c) => ({ type: "icon" as const, id: c.id }));
    const base: HomeEntry[] = stored ?? icons;
    // Icons the layout doesn't name yet keep their place before the new widget.
    const missing = icons.filter((i) => !base.some((e) => e.type === "icon" && e.id === i.id));
    return this.setHomeLayout(owner, [...base, ...missing, { type: "widget", key: randomToken(6), ...entry }]);
  }

  /**
   * Delete a widget: a new version without it (manifest only, no builder; its operation stays, an
   * ordinary read), and it leaves Home now.
   */
  async removeWidget(owner: Agent, capabilityId: string, name: string): Promise<BuildView> {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    const w = widgetOf(this.activeManifest(capabilityId), name);
    if (!w) throw new PlatformError("not_found", `${capabilityId} has no widget ${name}`);
    const b = await this.d.builds.manifestOnlyModify(owner, capabilityId, (m) => { const rest = (m.widgets ?? []).filter((x) => x.name !== name); if (rest.length) m.widgets = rest; else delete m.widgets; }, `delete the "${w.title}" widget`);
    const layout = this.registry.getKv<HomeEntry[]>(HOME_LAYOUT);
    if (layout) this.registry.setKv(HOME_LAYOUT, layout.filter((e) => !(e.type === "widget" && e.id === capabilityId && e.widget === name)));
    return b;
  }

  /** Run a placed widget (Home's refresh). Failures come back as values: Home keeps the last view. */
  async refreshHomeWidget(owner: Agent, key: string): Promise<{ view: unknown; at: string | null; error: string | null }> {
    const entry = this.homeLayout(owner).find((e) => e.type === "widget" && e.key === key) as Extract<HomeEntryView, { type: "widget" }> | undefined;
    if (!entry) throw new PlatformError("not_found", "no such widget on Home");
    try {
      const r = await this.widget(owner, entry.id, entry.widget, entry.input ?? {});
      return { view: r.view, at: r.at, error: null };
    } catch (e) {
      const c = this.registry.widgetCache(widgetKey(entry.id, entry.widget, entry.input ?? {}));
      return { view: c?.view ?? null, at: c?.at ?? null, error: (e as Error).message };
    }
  }
}

/** How long a widget's operation may take (Home draws the cached view meanwhile). */
export const WIDGET_DEADLINE_MS = 15_000;

/** Home's stored layout (platform_kv). */
const HOME_LAYOUT = "home:layout";

export type HomeEntry = { type: "icon"; id: string; hidden?: true } | { type: "widget"; key: string; id: string; widget: string; size: WidgetSize; input?: Record<string, unknown> };
/** A layout entry as Home draws it: placed widgets carry their title, sizes and last view. */
export type HomeEntryView =
  | { type: "icon"; id: string; hidden?: true }
  | (Extract<HomeEntry, { type: "widget" }> & { title?: string; sizes?: WidgetSize[]; refreshMs?: number; open?: string; missing?: true; view: unknown; at: string | null; error: string | null });

export interface WidgetResult {
  capabilityId: string;
  widget: string;
  title: string;
  view: WidgetOutput;
  at: string;
}

const widgetKey = (capabilityId: string, name: string, input: Record<string, unknown>) => `${capabilityId}/${name}/${sha256(JSON.stringify(input)).slice(0, 16)}`;
