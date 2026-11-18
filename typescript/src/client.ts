/**
 * The HTTP client for api.ktemia.com.
 *
 * This is the only module that knows the API key exists. Tools receive
 * already-parsed data, so adding OAuth later (see NOTES.md) touches this file
 * and nothing else.
 */

export const VERSION = "0.1.3";

const DEFAULT_BASE_URL = "https://api.ktemia.com";

/** How long a search token stays valid, mirroring SEARCH_TTL_SECONDS upstream. */
export const SEARCH_TOKEN_TTL_SECONDS = 3600;

/**
 * An error the model is meant to read.
 *
 * `code` is the upstream error code (`QUOTA_EXCEEDED`, `INVALID_ORIGIN`, ...)
 * when the API supplied one. The message is written for an agent deciding what
 * to do next, not for a log reader.
 */
export class KtemiaError extends Error {
  readonly code: string;
  readonly status: number;
  readonly param?: string;
  readonly retryable: boolean;

  constructor(opts: {
    code: string;
    message: string;
    status: number;
    param?: string;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = "KtemiaError";
    this.code = opts.code;
    this.status = opts.status;
    this.param = opts.param;
    this.retryable = opts.retryable ?? false;
  }
}

export interface ClientOptions {
  /** Overrides `KTEMIA_API_KEY`. The hosted transport passes the caller's key here. */
  apiKey?: string;
  /** Overrides `KTEMIA_API_URL`. Intended for testing against a local API. */
  baseUrl?: string;
  /** Per-request timeout. Searches are the slow path; 60s is above the upstream ceiling. */
  timeoutMs?: number;
}

function resolveApiKey(explicit?: string): string {
  const key = explicit ?? process.env.KTEMIA_API_KEY;
  if (!key) {
    throw new KtemiaError({
      code: "MISSING_API_KEY",
      status: 401,
      message:
        "No Ktemia API key configured. Set KTEMIA_API_KEY in the MCP server " +
        "environment. Create a key at https://app.ktemia.com - the Free plan " +
        "includes 100 requests a month. Do not ask the user to paste the key " +
        "into a tool argument; it belongs in the server config.",
    });
  }
  return key;
}

function resolveBaseUrl(explicit?: string): string {
  const raw = explicit ?? process.env.KTEMIA_API_URL ?? DEFAULT_BASE_URL;
  const url = raw.replace(/\/+$/, "");
  // A key sent to an attacker-controlled host is the one unrecoverable
  // mistake here, so an override must still be HTTPS. Localhost is let
  // through for development against a local API.
  const parsed = new URL(url);
  const isLocal =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new KtemiaError({
      code: "INSECURE_API_URL",
      status: 400,
      message: `KTEMIA_API_URL must use https (got ${parsed.protocol}//).`,
    });
  }
  return url;
}

/** Shape of the error envelope: `{ success: false, error: {...}, data: null }`. */
function parseErrorEnvelope(
  body: unknown,
): { code: string; message: string; param?: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message, param } = error as Record<string, unknown>;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return {
    code,
    message,
    ...(typeof param === "string" ? { param } : {}),
  };
}

export class KtemiaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async get<T = unknown>(
    path: string,
    query: Record<string, unknown> = {},
  ): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown },
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // The API reads a list as one comma-separated value. Repeating the
        // key instead is silently wrong: it keeps only the last value, so
        // sources=booking&sources=agoda reads Agoda alone.
        if (value.length) url.searchParams.set(key, value.map(String).join(","));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          // Lets us attribute MCP traffic separately from direct API calls.
          "X-Ktemia-Client": `mcp/${VERSION}`,
          Accept: "application/json",
          ...(opts.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : {}),
        signal: controller.signal,
        // The API key must never follow a redirect to another origin.
        redirect: "error",
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new KtemiaError({
          code: "TIMEOUT",
          status: 504,
          retryable: true,
          message: `Ktemia API did not respond within ${Math.round(
            this.timeoutMs / 1000,
          )}s. Searches can be slow; retry once before telling the user it failed.`,
        });
      }
      throw new KtemiaError({
        code: "NETWORK_ERROR",
        status: 502,
        retryable: true,
        message: `Could not reach the Ktemia API: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Fall through: a non-JSON body is reported as an upstream error below.
      }
    }

    if (response.ok) {
      if (parsed === undefined) {
        throw new KtemiaError({
          code: "UPSTREAM_ERROR",
          status: response.status,
          retryable: true,
          message: "The Ktemia API returned a response that was not JSON.",
        });
      }
      return parsed as T;
    }

    const envelope = parseErrorEnvelope(parsed);
    const retryAfter = response.headers.get("Retry-After");

    // 429 is two different situations and the model must treat them
    // differently: a rate limit clears in seconds, a spent quota does not
    // clear until the month rolls over.
    if (response.status === 429) {
      const code = envelope?.code ?? "RATE_LIMIT_EXCEEDED";
      if (code === "QUOTA_EXCEEDED") {
        const limit = response.headers.get("X-Quota-Limit");
        throw new KtemiaError({
          code,
          status: 429,
          retryable: false,
          message:
            (envelope?.message ??
              "The monthly request quota for this account is exhausted.") +
            ` This is terminal: do not retry, and do not try a different key on the same account - the quota is shared.${
              limit ? ` Plan limit is ${limit} requests a month.` : ""
            } Call ktemia_key_status for the reset date, which costs no quota, then tell the user.`,
        });
      }
      throw new KtemiaError({
        code,
        status: 429,
        retryable: true,
        message:
          (envelope?.message ?? "Too many requests per second.") +
          ` Wait ${retryAfter ?? "a few"} seconds and retry. This is a speed limit, not the monthly quota.`,
      });
    }

    if (envelope) {
      throw new KtemiaError({
        code: envelope.code,
        status: response.status,
        ...(envelope.param ? { param: envelope.param } : {}),
        retryable: response.status >= 500,
        message: envelope.message,
      });
    }

    throw new KtemiaError({
      code: response.status >= 500 ? "UPSTREAM_ERROR" : "REQUEST_FAILED",
      status: response.status,
      retryable: response.status >= 500,
      message: `Ktemia API returned HTTP ${response.status}.`,
    });
  }
}
