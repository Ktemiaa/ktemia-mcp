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
 *
 * OAuth. With `oauth` set, this origin is also an OAuth 2.1 issuer, so
 * clients such as Claude can connect with nothing but the URL: the 401 points
 * at RFC 9728 metadata, and the authorization endpoints are relayed to
 * Ktemia's backend, which owns accounts and consent. The access tokens it
 * issues are one-hour keys bound to the user's account, so they are
 * forwarded exactly like API keys once confirmed live.
 */

import { createHash } from "node:crypto";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { KtemiaClient, KtemiaError, VERSION } from "./client.js";
import { createServer } from "./server.js";

/** Every key Ktemia issues: this prefix and 43 URL-safe characters. */
const API_KEY_PATTERN = /^sk_live_ktemia_[A-Za-z0-9_-]{43}$/;
/** An OAuth access token: a one-hour key the authorization server issued. */
const OAUTH_TOKEN_PATTERN = /^ktemia_at_[A-Za-z0-9_-]{43}$/;

export const MCP_PATH = "/mcp";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/**
 * Paths relayed to the authorization server, and what they are called there.
 * This server's origin is the issuer, so clients find everything on one host;
 * the accounts, consent and token storage behind them live in Ktemia's
 * backend, which is the only place that can see a user's session.
 */
const OAUTH_ROUTES: Record<string, { upstream: string; method: "GET" | "POST" }> = {
  "/.well-known/oauth-authorization-server": { upstream: "/metadata", method: "GET" },
  "/authorize": { upstream: "/authorize", method: "GET" },
  "/token": { upstream: "/token", method: "POST" },
  "/register": { upstream: "/register", method: "POST" },
  "/revoke": { upstream: "/revoke", method: "POST" },
};

/** Response headers worth passing back from the authorization server. */
const RELAYED_HEADERS = [
  "content-type",
  "location",
  "cache-control",
  "pragma",
  "www-authenticate",
  "retry-after",
  "x-frame-options",
  "content-security-policy",
];

const MAX_OAUTH_BODY_BYTES = 16_384;

/** How long a token the API accepted is trusted without asking again. */
const TOKEN_CHECK_TTL_MS = 60_000;
const TOKEN_CHECK_MAX_ENTRIES = 10_000;

export interface OAuthOptions {
  /** This server's public origin, e.g. `https://mcp.ktemia.com`. The issuer. */
  issuer: string;
  /** The backend's OAuth routes, e.g. `https://.../api/v1/oauth`. */
  upstream: string;
}

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
  /** Turns on OAuth sign-in. Without it, only API keys are accepted. */
  oauth?: OAuthOptions;
  onerror?: (error: Error) => void;
}

export interface HttpApp {
  fetch(request: Request, clientIp: string): Promise<Response>;
  close(): Promise<void>;
}

