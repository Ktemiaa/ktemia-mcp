# Ktemia MCP server

[![MCP Badge](https://lobehub.com/badge/mcp/ktemiaa-ktemia-mcp)](https://lobehub.com/mcp/ktemiaa-ktemia-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that searches and compares flights, hotels, and rental cars with the [Ktemia](https://www.ktemia.com/) [API](https://www.ktemia.com/docs/api/). Connect Cursor, Claude Code, Codex, VS Code, Claude Desktop, or any MCP client to it, ask in plain language, and the agent looks up the place, runs the search, and returns each seller's price with a booking link.

Hosted at `https://mcp.ktemia.com/mcp`, or run it yourself with Node (`npx -y @ktemia/mcp`) or Python (`uvx ktemia-mcp`).

**[Get a free API key](https://app.ktemia.com/api-keys)** · [API reference](https://www.ktemia.com/docs/api/) · [Getting started](https://www.ktemia.com/docs/getting-started/) · [Pricing](https://www.ktemia.com/pricing/) · [Guide: flights in Cursor and Claude](https://www.ktemia.com/blog/flights-mcp/) · [Changelog](https://www.ktemia.com/docs/changelog/)

Ktemia compares prices. It does not book the ticket, the car, or the room. The traveller books on the seller's site.

| Tool | Use it for |
| ---- | ---------- |
| `ktemia_key_status` | Plan, rate limits, and requests left this month. Costs no quota. |
| `ktemia_lookup` | Airport, airline, hotel, and car rental location codes |
| `ktemia_search_flights` | One-way, round trip, and multi-city fares |
| `ktemia_search_hotels` | Stays, with stars, ratings, and amenity filters |
| `ktemia_search_cars` | A hire at a city or airport |
| `ktemia_get_details` | Every price and booking link for one chosen result |
| `ktemia_get_hotel_reviews` | Guest reviews for one hotel |

Every plan can use the MCP server, including the [Free plan](https://www.ktemia.com/pricing/) with its 100 requests a month. A paid plan buys request volume and rate, not access.

## Two packages, one behaviour

The server ships in both languages, so you can run it with whichever runtime your machine already has:

| | Package | Command | Needs |
| --- | --- | --- | --- |
| **Node** | [`@ktemia/mcp`](https://www.npmjs.com/package/@ktemia/mcp) | `npx -y @ktemia/mcp` | Node 20+ |
| **Python** | [`ktemia-mcp`](https://pypi.org/project/ktemia-mcp/) | `uvx ktemia-mcp` | Python 3.10+ and [`uv`](https://docs.astral.sh/uv/) |

They are not two codebases that happen to agree. Both read one shared contract, [`spec/tools.json`](spec/tools.json), for every tool name, description, enum, and limit, and CI fails if they drift. Same seven tools, same wording, same errors — pick either.

`npx` and `uvx` both fetch the package on first run and cache it, so there is nothing to install or upgrade by hand.

## Install

You need an API key from [app.ktemia.com/api-keys](https://app.ktemia.com/api-keys). Free, no card.

### Hosted: nothing to install

The same seven tools are served at `https://mcp.ktemia.com/mcp` over Streamable HTTP. Send your key on every request as `X-API-Key: your-key` or `Authorization: Bearer your-key`. Without one the server answers `401` and runs nothing.

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ktemia": {
      "url": "https://mcp.ktemia.com/mcp",
      "headers": { "X-API-Key": "${env:KTEMIA_API_KEY}" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http ktemia https://mcp.ktemia.com/mcp --header "X-API-Key: your-key"
```

Codex CLI, in `~/.codex/config.toml` (sent as a bearer token):

```toml
[mcp_servers.ktemia]
url = "https://mcp.ktemia.com/mcp"
bearer_token_env_var = "KTEMIA_API_KEY"
```

VS Code, Claude.ai connectors with request headers, and other clients: see the [MCP docs](https://www.ktemia.com/docs/mcp/#hosted). ChatGPT needs OAuth sign-in, which is not available yet.

The local packages below are the same server and keep working; use them for clients that cannot send a header, such as Claude Desktop's config file.

### Local

Each example below shows Node first, then Python. Use one, not both — two copies of the same server would just show every tool twice.

#### Cursor

Add to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "ktemia": {
      "command": "npx",
      "args": ["-y", "@ktemia/mcp"],
      "env": { "KTEMIA_API_KEY": "${env:KTEMIA_API_KEY}" }
    }
  }
}
```

Python instead:

```json
{
  "mcpServers": {
    "ktemia": {
      "command": "uvx",
      "args": ["ktemia-mcp"],
      "env": { "KTEMIA_API_KEY": "${env:KTEMIA_API_KEY}" }
    }
  }
}
```

`${env:KTEMIA_API_KEY}` reads the key from your shell environment, so the key itself is not committed in a project file. Export it in your shell profile:

```bash
export KTEMIA_API_KEY="your-key"
```

To paste the key directly instead, put it in `~/.cursor/mcp.json` rather than a project file, and do not commit it.

#### Claude Code

```bash
claude mcp add ktemia -e KTEMIA_API_KEY=your-key -- npx -y @ktemia/mcp
```

Python instead:

```bash
claude mcp add ktemia -e KTEMIA_API_KEY=your-key -- uvx ktemia-mcp
```

Everything after `--` is the command Claude Code runs. Check it with `claude mcp list`.

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "ktemia": {
      "command": "npx",
      "args": ["-y", "@ktemia/mcp"],
      "env": { "KTEMIA_API_KEY": "your-key" }
    }
  }
}
```

Python instead: `"command": "uvx"`, `"args": ["ktemia-mcp"]`.

Restart Claude Desktop, then ask for a flight.

Claude Desktop launches servers from a GUI process that does not read your shell profile, so `npx` or `uvx` must be somewhere it can see. If the server fails to start, use the absolute path from `which npx` or `which uvx` as `command`.

#### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.ktemia]
command = "npx"
args = ["-y", "@ktemia/mcp"]
env = { KTEMIA_API_KEY = "your-key" }
```

Python instead:

```toml
[mcp_servers.ktemia]
command = "uvx"
args = ["ktemia-mcp"]
env = { KTEMIA_API_KEY = "your-key" }
```

#### Any other MCP client

The server speaks MCP over stdio. Run `npx -y @ktemia/mcp` or `uvx ktemia-mcp` with `KTEMIA_API_KEY` in the environment.

It negotiates the protocol revision per connection, so it answers both current (`2026-07-28`) clients and clients that still open with the older `initialize` handshake.

#### Check it before wiring it up

Run the command in a terminal first:

```bash
KTEMIA_API_KEY=your-key npx -y @ktemia/mcp     # or: uvx ktemia-mcp
```

It should sit silently waiting for JSON-RPC on stdin; `Ctrl-C` to quit. An immediate error means the environment is wrong, and reading it here is easier than digging through a client's logs.

## Try it

> Find flights from Lisbon to London on 15 March 2027.

> I need a car at Austin airport from 10 to 17 March, automatic, and I am 23.

> A hotel in London for two, 10–12 March, four stars or better, free cancellation if you can find it. Then show me recent reviews for the one I pick.

> How many Ktemia requests do I have left this month?

## How the search tools work

A search is two steps upstream, folded into one tool call:

1. Call `ktemia_search_flights` (or hotels, or cars) with the trip details. You get the first page of results and a `nextToken`.
2. Call the **same tool** again with only `nextToken` to get the next page. When `nextToken` is absent, that was the last page.

Tokens are opaque and expire **one hour** after the search starts. If a token expires, start a new search rather than retrying it.

Hotel and car searches need a location id from `ktemia_lookup` — the `locationId` field of a result, which is a numeric string like `29230`, not a city name. Flight searches take IATA codes from the `code` field instead, such as `LHR` for Heathrow or `LON` for every London airport.

`ktemia_get_details` expands one result into every price and booking link. Search pages carry only the leading offers, so this is the call that answers "where do I actually book this".

## Quota

Every tool call is one request against your plan's monthly quota, with one exception: `ktemia_key_status` is free and keeps answering after the quota is spent, which is how an agent diagnoses a `QUOTA_EXCEEDED` error without making it worse.

A search costs at least two requests — one to start it, one per page read — so budget accordingly. The quota is shared across **every key on an account**, so creating a second key does not raise the limit.

Two different errors both arrive as HTTP 429, and they mean opposite things:

| Code | Meaning | What to do |
| ---- | ------- | ---------- |
| `RATE_LIMIT_EXCEEDED` | Too many requests per second | Wait for `Retry-After`, then retry |
| `QUOTA_EXCEEDED` | The month's allowance is gone | Stop. Retrying cannot help. |

Limits per plan are on [pricing](https://www.ktemia.com/pricing/).

## Security

- The key is read from `KTEMIA_API_KEY` and sent only as the `X-API-Key` header, over HTTPS, to `https://api.ktemia.com`.
- The key is never a tool parameter. An agent should never ask you to paste it into a tool call, and the server never exposes it in a result.
- A `KTEMIA_API_URL` override must be `https://` (or localhost, for development), and redirects are refused, so the key cannot be sent to another host.
- Upstream calls carry `X-Ktemia-Client: mcp/<version>`, so MCP traffic is distinguishable from direct API traffic in Ktemia's own logs.
- Every tool is read-only. Nothing here books, pays, holds, or cancels anything.

Consider using a **separate key** for your editor, so you can revoke it without touching a production integration. The quota is per account, so a second key costs you nothing in allowance.

### A note on the hosted server

`mcp.ktemia.com` takes your API key and forwards it to `api.ktemia.com`. The MCP [security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) names that shape "token passthrough" and advises against it, so it is worth being explicit about why it is acceptable here: the guidance targets OAuth audience confusion, where a server accepts a token minted for a different service and deceives a third-party resource server into trusting it. A Ktemia key is first-party, the MCP server is Ktemia, and the quota and rate limits live on that same key upstream: one audience, no third party, and no control bypassed.

What the hosted server does with the key:

- It builds a fresh server for each request, with that request's key, so one caller's key can never reach another caller's request.
- It has no key of its own and refuses to start if one is configured, so a request without a key is refused rather than run on someone else's quota.
- A value that is not shaped like a Ktemia key is refused before anything is sent upstream.
- It checks `Host` and `Origin` against allowlists, against DNS rebinding.
- Request logs record method, path, status, and duration. Headers, and so keys, are never logged.

The code is [`typescript/src/http.ts`](typescript/src/http.ts). OAuth sign-in for clients that cannot send a header, such as ChatGPT, is the next step, and the credential source is a single seam in that file.

## Self-host and develop

```bash
git clone https://github.com/Ktemiaa/ktemia-mcp.git
cd ktemia-mcp
```

**TypeScript**

```bash
cd typescript
npm install
npm run build
npm test
```

**Python**

```bash
cd python
uv sync          # also copies spec/tools.json into the package
uv run pytest
```

Point your client at whichever you built:

```json
{
  "mcpServers": {
    "ktemia": {
      "command": "node",
      "args": ["/absolute/path/to/ktemia-mcp/typescript/dist/index.js"],
      "env": { "KTEMIA_API_KEY": "your-key" }
    }
  }
}
```

For Python, `"command": "uv"` with `"args": ["--directory", "/absolute/path/to/ktemia-mcp/python", "run", "ktemia-mcp"]`.

### Layout

```
spec/tools.json   shared tool contract: names, descriptions, enums, defaults
typescript/       the npm package, @ktemia/mcp
python/           the PyPI package, ktemia-mcp
```

Tool names, descriptions, enums, and defaults live in `spec/tools.json`, which both implementations read. The descriptions are what steer an agent — text like "a guessed city searches the wrong trip and spends quota" is what stops it inventing a departure airport — so they are written once rather than copied, since prose that drifts between two packages would change agent behaviour with nothing in any log to show why.

Each package copies that file in at build time, because neither npm nor a Python wheel can include a file from outside its own directory. `typescript/scripts/sync-spec.mjs` and `python/hatch_build.py` do that, and CI asserts both copies are byte-identical to the original.

### Tests

**TypeScript**

```bash
npm test          # offline, deterministic, no key needed
npm run test:live # opt-in, spends real quota
```

**Python**

```bash
uv run pytest                      # offline; the live tests skip themselves
KTEMIA_API_KEY=your-key uv run pytest tests/test_live.py
uv run python scripts/smoke_wheel.py   # checks an installed build can start
```

The offline suites stub the transport, so they cover what production cannot reach on demand — a spent quota, a rate limit, a timeout, a malformed upstream body — and assert that a missing required field is refused locally without an upstream call, so a guessed search cannot cost you a request.

`python/tests/test_parity.py` is the one that keeps the packages honest: it asserts both register the same seven tools in the same order, that every description contains the shared spec's prose verbatim, that every metered tool says so and `ktemia_key_status` does not, and that no numeric parameter advertises an absurd bound.

The live suites run only when `KTEMIA_API_KEY` is set. They exist to catch upstream contract drift: a renamed field would pass every stubbed test and break every real agent. A full pass is about a dozen requests per language.

```bash
npm run inspect:modern   # tools/list over the 2026-07-28 protocol
npm run inspect:legacy   # tools/list over the older initialize handshake
```

Both servers negotiate the protocol era per connection. The Python SDK does this in its stdio loop; the TypeScript one needs `serveStdio`, and the hand-wired transport silently serves 2025-era clients only, which is why CI checks both eras explicitly.

### Releasing

See [PUBLISHING.md](PUBLISHING.md) for the npm and PyPI release process, including the account setup each registry needs and why a bad version cannot be replaced.

## Learn more

**Docs**

- [Travel API reference](https://www.ktemia.com/docs/api/) — every field and error, with code in cURL, Python, Node, Go, Java, Ruby, and PHP
- [Key status and quota](https://www.ktemia.com/docs/api/key/) · [Getting started](https://www.ktemia.com/docs/getting-started/) · [Changelog](https://www.ktemia.com/docs/changelog/)
- [Flights](https://www.ktemia.com/docs/api/flights/search/) · [Hotels](https://www.ktemia.com/docs/api/hotels/search/) · [Cars](https://www.ktemia.com/docs/api/cars/search/)

**For agents and tools**

- [OpenAPI 3.1 spec](https://www.ktemia.com/openapi.json) · [AGENTS.md](https://www.ktemia.com/AGENTS.md) · [llms.txt](https://www.ktemia.com/llms.txt)
- [Ktemia skills](https://github.com/Ktemiaa/ktemia-skills) for Claude Code, Codex, and Cursor — the same searches as agent skills rather than MCP tools
- [Public Postman collection](https://www.postman.com/ktemia-411711/ktemia-api/overview)

**Guides**

- [Flights in Cursor and Claude: MCP, skills, and instructions](https://www.ktemia.com/blog/flights-mcp/)
- [Best travel API in 2026](https://www.ktemia.com/blog/best-travel-api/)

## About Ktemia

[Ktemia](https://www.ktemia.com/) is a search and compare platform for flights, hotels, car rentals, and real estate. Flights, hotels, and cars are live in the API; real estate is next. Use it in the [dashboard](https://www.ktemia.com/product/), through the [API](https://www.ktemia.com/docs/api/), or with the AI copilot.

## License

MIT
