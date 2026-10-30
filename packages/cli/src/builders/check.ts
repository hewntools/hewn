// SPDX-License-Identifier: AGPL-3.0-or-later
// The builder's `check` tool on this machine. The builder's CLI starts a tiny stdio MCP server (the
// shim, below) inside the builder's sandbox. A call writes a request file in the workspace's scratch
// folder; Hewn sees it, checks the workspace as validation will (without promoting), and writes the
// result and the UI's screenshots back; the shim hands them to the builder. No port and no token:
// files in the one folder the builder may write. The host's builder offers the same check over its
// own protocol (remote.ts).
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, watch, writeSync, type FSWatcher } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { CheckResult } from "@hewntools/core/ports.ts";

/** The scratch folder in the workspace: a dot-folder, so never part of a version (`isBuilderConfig`). */
export const CHECK_DIR = ".hewn-check";
/** How long the shim waits for a check; the builders' MCP clients wait a little longer (their defaults are shorter: OpenCode's 60 s). */
export const CHECK_WAIT_MS = 300_000;
export const CHECK_CLIENT_TIMEOUT_MS = CHECK_WAIT_MS + 15_000;
/** The MCP server and its one tool, as each builder's config names them (Claude Code: mcp__hewn__check; OpenCode: hewn_check). */
export const CHECK_SERVER_NAME = "hewn";

/** How a builder's CLI starts the shim: Hewn's own Node, the shim copied into the scratch folder (the sandbox can't read Hewn's install). */
export interface CheckServer {
  command: string;
  args: string[];
}

/** A request's name: the shim's counter. Nothing else is answered, so a result's file name is never the builder's choice. */
const REQUEST = /^(c\d{1,6})\.json$/;

const DESCRIPTION =
  "Check your work as Hewn will before it goes live: the manifest, bundling, contracts, migrations, tests/cases.json, the sample data, the widgets, and your UI rendered filled with the sample data at 1280 and 390 px wide, light and dark, with what to fix measured on it. Returns PASS or FAIL with every failure, and the four screenshots (also written to screenshots/). Call it before you stop, fix what it shows, and call it again until it passes.";

/** The shim: plain JavaScript run by Hewn's Node, no dependencies. argv[2] is the scratch folder. */
export const CHECK_SHIM = `// Hewn's check tool for the builder: written by Hewn, run inside the builder's sandbox.
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const WAIT_MS = ${CHECK_WAIT_MS};
const DESCRIPTION = ${JSON.stringify(DESCRIPTION)};
mkdirSync(join(dir, "requests"), { recursive: true });
mkdirSync(join(dir, "results"), { recursive: true });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const answer = (id, result) => send({ jsonrpc: "2.0", id, result });
const failed = (text) => ({ content: [{ type: "text", text }], isError: true });
let n = 0;
const wait = (file) =>
  new Promise((resolve) => {
    let done = false;
    let watcher;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      try { watcher?.close(); } catch {}
      resolve(value);
    };
    const look = () => {
      if (!existsSync(file)) return;
      try { finish(JSON.parse(readFileSync(file, "utf8"))); } catch {}
    };
    try { watcher = watch(join(file, ".."), look); } catch {}
    const poll = setInterval(look, 250);
    const timer = setTimeout(() => finish({ error: "the check took too long; try again, or stop and let Hewn validate" }), WAIT_MS);
    look();
  });
const check = async () => {
  const id = "c" + ++n;
  const tmp = join(dir, "requests", id + ".json.tmp");
  writeFileSync(tmp, "{}");
  renameSync(tmp, join(dir, "requests", id + ".json"));
  const r = await wait(join(dir, "results", id + ".json"));
  if (typeof r.text !== "string") return failed("check unavailable: " + (r.error ?? "no result"));
  const images = [];
  for (const name of Array.isArray(r.images) ? r.images : []) {
    try { images.push({ type: "image", data: readFileSync(join(dir, "results", name)).toString("base64"), mimeType: "image/png" }); } catch {}
  }
  // Never isError for a check that ran, passed or not: some clients drop the images from an error.
  return { content: [{ type: "text", text: r.text }, ...images], isError: false };
};
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") answer(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hewn", version: "1" } });
    else if (m.method === "tools/list") answer(m.id, { tools: [{ name: "check", description: DESCRIPTION, inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
    else if (m.method === "tools/call") {
      if (m.params?.name !== "check") answer(m.id, failed("no such tool: " + m.params?.name));
      else check().then((r) => answer(m.id, r), (e) => answer(m.id, failed("check unavailable: " + e.message)));
    } else if (m.method === "ping") answer(m.id, {});
    else if (m.id !== undefined && typeof m.method === "string") send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** A folder inside the workspace, made where missing: each part a real folder, never a link. Its real path. */
function folderInside(workspace: string, rel: string): string {
  const root = realpathSync(workspace);
  let dir = root;
  for (const part of rel.split(sep).filter((p) => p && p !== ".")) {
    if (part === "..") throw new Error(`bad path ${rel}`);
    dir = join(dir, part);
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) mkdirSync(dir);
    else if (!st.isDirectory()) throw new Error(`${relative(root, dir)} isn't a folder`);
  }
  return dir;
}

