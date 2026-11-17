/**
 * The three search tools.
 *
 * Each one folds the upstream two-step (POST to start, GET to read a page)
 * into a single tool call, and handles paging through the same tool: pass
 * `nextToken` alone to read the following page.
 *
 * Prose comes from `spec/tools.json`; only the zod schemas are local.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { KtemiaClient, KtemiaError } from "../client.js";
import { describe, param, tool, values } from "../spec.js";
import { compact, fail, idString, ok } from "../result.js";

/** A page of results, as every vertical returns it. */
interface ResultsPage {
  page: number;
  hasMore: boolean;
  nextToken?: string;
  totalResults?: number;
  expiresIn?: number;
  [key: string]: unknown;
}

/**
 * Starts a search then reads its first page, or reads a later page directly.
 *
 * Two upstream requests for a new search, one for a subsequent page. The model
 * sees a single call either way.
 */
async function runSearch(
  client: KtemiaClient,
  vertical: "flights" | "hotels" | "cars",
  nextToken: string | undefined,
  body: Record<string, unknown>,
): Promise<ResultsPage> {
  let token = nextToken;
  if (!token) {
    const started = await client.post<{ searchToken?: string }>(
      `/${vertical}/search`,
      body,
    );
    if (!started.searchToken) {
      throw new KtemiaError({
        code: "UPSTREAM_ERROR",
        status: 502,
        retryable: true,
        message: `Ktemia started a ${vertical} search but returned no search token.`,
      });
    }
    token = started.searchToken;
  }
  return client.get<ResultsPage>(`/${vertical}/results`, { token });
}

/**
 * Adds the paging hint the model needs to decide what to do next.
 *
 * `nextToken` on its own is easy to overlook, so the instruction is spelled
 * out in the payload rather than left implicit in the tool description.
 */
function withPagingHint(
  toolName: string,
  page: ResultsPage,
): Record<string, unknown> {
  return {
    ...page,
    pagingHint: page.nextToken
      ? `More results are available. To read the next page, call ${toolName} with nextToken only.`
      : "This is the last page of results.",
  };
}

