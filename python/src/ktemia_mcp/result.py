"""Shared plumbing for tool handlers: result shaping and error reporting.

Mirrors ``typescript/src/result.ts``. Both languages return the same JSON for
the same situation, so an agent behaves identically whether the server was
installed with ``uvx`` or ``npx``.

Why handlers return ``CallToolResult`` rather than a plain dict or a raised
exception, which would both be more idiomatic for this SDK:

  * Raising ``ToolError`` prefixes the message with ``Error executing tool
    <name>:``, which corrupts the JSON error payload the TypeScript server
    emits verbatim.
  * Raising anything else is treated as a crash and the model sees only
    ``Error executing tool <name>`` - the quota and rate-limit guidance, the
    entire reason these messages are written the way they are, is discarded.

Returning the result keeps the payloads byte-identical across both packages.
The one cost is that a tool annotated ``-> CallToolResult`` publishes no
``outputSchema``; see NOTES.md.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.types import CallToolResult, TextContent, ToolAnnotations

from .client import KtemiaError

#: Every tool here reads live provider data. Nothing writes, nothing deletes,
#: and two identical calls can legitimately return different prices.
#:
#: Per the spec, clients must treat annotations as untrusted hints, so these
#: inform display and consent prompts only - they are not a security control.
READ_ONLY_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=True,
)


def ok(data: dict[str, Any]) -> CallToolResult:
    """A successful tool result.

    ``structuredContent`` is the machine-readable payload; the same JSON is
    also serialised into a text block, which the spec asks for so clients that
    do not read ``structuredContent`` still see the data.
    """
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(data, indent=2))],
        structuredContent=data,
    )


def fail(error: BaseException) -> CallToolResult:
    """A failed tool result.

    This is a tool execution error (``isError: true``), not a protocol error:
    the model is supposed to see it and decide what to do, which is the whole
    point of distinguishing a retryable rate limit from a terminal quota
    exhaustion.

    Deliberately carries no ``structuredContent``. The spec requires
    ``structuredContent`` to conform to the tool's declared ``outputSchema``,
    and an error payload never does - a client that validates rejects the whole
    result and the model sees a schema complaint instead of the actual error.
    The text block carries the same JSON, so nothing is lost.
    """
    if isinstance(error, KtemiaError):
        body: dict[str, Any] = {
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable,
        }
        if error.param:
            body["param"] = error.param
    else:
        body = {
            "code": "INTERNAL_ERROR",
            "message": str(error),
            "retryable": False,
        }

    return CallToolResult(
        isError=True,
        content=[TextContent(type="text", text=json.dumps({"error": body}, indent=2))],
    )


def compact(obj: dict[str, Any]) -> dict[str, Any]:
    """Drops keys the caller left unset, so the API sees a clean body."""
    return {k: v for k, v in obj.items() if v is not None}


def id_string(value: str | int | float) -> str:
    """Normalise an identifier field that may arrive as a number.

    Several Ktemia identifiers are numeric strings - a hotel location id is
    "29230" - and a model that copies one out of a lookup result will often
    emit it unquoted. Rejecting that gives the model a validation error it
    cannot act on, since from its point of view it passed the id it was given.
    Numbers are accepted and stringified instead.

    Deliberately not applied to dates or times: "2027-01-15" is never a number,
    and coercing there would hide a genuinely malformed argument.
    """
    # 29230.0 must not become "29230.0"; JSON has no integer type, so an id
    # that survived a float round-trip still has to come back as an integer.
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)
