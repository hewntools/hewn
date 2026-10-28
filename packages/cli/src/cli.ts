#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// SPDX-License-Identifier: AGPL-3.0-or-later
// The `hewn` CLI: runs Hewn (serve, service), and acts as the owner on it. Platform commands go to
// the running host (`hewn serve`) over its admin channel.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { backupLocation, backupNow, findBackup, listBackups, restoreBackup } from "./backup.ts";
import { BUILDERS, cliIntake, isCliAgent } from "./builders/cli-agents.ts";
import { startMetrics } from "./supervisor/metrics.ts";
import { connect, type PlatformClient, supervisorInfo } from "./cli-client.ts";
import { initConfig, readConfig, writeConfig } from "./config.ts";
import { formatChecks, runDoctor } from "./doctor.ts";
import { openHome } from "./home.ts";
import { openUrl as openInBrowser } from "./open-url.ts";
import { realSetupHooks } from "./setup/hooks.ts";
import { remoteBuilder, remoteIntake, remoteJobsFromEnv } from "./builders/remote.ts";
import * as service from "./service.ts";
import { defaultHome, harnesses, realExec } from "./setup/harnesses.ts";
import { runSetup } from "./setup/wizard.ts";
import { hostedFromEnv, startSupervisor, supervisorFile } from "./supervisor/index.ts";
import { checkFormat, writeFormat } from "./supervisor/format.ts";
import { renderUnicodeCompact } from "uqr";
import { dnsRecords, localSite, publicSite } from "@hewntools/host-workerd/surface/site.ts";
import { webOrigin } from "@hewntools/host-workerd/surface/web.ts";
import { APP_DIR, BUNDLED, NPM_PREFIX } from "./app-dir.ts";

const [cmd, ...args] = process.argv.slice(2);
const home = openHome();
const port = Number(process.env.HEWN_PORT ?? 7717);
const url = `http://127.0.0.1:${port}/mcp`;

const USAGE = `usage: hewn <command>

Run Hewn
  serve [--no-sandbox] run Hewn (workerd host, isolated tools) in this terminal
  service install [--force]|uninstall|start|stop|restart|status
                      run Hewn in the background (launchd on macOS, systemd user unit on Linux)
  doctor              check Hewn, the sandboxes, builders, agents, the secrets key and backups
  uninstall [--yes]   remove the service, agent registrations and the hewn command (asks first;
                      --yes doesn't). Your data and backups stay; it says how to remove them
  upgrade [--to <tag>]
                      move to the newest release in your 0.x line (or <tag>), install it, back up, restart
                      (data is migrated at start); --restart-only skips the move

Use it (as the owner; talks to the running Hewn)
  open [id]           open Hewn in the browser, or a tool's UI directly
                      --print: print a sign-in link instead (on the public URL, with a QR code; --local for this machine's)
  url [<https://…> | --clear] [--listen <address> | --listen off]
                      the public URL: use Hewn from your phone or anywhere (prints the DNS records and proxy setup)
  status              tools and recent builds
  feedback [--days N] [--json]
                      how recent builds worked out: your answers to "Got what you asked for?", attempts,
                      what they ran on, and the signs in the record (a fix, a change soon after, a restore, a delete)
  install <dir | file.hewn.zip> [--name <name>] [--no-sample]
                      install a tool from a source dir, or from a file someone shared (with its sample data)
  share <id> [--version N] [--out file.hewn.zip]
                      a tool as a file to give someone: what's in it (personal data, keys, your settings) first;
                      refused if it holds one of your own keys or has no sample data
  connect <id>        give a tool what it needs: config, secrets (hidden prompt or --from <path>) + approval;
                      a connection with a sign-in step asks you to sign in (--again to sign in anew)
  accounts            connections to external services: health and what uses them
  models              the model provider, tiers, budget and this month's spend
                      models key <provider> [--from <path>|--remove] | use <provider> | list
                      | tier <tier> <model-id>|--suggested | cap [<tool>] <usd>|none
                      | price <provider/model> <in> <out> (USD per M tokens) | check
                      | set <tool> <tier>|<provider/model> (what it uses; no builder)
  config <id> [NAME value]
                      show a tool's config (non-secret settings like a site URL), or set one
  secrets list|set|import|rm <id> [NAME] [--from <path>]
  grants [id]         show requested / approved authority; grants approve <id> [grant]; grants deny <id> <grant>
  schedules [id]      list schedules; schedules add <id> <op> "<cadence>" [json input] | pause|resume|rm <schedule>
  logs <id> [-f] [-n N]
                      a tool's call log
  watch [buildId]     follow a build live (default: the current one, or wait for the next)
  review [approve|reject <buildId>]
                      agents' changes waiting for you (to a connection, or adding operations)
  restore <id>        bring back a deleted tool, with its data
  rollback <id> [version]
  export <id> [--out file.json]
  data reset <id> [--sample]
                      Start over: empty a tool's data and keep the tool (a backup is kept; asks you to
                      type the id); --sample replays its sample data after
  purge <id>          permanently delete a deleted tool (asks you to type the id)
  backup now|list|restore <date|file>|dir <path>
                      zipped snapshots (never secrets in plain text, never agent tokens)

Agents (MCP clients sign in with OAuth; you approve them)
  setup [--agents claude-code,codex,opencode] [--yes] [--dry-run]
                      connect local agents: registers Hewn with them, then they sign in
  agents              connected agents; agents pending | approve <code> [--scopes a,b] [--name n] [--only id,id]
                      | deny <code> | scopes <agent> a,b | revoke <agent>
  tunnel [status]     reach Hewn from cloud agents (claude.ai, ChatGPT): only MCP and sign-in are exposed
  tunnel start [--quick | --cloudflared <tunnel> --hostname <host> | --tailscale] | stop`;

const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const positional = () => args.filter((x, i) => !x.startsWith("-") && !["--from", "--out", "-n", "--scopes", "--name", "--only", "--cloudflared", "--hostname", "--agents", "--listen", "--days"].includes(args[i - 1] ?? ""));

