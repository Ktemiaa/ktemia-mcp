# Ktemia MCP server

A [Model Context Protocol](https://modelcontextprotocol.io/) server that searches and compares flights, hotels, and rental cars with the [Ktemia](https://www.ktemia.com/) [API](https://www.ktemia.com/docs/api/). Point Cursor, Claude Code, Claude Desktop, or any MCP client at it, ask in plain language, and the agent looks up the place, runs the search, and returns each seller's price with a booking link.

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

## Install

You need an API key from [app.ktemia.com](https://app.ktemia.com). Free, no card.

### Cursor

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

`${env:KTEMIA_API_KEY}` reads the key from your shell environment, so the key itself is not committed in a project file. Export it in your shell profile:

```bash
export KTEMIA_API_KEY="your-key"
```

To paste the key directly instead, put it in `~/.cursor/mcp.json` rather than a project file, and do not commit it.

### Claude Code

```bash
claude mcp add ktemia -e KTEMIA_API_KEY=your-key -- npx -y @ktemia/mcp
```

### Claude Desktop

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

Restart Claude Desktop, then ask for a flight.

### Any other MCP client

The server speaks MCP over stdio. Run `npx -y @ktemia/mcp` with `KTEMIA_API_KEY` in the environment.

It negotiates the protocol revision per connection, so it answers both current (`2026-07-28`) clients and clients that still open with the older `initialize` handshake.

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

A hosted server at `mcp.ktemia.com` is planned, and it will accept your API key and forward it to `api.ktemia.com`. The MCP [security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) names that shape "token passthrough" and advises against it, so it is worth being explicit about why it is acceptable here: the guidance targets OAuth audience confusion, where a server accepts a token minted for a different service and deceives a third-party resource server into trusting it. A Ktemia key is first-party, the MCP server is Ktemia, and the quota and rate limits live on that same key upstream — one audience, no third party, and no control bypassed. If that changes, OAuth 2.1 is the migration, and the credential source is a single seam in the code so it will not ripple into the tools.

Until then, run it locally over stdio as above.

## Self-host

The server is open source: [github.com/Ktemiaa/ktemia-mcp](https://github.com/Ktemiaa/ktemia-mcp). Clone it, run `npm install && npm run build` in `typescript/`, and point your client at `dist/index.js`.

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
