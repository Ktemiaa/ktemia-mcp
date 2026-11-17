/**
 * Error mapping in the upstream client.
 *
 * These are the branches live testing cannot reach. The verification key is
 * enterprise tier with a ten million request quota at 500 requests per second,
 * so QUOTA_EXCEEDED and RATE_LIMIT_EXCEEDED cannot be provoked against the
 * real API without deliberately breaking an account.
 *
 * They are also the branches that matter most. The difference between
 * "terminal, stop" and "retryable, wait" is what decides whether an agent
 * tells the user the budget is gone or retries a dead quota in a loop, so it
 * cannot rest on code review alone.
 *
 * `fetch` is replaced per test rather than mocked through a library, which
 * keeps the suite dependency-free and exercises the real parsing path.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { KtemiaClient, KtemiaError } from "../dist/client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with one that answers every call identically. */
function respondWith(opts: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
}) {
  const body = opts.raw ?? JSON.stringify(opts.body ?? {});
  globalThis.fetch = (async () =>
    new Response(body, {
      status: opts.status,
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    })) as typeof fetch;
}

/** The error envelope the API returns: `{ success, error: {...}, data }`. */
function envelope(code: string, message: string, param?: string) {
  return {
    success: false,
    data: null,
    error: { code, message, ...(param ? { param } : {}) },
  };
}

function client() {
  return new KtemiaClient({ apiKey: "test_key" });
}

async function captureError(fn: () => Promise<unknown>): Promise<KtemiaError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof KtemiaError, `expected KtemiaError, got ${error}`);
    return error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

describe("429 is two different situations", () => {
  test("QUOTA_EXCEEDED is terminal and says so", async () => {
    respondWith({
      status: 429,
      body: envelope("QUOTA_EXCEEDED", "Monthly quota of 100 requests exhausted."),
      headers: { "X-Quota-Limit": "100" },
    });

    const error = await captureError(() => client().get("/flights/results"));

    assert.equal(error.code, "QUOTA_EXCEEDED");
    assert.equal(
      error.retryable,
      false,
      "a spent quota must not be marked retryable - that is what causes retry loops",
    );
    // The guidance has to reach the model, not just the log.
    assert.match(error.message, /do not retry/i);
    assert.match(error.message, /shared/i, "must warn that another key will not help");
    assert.match(error.message, /ktemia_key_status/, "must point at the free diagnostic");
    assert.match(error.message, /100/, "should surface the plan limit from the header");
  });

  test("RATE_LIMIT_EXCEEDED is retryable and carries the wait", async () => {
    respondWith({
      status: 429,
      body: envelope("RATE_LIMIT_EXCEEDED", "Too many requests."),
      headers: { "Retry-After": "7" },
    });

    const error = await captureError(() => client().get("/flights/results"));

    assert.equal(error.code, "RATE_LIMIT_EXCEEDED");
    assert.equal(error.retryable, true);
    assert.match(error.message, /7 seconds/, "the model needs the actual interval");
    assert.match(
      error.message,
      /not the monthly quota/i,
      "must distinguish itself from a spent quota",
    );
  });

  test("an unlabelled 429 is treated as a rate limit, not a dead quota", async () => {
    // Defaulting the other way would make an agent give up on a transient
    // speed limit and tell the user their quota was gone.
    respondWith({ status: 429, raw: "rate limited" });

    const error = await captureError(() => client().get("/key"));

    assert.equal(error.code, "RATE_LIMIT_EXCEEDED");
    assert.equal(error.retryable, true);
  });
});