/** The client for owner commands; prints a clear error and exits on failure. */
async function owner<T>(fn: (c: PlatformClient) => Promise<T>): Promise<T | undefined> {
  let client: PlatformClient | undefined;
  try {
    client = await connect(home);
    return await fn(client);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

const openUrl = (target: string) => {
  if (flag("print")) return console.log(target);
  if (!openInBrowser(target)) console.log(`Couldn't open a browser here. Open this link yourself:\n  ${target}`);
};

async function main() {
  switch (cmd) {
    case "serve": {
      // The workerd host: isolated capabilities, run by the supervisor. Foreground; Ctrl-C stops it.
      const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
      if (process.env.HEWN_LOG_FILE) service.logToFile(process.env.HEWN_LOG_FILE);
      const format = checkFormat(home);
      if (format.refuse) throw new Error(format.refuse);
      if (format.upgradeFrom !== undefined && format.hasData) {
        const b = backupNow(home, backupLocation(home, readConfig(home).backupDir).dir);
        log(`data format ${format.upgradeFrom} → ${format.current}: backed up first (${b.file})`);
      }
      const upgrade = await import("./upgrade.ts");
      // A host that runs Hewn's builder and intake on its own keys (HEWN_BUILD_URL) adds "remote".
      const remote = remoteJobsFromEnv();
      if (remote) log(`builder and intake: also ${remote.label} (${new URL(remote.url).host})`);
      // A host that runs this Hewn for its owner, who has no terminal (HEWN_HOSTED).
      const hosted = hostedFromEnv();
      if (hosted) log("hosted: the web client sends the owner to the host, not to a terminal");
      const sv = await startSupervisor({
        home,
        port,
        publicPort: process.env.HEWN_PUBLIC_PORT ? Number(process.env.HEWN_PUBLIC_PORT) : undefined,
        publicListen: readConfig(home).publicListen,
        builders: remote ? { ...BUILDERS, remote: remoteBuilder(remote) } : BUILDERS,
        intake: (which, run) => {
          if (which === "remote") {
            if (!remote) throw new Error("the host's intake isn't configured here (HEWN_BUILD_URL); pick another in Settings › AI");
            return remoteIntake(remote, run);
          }
          if (!isCliAgent(which)) throw new Error(`no intake named ${which}; pick one in Settings › AI`);
          return cliIntake(which, home.root, run);
        },
        ...(remote ? { remote } : {}),
        ...(hosted ? { hosted } : {}),
        setup: await realSetupHooks(),
        sandbox: !flag("no-sandbox"),
        sandboxBuilders: () => readConfig(home).sandbox,
        latest: upgrade.latestRelease,
        // Only once a newer release is out: then its notes are fetched (at most twice a day).
        latestNotes: () => (upgrade.latestRelease() && upgrade.latestRelease() !== upgrade.appVersion() ? upgrade.latestNotes() : []),
        log,
      });
      writeFormat(home);
      writeFileSync(supervisorFile(home), JSON.stringify({ url: sv.url, adminToken: sv.adminToken, control: sv.control, publicListener: sv.publicNetwork ?? sv.publicUrl, pid: process.pid }) + "\n", { mode: 0o600 });
      // Off unless set: a host that scrapes Hewn turns it on.
      const metricsPort = Number(process.env.HEWN_METRICS_PORT ?? 0);
      if (metricsPort) startMetrics({ port: metricsPort, url: sv.url, adminToken: sv.adminToken, version: (await import("./upgrade.ts")).appVersion(), log });
      log(`Hewn on ${webOrigin(port)} · MCP ${sv.url}/mcp · tunnels point at ${sv.publicUrl}${sv.publicNetwork ? ` · public listener also on ${sv.publicNetwork}` : ""} · home ${home.root}${flag("no-sandbox") ? " · workerd sandbox OFF" : ""}`);
      log(`Sign in: hewn open`);
      const stop = async () => {
        rmSync(supervisorFile(home), { force: true });
        await sv.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => {});
      return;
    }

    case "service": {
      const sub = args[0] ?? "status";
      if (sub === "install") {
        service.install(service.defaultSpec(home.root, port), { force: flag("force") });
        console.log(`✔ Hewn installed as a ${service.KIND} service: starts at login, restarts if it stops\n  log: ${service.logFile(home.root)}`);
      } else if (sub === "uninstall") {
        service.uninstall();
        console.log("✔ service removed");
      } else if (sub === "start") service.start(), console.log("✔ started");
      else if (sub === "restart") service.restart(), console.log("✔ restarted");
      else if (sub === "stop") console.log(service.stop() ? "✔ stopped (it starts again at next login; hewn service start to start it now)" : "not running (hewn service start to start it)");
      else if (sub === "status") {
        const st = service.status();
        // Report on the installed service, not on this shell's HEWN_HOME / HEWN_PORT.
        const svc = service.installed() ?? { homeRoot: home.root, port };
        const healthy = await fetch(`http://127.0.0.1:${svc.port}/health`).then((r) => r.ok, () => false);
        console.log(st.installed ? `installed (${service.unitPath()})\nhome: ${svc.homeRoot}` : "not installed: hewn service install");
        console.log(st.running ? `running${st.pid ? `, pid ${st.pid}` : ""}` : st.loaded ? `loaded, not running${st.lastExit ? ` (last exit: ${st.lastExit})` : ""}` : "not loaded");
        console.log(healthy ? `answering on port ${svc.port}` : `nothing answering on port ${svc.port}`);
        console.log(`log: ${service.logFile(svc.homeRoot)}`);
      } else throw new Error(`unknown: service ${sub}`);
      return;
    }

    case "upgrade": {
      // Move the checkout to the newest release (or --to <tag>), install it, check it builds.
      // Then: data is migrated by the new code at start (with a backup first).
      const { isCheckout, upgradeCheckout, upgradeNpm } = await import("./upgrade.ts");
      if (BUNDLED && !flag("restart-only")) {
        const r = upgradeNpm({ to: option("to"), log: (l) => console.log(`  ${l}`) });
        if (r.command) return console.log(`Hewn ${r.to} is out. npm needs more rights here; run:\n  ${r.command}\nthen: hewn upgrade --restart-only`);
        if (!r.changed) return console.log(`✔ already on ${r.to}`);
        console.log(`✔ ${r.from} → ${r.to}`);
      } else if (isCheckout() && !flag("restart-only")) {
        const r = await upgradeCheckout({ to: option("to"), log: (l) => console.log(`  ${l}`) });
        if (!r.changed) return console.log(`✔ already on ${r.to}`);
        console.log(`✔ ${r.from} → ${r.to}`);
      }
      const b = backupNow(home, backupLocation(home, readConfig(home).backupDir).dir);
      console.log(`✔ backed up: ${b.file}`);
      if (service.status().installed) {
        service.restart();
        console.log("✔ restarted on the installed code");
      } else console.log("Now restart hewn serve (it upgrades the data format at start).");
      return;
    }

    case "uninstall": {
      const { uninstallPlan } = await import("./uninstall.ts");
      const { defaultKeySource } = await import("./supervisor/master-key.ts");
      const npmBin = (() => {
        const r = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8" });
        return r.status === 0 ? [join(r.stdout.trim(), "bin")] : [];
      })();
      const st = service.status();
      const plan = uninstallPlan({
        homeRoot: home.root,
        backupDir: backupLocation(home, readConfig(home).backupDir).dir,
        appDir: APP_DIR,
        bundled: BUNDLED,
        npmPrefix: NPM_PREFIX,
        userHome: defaultHome(),
        harnesses: harnesses(),
        exec: realExec,
        service: { installed: st.installed || st.loaded, uninstall: () => service.uninstall() },
        binDirs: [...npmBin, join(defaultHome(), ".local", "bin")],
        keySource: defaultKeySource(home.root),
        linux: process.platform === "linux",
      });
      let yes = flag("yes");
      if (!plan.steps.length) console.log("Nothing to remove: no service, agent registrations or hewn command.");
      else if (!yes) {
        console.log("This removes:");
        for (const s of plan.steps) console.log(`  - ${s.describe}`);
        if (process.stdin.isTTY) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          yes = /^y(es)?$/i.test((await rl.question("Remove them? [y/N] ")).trim());
          rl.close();
        }
        if (!yes) console.log(process.stdin.isTTY ? "Nothing removed." : "Nothing removed (not a terminal: run hewn uninstall --yes).");
      }
      for (const s of yes ? plan.steps : []) {
        try {
          s.run();
          console.log(`  ✔ ${s.describe}`);
        } catch (e) {
          process.exitCode = 1;
          console.log(`  ✖ ${s.describe}: ${(e as Error).message}`);
        }
      }
      console.log("\nKept (remove them yourself when you're sure):");
      for (const l of plan.leftovers) console.log(`  ${l}`);
      return;
    }

    case "version":
    case "--version":
      return console.log((await import("./upgrade.ts")).appVersion());

    case "doctor": {
      const info = supervisorInfo(home);
      const ctl = info ? (path: string) => fetch(`${info.control.url}${path}`, { method: "POST", headers: { "x-hewn-control": info.control.token, "content-type": "application/json" }, body: "{}" }).then((r) => (r.ok ? r.json() : undefined)) : undefined;
      const checks = await runDoctor({
        home,
        port: info ? Number(new URL(info.url).port) : port,
        userHome: defaultHome(),
        harnesses: harnesses(),
        service: () => service.status(),
        control: ctl ? () => ctl("/control/status") as any : undefined,
        tunnel: ctl ? () => ctl("/control/tunnel") as any : undefined,
        pendingAgents: info
          ? async () => ((await fetch(`${info.url}/_admin/call`, { method: "POST", headers: { "x-hewn-admin": info.adminToken, "content-type": "application/json" }, body: JSON.stringify({ method: "pendingAgents" }) }).then((r) => r.json())) as { result: unknown[] }).result.length
          : undefined,
        unreadableSecrets: info
          ? async () => ((await fetch(`${info.url}/_admin/call`, { method: "POST", headers: { "x-hewn-admin": info.adminToken, "content-type": "application/json" }, body: JSON.stringify({ method: "unreadableSecrets" }) }).then((r) => r.json())) as { result: { capabilityId: string; name: string }[] }).result
          : undefined,
        settings: info
          ? async () => (await fetch(`${info.url}/_admin/settings`, { headers: { "x-hewn-admin": info.adminToken } }).then((r) => r.json())) as { builder: string; intake: string }
          : undefined,
      });
      console.log(formatChecks(checks));
      if (checks.some((c) => c.state === "fail")) process.exitCode = 1;
      return;
    }

    case "open": {
      const id = positional()[0];
      await owner(async (c) => {
        const p = c.url ? Number(new URL(c.url).port) : port;
        const ticket = () => (id ? c.call("createUiTicket", id) : c.call("createWebTicket"));
        // --print is for another device (over SSH): the public URL's link when there is one.
        const publicUrl: string | null = flag("print") && !flag("local") ? await c.call("publicUrl") : null;
        if (publicUrl) {
          const site = publicSite(publicUrl);
          const target = `${id ? site.ui(id) : site.web}/auth?ticket=${await ticket()}`;
          console.log(renderUnicodeCompact(target, { border: 2 }));
          console.log(`Scan it with your phone, or open the link below on any device. It works once, for 2 minutes;${id ? "" : " then add a passkey there to sign in without a link."}\n`);
          return console.log(target);
        }
        const site = localSite(p);
        const target = `${id ? site.ui(id) : site.web}/auth?ticket=${await ticket()}`;
        if (!flag("print")) console.log(`Opening ${id ? site.ui(id) : site.web} (link valid 2 minutes, single use)`);
        openUrl(target);
      });
      return;
    }

    case "url":
      return void (await owner((c) => urlCommand(c)));

    case "status":
      await owner(async (c) => {
        console.log(`Hewn at ${c.url}`);
        const caps = await c.call("list");
        console.table(caps.map((x: any) => ({ id: x.id, name: x.name, ready: x.ready })));
        if (c.control) {
          const st = await c.control("/control/status");
          console.log(`up ${st.upSeconds}s · workerd restarts ${st.restarts} · secrets key: ${st.keySource} · sandbox ${st.sandbox ? "on" : "OFF"} · last backup ${st.backups.last?.date ?? "none"}`);
        }
      });
      return;

    case "accounts":
      await owner(async (c) => {
        const { connections } = await c.call("accounts");
        if (!connections.length) console.log("No connections yet. They're built when a tool needs an external service.");
        for (const x of connections) {
          const users = x.usedBy.map((u: any) => u.id).join(", ") || "nothing yet";
          console.log(`${x.health.status === "connected" ? "✔" : "✖"} ${x.name} (${x.id}): ${x.health.status}${x.health.detail ? ` — ${x.health.detail}` : ""}\n    used by ${users}`);
        }
      });
      return;

    case "install": {
      const dir = resolve(positional()[0] ?? "");
      const info = supervisorInfo(home);
      if (!info) throw new Error("Hewn isn't running: start it with hewn serve (or hewn service install)");
      // A shared tool's file (a zip): installed under its name (or --name), with its sample data unless --no-sample.
      const zip = statSync(dir, { throwIfNoEntry: false })?.isFile();
      const manifest = zip ? null : JSON.parse(readFileSync(resolve(dir, "capability.json"), "utf8"));
      const body = zip ? { bundle: readFileSync(dir).toString("base64"), ...(option("name") ? { name: option("name") } : {}), sample: !args.includes("--no-sample"), wait: true } : { name: manifest.name, purpose: manifest.purpose, dir, wait: true };
      const res = await fetch(`${info.url}/_admin/install`, { method: "POST", headers: { "x-hewn-admin": info.adminToken, "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = (await res.json()) as any;
      if (!res.ok) throw new Error(result.message ?? result.error);
      console.log(result.status === "promoted" ? `✔ ${result.capabilityId} v${result.resultVersion}` : `✖ ${result.failure?.title ?? result.status}\n${result.log.join("\n")}`);
      process.exitCode = result.status === "promoted" ? 0 : 1;
      return;
    }

    case "connect":
    case "config":
    case "secrets":
    case "grants": {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await owner((c) => authority(c, cmd, rl));
      rl.close();
      return;
    }

    case "schedules":
      await owner((c) => schedules(c));
      return;

    case "models": {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await owner((c) => models(c, rl));
      rl.close();
      return;
    }

    case "review":
      await owner(async (c) => {
        const [action, id] = positional();
        if (action === "approve" || action === "reject") {
          if (!id) throw new Error(`usage: hewn review ${action} <buildId>`);
          const b = await c.call(action === "approve" ? "approveBuild" : "rejectBuild", id);
          console.log(b.status === "promoted" ? `✔ ${b.capabilityId}: v${b.resultVersion} is live` : b.status === "cancelled" ? `✔ turned down: ${b.capabilityId} is unchanged` : `✖ ${b.log.at(-1)}`);
          return;
        }
        if (action) throw new Error("usage: hewn review [approve|reject <buildId>]");
        const list = await c.call("buildsInReview");
        if (!list.length) return void console.log("Nothing waits for your review.");
        const verb: Record<string, string> = { read: "READ", write: "CHANGE", destructive: "DELETE" };
        for (const b of list) {
          const r = b.review;
          console.log(`${b.buildId}  ${b.requestedBy} wants to ${r.newOperations.length ? "add to" : "change"} ${b.capabilityId}`);
          if (r.connection) console.log("    it's a connection: this code holds your sign-in for that service");
          for (const o of r.newOperations) {
            console.log(`    + ${o.key}: agents can then ${verb[o.sideEffect] ?? o.sideEffect}: ${o.description}`);
            if (o.example) console.log(o.example.split("\n").slice(0, 8).map((l: string) => `        ${l}`).join("\n"));
          }
          const c = r.changes;
          if (c) {
            const also = [c.ui && "the screen", c.migrations.length && `data (${c.migrations.join(", ")})`, c.newGrants.length && `new access (${c.newGrants.join(", ")})`, c.changedOperations.length && `updates ${c.changedOperations.join(", ")}`, c.removedOperations.length && `removes ${c.removedOperations.join(", ")}`].filter(Boolean);
            console.log(`    ${also.length ? `also changes: ${also.join("; ")}` : "nothing else changes"}`);
          }
          console.log(`    asked: "${String(b.request.request ?? "").slice(0, 160)}"`);
        }
        console.log("\nAllow: hewn review approve <buildId>   Don't allow: hewn review reject <buildId>");
      });
      return;

    case "restore":
      await owner(async (c) => {
        await c.call("restore", positional()[0] ?? "");
        console.log(`✔ ${positional()[0]} restored`);
      });
      return;

    case "rollback":
      await owner(async (c) => {
        const [id, v] = positional();
        const { from, to } = await c.call("rollback", id ?? "", v ? Number(v.replace(/^v/, "")) : undefined);
        console.log(`✔ ${id}: v${from} → v${to}`);
      });
      return;

    case "export":
      await owner(async (c) => {
        const data = JSON.stringify(await c.call("exportData", positional()[0] ?? ""), null, 2);
        const out = option("out");
        if (out) writeFileSync(out, data + "\n"), console.error(`✔ wrote ${out}`);
        else console.log(data);
      });
      return;

    case "share": {
      const id = positional()[0] ?? "";
      const info = supervisorInfo(home);
      if (!info) throw new Error("Hewn isn't running: start it with hewn serve (or hewn service install)");
      const version = option("version");
      const res = await fetch(`${info.url}/_admin/share`, { method: "POST", headers: { "x-hewn-admin": info.adminToken, "content-type": "application/json" }, body: JSON.stringify({ capabilityId: id, ...(version ? { version: Number(version.replace(/^v/, "")) } : {}) }) });
      const out = (await res.json()) as any;
      if (!res.ok) throw new Error(out.message ?? out.error);
      const { check } = out;
      console.log(`${check.name} v${check.version}: ${check.files} files${check.sample ? `, sample data (${check.sample.calls} calls)` : ""}`);
      for (const f of check.findings) console.log(`  ${f.kind === "secret" ? "✖" : "!"} ${f.file}:${f.line}  ${f.label}: ${f.masked}`);
      if (!check.findings.length) console.log("  nothing personal or key-shaped found");
      console.log("  never in it: your data, keys, settings, conversations, logs");
      if (check.blocked?.kind === "secret") {
        process.exitCode = 1;
        return void console.error(`✖ your own keys are in it (✖ above: ${check.findings.filter((f: any) => f.kind === "secret").map((f: any) => `${f.file}:${f.line}`).join(", ")}). Remove them, then share again.`);
      }
      if (check.blocked?.kind === "no-sample") {
        process.exitCode = 1;
        return void console.error(`✖ ${id} has no sample data (sample/calls.json), and a tool needs it to be shared. Open Share… on it in Hewn: Ask builder adds some, or write it yourself.`);
      }
      const file = resolve(option("out") ?? out.name);
      writeFileSync(file, Buffer.from(out.bundle, "base64"));
      console.log(`✔ wrote ${file}`);
      return;
    }

    case "data": {
      const [sub, id] = positional();
      if (sub !== "reset" || !id) throw new Error("usage: hewn data reset <id> [--sample]");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const typed = (await rl.question(`Start ${id} over: its data is emptied (a backup is kept), the tool stays.\nType ${id} to confirm: `)).trim();
      rl.close();
      await owner(async (c) => {
        const r = await c.call("startOver", id, { confirm: typed, sample: args.includes("--sample") });
        console.log(`✔ ${id} started over${r.backup ? ` (backup kept: ${r.backup})` : ""}${r.sample ? (r.sample.failed ? `; sample data stopped at call ${r.sample.failed.index + 1} (${r.sample.failed.operation}): ${r.sample.failed.error}` : `; sample data: ${r.sample.calls} calls`) : ""}`);
      });
      return;
    }

    case "purge": {
      const id = positional()[0] ?? "";
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const typed = (await rl.question(`Permanently delete ${id}: its code, versions, data, logs and secrets. This can't be undone.\nType ${id} to confirm: `)).trim();
      rl.close();
      await owner(async (c) => {
        await c.call("purge", id, typed);
        console.log(`✔ ${id} permanently deleted`);
      });
      return;
    }

    case "backup": {
      const sub = args[0] ?? "list";
      const info = supervisorInfo(home);
      const running = info && (await fetch(`${info.url}/health`).then((r) => r.ok, () => false));
      const ctl = async (path: string, body: unknown = {}) => {
        const res = await fetch(`${info!.control.url}${path}`, { method: "POST", headers: { "x-hewn-control": info!.control.token, "content-type": "application/json" }, body: JSON.stringify(body) });
        const out = (await res.json()) as any;
        if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
        return out;
      };
      const dir = backupLocation(home, readConfig(home).backupDir).dir;
      if (sub === "dir") {
        if (!args[1]) return console.log(dir);
        writeConfig(home, { backupDir: resolve(args[1]) });
        return console.log(`✔ backups go to ${resolve(args[1])}`);
      }
      if (sub === "now") {
        const b = running ? await ctl("/control/backup") : backupNow(home, dir);
        return console.log(`✔ ${b.file} (${(b.bytes / 1024).toFixed(0)} KB)`);
      }
      if (sub === "list") {
        console.log(dir);
        const all = listBackups(dir);
        if (!all.length) return console.log("  no backups yet: hewn backup now");
        for (const b of all) console.log(`  ${b.date}  ${(b.bytes / 1024).toFixed(0).padStart(7)} KB  ${b.name}`);
        return;
      }
      if (sub === "restore") {
        if (!args[1]) throw new Error("usage: hewn backup restore <date|file>");
        const file = findBackup(dir, args[1]);
        // A running Hewn stops, restores and starts again; otherwise restore in place.
        const r = running ? await ctl("/control/restore", { file }) : restoreBackup(home, file);
        console.log(`✔ restored ${file}\n  what it replaced is kept at ${r.aside}`);
        if (running) {
          const lost = ((await owner((c) => c.call("unreadableSecrets"))) ?? []) as { capabilityId: string; name: string }[];
          if (lost.length) console.log(`! ${lost.length} secret(s) were stored with another secrets key (another machine or home) and count as not set: ${lost.map((s) => `${s.capabilityId} ${s.name}`).join(", ")}\n  Set them again (open each tool), or see docs/data.md to bring the old key.`);
        }
        return;
      }
      throw new Error(`unknown: backup ${sub}`);
    }

    case "logs": {
      const id = positional()[0];
      if (!id) return void ((process.exitCode = 1), console.error("usage: hewn logs <tool> [-f] [-n N]"));
      const n = Number(option("n") ?? args[args.indexOf("-n") + 1] ?? 50) || 50;
      await owner(async (c) => {
        let seen: string[] = await c.call("logLines", id, n);
        if (!seen.length) console.error(`no log entries for ${id} yet`);
        for (const l of seen) console.log(l);
        if (!args.includes("-f")) return;
        for (;;) {
          await sleep(500);
          const now: string[] = await c.call("logLines", id, 500);
          const last = seen.at(-1);
          const from = last === undefined ? 0 : now.lastIndexOf(last) + 1;
          for (const l of now.slice(from)) console.log(l);
          if (now.length) seen = now;
        }
      });
      return;
    }

    case "feedback": {
      // How recent builds worked out: the owner's answer to "Got what you asked for?" and the signs in
      // the record. Stays here; a host reads it the same way, in the machine.
      await owner(async (c) => {
        const days = Number(option("days"));
        const report = await c.call("buildReport", days ? { days } : {});
        if (flag("json")) return void console.log(JSON.stringify(report, null, 2));
        const rows = report.builds;
        if (!rows.length) return void console.log(`No builds in the last ${report.days} days.`);
        console.table(
          rows.map((r: any) => ({
            build: r.buildId,
            tool: r.capabilityId,
            kind: r.kind,
            status: r.status,
            attempts: r.attempts,
            model: r.ranModel ?? r.model ?? "default",
            brief: r.brief ?? "",
            answer: r.feedback?.score ?? "",
            note: r.feedback?.note ?? "",
            signs: Object.entries(r.signals).filter(([, v]) => v).map(([k]) => k).join(" "),
          })),
        );
        const asked = rows.filter((r: any) => r.feedback && r.feedback.score !== "skip");
        if (asked.length) console.log(`${asked.filter((r: any) => r.feedback.score === "yes").length} of ${asked.length} answered builds got what was asked for.`);
      });
      return;
    }

    case "watch": {
      // Follow one build: the transcript (on this machine, where builders run) until it settles.
      await owner(async (c) => {
        let found: string | undefined = positional()[0];
        if (!found) {
          console.error("No build in progress. Waiting for the next one… (Ctrl-C to stop)");
          const before = new Set(existsSync(home.builds) ? readdirSync(home.builds) : []);
          while (!found) {
            await sleep(1000);
            found = (existsSync(home.builds) ? readdirSync(home.builds) : []).find((f) => f.endsWith(".log") && !before.has(f))?.replace(/\.log$/, "");
          }
        }
        const id: string = found;
        const b = await c.call("getBuild", id);
        console.error(`build ${id}: ${b.kind} ${b.capabilityId}, builder ${b.builder}\n`);
        const log = `${home.builds}/${id}.log`;
        let offset = 0;
        const flush = () => {
          if (!existsSync(log)) return;
          const buf = readFileSync(log);
          if (buf.length > offset) process.stdout.write(buf.subarray(offset)), (offset = buf.length);
        };
        for (;;) {
          flush();
          const status = (await c.call("getBuild", id)).status;
          if (["promoted", "failed", "cancelled"].includes(status)) {
            flush();
            console.error(`\nbuild ${id} ${status}`);
            process.exitCode = status === "promoted" ? 0 : 1;
            return;
          }
          await sleep(500);
        }
      });
      return;
    }

    case "setup": {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await owner(async (c) => {
          const result = await runSetup({
            home,
            url,
            userHome: defaultHome(),
            harnesses: harnesses(),
            io: { ask: (q, signal) => (signal ? rl.question(q, { signal }) : rl.question(q)), print: (l) => console.log(l) },
            agents: option("agents")?.split(","),
            pointer: flag("pointer") ? true : flag("no-pointer") ? false : undefined,
            yes: flag("yes"),
            dryRun: flag("dry-run"),
            approvals: { pending: () => c.call("pendingAgents"), decide: (id, d) => c.call("decideAgent", id, d) },
          });
          process.exitCode = result.failed.length ? 1 : 0;
        });
      } finally {
        rl.close();
      }
      return;
    }

    case "agents":
      return void (await owner((c) => agentsCommand(c)));

    case "tunnel":
      return void (await owner((c) => tunnelCommand(c)));

    default:
      console.log(USAGE);
      process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
}

/** Read a secret value from a file, or a directory as a JSON object {filename: content}. */
function readSecretSource(path: string): string {
  if (statSync(path).isDirectory()) {
    const files = readdirSync(path).filter((f) => statSync(`${path}/${f}`).isFile());
    return JSON.stringify(Object.fromEntries(files.map((f) => [f, readFileSync(`${path}/${f}`, "utf8")])));
  }
  return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}

/** Prompt without echoing the typed value. */
async function askHidden(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  const out = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
  const original = out._writeToOutput;
  out._writeToOutput = (s: string) => {
    if (s.startsWith(prompt)) out.output.write(prompt);
    else if (s === "\r\n" || s === "\n") out.output.write(s);
  };
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    out._writeToOutput = original;
  }
}

const SCOPE_WORDS: Record<string, string> = { discover: "see your tools", invoke: "use them", create: "make new ones", modify: "change existing ones", manage: "manage", delete: "delete" };

async function agentsCommand(c: PlatformClient) {
  const [sub, target, extra] = positional();
  const findPending = async (code: string) => {
    const all = (await c.call("pendingAgents")) as { id: string; userCode: string; clientName: string }[];
    const p = all.find((x) => x.userCode.toUpperCase() === code.toUpperCase() || x.id === code);
    if (!p) throw new Error(`no pending request with code ${code} (hewn agents pending)`);
    return p;
  };
  switch (sub ?? "list") {
    case "list": {
      const agents = (await c.call("agents")) as { id: string; name: string; scopes: string[]; capabilities: "*" | string[]; via: string; lastUsedAt: string | null }[];
      if (!agents.length) console.log("No agents yet. Connect one: hewn setup (local), or add Hewn's address in the agent (hewn tunnel for cloud agents).");
      for (const a of agents) console.log(`${a.id.padEnd(16)} ${a.scopes.join(",") || "(no access)"}${a.capabilities === "*" ? "" : ` · only ${a.capabilities.join(", ")}`} · ${a.via} · ${a.lastUsedAt ? `last used ${a.lastUsedAt.slice(0, 16).replace("T", " ")}` : "not used yet"}`);
      const pending = (await c.call("pendingAgents")) as unknown[];
      if (pending.length) console.log(`\n${pending.length} waiting for approval: hewn agents pending`);
      return;
    }
    case "pending": {
      const pending = (await c.call("pendingAgents")) as { userCode: string; clientName: string; redirectHost: string; requested: string[]; suggested: string[]; via: string; reconnects: string | null }[];
      if (!pending.length) return console.log("Nothing waiting.");
      for (const p of pending) {
        console.log(`${p.userCode}  ${p.clientName} (${p.via}, returns to ${p.redirectHost})${p.reconnects ? ` · reconnects ${p.reconnects}` : ""}`);
        console.log(`           asks to: ${p.requested.map((s) => SCOPE_WORDS[s] ?? s).join(", ")}`);
      }
      console.log(`\nApprove: hewn agents approve <code> [--scopes ${pending[0].suggested.join(",")}] [--only <tool ids>]   Decline: hewn agents deny <code>`);
      return;
    }
    case "approve": {
      if (!target) throw new Error("usage: hewn agents approve <code> [--scopes discover,invoke] [--name <agent name>] [--only id,id]");
      const p = await findPending(target);
      const r = (await c.call("decideAgent", p.id, { approve: true, name: option("name"), scopes: option("scopes")?.split(","), capabilities: option("only")?.split(",") })) as { agentId: string };
      return console.log(`✔ ${p.clientName} connected as '${r.agentId}'. Its browser tab returns to it now.`);
    }
    case "deny": {
      if (!target) throw new Error("usage: hewn agents deny <code>");
      const p = await findPending(target);
      await c.call("decideAgent", p.id, { approve: false });
      return console.log(`Declined ${p.clientName}.`);
    }
    case "scopes": {
      if (!target || !extra) throw new Error("usage: hewn agents scopes <agent> discover,invoke");
      await c.call("updateAgent", target, { scopes: extra.split(",").filter(Boolean) });
      return console.log(`✔ ${target}: ${extra}`);
    }
    case "revoke": {
      if (!target) throw new Error("usage: hewn agents revoke <agent>");
      await c.call("updateAgent", target, "revoke");
      return console.log(`✔ ${target} revoked: its next call fails. Connect it again to restore access.`);
    }
    default:
      throw new Error("usage: hewn agents [list | pending | approve <code> | deny <code> | scopes <agent> <scopes> | revoke <agent>]");
  }
}

/** hewn url: the public URL (where the owner reaches Hewn from anywhere), its DNS records and proxy. */
async function urlCommand(c: PlatformClient) {
  const value = positional()[0];
  const listen = option("listen");
  if (listen !== undefined) {
    const before = readConfig(home).publicListen;
    const after = writeConfig(home, { publicListen: listen === "off" ? null : listen }).publicListen;
    console.log(after ? `The public listener will also answer on ${after}:${port + 1}, for a reverse proxy on another machine.` : "The public listener will answer on this machine only (127.0.0.1).");
    if (after !== before) console.log("Restart Hewn to apply it: hewn service restart\n");
  }
  if (value || flag("clear")) {
    const r = await c.call("setPublicUrl", flag("clear") ? null : value);
    if (!r.url) return console.log("No public URL. Hewn's web client is only on this machine (hewn open); the tunnel, if any, still serves agents.");
    if (r.passkeysElsewhere) console.log(`Note: ${r.passkeysElsewhere} passkey(s) were made for another address and won't work on ${new URL(r.url).hostname}. Sign in with hewn open --print and add new ones (Settings › Remote access).\n`);
  }
  const url: string | null = await c.call("publicUrl");
  if (!url) {
    console.log("No public URL: Hewn's web client is only on this machine (hewn open).\nTo use Hewn from your phone or another computer, give it an address you own:\n  hewn url https://hewn.example.com");
    return;
  }
  const network = readConfig(home).publicListen;
  const listener = network ? `${network}:${port + 1}` : `127.0.0.1:${port + 1}`;
  const host = new URL(url).host;
  const [record] = dnsRecords(url);
  console.log(`Public URL: ${url}  (tool apps: hewn open <id> --print)\n`);
  console.log(`1. DNS: ${record.name} → ${record.value} (an A record at your DNS provider).\n`);
  console.log(`2. HTTPS: a reverse proxy for ${host}, forwarding to ${listener} (keep the Host header). Caddy:\n`);
  console.log(`     ${host} {\n       reverse_proxy ${listener}\n     }\n`);
  if (!network) console.log("   Caddy on another machine? hewn url --listen <this machine's LAN address>, then restart Hewn.\n");
  console.log("   (Or a named cloudflared tunnel for this name. See docs/remote-access.md.)\n");
  console.log("3. Sign in from your phone or laptop: hewn open --print (here, over SSH), then add a passkey there.");
}

async function tunnelCommand(c: PlatformClient) {
  if (!c.control) throw new Error("the tunnel runs with Hewn itself: start it with hewn serve (or hewn service install)");
  const sub = positional()[0] ?? "status";
  const show = (t: { kind: string | null; state: string; url: string | null; error?: string }) => {
    if (!t.kind) return console.log("No tunnel. Cloud agents can't reach Hewn.\nStart one: hewn tunnel start --quick (a random trycloudflare.com address, new on every start)\n           hewn tunnel start --cloudflared <tunnel> --hostname <host> (your own domain, stable)\n           hewn tunnel start --tailscale (Tailscale Funnel)");
    console.log(`${t.kind}: ${t.state}${t.url ? `  ${t.url}` : ""}${t.error ? `\n  ${t.error}` : ""}`);
    if (t.state === "up" && t.url) console.log(`\nIn claude.ai or ChatGPT, add a custom connector with:\n  ${t.url}/mcp\nThen approve it in Hewn (Agents), or with hewn agents pending.`);
    if (t.kind === "cloudflared" && t.url) console.log(`\nThe web client can use this address too: hewn url ${t.url}`);
  };
  if (sub === "status") return show(await c.control("/control/tunnel", {}));
  if (sub === "stop") return show(await c.control("/control/tunnel", { action: "stop" }));
  if (sub === "start") {
    const kind = flag("tailscale") ? "tailscale" : option("cloudflared") ? "cloudflared" : "quick";
    const cfg = kind === "cloudflared" ? { kind, name: option("cloudflared"), hostname: option("hostname") } : { kind };
    if (kind === "cloudflared" && !cfg.hostname) throw new Error("usage: hewn tunnel start --cloudflared <tunnel name> --hostname <public host routed to it>");
    let t = await c.control("/control/tunnel", { action: "start", tunnel: cfg });
    for (let i = 0; i < 60 && t.state === "starting"; i++) {
      await sleep(1000);
      t = await c.control("/control/tunnel", {});
    }
    show(t);
    if (t.state !== "up") process.exitCode = 1;
    return;
  }
  throw new Error("usage: hewn tunnel [status | start [--quick | --cloudflared <tunnel> --hostname <host> | --tailscale] | stop]");
}

const usd = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0");
const perM = (p?: { input: number; output: number }) => (p ? `${usd(p.input * 1e6)} / ${usd(p.output * 1e6)} per M tokens` : "no price known");

/** hewn models: the owner's model provider, tiers, budget and spend (the same as Settings → Models). */
async function models(c: PlatformClient, rl: ReturnType<typeof createInterface>) {
  const [sub, a, b, x] = positional();
  const PROVIDERS = ["anthropic", "openai", "openrouter"];
  if (sub === "key") {
    if (!a || !PROVIDERS.includes(a)) throw new Error("usage: hewn models key anthropic|openai|openrouter [--from <path>|--remove]");
    if (flag("remove")) return void (await c.call("setModelKey", a, null), console.log(`✔ ${a} key removed`));
    const from = option("from");
    const key = from ? readSecretSource(from) : await askHidden(rl, `${a} API key (input hidden): `);
    if (!key) throw new Error("empty key, nothing stored");
    const m = await c.call("setModelKey", a, key);
    const p = m.providers.find((p: any) => p.id === a);
    console.log(p.check?.ok ? `✔ ${a} key works (${p.models.length} models)` : `✔ ${a} key stored, but it couldn't be checked: ${p.check?.error}`);
    if (m.provider === a) console.log(`  ${a} runs the tiers${Object.keys(p.tiers).length ? `: ${Object.entries(p.tiers).map(([t, id]) => `${t} ${id}`).join(", ")}` : ""}`);
    return;
  }
  if (sub === "use") {
    if (!a) throw new Error("usage: hewn models use anthropic|openai|openrouter");
    await c.call("setModelSettings", { provider: a });
    return void console.log(`✔ tiers now run on ${a}`);
  }
  if (sub === "tier") {
    const m = await c.call("models");
    if (!m.provider) throw new Error("no provider yet: hewn models key <provider>");
    const prov = m.providers.find((p: any) => p.id === m.provider);
    if (flag("suggested")) {
      await c.call("setModelSettings", { tiers: { [m.provider]: Object.fromEntries(m.tierNames.map((t: string) => [t, prov.suggested.tiers[t] ?? null])) } });
      return void console.log(`✔ tiers reset to the suggestion (${prov.suggested.by})`);
    }
    if (!a || !b) throw new Error(`usage: hewn models tier ${m.tierNames.join("|")} <${m.provider} model id> | --suggested`);
    await c.call("setModelSettings", { tiers: { [m.provider]: { [a]: b } } });
    return void console.log(`✔ ${a}: ${b}`);
  }
  if (sub === "cap") {
    const m = await c.call("models");
    if (a && b) {
      const caps = { ...m.capabilityCapsUsd };
      if (b === "none") delete caps[a];
      else caps[a] = Number(b);
      await c.call("setModelSettings", { capabilityCapsUsd: caps });
      return void console.log(b === "none" ? `✔ ${a}: no cap of its own` : `✔ ${a}: at most $${Number(b)} a month`);
    }
    if (!a) throw new Error("usage: hewn models cap <usd> | cap <tool> <usd>|none");
    await c.call("setModelSettings", { monthlyCapUsd: Number(a) });
    return void console.log(`✔ monthly cap: $${Number(a)}`);
  }
  if (sub === "price") {
    if (!a || b === undefined || x === undefined) throw new Error("usage: hewn models price <provider/model> <input USD per M tokens> <output USD per M tokens>");
    const m = await c.call("models");
    const prices = Object.fromEntries(Object.entries(m.prices as Record<string, { input: number; output: number }>).map(([k, v]) => [k, { input: v.input * 1e6, output: v.output * 1e6 }]));
    prices[a] = { input: Number(b), output: Number(x) };
    await c.call("setModelSettings", { prices });
    return void console.log(`✔ ${a}: ${perM({ input: Number(b) / 1e6, output: Number(x) / 1e6 })}`);
  }
  if (sub === "check") {
    const m0 = await c.call("models");
    if (!m0.provider) throw new Error("no provider yet: hewn models key <provider>");
    const m = await c.call("checkModelProvider", a ?? m0.provider);
    const p = m.providers.find((p: any) => p.id === (a ?? m0.provider));
    return void console.log(p.check?.ok ? `✔ ${p.id} key works (${p.models.length} models)` : `✖ ${p.id}: ${p.check?.error}`);
  }
  if (sub === "list") {
    const m = await c.call("models");
    const prov = m.providers.find((p: any) => p.id === (a ?? m.provider));
    if (!prov?.keySet) throw new Error(`no ${a ?? "provider"} key yet: hewn models key <provider>`);
    for (const y of prov.models) console.log(`  ${y.id.padEnd(44)} ${perM(y.price)}${y.images ? " · images" : ""}${prov.suggested.tiers && Object.values(prov.suggested.tiers).includes(y.id) ? " · suggested" : ""}`);
    return;
  }
  if (sub === "set" || sub === "replace") {
    if (!a || !b) throw new Error("usage: hewn models set <tool> light|standard|strong|max|<provider/model>");
    const build = await c.call("setCapabilityModel", a, b.includes("/") ? { model: b } : { tier: b });
    return void console.log(`✔ ${a}: a new version using ${b} is being validated (hewn watch ${build.buildId})`);
  }
  if (sub) throw new Error(`unknown: hewn models ${sub} (see hewn help)`);

  const m = await c.call("models");
  if (!m.provider) {
    console.log("No model provider yet. Tools that use a model can't run.\n  hewn models key anthropic|openai|openrouter");
    return;
  }
  const prov = m.providers.find((p: any) => p.id === m.provider);
  console.log(`Provider  ${m.provider}  ${prov.check?.ok ? `✔ key works (checked ${prov.check.at.slice(0, 16).replace("T", " ")})` : `✖ ${prov.check?.error ?? "not checked"}`}`);
  console.log("Tiers");
  for (const t of m.tierNames) {
    const id = prov.tiers[t];
    const y = prov.models.find((z: any) => z.id === id);
    const users = (m.usage[t] ?? []).map((u: any) => u.name);
    console.log(`  ${t.padEnd(9)} ${(id ?? "(not set)").padEnd(28)} ${id ? perM(y?.price ?? m.prices[`${m.provider}/${id}`]) : ""}${users.length ? `  · used by ${users.join(", ")}` : ""}`);
  }
  for (const p of m.pinned) console.log(`  pinned    ${p.name}: ${p.model}${p.retired ? `  ✖ no longer available (hewn models set ${p.id} ${p.retired.successor ?? "<provider/model>"})` : p.problem ? `  ✖ ${p.problem}` : ""}`);
  console.log(`This month  ${usd(m.spend.totalUsd)} of ${usd(m.monthlyCapUsd)}`);
  for (const r of m.spend.rows) console.log(`  ${r.capabilityId.padEnd(24)} ${r.model.padEnd(36)} ${String(r.calls).padStart(4)} calls  ${usd(r.costUsd)}${m.capabilityCapsUsd[r.capabilityId] !== undefined ? `  (cap ${usd(m.capabilityCapsUsd[r.capabilityId])})` : ""}`);
}

async function authority(c: PlatformClient, command: string, rl: ReturnType<typeof createInterface>) {
  const pos = positional();
  const from = option("from");
  const caps: { id: string }[] = await c.call("list");
  const show = async (id: string) => {
    if (!caps.some((x) => x.id === id)) throw new Error(`no active tool '${id}'`);
    const m = await c.call("get", id);
    const st = m.status;
    console.log(`${m.name} (${id}): ${st.ready ? "ready" : "NOT READY"}`);
    const items = (await c.call("authorization", id)).items;
    for (const i of items) {
      const secret = i.kind === "secret" ? i.grant.slice(7) : null;
      const value = secret ? (st.missingSecrets.includes(secret) ? " (value missing)" : " (value set)") : "";
      console.log(`  ${i.approved ? "✔" : "·"} ${i.label}${value}${i.approved ? "" : st.declinedGrants?.includes(i.grant) ? "  [you said no]" : "  [not authorized]"}`);
    }
    for (const x of (await c.call("authorization", id)).config ?? []) console.log(`  ${x.value === null ? "·" : "✔"} config ${x.name}: ${x.value ?? "(not set)"}  ${x.description}`);
    for (const d of st.missingDependencies) console.log(`  ✖ depends on ${d}, which no longer exists`);
    if (st.retiredModel) console.log(`  ✖ ${st.retiredModel.model} is no longer available: hewn models set ${id} ${st.retiredModel.successor ?? "<provider/model>"}`);
    else if (st.missingModel) console.log(`  ✖ model: ${st.missingModel}${/provider is set up/.test(st.missingModel) ? " (hewn models key <provider>)" : ""}`);
    if (st.unsupportedAbi) console.log(`  ✖ ${st.unsupportedAbi}: upgrade Hewn, or roll it back`);
    if (!items.length) console.log("  requires nothing");
  };
  const setOne = async (id: string, name: string) => {
    const value = from ? readSecretSource(from) : await askHidden(rl, `${name} for ${id} (input hidden): `);
    if (!value) throw new Error("empty value, nothing stored");
    await c.call("setSecret", id, name, value);
    console.log(`✔ ${name} stored (encrypted)`);
  };
  const approve = async (id: string, grant?: string) => {
    if (grant) return void (await c.call("approveGrant", id, grant), console.log(`✔ ${grant} approved`));
    const pending: string[] = (await c.call("readiness", id)).pendingGrants;
    if (!pending.length) return console.log("No pending grants.");
    console.log(`${id} requests:\n${pending.map((g) => `  - ${g}`).join("\n")}`);
    const ok = flag("yes") || (await rl.question("Approve? [y/N] ")).trim().toLowerCase().startsWith("y");
    if (!ok) return console.log("Not approved.");
    await c.call("approveGrants", id);
    console.log("✔ approved");
  };

  if (command === "grants") {
    if (pos[0] === "approve") return approve(pos[1] ?? "", pos[2]);
    if (pos[0] === "deny") {
      if (!pos[2]) throw new Error("usage: hewn grants deny <id> <grant>   (the grant as hewn grants <id> shows it, e.g. host:api.example.com)");
      // A secret is set or not: there's nothing to say no to.
      if (pos[2].startsWith("secret:")) throw new Error(`a secret can't be denied: leave it unset, or remove it (hewn secrets rm ${pos[1]} ${pos[2].slice(7)})`);
      await c.call("declineGrant", pos[1], pos[2]);
      return console.log(`✔ said no to ${pos[2]}: nothing asks for it again until a new version (hewn grants approve ${pos[1]} ${pos[2]} allows it)`);
    }
    for (const x of pos[0] ? [{ id: pos[0] }] : caps) await show(x.id);
    return;
  }
  const setConfig = async (id: string, name: string, value?: string) => {
    const v = value ?? (await rl.question(`${name} for ${id}: `)).trim();
    if (!v) throw new Error("empty value, nothing stored");
    await c.call("setConfig", id, name, v);
    console.log(`✔ ${name} set`);
  };
  if (command === "config") {
    const [id, name, ...value] = pos;
    if (!id) throw new Error("usage: hewn config <tool> [NAME value]");
    if (!name) return show(id);
    return setConfig(id, name, value.join(" ") || undefined);
  }
  if (command === "secrets") {
    const [sub, id, name] = pos;
    if (sub === "list" || !sub) {
      for (const x of id ? [{ id }] : caps) await show(x.id);
      return;
    }
    if (!id || !name) throw new Error("usage: hewn secrets set|import|rm <tool> <NAME> [--from <path>]");
    if (sub === "set" || sub === "import") return setOne(id, name);
    if (sub === "rm") return void (await c.call("deleteSecret", id, name), console.log(`✔ ${name} removed`));
    throw new Error(`unknown: secrets ${sub}`);
  }
  // connect: everything the capability needs, in one go
  const id = pos[0];
  if (!id) throw new Error("usage: hewn connect <tool> [--from <path>]");
  await show(id);
  const m = await c.call("get", id);
  // A connection with a sign-in step gets its secrets by signing in, not by pasting them.
  const signIn = m.kind === "connection" ? m.operations.filter((o: any) => o.name === "connect").sort((a: any, b: any) => b.version - a.version)[0] : undefined;
  for (const name of (await c.call("readiness", id)).missingConfig ?? []) {
    console.log();
    await setConfig(id, name);
  }
  if (!signIn) {
    for (const name of (await c.call("readiness", id)).missingSecrets) {
      console.log();
      await setOne(id, name);
    }
  }
  console.log();
  await approve(id);
  if (signIn && ((await c.call("readiness", id)).missingSecrets.length || flag("again"))) {
    console.log(`\nSign in to ${m.name} (your answers go to ${m.name}'s sign-in step only, never to an agent or a log):`);
    let schema = signIn.inputSchema;
    let state: string | undefined;
    for (;;) {
      const input: Record<string, unknown> = state ? { state } : {};
      for (const [name, s] of Object.entries<any>(schema.properties ?? {})) {
        if (name === "state") continue;
        const label = `  ${s.title ?? name}${s.description ? ` (${s.description})` : ""}: `;
        const raw = s.format === "password" || s.writeOnly || /pass|token|secret|key/i.test(name) ? await askHidden(rl, label) : (await rl.question(label)).trim();
        if (raw === "") {
          if ((schema.required ?? []).includes(name)) throw new Error(`${name} is required`);
          continue;
        }
        input[name] = s.type === "integer" || s.type === "number" ? Number(raw) : s.type === "boolean" ? /^y/i.test(raw) : raw;
      }
      const r = await c.call("connect", id, input);
      if (r.status !== "needs_input") break;
      if (r.message) console.log(`  ${r.message}`);
      schema = r.inputSchema ?? { type: "object", properties: {} };
      state = r.state;
    }
    console.log("✔ signed in");
  }
  console.log();
  await show(id);
}

async function schedules(c: PlatformClient) {
  const [sub, ...rest] = positional();
  const print = (list: any[]) => {
    if (!list.length) return console.log("no schedules");
    console.table(list.map((s) => ({ id: s.id, tool: s.capabilityId, operation: `${s.operation}@${s.operationVersion}`, cadence: s.cadence, status: s.status, next: s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "", last: s.lastOutcome ?? "" })));
  };
  if (!sub || !["add", "pause", "resume", "rm"].includes(sub)) return print(await c.call("listSchedules", sub));
  if (sub === "add") {
    const [capabilityId, operation, cadence, input] = rest;
    if (!capabilityId || !operation || !cadence) throw new Error('usage: hewn schedules add <tool> <operation> "<cadence>" [json input]');
    const s = await c.call("createSchedule", { capabilityId, operation, cadence, input: input ? JSON.parse(input) : {} });
    return console.log(`✔ ${s.id}: next ${new Date(s.nextRunAt).toLocaleString()}`);
  }
  if (sub === "rm") return void (await c.call("deleteSchedule", rest[0]), console.log("✔ removed"));
  const s = await c.call("updateSchedule", rest[0], { status: sub === "pause" ? "paused" : "active" });
  console.log(`✔ ${s.id} ${s.status}${s.nextRunAt ? `, next ${new Date(s.nextRunAt).toLocaleString()}` : ""}`);
}

await main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
