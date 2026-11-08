// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds from anywhere: a client that writes a tool itself. It fetches the pack (what Hewn's own
// builder finds in its workspace), checks its files as validation would while it works, and submits
// them; Hewn validates the submission and holds it for the owner or promotes it, as any build.
// Files travel as a list of { path, content, encoding? }; the gate itself is Builds.submit.
import { type Agent, canSee, requireScope } from "../auth.ts";
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES } from "../bundle.ts";
import { PlatformError } from "../errors.ts";
import { bytes, fromBase64, isArtefact, isBuilderConfig, isWorkspaceOnly, toBase64 } from "../files.ts";
import type { CheckResult, Files } from "../ports.ts";
import type { BuildRow } from "../registry.ts";
import type { BuildView } from "./builds.ts";
import { Domain } from "./context.ts";
import { MAX_PARTS_BYTES } from "./validation.ts";

/** A file as it travels over MCP: UTF-8 text, or base64 for anything that isn't. */
export interface FileEntry {
  path: string;
  content: string;
  encoding?: "utf-8" | "base64";
}

/** `capabilities_check` calls a client may make in an hour (a submission's own validation doesn't count). */
export const CHECKS_PER_HOUR = 30;
const HOUR = 3600_000;

/** What `capabilities_pack` returns. */
export interface Pack {
  kind: "create" | "modify";
  capabilityId?: string;
  /** For a change: the version its files are, to pass back as `baseVersion`. */
  baseVersion?: number;
  files: FileEntry[];
  /** For a change: the owner's schedules on the tool, each running an operation by name. */
  schedules?: { operation: string; cadence: string; status: string }[];
  /** What to do next, in a line. */
  next: string;
}

/** What `capabilities_check` returns: the check's result, its four renders as images, and every render as a file for `screenshots/`. */
export interface ClientCheck {
  passed: boolean;
  text: string;
  failures: string[];
  defects: string[];
  images: { name: string; png: Uint8Array }[];
  files: FileEntry[];
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
  if (total > MAX_BUNDLE_BYTES) bad.push(`the files come to ${Math.round(total / 104857.6) / 10} MB; a tool may be at most 5 MB`);
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
    if (e.encoding === "base64") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(e.content.replace(/\s+/g, ""))) throw new PlatformError("invalid_request", `${e.path}: its content isn't base64`);
      out[e.path] = fromBase64(e.content.replace(/\s+/g, ""));
    } else out[e.path] = bytes(e.content);
  }
  return out;
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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

  /**
   * What Hewn's builder finds in its workspace before it writes, for a client that writes the tool
   * itself: the other tools' contracts (`CONTRACTS.md`, `.hewn-contracts/<id>.md`), their looks
   * (`OTHER_TOOLS.md`), the design system (`PLATFORM_UI.css`), and for a change the tool's files and
   * its schedules. Never the brief's request or the owner's words: the client has its own. Only the
   * tools the client may see.
   */
  async pack(agent: Agent, req: { kind?: unknown; capabilityId?: unknown }): Promise<Pack> {
    if (req.kind !== "create" && req.kind !== "modify") throw new PlatformError("invalid_request", 'kind: "create" for a new tool, "modify" for a change');
    requireScope(agent, req.kind);
    if (req.kind === "create" && req.capabilityId !== undefined) throw new PlatformError("invalid_request", "a new tool has no capabilityId; leave it out, or use kind modify");
    const visible = (id: string) => canSee(agent, id);
    if (req.kind === "create") {
      const files = await this.d.builds.packFiles(undefined, visible);
      return { kind: "create", files: entries(files), next: "Write the tool in this folder, then capabilities_check it while you work and capabilities_submit it when the check passes." };
    }
    if (typeof req.capabilityId !== "string") throw new PlatformError("invalid_request", "capabilityId: the tool to change");
    const cap = this.visibleActive(agent, req.capabilityId);
    const files = await this.d.builds.packFiles(cap.id, visible);
    const schedules = this.schedules.list(cap.id).map((s) => ({ operation: `${s.operation}@${s.operationVersion}`, cadence: s.cadence, status: s.status }));
    return {
      kind: "modify",
      capabilityId: cap.id,
      baseVersion: cap.activeVersion!,
      files: entries(files),
      ...(schedules.length ? { schedules } : {}),
      next: `These are v${cap.activeVersion}'s files. Change them here, keep every operation a schedule runs, then capabilities_check with capabilityId while you work and capabilities_submit with capabilityId and baseVersion ${cap.activeVersion} when the check passes. Send the tool's files only, not the contracts, looks or design system.`,
    };
  }

  /**
   * Check a client's files as validation will, promoting nothing: what the builder's own `check`
   * runs (the manifest, bundling, contracts against the tool when `capabilityId` is given,
   * migrations, the tests, the sample data, the screen at 1280 and 390 px in light and dark with
   * what to fix measured on it), but for the upgrade dry run on the tool's own data, which runs when
   * it's submitted. At most `CHECKS_PER_HOUR` a client, one at a time.
   */
  async check(agent: Agent, req: { files?: unknown; capabilityId?: unknown }): Promise<ClientCheck> {
    const change = req.capabilityId !== undefined;
    requireScope(agent, change ? "modify" : "create");
    if (change && typeof req.capabilityId !== "string") throw new PlatformError("invalid_request", "capabilityId: the tool your files change");
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
        r = await this.d.validation.check(build, { liveData: false });
      } finally {
        await this.workbench.remove(build.id).catch(() => {});
      }
      this.logger(`check by ${agent.id} of ${cap ? `a change to ${id}` : `new tool ${id}`}: ${r.passed ? "passed" : `${r.failures.length} problem(s)`}`);
      // The renders as files too, for a client that drops images (a long page's parts only there).
      let room = MAX_PARTS_BYTES;
      const parts = (r.parts ?? []).filter((s) => (room -= s.png.length) >= 0);
      const later = cap && (await this.runtime.hasState({ capabilityId: cap.id })) ? `\n\nNot in a check: the upgrade dry run, your migrations on a copy of ${cap.id}'s data. It runs when you submit.` : "";
      return { passed: r.passed, text: r.text + later, failures: r.failures, defects: r.defects, images: r.images, files: [...r.images, ...parts].map((s) => ({ path: `screenshots/${s.name}.png`, content: toBase64(s.png), encoding: "base64" as const })) };
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

const entries = (files: Files): FileEntry[] =>
  Object.keys(files)
    .sort()
    .map((p) => entryOf(p, files[p]));
