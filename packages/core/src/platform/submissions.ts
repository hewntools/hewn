// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds from anywhere: a client that writes a tool itself. It fetches the pack (what Hewn's own
// builder finds in its workspace), checks its files as validation would while it works, and submits
// them; Hewn validates the submission and holds it for the owner or promotes it, as any build.
// Files travel as a list of { path, content, encoding? }; the gate itself is Builds.submit.
import { type Agent, canSee, requireScope } from "../auth.ts";
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, writeZip } from "../bundle.ts";
import { PlatformError } from "../errors.ts";
import { bytes, CONTRACTS_DIR, fromBase64, isArtefact, isBuilderConfig, isWorkspaceOnly, toBase64 } from "../files.ts";
import { randomToken, sha256 } from "../sha256.ts";
import type { CheckResult, Files } from "../ports.ts";
import type { BuildRow } from "../registry.ts";
import type { BuildView } from "./builds.ts";
import { Domain } from "./context.ts";

/** A file as it travels over MCP: UTF-8 text, or base64 for anything that isn't. */
export interface FileEntry {
  path: string;
  content: string;
  encoding?: "utf-8" | "base64";
}

/** `capabilities_check` calls a client may make in an hour (a submission's own validation doesn't count). */
export const CHECKS_PER_HOUR = 30;
const HOUR = 3600_000;

/**
 * The most a `capabilities_pack` call sends of the pack's files (their content, in bytes); the rest
 * are listed in `more`. About 10,000 tokens: well under what a client takes from one tool call
 * (Claude Code: 25,000 by default).
 */
export const PACK_PAGE_BYTES = 40 * 1024;
/** How long a pack's download link works (once). */
export const PACK_LINK_MS = 10 * 60_000;
/** Where a pack's download link points; the token follows. `/~` keeps the token out of the public listener's log. */
export const PACK_PATH = "/_platform/pack/~";

/** What `capabilities_pack` returns. */
export interface Pack {
  kind: "create" | "modify";
  capabilityId?: string;
  /** For a change: the version its files are, to pass back as `baseVersion`. */
  baseVersion?: number;
  /** As many of the pack's files as fit in a page (`PACK_PAGE_BYTES`); at least one. */
  files: FileEntry[];
  /** The pack's files left out of this page, with their size: ask for them with `paths`. */
  more?: { path: string; bytes: number }[];
  /** The whole pack as a zip, the other tools' full contracts too: `path` (on this Hewn) works once, until `expiresAt`. Not on a call with `paths`. */
  download?: { path: string; expiresAt: string };
  /** For a change: the owner's schedules on the tool, each running an operation by name. */
  schedules?: { operation: string; cadence: string; status: string }[];
  /** What to do next, in a line. */
  next: string;
}

/** A download link's holder: what it was minted for. Only the token's hash is kept. */
interface PackLink {
  agentId: string;
  kind: "create" | "modify";
  capabilityId?: string;
  expires: number;
}

/**
 * What `capabilities_check` returns: the check's result and its renders as images, the four (a long
 * page's top part); with `screenshots: "all"` a long page's further parts after them; none with `screenshots: false`.
 */
export interface ClientCheck {
  passed: boolean;
  text: string;
  failures: string[];
  defects: string[];
  images: { name: string; png: Uint8Array }[];
}

/** Each refused path with the rule it breaks, so a client learns the rule. */
const RULES = {
  config: "Hewn never keeps a builder's own configuration in a tool (dotfiles and dot-folders, CLAUDE.md, AGENTS.md, opencode.json)",
  workspace: "Hewn writes these for builders and never keeps them in a tool (BUILDER.md, BRIEF.md, CONTRACTS.md, OTHER_TOOLS.md, PLATFORM_UI.css, OWNERS_WORDS.md, attachments/, screenshots/)",
  artefact: "build output is never part of a tool (node_modules, .venv, __pycache__, .DS_Store, .pytest_cache)",
} as const;

/**
 * A candidate's files, checked before anything is written: paths Hewn accepts (as a bundle's: no
 * leading /, no `..` or empty part, no backslash or control character, no two that one disk would
 * take for the same file), at most 1,000 files and 5 MB, and nothing Hewn never keeps in a version.
 * What's refused is refused whole, every path named with its rule: never dropped quietly.
 */
