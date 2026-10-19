// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import type { Harness } from "./harnesses.ts";

/**
 * Runs a harness's OAuth login command, streaming its output lines. Resolves with the exit
 * code. Injectable for tests.
 */
export type LoginRunner = (argv: string[], onLine: (line: string) => void, signal: AbortSignal) => Promise<number>;

/** Terminal escapes (Claude Code's login runs under a pty): colours, hyperlinks, cursor moves. */
const plain = (s: string) => s.replace(/\x1b\]8;;[^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f]/g, "");

export const realLogin: LoginRunner = (argv, onLine, signal) =>
  new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], signal });
    let buf = "";
    const take = (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (plain(l).trim()) onLine(plain(l).trim());
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => (onLine(e.message), resolve(127)));
    child.on("close", (code) => (plain(buf).trim() && onLine(plain(buf).trim()), resolve(code ?? 1)));
  });

/** The owner has this long to approve before the login gives up (matches the request's lifetime). */
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The sign-in page the login asks to open (`<hewn>/authorize?…`), found in its output so far. Its
 * UI may hard-wrap a long URL: lines made only of URL characters continue it.
 */
export function authorizeUrl(output: string, hewnUrl: string): string | undefined {
  const start = `${new URL(hewnUrl).origin}/authorize?`;
  const lines = output.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(start));
  if (i === -1) return undefined;
  const chars = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;
  const first = lines[i].slice(lines[i].indexOf(start));
  let url = chars.exec(first)![0];
  for (let j = i + 1, ended = url.length === first.length; ended && j < lines.length; j++) {
    const m = chars.exec(lines[j]);
    if (!m || m[0].length !== lines[j].length) break;
    url += m[0];
  }
  return url.replace(/[).,;'\]]+$/, "");
}

const tilde = (path: string, home: string) => (path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path);

/**
 * Connect a local harness: register Hewn's address with it, add the pointer, then run its OAuth
 * login. Events: plan → step… → login (output lines, and `waiting` while the owner approves) → done.
 */
export async function connectHarness(
  h: Harness,
  ctx: { url: string; userHome: string },
  event: (name: string, data: unknown) => void,
  opts: { login?: LoginRunner; log?: (line: string) => void; timeoutMs?: number } = {},
): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const steps = h.steps({ url: ctx.url, home: ctx.userHome, pointer: h.pointerRequired });
  event("plan", { steps: [...steps.map((s) => ({ kind: s.kind, file: s.file ? tilde(s.file, ctx.userHome) : undefined })), { kind: "login" }] });
  for (const [i, s] of steps.entries()) {
    // Steps block (spawnSync); yield first so the previous event reaches the browser.
    await new Promise((r) => setTimeout(r, 20));
    try {
      s.run();
      event("step", { index: i, ok: true });
      log(`setup ${h.agentId}: ✔ ${s.describe}`);
    } catch (e) {
      event("step", { index: i, ok: false, error: (e as Error).message });
      log(`setup ${h.agentId}: ✖ ${s.describe}`);
      event("done", { ok: false, agentId: h.agentId });
      return false;
    }
  }
  event("login", { waiting: true, command: h.login(ctx.url).join(" ") });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  // A browser may not open (WSL, a service with no desktop session): offer the sign-in page in Hewn.
  let output = "";
  let offered: string | undefined;
  const onLine = (line: string) => {
    event("login", { line });
    output += line + "\n";
    const found = offered ? undefined : authorizeUrl(output, ctx.url);
    if (found) event("login", { authorizeUrl: (offered = found) });
  };
  const code = await (opts.login ?? realLogin)(h.login(ctx.url), onLine, abort.signal).finally(() => clearTimeout(timer));
  const ok = code === 0;
  event("step", ok ? { index: steps.length, ok: true } : { index: steps.length, ok: false, error: abort.signal.aborted ? "Not approved in time. Connect again to retry." : `${h.label} couldn't sign in. ${h.loginFix(output)}` });
  log(`setup ${h.agentId}: ${ok ? "✔" : "✖"} ${h.login(ctx.url).join(" ")}`);
  event("done", { ok, agentId: h.agentId });
  return ok;
}
