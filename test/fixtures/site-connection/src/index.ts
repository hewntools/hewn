// SPDX-License-Identifier: AGPL-3.0-or-later
type Ctx = { secrets: Record<string, string>; config: Record<string, string> };

export const operations = {
  "health@1"(_input: unknown, ctx: Ctx) {
    if (!ctx.secrets.API_KEY) return { status: "broken", detail: "no key" };
    return ctx.secrets.API_KEY === "expired" ? { status: "expired" } : { status: "connected", detail: ctx.config.SITE_URL };
  },
  async "site@1"(input: { fetch?: string }, ctx: Ctx) {
    if (!input.fetch) return { config: ctx.config };
    const r = await fetch(input.fetch).catch(() => undefined);
    return { config: ctx.config, status: r?.status ?? 0 };
  },
};