export function candidateFiles(files: Files): Files {
  const paths = Object.keys(files);
  if (!paths.length) throw new PlatformError("invalid_request", "no files: send the tool's files (capability.json, src/index.ts, tests/cases.json …)");
  if (paths.length > MAX_BUNDLE_FILES) throw new PlatformError("invalid_request", `${paths.length} files; a tool may have at most ${MAX_BUNDLE_FILES.toLocaleString("en")}`);
  const bad: string[] = [];
  const refused: { path: string; rule: string }[] = [];
  const seen = new Map<string, string>();
  let total = 0;
  for (const path of paths) {
    if (!path || path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "" || p === ".") || path.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(path)) {
      bad.push(`${JSON.stringify(path)} isn't a path Hewn accepts (relative, with / between parts, no .. or empty part)`);
      continue;
    }
    const key = path.normalize("NFC").toLowerCase();
    const twin = seen.get(key);
    if (twin !== undefined) bad.push(`${twin} and ${path}: on many disks they're the same file`);
    seen.set(key, path);
    const rule = isBuilderConfig(path) ? RULES.config : isWorkspaceOnly(path) ? RULES.workspace : isArtefact(path) ? RULES.artefact : undefined;
    if (rule) refused.push({ path, rule });
    total += files[path].length;
  }
  if (total > MAX_BUNDLE_BYTES) bad.push(`the files come to ${Math.round((total / MB) * 10) / 10} MB; a tool may be at most ${MAX_BUNDLE_BYTES / MB} MB`);
  if (bad.length || refused.length) {
    const byRule = Object.values(RULES).flatMap((rule) => {
      const named = refused.filter((r) => r.rule === rule).map((r) => r.path);
      return named.length ? [`${named.join(", ")}: ${rule}. Leave ${named.length === 1 ? "it" : "them"} out.`] : [];
    });
    throw new PlatformError("invalid_request", `Hewn won't take these files:\n  - ${[...bad, ...byRule].join("\n  - ")}`, { refused, problems: bad });
  }
  return files;
}

/** Files from the list a client sends (`FileEntry`), or invalid_request saying what's wrong with it. */
export function filesFromEntries(list: unknown): Files {
  if (!Array.isArray(list)) throw new PlatformError("invalid_request", "files: a list of { path, content, encoding? }");
  if (list.length > MAX_BUNDLE_FILES) throw new PlatformError("invalid_request", `${list.length} files; a tool may have at most ${MAX_BUNDLE_FILES.toLocaleString("en")}`);
  const out: Files = {};
  for (const [i, f] of list.entries()) {
    const e = f as Partial<FileEntry> | null;
    if (!e || typeof e.path !== "string" || typeof e.content !== "string") throw new PlatformError("invalid_request", `files[${i}]: needs a path and a content (text)`);
    if (e.encoding !== undefined && e.encoding !== "utf-8" && e.encoding !== "base64") throw new PlatformError("invalid_request", `files[${i}] (${e.path}): encoding is "utf-8" (the default) or "base64"`);
    if (Object.hasOwn(out, e.path)) throw new PlatformError("invalid_request", `${e.path} is in the list twice`);
    // An object key that isn't one (it would set the list's prototype, and the file be dropped unseen).
    if (e.path === "__proto__") throw new PlatformError("invalid_request", `${JSON.stringify(e.path)} isn't a path Hewn accepts`);
    if (e.encoding === "base64") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(e.content.replace(/\s+/g, ""))) throw new PlatformError("invalid_request", `${e.path}: its content isn't base64`);
      out[e.path] = fromBase64(e.content.replace(/\s+/g, ""));
    } else out[e.path] = bytes(e.content);
  }
  return out;
}

const MB = 1024 * 1024;
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8 = new TextEncoder();
/** A file as it travels: as text when it is UTF-8 without NULs, else base64. */
export function entryOf(path: string, b: Uint8Array): FileEntry {
  if (!b.includes(0)) {
    try {
      return { path, content: strict.decode(b) };
    } catch {
      // not text
    }
  }
  return { path, content: toBase64(b), encoding: "base64" };
}

