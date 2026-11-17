"""HTTP client for api.ktemia.com.

The only module that knows the API key exists. Tools receive parsed data, so
swapping the credential source later touches this file alone.

Mirrors ``typescript/src/client.ts``. The two are kept behaviourally identical
on purpose: an agent must not act differently depending on whether the server
was installed with ``uvx`` or ``npx``.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlsplit

import httpx

VERSION = "0.1.2"

DEFAULT_BASE_URL = "https://api.ktemia.com"

#: How long a search token stays valid, mirroring ``SEARCH_TTL_SECONDS`` upstream.
SEARCH_TOKEN_TTL_SECONDS = 3600


class KtemiaError(Exception):
    """An error written for the model to read, not for a log reader.

    ``code`` is the upstream error code (``QUOTA_EXCEEDED``, ``INVALID_ORIGIN``)
    when the API supplied one. ``retryable`` is the field that matters most: it
    is what stops an agent retrying a quota that cannot come back this month.
    """

    def __init__(
        self,
        *,
        code: str,
        message: str,
        status: int,
        param: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.param = param
        self.retryable = retryable


def _resolve_api_key(explicit: str | None = None) -> str:
    key = explicit or os.environ.get("KTEMIA_API_KEY")
    if not key:
        raise KtemiaError(
            code="MISSING_API_KEY",
            status=401,
            message=(
                "No Ktemia API key configured. Set KTEMIA_API_KEY in the MCP "
                "server environment. Create a key at https://app.ktemia.com - "
                "the Free plan includes 100 requests a month. Do not ask the "
                "user to paste the key into a tool argument; it belongs in the "
                "server config."
            ),
        )
    return key


def _resolve_base_url(explicit: str | None = None) -> str:
    raw = explicit or os.environ.get("KTEMIA_API_URL") or DEFAULT_BASE_URL
    url = raw.rstrip("/")
    parts = urlsplit(url)
    # A key sent to an attacker-controlled host is the one unrecoverable
    # mistake here, so an override must still be HTTPS. Localhost is allowed
    # for development against a local API.
    is_local = parts.hostname in ("localhost", "127.0.0.1")
    if parts.scheme != "https" and not is_local:
        raise KtemiaError(
            code="INSECURE_API_URL",
            status=400,
            message=f"KTEMIA_API_URL must use https (got {parts.scheme}://).",
        )
    return url


def _parse_error_envelope(body: Any) -> dict[str, str] | None:
    """Read ``{"success": false, "error": {...}, "data": null}``."""
    if not isinstance(body, dict):
        return None
    error = body.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    message = error.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    out = {"code": code, "message": message}
    param = error.get("param")
    if isinstance(param, str):
        out["param"] = param
    return out


def _flatten_query(query: dict[str, Any]) -> list[tuple[str, str]]:
    """Drop empty values and repeat the key for list values."""
    pairs: list[tuple[str, str]] = []
    for key, value in query.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            pairs.extend((key, str(item)) for item in value)
        elif isinstance(value, bool):
            # Python's str(True) is "True"; the API expects JSON's "true".
            pairs.append((key, "true" if value else "false"))
        else:
            pairs.append((key, str(value)))
    return pairs


class KtemiaClient:
    """Calls the Ktemia API, translating failures into agent-readable errors."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._api_key = _resolve_api_key(api_key)
        self._base_url = _resolve_base_url(base_url)
        self._timeout = timeout

    async def get(self, path: str, query: dict[str, Any] | None = None) -> Any:
        return await self._request("GET", path, query=query or {})

    async def post(self, path: str, body: Any) -> Any:
        return await self._request("POST", path, body=body)

    async def _request(
        self,
        method: str,
        path: str,
        query: dict[str, Any] | None = None,
        body: Any = None,
    ) -> Any:
        headers = {
            "X-API-Key": self._api_key,
            # Lets us attribute MCP traffic separately from direct API calls.
            "X-Ktemia-Client": f"mcp/{VERSION}",
            "Accept": "application/json",
        }

        try:
            # follow_redirects stays False: the API key must never be replayed
            # to another origin.
            async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=False) as client:
                response = await client.request(
                    method,
                    self._base_url + path,
                    params=_flatten_query(query) if query else None,
                    json=body if body is not None else None,
                    headers=headers,
                )
        except httpx.TimeoutException as exc:
            raise KtemiaError(
                code="TIMEOUT",
                status=504,
                retryable=True,
                message=(
                    f"Ktemia API did not respond within {int(self._timeout)}s. "
                    "Searches can be slow; retry once before telling the user "
                    "it failed."
                ),
            ) from exc
        except httpx.HTTPError as exc:
            raise KtemiaError(
                code="NETWORK_ERROR",
                status=502,
                retryable=True,
                message=f"Could not reach the Ktemia API: {exc}",
            ) from exc

        # A redirect is a failure here, not something to chase.
        if response.is_redirect:
            raise KtemiaError(
                code="UPSTREAM_ERROR",
                status=response.status_code,
                retryable=False,
                message=(
                    "The Ktemia API returned a redirect, which is not followed "
                    "because it would send the API key to another host."
                ),
            )

        try:
            parsed: Any = response.json()
        except ValueError:
            parsed = None

        if response.is_success:
            if parsed is None:
                raise KtemiaError(
                    code="UPSTREAM_ERROR",
                    status=response.status_code,
                    retryable=True,
                    message="The Ktemia API returned a response that was not JSON.",
                )
            return parsed

        envelope = _parse_error_envelope(parsed)
        retry_after = response.headers.get("Retry-After")

        # 429 is two different situations and the model must treat them
        # differently: a rate limit clears in seconds, a spent quota does not
        # clear until the month rolls over.
        if response.status_code == 429:
            code = envelope["code"] if envelope else "RATE_LIMIT_EXCEEDED"
            if code == "QUOTA_EXCEEDED":
                limit = response.headers.get("X-Quota-Limit")
                base = (
                    envelope["message"]
                    if envelope
                    else "The monthly request quota for this account is exhausted."
                )
                raise KtemiaError(
                    code=code,
                    status=429,
                    retryable=False,
                    message=(
                        f"{base} This is terminal: do not retry, and do not try "
                        "a different key on the same account - the quota is "
                        "shared."
                        + (f" Plan limit is {limit} requests a month." if limit else "")
                        + " Call ktemia_key_status for the reset date, which "
                        "costs no quota, then tell the user."
                    ),
                )
            base = envelope["message"] if envelope else "Too many requests per second."
            raise KtemiaError(
                code=code,
                status=429,
                retryable=True,
                message=(
                    f"{base} Wait {retry_after or 'a few'} seconds and retry. "
                    "This is a speed limit, not the monthly quota."
                ),
            )

        if envelope:
            raise KtemiaError(
                code=envelope["code"],
                status=response.status_code,
                param=envelope.get("param"),
                retryable=response.status_code >= 500,
                message=envelope["message"],
            )

        raise KtemiaError(
            code="UPSTREAM_ERROR" if response.status_code >= 500 else "REQUEST_FAILED",
            status=response.status_code,
            retryable=response.status_code >= 500,
            message=f"Ktemia API returned HTTP {response.status_code}.",
        )
