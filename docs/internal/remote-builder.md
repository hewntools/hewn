# The host's builder: protocol

A host can run Hewn's builder and intake itself, on its own model keys, instead of Claude Code or Codex on the owner's machine. Hewn Cloud does: each user's Hewn (a cell) holds no model key, only a token for the build service, and builds run on separate short-lived machines with no state or secrets.

Hewn's side is `packages/cli/src/builders/remote.ts`. Validation, tests, the visual check and promotion stay in Hewn, exactly as for a local builder: the service only turns a workspace into a candidate, and a request into a reply.

## Turning it on

| Variable | |
| --- | --- |
| `HEWN_BUILD_URL` | The service's base URL: `https://…` (plain `http` only to localhost, since the token goes with every request). Set: the `remote` builder and intake exist, and are the default. |
| `HEWN_BUILD_TOKEN` | This Hewn's token, sent as `Authorization: Bearer <token>`. |
| `HEWN_BUILD_NAME` | What the owner sees it called (default "Remote builder"), e.g. "Hewn Cloud". |

`hewn doctor` reports it as "the host's builder (HEWN_BUILD_URL)".

## Common rules

- Requests are `POST` with a JSON body; responses stream **NDJSON** (`application/x-ndjson`): one JSON object per line, as things happen.
- A refusal (over quota, too many running) is final: either an event `{ "refused": "<reason for the owner>" }`, or the status `402`, `403` or `429` with a JSON body `{ "refused": "…" }`. Hewn shows the reason as is ("Not built: You've used this month's 40 builds.") and doesn't retry.
- `401` or `403` without `refused`: the token isn't accepted. The build stops ("isn't available") without using its other attempts.
- `{ "error": "…" }` (optionally `"unavailable": true`): this attempt failed. Without `unavailable`, Hewn tries again with the next attempt, as for a crashed local builder.
- When Hewn stops a build or the owner stops the intake, it closes the request. The service should stop the work then.

## Builds: `POST /v1/builds`

Request:

```json
{
  "buildId": "b-…",
  "capabilityId": "reading-list",
  "kind": "create",
  "attempt": 1,
  "feedback": "The previous candidate FAILED platform validation: …",
  "model": "fable",
  "effort": "high",
  "prompt": "You are a builder for Hewn, … Read BUILDER.md …",
  "files": { "BUILDER.md": "<base64>", "ui.css": "<base64>", "src/index.ts": "<base64>" }
}
```

- `kind`: `create`, `modify` or `widgets`. `feedback` is set from the second attempt on.
- `model` and `effort` are set only when the owner or the requesting agent chose them; otherwise the service's default. Names come from `GET /v1/models`.
- `prompt` is what a local builder would be told; `files` is the workspace (`BUILDER.md` holds the request and the contract).

Events:

| Event | |
| --- | --- |
| `{ "activity": "→ Edit src/index.ts" }` | One line of what the builder is doing (the build page and `builds_wait` show it). |
| `{ "model": "claude-fable-5-5" }` | The model it runs on, once known. |
| `{ "charge": { "amount": 12, "unit": "Credits" } }` | What this attempt costs the owner, in the host's own unit. Hewn adds up a build's attempts and shows it as given ("12 Credits") on the build page and in Activity; it never converts or prices anything. Leave it out when nothing is charged. |
| `{ "heartbeat": true }` (or any other key) | Ignored: keeps the connection open. |
| `{ "note": { "kind": "fallback", "model": "…", "text": "…" } }` | The model asked for wasn't available, so it ran on the default. The Inbox tells the owner. |
| `{ "files": { "<path>": "<base64>", … } }` | The workspace as the builder left it: the whole tree. Paths it doesn't list are deleted. Paths must be relative, inside the workspace, and not artefacts (`node_modules` …); one that isn't fails the attempt before anything is written. |
| `{ "done": true }` | Finished. Without a `files` event first, the attempt fails. |
| `{ "refused": … }`, `{ "error": … }` | As above. |

## The intake: `POST /v1/intake`

One request per turn of the conversation; `session` is the same for every turn of one conversation, so the service can keep one model session (and its cache) for it. Hewn still sends the whole prompt each turn, so a service may ignore `session`.

```json
{ "session": "6f1c…", "mode": "create", "prompt": "…", "schema": { … }, "model": "sonnet", "effort": "low" }
```

- `prompt` is Hewn's intake prompt with the conversation in it; `schema` is the JSON Schema the reply must follow. The service may give the model web search and fetching (the owner reviews every draft before anything is built).

Events: `{ "text": "<delta>" }` as the reply is written (Hewn shows its message and questions as they arrive), `{ "activity": "Searching the web" }`, then `{ "result": "<the reply: JSON text following the schema>" }`. Or `refused` / `error`.

## Models: `GET /v1/models`

```json
{ "models": [{ "id": "default", "label": "Default", "kind": "default", "efforts": ["low", "medium", "high"] }, { "id": "fable", "label": "Fable", "kind": "family", "description": "The newest Fable", "efforts": ["low", "medium", "high", "max"] }] }
```

`kind`: `default` (the service decides), `family` (follows the newest), or `pinned` (exactly that model; `upgrade` may name its successor). Settings › AI and the intake's model menu list these; the owner ticks which ones agents may ask for.