export function registerSearchTools(
  server: McpServer,
  getClient: () => KtemiaClient,
) {
  // ── Flights ──────────────────────────────────────────────────────────────
  const flights = tool("ktemia_search_flights");
  server.registerTool(
    flights.name,
    {
      title: flights.title,
      description: describe(flights.name, [
        "askDoNotGuessNote",
        "tokenLifetimeNote",
        "quotaNote",
        "searchNotBookNote",
      ]),
      inputSchema: z.object({
        nextToken: z
          .string()
          .optional()
          .describe(param(flights.name, "nextToken")),
        origin: z.string().optional().describe(param(flights.name, "origin")),
        destination: z
          .string()
          .optional()
          .describe(param(flights.name, "destination")),
        departureDate: z
          .string()
          .optional()
          .describe(param(flights.name, "departureDate")),
        returnDate: z
          .string()
          .optional()
          .describe(param(flights.name, "returnDate")),
        legs: z
          .array(
            z.object({
              origin: z.string(),
              destination: z.string(),
              date: z.string(),
            }),
          )
          .optional()
          .describe(param(flights.name, "legs")),
        cabin: z
          .enum(values("cabin"))
          .optional()
          .describe(param(flights.name, "cabin")),
        passengers: z
          .object({
            adults: z.number().int().min(0).max(9).optional(),
            seniors: z.number().int().min(0).max(9).optional(),
            students: z.number().int().min(0).max(9).optional(),
            youths: z.number().int().min(0).max(9).optional(),
            children: z.number().int().min(0).max(9).optional(),
            infantsInSeat: z.number().int().min(0).max(9).optional(),
            infantsOnLap: z.number().int().min(0).max(9).optional(),
          })
          .optional()
          .describe(param(flights.name, "passengers")),
        maxStops: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe(param(flights.name, "maxStops")),
        airlines: z
          .array(z.string())
          .optional()
          .describe(param(flights.name, "airlines")),
        alliances: z
          .array(z.enum(values("alliance")))
          .optional()
          .describe(param(flights.name, "alliances")),
        maxPrice: z
          .number()
          .positive()
          .optional()
          .describe(param(flights.name, "maxPrice")),
        sortBy: z
          .enum(values("flightSortBy"))
          .optional()
          .describe(param(flights.name, "sortBy")),
        sortOrder: z
          .enum(values("sortOrder"))
          .optional()
          .describe(param(flights.name, "sortOrder")),
        country: z
          .string()
          .length(2)
          .optional()
          .describe(param(flights.name, "country")),
      }),
      annotations: flights.annotations,
    },
    async (args: Record<string, unknown>) => {
      try {
        const { nextToken, ...rest } = args as {
          nextToken?: string;
          origin?: string;
          destination?: string;
          departureDate?: string;
          legs?: unknown[];
        };

        if (!nextToken) {
          const flat = rest.origin || rest.destination || rest.departureDate;
          const multi = Array.isArray(rest.legs) && rest.legs.length > 0;
          if (!flat && !multi) {
            throw new KtemiaError({
              code: "MISSING_FIELD",
              status: 400,
              message:
                "A flight search needs either origin, destination and " +
                "departureDate, or a legs list for multi-city. Ask the user " +
                "for whichever is missing instead of guessing: a guessed " +
                "route spends quota and returns the wrong trip.",
            });
          }
          if (flat && multi) {
            throw new KtemiaError({
              code: "TRIP_CONFLICT",
              status: 400,
              message:
                "Pass either origin/destination/departureDate or legs, not " +
                "both. Use legs only for multi-city itineraries.",
            });
          }
        }

        const page = await runSearch(
          getClient(),
          "flights",
          nextToken,
          compact(rest as Record<string, unknown>),
        );
        return ok(withPagingHint(flights.name, page));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ── Hotels ───────────────────────────────────────────────────────────────
  const hotels = tool("ktemia_search_hotels");
  server.registerTool(
    hotels.name,
    {
      title: hotels.title,
      description: describe(hotels.name, [
        "askDoNotGuessNote",
        "tokenLifetimeNote",
        "quotaNote",
        "searchNotBookNote",
      ]),
      inputSchema: z.object({
        nextToken: z
          .string()
          .optional()
          .describe(param(hotels.name, "nextToken")),
        location: idString()
          .optional()
          .describe(param(hotels.name, "location")),
        checkin: z.string().optional().describe(param(hotels.name, "checkin")),
        checkout: z
          .string()
          .optional()
          .describe(param(hotels.name, "checkout")),
        adults: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe(param(hotels.name, "adults")),
        rooms: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe(param(hotels.name, "rooms")),
        childAges: z
          .array(z.number().int().min(0).max(17))
          .optional()
          .describe(param(hotels.name, "childAges")),
        minStars: z
          .number()
          .min(1)
          .max(5)
          .optional()
          .describe(param(hotels.name, "minStars")),
        minRating: z
          .number()
          .optional()
          .describe(param(hotels.name, "minRating")),
        maxPrice: z
          .number()
          .positive()
          .optional()
          .describe(param(hotels.name, "maxPrice")),
        freeCancellation: z
          .boolean()
          .optional()
          .describe(param(hotels.name, "freeCancellation")),
        amenities: z
          .array(z.string())
          .optional()
          .describe(param(hotels.name, "amenities")),
        providers: z
          .array(z.string())
          .optional()
          .describe(param(hotels.name, "providers")),
        sortBy: z
          .enum(values("hotelSortBy"))
          .optional()
          .describe(param(hotels.name, "sortBy")),
        sortOrder: z
          .enum(values("sortOrder"))
          .optional()
          .describe(param(hotels.name, "sortOrder")),
        country: z
          .string()
          .length(2)
          .optional()
          .describe(param(hotels.name, "country")),
      }),
      annotations: hotels.annotations,
    },
    async (args: Record<string, unknown>) => {
      try {
        const { nextToken, ...rest } = args as {
          nextToken?: string;
          location?: string;
          checkin?: string;
          checkout?: string;
        };

        if (!nextToken) {
          const missing = (["location", "checkin", "checkout"] as const).filter(
            (field) => !rest[field],
          );
          if (missing.length > 0) {
            throw new KtemiaError({
              code: "MISSING_FIELD",
              status: 400,
              param: missing[0],
              message:
                `A hotel search needs ${missing.join(", ")}. Ask the user ` +
                "rather than guessing. The location must be an id from " +
                "ktemia_lookup with kind='hotelLocation', not a city name.",
            });
          }
        }

        const page = await runSearch(
          getClient(),
          "hotels",
          nextToken,
          compact(rest as Record<string, unknown>),
        );
        return ok(withPagingHint(hotels.name, page));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ── Cars ─────────────────────────────────────────────────────────────────
  const cars = tool("ktemia_search_cars");
  server.registerTool(
    cars.name,
    {
      title: cars.title,
      description: describe(cars.name, [
        "askDoNotGuessNote",
        "tokenLifetimeNote",
        "quotaNote",
        "searchNotBookNote",
      ]),
      inputSchema: z.object({
        nextToken: z
          .string()
          .optional()
          .describe(param(cars.name, "nextToken")),
        pickupLocation: idString()
          .optional()
          .describe(param(cars.name, "pickupLocation")),
        dropoffLocation: idString()
          .optional()
          .describe(param(cars.name, "dropoffLocation")),
        pickupDate: z
          .string()
          .optional()
          .describe(param(cars.name, "pickupDate")),
        dropoffDate: z
          .string()
          .optional()
          .describe(param(cars.name, "dropoffDate")),
        pickupTime: z
          .string()
          .optional()
          .describe(param(cars.name, "pickupTime")),
        dropoffTime: z
          .string()
          .optional()
          .describe(param(cars.name, "dropoffTime")),
        driverAge: z
          .number()
          .int()
          .min(18)
          .max(99)
          .optional()
          .describe(param(cars.name, "driverAge")),
        carClass: z
          .enum(values("carClass"))
          .optional()
          .describe(param(cars.name, "carClass")),
        transmission: z
          .enum(values("transmission"))
          .optional()
          .describe(param(cars.name, "transmission")),
        maxPrice: z
          .number()
          .positive()
          .optional()
          .describe(param(cars.name, "maxPrice")),
        providers: z
          .array(z.string())
          .optional()
          .describe(param(cars.name, "providers")),
        agencies: z
          .array(z.string())
          .optional()
          .describe(param(cars.name, "agencies")),
        sortBy: z
          .enum(values("carSortBy"))
          .optional()
          .describe(param(cars.name, "sortBy")),
        sortOrder: z
          .enum(values("sortOrder"))
          .optional()
          .describe(param(cars.name, "sortOrder")),
        priceMode: z
          .enum(values("priceMode"))
          .optional()
          .describe(param(cars.name, "priceMode")),
        country: z
          .string()
          .length(2)
          .optional()
          .describe(param(cars.name, "country")),
      }),
      annotations: cars.annotations,
    },
    async (args: Record<string, unknown>) => {
      try {
        const { nextToken, ...rest } = args as {
          nextToken?: string;
          pickupLocation?: string;
          pickupDate?: string;
          dropoffDate?: string;
        };

        if (!nextToken) {
          const missing = (
            ["pickupLocation", "pickupDate", "dropoffDate"] as const
          ).filter((field) => !rest[field]);
          if (missing.length > 0) {
            throw new KtemiaError({
              code: "MISSING_FIELD",
              status: 400,
              param: missing[0],
              message:
                `A car search needs ${missing.join(", ")}. Ask the user ` +
                "rather than guessing. The pickup location must be an id " +
                "from ktemia_lookup with kind='carLocation'.",
            });
          }
        }

        const page = await runSearch(
          getClient(),
          "cars",
          nextToken,
          compact(rest as Record<string, unknown>),
        );
        return ok(withPagingHint(cars.name, page));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
