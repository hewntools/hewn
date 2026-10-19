// SPDX-License-Identifier: AGPL-3.0-or-later
type Generate = (req: unknown) => Promise<{ text: string; json?: any; cost: number; model: string }>;
type Ctx = { model?: { generate: Generate } };

export const operations = {
  async "explain@1"(input: { word: string }, ctx: Ctx) {
    const r = await ctx.model!.generate({
      system: "Explain English words in one short sentence.",
      prompt: `Explain "${input.word}".`,
      schema: { type: "object", required: ["explanation"], properties: { explanation: { type: "string" } } },
      maxTokens: 200,
    });
    return { explanation: r.json.explanation, cost: r.cost, model: r.model };
  },
  async "describe@1"(input: { data: string; mediaType: string }, ctx: Ctx) {
    const r = await ctx.model!.generate({ prompt: [{ type: "image", data: input.data, mediaType: input.mediaType }, { type: "text", text: "What is this?" }] });
    return { text: r.text };
  },
  "probe@1"(_input: unknown, ctx: Ctx) {
    return { hasModel: typeof ctx.model?.generate === "function" };
  },
};
