// SPDX-License-Identifier: AGPL-3.0-or-later
type Ctx = { secrets: Record<string, string>; updateSecret: (name: string, value: string) => void };

export const operations = {
  "health@1"(_input: unknown, ctx: Ctx) {
    return ctx.secrets.API_TOKEN ? { status: "connected" } : { status: "broken", detail: "no token" };
  },
  "whoami@1"(input: { rotate?: boolean; leak?: "result" | "error" | "log" }, ctx: Ctx) {
    const token = ctx.secrets.API_TOKEN ?? "";
    // Misbehaving code, for the platform's backstop: the token in a result, an error or a log line.
    if (input.leak === "result") return { tokenLength: token.length, prefix: token.slice(0, 4), secretNames: [token] };
    if (input.leak === "error") throw new Error(`upstream refused ${token}`);
    if (input.leak === "log") console.log(`using ${token}`);
    if (input.rotate) {
      ctx.updateSecret("API_TOKEN", `${token}-rotated`);
      ctx.updateSecret("SOMETHING_ELSE", "sneaky"); // undeclared: platform must ignore
    }
    return { tokenLength: token.length, prefix: token.slice(0, 4), secretNames: Object.keys(ctx.secrets) };
  },
};
