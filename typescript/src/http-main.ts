#!/usr/bin/env node
/**
 * Hosted entry point: serves `createHttpApp` on a Node HTTP server.
 *
 * Configuration, all from the environment:
 *   PORT                    listen port (default 8080, Cloud Run's)
 *   MCP_ALLOWED_HOSTS       comma-separated Host names to answer to
 *                           (default localhost,127.0.0.1)
 *   MCP_ALLOWED_ORIGINS     comma-separated browser origins allowed on /mcp
 *   MCP_TRUSTED_PROXY_HOPS  proxies in front that append X-Forwarded-For
 *                           (1 behind the Google load balancer, default 0)
 *   KTEMIA_RELAY_SECRET     shared with api.ktemia.com; optional
 *   KTEMIA_API_URL          upstream override, as for the stdio server
 *   KTEMIA_OAUTH_ISSUER     this server's public origin; with the next one,
 *                           turns on OAuth sign-in (e.g. https://mcp.ktemia.com)
 *   KTEMIA_OAUTH_UPSTREAM   the backend's OAuth routes, .../api/v1/oauth
 */

import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { VERSION } from "./client.js";
import { clientIpFrom, createHttpApp } from "./http.js";

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

// A server-wide key would be used for any request that somehow arrived
// without one, billing every anonymous caller to whoever owns it. The hosted
// server only ever acts on the caller's key, so refuse to start with one.
if (process.env.KTEMIA_API_KEY) {
  console.error(
    "ktemia-mcp-http: KTEMIA_API_KEY is set. The HTTP server uses each " +
      "caller's own key and must not have one of its own; unset it.",
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const trustedHops = Number(process.env.MCP_TRUSTED_PROXY_HOPS ?? 0);
const allowedHosts = list(process.env.MCP_ALLOWED_HOSTS, ["localhost", "127.0.0.1"]);

const oauthIssuer = process.env.KTEMIA_OAUTH_ISSUER;
const oauthUpstream = process.env.KTEMIA_OAUTH_UPSTREAM;
if (Boolean(oauthIssuer) !== Boolean(oauthUpstream)) {
  console.error("ktemia-mcp-http: set both KTEMIA_OAUTH_ISSUER and KTEMIA_OAUTH_UPSTREAM, or neither.");
  process.exit(1);
}

const app = createHttpApp({
  allowedHosts,
  allowedOrigins: list(process.env.MCP_ALLOWED_ORIGINS, []),
  ...(process.env.KTEMIA_RELAY_SECRET ? { relaySecret: process.env.KTEMIA_RELAY_SECRET } : {}),
  ...(oauthIssuer && oauthUpstream ? { oauth: { issuer: oauthIssuer, upstream: oauthUpstream } } : {}),
  onerror: (error) => console.error("ktemia-mcp-http:", error.message),
});

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  // The URL's host is cosmetic - Host validation reads the header - but a
  // fixed scheme keeps a spoofed Host from producing an odd URL.
  return new Request(new URL(req.url ?? "/", `http://${headers.get("host") ?? "localhost"}`), {
    method: req.method ?? "GET",
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  // Streamed, not buffered: a tool call may answer as server-sent events.
  const reader = response.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await once(res, "drain");
  }
  res.end();
}

const server = createNodeServer(async (req, res) => {
  const started = Date.now();
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const forwarded = req.headers["x-forwarded-for"];
  const clientIp = clientIpFrom(
    Array.isArray(forwarded) ? forwarded.join(",") : forwarded,
    req.socket.remoteAddress ?? "unknown",
    trustedHops,
  );
  try {
    await send(res, await app.fetch(toRequest(req, controller.signal), clientIp));
  } catch (error) {
    console.error("ktemia-mcp-http: unhandled", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
    }
    res.end(res.headersSent ? undefined : JSON.stringify({ error: "Internal error" }));
  } finally {
    // Path and status only: headers carry the caller's key and are never logged.
    console.log(
      JSON.stringify({
        method: req.method,
        path: (req.url ?? "").split("?")[0],
        status: res.statusCode,
        ms: Date.now() - started,
      }),
    );
  }
});

server.listen(port, () => {
  console.error(`ktemia-mcp ${VERSION} serving HTTP on :${port} for ${allowedHosts.join(", ")}`);
});

// Cloud Run sends SIGTERM before stopping an instance; let in-flight
// searches finish rather than cutting them off mid-response.
process.on("SIGTERM", () => {
  server.close(() => {
    void app.close().finally(() => process.exit(0));
  });
});
