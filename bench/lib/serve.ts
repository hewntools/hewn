// SPDX-License-Identifier: AGPL-3.0-or-later
// The run's gallery on this machine: every result side by side, each tool live (clickable, on a copy of
// its seeded state), a blind pairwise vote, and the per-arm summary.
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { loadCases } from "./cases.ts";
import { readJudge } from "./judge.ts";
import { benchPlatform, served, type BenchPlatform } from "./platform.ts";
import { listResults, type Result } from "./run.ts";
import { summarize, votesFile, readVotes, type Vote } from "./summary.ts";
import { readBody, startUiServer, TYPES, type Served } from "./ui-server.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function serveRun(runDir: string, o: { port?: number } = {}) {
  const cases = new Map((await loadCases().catch(() => [])).map((c) => [c.id, c]));
  const index = () => listResults(runDir);
  const byKey = (key: string) => index().find((r) => r.key === key);
  const live = new Map<string, { bp: BenchPlatform; s: Served }>();

  /** A result's tool, live on a copy of its seeded state (made on first open, kept until reset). */
  const open = (key: string): Served | undefined => {
    if (live.has(key)) return live.get(key)!.s;
    const r = byKey(key);
    if (r?.result?.status !== "done" || !r.result.capabilityId) return undefined;
    const home = join(r.dir, "live-home");
    if (!existsSync(home)) cpSync(join(r.dir, "home"), home, { recursive: true });
    const bp = benchPlatform(home);
    const s = served(bp.platform, r.result.capabilityId, join(r.dir, "version"));
    live.set(key, { bp, s });
    return s;
  };
  const reset = (key: string) => {
    live.get(key)?.bp.close();
    live.delete(key);
    const r = byKey(key);
    if (r) rmSync(join(r.dir, "live-home"), { recursive: true, force: true });
  };

  const pairs = new Map<string, Omit<Vote, "at" | "winner" | "daily">>();
  /** The next blind pair: two arms' results for the same case, the least-compared pair first. */
  const nextPair = () => {
    const done = index().filter((r) => r.result?.status === "done");
    const votes = readVotes(runDir);
    const options: { case: string; a: (typeof done)[number]; b: (typeof done)[number]; seen: number }[] = [];
    for (const a of done)
      for (const b of done) {
        if (a.key >= b.key || a.result!.case !== b.result!.case || a.result!.arm === b.result!.arm) continue;
        const seen = votes.filter((v) => [v.left.key, v.right.key].sort().join() === [a.key, b.key].sort().join()).length;
        options.push({ case: a.result!.case, a, b, seen });
      }
    if (!options.length) return undefined;
    const least = Math.min(...options.map((p) => p.seen));
    const pool = options.filter((p) => p.seen === least);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const [left, right] = Math.random() < 0.5 ? [pick.a, pick.b] : [pick.b, pick.a];
    const id = randomUUID();
    pairs.set(id, { case: pick.case, left: { arm: left.result!.arm, key: left.key }, right: { arm: right.result!.arm, key: right.key } });
    const side = (r: typeof left) => ({ key: r.key, desktop: `/f/${r.key}/shots/desktop-light.png`, desktopDark: `/f/${r.key}/shots/desktop-dark.png`, mobile: `/f/${r.key}/shots/mobile-light.png`, live: `/live/${r.key}` });
    return { id, case: pick.case, name: cases.get(pick.case)?.name ?? pick.case, purpose: cases.get(pick.case)?.purpose ?? "", seen: least, left: side(left), right: side(right) };
  };

  const page = (title: string, body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/_platform/ui.css"><style>${CSS}</style></head><body><main class="page stack bench">${NAV}${body}</main></body></html>`;

  const gallery = () => {
    const rs = index();
    const arms = [...new Set(rs.map((r) => r.result?.arm ?? r.job?.arm))].filter(Boolean) as string[];
    const caseIds = [...new Set(rs.map((r) => r.result?.case ?? r.job?.case))].filter(Boolean) as string[];
    const meta = existsSync(join(runDir, "run.json")) ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) : {};
    const about = new Map<string, string>((meta.arms ?? []).map((a: { name: string; about: string }) => [a.name, a.about]));
    const td = (r: (typeof rs)[number] | undefined) => {
      if (!r) return `<td></td>`;
      const res: Result | undefined = r.result;
      if (!res) return `<td><span class="pill">running…</span></td>`;
      if (res.status !== "done") return `<td><span class="pill bad">failed</span><pre class="err">${esc(res.error?.slice(-600))}</pre><a href="/f/${r.key}/run.log">log</a></td>`;
      const j = readJudge(r.dir);
      const errs = Object.values(res.pageErrors ?? {}).flat().length;
      const flags = [
        res.seedError ? `<span class="pill warn" title="${esc(res.seedError)}">seed error</span>` : "",
        errs ? `<span class="pill bad" title="${esc(Object.values(res.pageErrors ?? {}).flat().join("\n"))}">${errs} page error${errs > 1 ? "s" : ""}</span>` : "",
        res.clicks?.failures.length ? `<span class="pill bad" title="${esc(res.clicks.failures.map((f) => `${f.label}: ${f.errors.join("; ")}`).join("\n"))}">${res.clicks.failures.length} broken click${res.clicks.failures.length > 1 ? "s" : ""}</span>` : "",
        (res.overflowMobile ?? 0) > 1 ? `<span class="pill warn">phone overflow ${res.overflowMobile}px</span>` : "",
        res.clicks?.dialogs?.length ? `<span class="pill" title="${esc(res.clicks.dialogs.map((d) => `${d.label}: ${d.dialogs.join("; ")}`).join("\n"))}">${res.clicks.dialogs.length} browser dialog${res.clicks.dialogs.length > 1 ? "s" : ""}</span>` : "",
      ].join(" ");
      return `<td><a href="/f/${r.key}/shots/desktop-light.png" target="_blank"><img class="thumb" src="/f/${r.key}/shots/desktop-light.png" loading="lazy" alt=""></a>
        <div class="row between small"><span>${j ? `<strong>${j.total}</strong>/60` : "not judged"}</span><span class="muted">${res.usage ? `$${res.usage.usd} · ${res.usage.minutes} min` : ""}</span></div>
        <div class="small">${flags}</div>
        ${j ? `<details class="small"><summary>judge</summary><p>Design ${j.design_quality} · original ${j.originality} · craft ${j.craft} · useful ${j.usefulness}</p><p><strong>Best:</strong> ${esc(j.best)}</p><ul>${j.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>${j.tells.length ? `<p><strong>Tells:</strong> ${esc(j.tells.join("; "))}</p>` : ""}</details>` : ""}
        <div class="links small"><a href="/live/${r.key}" target="_blank">open live</a> <a href="/f/${r.key}/shots/desktop-dark.png" target="_blank">dark</a> <a href="/f/${r.key}/shots/mobile-light.png" target="_blank">phone</a> <a href="/f/${r.key}/shots/mobile-dark.png" target="_blank">phone dark</a> <a href="/f/${r.key}/shots/empty-light.png" target="_blank">empty</a> <a href="/f/${r.key}/result.json" target="_blank">result</a> <a href="/f/${r.key}/run.log" target="_blank">log</a> <form method="post" action="/reset/${r.key}"><button class="ghost sm" title="Throw away what you changed in the live tool">reset</button></form></div></td>`;
    };
    const table = caseIds
      .map((c) => {
        const reps = [...new Set(rs.filter((r) => (r.result?.case ?? r.job?.case) === c).map((r) => r.result?.rep ?? r.job?.rep))].sort();
        return reps
          .map((rep) => `<tr><th scope="row">${esc(cases.get(c)?.name ?? c)}${reps.length > 1 ? ` <span class="muted">r${rep}</span>` : ""}</th>${arms.map((a) => td(rs.find((r) => (r.result?.arm ?? r.job?.arm) === a && (r.result?.case ?? r.job?.case) === c && (r.result?.rep ?? r.job?.rep) === rep))).join("")}</tr>`)
          .join("");
      })
      .join("");
    return page(
      `Bench ${meta.name ?? ""}`,
      `<h1>${esc(meta.name ?? "Bench run")}</h1><p class="muted">${esc(meta.commit ?? "")}${meta.dirty ? " (uncommitted changes)" : ""} · brief ${esc(meta.briefSha ?? "")} · ${esc(meta.claude ?? "")}</p>
      <div class="table-wrap"><table class="grid-table"><thead><tr><th></th>${arms.map((a) => `<th title="${esc(about.get(a) ?? "")}">${esc(a)}<div class="muted small">${esc(about.get(a) ?? "")}</div></th>`).join("")}</tr></thead><tbody>${table}</tbody></table></div>`,
    );
  };

  const summaryPage = () => {
    const s = summarize(runDir);
    const v = (x: unknown) => (x === undefined ? "–" : esc(x));
    return page(
      "Summary",
      `<h1>Summary</h1><div class="table-wrap"><table><thead><tr><th>Arm</th><th>Built</th><th>$ / result</th><th>Min</th><th>Judge /60</th><th>Design</th><th>Original</th><th>Craft</th><th>Useful</th><th>Sameness /10</th><th>Your win % (n)</th><th>Would open daily %</th><th>UI KB</th><th>CSS KB</th><th>SVG</th><th>Motion</th><th>Page errors</th><th>Broken clicks</th><th>Phone overflow</th></tr></thead><tbody>${s
        .map(
          (a) =>
            `<tr><th scope="row">${esc(a.arm)}</th><td>${a.done}/${a.results}${a.seedErrors ? ` (${a.seedErrors} seed err)` : ""}</td><td class="num">${v(a.usd)}</td><td class="num">${v(a.minutes)}</td><td class="num"><strong>${v(a.judge?.total)}</strong></td><td class="num">${v(a.judge?.design_quality)}</td><td class="num">${v(a.judge?.originality)}</td><td class="num">${v(a.judge?.craft)}</td><td class="num">${v(a.judge?.usefulness)}</td><td class="num">${v(a.sameness)}</td><td class="num"><strong>${a.votes ? `${a.votes.winRate}` : "–"}</strong>${a.votes ? ` (${a.votes.n})` : ""}</td><td class="num">${v(a.votes?.daily)}</td><td class="num">${v(a.ui?.kb)}</td><td class="num">${v(a.ui?.cssKb)}</td><td class="num">${v(a.ui?.svgSites)}</td><td class="num">${v(a.ui?.motion)}</td><td class="num">${a.pageErrors}</td><td class="num">${a.clickFailures}</td><td class="num">${a.overflowing}</td></tr>`,
        )
        .join("")}</tbody></table></div>
      <h2>Tells the judge saw most</h2><ul>${s.map((a) => `<li><strong>${esc(a.arm)}:</strong> ${esc(a.tells.map(([t, n]) => `${t} (${n})`).join("; ") || "none")}</li>`).join("")}</ul>`,
    );
  };

  const server = await startUiServer(open, {
    port: o.port,
    extra: async (req, res, url) => {
      const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
      if (url.pathname === "/") return html(gallery()), true;
      if (url.pathname === "/summary") return html(summaryPage()), true;
      if (url.pathname === "/vote") return html(page("Blind vote", VOTE_HTML)), true;
      if (url.pathname === "/api/pair") return json(200, nextPair() ?? { done: true }), true;
      if (url.pathname === "/api/vote" && req.method === "POST") {
        const b = JSON.parse((await readBody(req)) || "{}");
        const p = pairs.get(b.id);
        if (!p || !["left", "right", "tie"].includes(b.winner)) return json(400, { error: "unknown pair or answer" }), true;
        pairs.delete(b.id);
        const vote: Vote = { at: new Date().toISOString(), ...p, winner: b.winner, daily: { left: !!b.daily?.left, right: !!b.daily?.right } };
        appendFileSync(votesFile(runDir), JSON.stringify(vote) + "\n");
        return json(200, { ok: true, votes: readVotes(runDir).length }), true;
      }
      const lv = /^\/live\/([a-f0-9]+)$/.exec(url.pathname);
      if (lv) {
        const s = open(lv[1]);
        if (!s) return json(404, { error: "no such result, or it failed" }), true;
        return res.writeHead(302, { location: server.url(lv[1], s.id) }).end(), true;
      }
      const rs = /^\/reset\/([a-f0-9]+)$/.exec(url.pathname);
      if (rs && req.method === "POST") return reset(rs[1]), res.writeHead(303, { location: "/" }).end(), true;
      const f = /^\/f\/([a-f0-9]+)\/(.+)$/.exec(url.pathname);
      if (f) {
        const r = byKey(f[1]);
        const rel = normalize(decodeURIComponent(f[2]));
        if (!r || rel.startsWith("..") || !/^(shots\/|transcripts\/|version\/|result\.json$|judge\.json$|job\.json$|run\.log$)/.test(rel)) return json(404, { error: "not found" }), true;
        const file = join(r.dir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return json(404, { error: "not found" }), true;
        return res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(file)), true;
      }
      return false;
    },
  });
  return server;
}

