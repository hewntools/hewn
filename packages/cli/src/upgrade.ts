// SPDX-License-Identifier: AGPL-3.0-or-later
// Upgrading Hewn. The npm package: `hewn upgrade` installs the newest published version in its
// 0.x line with npm (or says the command, when the global folder needs sudo). A git checkout
// (install.sh, for contributors): it moves the checkout to the newest release tag, installs exactly
// the locked dependencies (npm ci), and checks the install builds.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export { APP_DIR } from "./app-dir.ts";
import { APP_DIR, NPM_PREFIX } from "./app-dir.ts";

const git = (...args: string[]) => spawnSync("git", ["-C", APP_DIR, ...args], { encoding: "utf8" });
const ok = (r: ReturnType<typeof git>, what: string) => {
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  return r.stdout.trim();
};

export const appVersion = (): string => JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version;
export const isCheckout = () => existsSync(join(APP_DIR, ".git"));

/** Release tags (v0.1.0, v0.1.1-rc.1 …), newest first. */
export function releaseTags(): string[] {
  return git("tag", "-l", "v*", "--sort=-v:refname").stdout.split("\n").filter((t) => /^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(t));
}

/** The newest tag in the same 0.x line as `version` (a move to 0.2 is deliberate: `--to`). Stable tags win over pre-releases of the same version. */
export function newestInLine(version: string, tags: string[] = releaseTags()): string | undefined {
  const [maj, min] = version.split(".");
  const line = tags.filter((t) => t.startsWith(`v${maj}.${min}.`));
  const key = (t: string) => {
    const [core, pre] = t.slice(1).split("-");
    return [...core.split(".").map(Number), pre ? 0 : 1, pre ?? ""] as const;
  };
  return line.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return (y[i] as number) - (x[i] as number);
    return String(y[4]).localeCompare(String(x[4]), undefined, { numeric: true });
  })[0];
}

/** Install exactly what the lockfile says (a plain `npm install` over an old tree can leave it broken). */
export function npmCi(log: (line: string) => void = () => {}): void {
  log("installing dependencies (npm ci)…");
  const r = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: APP_DIR, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npm ci failed:\n${(r.stderr || r.stdout).trim().split("\n").slice(-8).join("\n")}`);
}

/** Can this install build the workerd host? Returns the first error line, or undefined when it's fine. */
export async function bundleProblem(): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "hewn-bundle-"));
  try {
    const { buildHost } = await import("./supervisor/bundle.ts");
    await buildHost(dir);
    return undefined;
  } catch (e) {
    const m = (e as Error).message;
    return (/ERROR: .*/.exec(m)?.[0] ?? m.split("\n")[0]).slice(0, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Move the checkout to `to` (default: the newest tag in this version's line), install, and check
 * it builds. On failure, goes back to where it was. Returns the old and new refs.
 */
export async function upgradeCheckout(o: { to?: string; log?: (line: string) => void } = {}): Promise<{ from: string; to: string; changed: boolean }> {
  const log = o.log ?? (() => {});
  if (!isCheckout()) throw new Error(`${APP_DIR} isn't a git checkout: reinstall Hewn from the README`);
  if (git("status", "--porcelain", "--untracked-files=no").stdout.trim()) throw new Error(`${APP_DIR} has local changes; commit or discard them first`);
  const from = ok(git("describe", "--tags", "--always"), "git describe");
  log("fetching releases…");
  ok(git("fetch", "--tags", "--force", "--quiet", "origin"), "git fetch");
  const to = o.to ?? newestInLine(appVersion());
  if (!to) throw new Error("no release tags found");
  if (!releaseTags().includes(to)) throw new Error(`no release ${to} (known: ${releaseTags().slice(0, 5).join(", ")})`);
  const head = ok(git("rev-parse", "HEAD"), "git rev-parse");
  if (ok(git("rev-parse", `${to}^{commit}`), "git rev-parse") === head) return { from, to, changed: false };
  log(`switching ${from} → ${to}…`);
  ok(git("-c", "advice.detachedHead=false", "checkout", "--quiet", to), "git checkout");
  try {
    npmCi(log);
    const problem = await bundleProblem();
    if (problem) throw new Error(`the new version doesn't build here: ${problem}`);
  } catch (e) {
    log(`going back to ${from}…`);
    git("-c", "advice.detachedHead=false", "checkout", "--quiet", head);
    try {
      npmCi();
    } catch {
      // reported below
    }
    throw e;
  }
  return { from, to, changed: true };
}

export const PACKAGE = "@hewntools/cli";
const npm = (...args: string[]) => spawnSync("npm", args, { encoding: "utf8" });

