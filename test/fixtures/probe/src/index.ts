// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolation probes: everything except "declared" should fail closed.
/** "denied" when Hewn's egress gate refused, else the remote's status (which can be a 403 of its own, e.g. a rate limit). */
const gate = async (r: Response) => (r.status === 403 && (await r.text()).startsWith("egress denied") ? "denied" : r.status);
const attempt = async (fn: () => unknown) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
};

export const operations = {
  async "probe@1"(input: { what: string; port?: number }, ctx: any) {
    switch (input.what) {
      case "globals":
        return { found: ["process", "Deno", "Bun", "require"].filter((k) => typeof (globalThis as any)[k] === "function" || (k === "process" && (globalThis as any).process?.env?.HOME)) };
      case "undeclared":
        return attempt(async () => gate(await fetch("https://example.com/")));
      case "declared":
        return attempt(async () => gate(await fetch("https://api.github.com/zen", { headers: { "user-agent": "hewn-test" } })));
      case "admin":
        return attempt(async () => (await fetch(`http://127.0.0.1:${input.port}/_admin/status`)).status);
      case "file":
        return attempt(async () => (await import("node:fs")).readFileSync("/etc/passwd", "utf8").slice(0, 10));
      case "attach":
        return attempt(() => ctx.db.exec("ATTACH DATABASE '/tmp/x.db' AS x"));
      case "tables":
        return { tables: ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name) };
    }
    return { unknown: input.what };
  },
  async "spin@1"() {
    for (;;) {}
  },
};