const NAV = `<nav class="row bench-nav"><a href="/">Gallery</a><a href="/vote">Blind vote</a><a href="/summary">Summary</a></nav>`;

const CSS = `
.bench { max-width: none; }
.bench-nav { gap: 1rem; }
.grid-table { table-layout: fixed; }
.grid-table th, .grid-table td { vertical-align: top; min-width: 300px; }
.grid-table th { text-transform: none; letter-spacing: normal; font-family: inherit; font-size: var(--fs-md, 1rem); color: var(--text, inherit); }
.grid-table th .muted { font-weight: normal; }
.grid-table th[scope="row"], .grid-table thead th:first-child { min-width: 0; width: 9rem; }
.thumb { width: 100%; height: 300px; object-fit: cover; object-position: top; border: 1px solid var(--border, #8884); border-radius: 8px; display: block; }
.small { font-size: var(--fs-sm, 0.85rem); }
.links { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
.links form { display: inline; }
pre.err { white-space: pre-wrap; max-height: 12rem; overflow: auto; font-size: 0.75rem; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
.pair img { width: 100%; border: 1px solid var(--border, #8884); border-radius: 8px; display: block; }
.side .phone { max-width: 220px; }
.shots { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: start; }
`;

const VOTE_HTML = `<h1>Blind vote</h1>
<p class="muted" id="ctx">Two builds of the same tool, from different setups, in random order. Which one would you rather have? Open them live to click around.</p>
<div id="pair"></div>
<script type="module">
const el = document.getElementById("pair");
let cur;
async function load() {
  cur = await (await fetch("/api/pair")).json();
  if (cur.done) { el.innerHTML = '<p class="empty"><strong>Nothing to compare yet.</strong> A case needs results from two arms.</p>'; return; }
  document.getElementById("ctx").textContent = cur.name + ": " + cur.purpose + (cur.seen ? " (this pair has " + cur.seen + " vote(s) already)" : "");
  const side = (s, name) => '<div class="side stack"><h2>' + name + '</h2><div class="shots"><a href="' + s.desktop + '" target="_blank"><img src="' + s.desktop + '" alt=""></a><a href="' + s.mobile + '" target="_blank"><img class="phone" src="' + s.mobile + '" alt=""></a></div><div class="row"><a class="btn" href="' + s.live + '" target="_blank">Open ' + name + ' live</a><a href="' + s.desktopDark + '" target="_blank">dark</a><label class="row"><input type="checkbox" id="daily-' + name + '"> I\\'d open this daily</label></div></div>';
  el.innerHTML = '<div class="row" style="gap:.5rem;margin-bottom:1rem"><button class="primary" data-w="left">A is better</button><button data-w="tie">About the same</button><button class="primary" data-w="right">B is better</button><span class="muted">keys: a · s · b</span></div><div class="pair">' + side(cur.left, "A") + side(cur.right, "B") + '</div>';
  el.querySelectorAll("button[data-w]").forEach((b) => b.onclick = () => vote(b.dataset.w));
}
async function vote(winner) {
  const daily = { left: document.getElementById("daily-A")?.checked, right: document.getElementById("daily-B")?.checked };
  await fetch("/api/vote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: cur.id, winner, daily }) });
  scrollTo(0, 0);
  load();
}
addEventListener("keydown", (e) => { if (e.target.tagName === "INPUT" || !cur || cur.done) return; if (e.key === "a") vote("left"); if (e.key === "b") vote("right"); if (e.key === "s") vote("tie"); });
load();
</script>`;
