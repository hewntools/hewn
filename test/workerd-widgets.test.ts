// SPDX-License-Identifier: AGPL-3.0-or-later
// Widgets on the real workerd host: read-only state crosses Durable Object RPC into the facet.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FIXTURES } from "./helpers.ts";
import { parse, startTestHost, type TestHost } from "./workerd-helpers.ts";

describe("widgets on the workerd host", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost();
    const r = await h.sv.admin("install", { name: "Widget Counter", purpose: "count", dir: join(FIXTURES, "widget-counter"), wait: true });
    assert.equal(r.status, "promoted", JSON.stringify(r.log));
  });
  after(() => h.stop());

  test("widgets_show draws from the isolate; a widget that writes is refused there, and nothing is written", async () => {
    await h.invoke("widget-counter", "increment");
    const agent = await h.agent("claude-code", ["discover", "invoke"]);
    const r: any = await agent.callTool({ name: "widgets_show", arguments: { capabilityId: "widget-counter", widget: "count" } });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal(r.structuredContent.view.value, 1);
    const sneaky = await agent.callTool({ name: "widgets_show", arguments: { capabilityId: "widget-counter", widget: "count", input: { sneak: true } } });
    assert.equal(sneaky.isError, true);
    assert.match(parse(sneaky).message, /widgets are read-only/);
    assert.equal((await h.invoke("widget-counter", "widget_count")).result.value, 1, "the UPDATE never ran");
    // The same operation outside a widget is an ordinary read: the guard is the widget's, not the op's.
    assert.equal((await h.invoke("widget-counter", "widget_count", { sneak: true })).result.value, 100);
    const html = (await agent.readResource({ uri: "ui://hewn/widget" })).contents[0] as { text: string };
    assert.match(html.text, /function renderWidget/);
  });
});
