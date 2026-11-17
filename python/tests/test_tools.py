"""Tool behaviour: guards, paging, routing, and error shaping.

Mirrors ``typescript/test/tools.test.ts``. Calls go through
``MCPServer.call_tool`` so argument validation and result conversion are
exercised the way a real client would exercise them.

The guard tests matter most: each one is a search refused locally, before it
costs a request, when the model has not supplied enough to search for.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from ktemia_mcp.server import create_server


@pytest.fixture
def api(monkeypatch):
    """Installs a fake API and records what it was asked for."""
    calls: list[httpx.Request] = []
    bodies: list[Any] = []

    def install(responder):
        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            bodies.append(json.loads(request.content) if request.content else None)
            return responder(request)

        original = httpx.AsyncClient.__init__

        def patched(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            original(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)
        return calls

    install.calls = calls  # type: ignore[attr-defined]
    install.bodies = bodies  # type: ignore[attr-defined]
    return install


def _payload(result) -> dict[str, Any]:
    """The JSON a model actually reads out of a tool result."""
    return json.loads(result.content[0].text)


async def _call(tool: str, args: dict[str, Any]):
    return await create_server(api_key="test-key").call_tool(tool, args)


def _paged(**extra):
    """A results-page responder: POST starts a search, GET returns a page."""

    def responder(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"searchToken": "tok-1"})
        return httpx.Response(200, json={"page": 1, "hasMore": False, **extra})

    return responder


# ── Guards: a refused search costs nothing ───────────────────────────────────


async def test_flight_search_without_a_route_is_refused(api):
    calls = api(_paged())
    result = await _call("ktemia_search_flights", {})

    assert result.is_error
    error = _payload(result)["error"]
    assert error["code"] == "MISSING_FIELD"
    assert "Ask the user" in error["message"]
    # The point of the guard: no upstream request was made.
    assert calls == []


async def test_flight_search_rejects_both_trip_shapes(api):
    calls = api(_paged())
    result = await _call(
        "ktemia_search_flights",
        {
            "origin": "LIS",
            "destination": "LHR",
            "departureDate": "2027-03-15",
            "legs": [{"origin": "LIS", "destination": "LHR", "date": "2027-03-15"}],
        },
    )
    assert result.is_error
    assert _payload(result)["error"]["code"] == "TRIP_CONFLICT"
    assert calls == []


async def test_hotel_search_names_every_missing_field(api):
    calls = api(_paged())
    result = await _call("ktemia_search_hotels", {"location": "29230"})

    error = _payload(result)["error"]
    assert error["code"] == "MISSING_FIELD"
    assert "checkin" in error["message"] and "checkout" in error["message"]
    # Names the first missing field so a client can highlight it.
    assert error["param"] == "checkin"
    # Steers away from the mistake a model actually makes here.
    assert "not a city name" in error["message"]
    assert calls == []


async def test_car_search_requires_pickup_and_dates(api):
    calls = api(_paged())
    result = await _call("ktemia_search_cars", {"pickupLocation": "12345"})

    error = _payload(result)["error"]
    assert error["code"] == "MISSING_FIELD"
    assert error["param"] == "pickupDate"
    assert "kind='carLocation'" in error["message"]
    assert calls == []


async def test_paging_call_skips_the_guards(api):
    """With a nextToken the trip details are already encoded in the token."""
    calls = api(_paged())
    result = await _call("ktemia_search_hotels", {"nextToken": "tok-abc"})

    assert not result.is_error
    # One GET for the page, and no POST to start a new search.
    assert [c.method for c in calls] == ["GET"]
    assert calls[0].url.params["token"] == "tok-abc"


# ── Search flow ──────────────────────────────────────────────────────────────


async def test_new_search_posts_then_reads_a_page(api):
    calls = api(_paged())
    result = await _call(
        "ktemia_search_flights",
        {"origin": "LIS", "destination": "LHR", "departureDate": "2027-03-15"},
    )

    assert not result.is_error
    assert [c.method for c in calls] == ["POST", "GET"]
    assert calls[0].url.path == "/flights/search"
    assert calls[1].url.path == "/flights/results"
    # The page read uses the token the search returned.
    assert calls[1].url.params["token"] == "tok-1"


async def test_unset_arguments_are_not_sent_upstream(api):
    api(_paged())
    await _call(
        "ktemia_search_flights",
        {"origin": "LIS", "destination": "LHR", "departureDate": "2027-03-15"},
    )
    body = api.bodies[0]
    assert body == {
        "origin": "LIS",
        "destination": "LHR",
        "departureDate": "2027-03-15",
    }


async def test_missing_search_token_is_reported_as_upstream_error(api):
    def responder(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": True})

    api(responder)
    result = await _call(
        "ktemia_search_cars",
        {
            "pickupLocation": "123",
            "pickupDate": "2027-03-10",
            "dropoffDate": "2027-03-17",
        },
    )
    assert result.is_error
    error = _payload(result)["error"]
    assert error["code"] == "UPSTREAM_ERROR"
    assert error["retryable"] is True


# ── Paging hints ─────────────────────────────────────────────────────────────


async def test_paging_hint_tells_the_model_how_to_continue(api):
    api(
        lambda r: httpx.Response(
            200,
            json=(
                {"searchToken": "t"}
                if r.method == "POST"
                else {"page": 1, "hasMore": True, "nextToken": "t2"}
            ),
        )
    )
    result = await _call("ktemia_search_hotels", {"nextToken": "t1"})
    data = _payload(result)
    assert "nextToken only" in data["pagingHint"]
    assert "ktemia_search_hotels" in data["pagingHint"]


async def test_last_page_says_so(api):
    api(_paged())
    result = await _call("ktemia_search_hotels", {"nextToken": "t1"})
    assert _payload(result)["pagingHint"] == "This is the last page of results."


# ── Numeric id coercion ──────────────────────────────────────────────────────


async def test_numeric_location_id_is_accepted(api):
    """A model copying 29230 out of a lookup result emits it unquoted."""
    calls = api(_paged())
    result = await _call(
        "ktemia_search_hotels",
        {"location": 29230, "checkin": "2027-03-10", "checkout": "2027-03-12"},
    )
    assert not result.is_error, _payload(result)
    assert api.bodies[0]["location"] == "29230"
    assert calls[0].method == "POST"


async def test_numeric_result_id_and_token_are_accepted(api):
    api(lambda r: httpx.Response(200, json={"offers": []}))
    result = await _call(
        "ktemia_get_details",
        {"vertical": "hotels", "token": "tok", "resultId": 5782},
    )
    assert not result.is_error, _payload(result)
    assert api.calls[0].url.params["resultId"] == "5782"


async def test_numeric_hotel_id_is_accepted(api):
    api(lambda r: httpx.Response(200, json={"reviews": []}))
    result = await _call("ktemia_get_hotel_reviews", {"hotelId": 5782})
    assert not result.is_error, _payload(result)
    assert api.calls[0].url.params["hotelId"] == "5782"


# ── Routing ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("kind", "path"),
    [
        ("airport", "/flights/airports"),
        ("airline", "/flights/airlines"),
        ("hotelLocation", "/hotels/locations"),
        ("carLocation", "/cars/locations"),
    ],
)
async def test_lookup_routes_each_kind(api, kind: str, path: str):
    api(lambda r: httpx.Response(200, json={"results": []}))
    result = await _call("ktemia_lookup", {"kind": kind, "query": "london"})

    assert not result.is_error, _payload(result)
    assert api.calls[0].url.path == path
    # The kind is echoed so the model can tell which id space it got back.
    assert _payload(result)["kind"] == kind


async def test_location_type_only_goes_to_the_car_endpoint(api):
    """Other lookup endpoints reject an unrecognised field."""
    api(lambda r: httpx.Response(200, json={"results": []}))

    await _call("ktemia_lookup", {"kind": "hotelLocation", "query": "london", "type": "city"})
    assert "type" not in api.calls[0].url.params

    await _call("ktemia_lookup", {"kind": "carLocation", "query": "london", "type": "city"})
    assert api.calls[1].url.params["type"] == "city"


@pytest.mark.parametrize("vertical", ["flights", "hotels", "cars"])
async def test_details_routes_by_vertical(api, vertical: str):
    api(lambda r: httpx.Response(200, json={"offers": []}))
    result = await _call(
        "ktemia_get_details",
        {"vertical": vertical, "token": "tok", "resultId": "r1"},
    )
    assert not result.is_error
    assert api.calls[0].url.path == f"/{vertical}/details"


# ── Quota inspection stays usable when the quota is gone ─────────────────────


async def test_key_status_is_unmetered_and_structured(api):
    payload = {
        "key": {"fingerprint": "abc", "status": "active"},
        "plan": {"name": "free", "monthlyQuota": 100},
        "usage": {"used": 7, "remaining": 93},
        "metered": False,
    }
    api(lambda r: httpx.Response(200, json=payload))
    result = await _call("ktemia_key_status", {})

    assert not result.is_error
    assert api.calls[0].url.path == "/key"
    # Machine-readable alongside the text block, per the spec.
    assert result.structured_content == payload


async def test_errors_carry_no_structured_content(api):
    """An error payload cannot satisfy a success outputSchema.

    A validating client would reject the whole result and the model would see a
    schema complaint instead of the quota error it needs to act on.
    """
    api(
        lambda r: httpx.Response(
            401,
            json={
                "success": False,
                "error": {"code": "INVALID_API_KEY", "message": "Bad key."},
            },
        )
    )
    result = await _call("ktemia_key_status", {})

    assert result.is_error
    assert result.structured_content is None
    assert _payload(result)["error"]["code"] == "INVALID_API_KEY"


async def test_quota_error_reaches_the_model_intact(api):
    """The SDK discards detail from raised exceptions; returned results keep it."""
    api(
        lambda r: httpx.Response(
            429,
            headers={"X-Quota-Limit": "100"},
            json={
                "success": False,
                "error": {"code": "QUOTA_EXCEEDED", "message": "Spent."},
            },
        )
    )
    result = await _call("ktemia_lookup", {"kind": "airport", "query": "london"})

    assert result.is_error
    error = _payload(result)["error"]
    assert error["code"] == "QUOTA_EXCEEDED"
    assert error["retryable"] is False
    assert "quota is shared" in error["message"]
    # Must not be the SDK's generic "Error executing tool" text.
    assert "Error executing tool" not in result.content[0].text


# ── Argument validation ──────────────────────────────────────────────────────


async def test_out_of_range_values_are_rejected(api):
    from mcp.server.mcpserver.exceptions import ToolError

    calls = api(_paged())
    with pytest.raises(ToolError):
        await _call(
            "ktemia_search_hotels",
            {
                "location": "1",
                "checkin": "2027-03-10",
                "checkout": "2027-03-12",
                "rooms": 99,
            },
        )
    assert calls == []


async def test_unknown_enum_value_is_rejected(api):
    from mcp.server.mcpserver.exceptions import ToolError

    calls = api(_paged())
    with pytest.raises(ToolError):
        await _call(
            "ktemia_search_flights",
            {
                "origin": "LIS",
                "destination": "LHR",
                "departureDate": "2027-03-15",
                "cabin": "platinum",
            },
        )
    assert calls == []
