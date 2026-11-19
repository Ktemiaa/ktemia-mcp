/**
 * OAuth on the hosted server: discovery, relaying to the authorization
 * server, and refusing dead tokens with a 401 a client knows to act on.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHttpApp } from "../dist/http.js";

const HOST = "mcp.ktemia.com";
const ISSUER = `https://${HOST}`;
const AS = "https://backend.example/api/v1/oauth";
const API = "https://api.ktemia.com";
const TOKEN = "ktemia_at_" + "T".repeat(43);
const KEY = "sk_live_ktemia_" + "A".repeat(43);
const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Stubs both the API (GET /key) and the authorization server. */
function stub(keyStatus = 200): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", headers, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    if (url.startsWith(`${API}/key`)) {
      if (keyStatus !== 200) {
        return Response.json({ error: { code: "INVALID_API_KEY", message: "Invalid API key." } }, { status: keyStatus });
      }
      return Response.json({ key: { fingerprint: "x", status: "active", createdAt: null } });
    }
    if (url.startsWith(`${AS}/authorize`)) {
      return new Response(null, { status: 302, headers: { location: "https://app.ktemia.com/oauth/consent?request=r1" } });
    }
    if (url.startsWith(`${AS}/token`)) {
      return Response.json({ access_token: TOKEN, token_type: "Bearer" }, { headers: { "cache-control": "no-store", "set-cookie": "x=1" } });
    }
    return Response.json({ issuer: ISSUER });
  }) as typeof fetch;
  return calls;
}

function makeApp(withOAuth = true) {
  return createHttpApp({
    allowedHosts: [HOST],
    baseUrl: API,
    relaySecret: "r".repeat(32),
    ...(withOAuth ? { oauth: { issuer: ISSUER, upstream: AS } } : {}),
  });
}

function call(app: ReturnType<typeof makeApp>, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  return app.fetch(new Request(`${ISSUER}${path}`, { ...init, headers }), "203.0.113.7");
}

describe("discovery", () => {
  test("a 401 points at the protected resource metadata", async () => {
    const r = await call(makeApp(), "/mcp", { method: "POST", headers: MCP_HEADERS, body: LIST_TOOLS });
    assert.equal(r.status, 401);
    assert.match(
      r.headers.get("www-authenticate") ?? "",
      /resource_metadata="https:\/\/mcp\.ktemia\.com\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });

  test("protected resource metadata names this server as the issuer", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const body = await (await call(makeApp(), path)).json();
      assert.equal(body.resource, `${ISSUER}/mcp`);
      assert.deepEqual(body.authorization_servers, [ISSUER]);
    }
  });

  test("without OAuth configured, none of it exists", async () => {
    const app = makeApp(false);
    assert.equal((await call(app, "/.well-known/oauth-protected-resource")).status, 404);
    assert.equal((await call(app, "/token", { method: "POST" })).status, 404);
    const r = await call(app, "/mcp", { method: "POST", headers: MCP_HEADERS, body: LIST_TOOLS });
    assert.doesNotMatch(r.headers.get("www-authenticate") ?? "", /resource_metadata/);
  });
});

describe("relay to the authorization server", () => {
  test("authorization server metadata is relayed", async () => {
    const calls = stub();
    const r = await call(makeApp(), "/.well-known/oauth-authorization-server");
    assert.equal((await r.json()).issuer, ISSUER);
    assert.equal(calls[0]!.url, `${AS}/metadata`);
  });

  test("/authorize passes the query and returns the redirect untouched", async () => {
    const calls = stub();
    const r = await call(makeApp(), "/authorize?client_id=c&state=s");
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "https://app.ktemia.com/oauth/consent?request=r1");
    assert.equal(calls[0]!.url, `${AS}/authorize?client_id=c&state=s`);
    assert.equal(calls[0]!.headers["x-ktemia-client-ip"], "203.0.113.7");
  });

  test("/token forwards the form and Basic credentials, and only safe headers come back", async () => {
    const calls = stub();
    const r = await call(makeApp(), "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic abc" },
      body: "grant_type=refresh_token&refresh_token=x",
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(calls[0]!.body, "grant_type=refresh_token&refresh_token=x");
    assert.equal(calls[0]!.headers["authorization"], "Basic abc");
  });

  test("the wrong method is refused without going upstream", async () => {
    const calls = stub();
    assert.equal((await call(makeApp(), "/token")).status, 405);
    assert.equal(calls.length, 0);
  });

  test("CORS preflight is answered for browser-based clients", async () => {
    const r = await call(makeApp(), "/token", { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });
});

describe("OAuth tokens on /mcp", () => {
  test("a live token is checked once, then served", async () => {
    const calls = stub();
    const app = makeApp();
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` };
    const init = JSON.stringify({
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    assert.equal((await call(app, "/mcp", { method: "POST", headers, body: init })).status, 200);
    assert.equal((await call(app, "/mcp", { method: "POST", headers, body: init })).status, 200);
    const checks = calls.filter((c) => c.url === `${API}/key`);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.headers["x-api-key"], TOKEN);
  });

  test("an expired or revoked token gets invalid_token, so the client refreshes", async () => {
    stub(401);
    const r = await call(makeApp(), "/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` },
      body: LIST_TOOLS,
    });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });

  test("API keys are not checked ahead of time", async () => {
    const calls = stub();
    await call(makeApp(), "/mcp", { method: "POST", headers: { ...MCP_HEADERS, "x-api-key": KEY }, body: LIST_TOOLS });
    assert.equal(calls.filter((c) => c.url === `${API}/key`).length, 0);
  });

  test("an OAuth token is refused where OAuth is off", async () => {
    stub();
    const r = await call(makeApp(false), "/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` },
      body: LIST_TOOLS,
    });
    assert.equal(r.status, 401);
  });
});
