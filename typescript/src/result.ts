/**
 * Shared plumbing for tool handlers: result shaping and error reporting.
 */

import { KtemiaError } from "./client.js";
import { z } from "zod";

/**
 * Every tool here reads live provider data. Nothing writes, nothing deletes,
 * and two identical calls can legitimately return different prices.
 *
 * Per the spec, clients must treat annotations as untrusted hints, so these
 * inform display and consent prompts only - they are not a security control.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * A successful tool result.
 *
 * `structuredContent` is the machine-readable payload; the same JSON is also
 * serialised into a text block, which the spec asks for so clients that do not
 * read `structuredContent` still see the data.
 */
export function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * A failed tool result.
 *
 * This is a tool execution error (`isError: true`), not a protocol error: the
 * model is supposed to see it and decide what to do, which is the whole point
 * of distinguishing a retryable rate limit from a terminal quota exhaustion.
 *
 * Deliberately returns no `structuredContent`. The spec requires
 * `structuredContent` to conform to the tool's declared `outputSchema`, and an
 * error payload never does - a client that validates (the Inspector does)
 * rejects the whole result and the model sees a schema complaint instead of
 * the actual error. The text block carries the same JSON, so nothing is lost.
 */
export function fail(error: unknown) {
  const payload =
    error instanceof KtemiaError
      ? {
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.param ? { param: error.param } : {}),
          },
        }
      : {
          error: {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };

  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/** Drops keys the caller left undefined, so the API sees a clean body. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * A schema for identifier fields, accepting a number as well as a string.
 *
 * Several Ktemia identifiers are numeric strings - a hotel location id is
 * "29230" - and a model that copies one out of a lookup result will often
 * emit it unquoted. A bare `z.string()` rejects that with a validation error
 * the model cannot act on, since from its point of view it passed the id it
 * was given. Numbers are accepted and stringified instead.
 *
 * Deliberately not used for dates or times: "2027-01-15" is never a number,
 * and coercing there would hide a genuinely malformed argument.
 */
export function idString() {
  return z
    .union([z.string().min(1), z.number()])
    .transform((value) => String(value));
}

/**
 * The sentence appended to every paging tool's description.
 *
 * The spec's stateful-tool guidance asks that a handle's lifetime be stated in
 * the description, so the model can see the constraint when it decides whether
 * to keep paging or start over.
 */
export const TOKEN_LIFETIME_NOTE =
  "Tokens are opaque and expire one hour after the search starts. " +
  "Page through with the nextToken from the previous page; when nextToken is " +
  "absent there are no more pages. If a token has expired, start a new search " +
  "rather than retrying the same token.";

/**
 * The quota sentence for tools that spend it.
 *
 * Stated per tool because the model's budgeting decision happens at the point
 * of the call, and a search costs at least two requests: one to start it and
 * one per page read.
 */
export const QUOTA_NOTE =
  "Costs one API request against the account's monthly quota. " +
  "Starting a search and reading each page are separate requests.";