/**
 * Write a file inside the workspace and only there: every folder on the way is a real folder (not a
 * link) inside it, and the file itself isn't followed if it's a link. Hewn runs unconfined; a builder
 * with a shell could otherwise point a folder at one of the owner's and have Hewn write into it.
 */
function writeInside(workspace: string, rel: string, data: Uint8Array | string) {
  const target = join(folderInside(workspace, dirname(rel)), rel.split(sep).at(-1)!);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(target);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
  } finally {
    closeSync(fd);
  }
}

/**
 * Offer `check` to a builder on this machine: the scratch folder made afresh with the shim in it,
 * and Hewn watching for its requests. `run` checks this build's workspace (the request names nothing
 * else). `close` stops watching and removes the folder.
 */
export function openCheck(workspace: string, run: (id: string) => Promise<CheckResult>): { server: CheckServer; close: () => void } {
  const dir = join(workspace, CHECK_DIR);
  rmSync(dir, { recursive: true, force: true });
  writeInside(workspace, join(CHECK_DIR, "shim.mjs"), CHECK_SHIM);
  folderInside(workspace, join(CHECK_DIR, "requests"));
  folderInside(workspace, join(CHECK_DIR, "results"));
  const seen = new Set<string>();
  let closed = false;
  const answerRequest = async (id: string) => {
    let out: Record<string, unknown>;
    try {
      const r = await run(id);
      const images: string[] = [];
      for (const img of r.images) {
        const name = img.name.replace(/[^a-z0-9-]/gi, "");
        writeInside(workspace, join(CHECK_DIR, "results", `${id}-${name}.png`), img.png);
        // Also where file tools find them, for a builder whose MCP client drops images.
        writeInside(workspace, join("screenshots", `${name}.png`), img.png);
        images.push(`${id}-${name}.png`);
      }
      out = { passed: r.passed, text: r.text, images };
    } catch (e) {
      out = { error: (e as Error).message };
    }
    if (closed) return;
    try {
      // Whole or not at all: the shim reads it as soon as it appears.
      writeInside(workspace, join(CHECK_DIR, "results", `${id}.json.tmp`), JSON.stringify(out));
      const results = folderInside(workspace, join(CHECK_DIR, "results"));
      renameSync(join(results, `${id}.json.tmp`), join(results, `${id}.json`));
    } catch {
      // The workspace changed under it (the build ended): no one is waiting.
    }
  };
  const scan = () => {
    if (closed || !existsSync(join(dir, "requests"))) return;
    for (const f of readdirSync(join(dir, "requests"))) {
      const id = REQUEST.exec(f)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      void answerRequest(id);
    }
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(join(dir, "requests"), scan);
    watcher.on("error", () => {});
  } catch {
    // polling below
  }
  const poll = setInterval(scan, 250);
  poll.unref?.();
  return {
    server: { command: process.execPath, args: [join(dir, "shim.mjs"), dir] },
    close: () => {
      closed = true;
      clearInterval(poll);
      watcher?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
