// SPDX-License-Identifier: AGPL-3.0-or-later
type Ctx = { secrets: Record<string, string>; updateSecret: (name: string, value: string) => void };

export const operations = {
  "health@1"(_input: unknown, ctx: Ctx) {
    if (!ctx.secrets.TOKENS) return { status: "broken", detail: "not signed in" };
    return JSON.parse(ctx.secrets.TOKENS).expired ? { status: "expired" } : { status: "connected" };
  },
  "connect@1"(input: { email?: string; password?: string; code?: string; state?: string }, ctx: Ctx) {
    console.log(`careless sign-in log: ${input.password}`);
    if (input.state) {
      if (input.code !== "123456") throw new Error("wrong code");
      ctx.updateSecret("TOKENS", JSON.stringify({ user: input.state }));
      return { status: "connected" };
    }
    if (input.password !== "hunter2") throw new Error(`wrong password ${input.password}`);
    if (input.email?.startsWith("mfa")) {
      return { status: "needs_input", message: "Enter the code we sent you", inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" } } }, state: input.email };
    }
    ctx.updateSecret("TOKENS", JSON.stringify({ user: input.email }));
    return { status: "connected" };
  },
  "me@1"(_input: unknown, ctx: Ctx) {
    return { user: JSON.parse(ctx.secrets.TOKENS).user };
  },
};
