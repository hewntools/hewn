// SPDX-License-Identifier: Apache-2.0
// JSON Schemas for a tool's capability.json and tests/cases.json. These objects are the source;
// ../schemas/*.json are generated from them (npm run spec:schemas) and published with the spec.
// Rules a schema can't express (a feature used below its declared ABI, duplicate operations,
// requires.model's tier-or-model) are described in capability-model.md and checked by the host.
import { MODEL_TIERS, RUNTIME_PROFILES, WIDGET_SIZES, type JSONSchema } from "./manifest.ts";

export const MANIFEST_SCHEMA: JSONSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hewn.tools/spec/2/capability.schema.json",
  title: "Hewn capability manifest (capability.json), ABI 2",
  type: "object",
  required: ["id", "name", "purpose", "operations"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
    name: { type: "string", minLength: 1 },
    purpose: { type: "string", minLength: 1 },
    description: { type: "string" },
    abi: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
    kind: { enum: ["capability", "connection"] },
    config: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "description"],
        additionalProperties: false,
        properties: { name: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" }, description: { type: "string", minLength: 1 } },
      },
    },
    runtime: { enum: [...RUNTIME_PROFILES] },
    hue: { type: "integer", minimum: 0, maximum: 359 },
    saturation: { type: "integer", minimum: 0, maximum: 150 },
    source: {
      type: "object",
      required: ["id", "version", "hash", "from"],
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
        name: { type: "string", minLength: 1 },
        version: { type: "integer", minimum: 1 },
        hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        from: { enum: ["file", "link", "hub"] },
        host: { type: "string", pattern: "^[a-z0-9.-]+(:[0-9]+)?$" },
      },
    },
    requires: {
      type: "object",
      additionalProperties: false,
      properties: {
        secrets: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "description"],
            properties: { name: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" }, description: { type: "string" } },
          },
        },
        hosts: { type: "array", items: { type: "string", pattern: "^((\\*\\.)?[a-z0-9.-]+|config:[A-Z][A-Z0-9_]*)$" } },
        model: {
          type: "object",
          additionalProperties: false,
          properties: {
            tier: { enum: [...MODEL_TIERS] },
            model: { type: "string", pattern: "^(anthropic|openai|openrouter)/[A-Za-z0-9._:-]+(/[A-Za-z0-9._:-]+)?$" },
            input: { type: "array", uniqueItems: true, items: { enum: ["text", "image"] } },
          },
        },
        capabilities: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "operations"],
            additionalProperties: false,
            properties: {
              id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
              operations: { type: "array", minItems: 1, items: { type: "string", pattern: "^[a-z][a-z0-9_]*@[0-9]+$" } },
              hub: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$" },
              minVersion: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    tags: { type: "array", items: { type: "string" } },
    ui: { type: "object", properties: { available: { type: "boolean" } } },
    widgets: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["name", "version", "title", "operation", "sizes"],
        additionalProperties: false,
        properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
          version: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1, maxLength: 40 },
          description: { type: "string", maxLength: 200 },
          operation: { type: "string", pattern: "^[a-z][a-z0-9_]*@[0-9]+$" },
          sizes: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...WIDGET_SIZES] } },
          refresh: { type: "object", additionalProperties: false, properties: { every: { type: "string", pattern: "^[0-9]+(m|h)$" } } },
          open: { type: "string", pattern: "^ui(#[A-Za-z0-9_-]+)?$" },
        },
      },
    },
    operations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "description", "version", "inputSchema", "outputSchema", "sideEffect"],
        properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
          description: { type: "string", minLength: 1 },
          version: { type: "integer", minimum: 1 },
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          sideEffect: { enum: ["read", "write", "destructive"] },
          deprecated: {
            type: "object",
            additionalProperties: false,
            properties: { replacement: { type: "string", pattern: "^([a-z0-9][a-z0-9-]*/)?[a-z][a-z0-9_]*@[0-9]+$" }, note: { type: "string", maxLength: 500 } },
          },
        },
      },
    },
  },
};

export const CASES_SCHEMA: JSONSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hewn.tools/spec/2/cases.schema.json",
  title: "Hewn tool test cases (tests/cases.json), ABI 2",
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["name", "operation"],
    properties: {
      name: { type: "string", minLength: 1 },
      operation: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
      version: { type: "integer", minimum: 1 },
      input: {},
      secrets: { type: "object", additionalProperties: { type: "string" } },
      config: { type: "object", additionalProperties: { type: "string" } },
      calls: { type: "object", propertyNames: { pattern: "^[a-z0-9][a-z0-9-]*/[a-z][a-z0-9_]*@[0-9]+$" } },
      model: {
        type: "array",
        items: { anyOf: [{ type: "object", required: ["error"], properties: { error: { type: "string" } } }, { type: "object", properties: { text: { type: "string" }, json: {} } }] },
      },
      expect: {},
      expectError: { type: "boolean" },
    },
  },
};

export const SAMPLE_SCHEMA: JSONSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hewn.tools/spec/2/sample.schema.json",
  title: "Hewn tool sample data (sample/calls.json), ABI 2.5",
  type: "array",
  minItems: 1,
  maxItems: 200,
  items: {
    type: "object",
    required: ["operation"],
    additionalProperties: false,
    properties: {
      operation: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
      version: { type: "integer", minimum: 1 },
      input: {},
    },
  },
};

/** The published files: name → schema. */
export const SCHEMA_FILES: Record<string, JSONSchema> = { "capability.schema.json": MANIFEST_SCHEMA, "cases.schema.json": CASES_SCHEMA, "sample.schema.json": SAMPLE_SCHEMA };
