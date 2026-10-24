// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's own docs for agents and the intake: the pages the hosts serve, the search over them,
// hewn_docs over MCP, and the intake's "answer" to a question about Hewn.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DOC_PAGES, type DocPage, docExcerpts, docSections, docsText, findPage, readDocs, searchDocs, sectionText, slug } from "@hewntools/core/docs.ts";
import { hewnDocs, sourceAsset } from "@hewntools/cli/assets.ts";
import { intakePrompt, looksLikeQuestion, parseIntake, SCHEMA } from "@hewntools/cli/intake.ts";
import { serverUrl } from "@hewntools/test-host/server.ts";
import { serve, setup, TOKENS } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");

const PAGES: DocPage[] = [
  {
    name: "docs/garden.md",
    text: "# Garden\n\nIntro about the garden.\n\n## Watering\n\nWater the plants every morning. Watering in the evening works too.\n\n### Rain\n\nSkip it when it rains.\n\n## Compost\n\n```sh\n# not a heading: a shell comment about watering\n```\n\nKitchen scraps go in the compost. Plants like compost.\n",
  },
  { name: "spec/tools.md", text: "# Writing a tool\n\n## Widgets (since 2.3)\n\nA widget is a card. Its sizes: small, medium, large.\n\n## Grants\n\nThe owner approves each grant: hosts, secrets, plants.\n" },
];

describe("docs: the pages", () => {
  test("DOC_PAGES is every page of docs/ and spec/ (not docs/internal/); the CLI serves them and nothing else there", async () => {
    const md = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`);
    assert.deepEqual([...DOC_PAGES].sort(), [...md("docs"), ...md("spec")].sort());
    const pages = await hewnDocs();
    assert.deepEqual(pages.map((p) => p.name), DOC_PAGES);
    assert.equal(pages[0].text, readFileSync(join(ROOT, "docs", "README.md"), "utf8"));
    for (const path of ["docs/internal/architecture.md", "docs/images/spec-proposal.png", "spec/src/agents.ts", "spec/package.json", "docs/../README.md", "docs/"]) assert.equal(await sourceAsset(path), undefined, path);
    assert.ok(await sourceAsset("spec/agents.md"));
  });

  test("readDocs: what the host's asset lookup finds, in reading order", async () => {
    const pages = await readDocs(async (p) => (p === "spec/agents.md" || p === "docs/README.md" ? new TextEncoder().encode(`# ${p}`) : undefined));
    assert.deepEqual(pages, [{ name: "docs/README.md", text: "# docs/README.md" }, { name: "spec/agents.md", text: "# spec/agents.md" }]);
  });
});