/** `npm view <package> versions`, or a plain reason when npm can't say (offline, not published). */
function viewVersions(): string {
  const r = npm("view", PACKAGE, "versions", "--json");
  if (r.status === 0) return r.stdout;
  if (/E404|404 Not Found/.test(r.stdout + r.stderr)) throw new Error(`${PACKAGE} isn't on npm (yet): nothing to upgrade to`);
  throw new Error(`couldn't ask npm for the newest Hewn (offline?): ${(r.stderr || r.stdout).trim().split("\n").find((l) => /npm error/.test(l))?.replace(/^npm error\s*/, "") ?? "npm view failed"}`);
}

/** Published versions of the CLI, as tags (v0.4.0 …), newest first (as releaseTags). */
export function publishedTags(view: () => string = viewVersions): string[] {
  const v = JSON.parse(view() || "[]") as string | string[];
  return (Array.isArray(v) ? v : [v]).map((x) => `v${x}`).reverse();
}

/** Whether npm can install into `prefix` without sudo. */
function writable(prefix: string): boolean {
  const dir = join(prefix, "lib", "node_modules");
  return spawnSync("test", ["-w", existsSync(dir) ? dir : prefix]).status === 0;
}

/**
 * The npm package: install the newest published version in this version's line (or `to`), then
 * check the new one starts. On failure, goes back to the old version. When the global folder needs
 * sudo, nothing runs: `command` is what to run instead.
 */
export function upgradeNpm(o: { to?: string; log?: (line: string) => void } = {}): { from: string; to: string; changed: boolean; command?: string } {
  const log = o.log ?? (() => {});
  const from = appVersion();
  log("looking for releases…");
  const tags = publishedTags();
  const tag = o.to ? `v${o.to.replace(/^v/, "")}` : newestInLine(from, tags);
  if (!tag) throw new Error(`no published ${PACKAGE} in the ${from.split(".").slice(0, 2).join(".")} line`);
  if (!tags.includes(tag)) throw new Error(`no release ${tag} (known: ${tags.slice(0, 5).join(", ")})`);
  const to = tag.slice(1);
  if (to === from) return { from, to, changed: false };
  // Into the prefix it came from (the global one, or ~/.local when that needed sudo).
  const prefix = NPM_PREFIX ?? npm("prefix", "-g").stdout.trim();
  const command = `npm install -g --prefix ${prefix} ${PACKAGE}@${to}`;
  if (!writable(prefix)) return { from, to, changed: false, command: `sudo ${command}` };
  const install = (v: string) => ok(npm("install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", `${PACKAGE}@${v}`), `npm install ${PACKAGE}@${v}`);
  log(`installing ${PACKAGE}@${to}…`);
  install(to);
  const check = spawnSync(process.execPath, [join(APP_DIR, "dist", "cli.js"), "version"], { encoding: "utf8" });
  if (check.status !== 0 || check.stdout.trim() !== to) {
    log(`the new version doesn't start here; going back to ${from}…`);
    install(from);
    throw new Error(`${PACKAGE}@${to} didn't start: ${(check.stderr || check.stdout).trim().split("\n").slice(-3).join(" ")}`);
  }
  return { from, to, changed: true };
}

/**
 * The newest release in this version's line ("0.3.4"), from the same feed `hewn upgrade` uses (npm,
 * or the checkout's release tags), checked in the background at most twice a day. null until known
 * or while offline.
 */
let latestCache: { at: number; value: string | null; running: boolean } = { at: 0, value: null, running: false };
const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<string>((resolve, reject) => execFile(cmd, args, { cwd, timeout: 15_000, encoding: "utf8" }, (e, out) => (e ? reject(e) : resolve(out))));
export function latestRelease(now = Date.now()): string | null {
  if (!latestCache.running && now - latestCache.at > 12 * 3600_000) {
    latestCache.running = true;
    const version = appVersion();
    const tags = isCheckout()
      ? run("git", ["ls-remote", "--tags", "--refs", "origin", "v*"], APP_DIR).then((out) => out.split("\n").map((l) => l.split("refs/tags/")[1]).filter((t): t is string => !!t && /^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(t)))
      : run("npm", ["view", PACKAGE, "versions", "--json"]).then((out) => publishedTags(() => out));
    tags
      .then((t) => (latestCache = { at: Date.now(), value: newestInLine(version, t)?.slice(1) ?? null, running: false }))
      .catch(() => (latestCache = { at: Date.now() - 11 * 3600_000, value: null, running: false }));
  }
  return latestCache.value;
}