export class Submissions extends Domain {
  /** Recent check times per client, for the hourly cap. */
  private checked = new Map<string, number[]>();
  /** Each client's checks run one at a time. */
  private checking = new Map<string, Promise<unknown>>();
  /** The pack's download links, by their token's hash, in memory: a restart ends them. */
  private links = new Map<string, PackLink>();

  /**
   * What Hewn's builder finds in its workspace before it writes, for a client that writes the tool
   * itself: the other tools' contracts (`CONTRACTS.md`, `.hewn-contracts/<id>.md`), their looks
   * (`OTHER_TOOLS.md`), the design system (`PLATFORM_UI.css`), and for a change the tool's files and
   * its schedules. Never the brief's request or the owner's words: the client has its own. Only the
   * tools the client may see.
   */
  async pack(agent: Agent, req: { kind?: unknown; capabilityId?: unknown; paths?: unknown }): Promise<Pack> {
    if (req.kind !== "create" && req.kind !== "modify") throw new PlatformError("invalid_request", 'kind: "create" for a new tool, "modify" for a change');
    requireScope(agent, req.kind);
    if (req.kind === "create" && req.capabilityId !== undefined) throw new PlatformError("invalid_request", "a new tool has no capabilityId; leave it out, or use kind modify");
    if (req.paths !== undefined && (!Array.isArray(req.paths) || !req.paths.length || req.paths.some((p) => typeof p !== "string"))) throw new PlatformError("invalid_request", "paths: the files to fetch, from the pack's more");
    if (req.kind === "modify" && typeof req.capabilityId !== "string") throw new PlatformError("invalid_request", "capabilityId: the tool to change");
    const cap = req.kind === "modify" ? this.visibleActive(agent, req.capabilityId as string) : undefined;
    const all = await this.packOf(agent, cap?.id);
    // The other tools' full contracts come with the download, or from capabilities_get: never in pages.
    const paged = Object.fromEntries(Object.entries(all).filter(([p]) => !p.startsWith(`${CONTRACTS_DIR}/`)));
    const asked = req.paths as string[] | undefined;
    if (asked) {
      const missing = asked.filter((p) => !Object.hasOwn(paged, p));
      if (missing.length) throw new PlatformError("invalid_request", `not in the pack: ${missing.join(", ")}${missing.some((p) => p.startsWith(`${CONTRACTS_DIR}/`)) ? ` (a tool's full contract: capabilities_get it)` : ""}`);
    }
    const { files, more } = page(asked ?? packOrder(paged), paged, this.platform.packPageBytes);
    const download = asked ? undefined : this.packLink(agent, req.kind, cap?.id);
    const rest = more.length ? ` ${more.length} more of the pack's files: capabilities_pack with paths for them, a page at a time.` : "";
    const head = { files, ...(more.length ? { more } : {}), ...(download ? { download } : {}) };
    if (!cap) return { kind: "create", ...head, next: `Read these, write the tool in your workspace, then capabilities_check it while you work and capabilities_submit it when the check passes.${rest}` };
    const schedules = this.schedules.list(cap.id).map((s) => ({ operation: `${s.operation}@${s.operationVersion}`, cadence: s.cadence, status: s.status }));
    return {
      kind: "modify",
      capabilityId: cap.id,
      baseVersion: cap.activeVersion!,
      ...head,
      ...(schedules.length ? { schedules } : {}),
      next: `The tool's files are v${cap.activeVersion}'s. Change them in your workspace, keep every operation version in schedules (each runs exactly that one), then capabilities_check with capabilityId while you work and capabilities_submit with capabilityId and baseVersion ${cap.activeVersion} when the check passes. Send the tool's files only, not the contracts, looks or design system.${rest}`,
    };
  }

  /** The whole pack for `agent`: the other tools it may see, and for a change (`capabilityId`) the tool's files. */
  private packOf(agent: Agent, capabilityId?: string): Promise<Files> {
    return this.d.builds.packFiles(capabilityId, (id) => canSee(agent, id));
  }

  /** A download link for the pack: a fresh token, of which only the hash is kept, for `PACK_LINK_MS`. */
  private packLink(agent: Agent, kind: "create" | "modify", capabilityId?: string): { path: string; expiresAt: string } {
    const now = Date.now();
    for (const [h, l] of this.links) if (l.expires <= now) this.links.delete(h);
    // A handful a client at most: an older one goes.
    const mine = [...this.links].filter(([, l]) => l.agentId === agent.id);
    for (const [h] of mine.slice(0, Math.max(0, mine.length - 4))) this.links.delete(h);
    const token = randomToken(32);
    const expires = now + this.platform.packLinkMs;
    this.links.set(sha256(token), { agentId: agent.id, kind, ...(capabilityId ? { capabilityId } : {}), expires });
    return { path: `${PACK_PATH}${token}`, expiresAt: new Date(expires).toISOString() };
  }

  /**
   * The pack a download link was minted for, as a zip, once: the link goes as it's used, and on
   * expiry. Undefined when it isn't (or is no longer) a link, or its client may no longer have the
   * pack (its scope, the tool, its grant), which is all the same to whoever asks.
   */
  async packDownload(token: string): Promise<Uint8Array | undefined> {
    const h = sha256(token);
    const link = this.links.get(h);
    if (!link) return undefined;
    this.links.delete(h);
    if (link.expires <= Date.now()) return undefined;
    const agent = this.agentStore.get(link.agentId);
    if (!agent?.scopes.has(link.kind)) return undefined;
    try {
      const cap = link.capabilityId ? this.visibleActive(agent, link.capabilityId) : undefined;
      return writeZip(await this.packOf(agent, cap?.id));
    } catch (e) {
      if (e instanceof PlatformError) return undefined;
      throw e;
    }
  }

  /**
   * Check a client's files as validation will, promoting nothing: what the builder's own `check`
   * runs (the manifest, bundling, contracts against the tool when `capabilityId` is given,
   * migrations, the tests, the sample data, the screen at 1280 and 390 px in light and dark with
   * what to fix measured on it), but for the upgrade dry run on the tool's own data, which runs when
   * it's submitted. At most `CHECKS_PER_HOUR` a client (counted in memory: a restart starts afresh),
   * one at a time. The four renders come back as images; `screenshots: "all"` adds a long page's
   * further parts (the text names them either way); `screenshots: false`: the UI still renders and is
   * measured, but no images come back.
   */
  async check(agent: Agent, req: { files?: unknown; capabilityId?: unknown; screenshots?: unknown }): Promise<ClientCheck> {
    const change = req.capabilityId !== undefined;
    requireScope(agent, change ? "modify" : "create");
    if (change && typeof req.capabilityId !== "string") throw new PlatformError("invalid_request", "capabilityId: the tool your files change");
    if (req.screenshots !== undefined && typeof req.screenshots !== "boolean" && req.screenshots !== "all") throw new PlatformError("invalid_request", 'screenshots: true, false or "all"');
    const shots = req.screenshots === false ? "none" : req.screenshots === "all" ? "all" : "four";
    const files = candidateFiles(filesFromEntries(req.files));
    const cap = change ? this.visibleActive(agent, req.capabilityId as string) : undefined;
    const id = cap?.id ?? this.newToolId(files);
    const limit = this.platform.checksPerHour;
    const now = Date.now();
    const recent = (this.checked.get(agent.id) ?? []).filter((t) => now - t < HOUR);
    if (recent.length >= limit) throw new PlatformError("conflict", `No checks left this hour (${limit}). The next one frees up in ${Math.ceil((recent[0] + HOUR - now) / 60_000)} min; capabilities_submit runs the same validation.`);
    this.checked.set(agent.id, [...recent, now]);
    const run = async (): Promise<ClientCheck> => {
      const build: BuildRow = { id: `chk-${crypto.randomUUID().slice(0, 8)}`, capabilityId: id, kind: cap ? "modify" : "create", request: {}, requestedBy: agent.id, builder: "submitted", status: "open", baseVersion: cap?.activeVersion ?? null, resultVersion: null, dependsOn: null, review: null, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await this.workbench.open(build.id, files);
      let r: CheckResult;
      try {
        // Not the upgrade dry run: a client's migrations run on a copy of the owner's data only once submitted.
        r = await this.d.validation.check(build, { liveData: false, shots });
      } finally {
        await this.workbench.remove(build.id).catch(() => {});
      }
      this.logger(`check by ${agent.id} of ${cap ? `a change to ${id}` : `new tool ${id}`}: ${r.passed ? "passed" : `${r.failures.length} problem(s)`}`);
      const later = cap && (await this.runtime.hasState({ capabilityId: cap.id })) ? `\n\nNot in a check: the upgrade dry run, your migrations on a copy of ${cap.id}'s data. It runs when you submit.` : "";
      return { passed: r.passed, text: r.text + later, failures: r.failures, defects: r.defects, images: shots === "none" ? [] : shots === "all" ? [...r.images, ...(r.parts ?? [])] : r.images };
    };
    const prev = this.checking.get(agent.id) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.checking.set(agent.id, next.catch(() => {}));
    return next;
  }

  /** A client's tool, handed over: through the same gate as any build (`Builds.submit`). */
  async submit(agent: Agent, req: { files?: unknown; capabilityId?: unknown; request?: unknown; baseVersion?: unknown }): Promise<BuildView> {
    if (req.capabilityId !== undefined && typeof req.capabilityId !== "string") throw new PlatformError("invalid_request", "capabilityId: the tool your files change");
    if (req.baseVersion !== undefined && typeof req.baseVersion !== "number") throw new PlatformError("invalid_request", "baseVersion must be a version number");
    requireScope(agent, req.capabilityId === undefined ? "create" : "modify");
    const name = this.agentStore.list().find((a) => a.id === agent.id)?.name ?? agent.id;
    return this.d.builds.submit(agent, {
      files: filesFromEntries(req.files),
      ...(req.capabilityId !== undefined ? { capabilityId: req.capabilityId as string } : {}),
      builder: "submitted",
      submittedBy: name,
      request: typeof req.request === "string" ? req.request : "",
      ...(req.baseVersion !== undefined ? { baseVersion: req.baseVersion as number } : {}),
    });
  }

  /** A new tool's id, from its capability.json: one that names a tool already here is a change, not a new tool. */
  private newToolId(files: Files): string {
    let id: unknown;
    try {
      id = JSON.parse(new TextDecoder().decode(files["capability.json"])).id;
    } catch {
      // said below
    }
    if (!files["capability.json"]) throw new PlatformError("invalid_request", "capability.json is missing");
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new PlatformError("invalid_request", "capability.json needs an id: lowercase letters, digits and dashes");
    const existing = this.registry.getCapability(id);
    if (existing?.activeVersion || existing?.archivedAt) throw new PlatformError("conflict", `'${id}' is already a tool here: pass capabilityId '${id}' to check a change to it, or give the new tool another id`);
    return id;
  }
}

/** A pack's files as a client reads them first: the other tools' contracts and looks, the tool's own files (smallest first), then the design system. */
function packOrder(files: Files): string[] {
  const rank = (p: string) => (p === "CONTRACTS.md" ? 0 : p === "OTHER_TOOLS.md" ? 1 : p === "PLATFORM_UI.css" ? 3 : 2);
  return Object.keys(files).sort((a, b) => rank(a) - rank(b) || files[a].length - files[b].length || a.localeCompare(b));
}

/** `paths` of `files`, in order, as many as fit in `budget` bytes as sent (at least one); the rest, with their size. */
function page(paths: string[], files: Files, budget: number): { files: FileEntry[]; more: { path: string; bytes: number }[] } {
  const taken: FileEntry[] = [];
  const more: { path: string; bytes: number }[] = [];
  let used = 0;
  for (const path of [...new Set(paths)]) {
    const e = entryOf(path, files[path]);
    // The content as it travels (UTF-8 text, or base64), in bytes.
    const size = utf8.encode(e.content).length;
    if (taken.length && used + size > budget) more.push({ path, bytes: size });
    else (taken.push(e), (used += size));
  }
  return { files: taken, more };
}
