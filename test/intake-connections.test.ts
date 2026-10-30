// SPDX-License-Identifier: AGPL-3.0-or-later
// What the intake is told about connections: they sign in with a pasted key or token, or a plain sign-in,
// never OAuth, so it doesn't suggest or draft one to a service that only lets apps in through OAuth.
import assert from "node:assert/strict";
import { test } from "node:test";
import { intakePrompt } from "@hewntools/cli/intake.ts";
import { AGENT_TOOLS } from "@hewntools/spec/agents.ts";

const rule = /How a connection signs in, today: with an API key or personal access token the owner creates in the service and pastes into Hewn, or with a sign-in step[^\n]*Never OAuth[^\n]*Google Calendar[^\n]*Spotify[^\n]*Only suggest, list or draft connections to services that offer a key, a token or a plain sign-in\. When the owner asks for an OAuth-only one, say plainly in "message" that Hewn can't connect to it yet, and offer what works/;

test("intake: connections are a key, a token or a plain sign-in, never OAuth, when creating and changing", () => {
  const ask = (content: string) => [{ role: "user" as const, content }];
  assert.match(intakePrompt({ mode: "create", messages: ask("Which services can I connect? Give me some examples.") }), rule);
  assert.match(intakePrompt({ mode: "modify", capabilityId: "x", messages: ask("Add my Google Calendar") }), rule);
  // No OAuth-only service as an example of what a connection wraps.
  const examples = /A service that needs a key, token or login \(([^)]*)\)/.exec(intakePrompt({ mode: "create", messages: ask("x") }))?.[1] ?? "";
  assert.ok(examples, "the connection examples are there");
  assert.doesNotMatch(examples, /Google|Gmail|Spotify|Strava|Outlook/);
});

test("agents creating a tool are told the same", () => {
  const create = AGENT_TOOLS.find((t) => t.name === "capabilities_create")!;
  assert.match(create.description, /signs in with a key or token the user pastes, or with a username-and-password sign-in step; services that only allow OAuth \(Google Calendar, Gmail, Spotify…\) can't be connected yet/);
});