/** The key a request presents, or the reason it is refused. */
export function presentedKey(
  request: Request,
): { key: string; oauth: boolean } | { error: string } {
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
  if (OAUTH_TOKEN_PATTERN.test(key)) return { key, oauth: true };
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
  return { key, oauth: false };
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
    { status, headers },
  );
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const allowedOrigins = options.allowedOrigins ?? [];
  const oauth = options.oauth
    ? { issuer: options.oauth.issuer.replace(/\/+$/, ""), upstream: options.oauth.upstream.replace(/\/+$/, "") }
    : undefined;
  const resourceMetadataUrl = oauth ? `${oauth.issuer}${PROTECTED_RESOURCE_PATH}${MCP_PATH}` : undefined;

  /** RFC 9728: tells a client where to sign in, on every refusal. */
  function challenge(error?: string): Record<string, string> {
    const parts = ['Bearer realm="ktemia"'];
    if (resourceMetadataUrl) parts.push(`resource_metadata="${resourceMetadataUrl}"`);
    if (error) parts.push(`error="${error}"`);
    return { "WWW-Authenticate": parts.join(", ") };
  }

  function relayHeaders(clientIp: string): Record<string, string> {
    return options.relaySecret
      ? { "X-Ktemia-Relay-Secret": options.relaySecret, "X-Ktemia-Client-IP": clientIp }
      : {};
  }

  // Tokens the API accepted recently, by digest so no raw token is held.
  const accepted = new Map<string, number>();

  /**
   * Whether an OAuth token is still live, asked of the API's unmetered GET /key.
   *
   * Needed because an expired token must be refused here, with a 401, for the
   * client to refresh it. Passed through, it would fail inside a tool result
   * instead, which no client treats as a reason to refresh. Only a definite
   * "no" refuses: if the API cannot be reached the request goes on, and the
   * API, which checks every call anyway, has the final word.
   */
  async function tokenIsLive(token: string, clientIp: string): Promise<boolean> {
    const id = createHash("sha256").update(token).digest("hex");
    const until = accepted.get(id);
    if (until !== undefined && until > Date.now()) return true;
    accepted.delete(id);
    try {
      const client = new KtemiaClient({
        apiKey: token,
        timeoutMs: 10_000,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.relaySecret ? { relay: { secret: options.relaySecret, clientIp } } : {}),
      });
      await client.get("/key");
    } catch (error) {
      if (error instanceof KtemiaError && (error.status === 401 || error.status === 403)) return false;
      return true;
    }
    if (accepted.size >= TOKEN_CHECK_MAX_ENTRIES) accepted.delete(accepted.keys().next().value!);
    accepted.set(id, Date.now() + TOKEN_CHECK_TTL_MS);
    return true;
  }

  async function relayOAuth(request: Request, route: { upstream: string; method: string }, clientIp: string): Promise<Response> {
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": `${route.method}, OPTIONS`,
          "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method !== route.method) {
      return Response.json({ error: "invalid_request", error_description: "Method not allowed" }, { status: 405, headers: cors });
    }
    const url = new URL(request.url);
    const headers: Record<string, string> = { Accept: "application/json", ...relayHeaders(clientIp) };
    let body: string | undefined;
    if (route.method === "POST") {
      body = await request.text();
      if (body.length > MAX_OAUTH_BODY_BYTES) {
        return Response.json({ error: "invalid_request", error_description: "Body too large" }, { status: 413, headers: cors });
      }
      headers["Content-Type"] = request.headers.get("content-type") ?? "application/x-www-form-urlencoded";
      const authorization = request.headers.get("authorization");
      // Client credentials for confidential clients (HTTP Basic).
      if (authorization) headers["Authorization"] = authorization;
    }
    let upstream: Response;
    try {
      upstream = await globalThis.fetch(oauth!.upstream + route.upstream + url.search, {
        method: route.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        // /authorize answers with a redirect meant for the user's browser.
        redirect: "manual",
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      return Response.json(
        { error: "temporarily_unavailable", error_description: "Sign-in is unavailable right now. Please retry." },
        { status: 503, headers: cors },
      );
    }
    const out = new Headers(cors);
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
  }

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

    if (oauth) {
      // RFC 9728. Served at both the bare and the path-suffixed location,
      // since clients differ on which one they try first.
      if (url.pathname === PROTECTED_RESOURCE_PATH || url.pathname === PROTECTED_RESOURCE_PATH + MCP_PATH) {
        return Response.json(
          {
            resource: oauth.issuer + MCP_PATH,
            authorization_servers: [oauth.issuer],
            scopes_supported: ["search"],
            bearer_methods_supported: ["header"],
            resource_name: "Ktemia",
            resource_documentation: "https://www.ktemia.com/docs/mcp/",
          },
          { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } },
        );
      }
      const route = OAUTH_ROUTES[url.pathname];
      if (route) return relayOAuth(request, route, clientIp);
    }

    if (url.pathname !== MCP_PATH) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const badOrigin = originValidationResponse(request, allowedOrigins);
    if (badOrigin) return badOrigin;

    const presented = presentedKey(request);
    if ("error" in presented) {
      return jsonRpcError(401, presented.error, challenge());
    }
    if (presented.oauth) {
      if (!oauth) {
        return jsonRpcError(401, "This server does not accept OAuth tokens. Use a Ktemia API key.", challenge());
      }
      if (!(await tokenIsLive(presented.key, clientIp))) {
        return jsonRpcError(
          401,
          "The access token has expired or was revoked. Refresh it, or sign in again.",
          challenge("invalid_token"),
        );
      }
    }

    const authInfo: AuthInfo = {
      token: presented.key,
      clientId: presented.oauth ? "oauth" : "api-key",
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
