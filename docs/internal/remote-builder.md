# The host's builder: protocol

A host can run Hewn's builder and intake itself, on its own model keys, instead of Claude Code or Codex on the owner's machine. Then each user's Hewn can hold no model key, only a token for the build service, and builds can run on separate short-lived machines with no state or secrets.

Hewn's side is `packages/cli/src/builders/remote.ts`. Validation, tests, the visual check and promotion stay in Hewn, exactly as for a local builder: the service only turns a workspace into a candidate, and a request into a reply.

## Turning it on

| Variable | |
| --- | --- |
| `HEWN_BUILD_URL` | The service's base URL: `https://…` (plain `http` only to localhost, since the token goes with every request). Set: the `remote` builder and intake exist, and are the default. |
| `HEWN_BUILD_TOKEN` | This Hewn's token, sent as `Authorization: Bearer <token>`. |
| `HEWN_BUILD_NAME` | What the owner sees it called (default "Remote builder"). |

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
  "session": "b-…",
  "capabilityId": "reading-list",
  "kind": "create",
  "attempt": 1,
  "retryOf": "b-…",
  "pause": true,
  "feedback": "The previous candidate FAILED platform validation: …",
  "model": "fable",
  "effort": "high",
  "check": true,
  "prompt": "You are a builder for Hewn, … Read BUILDER.md …",
  "files": { "BUILDER.md": "<base64>", "ui.css": "<base64>", "src/index.ts": "<base64>" }
}
```

- `kind`: `create`, `modify` or `widgets`. `feedback` is set from the second attempt on.
- `retryOf` is set when this build retries a failed or cancelled one (Retry, Ask builder to fix, Continue, Start again, or Hewn's own retry after a restart): the first build of that chain, the same on every retry of it. A host can count the chain as one build. Unset: not a retry.
- `pause` (since 0.4.10): this Hewn takes a `{ "paused": … }` outcome (below). Without it, send `refused` instead.
- `session` is the same for every attempt of one build (the build id), so the service may resume its own model session on a later attempt instead of starting over; `prompt` and `files` are still whole each time, so a stateless service works.
- `model` and `effort` are set only when the owner or the requesting agent chose them; otherwise the service's default. Names come from `GET /v1/models`. A model the service can't run is refused before anything starts (`{ "refused": "<model> isn't available. Pick another model." }`); never build on another model instead.
- `prompt` is what a local builder would be told; `files` is the workspace (`BUILDER.md` holds the request and the contract, and quotes the owner's conversation with the intake after the request when there is one, up to 40,000 characters). What the owner attached is in it under `attachments/` (images and text files, listed in `BUILDER.md`'s request), for the builder to read; Hewn never makes them part of a version.

Events:

| Event | |
| --- | --- |
| `{ "activity": "→ Edit src/index.ts" }` | One line of what the builder is doing (the build page and `builds_wait` show it). |
| `{ "model": "claude-fable-5-5" }` | The model it runs on, once known. |
| `{ "charge": { "amount": 12, "unit": "points" } }` | What this attempt costs the owner, in the host's own unit. Hewn adds up a build's attempts and shows it as given ("12 points") on the build page and in Activity; it never converts or prices anything. Leave it out when nothing is charged. |
| `{ "heartbeat": true }` (or any other key) | Ignored: keeps the connection open. |
| `{ "file": { "path": "ui/icon.svg", "content": "<base64>" } }` | Optional: one file as the builder writes it, before the build ends. Hewn writes it into the workspace at once, so the icon (`ui/icon.svg`, and `hue` in `capability.json`) shows on Home and the build page while it builds. Same path rules as `files`; a path Hewn won't write is ignored. The `files` event still decides the candidate. |
| `{ "check": { "id": "c1", "files": { "<path>": "<base64>", … } } }` | Only when the request has `check: true`: the builder checks its work (its `check` tool, below). `files` is the workspace as it is now, the whole tree, with the same rules as `files`; Hewn writes it, checks it, and posts the result to `POST /v1/builds/:buildId/checks/:id`. `id`: letters, digits, `-` and `_`, up to 64. Keep the stream open while you wait. |
| `{ "files": { "<path>": "<base64>", … } }` | The workspace as the builder left it: the whole tree. Paths it doesn't list are deleted. Paths must be relative, inside the workspace, and not artefacts (`node_modules` …); one that isn't fails the attempt before anything is written. |
| `{ "done": true }` | Finished: the last event. Without a `files` event first, or a stream that ends without it, the attempt fails. |
| `{ "paused": "<what happened and what's kept>" }` | Since 0.4.10, only when the request had `pause`: the build stopped part-way (e.g. at a build's allowance) with its work kept, and the owner decides. The last event (no `files`, no `done`). Hewn makes no further attempts and shows it as paused, with the text (an empty one gets Hewn's own words), **Continue** and **Stop**. See [A paused build](#a-paused-build). |
| `{ "refused": … }`, `{ "error": … }` | As above. |

### A paused build

- **Continue** is the owner's alone (an agent's `builds_retry` of a paused build is refused). It is a retry: a new build, with a new `buildId` and `session`, whose `retryOf` is the first build of the chain, for the service to pick the kept work up. Its `files` is the tool as it is now (its live version and `BUILDER.md`), not the paused build's workspace: the kept work is the service's to bring back. The service may pause it again.
- **Stop** only ends it in Hewn (cancelled); nothing is sent to the service. A service that keeps paused work learns of a Stop only in that no Continue comes, so it keeps the work as long as its own policy says.
- Hewn doesn't tell a Continue apart from other retries of the same chain: a **Retry** of a later failure, or a **Start again** after Stop, carries the same `retryOf`. A service that keeps work per chain may pick it up then too.

### The builder's check: `POST /v1/builds/:buildId/checks/:id`

With `check: true` in the request, Hewn offers the builder a `check` tool: what validation runs before
promotion (the manifest, bundling, contracts, migrations, `tests/cases.json`, `sample/calls.json`,
the widgets), going on after a failure, with the UI rendered filled with the sample data, 1280 and
390 px wide, light and dark, and what to fix measured on it. Nothing is promoted. A service that
ignores the offer builds as before.

Give your builder a tool named `check` (an MCP server on your side, say) that sends the `check`
event with the workspace and waits for Hewn's answer, which Hewn posts (the build's token, as for every call):

```json
{
  "passed": false,
  "text": "FAIL: 1 problem. Fix it, then check again.\n\nWhat failed:\n- 1 of 3 test cases failed: …",
  "failures": ["1 of 3 test cases failed: …"],
  "defects": ["Sticks out on the phone (390 px): div.row (\"…\"): 40px past the edge, 430px wide"],
  "images": [{ "name": "desktop-light", "png": "<base64>" }, { "name": "desktop-dark", "png": "<base64>" }, { "name": "mobile-light", "png": "<base64>" }, { "name": "mobile-dark", "png": "<base64>" }]
}
```

or `{ "error": "…" }` when the check couldn't run. Hand `text` and the images to the model as the
tool's result: a check that ran is not a tool error, passed or not (some clients drop the images
from an error). Hewn's builders on this machine also get the images in `screenshots/`. Answer with any
2xx. Hewn runs one check at a time per build, ten per attempt; an eleventh answers "No checks left".
A check takes up to about a minute.

## The intake: `POST /v1/intake`

One request per turn of the conversation; `session` is the same for every turn of one conversation, so the service can keep one model session (and its cache) for it. Hewn still sends the whole prompt each turn, so a service may ignore `session`.

```json
{ "session": "6f1c…", "mode": "create", "prompt": "…", "schema": { … }, "model": "sonnet", "effort": "low", "attachments": [{ "kind": "image", "name": "screen.png", "mediaType": "image/png", "data": "<base64>" }] }
```

- `prompt` is Hewn's intake prompt with the conversation in it; `schema` is the JSON Schema the reply must follow. The service may give the model web search and fetching (the owner reviews every draft before anything is built), except when reading a tool (`summarize`, below).
- `mode` `summarize` (since 0.4.9): read a tool someone shared before the owner installs it. There is no conversation and no `session`; `prompt` carries the tool's files (up to about 200 KB), and the reply is `{ "kind": "summary", "message", "keeps", "reaches", "findings": [{ "kind": "warn" | "ok", "title", "detail", "file", "line" }] }` (the `schema` sent says so). Run it with no tools at all, no web search or fetching, and few turns: everything to read is in the prompt, and that text comes from whoever shared the tool, so it may try to steer the model. Hewn closes the request when the owner moves on (Install anyway, Cancel); stop then.
- The reply's `kind` may be `answer` (since 0.4.8): the owner asked about Hewn itself, and `message` is the answer, with nothing to build. When the owner's message reads like a question, the prompt carries excerpts of Hewn's docs to answer from. Hewn reads the reply as it reads any other; the service passes it through.
- `attachments` (only when there are any): the images the owner attached in the conversation so far (at most 10, each at most 2 MB; `image/png`, `image/jpeg`, `image/webp` or `image/gif`), for the model to look at next to the prompt, which names each under the message it came with (`[attached: screen.png (image 1200×800)]`). Attached text files are already in the prompt, each cut at 100,000 characters.

Events: `{ "text": "<delta>" }` as the reply is written (Hewn shows its message and questions as they arrive), `{ "activity": "Searching the web" }` (and `{ "activity": "Thinking" }` while the model thinks before it writes, so the owner sees more than the typing dots), then `{ "result": "<the reply: JSON text following the schema>" }`. Or `refused` / `error` (`unavailable` as above). A `{ "charge": { "amount": 4, "unit": "Credits" } }` event, as for builds, counts the turn in "used this month" (not shown in the chat).

## Tools' model calls: `POST /v1/generate` (hosted)

Only with `HEWN_HOSTED=1`: then a tool's `ctx.model.generate` goes to the host instead of a provider on the owner's key. Hewn checks the request first (shape, sizes, images) and the result's JSON against the schema after, as for its own providers. Plain JSON both ways, no streaming.

```json
{ "capabilityId": "word-explainer", "tier": "light", "system": "…", "messages": [{ "role": "user", "content": "Explain \"gruntled\"." }], "schema": { "type": "object", … }, "maxTokens": 1024 }
```

- `tier` (`light`, `standard`, `strong`, `max`) or `model` (a pinned name), from the tool's `requires.model`. `content` is a string or parts (`{ "type": "text", "text" }`, `{ "type": "image", "data": "<base64>", "mediaType" }`).
- 200: `{ "text": "…", "usage": { "inputTokens": 900, "outputTokens": 80 }, "model": "<the model it ran on>", "charge": { "amount": 0.37, "unit": "Credits" } }`. Amounts may be fractions; Hewn sums them as decimals.
- A refusal, any status with `{ "refused": "…" }` (over the month, a model it can't run, too many at once): the tool's call fails with that reason, not retried. `401`/`403` without `refused`: the token isn't accepted. Otherwise `{ "error": "…", "charge"? }`: an ordinary failed call, its charge still counted (the model answered).
- Hewn calls it from the supervisor, which holds the token; a tool never sees it. Calls are logged for Activity at $0; the USD caps don't apply. A tool's own monthly cap, in the host's unit (`capabilityCapsHost`), is checked before each call against what the host charged its calls this month.

## Models: `GET /v1/models`

```json
{ "models": [{ "id": "default", "label": "Default", "kind": "default", "efforts": ["low", "medium", "high"] }, { "id": "fable", "label": "Fable", "kind": "family", "description": "The newest Fable", "efforts": ["low", "medium", "high", "max"] }] }
```

`kind`: `default` (the service decides), `family` (follows the newest), or `pinned` (exactly that model; `upgrade` may name its successor). Settings › AI and the model menu in the intake's chat box list these; the owner ticks which ones agents may ask for.

Hosted, `"tiers": { "light": "Haiku 5.5", "standard": "Sonnet 5.5", "strong": "Opus 5.5", "max": "Fable 5.1" }` says what each tier runs on for tools' model calls (labels for Settings › AI › Models; the service resolves the tier itself on `/v1/generate`).
