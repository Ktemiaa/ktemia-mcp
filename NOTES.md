# Implementation notes

Verified against the published spec and the installed packages on 2026-11-16.
Everything here was checked against `node_modules` or a live fetch, not recalled.

## Protocol and packages

- Current protocol revision: **2026-07-28**.
- TypeScript SDK was **split into scoped packages at 2.x**.
  `@modelcontextprotocol/sdk` (1.32.2) is the previous monolith and does
  *not* export `serveStdio`. The current package is
  **`@modelcontextprotocol/server` 2.4.0**, which depends on `zod@^4`.
- Python SDK `mcp` is at **2.3.0** (also a major bump from 1.x).

## Entry point

Use `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`, not
`server.connect(new StdioServerTransport())`. The hand-wired form still
compiles but serves only 2025-era clients. `serveStdio` negotiates the era
per connection and serves both.

The argument is a **factory**: it is called again for a `server/discover`
probe that is discarded if the client falls back to `initialize`, so it must
return a fresh `McpServer` every time.

## Tool registration

`registerTool(name, config, cb)` where config is
`{ title?, description?, inputSchema?, outputSchema?, annotations?, icons?, _meta? }`.

Schemas must be wrapped: `inputSchema: z.object({ ... })`. The bare
raw-shape form (`{ field: z.string() }`) is deprecated in 2.x.

For a tool with no parameters the spec recommends
`{ "type": "object", "additionalProperties": false }`.

## Tool naming

Allowed characters are `A-Z a-z 0-9 _ . -`, length 1-128, case-sensitive.
The spec notes that clients aggregating several servers hit collisions on
generic names like `search`, and that `serverInfo.name` must not be relied
on to disambiguate. Every tool here is therefore prefixed `ktemia_`.

## Annotations

All seven tools are reads against live provider data:
`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: false`,
`openWorldHint: true`.

Clients MUST treat annotations as untrusted unless the server is trusted, so
these are hints for display and ordering, never a substitute for our own
server-side checks.

## Structured output

Return `structuredContent` conforming to a declared `outputSchema`, and also
serialise the same JSON into a `TextContent` block, which the spec asks for
as a backwards-compatibility measure.

## Stateful flow: search -> results -> next page

The upstream API already uses an opaque token chain. `POST /*/search` returns
a `searchToken` that points at page 1; each `GET /*/results` response carries
a `nextToken` and omits it on the last page. The page number is encoded in
the token, so a caller cannot jump to an arbitrary page.

This maps onto the spec's non-normative "Stateful Tools" guidance, which
asks that handles be opaque, that their lifetime be stated in the tool
description so the model can see it, and that a call against an expired
handle return a tool execution error saying so, so the model recovers by
starting a new search instead of retrying blindly.

## Required fields and elicitation

`POST /flights/search` takes either the flat form (`origin`, `destination`,
`departureDate`, optional `returnDate`) **or** `legs` for multi-city. The two
are mutually exclusive and the rule is enforced in the route, so neither is
marked required in the schema. Hotels require `location`, `checkin`,
`checkout`; cars require `pickupLocation`, `pickupDate`, `dropoffDate`.

Where a required field is missing, prefer `InputRequiredResult`
(`resultType: "input_required"` with an `elicitation/create` form and a
`requestState`) over guessing. This is the structural version of the rule the
skills have carried as prose: the agent asks, it does not guess. Guessing also
spends quota, since every upstream call is metered. Clients that do not
support elicitation must still get a clear error, so the fallback matters.

## Credentials

The API key is read from `KTEMIA_API_KEY` in the environment for stdio. The
authorization spec says stdio implementations SHOULD NOT use the OAuth flow
and should take credentials from the environment, which matches.

The key is never a tool parameter and never carries `x-mcp-header`: the spec
warns explicitly against marking API keys and other secrets with it, because
header values are visible to network intermediaries.

Upstream calls carry `X-Ktemia-Client: mcp/<version>` so MCP traffic is
attributable in our own logs.

## Python SDK: verified differences from TypeScript

Checked against `mcp` 2.3.0 on 2026-11-17 by probing the installed package,
not from memory. The two SDKs are not symmetric, and three of these shaped the
implementation:

- **`FastMCP` is gone.** 2.x renamed it to `MCPServer`
  (`from mcp.server.mcpserver import MCPServer`). Importing
  `mcp.server.fastmcp` raises with a migration pointer.
- **Model fields are snake_case.** `tool.input_schema`, not `inputSchema`, and
  `annotations.read_only_hint`, not `readOnlyHint`. Constructors still accept
  the camelCase wire aliases, so `ToolAnnotations(readOnlyHint=True)` works
  while reading it back as `.readOnlyHint` raises.
- **Dual-era negotiation is the default.** `run_stdio_async` delegates to
  `serve_dual_era_loop`, which picks the era from the client's first request.
  There is no equivalent of the TypeScript trap where the hand-wired transport
  silently serves 2025-era clients only. Both eras were verified end to end
  against the built wheel.

### Why handlers return `CallToolResult` instead of raising

The idiomatic Python form is to raise `ToolError`, but both raising paths lose
information the model needs:

- `raise ToolError(payload)` prefixes the message with
  `Error executing tool <name>:`, which corrupts the JSON error envelope the
  TypeScript server emits verbatim.
- Raising anything else is treated as a crash: the model receives only
  `Error executing tool <name>`, discarding the quota-versus-rate-limit
  guidance that is the entire reason those messages are written as they are.

Returning the result keeps both packages byte-identical for the same failure.
`test_quota_error_reaches_the_model_intact` pins this.

### Known asymmetry: no `outputSchema` in Python

A function annotated `-> CallToolResult` publishes no `outputSchema`, and the
SDK rejects `KeyOut | CallToolResult` with
`CallToolResult cannot be used in Union or Optional types`. So
`ktemia_key_status` declares an `outputSchema` in TypeScript and does not in
Python.

This is the lesser of the two evils: `outputSchema` is optional in the spec,
whereas truncated error prose directly causes an agent to retry an exhausted
quota. Both packages still return `structuredContent` on success, which is
what hosts actually read. If the SDK later allows an explicit output schema
alongside a returned result, close the gap here first.

### Annotations must not be deferred

`server.py` deliberately omits `from __future__ import annotations`. With it,
every annotation becomes a string that the SDK re-evaluates in module scope,
where the per-tool spec locals the `Field` descriptions are built from do not
exist — a `NameError` at import time.

## Deviation: API key on the hosted transport (documented on purpose)

The hosted server at `mcp.ktemia.com` will accept `X-API-Key` from the client
and forward it to `api.ktemia.com`. In shape this is the "token passthrough"
anti-pattern, which the security guidance states is forbidden by the
authorization spec. Recording why we accept it:

- Authorization is OPTIONAL in MCP. HTTP transports *SHOULD* conform to the
  OAuth 2.1 flow; it is not a MUST.
- The anti-pattern targets OAuth **audience confusion**: a server accepting a
  token minted for a different resource and deceiving a third-party resource
  server into trusting it. Our key is first-party, issued by Ktemia, and the
  MCP server *is* Ktemia. There is one audience and no third-party deputy.
- The controls the guidance worries about bypassing - monthly quota and
  per-second rate limit - live in `api.ktemia.com` keyed to that same API key,
  so forwarding it circumvents nothing.
- The audit-trail objection is answered by `X-Ktemia-Client`, which makes MCP
  traffic distinguishable from direct API traffic.

The guidance's "future compatibility risk" point stands: if we later need
real audience separation, OAuth 2.1 is the migration. The upstream client is
written so the credential source is one seam, so that change does not ripple
into the tools.
