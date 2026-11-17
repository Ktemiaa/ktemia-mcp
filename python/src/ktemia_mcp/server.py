"""The Ktemia MCP server: all seven tools.

Mirrors ``typescript/src/server.ts`` and ``typescript/src/tools/*.ts``. Every
piece of prose comes from ``spec/tools.json``, so the two packages describe
themselves identically; only the parameter types are native.

The client is built lazily, on the first call that needs it. Constructing it
eagerly would make a server with no API key fail at startup, which an MCP host
surfaces as "server crashed" with no explanation. Deferring it means the
missing key arrives as a readable tool error instead.
"""

#
# Deliberately no "from __future__ import annotations" here, and it must not be
# added: it would turn every annotation into a string that the SDK later
# re-evaluates in module scope, where the per-tool spec locals this file builds
# its Field descriptions from do not exist. The failure is a NameError at
# import time, so it is at least loud, but the cause is not obvious.

from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp.types import CallToolResult
from pydantic import Field

from . import spec
from .client import VERSION, KtemiaClient, KtemiaError
from .result import READ_ONLY_ANNOTATIONS, compact, fail, id_string, ok
from .types import (
    Alliance,
    Cabin,
    CarClass,
    CarSortBy,
    Country,
    FlightSortBy,
    HotelSortBy,
    IdLike,
    Leg,
    LocationType,
    LookupKind,
    Passengers,
    PriceMode,
    ReviewSort,
    SortOrder,
    Transmission,
    Vertical,
)

#: The four lookup endpoints, keyed by what the model is resolving.
LOOKUP_ENDPOINTS = {
    "airport": "/flights/airports",
    "airline": "/flights/airlines",
    "hotelLocation": "/hotels/locations",
    "carLocation": "/cars/locations",
}

INSTRUCTIONS = (
    "Ktemia searches flights, hotels, and car rentals across many providers "
    "and compares them. It never books, holds, or pays for anything.\n\n"
    "Resolve places with ktemia_lookup before searching: flight searches take "
    "the airport code, hotel and car searches take the numeric locationId. "
    "Never guess a code, a city, or a date - ask the user, because a guessed "
    "value spends quota and returns a confident answer about the wrong trip.\n\n"
    "Every call except ktemia_key_status costs one request against the "
    "account's monthly quota, and a search costs one per page on top of the "
    "one that starts it. Page only as far as the user needs. On "
    "QUOTA_EXCEEDED, stop and say so; on RATE_LIMIT_EXCEEDED, wait and retry."
)


def _param(tool: str, name: str) -> Any:
    """Field metadata for one optional parameter, described by the spec."""
    return Field(None, description=spec.param(tool, name))


def _required(tool: str, name: str) -> Any:
    """Field metadata for one required parameter, described by the spec."""
    return Field(description=spec.param(tool, name))


def _bounded(tool: str, name: str, **bounds: Any) -> Any:
    """Field metadata for a numeric parameter with explicit bounds.

    Bounds are stated rather than left open because pydantic emits no maximum
    for a bare ``int``, and an unbounded integer in a published schema invites
    a model to pass 9999 rooms.
    """
    return Field(None, description=spec.param(tool, name), **bounds)


