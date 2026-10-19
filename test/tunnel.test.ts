// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import { openHome, type Home } from "@hewntools/cli/home.ts";
import { parseTunnelLine, readTunnelConfig, Tunnel, tunnelCommand, validTunnelConfig } from "@hewntools/cli/supervisor/tunnel.ts";

/** A child process we control: write lines to its stderr, make it exit. */
function fakeSpawn() {
  const spawned: { argv: string[]; child: any }[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    spawned.push({ argv: [cmd, ...args], child });
    return child;
  }) as any;
  return { spawn, spawned, say: (line: string) => spawned.at(-1)!.child.stderr.write(`${line}\n`) };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("hewn tunnel", () => {
  let root: string;
  let home: Home;
  const logs: string[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hewn-tunnel-"));
    home = openHome(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("commands point at the public listener only", () => {
    assert.deepEqual(tunnelCommand({ kind: "quick" }, 7718), ["cloudflared", "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:7718"]);
    assert.deepEqual(tunnelCommand({ kind: "cloudflared", name: "hewn", hostname: "hewn.example.com" }, 7718), ["cloudflared", "tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:7718", "hewn"]);
    assert.deepEqual(tunnelCommand({ kind: "tailscale" }, 7718), ["tailscale", "funnel", "7718"]);
    assert.throws(() => validTunnelConfig({ kind: "cloudflared", name: "x; rm -rf /", hostname: "a.b" }));
    assert.throws(() => validTunnelConfig({ kind: "ngrok" }));
  });

  test("output parsing: quick URL, connected, tailscale URL", () => {
    assert.deepEqual(parseTunnelLine({ kind: "quick" }, "INF |  https://brave-otter-12.trycloudflare.com  |"), { url: "https://brave-otter-12.trycloudflare.com" });
    assert.deepEqual(parseTunnelLine({ kind: "quick" }, "INF Registered tunnel connection connIndex=0 location=arn01"), { state: "up" });
    assert.deepEqual(parseTunnelLine({ kind: "tailscale" }, "https://mac.tail1234.ts.net/"), { url: "https://mac.tail1234.ts.net", state: "up" });
    assert.equal(parseTunnelLine({ kind: "quick" }, "INF Starting metrics server"), undefined);
  });

  test("quick tunnel: starting → up with its URL; persisted; stop forgets it", async () => {
    const f = fakeSpawn();
    const t = new Tunnel(home, 7718, (l) => void logs.push(l), f.spawn);
    assert.equal(t.start({ kind: "quick" }).state, "starting");
    f.say("INF Requesting new quick Tunnel on trycloudflare.com...");
    f.say("INF |  https://brave-otter-12.trycloudflare.com  |");
    await tick();
    assert.equal(t.current().state, "starting", "not up before a connection registers");
    f.say("INF Registered tunnel connection connIndex=0");
    await tick();
    assert.deepEqual(t.current(), { kind: "quick", state: "up", url: "https://brave-otter-12.trycloudflare.com" });
    assert.deepEqual(readTunnelConfig(home), { kind: "quick" });
    assert.deepEqual(t.stop(), { kind: null, state: "off", url: null });
    assert.ok(!existsSync(join(root, "tunnel.json")));
  });

  test("resumes the configured tunnel; restarts it when it dies; missing binary is explained", async () => {
    const f = fakeSpawn();
    const t = new Tunnel(home, 7718, (l) => void logs.push(l), f.spawn);
    t.start({ kind: "cloudflared", name: "hewn", hostname: "hewn.example.com" });
    t.halt(); // Hewn stopping: the config stays
    const again = new Tunnel(home, 7718, (l) => void logs.push(l), f.spawn);
    again.resume();
    assert.equal(again.current().url, "https://hewn.example.com");
    f.spawned.at(-1)!.child.emit("exit", 1, null);
    assert.equal(again.current().state, "failed");
    assert.ok(logs.some((l) => /retrying in 2s/.test(l)));
    again.halt();

    const missing = new Tunnel(home, 7718, () => {}, f.spawn);
    missing.start({ kind: "tailscale" });
    f.spawned.at(-1)!.child.emit("error", Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }));
    assert.match(missing.current().error!, /tailscale isn't installed/);
    missing.halt();
  });
});
