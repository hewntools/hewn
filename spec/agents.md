# Connecting an agent

An agent is any MCP client acting for the owner: Claude, ChatGPT, Codex, an IDE, a script. It connects to one MCP server on the owner's host, signs in with OAuth, and gets a fixed set of tools for finding, using and building the owner's tools. This page is for people writing such a client, and for anyone implementing another host.

In the API, the owner's tools are called **[capabilities](capability-model.md#capability)** (`capabilities_list`, `capabilityId`); this page says "tool" for them and "MCP tool" for the MCP server's own tools.

The contract is [`src/agents.ts`](src/agents.ts): the scopes, the server instructions, every MCP tool's name, scopes, description and input schema, and the widget resource. A host offers exactly those MCP tools, filtered by the agent's scopes. Everything below describes Hewn's implementation of it.

## The endpoint

- **URL:** `<host>/mcp`, for example `http://127.0.0.1:7717/mcp` locally, or a public `https://…/mcp` address through a tunnel.
- **Transport:** MCP Streamable HTTP, with sessions. The first request is a `POST` of `initialize` without an `Mcp-Session-Id` header; the response carries the session id, which every later request sends. A session idles out after two hours, and sessions don't survive a host restart: an unknown session id gets `404`, and the client initializes again.
- **Authentication:** every request carries `Authorization: Bearer <access token>`. Without a valid token the answer is `401` with `WWW-Authenticate: Bearer resource_metadata="<host>/.well-known/oauth-protected-resource/mcp", scope="discover invoke create modify"`. Clients that only support static tokens can't connect: tokens come only from the OAuth flow below.

The server announces `tools` (with `listChanged`) and, when it can draw widgets, `resources`.

## Signing in

The host is its own OAuth 2.1 authorization server, following the MCP authorization spec. Every endpoint is on the same origin as `/mcp`, and the issuer is whichever origin the client used.

