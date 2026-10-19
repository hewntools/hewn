// SPDX-License-Identifier: Apache-2.0
// `ctx.model.generate` (ABI 2.2): what tool code sends, and what it gets back.

export type ContentPart = { type: "text"; text: string } | { type: "image"; data: string; mediaType: string };
export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

export interface GenerateRequest {
  system?: string;
  /** One user turn: text, or content parts (text and base64 images). */
  prompt?: string | ContentPart[];
  /** A conversation instead of `prompt` (user first, alternating). */
  messages?: ModelMessage[];
  /** JSON Schema for structured output; the reply is checked against it and returned as `json`. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface GenerateResult {
  text: string;
  json?: unknown;
  usage: { inputTokens: number; outputTokens: number };
  /** What the call cost, in USD. */
  cost: number;
  /** The model that ran ("<provider>/<model-id>"). */
  model: string;
}
