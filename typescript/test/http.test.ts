/**
 * Hosted HTTP transport.
 *
 * Drives `createHttpApp` with the real SDK client over Streamable HTTP - the
 * client's fetch is pointed straight at the app, so no socket is opened -
 * in both protocol eras. Upstream calls to api.ktemia.com are stubbed and
 * recorded, which is how the credential tests see which key went out.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { clientIpFrom, createHttpApp, presentedKey } from "../dist/http.js";

const KEY_A = "sk_live_ktemia_" + "A".repeat(43);
const KEY_B = "sk_live_ktemia_" + "B".repeat(43);
const HOST = "mcp.ktemia.com";
const URL_MCP = `https://${HOST}/mcp`;
const API = "https://api.ktemia.com";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Upstream {
  url: string;
  headers: Record<string, string>;
}

/** Stubs api.ktemia.com only; the app itself is reached by direct call. */
function stubUpstream(): Upstream[] {
  const calls: Upstream[] = [];
  globalThis.fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), headers });
    // The real GET /key shape: the tool validates it against its outputSchema.
    return Response.json({
      key: { fingerprint: "abcd1234", status: "active", createdAt: null },
      plan: { name: "free", monthlyQuota: 100, requestsPerSecond: 2, burst: 5 },
      usage: { month: "2026-11", used: 1, remaining: 99, resetsAt: "2026-12-01T00:00:00Z", scope: "account" },
      metered: false,
    });
  }) as typeof fetch;
  return calls;
}

function makeApp(extra: Partial<Parameters<typeof createHttpApp>[0]> = {}) {
  return createHttpApp({ allowedHosts: [HOST], baseUrl: API, ...extra });
}

type App = ReturnType<typeof makeApp>;