def create_server(
    api_key: str | None = None,
    base_url: str | None = None,
) -> MCPServer:
    """Builds the server with all seven tools registered."""
    app = MCPServer(
        name="ktemia",
        title="Ktemia Travel Search",
        version=VERSION,
        instructions=INSTRUCTIONS,
        website_url="https://www.ktemia.com",
    )

    client: KtemiaClient | None = None

    def get_client() -> KtemiaClient:
        nonlocal client
        if client is None:
            client = KtemiaClient(api_key=api_key, base_url=base_url)
        return client

    async def run_search(
        vertical: str,
        next_token: str | None,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        """Start a search then read its first page, or read a later page.

        Two upstream requests for a new search, one for a subsequent page. The
        model sees a single call either way.
        """
        token = next_token
        if not token:
            started = await get_client().post(f"/{vertical}/search", body)
            token = started.get("searchToken") if isinstance(started, dict) else None
            if not token:
                raise KtemiaError(
                    code="UPSTREAM_ERROR",
                    status=502,
                    retryable=True,
                    message=(f"Ktemia started a {vertical} search but returned no search token."),
                )
        return await get_client().get(f"/{vertical}/results", {"token": token})

    def with_paging_hint(tool_name: str, page: dict[str, Any]) -> dict[str, Any]:
        """Adds the paging hint the model needs to decide what to do next.

        ``nextToken`` on its own is easy to overlook, so the instruction is
        spelled out in the payload rather than left implicit in the
        description.
        """
        return {
            **page,
            "pagingHint": (
                f"More results are available. To read the next page, call "
                f"{tool_name} with nextToken only."
                if page.get("nextToken")
                else "This is the last page of results."
            ),
        }

    # ── Key status ───────────────────────────────────────────────────────────
    key_status = spec.tool("ktemia_key_status")

    @app.tool(
        name=key_status["name"],
        title=key_status["title"],
        description=key_status["description"],
        annotations=READ_ONLY_ANNOTATIONS,
    )
    async def ktemia_key_status() -> CallToolResult:
        try:
            return ok(await get_client().get("/key"))
        except Exception as error:  # noqa: BLE001 - reported to the model
            return fail(error)

    # ── Lookup ───────────────────────────────────────────────────────────────
    lookup = spec.tool("ktemia_lookup")

    @app.tool(
        name=lookup["name"],
        title=lookup["title"],
        description=spec.describe(lookup["name"], ["quotaNote"]),
        annotations=READ_ONLY_ANNOTATIONS,
    )
    async def ktemia_lookup(
        kind: Annotated[LookupKind, _required(lookup["name"], "kind")],
        query: Annotated[str, _required(lookup["name"], "query")],
        type: Annotated[LocationType | None, _param(lookup["name"], "type")] = None,
        country: Annotated[Country | None, _param(lookup["name"], "country")] = None,
        locale: Annotated[str | None, _param(lookup["name"], "locale")] = None,
    ) -> CallToolResult:
        try:
            data = await get_client().get(
                LOOKUP_ENDPOINTS[kind],
                compact(
                    {
                        "query": query,
                        "country": country,
                        "locale": locale,
                        # Only the car endpoint accepts a location type;
                        # sending it elsewhere would be rejected as an
                        # unrecognised field.
                        "type": type if kind == "carLocation" else None,
                    }
                ),
            )
            return ok({"kind": kind, **data})
        except Exception as error:  # noqa: BLE001
            return fail(error)

    # ── Flights ──────────────────────────────────────────────────────────────
    flights = spec.tool("ktemia_search_flights")

    @app.tool(
        name=flights["name"],
        title=flights["title"],
        description=spec.describe(
            flights["name"],
            ["askDoNotGuessNote", "tokenLifetimeNote", "quotaNote", "searchNotBookNote"],
        ),
        annotations=READ_ONLY_ANNOTATIONS,
    )
    async def ktemia_search_flights(
        nextToken: Annotated[str | None, _param(flights["name"], "nextToken")] = None,
        origin: Annotated[str | None, _param(flights["name"], "origin")] = None,
        destination: Annotated[str | None, _param(flights["name"], "destination")] = None,
        departureDate: Annotated[str | None, _param(flights["name"], "departureDate")] = None,
        returnDate: Annotated[str | None, _param(flights["name"], "returnDate")] = None,
        legs: Annotated[list[Leg] | None, _param(flights["name"], "legs")] = None,
        cabin: Annotated[Cabin | None, _param(flights["name"], "cabin")] = None,
        passengers: Annotated[Passengers | None, _param(flights["name"], "passengers")] = None,
        maxStops: Annotated[int | None, _bounded(flights["name"], "maxStops", ge=0, le=3)] = None,
        airlines: Annotated[list[str] | None, _param(flights["name"], "airlines")] = None,
        alliances: Annotated[list[Alliance] | None, _param(flights["name"], "alliances")] = None,
        maxPrice: Annotated[float | None, _bounded(flights["name"], "maxPrice", gt=0)] = None,
        sortBy: Annotated[FlightSortBy | None, _param(flights["name"], "sortBy")] = None,
        sortOrder: Annotated[SortOrder | None, _param(flights["name"], "sortOrder")] = None,
        country: Annotated[Country | None, _param(flights["name"], "country")] = None,
    ) -> CallToolResult:
        try:
            if not nextToken:
                flat = bool(origin or destination or departureDate)
                multi = bool(legs)
                if not flat and not multi:
                    raise KtemiaError(
                        code="MISSING_FIELD",
                        status=400,
                        message=(
                            "A flight search needs either origin, destination "
                            "and departureDate, or a legs list for multi-city. "
                            "Ask the user for whichever is missing instead of "
                            "guessing: a guessed route spends quota and "
                            "returns the wrong trip."
                        ),
                    )
                if flat and multi:
                    raise KtemiaError(
                        code="TRIP_CONFLICT",
                        status=400,
                        message=(
                            "Pass either origin/destination/departureDate or "
                            "legs, not both. Use legs only for multi-city "
                            "itineraries."
                        ),
                    )

            body = compact(
                {
                    "origin": origin,
                    "destination": destination,
                    "departureDate": departureDate,
                    "returnDate": returnDate,
                    "legs": [leg.model_dump() for leg in legs] if legs else None,
                    "cabin": cabin,
                    "passengers": (compact(passengers.model_dump()) if passengers else None),
                    "maxStops": maxStops,
                    "airlines": airlines,
                    "alliances": alliances,
                    "maxPrice": maxPrice,
                    "sortBy": sortBy,
                    "sortOrder": sortOrder,
                    "country": country,
                }
            )
            page = await run_search("flights", nextToken, body)
            return ok(with_paging_hint(flights["name"], page))
        except Exception as error:  # noqa: BLE001
            return fail(error)

    # ── Hotels ───────────────────────────────────────────────────────────────
    hotels = spec.tool("ktemia_search_hotels")

    @app.tool(
        name=hotels["name"],
        title=hotels["title"],
        description=spec.describe(
            hotels["name"],
            ["askDoNotGuessNote", "tokenLifetimeNote", "quotaNote", "searchNotBookNote"],
        ),
        annotations=READ_ONLY_ANNOTATIONS,
    )
    async def ktemia_search_hotels(
        nextToken: Annotated[str | None, _param(hotels["name"], "nextToken")] = None,
        location: Annotated[IdLike | None, _param(hotels["name"], "location")] = None,
        checkin: Annotated[str | None, _param(hotels["name"], "checkin")] = None,
        checkout: Annotated[str | None, _param(hotels["name"], "checkout")] = None,
        adults: Annotated[int | None, _bounded(hotels["name"], "adults", ge=1, le=30)] = None,
        rooms: Annotated[int | None, _bounded(hotels["name"], "rooms", ge=1, le=8)] = None,
        childAges: Annotated[
            list[Annotated[int, Field(ge=0, le=17)]] | None,
            _param(hotels["name"], "childAges"),
        ] = None,
        minStars: Annotated[float | None, _bounded(hotels["name"], "minStars", ge=1, le=5)] = None,
        minRating: Annotated[float | None, _param(hotels["name"], "minRating")] = None,
        maxPrice: Annotated[float | None, _bounded(hotels["name"], "maxPrice", gt=0)] = None,
        freeCancellation: Annotated[bool | None, _param(hotels["name"], "freeCancellation")] = None,
        amenities: Annotated[list[str] | None, _param(hotels["name"], "amenities")] = None,
        providers: Annotated[list[str] | None, _param(hotels["name"], "providers")] = None,
        sortBy: Annotated[HotelSortBy | None, _param(hotels["name"], "sortBy")] = None,
        sortOrder: Annotated[SortOrder | None, _param(hotels["name"], "sortOrder")] = None,
        country: Annotated[Country | None, _param(hotels["name"], "country")] = None,
    ) -> CallToolResult:
        try:
            if not nextToken:
                present = {
                    "location": location,
                    "checkin": checkin,
                    "checkout": checkout,
                }
                missing = [name for name, value in present.items() if not value]
                if missing:
                    raise KtemiaError(
                        code="MISSING_FIELD",
                        status=400,
                        param=missing[0],
                        message=(
                            f"A hotel search needs {', '.join(missing)}. Ask "
                            "the user rather than guessing. The location must "
                            "be an id from ktemia_lookup with "
                            "kind='hotelLocation', not a city name."
                        ),
                    )

            body = compact(
                {
                    "location": id_string(location) if location is not None else None,
                    "checkin": checkin,
                    "checkout": checkout,
                    "adults": adults,
                    "rooms": rooms,
                    "childAges": childAges,
                    "minStars": minStars,
                    "minRating": minRating,
                    "maxPrice": maxPrice,
                    "freeCancellation": freeCancellation,
                    "amenities": amenities,
                    "providers": providers,
                    "sortBy": sortBy,
                    "sortOrder": sortOrder,
                    "country": country,
                }
            )
            page = await run_search("hotels", nextToken, body)
            return ok(with_paging_hint(hotels["name"], page))
        except Exception as error:  # noqa: BLE001
            return fail(error)

    # ── Cars ─────────────────────────────────────────────────────────────────
    cars = spec.tool("ktemia_search_cars")

    @app.tool(
        name=cars["name"],
        title=cars["title"],
        description=spec.describe(
            cars["name"],
            ["askDoNotGuessNote", "tokenLifetimeNote", "quotaNote", "searchNotBookNote"],
        ),
        annotations=READ_ONLY_ANNOTATIONS,
    )
    async def ktemia_search_cars(
        nextToken: Annotated[str | None, _param(cars["name"], "nextToken")] = None,
        pickupLocation: Annotated[IdLike | None, _param(cars["name"], "pickupLocation")] = None,
        dropoffLocation: Annotated[IdLike | None, _param(cars["name"], "dropoffLocation")] = None,
        pickupDate: Annotated[str | None, _param(cars["name"], "pickupDate")] = None,
        dropoffDate: Annotated[str | None, _param(cars["name"], "dropoffDate")] = None,
        pickupTime: Annotated[str | None, _param(cars["name"], "pickupTime")] = None,
        dropoffTime: Annotated[str | None, _param(cars["name"], "dropoffTime")] = None,
        driverAge: Annotated[int | None, _bounded(cars["name"], "driverAge", ge=18, le=99)] = None,
        carClass: Annotated[list[CarClass] | None, _param(cars["name"], "carClass")] = None,
        transmission: Annotated[Transmission | None, _param(cars["name"], "transmission")] = None,
        maxPrice: Annotated[float | None, _bounded(cars["name"], "maxPrice", gt=0)] = None,
        providers: Annotated[list[str] | None, _param(cars["name"], "providers")] = None,
        agencies: Annotated[list[str] | None, _param(cars["name"], "agencies")] = None,
        sortBy: Annotated[CarSortBy | None, _param(cars["name"], "sortBy")] = None,
        sortOrder: Annotated[SortOrder | None, _param(cars["name"], "sortOrder")] = None,
        priceMode: Annotated[PriceMode | None, _param(cars["name"], "priceMode")] = None,
        country: Annotated[Country | None, _param(cars["name"], "country")] = None,
    ) -> CallToolResult:
        try:
            if not nextToken:
                present = {
                    "pickupLocation": pickupLocation,
                    "pickupDate": pickupDate,
                    "dropoffDate": dropoffDate,
                }
                missing = [name for name, value in present.items() if not value]
                if missing:
                    raise KtemiaError(
                        code="MISSING_FIELD",
                        status=400,
                        param=missing[0],
                        message=(
                            f"A car search needs {', '.join(missing)}. Ask the "
                            "user rather than guessing. The pickup location "
                            "must be an id from ktemia_lookup with "
                            "kind='carLocation'."
                        ),
                    )

            body = compact(
                {
                    "pickupLocation": (
                        id_string(pickupLocation) if pickupLocation is not None else None
                    ),
                    "dropoffLocation": (
                        id_string(dropoffLocation) if dropoffLocation is not None else None
                    ),
                    "pickupDate": pickupDate,
                    "dropoffDate": dropoffDate,
                    "pickupTime": pickupTime,
                    "dropoffTime": dropoffTime,
                    "driverAge": driverAge,
                    "carClass": carClass,
                    "transmission": transmission,
                    "maxPrice": maxPrice,
                    "providers": providers,
                    "agencies": agencies,
                    "sortBy": sortBy,
                    "sortOrder": sortOrder,
                    "priceMode": priceMode,
                    "country": country,
                }
            )
            page = await run_search("cars", nextToken, body)
            return ok(with_paging_hint(cars["name"], page))
        except Exception as error:  # noqa: BLE001
            return fail(error)

    # ── Details ──────────────────────────────────────────────────────────────
    details = spec.tool("ktemia_get_details")

    @app.tool(
        name=details["name"],
        title=details["title"],
        description=spec.describe(
            details["name"], ["tokenLifetimeNote", "quotaNote", "searchNotBookNote"]
        ),
        annotations=READ_ONLY_ANNOTATIONS,
    )
    async def ktemia_get_details(
        vertical: Annotated[Vertical, _required(details["name"], "vertical")],
        token: Annotated[IdLike, _required(details["name"], "token")],
        resultId: Annotated[IdLike, _required(details["name"], "resultId")],
    ) -> CallToolResult:
        try:
            data = await get_client().get(
                f"/{vertical}/details",
                {"token": id_string(token), "resultId": id_string(resultId)},
            )
            return ok({"vertical": vertical, **data})
        except Exception as error:  # noqa: BLE001
            return fail(error)

    # ── Hotel reviews ────────────────────────────────────────────────────────
    reviews = spec.tool("ktemia_get_hotel_reviews")

    @app.tool(
        name=reviews["name"],
        title=reviews["title"],
        description=spec.describe(reviews["name"], ["quotaNote"]),
        annotations=READ_ONLY_ANNOTATIONS,
    )
    async def ktemia_get_hotel_reviews(
        hotelId: Annotated[IdLike, _required(reviews["name"], "hotelId")],
        sortBy: Annotated[ReviewSort | None, _param(reviews["name"], "sortBy")] = None,
        travelerTypes: Annotated[list[str] | None, _param(reviews["name"], "travelerTypes")] = None,
        months: Annotated[int | None, _bounded(reviews["name"], "months", ge=1, le=120)] = None,
        sources: Annotated[list[str] | None, _param(reviews["name"], "sources")] = None,
        search: Annotated[str | None, _param(reviews["name"], "search")] = None,
        page: Annotated[int | None, _bounded(reviews["name"], "page", ge=1, le=1000)] = None,
    ) -> CallToolResult:
        try:
            data = await get_client().get(
                "/hotels/reviews",
                compact(
                    {
                        "hotelId": id_string(hotelId),
                        "sortBy": sortBy,
                        "travelerTypes": travelerTypes,
                        "months": months,
                        "sources": sources,
                        "search": search,
                        "page": page,
                    }
                ),
            )
            return ok(data)
        except Exception as error:  # noqa: BLE001
            return fail(error)

    return app