describe("error envelope parsing", () => {
  test("upstream code, message and param are preserved", async () => {
    respondWith({
      status: 400,
      body: envelope(
        "INVALID_ORIGIN",
        "origin must be an IATA airport or city code.",
        "origin",
      ),
    });

    const error = await captureError(() => client().post("/flights/search", {}));

    assert.equal(error.code, "INVALID_ORIGIN");
    assert.equal(error.param, "origin");
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false, "a bad argument will fail again unchanged");
  });

  test("a 5xx envelope is retryable", async () => {
    respondWith({
      status: 503,
      body: envelope("SESSION_ERROR", "Service is temporarily unavailable."),
    });

    const error = await captureError(() => client().get("/flights/results"));

    assert.equal(error.code, "SESSION_ERROR");
    assert.equal(error.retryable, true);
  });

  test("a body with no envelope still yields a usable error", async () => {
    respondWith({ status: 502, raw: "<html>Bad Gateway</html>" });

    const error = await captureError(() => client().get("/key"));

    assert.equal(error.code, "UPSTREAM_ERROR");
    assert.equal(error.retryable, true);
  });

  test("a 404 without an envelope is not retryable", async () => {
    respondWith({ status: 404, raw: "not found" });

    const error = await captureError(() => client().get("/nope"));

    assert.equal(error.code, "REQUEST_FAILED");
    assert.equal(error.retryable, false);
  });

  test("a 200 that is not JSON is reported rather than returned", async () => {
    respondWith({ status: 200, raw: "not json at all" });

    const error = await captureError(() => client().get("/key"));

    assert.equal(error.code, "UPSTREAM_ERROR");
    assert.equal(error.retryable, true);
  });
});

describe("credentials and transport", () => {
  test("a missing key explains where it belongs", async () => {
    const saved = process.env.KTEMIA_API_KEY;
    delete process.env.KTEMIA_API_KEY;
    try {
      const error = await captureError(async () => new KtemiaClient());
      assert.equal(error.code, "MISSING_API_KEY");
      // The model must not try to solve this by asking the user for the key.
      assert.match(error.message, /KTEMIA_API_KEY/);
      assert.match(error.message, /not.*tool argument|belongs in the server config/i);
    } finally {
      if (saved !== undefined) process.env.KTEMIA_API_KEY = saved;
    }
  });

  test("a plaintext base URL is refused", async () => {
    // Sending the key to an http origin is the one unrecoverable mistake here.
    const error = await captureError(
      async () =>
        new KtemiaClient({ apiKey: "k", baseUrl: "http://evil.example.com" }),
    );
    assert.equal(error.code, "INSECURE_API_URL");
  });

  test("localhost over http is allowed for development", () => {
    assert.doesNotThrow(
      () => new KtemiaClient({ apiKey: "k", baseUrl: "http://localhost:8000" }),
    );
  });

  test("the key and client header are sent on every request", async () => {
    let seen: Headers | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seen = new Headers(init.headers);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await client().get("/key");

    assert.equal(seen?.get("x-api-key"), "test_key");
    assert.match(
      seen?.get("x-ktemia-client") ?? "",
      /^mcp\//,
      "MCP traffic must be attributable in our own logs",
    );
  });

  test("redirects are refused rather than followed", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seen = init;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await client().get("/key");

    assert.equal(
      seen?.redirect,
      "error",
      "following a redirect would hand the API key to another origin",
    );
  });

  test("a timeout is reported as retryable", async () => {
    globalThis.fetch = ((_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const error = await captureError(() =>
      new KtemiaClient({ apiKey: "k", timeoutMs: 20 }).get("/flights/results"),
    );

    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.retryable, true);
    assert.match(error.message, /retry once/i);
  });

  test("a network failure is reported as retryable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const error = await captureError(() => client().get("/key"));

    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.retryable, true);
  });
});

describe("query serialisation", () => {
  test("array values repeat the key and undefined is dropped", async () => {
    let url = "";
    globalThis.fetch = (async (target: URL) => {
      url = target.toString();
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await client().get("/hotels/results", {
      token: "t1",
      amenities: ["wifi", "pool"],
      missing: undefined,
    });

    assert.match(url, /token=t1/);
    assert.match(url, /amenities=wifi/);
    assert.match(url, /amenities=pool/);
    assert.doesNotMatch(url, /missing/);
  });
});
