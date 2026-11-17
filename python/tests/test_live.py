"""Live smoke test against the real API.

Opt-in: skipped unless ``KTEMIA_API_KEY`` is set, so ``pytest`` stays offline
and deterministic for contributors and CI. Run it with
``pytest tests/test_live.py``.

These calls spend real quota - roughly a dozen requests for a full pass, which
fits inside a Free plan's monthly 100 with room left over. They also hit live
provider data, so assertions check shape and plausibility rather than exact
prices or counts, which move hour to hour.

The point is to catch upstream contract drift: a renamed field or a changed
token shape would pass every stubbed test and break every real agent. It also
confirms the Python client reaches the same API, the same way, as the
TypeScript one - a header or query-encoding bug would show up only here.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from ktemia_mcp.client import KtemiaClient, KtemiaError
from ktemia_mcp.server import create_server

pytestmark = pytest.mark.skipif(
    not os.environ.get("KTEMIA_API_KEY"),
    reason="set KTEMIA_API_KEY to run the live smoke test (spends real quota)",
)


def _future(days: int) -> str:
    """A date comfortably ahead, so searches are not empty."""
    return (datetime.now(timezone.utc) + timedelta(days=days)).date().isoformat()


OUT = _future(60)
BACK = _future(63)


@pytest.fixture
def client() -> KtemiaClient:
    return KtemiaClient()


# ── Quota inspection ─────────────────────────────────────────────────────────


async def test_key_reports_a_plan_and_is_not_metered(client: KtemiaClient):
    before = await client.get("/key")

    assert before["plan"]["name"], "a key must report its plan"
    assert before["metered"] is False
    assert before["usage"]["scope"] in ("account", "key")

    # The whole point of the endpoint: checking the budget must not spend it.
    after = await client.get("/key")
    assert after["usage"]["used"] == before["usage"]["used"], (
        "reading /key twice changed the counter - the endpoint is metered after all"
    )


# ── Lookup ───────────────────────────────────────────────────────────────────


async def test_airports_resolve_a_city_to_codes(client: KtemiaClient):
    data = await client.get("/flights/airports", {"query": "London"})
    codes = [a["code"] for a in data.get("airports", [])]

    assert codes, "London returned no airports"
    assert "LHR" in codes, f"expected Heathrow among {', '.join(codes)}"


async def test_hotel_locations_expose_location_id(client: KtemiaClient):
    data = await client.get("/hotels/locations", {"query": "London"})
    first = (data.get("locations") or [None])[0]

    assert first, "London returned no hotel locations"
    assert "locationId" in first, (
        "hotel locations must expose locationId - the tool prose names that field"
    )


async def test_car_locations_expose_location_id(client: KtemiaClient):
    data = await client.get("/cars/locations", {"query": "Austin"})
    assert (data.get("locations") or [{}])[0].get("locationId") is not None


# ── Search, paging, and details ──────────────────────────────────────────────


async def test_flight_search_pages_and_details_carry_links(client: KtemiaClient):
    started = await client.post(
        "/flights/search",
        {"origin": "LHR", "destination": "JFK", "departureDate": OUT},
    )
    assert started.get("searchToken"), "no search token returned"
    assert started["expiresIn"] > 0, (
        "the token lifetime is quoted in tool descriptions and must be real"
    )

    page1 = await client.get("/flights/results", {"token": started["searchToken"]})
    assert page1["page"] == 1
    assert page1["flights"], "no flights on page one"
    assert page1["flights"][0].get("id"), "results must carry an id for details"

    if page1.get("hasMore"):
        assert page1.get("nextToken"), "hasMore was true but no nextToken was given"
        page2 = await client.get("/flights/results", {"token": page1["nextToken"]})
        assert page2["page"] == 2
        first_ids = {f["id"] for f in page1["flights"]}
        overlap = [f for f in page2["flights"] if f["id"] in first_ids]
        assert not overlap, "page two repeated results from page one"

    details = await client.get(
        "/flights/details",
        {"token": started["searchToken"], "resultId": page1["flights"][0]["id"]},
    )
    options = details.get("bookingOptions") or []
    assert options, "details returned no booking options"
    # Booking links are the product. A rename here breaks every agent.
    assert options[0].get("providerUrl", "").startswith("http")
    assert options[0].get("providerCode")


async def test_hotel_search_returns_results(client: KtemiaClient):
    locations = await client.get("/hotels/locations", {"query": "London"})
    city = next(
        (loc for loc in locations["locations"] if loc.get("locationType") == "city"),
        locations["locations"][0],
    )

    started = await client.post(
        "/hotels/search",
        {"location": city["locationId"], "checkin": OUT, "checkout": BACK},
    )
    page = await client.get("/hotels/results", {"token": started["searchToken"]})

    assert page["hotels"], "no hotels returned for London"
    assert page["hotels"][0].get("name"), "hotels must carry a name"
    assert page["hotels"][0].get("id") is not None, (
        "hotels must carry an id - reviews and details need it"
    )


async def test_car_search_returns_results(client: KtemiaClient):
    locations = await client.get("/cars/locations", {"query": "Austin"})
    started = await client.post(
        "/cars/search",
        {
            "pickupLocation": locations["locations"][0]["locationId"],
            "pickupDate": OUT,
            "dropoffDate": BACK,
        },
    )
    page = await client.get("/cars/results", {"token": started["searchToken"]})
    assert page["cars"], "no cars returned for Austin"


# ── Error contract ───────────────────────────────────────────────────────────


async def test_bogus_token_is_refused_not_silently_empty(client: KtemiaClient):
    # The tool descriptions tell the model to start a new search when a token
    # expires, which only works if the API says so rather than returning [].
    with pytest.raises(KtemiaError):
        await client.get("/flights/results", {"token": "obviously_not_a_token"})


async def test_bad_origin_is_rejected_with_a_named_code(client: KtemiaClient):
    with pytest.raises(KtemiaError) as info:
        await client.post(
            "/flights/search",
            {"origin": "NOTACODE", "destination": "JFK", "departureDate": OUT},
        )
    assert any(part in info.value.code for part in ("INVALID", "MISSING", "UNSUPPORTED")), (
        f"expected a named validation code, got {info.value.code}"
    )


# ── End to end, through the tools a model actually calls ─────────────────────


async def test_a_model_can_search_hotels_end_to_end():
    """Lookup then search, exactly as an agent would, through the MCP layer."""
    app = create_server()

    found = await app.call_tool("ktemia_lookup", {"kind": "hotelLocation", "query": "London"})
    assert not found.is_error, found.content[0].text
    locations = json.loads(found.content[0].text)["locations"]

    # Deliberately passed as an int: this is what a model does with "29230",
    # and it must not be a validation error.
    location_id = int(locations[0]["locationId"])

    searched = await app.call_tool(
        "ktemia_search_hotels",
        {"location": location_id, "checkin": OUT, "checkout": BACK},
    )
    assert not searched.is_error, searched.content[0].text

    page = json.loads(searched.content[0].text)
    assert page["hotels"], "no hotels returned"
    assert "pagingHint" in page, "the model needs to be told how to continue"
    # Structured content is what a modern host reads.
    assert searched.structured_content is not None
