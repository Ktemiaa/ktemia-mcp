"""Parameter types shared by the tool signatures.

The TypeScript server states its constraints in zod; this states the same ones
in annotated types, so the two publish matching JSON Schema. Bounds are
deliberate: a bare ``int`` makes pydantic emit no maximum, and an unbounded
integer invites a model to pass 9999 rooms.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field

from . import spec


def _literal(enum_name: str) -> Any:
    """A ``Literal`` built from a spec enum, so values cannot drift."""
    return Literal[tuple(spec.values(enum_name))]  # type: ignore[misc]


# ── Enums, all sourced from spec/tools.json ──────────────────────────────────
Cabin: TypeAlias = _literal("cabin")
Alliance: TypeAlias = _literal("alliance")
FlightSortBy: TypeAlias = _literal("flightSortBy")
HotelSortBy: TypeAlias = _literal("hotelSortBy")
CarSortBy: TypeAlias = _literal("carSortBy")
SortOrder: TypeAlias = _literal("sortOrder")
CarClass: TypeAlias = _literal("carClass")
Transmission: TypeAlias = _literal("transmission")
PriceMode: TypeAlias = _literal("priceMode")
LookupKind: TypeAlias = _literal("lookupKind")
LocationType: TypeAlias = _literal("locationType")
Vertical: TypeAlias = _literal("vertical")
ReviewSort: TypeAlias = _literal("reviewSort")
TravelerType: TypeAlias = _literal("travelerType")
ReviewSource: TypeAlias = _literal("reviewSource")
#: A calendar month of the stay, 1 = January, matching the TypeScript schema.
StayMonth: TypeAlias = Annotated[int, Field(ge=1, le=12)]

#: An identifier that may arrive unquoted. See ``result.id_string``.
IdLike: TypeAlias = str | int | float

#: ISO 3166-1 alpha-2, matching the TypeScript ``z.string().length(2)``.
Country: TypeAlias = Annotated[str, Field(min_length=2, max_length=2)]


class Passengers(BaseModel):
    """Flight passenger counts: the three kinds kayak.com searches with.

    ``extra="forbid"`` so a misspelled count - or a retired one such as
    seniors - surfaces as a validation error rather than being silently
    dropped and searched for one adult.
    """

    model_config = ConfigDict(extra="forbid")

    adults: Annotated[int, Field(ge=0, le=9)] | None = None
    children: Annotated[int, Field(ge=0, le=9)] | None = None
    infantsOnLap: Annotated[int, Field(ge=0, le=9)] | None = None


class Leg(BaseModel):
    """One leg of a multi-city flight itinerary."""

    model_config = ConfigDict(extra="forbid")

    origin: str
    destination: str
    date: str
