// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { appendFileSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import type { IntakeRequest } from "@hewntools/cli/intake.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import { WEB_CODE } from "@hewntools/host-workerd/surface/web.ts";
import { installFrom, installSeed, platformWith, SEED, serve, setup, TOKENS } from "./helpers.ts";

const FIX = resolve(import.meta.dirname, "fixtures");
/** The web client's JavaScript: app.js, the kit, and its modules in app/. */
const WEB = resolve(import.meta.dirname, "../packages/host-workerd/web");
const webJs = () => readdirSync(WEB, { recursive: true }).map(String).filter((f) => f.endsWith(".js"));

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe("web client (owner surface)", () => {
  let t: ReturnType<typeof setup>;
  let platform: Platform;
  let server: Server;
  let port: number;
  let cookie: string;
  const intakeCalls: IntakeRequest[] = [];
  const setupRan: string[] = [];

  const http = (path: string, o: { method?: string; host?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<Res>((res, rej) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: o.method ?? "GET",
          headers: {
            host: `${o.host ?? "hewn.localhost"}:${port}`,
            ...(o.cookie !== undefined ? { cookie: o.cookie } : cookie ? { cookie } : {}),
            ...(o.body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(o.body))) } : {}),
            ...o.headers,
          },
        },
        (m) => {
          let body = "";
          m.on("data", (d) => (body += d));
          m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
        },
      );
      r.on("error", rej);
      r.end(o.body !== undefined ? JSON.stringify(o.body) : undefined);
    });
  const api = async (path: string, o: Parameters<typeof http>[1] = {}) => {
    const r = await http(`/api${path}`, { ...o, headers: { "x-hewn-ui": "1", ...o.headers } });
    return { status: r.status, json: r.body ? JSON.parse(r.body) : undefined };
  };

  before(async () => {
    t = setup();
    // Installed by the owner: running-log, secret-echo, ui-counter
    await installSeed(t.platform);
    for (const [name, dir] of [["Secret Echo", "secret-echo"], ["UI Counter", "ui-counter"]]) await installFrom(t.platform, resolve(FIX, dir), name);
    // Like the real CLI builders: activity goes to the transcript and to onActivity.
    const builder: CapabilityBuilder = {
      name: "fake",
      build: async (job) => {
        if (job.capabilityId === "stops-early") throw new Error("hit the usage limit");
        appendFileSync(job.logPath, "00:00:00 → Write src/index.ts\n");
        job.onActivity?.("→ Write src/index.ts");
        cpSync(SEED, job.workspace, { recursive: true });
      },
    };
    platform = platformWith(t.home, () => builder);
    server = await serve(platform, t.home, {
      intake: async (req, onProgress) => {
        intakeCalls.push(req);
        onProgress?.({ activity: "Thinking" });
        // A rule stated in passing is remembered (global, or for the tool when modifying); "forget" drops one.
        const last = req.messages.at(-1)?.content ?? "";
        const memory = /always Swedish/.test(last) ? { remember: [{ scope: "global" as const, text: "Swedish copy in every screen" }, { scope: "tool" as const, text: "One screen only" }] } : /drop the Swedish rule/.test(last) ? { forget: [{ scope: "global" as const, text: "Swedish copy in every screen" }] } : {};
        if (req.mode === "modify") return { kind: "widgets", message: "", proposals: [{ title: "Runs this week", shows: "How far you ran.", template: "stat", sizes: ["small"] }], ...memory };
        if (memory.remember) return { kind: "questions", message: "", questions: ["Noted. Anything else?"], ...memory };
        return {
          ...(req.messages.length === 1
            ? { kind: "questions" as const, message: "", questions: ["Track grind size too?"] }
            : { kind: "draft" as const, message: "", draft: { name: "Coffee Log", purpose: "Track beans and brews.", requirements: "ops: add_bean, rate_brew" } }),
          ...memory,
        };
      },
      setup: {
        appInstalled: (name: string) => name === "Claude",
        harnesses: () => [
          {
            agentId: "fake-agent",
            label: "Fake Agent",
            pointerRequired: true,
            pointerNote: "",
            detect: () => true,
            registered: () => setupRan.length > 0,
            steps: (ctx) => [
              { describe: "pointer", kind: "pointer", file: `${ctx.home}/.fake/AGENTS.md`, run: () => {} },
              { describe: "register", kind: "register", run: () => setupRan.push(ctx.url) },
            ],
            login: (url) => ["fake", "login", url],
            loginFix: () => "Update Fake Agent.",
          },
        ],
        login: async (argv, onLine) => (onLine(`opening ${argv.at(-1)}`), 0),
        userHome: "/Users/someone",
      },
    });
    port = (server.address() as AddressInfo).port;
    const r = await http(`/auth?ticket=${platform.createWebTicket(USER)}`, { cookie: "" });
    assert.equal(r.status, 200);
    cookie = String(r.headers["set-cookie"]).split(";")[0];
  });
  after(async () => {
    await platform.drain();
    await new Promise((r) => server.close(r));
    platform.close();
    t.cleanup();
  });

  describe("boundaries", () => {
    test("nothing without an owner session", async () => {
      assert.equal((await http("/", { cookie: "" })).status, 401);
      assert.equal((await api("/capabilities", { cookie: "" })).status, 401);
    });

    test("signed out: a page that says how to sign in; only branding and the manifest are public", async () => {
      const page = await http("/", { cookie: "" });
      assert.match(page.headers["content-type"] as string, /text\/html/);
      assert.match(page.body, /Signed out\.[\s\S]*hewn open/);
      assert.doesNotMatch(page.body, /<script/);
      assert.equal((await http("/auth?ticket=nope", { cookie: "" })).status, 401);
      for (const f of ["/manifest.webmanifest", "/icons/hewn-192.png", "/hewn-mark.svg", "/app.css"]) assert.equal((await http(f, { cookie: "" })).status, 200, f);
      for (const f of ["/app.js", "/app/router.js"]) assert.equal((await http(f, { cookie: "" })).status, 401, `${f}: the app itself needs a session`);
      assert.equal(JSON.parse((await http("/manifest.webmanifest", { cookie: "" })).body).display, "standalone");
    });

    test("sessions: 30 days, sliding; listed with this browser marked; revoke and sign out", async () => {
      const r = await http(`/auth?ticket=${platform.createWebTicket(USER)}`, { cookie: "", headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130" } });
      assert.match(String(r.headers["set-cookie"]), /Max-Age=2592000/);
      const other = String(r.headers["set-cookie"]).split(";")[0];
      const list = (await api("/sessions")).json;
      assert.equal(list.filter((x: any) => x.current).length, 1);
      const theirs = list.find((x: any) => x.userAgent?.includes("Chrome/130"));
      assert.ok(theirs && !theirs.current);
      assert.ok(new Date(theirs.expiresAt).getTime() - Date.now() > 29 * 86400_000);
      assert.equal((await http("/", { cookie: other })).status, 200);
      assert.equal((await api(`/sessions/${theirs.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await http("/", { cookie: other })).status, 401, "revoked");
      // Sign out a fresh session with its own cookie.
      const mine = String((await http(`/auth?ticket=${platform.createWebTicket(USER)}`, { cookie: "" })).headers["set-cookie"]).split(";")[0];
      const out = await http("/api/sessions/signout", { method: "POST", cookie: mine, headers: { "x-hewn-ui": "1" } });
      assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
      assert.equal((await http("/", { cookie: mine })).status, 401);
    });

    test("/approve (from an agent's sign-in page): Agents when signed in, the terminal command when not", async () => {
      const out = await http("/approve?code=BCD-F23", { cookie: "" });
      assert.equal(out.status, 401);
      assert.match(out.body, /hewn agents approve BCD-F23/);
      assert.doesNotMatch((await http("/approve?code=<script>", { cookie: "" })).body, /<script>/, "only a well-formed code is echoed");
      const signedIn = await http("/approve?code=BCD-F23");
      assert.equal(signedIn.status, 302);
      assert.equal(signedIn.headers.location, "/#/agents");
    });

    test("an agent bearer token is not an owner session", async () => {
      const r = await api("/agents", { cookie: "", headers: { authorization: `Bearer ${TOKENS.claude}` } });
      assert.equal(r.status, 401);
    });

    test("a capability UI session is not an owner session", async () => {
      const ticket = platform.createUiTicket("ui-counter");
      const ui = await http(`/tools/ui-counter/auth?ticket=${ticket}`, { cookie: "" });
      const uiToken = /#hewn_session=([\w-]+)/.exec(ui.body)![1];
      assert.equal((await api("/capabilities", { cookie: `hewn_web=${uiToken}` })).status, 401);
      assert.equal((await api("/capabilities", { cookie: "", headers: { authorization: `Hewn ${uiToken}` } })).status, 401);
    });

    test("web tickets are single use; cookie is HttpOnly + SameSite=Strict", async () => {
      const ticket = platform.createWebTicket(USER);
      const r = await http(`/auth?ticket=${ticket}`, { cookie: "" });
      assert.match(String(r.headers["set-cookie"]), /HttpOnly; SameSite=Strict/);
      assert.equal((await http(`/auth?ticket=${ticket}`, { cookie: "" })).status, 401);
    });

    test("cross-origin and header-less mutations are refused, capability UIs (opaque origins) included", async () => {
      assert.equal((await api("/capabilities", { headers: { origin: "null" } })).status, 403);
      assert.equal((await api("/capabilities", { headers: { origin: `http://ui-counter.localhost:${port}` } })).status, 403);
      assert.equal((await api("/capabilities", { headers: { "sec-fetch-site": "same-site" } })).status, 403);
      const noHeader = await http("/api/capabilities/running-log/invoke", { method: "POST", body: { operation: "list_runs" } });
      assert.equal(noHeader.status, 403);
    });

    test("API responses carry the web client's fingerprint (an open page notices an upgrade)", async () => {
      const a = await http("/api/capabilities", { headers: { "x-hewn-ui": "1" } });
      const b = await http("/api/settings", { headers: { "x-hewn-ui": "1" } });
      assert.match(String(a.headers["x-hewn-web"]), /^[0-9a-f]{16}$/);
      assert.equal(a.headers["x-hewn-web"], b.headers["x-hewn-web"]);
      // It covers all of the client's code: a module left out of WEB_CODE could change unnoticed.
      assert.deepEqual([...WEB_CODE].sort(), [...webJs(), "index.html", "app.css"].sort());
      const bad = await api("/capabilities/running-log/invoke", { method: "POST", body: { operation: "record_run", input: {} } });
      assert.equal(bad.status, 400);
      assert.match(bad.json.message, /inputSchema \(missing [a-zA-Z, ]+\)/, "names the missing fields");
    });

    test("CSP allows no inline script; client code has no HTML sinks", async () => {
      const r = await http("/");
      const csp = String(r.headers["content-security-policy"]);
      assert.match(csp, /script-src 'self'/);
      assert.doesNotMatch(csp, /unsafe-inline'[^;]*;?\s*$|script-src[^;]*unsafe-inline/);
      const mod = await http("/app/router.js");
      assert.equal(mod.status, 200, "the client's modules, from app/");
      assert.match(String(mod.headers["content-type"]), /^text\/javascript/);
      assert.equal(mod.headers["content-security-policy"], r.headers["content-security-policy"]);
      const files = webJs();
      assert.ok(files.includes("app.js") && files.includes("app/router.js"), "the modules in app/ too");
      for (const file of files) {
        const js = readFileSync(resolve(WEB, file), "utf8").replace(/^\/\/.*$/gm, "");
        assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
        // Dialogs, inline edits and toasts instead of browser built-ins.
        assert.doesNotMatch(js, /(?<![\w.])(alert|confirm|prompt)\(/, file);
      }
    });

    test("the id 'hewn' is reserved for the web client origin", async () => {
      await assert.rejects(platform.create(USER, { name: "Hewn", purpose: "x", requirements: "x" }), (e) => e instanceof PlatformError && e.code === "invalid_request");
    });
  });

  describe("owner flows", () => {
    test("drawer data: one entry per capability with ui/ready/icon info", async () => {
      const { json } = await api("/capabilities");
      const ids = json.map((c: any) => c.id).sort();
      assert.deepEqual(ids, ["running-log", "secret-echo", "ui-counter"]);
      assert.equal(json.find((c: any) => c.id === "ui-counter").ui, true);
      assert.equal(json.find((c: any) => c.id === "secret-echo").ready, false);
    });

    test("run an operation from its contract; output stays data", async () => {
      const r = await api("/capabilities/running-log/invoke", { method: "POST", body: { operation: "record_run", input: { distanceKm: 5, durationSeconds: 1500, notes: "<script>alert(1)</script>" } } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const list = await api("/capabilities/running-log/invoke", { method: "POST", body: { operation: "list_runs", input: {} } });
      assert.equal(list.json.result.runs[0].notes, "<script>alert(1)</script>", "returned as JSON data; the client renders it as text");
      const logs = await api("/capabilities/running-log/logs");
      assert.ok(logs.json.lines.some((l: string) => / web record_run ok /.test(l)), "calls attributed to the web owner");
    });

    test("secrets and grants from the web: set, approve, revoke", async () => {
      assert.equal((await api("/capabilities/secret-echo/secrets/API_TOKEN", { method: "PUT", body: { value: "s3cret" } })).status, 200);
      const page = await api("/capabilities/secret-echo");
      assert.deepEqual(page.json.status.missingSecrets, []);
      assert.ok(!JSON.stringify(page.json).includes("s3cret"), "values never come back");
      assert.deepEqual((await api("/capabilities/secret-echo/grants/approve", { method: "POST" })).json.approved, ["secret:API_TOKEN"]);
      assert.equal((await api("/capabilities/secret-echo/invoke", { method: "POST", body: { operation: "whoami", input: {} } })).json.result.tokenLength, 6);
      await api("/capabilities/secret-echo/grants/revoke", { method: "POST", body: { grant: "secret:API_TOKEN" } });
      assert.equal((await api("/capabilities/secret-echo/invoke", { method: "POST", body: { operation: "whoami", input: {} } })).status, 409);
    });

    test("delegated agents: edit scopes, revoke", async () => {
      await api("/agents/codex", { method: "PUT", body: { scopes: ["discover"] } });
      assert.deepEqual((await api("/agents")).json.find((a: any) => a.id === "codex").scopes, ["discover"]);
      assert.equal((await api("/agents/outsider", { method: "DELETE" })).status, 200);
      assert.ok(!(await api("/agents")).json.some((a: any) => a.id === "outsider"));
    });

    test("open a capability UI: returns a single-use link under /tools/<id>/", async () => {
      const { json } = await api("/capabilities/ui-counter/open", { method: "POST" });
      assert.match(json.url, new RegExp(`^http://hewn\\.localhost:${port}/tools/ui-counter/auth\\?ticket=`));
    });

    test("rename and logo are owner presentation; the id never changes", async () => {
      await api("/capabilities/running-log/rename", { method: "POST", body: { name: "Runs" } });
      const list = (await api("/capabilities")).json;
      assert.equal(list.find((c: any) => c.id === "running-log").name, "Runs");
      assert.equal(platform.get(t.codex, "running-log").name, "Runs", "agents see the owner's name too");
      // Emoji icons are gone (design pass 2): glyphs and images only.
      assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { emoji: "🏃" } })).status, 400);
    });

    test("uploaded SVG logos are served sandboxed (no script on the owner origin)", async () => {
      const evil = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>';
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(evil).toString("base64")}`;
      assert.equal((await api("/capabilities/ui-counter/icon", { method: "PUT", body: { dataUrl } })).status, 200);
      const r = await http("/api/capabilities/ui-counter/icon");
      assert.equal(r.headers["content-type"], "image/svg+xml");
      assert.match(String(r.headers["content-security-policy"]), /default-src 'none'.*sandbox/);
      assert.equal((await api("/capabilities/ui-counter/icon", { method: "PUT", body: { dataUrl: "data:text/html;base64,PGgxPg==" } })).status, 400);
    });

    test("delete archives: gone for owner and agents, data kept, restorable, id reserved", async () => {
      assert.equal((await api("/capabilities/secret-echo", { method: "DELETE", body: { confirm: "nope" } })).status, 400);
      const del = await api("/capabilities/secret-echo", { method: "DELETE", body: { confirm: "secret-echo" } });
      assert.equal(del.status, 200, JSON.stringify(del.json));
      assert.ok(!(await api("/capabilities")).json.some((c: any) => c.id === "secret-echo"));
      assert.ok(!platform.list(t.codex).some((c) => c.id === "secret-echo"));
      await assert.rejects(platform.create(USER, { name: "Secret Echo", purpose: "x", requirements: "x" }), /archived/);
      platform.restore(USER, "secret-echo");
      assert.ok((await api("/capabilities")).json.some((c: any) => c.id === "secret-echo"));
    });

    test("attachments: uploaded as added, served back sandboxed, handed to the intake with their bytes, kept with the build", async () => {
      const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+9AAAADklEQVQIW2P4z8DwHwAFAAH/yQ0wtQAAAABJRU5ErkJggg==";
      const up = await api("/attachments", { method: "POST", body: { session: "s-web", kind: "image", name: "screen.png", mediaType: "image/png", data: PNG } });
      assert.equal(up.status, 200, JSON.stringify(up.json));
      assert.deepEqual({ ...up.json, ref: "" }, { ref: "", kind: "image", name: "screen.png", mediaType: "image/png", bytes: 70, width: 2, height: 1 });
      const got = await http(`/api/attachments/${up.json.ref}`);
      assert.equal(got.status, 200);
      assert.equal(got.headers["content-type"], "image/png");
      assert.match(String(got.headers["content-security-policy"]), /sandbox/);
      assert.equal((await api("/attachments/at-nope")).status, 404);
      assert.equal((await api("/attachments", { method: "POST", body: { session: "s-web", kind: "file", name: "x.bin", mediaType: "application/octet-stream", data: "AAAA" } })).status, 400);
      // The intake gets the bytes; the client only sent the ref.
      const turn = { role: "user", content: "make it look like this", attachments: [{ ref: up.json.ref, kind: "image", name: "screen.png", mediaType: "image/png" }] };
      const r = await api("/intake", { method: "POST", body: { mode: "create", messages: [turn] } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(intakeCalls.at(-1)!.messages[0].attachments![0].data, PNG);
      assert.equal(intakeCalls.at(-1)!.messages[0].attachments![0].width, 2);
      assert.equal((await api("/intake", { method: "POST", body: { mode: "create", messages: [{ ...turn, attachments: [{ ref: "at-nope" }] }] } })).status, 404);
      // With the build: refs resolved to what they are, kept in the conversation.
      const b = await api("/capabilities", { method: "POST", body: { name: "Shown Log", purpose: "p", requirements: "r", conversation: [turn, { role: "intake", content: "DRAFT\nShown Log" }] } });
      assert.equal(b.status, 200, JSON.stringify(b.json));
      await platform.settle(b.json.buildId);
      const ctx = (await api(`/builds/${b.json.buildId}/context`)).json;
      assert.deepEqual(ctx.conversation[0].attachments, [{ ref: up.json.ref, kind: "image", name: "screen.png", mediaType: "image/png", bytes: 70, width: 2, height: 1 }]);
    });

    test("intake: questions, then a draft; the platform supplies the catalog", async () => {
      const q = await api("/intake", { method: "POST", body: { mode: "create", messages: [{ role: "user", content: "coffee beans" }] } });
      assert.equal(q.json.kind, "questions");
      assert.ok(intakeCalls[0].catalog!.some((c) => c.id === "running-log"));
      const d = await api("/intake", {
        method: "POST",
        body: { mode: "create", messages: [{ role: "user", content: "coffee beans" }, { role: "intake", content: "Track grind size too?" }, { role: "user", content: "yes" }] },
      });
      assert.equal(d.json.draft.name, "Coffee Log");
    });

    test("instructions: the intake remembers a rule (the owner sees what was saved), reads them next time; the owner edits them", async () => {
      // Creating: only the rule for every tool is kept (there is no tool yet).
      const r = await api("/intake", { method: "POST", body: { mode: "create", messages: [{ role: "user", content: "a coffee log; always Swedish copy please" }] } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.saved, { remember: [{ scope: "global", text: "Swedish copy in every screen" }], forget: [] });
      assert.ok(!("remember" in r.json), "the raw ask isn't sent back, only what was saved");
      assert.deepEqual((await api("/instructions")).json, { lines: ["Swedish copy in every screen"] });
      // Modifying: the tool's rule is kept too, and the intake sees both scopes.
      const m = await api("/intake", { method: "POST", body: { mode: "modify", capabilityId: "running-log", messages: [{ role: "user", content: "always Swedish" }] } });
      assert.deepEqual(m.json.saved.remember, [{ scope: "tool", text: "One screen only" }]);
      assert.deepEqual(intakeCalls.at(-1)!.instructions, { global: ["Swedish copy in every screen"], tool: [] });
      assert.deepEqual((await api("/capabilities/running-log/instructions")).json, { lines: ["One screen only"] });
      // A build records them in BUILDER.md's "Owner's instructions".
      const b = await api("/capabilities/running-log/modify", { method: "POST", body: { request: "add a note field" } });
      await platform.settle(b.json.buildId);
      assert.match((await api(`/builds/${b.json.buildId}/context`)).json.instructions, /## Owner's instructions[^]*For every tool:\n- Swedish copy in every screen[^]*For this tool:\n- One screen only/);
      // Dropping one, and editing by hand (a text, one per line; blanks and bullets cleaned up).
      const f = await api("/intake", { method: "POST", body: { mode: "create", messages: [{ role: "user", content: "drop the Swedish rule" }] } });
      assert.deepEqual(f.json.saved, { remember: [], forget: [{ scope: "global", text: "Swedish copy in every screen" }] });
      assert.deepEqual((await api("/instructions", { method: "PUT", body: { text: "- Dates as 2026-10-22\n\n  Metric units  \n" } })).json, { lines: ["Dates as 2026-10-22", "Metric units"] });
      assert.equal((await api("/instructions", { method: "PUT", body: { text: 42 } })).status, 400);
      assert.equal((await api("/capabilities/nope/instructions")).status, 404);
    });

    test("a change can come back as widget proposals; the intake sees the current manifest", async () => {
      const r = await api("/intake", { method: "POST", body: { mode: "modify", capabilityId: "running-log", messages: [{ role: "user", content: "weekly distance" }] } });
      assert.equal(r.json.kind, "widgets");
      assert.equal(r.json.proposals[0].title, "Runs this week");
      assert.equal(intakeCalls.at(-1)!.current?.id, "running-log");
      assert.equal((await api("/intake", { method: "POST", body: { mode: "modify", messages: [] } })).status, 400);
    });

    test("intake streams with Accept: text/event-stream: progress, then the reply", async () => {
      const r = await http("/api/intake", {
        method: "POST",
        headers: { "x-hewn-ui": "1", accept: "text/event-stream" },
        body: { mode: "create", messages: [{ role: "user", content: "coffee" }] },
      });
      assert.equal(r.headers["content-type"], "text/event-stream");
      assert.match(r.body, /event: progress\ndata: \{"activity":"Thinking"\}/);
      assert.match(r.body, /event: reply\ndata: \{"kind":"questions"/);
    });

    test("Got what you asked for?: the answer is kept with the build's context, once it's live; nothing leaves", async () => {
      const b = await api("/capabilities/running-log/modify", { method: "POST", body: { request: "add a note field" } });
      await platform.settle(b.json.buildId);
      assert.equal((await api(`/builds/${b.json.buildId}`)).json.status, "promoted");
      assert.equal((await api(`/builds/${b.json.buildId}/context`)).json.feedback, undefined);
      const no = await api(`/builds/${b.json.buildId}/feedback`, { method: "POST", body: { score: "no", note: "the field is hidden" } });
      assert.equal(no.status, 200, JSON.stringify(no.json));
      assert.equal(no.json.note, "the field is hidden");
      assert.deepEqual((await api(`/builds/${b.json.buildId}/context`)).json.feedback, no.json);
      assert.equal((await api(`/builds/${b.json.buildId}/feedback`, { method: "POST", body: { score: "great" } })).status, 400);
      assert.equal((await api("/builds/b-nope/feedback", { method: "POST", body: { score: "yes" } })).status, 404);
    });

    test("a build from the chat keeps its conversation and its log; the intake can continue from it", async () => {
      const turns = [
        { role: "user", content: "a plant log" },
        { role: "intake", content: "DRAFT\nPlant Log: when each plant was watered" },
      ];
      const b = await api("/capabilities", { method: "POST", body: { name: "Plant Log", purpose: "plants", requirements: "water dates", conversation: turns } });
      assert.equal(b.status, 200, JSON.stringify(b.json));
      assert.ok(!("conversation" in b.json.request));
      await platform.settle(b.json.buildId);
      assert.deepEqual((await api(`/builds/${b.json.buildId}/context`)).json.conversation, turns);
      assert.match((await api(`/builds/${b.json.buildId}/transcript`)).json.text, /→ Write src\/index\.ts/);
      // "Continue from here": the client names the build; the platform fills in its conversation.
      const r = await api("/intake", { method: "POST", body: { mode: "modify", capabilityId: "running-log", messages: [{ role: "user", content: "add fertilizer" }], earlier: { buildId: b.json.buildId } } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(intakeCalls.at(-1)!.earlier, { buildId: b.json.buildId, messages: turns });
      assert.equal((await api("/intake", { method: "POST", body: { mode: "create", messages: [{ role: "user", content: "x" }], earlier: { buildId: "nope" } } })).status, 404);
      assert.equal((await api("/capabilities", { method: "POST", body: { name: "Bad", purpose: "p", requirements: "r", conversation: [{ role: "bot", content: "x" }] } })).status, 400);
    });

    test("create from the web → live build over SSE until done", async () => {
      const b = await api("/capabilities", { method: "POST", body: { name: "Run Log Two", purpose: "p", requirements: "r" } });
      assert.equal(b.json.status, "building");
      const sse = await http(`/api/builds/${b.json.buildId}/events`);
      assert.match(sse.body, /event: line\ndata: ".*→ Write src\/index\.ts"/);
      assert.match(sse.body, /event: done\ndata: \{.*"status":"failed"/s, "fake builder copied running-log's manifest (wrong id): fails validation, still streams to done");
      const failed = (await api(`/builds/${b.json.buildId}`)).json;
      assert.equal(failed.failure.title, "Its description is invalid");
      assert.match(failed.failure.detail, /manifest id 'running-log' must be 'run-log-two'/);
    });

    test("ask builder to fix: a retry that carries the failure as context", async () => {
      const [last] = platform.registry.recentBuilds(1);
      const fix = await api(`/builds/${last}/fix`, { method: "POST" });
      assert.equal(fix.status, 200, JSON.stringify(fix.json));
      assert.match(fix.json.request.requirements, /^r\n\n--- Fix request ---\nThe previous build failed: Its description is invalid\./);
      await platform.settle(fix.json.buildId);
      // Fixing a fix replaces the context rather than stacking it.
      const again = await api(`/builds/${fix.json.buildId}/fix`, { method: "POST" });
      assert.equal(again.json.request.requirements.split("--- Fix request ---").length, 2);
      await platform.settle(again.json.buildId);
    });

    test("a failed build's reason reaches the Inbox and Activity, as its build page leads with it", async () => {
      const [last] = platform.registry.recentBuilds(1);
      const title = (await api(`/builds/${last}`)).json.failure.title;
      const inbox = (await api("/inbox")).json.needs.find((n: any) => n.buildId === last);
      assert.equal(inbox.detail, `Build failed · ${title}`);
      // The builder itself stopped: the title alone ("The builder stopped") says nothing; what it stopped on does.
      const b = await api("/capabilities", { method: "POST", body: { name: "Stops Early", purpose: "p", requirements: "r" } });
      await platform.settle(b.json.buildId);
      const failure = (await api(`/builds/${b.json.buildId}`)).json.failure;
      assert.deepEqual([failure.title, failure.detail], ["The builder stopped", "hit the usage limit"]);
      assert.equal((await api("/inbox")).json.needs.find((n: any) => n.buildId === b.json.buildId).detail, "Build failed · hit the usage limit");
      const row = (await api("/activity")).json.items.find((i: any) => i.buildId === b.json.buildId);
      assert.equal(row.reason, "hit the usage limit");
      assert.equal((await api("/activity")).json.items.find((i: any) => i.buildId === last).reason, title);
    });

    test("home data: hue, icon kind, last build, in-flight builds", async () => {
      const list = (await api("/capabilities")).json;
      const rl = list.find((c: any) => c.id === "running-log");
      assert.equal(rl.iconKind, null, "no icon file");
      assert.equal(rl.lastBuild.status, "promoted");
      assert.equal(rl.building, null);
      assert.equal(list.find((c: any) => c.id === "ui-counter").iconKind, "image", "owner upload");
      assert.equal(list.find((c: any) => c.id === "run-log-two"), undefined, "failed creates are not on Home");
    });

    test("activity: one merged timeline of builds, calls and grant changes, filterable", async () => {
      const all = (await api("/activity")).json;
      const kinds = new Set(all.items.map((i: any) => i.kind));
      assert.deepEqual([...kinds].sort(), ["authority", "build", "call", "grant", "lifecycle"]);
      const sorted = [...all.items].sort((a: any, b: any) => b.at.localeCompare(a.at));
      assert.deepEqual(all.items, sorted, "newest first");
      const grants = all.items.filter((i: any) => i.kind === "grant").map((i: any) => i.outcome);
      assert.ok(grants.includes("approve") && grants.includes("revoke"));
      const one = (await api("/activity?capability=running-log")).json.items;
      assert.ok(one.length && one.every((i: any) => i.capabilityId === "running-log"));
      const mine = (await api("/activity?agent=you")).json.items;
      assert.ok(mine.length && mine.every((i: any) => ["web", "user"].includes(i.actor)));
      const page = (await api("/activity?limit=2")).json;
      assert.equal(page.items.length, 2);
      const next = (await api(`/activity?limit=2&before=${encodeURIComponent(page.next)}`)).json;
      assert.ok(next.items.every((i: any) => i.at < page.next));
    });

    test("settings: read and write platform.json, validated; no discovery option", async () => {
      const s = (await api("/settings")).json;
      assert.deepEqual(Object.keys(s).sort(), ["builder", "intake", "logRetentionDays", "maxBuildAttempts", "sandbox"]);
      assert.equal(s.logRetentionDays, 14);
      assert.equal((await api("/settings", { method: "PUT", body: { logRetentionDays: -1 } })).status, 400);
      assert.equal((await api("/settings", { method: "PUT", body: { logRetentionDays: 0 } })).json.logRetentionDays, 0);
      await api("/settings", { method: "PUT", body: { logRetentionDays: 14 } });
      assert.equal((await api("/settings", { method: "PUT", body: { maxBuildAttempts: 9 } })).status, 400);
      const next = (await api("/settings", { method: "PUT", body: { maxBuildAttempts: 2, discovery: "tools" } })).json;
      assert.equal(next.maxBuildAttempts, 2);
      assert.equal(JSON.parse(readFileSync(`${t.home.root}/platform.json`, "utf8")).discovery, undefined);
    });

    test("connect an agent: registers the address, then the harness signs in (no token anywhere)", async () => {
      const list = (await api("/setup/agents")).json;
      assert.deepEqual(list, [
        { agentId: "fake-agent", label: "Fake Agent", found: true, connected: false },
        { agentId: "codex-desktop", label: "Codex Desktop", found: false, connected: false, via: "codex" },
        { agentId: "claude-desktop", label: "Claude Desktop", found: true, connected: false, cloud: true },
      ]);
      // Claude Desktop goes through the tunnel; Codex Desktop through the Codex CLI's settings.
      const desktop = await api("/setup/agents/claude-desktop", { method: "POST" });
      assert.equal(desktop.status, 400);
      assert.match(desktop.json.message, /through your tunnel/);
      assert.match((await api("/setup/agents/codex-desktop", { method: "POST" })).json.message, /uses the codex CLI's settings/);
      const r = await http("/api/setup/agents/fake-agent", { method: "POST", headers: { "x-hewn-ui": "1" } });
      assert.equal(r.status, 200);
      assert.match(r.body, /event: plan\ndata: \{"steps":\[\{"kind":"pointer","file":"~\/\.fake\/AGENTS\.md"\},\{"kind":"register"\},\{"kind":"login"\}\]\}/);
      assert.match(r.body, /event: login\ndata: \{"line":"opening http:\/\/127\.0\.0\.1:\d+\/mcp"\}/);
      assert.match(r.body, /event: done\ndata: \{"ok":true,"agentId":"fake-agent"\}/);
      assert.match(setupRan[0], /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.ok(!/hewn_at_|Bearer/.test(r.body));
      assert.deepEqual((await api("/setup/agents")).json.map((x: any) => x.connected), [true, false, false]);
      assert.equal((await api("/setup/agents/nope", { method: "POST" })).status, 404);
    });

    test("status: version, data format, backups; first run only on an empty Hewn not yet finished", async () => {
      const st = (await api("/status")).json;
      assert.equal(st.firstRun, false, "capabilities exist");
      assert.equal(typeof st.version, "string");
      assert.equal(st.dataFormat, 1);
      assert.ok(Array.isArray((await api("/tools")).json));
      assert.equal((await api("/settings", { method: "PUT", body: { firstRunDone: true } })).json.firstRunDone, true);
    });

    test("schedules from the web: create, pause, list", async () => {
      const made = await api("/schedules", { method: "POST", body: { capabilityId: "ui-counter", operation: "increment", cadence: "daily 07:00" } });
      assert.equal(made.status, 200, JSON.stringify(made.json));
      assert.equal(made.json.status, "active");
      assert.equal((await api(`/schedules/${made.json.id}`, { method: "PUT", body: { status: "paused" } })).json.status, "paused");
      assert.ok((await api("/schedules")).json.some((x: any) => x.id === made.json.id && x.status === "paused"));
      assert.equal((await api("/schedules", { method: "POST", body: { capabilityId: "ui-counter", operation: "increment", cadence: "every second" } })).status, 400);
    });

    test("authority changes show on Activity", async () => {
      platform.setSecret(USER, "secret-echo", "API_TOKEN", "x");
      const items = (await api("/activity?limit=300")).json.items;
      assert.ok(items.some((i: any) => i.kind === "authority" && i.outcome === "secret_set" && i.subject === "API_TOKEN" && i.capabilityId === "secret-echo"));
      assert.deepEqual((await api("/confirmations")).json, []);
      assert.equal((await api("/confirmations/nope", { method: "POST", body: { approve: true } })).status, 404);
    });

    test("another MCP client: just the address (it signs in with OAuth)", async () => {
      const m = (await api("/setup/manual")).json;
      assert.match(m.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.equal(m.publicUrl, null);
      assert.equal(m.token, undefined);
      assert.match(m.pointer, /live in the `hewn` MCP server/);
    });

    test("delete has an undo: restore from the web, and a list of deleted capabilities", async () => {
      await api("/capabilities/ui-counter", { method: "DELETE", body: { confirm: "ui-counter" } });
      assert.deepEqual((await api("/capabilities?archived=1")).json.map((c: any) => c.id), ["ui-counter"]);
      assert.equal((await api("/capabilities/ui-counter/restore", { method: "POST" })).status, 200);
      assert.ok((await api("/capabilities")).json.some((c: any) => c.id === "ui-counter"));
      assert.deepEqual((await api("/capabilities?archived=1")).json, []);
      assert.equal((await api("/capabilities/ui-counter/restore", { method: "POST" })).status, 404, "not archived");
    });

    test("owner glyph and hue: stored as a clean 5×5 SVG, tinted by the tile", async () => {
      const rows = ["....#", "...##", "..###", ".####", "#####"];
      assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { glyph: rows, hue: 30 } })).status, 200);
      let rl = (await api("/capabilities")).json.find((c: any) => c.id === "running-log");
      assert.equal(rl.iconKind, "glyph");
      assert.equal(rl.hue, 30);
      const svg = (await http("/api/capabilities/running-log/icon")).body;
      assert.equal(svg.match(/<rect /g)!.length, 15);
      // ?default=1: the builder's glyph only (Use default's preview); this one has none.
      assert.equal((await http("/api/capabilities/running-log/icon?default=1")).status, 404);
      // An SVG is accepted too, but only its cells survive.
      const hostile = '<svg viewBox="0 0 5 5"><script>alert(1)</script><rect x="0" y="0" width="5" height="1" onload="x()"/></svg>';
      assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { glyph: hostile } })).status, 200);
      const clean = (await http("/api/capabilities/running-log/icon")).body;
      assert.ok(!/script|onload/.test(clean));
      assert.equal(clean.match(/<rect /g)!.length, 5);
      assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { glyph: ["#"] } })).status, 400);
      assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { hue: 400 } })).status, 400);
      // Saturation: 0 (black or white on grey) to 150; the cap keeps tiles from turning neon.
      assert.equal(rl.saturation, null, "the default");
      assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { saturation: 0 } })).status, 200);
      assert.equal((await api("/capabilities")).json.find((c: any) => c.id === "running-log").saturation, 0);
      assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { saturation: 151 } })).status, 400);
      assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { saturation: 12.5 } })).status, 400);
      await api("/capabilities/running-log/icon", { method: "DELETE" });
      rl = (await api("/capabilities")).json.find((c: any) => c.id === "running-log");
      assert.equal(rl.iconKind, null);
      assert.equal(rl.hue, null, "back to the manifest's (none)");
      assert.equal(rl.saturation, null);
    });

    test("cancel from the web", async () => {
      const r = await api("/builds/nope/cancel", { method: "POST" });
      assert.equal(r.status, 404);
    });

    test("the builds list: newest first, with times; brief leaves the logs out", async () => {
      const full = (await api("/builds?n=200")).json;
      assert.ok(full.length > 1 && full.some((b: any) => b.log.length));
      assert.ok(full.every((b: any) => typeof b.createdAt === "string" && typeof b.updatedAt === "string"));
      assert.deepEqual(full.map((b: any) => b.createdAt), [...full.map((b: any) => b.createdAt)].sort().reverse());
      const brief = (await api("/builds?n=200&brief=1")).json;
      assert.deepEqual(brief.map((b: any) => b.buildId), full.map((b: any) => b.buildId));
      assert.ok(brief.every((b: any) => b.log.length === 0));
      assert.ok(brief.some((b: any) => b.failure?.title), "failed builds keep their reason");
    });

    test("Home order is the owner's: saved, then everything else oldest first", async () => {
      assert.equal((await api("/home/order", { method: "PUT", body: { ids: ["ui-counter", "nope"] } })).status, 200);
      const ids = (await api("/capabilities")).json.map((c: any) => c.id);
      assert.equal(ids[0], "ui-counter");
      const created = (id: string) => platform.registry.getCapability(id)!.createdAt;
      assert.deepEqual(ids.slice(1), [...ids.slice(1)].sort((a, b) => created(a).localeCompare(created(b))), "the rest by creation, so a new one lands last");
      assert.equal((await api("/home/order", { method: "PUT", body: { ids: "x" } })).status, 400);
    });

    test("Home widgets: gallery, layout, refresh; the renderer is a platform asset", async () => {
      await installFrom(platform, resolve(FIX, "widget-counter"));
      const home = (await api("/home")).json;
      assert.deepEqual(home.gallery.map((g: any) => [g.capabilityId, g.widgets.map((w: any) => w.name)]), [["widget-counter", ["count"]]]);
      const entries = [{ type: "widget", key: "w1", id: "widget-counter", widget: "count", size: "medium" }, { type: "icon", id: "ui-counter" }];
      const put = await api("/home/layout", { method: "PUT", body: { entries } });
      assert.equal(put.status, 200);
      assert.deepEqual(put.json.layout.map((e: any) => e.key ?? e.id), ["w1", "ui-counter"]);
      assert.equal((await api("/home/layout", { method: "PUT", body: { entries: [{ ...entries[0], size: "large" }] } })).status, 400);
      const r = (await api("/home/widgets/w1/refresh", { method: "POST" })).json;
      assert.equal(r.view.template, "stat");
      assert.equal(r.error, null);
      assert.equal((await api("/home")).json.layout[0].view.template, "stat", "the cached view comes with the layout");
      assert.equal((await api("/home/widgets/nope/refresh", { method: "POST" })).status, 404);
      const js = await http("/_platform/widgets.js");
      assert.equal(js.status, 200);
      assert.match(js.body, /export function renderWidget/);
      assert.doesNotMatch(js.body, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/);
      await api("/home/layout", { method: "PUT", body: { entries: [] } });
    });

    test("Accounts: connections with health and users; config, approval and sign-in from the web", async () => {
      await installFrom(platform, resolve(FIX, "login-connection"));
      await installFrom(platform, resolve(FIX, "site-connection"));
      assert.equal((await api("/capabilities")).json.find((c: any) => c.id === "login-connection").kind, "connection", "Home can leave connections out");
      let accounts = (await api("/accounts")).json;
      assert.deepEqual(accounts.connections.map((c: any) => c.id).sort(), ["login-connection", "secret-echo", "site-connection"]);
      const login = accounts.connections.find((c: any) => c.id === "login-connection");
      assert.equal(login.health.status, "needs_setup");
      assert.equal(login.signIn.operation, "connect@1");
      assert.deepEqual(login.secrets, [{ name: "TOKENS", description: "Session tokens, stored by signing in", set: false }]);
      assert.equal(accounts.legacy, undefined, "no 0.1 list");

      assert.equal((await api("/capabilities/site-connection/config/SITE_URL", { method: "PUT", body: { value: "nope" } })).status, 400);
      assert.equal((await api("/capabilities/site-connection/config/SITE_URL", { method: "PUT", body: { value: "https://example.com" } })).status, 200);
      await api("/capabilities/login-connection/grants/approve", { method: "POST" });
      const signIn = await api("/capabilities/login-connection/connect", { method: "POST", body: { input: { email: "a@example.com", password: "hunter2" } } });
      assert.deepEqual(signIn.json, { status: "connected" });
      assert.equal((await api("/capabilities/login-connection/health")).json.status, "connected");
      accounts = (await api("/accounts")).json;
      assert.equal(accounts.connections.find((c: any) => c.id === "login-connection").health.status, "connected");
      assert.deepEqual(accounts.connections.find((c: any) => c.id === "site-connection").config[0].value, "https://example.com");
    });

    test("Settings → Models: keys are write-only; one active provider; tiers and the cap round-trip", async () => {
      // No network here: the key can't be checked, so it's kept with that reason (only a refused key isn't).
      const set = await api("/models/keys/anthropic", { method: "PUT", body: { key: "sk-ant-web-test-1" } });
      assert.equal(set.status, 200);
      assert.equal(set.json.provider, "anthropic", "the first key makes its provider active");
      const m = (await api("/models")).json;
      const anthropic = m.providers.find((p: any) => p.id === "anthropic");
      assert.equal(anthropic.keySet, true);
      assert.match(anthropic.check.error, /can't reach model providers/);
      assert.ok(!JSON.stringify(m).includes("sk-ant-web-test-1"), "the key never comes back");
      const put = await api("/models", { method: "PUT", body: { tiers: { anthropic: { light: "claude-haiku-5-5" } }, monthlyCapUsd: 12 } });
      assert.equal(put.json.monthlyCapUsd, 12);
      assert.equal(put.json.providers.find((p: any) => p.id === "anthropic").tiers.light, "claude-haiku-5-5");
      assert.equal((await api("/models", { method: "PUT", body: { monthlyCapUsd: -3 } })).status, 400);
      assert.equal((await api("/models", { method: "PUT", body: { provider: "openai" } })).status, 400, "no OpenAI key");
      const removed = await api("/models/keys/anthropic", { method: "DELETE" });
      assert.equal(removed.json.provider, null, "removing the active key leaves no provider");
      assert.equal((await api("/models", { cookie: "" })).status, 401, "owner only");
    });

    test("one grant at a time from the web", async () => {
      const pending = async () => (await api("/capabilities/site-connection")).json.status.pendingGrants as string[];
      const [first, ...rest] = await pending();
      assert.ok(rest.length);
      assert.deepEqual((await api("/capabilities/site-connection/grants/approve", { method: "POST", body: { grant: first } })).json.approved, [first]);
      assert.deepEqual(await pending(), rest);
      assert.equal((await api("/capabilities/site-connection/grants/approve", { method: "POST", body: { grant: "host:elsewhere.example" } })).status, 400);
    });

    test("the Inbox: what needs the owner in one list, what builds, and recent Activity on request", async () => {
      const r = (await api("/inbox")).json;
      assert.ok(Array.isArray(r.needs) && Array.isArray(r.building));
      assert.equal(r.recent, undefined, "recent only when asked for");
      for (const n of r.needs) {
        assert.ok(["warn", "danger"].includes(n.severity), JSON.stringify(n));
        assert.ok(n.title && n.detail && n.action && n.kind && n.id, JSON.stringify(n));
      }
      // Secret Echo is a connection waiting for its secret: one row, to set it up.
      assert.ok(r.needs.some((n: any) => n.capabilityId === "secret-echo" && n.kind === "connection"), JSON.stringify(r.needs));
      const withRecent = (await api("/inbox?recent=1")).json;
      assert.ok(Array.isArray(withRecent.recent) && withRecent.recent.length <= 6);
    });

    test("owner settings: time zone (validated, used for new schedules) and the jobs the owner chose", async () => {
      assert.equal((await api("/settings", { method: "PUT", body: { timeZone: "Mars/Olympus" } })).status, 400);
      assert.equal((await api("/settings", { method: "PUT", body: { jobsChosen: ["cook"] } })).status, 400);
      const s = (await api("/settings", { method: "PUT", body: { timeZone: "Asia/Tokyo", jobsChosen: ["builder"] } })).json;
      assert.equal(s.timeZone, "Asia/Tokyo");
      assert.deepEqual(s.jobsChosen, ["builder"]);
      const made = (await api("/schedules", { method: "POST", body: { capabilityId: "ui-counter", operation: "increment", cadence: "daily 07:00" } })).json;
      assert.equal(made.timezone, "Asia/Tokyo", "new schedules use the owner's time zone");
      await api(`/schedules/${made.id}`, { method: "DELETE" });
    });

    test("status says the ABI (and the newest release, null when unknown); backups say whether they share a disk", async () => {
      const st = (await api("/status")).json;
      assert.match(st.abi, /^\d+\.\d+$/);
      assert.ok(st.latest === undefined || st.latest === null || typeof st.latest === "string");
      const b = (await api("/backups")).json;
      assert.equal(b.sameDisk, true, "the default backup folder sits next to the data");
      assert.match((await api("/remote")).json.proxyTo, /^127\.0\.0\.1:\d+$/);
    });

    test("Home: a tool hidden from Home keeps its place; Activity filters by kind", async () => {
      const layout = (await api("/home/layout", { method: "PUT", body: { entries: [{ type: "icon", id: "running-log", hidden: true }, { type: "icon", id: "ui-counter" }] } })).json.layout;
      assert.deepEqual(layout.slice(0, 2), [{ type: "icon", id: "running-log", hidden: true }, { type: "icon", id: "ui-counter" }]);
      await api("/home/layout", { method: "PUT", body: { entries: [] } });
      const builds = (await api("/activity?kinds=build&limit=50")).json.items;
      assert.ok(builds.length > 0 && builds.every((i: any) => i.kind === "build"));
    });
  });
});
