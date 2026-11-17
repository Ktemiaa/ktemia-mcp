/**
 * Live smoke test against the real API.
 *
 * Opt-in: every test skips unless `KTEMIA_API_KEY` is set, so `npm test` stays
 * offline and deterministic for contributors and CI. Run it with
 * `npm run test:live`.
 *
 * These calls spend real quota - roughly a dozen requests for a full pass,
 * which fits inside a Free plan's monthly 100 with room left over. They also
 * hit live provider data, so assertions check shape and plausibility rather
 * than exact prices or counts, which move hour to hour.
 *
 * The point is to catch upstream contract drift: a renamed field or a changed
 * token shape would pass every stubbed test and break every real agent.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { KtemiaClient } from "../dist/client.js";

const hasKey = Boolean(process.env.KTEMIA_API_KEY);
const skip = hasKey
  ? false
  : "set KTEMIA_API_KEY to run the live smoke test (spends real quota)";

/** A date comfortably in the future, so searches are not empty. */
function futureDate(daysAhead: number): string {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  return date.toISOString().slice(0, 10);
}

const OUT = futureDate(60);
const BACK = futureDate(63);

let client: KtemiaClient;
before(() => {
  if (hasKey) client = new KtemiaClient();
});

describe("live: quota inspection", { skip }, () => {
  test("GET /key reports a plan and is not metered", async () => {
    const before = (await client.get("/key")) as {
      plan: { name: string; monthlyQuota: number };
      usage: { used: number; remaining: number; scope: string };
      metered: boolean;
    };

    assert.ok(before.plan.name, "a key must report its plan");
    assert.equal(before.metered, false);
    assert.ok(["account", "key"].includes(before.usage.scope));

    // The whole point of the endpoint: checking the budget must not spend it.
    const after = (await client.get("/key")) as {
      usage: { used: number };
    };
    assert.equal(
      after.usage.used,
      before.usage.used,
      "reading /key twice changed the counter - the endpoint is metered after all",
    );
  });
});

describe("live: lookup", { skip }, () => {
  test("airports resolve a city to codes", async () => {
    const data = (await client.get("/flights/airports", {
      query: "London",
    })) as { airports?: Array<{ code: string; name: string }> };

    const codes = (data.airports ?? []).map((a) => a.code);
    assert.ok(codes.length > 0, "London returned no airports");
    assert.ok(
      codes.includes("LHR"),
      `expected Heathrow among ${codes.join(", ")}`,
    );
    // The field name the tool descriptions tell the model to use.
    assert.ok(data.airports?.[0]?.code, "results must carry a code field");
  });

  test("hotel locations expose locationId", async () => {
    const data = (await client.get("/hotels/locations", {
      query: "London",
    })) as { locations?: Array<Record<string, unknown>> };

    const first = data.locations?.[0];
    assert.ok(first, "London returned no hotel locations");
    assert.ok(
      first.locationId !== undefined,
      "hotel locations must expose locationId - the tool prose names that field",
    );
  });

  test("car locations expose locationId", async () => {
    const data = (await client.get("/cars/locations", {
      query: "Austin",
    })) as { locations?: Array<Record<string, unknown>> };

    assert.ok(data.locations?.[0]?.locationId !== undefined);
  });
});

describe("live: flight search and paging", { skip }, () => {
  test("a search pages and details carry booking links", async () => {
    const started = (await client.post("/flights/search", {
      origin: "LHR",
      destination: "JFK",
      departureDate: OUT,
    })) as { searchToken: string; expiresIn: number };

    assert.ok(started.searchToken, "no search token returned");
    assert.ok(
      started.expiresIn > 0,
      "the token lifetime is quoted in tool descriptions and must be real",
    );

    const page1 = (await client.get("/flights/results", {
      token: started.searchToken,
    })) as {
      page: number;
      hasMore: boolean;
      nextToken?: string;
      flights: Array<{ id: string }>;
    };

    assert.equal(page1.page, 1);
    assert.ok(page1.flights.length > 0, "no flights on page one");
    assert.ok(page1.flights[0]?.id, "results must carry an id for details");

    if (page1.hasMore) {
      assert.ok(page1.nextToken, "hasMore was true but no nextToken was given");

      const page2 = (await client.get("/flights/results", {
        token: page1.nextToken,
      })) as { page: number; flights: Array<{ id: string }> };

      assert.equal(page2.page, 2);
      const firstIds = new Set(page1.flights.map((f) => f.id));
      const overlap = page2.flights.filter((f) => firstIds.has(f.id));
      assert.equal(
        overlap.length,
        0,
        "page two repeated results from page one",
      );
    }

    const details = (await client.get("/flights/details", {
      token: started.searchToken,
      resultId: page1.flights[0]!.id,
    })) as {
      bookingOptions: Array<{ providerUrl?: string; providerCode?: string }>;
    };

    assert.ok(
      details.bookingOptions.length > 0,
      "details returned no booking options",
    );
    const option = details.bookingOptions[0]!;
    // Booking links are the product. A rename here breaks every agent.
    assert.ok(
      option.providerUrl?.startsWith("http"),
      "booking options must carry a providerUrl",
    );
    assert.ok(option.providerCode, "booking options must carry a providerCode");
  });
});

describe("live: hotels and cars", { skip }, () => {
  test("a hotel search returns priced results", async () => {
    const locations = (await client.get("/hotels/locations", {
      query: "London",
    })) as { locations: Array<{ locationId: string; locationType?: string }> };

    const city =
      locations.locations.find((l) => l.locationType === "city") ??
      locations.locations[0]!;

    const started = (await client.post("/hotels/search", {
      location: city.locationId,
      checkin: OUT,
      checkout: BACK,
    })) as { searchToken: string };

    const page = (await client.get("/hotels/results", {
      token: started.searchToken,
    })) as { hotels: Array<{ id: string; name: string }> };

    assert.ok(page.hotels.length > 0, "no hotels returned for London");
    assert.ok(page.hotels[0]?.name, "hotels must carry a name");
    assert.ok(
      page.hotels[0]?.id !== undefined,
      "hotels must carry an id - reviews and details need it",
    );
  });

  test("a car search returns priced results", async () => {
    const locations = (await client.get("/cars/locations", {
      query: "Austin",
    })) as { locations: Array<{ locationId: string }> };

    const started = (await client.post("/cars/search", {
      pickupLocation: locations.locations[0]!.locationId,
      pickupDate: OUT,
      dropoffDate: BACK,
    })) as { searchToken: string };

    const page = (await client.get("/cars/results", {
      token: started.searchToken,
    })) as { cars: Array<Record<string, unknown>> };

    assert.ok(page.cars.length > 0, "no cars returned for Austin");
  });
});

describe("live: error contract", { skip }, () => {
  test("an expired or bogus token is refused, not silently empty", async () => {
    // The tool descriptions tell the model to start a new search when a token
    // expires, which only works if the API says so rather than returning [].
    await assert.rejects(
      () => client.get("/flights/results", { token: "obviously_not_a_token" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        return true;
      },
    );
  });

  test("a bad origin is rejected with a named code", async () => {
    try {
      await client.post("/flights/search", {
        origin: "NOTACODE",
        destination: "JFK",
        departureDate: OUT,
      });
      assert.fail("expected the search to be rejected");
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      assert.match(
        code,
        /INVALID|MISSING|UNSUPPORTED/,
        `expected a named validation code, got ${code}`,
      );
    }
  });
});