describe("docs: sections and search", () => {
  test("a page is cut at every heading, not inside code blocks; anchors as GitHub makes them", () => {
    const s = docSections(PAGES[0]);
    assert.deepEqual(s.map((x) => [x.heading, x.level, x.slug]), [["Garden", 1, "garden"], ["Watering", 2, "watering"], ["Rain", 3, "rain"], ["Compost", 2, "compost"]]);
    assert.ok(s.every((x) => x.title === "Garden" && x.page === "docs/garden.md"));
    assert.match(s[3].text, /^## Compost\n\n```sh\n# not a heading/);
    assert.equal(slug("Widgets (since 2.3)"), "widgets-since-23");
    assert.equal(slug("Hewn's two jobs"), "hewns-two-jobs");
    // Text before the first heading is a section of its own, under the page's title.
    assert.deepEqual(docSections({ name: "x.md", text: "Intro.\n\n## A\n\nb" }).map((x) => [x.heading, x.level]), [["A", 0], ["A", 2]]);
  });

  test("search: the best sections first, a heading above a mention; no match, or only stop words: nothing", () => {
    assert.deepEqual(searchDocs(PAGES, "how do I water my plants?").map((x) => x.heading), ["Watering", "Compost", "Grants"]);
    assert.equal(searchDocs(PAGES, "compost")[0].heading, "Compost");
    assert.equal(searchDocs(PAGES, "widget sizes")[0].heading, "Widgets (since 2.3)");
    assert.equal(searchDocs(PAGES, "plants", 1).length, 1);
    assert.deepEqual(searchDocs(PAGES, "xyzzy"), []);
    assert.deepEqual(searchDocs(PAGES, "how does it work?"), []);
    assert.deepEqual(searchDocs(PAGES, ""), []);
  });

  test("pages by forgiving names; one section with the ones under it", () => {
    assert.equal(findPage(PAGES, "garden")?.name, "docs/garden.md");
    assert.equal(findPage(PAGES, "../spec/tools.md")?.name, "spec/tools.md");
    assert.equal(findPage(PAGES, "tools.md")?.name, "spec/tools.md", "the one page of that name");
    assert.equal(findPage(PAGES, "nope"), undefined);
    assert.match(sectionText(PAGES[0], "watering")!.text, /^## Watering[^]*### Rain\n\nSkip it when it rains\.$/);
    assert.deepEqual(sectionText(PAGES[1], "Widgets (since 2.3)"), sectionText(PAGES[1], "widgets-since-23"));
    assert.equal(sectionText(PAGES[1], "widget")?.slug, "widgets-since-23", "or the first whose anchor has it");
    assert.equal(sectionText(PAGES[0], "pruning"), undefined);
  });

  test("excerpts for a prompt: the best sections, each under its page and heading, within the budget", () => {
    const text = docExcerpts(PAGES, "watering plants", 10_000);
    assert.match(text, /^--- docs\/garden\.md#watering \(Garden › Watering\) ---\n## Watering\n/);
    assert.ok(docExcerpts(PAGES, "watering plants", 300).length <= 300);
    assert.equal(docExcerpts(PAGES, "xyzzy", 10_000), "");
  });

  test("the real docs: questions find the page that answers them", async () => {
    const pages = await hewnDocs();
    assert.equal(searchDocs(pages, "how do grants work?")[0].page, "docs/concepts.md");
    assert.ok(searchDocs(pages, "how do I connect claude.ai?").some((s) => s.page === "docs/agents.md" && s.slug === "claudeai-and-chatgpt"));
    assert.equal(searchDocs(pages, "what happens when a build fails")[0].slug, "when-a-build-fails");
  });
});

describe("docs: hewn_docs", () => {
  test("no input: the pages and their sections; a query: the best sections; a page, or one section of it", () => {
    const list = docsText(PAGES, {});
    assert.match(list, /^Hewn's docs: 2 pages/);
    assert.match(list, /docs\/garden\.md: Garden\n  Watering · Compost/);
    const found = docsText(PAGES, { query: "widget sizes" });
    assert.match(found, /best match "widget sizes"/);
    assert.match(found, /--- spec\/tools\.md#widgets-since-23 \(Writing a tool › Widgets \(since 2\.3\)\) ---\n## Widgets \(since 2\.3\)\n\nA widget is a card/);
    assert.match(docsText(PAGES, { query: "xyzzy" }), /^Nothing in Hewn's docs matches "xyzzy"\. Try other words, or read a page: docs\/garden\.md, spec\/tools\.md\.$/);
    assert.equal(docsText(PAGES, { page: "spec/tools.md" }), `spec/tools.md\n\n${PAGES[1].text.trim()}`);
    assert.match(docsText(PAGES, { page: "garden#watering" }), /^docs\/garden\.md#watering\n\n## Watering[^]*### Rain/);
    assert.match(docsText(PAGES, { page: "spec/tools.md#Widgets" }), /^spec\/tools\.md#widgets-since-23\n/);
    // Both: search that page only.
    assert.doesNotMatch(docsText(PAGES, { page: "spec/tools.md", query: "plants" }), /garden/);
    assert.throws(() => docsText(PAGES, { page: "nope.md" }), (e: any) => e.code === "not_found" && /The pages: docs\/garden\.md, spec\/tools\.md/.test(e.message));
    assert.throws(() => docsText(PAGES, { page: "garden#pruning" }), (e: any) => e.code === "not_found" && /Its sections: #watering, #rain, #compost/.test(e.message));
    assert.throws(() => docsText([], {}), (e: any) => e.code === "not_found");
  });

  describe("over MCP", () => {
    let t: ReturnType<typeof setup>;
    let server: Server;
    let url: string;
    const connect = async (token: string) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    };
    const text = (r: any) => r.content[0].text as string;
    before(async () => {
      t = setup();
      server = await serve(t.platform, t.home);
      url = serverUrl(server);
    });
    after(async () => {
      await new Promise((r) => server.close(r));
      t.cleanup();
    });

    test("every agent has it, whatever its scopes; the instructions point at it; it reads the real docs", async () => {
      const store = t.platform.agentStore;
      const maker = await connect(store.issue(store.approveDirect("maker", ["create"])).access_token);
      assert.deepEqual((await maker.listTools()).tools.map((x) => x.name).sort(), ["builds_cancel", "builds_get", "builds_retry", "builds_wait", "capabilities_create", "capabilities_request_access", "hewn_docs"]);
      assert.match(maker.getInstructions() ?? "", /read hewn_docs instead of guessing/);
      await maker.close();

      const agent = await connect(TOKENS.codex);
      const list = text(await agent.callTool({ name: "hewn_docs", arguments: {} }));
      assert.match(list, new RegExp(`^Hewn's docs: ${DOC_PAGES.length} pages`));
      assert.match(list, /docs\/concepts\.md: Concepts\n  Tools · Agents · Hewn's two jobs/);
      const found = text(await agent.callTool({ name: "hewn_docs", arguments: { query: "how do grants work?" } }));
      assert.match(found, /--- docs\/concepts\.md#grants \(Concepts › Grants\) ---\n## Grants\n/);
      const page = text(await agent.callTool({ name: "hewn_docs", arguments: { page: "spec/agents.md#scopes-and-mcp-tools" } }));
      assert.match(page, /^spec\/agents\.md#scopes-and-mcp-tools\n\n## Scopes and MCP tools\n[^]*\| `hewn_docs` \| yes \| yes \| yes \| yes \|/);
      const missing = await agent.callTool({ name: "hewn_docs", arguments: { page: "nope" } });
      assert.equal(missing.isError, true);
      assert.match(text(missing), /"error": "not_found"/);
      await agent.close();
    });
  });
});

describe("docs: the intake answers questions about Hewn", () => {
  test("a question reads like one: a ?, or a question word first", () => {
    for (const q of ["how do grants work", "Can a tool read my calendar", "what is a connection?", "a habit tracker? with streaks", "Is there a dark mode"]) assert.ok(looksLikeQuestion(q), q);
    for (const r of ["a habit tracker with streaks", "track my coffee", "Show pace per km", "Isolation please"]) assert.ok(!looksLikeQuestion(r), r);
  });

  test("the prompt carries excerpts of the docs for a question only, in both modes, and offers kind answer", async () => {
    const docs = await hewnDocs();
    const ask = (mode: "create" | "modify", content: string) => intakePrompt({ mode, ...(mode === "modify" ? { capabilityId: "x" } : {}), messages: [{ role: "user", content: "a coffee log" }, { role: "intake", content: "Daily?" }, { role: "user", content }] }, { docs });
    for (const mode of ["create", "modify"] as const) {
      const q = ask(mode, "how do grants work?");
      assert.match(q, /Excerpts from Hewn's docs that match the owner's latest message[^]*--- docs\/concepts\.md#grants \(Concepts › Grants\) ---/);
      assert.match(q, /reply kind "answer"[^]*Answer from the excerpts of Hewn's docs above[^]*Never invent features/);
      const excerpts = /Excerpts from Hewn's docs[^\n]*\n([^]*?)\n\nConversation so far:/.exec(q)![1];
      assert.ok(excerpts.length <= 9000, `${excerpts.length} characters`);
      const plain = ask(mode, "ok, and a weekly chart");
      assert.doesNotMatch(plain, /Excerpts from Hewn's docs/);
      assert.match(plain, /reply kind "answer"/, "it can still answer a question the heuristic missed");
      assert.equal(plain, intakePrompt({ mode, ...(mode === "modify" ? { capabilityId: "x" } : {}), messages: [{ role: "user", content: "a coffee log" }, { role: "intake", content: "Daily?" }, { role: "user", content: "ok, and a weekly chart" }] }), "no docs, no question: the same prompt");
    }
    assert.match(ask("modify", "can it read my calendar?"), /a change to this one would do what they asked about/);
  });

  test("it sticks to Hewn: trivia gets a line, not an answer; a Claude skill gets the nearest tool", () => {
    for (const mode of ["create", "modify"] as const) {
      const p = intakePrompt({ mode, ...(mode === "modify" ? { capabilityId: "x" } : {}), messages: [{ role: "user", content: "How many r's are there in strawberry" }] });
      assert.match(p, /about neither Hewn nor a tool \(general knowledge, trivia[^)]*\), don't answer it: reply kind "answer", one line/);
      assert.match(p, /something Hewn doesn't build \(a Claude skill[^)]*\), reply kind "answer": Hewn builds tools that live in Hewn[^\n]*Offer the nearest tool/);
    }
  });

  test("the reply: kind answer in both modes, its message the answer; an empty answer is no reply", () => {
    assert.ok((SCHEMA.properties.kind.enum as string[]).includes("answer"));
    for (const mode of ["create", "modify"] as const) {
      const r = parseIntake(JSON.stringify({ kind: "answer", message: "Through a connection.", questions: [], name: "", request: "", remember: [], forget: [] }), mode);
      assert.deepEqual(r, { kind: "answer", message: "Through a connection." });
    }
    assert.deepEqual(parseIntake(JSON.stringify({ kind: "answer", message: "Yes.", remember: [{ scope: "global", text: "Swedish copy" }] }), "create"), { kind: "answer", message: "Yes.", remember: [{ scope: "global", text: "Swedish copy" }] });
    assert.throws(() => parseIntake(JSON.stringify({ kind: "answer", message: " " }), "create"), /answer is empty/);
  });
});
