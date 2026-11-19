/**
 * Hosted transport: MCP over Streamable HTTP, for mcp.ktemia.com.
 *
 * A web-standard `(Request) => Response` app, so it is tested without a
 * socket; `http-main.ts` puts it on a Node server. Every request is served
 * by a fresh `McpServer` built for that caller's API key, so nothing about
 * one caller - key, client, cached state - can reach another's request.
 *
 * Credentials. The caller's Ktemia API key, in `X-API-Key` or as
 * `Authorization: Bearer <key>`, is forwarded to api.ktemia.com, which does
 * all quota, rate-limit and revocation enforcement. NOTES.md records why
 * that is acceptable for a first-party key. The server never falls back to
 * a key of its own: a request without one is refused before any tool runs.
 */

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { VERSION } from "./client.js";
import { createServer } from "./server.js";

/** Every key Ktemia issues: this prefix and 43 URL-safe characters. */
const API_KEY_PATTERN = /^sk_live_ktemia_[A-Za-z0-9_-]{43}$/;

export const MCP_PATH = "/mcp";

export interface HttpAppOptions {
  /** Host names this deployment answers to, e.g. `["mcp.ktemia.com"]`. */
  allowedHosts: string[];
  /**
   * Browser origins allowed to call `/mcp`. Requests with no `Origin` - every
   * desktop, CLI and server-side client - are unaffected. Empty by default.
   */
  allowedOrigins?: string[];
  /** Shared with api.ktemia.com so it throttles each caller on their own address. */
  relaySecret?: string;
  /** Overrides the upstream API, for tests. */
  baseUrl?: string;
  onerror?: (error: Error) => void;
}

export interface HttpApp {
  fetch(request: Request, clientIp: string): Promise<Response>;
  close(): Promise<void>;
}

/** The key a request presents, or the reason it is refused. */
export function presentedKey(
  request: Request,
): { key: string } | { error: string } {
  const header = request.headers.get("x-api-key")?.trim();
  const authorization = request.headers.get("authorization")?.trim();
  let key = header;
  if (!key && authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    key = match?.[1]?.trim();
  }
  if (!key) {
    return {
      error:
        "No Ktemia API key. Send it in the X-API-Key header or as " +
        "'Authorization: Bearer <key>'. Create one at https://app.ktemia.com.",
    };
  }
  // Checked here rather than left to the API: a malformed value can never
  // be a key, and refusing it locally keeps junk from counting as failed
  // logins against the caller's address upstream.
  if (!API_KEY_PATTERN.test(key)) {
    return {
      error:
        "That is not a Ktemia API key. Keys start with sk_live_ktemia_. " +
        "Create one at https://app.ktemia.com.",
    };
  }
  return { key };
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
    { status, headers },
  );
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const allowedOrigins = options.allowedOrigins ?? [];

  const handler: McpHttpHandler = createMcpHandler(
    (ctx) => {
      const auth = ctx.authInfo;
      // Unreachable through fetch() below, which refuses unauthenticated
      // requests first. Asserted so a future route cannot quietly serve
      // tools on the server's environment instead of the caller's key.
      if (!auth?.token) throw new Error("MCP request reached the factory without a key");
      const clientIp = auth.extra?.clientIp;
      return createServer({
        apiKey: auth.token,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.relaySecret && typeof clientIp === "string"
          ? { relay: { secret: options.relaySecret, clientIp } }
          : {}),
      });
    },
    { ...(options.onerror ? { onerror: options.onerror } : {}) },
  );

  async function fetch(request: Request, clientIp: string): Promise<Response> {
    const url = new URL(request.url);

    // Health is answered for any Host: the load balancer and the deploy
    // smoke test probe it, and it exposes nothing.
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "ktemia-mcp", version: VERSION });
    }

    // DNS-rebinding protection: only answer to our own host names.
    const badHost = hostHeaderValidationResponse(request, options.allowedHosts);
    if (badHost) return badHost;

    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        service: "ktemia-mcp",
        version: VERSION,
        mcp: new URL(MCP_PATH, url).toString(),
        docs: "https://www.ktemia.com/docs/mcp/",
      });
    }

    if (url.pathname !== MCP_PATH) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const badOrigin = originValidationResponse(request, allowedOrigins);
    if (badOrigin) return badOrigin;

    const presented = presentedKey(request);
    if ("error" in presented) {
      return jsonRpcError(401, presented.error, {
        "WWW-Authenticate": 'Bearer realm="ktemia"',
      });
    }

    const authInfo: AuthInfo = {
      token: presented.key,
      clientId: "api-key",
      scopes: [],
      extra: { clientIp },
    };
    return handler.fetch(request, { authInfo });
  }

  return { fetch, close: () => handler.close() };
}

/**
 * The caller's address, as the load balancer in front of Cloud Run saw it.
 *
 * Same rule as api.ktemia.com: count `trustedHops` entries in from the
 * right of X-Forwarded-For, because a caller controls only the left of it.
 * With no trusted hops - running directly, as in development - the socket
 * peer is the caller.
 */
export function clientIpFrom(
  forwardedFor: string | undefined,
  peer: string,
  trustedHops: number,
): string {
  if (trustedHops <= 0 || !forwardedFor) return peer;
  const hops = forwardedFor.split(",").map((h) => h.trim()).filter(Boolean);
  return hops.length > trustedHops ? hops[hops.length - trustedHops - 1]! : peer;
}
