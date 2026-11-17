"""Client behaviour: error mapping, headers, and URL safety.

Mirrors ``typescript/test/client.test.ts``. These assert on the exact wording
of error messages because the wording is the feature: it is what tells a model
to stop on a spent quota and to retry on a rate limit.
"""

from __future__ import annotations

import httpx
import pytest

from ktemia_mcp.client import VERSION, KtemiaClient, KtemiaError


@pytest.fixture
def mock_transport(monkeypatch):
    """Routes every httpx.AsyncClient through a handler the test supplies."""

    def install(handler):
        original = httpx.AsyncClient.__init__

        def patched(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            original(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)

    return install


# ── Credentials ──────────────────────────────────────────────────────────────


def test_missing_key_is_an_actionable_error(monkeypatch):
    monkeypatch.delenv("KTEMIA_API_KEY", raising=False)
    with pytest.raises(KtemiaError) as info:
        KtemiaClient()
    assert info.value.code == "MISSING_API_KEY"
    # The message must point at the server config, never at a tool argument.
    assert "KTEMIA_API_KEY" in info.value.message
    assert "tool argument" in info.value.message


def test_key_is_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("KTEMIA_API_KEY", "from-env")
    assert KtemiaClient()._api_key == "from-env"


def test_explicit_key_wins_over_the_environment(monkeypatch):
    monkeypatch.setenv("KTEMIA_API_KEY", "from-env")
    assert KtemiaClient(api_key="explicit")._api_key == "explicit"


# ── Base URL safety ──────────────────────────────────────────────────────────


def test_defaults_to_production():
    assert KtemiaClient(api_key="k")._base_url == "https://api.ktemia.com"


def test_plain_http_override_is_refused():
    """The one unrecoverable mistake: a key sent somewhere else in the clear."""
    with pytest.raises(KtemiaError) as info:
        KtemiaClient(api_key="k", base_url="http://evil.example.com")
    assert info.value.code == "INSECURE_API_URL"


def test_localhost_http_is_allowed_for_development():
    client = KtemiaClient(api_key="k", base_url="http://localhost:8787")
    assert client._base_url == "http://localhost:8787"


def test_trailing_slash_is_trimmed():
    client = KtemiaClient(api_key="k", base_url="https://api.ktemia.com/")
    assert client._base_url == "https://api.ktemia.com"


# ── Headers ──────────────────────────────────────────────────────────────────


async def test_sends_api_key_and_client_attribution(mock_transport):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json={"ok": True})

    mock_transport(handler)
    await KtemiaClient(api_key="test-key").get("/key")
    assert seen["x-api-key"] == "test-key"
    assert seen["x-ktemia-client"] == f"mcp/{VERSION}"


async def test_key_is_not_leaked_into_the_query_string(mock_transport):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})

    mock_transport(handler)
    await KtemiaClient(api_key="test-key").get("/key")
    assert "test-key" not in seen["url"]


# ── Query building ───────────────────────────────────────────────────────────


async def test_drops_unset_params_and_repeats_lists(mock_transport):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = request.url.params.multi_items()
        return httpx.Response(200, json={"ok": True})

    mock_transport(handler)
    await KtemiaClient(api_key="k").get(
        "/hotels/locations",
        {"query": "london", "country": None, "providers": ["a", "b"]},
    )
    assert seen["params"] == [("query", "london"), ("providers", "a"), ("providers", "b")]


async def test_booleans_are_sent_as_json_literals(mock_transport):
    """Python's str(True) is "True", which the API would reject."""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json={"ok": True})

    mock_transport(handler)
    await KtemiaClient(api_key="k").get("/hotels/results", {"freeCancellation": True})
    assert seen["params"]["freeCancellation"] == "true"


# ── The 429 split, which is the whole point of this layer ────────────────────


async def test_quota_exceeded_is_terminal(mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={"X-Quota-Limit": "100"},
            json={
                "success": False,
                "error": {
                    "code": "QUOTA_EXCEEDED",
                    "message": "Monthly quota exhausted.",
                },
            },
        )

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k").get("/flights/results")

    error = info.value
    assert error.code == "QUOTA_EXCEEDED"
    assert error.retryable is False
    # A second key on the same account shares the quota; the model must be
    # told, or it will suggest exactly that.
    assert "quota is shared" in error.message
    assert "100 requests a month" in error.message
    assert "ktemia_key_status" in error.message


async def test_rate_limit_is_retryable_and_says_so(mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={"Retry-After": "2"},
            json={
                "success": False,
                "error": {
                    "code": "RATE_LIMIT_EXCEEDED",
                    "message": "Too many requests.",
                },
            },
        )

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k").get("/flights/results")

    error = info.value
    assert error.retryable is True
    assert "Wait 2 seconds" in error.message
    assert "not the monthly quota" in error.message


async def test_bare_429_defaults_to_rate_limit(mock_transport):
    """A 429 with no envelope is a speed limit, the safer assumption."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow down")

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k").get("/flights/results")
    assert info.value.code == "RATE_LIMIT_EXCEEDED"
    assert info.value.retryable is True


# ── Other failures ───────────────────────────────────────────────────────────


async def test_upstream_envelope_is_passed_through(mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "success": False,
                "error": {
                    "code": "INVALID_ORIGIN",
                    "message": "Unknown origin XYZ.",
                    "param": "origin",
                },
            },
        )

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k").post("/flights/search", {})

    assert info.value.code == "INVALID_ORIGIN"
    assert info.value.param == "origin"
    assert info.value.retryable is False


async def test_server_errors_are_retryable(mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k").get("/key")
    assert info.value.retryable is True
    assert info.value.code == "UPSTREAM_ERROR"


async def test_redirects_are_refused(mock_transport):
    """Following one would replay the API key to another origin."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "https://evil.example.com"})

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k").get("/key")
    assert info.value.code == "UPSTREAM_ERROR"
    assert "another host" in info.value.message


async def test_non_json_success_is_an_error(mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>maintenance</html>")

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k").get("/key")
    assert info.value.code == "UPSTREAM_ERROR"
    assert info.value.retryable is True


async def test_timeout_is_retryable(mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k", timeout=30).get("/flights/results")
    assert info.value.code == "TIMEOUT"
    assert info.value.retryable is True
    assert "30s" in info.value.message


async def test_network_failure_is_retryable(mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns", request=request)

    mock_transport(handler)
    with pytest.raises(KtemiaError) as info:
        await KtemiaClient(api_key="k").get("/key")
    assert info.value.code == "NETWORK_ERROR"
    assert info.value.retryable is True