1. **Discovery.** `GET /.well-known/oauth-protected-resource/mcp` (also without `/mcp`) returns `{ resource: "<host>/mcp", authorization_servers: ["<host>"], scopes_supported, bearer_methods_supported: ["header"] }`. `GET /.well-known/oauth-authorization-server` (also at `/.well-known/openid-configuration`) returns the server metadata: `/authorize`, `/token`, `/register`, `/revoke`, response type `code`, grants `authorization_code` and `refresh_token`, PKCE `S256`.
2. **Dynamic client registration** (RFC 7591). `POST /register` with JSON: `redirect_uris` (1 to 10; each `https`, or `http` on `127.0.0.1`, `localhost` or `[::1]`; no fragment), `client_name`, optionally `grant_types` (must include `authorization_code`) and `token_endpoint_auth_method` (`none`, `client_secret_basic` (the default) or `client_secret_post`). The response (`201`) has a `client_id`, and a `client_secret` unless the method is `none`. Loopback redirect URIs match on everything but the port, so a local client may pick a free port each time.
3. **Authorization.** Send the owner's browser to `/authorize` with `response_type=code`, `client_id`, `redirect_uri` (optional if exactly one is registered), `code_challenge` and `code_challenge_method=S256` (PKCE is required), `state`, and optionally `scope` and `resource`. The page doesn't sign anyone in: it shows the client's name, where it will return to, and a short code (like `BCD-F23`), and waits.
4. **The owner's approval.** The request shows up in the owner's host (the web client's Agents page, or `hewn agents pending` and `hewn agents approve <code>`). The owner checks that the code matches the one in the browser, and approves or declines. When approving, the owner may **narrow** the scopes the client asked for (never widen them), name the agent, and limit it to some of their tools. The request expires after 15 minutes.
5. **Back to the client.** Once the owner decides, the page redirects to `redirect_uri` with `code`, `state` and `iss`, or with `error=access_denied`. The code is valid for 5 minutes and once only; presenting it twice revokes what the first use issued.
6. **Tokens.** `POST /token` (form or JSON) with `grant_type=authorization_code`, `code`, `code_verifier`, the `redirect_uri` if one was sent, and client authentication for confidential clients. The response is `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope }`, where `scope` is what the owner approved.
7. **Refresh.** Access tokens last an hour, refresh tokens 30 days. `grant_type=refresh_token` returns a new pair and spends the old refresh token (rotation). When a refresh fails with `invalid_grant`, the client runs the authorization flow again.
8. **Revocation.** `POST /revoke` with either token ends that client's access (both tokens).

Unknown scopes in the request (`openid`, for example) are ignored; a request with no known scope asks for all four.

The owner stays in control after approval. They can turn scopes off and on again (up to what they approved), change which tools the agent sees, or disconnect it. Changes apply to open sessions at once: the next request sees the new scopes, and a disconnected agent's tokens and sessions end. To get more than it was approved for, an agent has to connect again and be approved again.

## Scopes and MCP tools

There are four scopes. The web client shows them as See, Use, Make and Change. An MCP tool is offered if the agent holds any of the scopes listed for it (from `AGENT_TOOLS`):

| MCP tool | `discover` | `invoke` | `create` | `modify` |
| --- | :-: | :-: | :-: | :-: |
| `capabilities_list` | yes | | | |
| `capabilities_get` | yes | | | |
| `schedules_list` | yes | | | |
| `capabilities_invoke` | | yes | | |
| `widgets_show` | | yes | | |
| `schedules_propose` | | yes | | |
| `capabilities_request_access` | | yes | yes | yes |
| `capabilities_create` | | | yes | |
| `capabilities_modify` | | | | yes |
| `capabilities_add_widgets` | | | | yes |
| `builds_get` | | | yes | yes |
| `builds_wait` | | | yes | yes |
| `builds_retry` | | | yes | yes |
| `builds_cancel` | | | yes | yes |
| `hewn_docs` | yes | yes | yes | yes |

Whatever its scopes, an agent can't approve [grants](capability-model.md#grant), set secrets or config, run a connection's sign-in step, enable schedules, see tools' source or raw data, promote a build, or manage other agents. Those are the owner's. An agent limited to some tools gets `not_found` for the others.

## Discovery

The agent learns about the owner's tools in three places:

- **Server instructions:** `SERVER_INSTRUCTIONS` from `src/agents.ts`, followed by a catalog of the tools the agent can see, sent once in the `initialize` response.
- **MCP tool descriptions:** `capabilities_list` and `capabilities_invoke` (`catalog: true` in `src/agents.ts`) carry the same catalog after their description, so clients that drop server instructions still see it.
- **`capabilities_list` and `capabilities_get`:** the list returns `{ capabilities, connections }`, each entry with `id`, `name`, `purpose`, `tags`, `operations` (`name@version`), `widgets` and `ready`. It filters by `name` (substring of id or name), `operation` and `tag`. `capabilities_get` returns the full manifest (every operation's schemas and side effect, the widgets) plus its readiness as `status`; for an agent with `modify`, also `changesComing`: the tool's changes queued or building, oldest first (`buildId`, `kind`, `status`, `request`).

A catalog line looks like this; connections are listed apart, and a tool that isn't ready says so:

```
- Running Log (running-log): Maintain a durable personal running history … Operations: record_run@1, list_runs@1, get_summary@1.
```

Without `discover`, the catalog is empty. When the agent's list of MCP tools changes, including any description (a tool created, changed, deleted, made ready, or the agent's scopes changed), the session gets `notifications/tools/list_changed` and the client should list tools again.

## Invoking operations

`capabilities_invoke` takes `{ capabilityId, operation, operationVersion?, input? }`. Without `operationVersion` it calls the highest version of that operation. A new version may change the contract, so a client that saves calls for later (a script, a recurring workflow) should pass `operationVersion`; every result names the version that ran (`operation: "name@N"`). The host validates `input` against the operation's `inputSchema`, runs it, and validates the output.

A successful result is JSON text: `{ capabilityId, operation: "record_run@1", result }`, plus `deprecated` (a message naming the replacement) when the operation is deprecated.

A failed call is an MCP tool result with `isError: true` and JSON text `{ error, message, details? }`. The codes:

| `error` | Meaning |
| --- | --- |
| `not_found` | No such tool, or not visible to this agent; or no such operation (`details.available` lists the operations). |
| `invalid_input` | The input doesn't match `inputSchema`; `details` lists the schema errors. |
| `not_ready` | The tool needs the owner first (a grant, a secret, config, a model); `details` is its readiness, with `userAction` saying what to ask the owner. `capabilities_request_access` files a visible request. |
| `awaiting_confirmation` | A destructive call is waiting for the owner (below). |
| `forbidden` | Not allowed: a missing scope, the owner rejected a destructive call, or a sign-in step. |
| `operation_failed` | The tool's code threw, or the call ran out of time. |
| `invalid_output` | The tool returned output its own schema doesn't allow. |
| `invalid_request`, `conflict`, `unauthenticated`, `internal` | Bad requests to the MCP tools themselves, state conflicts (a build already running), and the rest. |

**Destructive operations.** When an agent calls an operation whose `sideEffect` is `destructive`, the host holds the call and asks the owner to confirm exactly that call: the same agent, operation and input. It waits up to about a minute. If the owner confirms in time, the call runs and returns normally. If not, it returns `awaiting_confirmation` and stays on the owner's list; the agent tells the owner, and calls again with the same input once they have confirmed. A rejection is reported once, as `forbidden`. Only agents' calls are held: the owner's own calls aren't (Hewn's web client asks before running a destructive one), and neither are one tool's calls to another, which the owner granted.

## Builds

An agent with `create` or `modify` asks the host's builder for a new tool or a change. It never writes the code itself, and it can't promote anything: the host validates every result (see [tools.md](tools.md#tests-and-promotion)).

- **`capabilities_create`** `{ name, purpose, requirements, kind?, after?, widgets?, model?, effort? }` starts a build. The tool's id is derived from `name`. `kind: "connection"` builds a [connection](capability-model.md#connection); only connections hold credentials, so a tool that needs a service with a login is built on one. `after: <buildId>` makes the build wait (status `waiting`) until that build promotes, for example the connection it will call. `widgets: true` also queues a widgets build after it, returned as `widgetsBuildId`.
- **`capabilities_modify`** `{ capabilityId, request, after?, model?, effort? }` asks for a change to an existing tool. A change to a connection, or one that adds operations, waits for the owner's review once it passes validation (status `review`). Changes to one tool take turns: one asked for while another is queued or building waits for it (status `waiting`) and is built on the version it makes; one in review doesn't hold it up.
- **`capabilities_add_widgets`** `{ capabilityId, request?, after?, model?, effort? }` asks for a build that adds widgets and changes nothing else.
- **`model` and `effort`** on those three choose what the build runs on: a model name the owner's builder takes (`default` for its own, a family such as `fable`, or a full name) and an effort (`low`, `medium`, `high`, more on some models). Leave them out to use the owner's choice. The owner decides which names agents may use; the tools' descriptions list them ("Models you may ask for"), and any other is an `invalid_request` naming the allowed ones, as is an effort the model doesn't take (naming its levels). A build's `model` says what it ran on (`ran`). A model the builder can't run fails the build at once ("Model not available"); it never runs on another one instead.
- **`builds_wait`** `{ buildId, timeoutSeconds? }` follows a build until it is promoted, fails, or waits for the owner's review. If the request carries a `progressToken`, each builder action and validation step arrives as a `notifications/progress` message. After `timeoutSeconds` (default 600, at most 1800) it returns the current state with `waitTimedOut: true`; call it again to keep following.
- **`builds_get`** returns a build's state: `status` (`waiting`, `open`, `building`, `validating`, `review`, `failed`, `promoted`, `cancelled`), its log, and `resultVersion` once promoted. A change waiting its turn behind an earlier change to the same tool has `queued: true`. A build the builder's host paused part-way, its work kept, is `failed` with `failure.paused: true`: tell the owner, who continues or stops it in Hewn (once continued, `continuedAs` names the build that carries it on). **`builds_retry`** re-runs a failed or cancelled build, except a paused one (only the owner continues it). **`builds_cancel`** cancels a build the agent requested (the owner can cancel any), except while it's being validated.

A promoted tool may still be not ready: if it asks for hosts, secrets, other tools' operations or a model, the owner approves those first. `capabilities_get` shows what's missing.

## Schedules

An agent with `invoke` can propose running an operation on a timetable: `schedules_propose` `{ capabilityId, operation, operationVersion?, input?, cadence, note? }`. The schedule is created as `proposed` and never runs until the owner enables it.

- **Cadence:** `"hourly"`, `"daily HH:MM"`, `"weekly mon HH:MM"`, or a 5-field cron expression, in the owner's timezone. At most once every 5 minutes.
- **Operations:** read and write only. Destructive operations and a connection's sign-in step can't be scheduled. The input is validated when it's proposed, and the operation version is pinned then.
- A schedule that fails 3 times in a row is paused.

`schedules_list` (with `discover`) shows schedules with their status, next and last run.

## Widgets in the chat

`widgets_show` `{ capabilityId, widget, input?, size? }` runs one of a tool's widgets (see [tools.md](tools.md#widgets-since-23)) and returns its view. It is read-only.

- **MCP Apps:** the tool's `_meta.ui.resourceUri` is `ui://hewn/widget` (`WIDGET_APP_URI`). The server lists that one resource (`text/html;profile=mcp-app`), a self-contained page that loads nothing from the network. Clients that support MCP Apps render it and pass it the tool result; it draws the view.
- **The result** has `structuredContent` (`capabilityId`, `widget`, `title`, `view`, `size`, `input`, `icon`, `at`) and, as `content`, the same view as plain text. Clients without MCP Apps show the text.
- **Buttons:** the widget page calls `capabilities_invoke` through the client for a button press (as the agent, under its grants, so a destructive one waits for the owner), then `widgets_show` again to redraw.
- **Size:** `small`, `medium` or `large`; by default `medium` if the widget offers it, else its first size.

`capabilities_get` lists a tool's widgets; a widget's input is its operation's `inputSchema`.

## Hewn's docs

`hewn_docs` `{ query?, page? }` reads Hewn's own documentation, so an agent asked how Hewn works answers from it instead of guessing (the server instructions say so). Every agent has it, whatever its scopes. The pages are the user docs (`docs/*.md`) and this spec (`spec/*.md`), named by their paths in the repo (`docs/concepts.md`), as the links between them are written. The result is plain text:

- **No input:** the pages, each with its title and its sections.
- **`query`:** the five sections that best match its words (a word in a heading counts more than a mention), each under a line naming its page, anchor and heading: `--- docs/concepts.md#grants (Concepts › Grants) ---`. A long section is cut, with the call that reads it whole.
- **`page`:** that page's markdown, or with `page#section` (the anchor, as links write it, or the heading) one section and the ones under it. With `query` too: the search, within that page.

An unknown page or section is `not_found`, naming the ones there are.

## For host implementers

A host that wants existing agents to work offers the same surface: one Streamable HTTP endpoint at `/mcp`, OAuth 2.1 with discovery metadata, dynamic client registration and PKCE, the four scopes, exactly the MCP tools in `AGENT_TOOLS` (names, scopes, descriptions and input schemas), the catalog in the server instructions and in the descriptions of the tools marked `catalog`, `tools/list_changed` when an agent's tool list changes, and the `ui://hewn/widget` resource for tools marked `widgetApp`. How the owner approves agents, destructive calls and schedules is up to the host, as long as only the owner can.