async function connect(
  app: App,
  headers: Record<string, string>,
  mode: "legacy" | "auto",
  clientIp = "203.0.113.7",
) {
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
    requestInit: { headers },
    fetch: ((input: URL | string | Request, init?: RequestInit) => {
      // A real socket always carries Host; an in-process Request does not.
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("host", new URL(request.url).host);
      return app.fetch(new Request(request, { headers }), clientIp);
    }) as typeof fetch,
  });
  const client = new Client(
    { name: "test", version: "0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  return client;
}

function raw(app: App, init: RequestInit & { path?: string; host?: string } = {}) {
  const { path = "/mcp", host = HOST, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("host", host);
  return app.fetch(new Request(`https://${host}${path}`, { ...rest, headers }), "203.0.113.7");
}

const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

for (const mode of ["legacy", "auto"] as const) {
  describe(`hosted server, ${mode} client`, () => {
    test("lists all seven tools for a caller with a key", async () => {
      stubUpstream();
      const client = await connect(makeApp(), { "x-api-key": KEY_A }, mode);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 7);
      await client.close();
    });

    test("a tool call goes upstream with the caller's own key", async () => {
      const calls = stubUpstream();
      const client = await connect(makeApp(), { authorization: `Bearer ${KEY_A}` }, mode);
      const result = await client.callTool({ name: "ktemia_key_status", arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, `${API}/key`);
      assert.equal(calls[0]!.headers["x-api-key"], KEY_A);
      await client.close();
    });
  });
}

describe("credentials", () => {
  test("two callers on one server never see each other's key", async () => {
    const calls = stubUpstream();
    const app = makeApp();
    const a = await connect(app, { "x-api-key": KEY_A }, "auto");
    const b = await connect(app, { "x-api-key": KEY_B }, "auto");
    await Promise.all([
      a.callTool({ name: "ktemia_key_status", arguments: {} }),
      b.callTool({ name: "ktemia_key_status", arguments: {} }),
      a.callTool({ name: "ktemia_key_status", arguments: {} }),
    ]);
    const keys = calls.map((c) => c.headers["x-api-key"]).sort();
    assert.deepEqual(keys, [KEY_A, KEY_A, KEY_B]);
    await Promise.all([a.close(), b.close()]);
  });

  test("a request with no key is refused before any upstream call", async () => {
    const calls = stubUpstream();
    const response = await raw(makeApp(), { method: "POST", headers: MCP_HEADERS, body: LIST_TOOLS });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
    assert.match((await response.json()).error.message, /X-API-Key/);
    assert.equal(calls.length, 0);
  });

  test("a value that is not a Ktemia key is refused locally", async () => {
    const calls = stubUpstream();
    for (const bad of ["hunter2", "sk_live_ktemia_short", `${KEY_A}x`, "sk_test_" + "A".repeat(43)]) {
      const response = await raw(makeApp(), {
        method: "POST",
        headers: { ...MCP_HEADERS, "x-api-key": bad },
        body: LIST_TOOLS,
      });
      assert.equal(response.status, 401, bad);
    }
    assert.equal(calls.length, 0);
  });

  test("X-API-Key wins over Authorization when both are sent", () => {
    const request = new Request(URL_MCP, {
      headers: { "x-api-key": KEY_A, authorization: `Bearer ${KEY_B}` },
    });
    assert.deepEqual(presentedKey(request), { key: KEY_A, oauth: false });
  });

  test("the relay secret and caller address go upstream only when configured", async () => {
    const calls = stubUpstream();
    const plain = await connect(makeApp(), { "x-api-key": KEY_A }, "auto");
    await plain.callTool({ name: "ktemia_key_status", arguments: {} });
    assert.equal(calls[0]!.headers["x-ktemia-relay-secret"], undefined);
    assert.equal(calls[0]!.headers["x-ktemia-client-ip"], undefined);

    const relayed = await connect(
      makeApp({ relaySecret: "s".repeat(32) }),
      { "x-api-key": KEY_A },
      "auto",
      "198.51.100.23",
    );
    await relayed.callTool({ name: "ktemia_key_status", arguments: {} });
    assert.equal(calls[1]!.headers["x-ktemia-relay-secret"], "s".repeat(32));
    assert.equal(calls[1]!.headers["x-ktemia-client-ip"], "198.51.100.23");
    await Promise.all([plain.close(), relayed.close()]);
  });
});

describe("routing and request checks", () => {
  test("health answers for any host", async () => {
    const response = await raw(makeApp(), { path: "/health", host: "10.0.0.1" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  });

  test("an unknown Host is refused (DNS rebinding)", async () => {
    const response = await raw(makeApp(), {
      method: "POST",
      host: "evil.example",
      headers: { ...MCP_HEADERS, "x-api-key": KEY_A },
      body: LIST_TOOLS,
    });
    assert.equal(response.status, 403);
  });

  test("a browser Origin that is not allowed is refused", async () => {
    stubUpstream();
    const response = await raw(makeApp(), {
      method: "POST",
      headers: { ...MCP_HEADERS, "x-api-key": KEY_A, origin: "https://evil.example" },
      body: LIST_TOOLS,
    });
    assert.equal(response.status, 403);
  });

  test("an allowed browser Origin is served", async () => {
    stubUpstream();
    const response = await raw(makeApp({ allowedOrigins: ["claude.ai"] }), {
      method: "POST",
      headers: { ...MCP_HEADERS, "x-api-key": KEY_A, origin: "https://claude.ai" },
      body: LIST_TOOLS,
    });
    assert.equal(response.status, 200);
  });

  test("unknown paths are 404", async () => {
    const response = await raw(makeApp(), { path: "/admin" });
    assert.equal(response.status, 404);
  });

  test("the root names the MCP endpoint", async () => {
    const response = await raw(makeApp(), { path: "/" });
    assert.equal((await response.json()).mcp, URL_MCP);
  });
});

describe("clientIpFrom", () => {
  test("behind one proxy, the entry the proxy observed", () => {
    assert.equal(clientIpFrom("203.0.113.7, 34.1.2.3", "169.254.1.1", 1), "203.0.113.7");
  });
  test("a prepended spoof does not shift it", () => {
    assert.equal(clientIpFrom("1.2.3.4, 203.0.113.7, 34.1.2.3", "169.254.1.1", 1), "203.0.113.7");
  });
  test("a chain too short to be real falls back to the peer", () => {
    assert.equal(clientIpFrom("9.9.9.9", "169.254.1.1", 1), "169.254.1.1");
  });
  test("no trusted hops ignores the header", () => {
    assert.equal(clientIpFrom("9.9.9.9, 8.8.8.8", "127.0.0.1", 0), "127.0.0.1");
  });
});
