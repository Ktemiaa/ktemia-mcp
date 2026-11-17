/**
 * Tool registration and argument handling.
 *
 * Drives a real `McpServer` through an in-memory client pair, so these
 * exercise the same registration and validation path a host does - including
 * zod coercion, which is where the hotel and car searches broke in testing.
 */

import { test, describe, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../dist/server.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records every upstream request so a test can assert none was made. */
interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function stubUpstream(response: unknown = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: URL, init: RequestInit = {}) => {
    calls.push({
      url: url.toString(),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = url.toString();
    // A search must answer with a token, or the tool reports an upstream fault
    // before it ever reads a page.
    const payload = path.includes("/search")
      ? { searchToken: "tok_stub", expiresIn: 3600 }
      : response;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

async function connect() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer({ apiKey: "test_key" });
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

/** The seven tools, as the README and the shared spec promise them. */
const EXPECTED_TOOLS = [
  "ktemia_key_status",
  "ktemia_lookup",
  "ktemia_search_flights",
  "ktemia_search_hotels",
  "ktemia_search_cars",
  "ktemia_get_details",
  "ktemia_get_hotel_reviews",
];

describe("tool registration", () => {
  test("exactly the seven documented tools are exposed", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...EXPECTED_TOOLS].sort(),
      "a tool added or renamed without updating the docs is a contract break",
    );
  });

  test("every tool name is spec-legal", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.match(
        tool.name,
        /^[A-Za-z0-9_.-]{1,128}$/,
        `${tool.name} uses characters the spec does not allow`,
      );
      assert.ok(
        tool.name.startsWith("ktemia_"),
        `${tool.name} must be prefixed: hosts aggregating several servers ` +
          "collide on generic names and cannot use serverInfo to disambiguate",
      );
    }
  });

  test("every tool is annotated read-only and non-destructive", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    }
  });

  test("every tool carries a description and a title", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      // The descriptions are the product: they are what stops an agent
      // guessing a city or retrying a dead quota.
      assert.ok(
        (tool.description ?? "").length > 80,
        `${tool.name} has a thin description`,
      );
      assert.ok(tool.title, `${tool.name} has no title`);
    }
  });

  test("the parameterless tool declares the recommended empty schema", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const keyStatus = tools.find((t) => t.name === "ktemia_key_status");
    assert.equal(keyStatus?.inputSchema.type, "object");
    assert.equal(keyStatus?.inputSchema.additionalProperties, false);
  });

  test("searches advertise the quota cost and the ask-first rule", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const name of [
      "ktemia_search_flights",
      "ktemia_search_hotels",
      "ktemia_search_cars",
    ]) {
      const tool = tools.find((t) => t.name === name);
      assert.match(tool?.description ?? "", /quota/i, `${name} must state the cost`);
      assert.match(
        tool?.description ?? "",
        /ask the user/i,
        `${name} must tell the model to ask rather than guess`,
      );
      assert.match(
        tool?.description ?? "",
        /expire/i,
        `${name} must state the token lifetime`,
      );
    }
  });

  test("key_status advertises that it is free", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "ktemia_key_status");
    assert.match(tool?.description ?? "", /free|does not count/i);
  });
});

describe("missing arguments are refused without spending quota", () => {
  test("a flight search with no trip details makes no upstream call", async () => {
    const calls = stubUpstream();
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_flights",
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.equal(
      calls.length,
      0,
      "guessing would have cost a request; the guard must fire locally",
    );
    const text = String((result.content as { text: string }[])[0]?.text);
    assert.match(text, /MISSING_FIELD/);
    assert.match(text, /guessed route spends quota/i);
  });

  test("a flat trip and a legs list together is a conflict, not a guess", async () => {
    const calls = stubUpstream();
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_flights",
      arguments: {
        origin: "LHR",
        destination: "JFK",
        departureDate: "2027-01-15",
        legs: [{ origin: "LHR", destination: "CDG", date: "2027-01-15" }],
      },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(
      String((result.content as { text: string }[])[0]?.text),
      /TRIP_CONFLICT/,
    );
  });

  test("a hotel search without dates names the missing field", async () => {
    const calls = stubUpstream();
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_hotels",
      arguments: { location: "29230" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    const text = String((result.content as { text: string }[])[0]?.text);
    assert.match(text, /checkin/);
    assert.match(text, /checkout/);
  });

  test("a car search without dates is refused locally", async () => {
    const calls = stubUpstream();
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_cars",
      arguments: { pickupLocation: "22863" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  test("errors never travel in structuredContent", async () => {
    // structuredContent is validated against outputSchema, so an error payload
    // there makes a validating host discard the whole result and the model sees
    // a schema complaint instead of the actual problem.
    stubUpstream();
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_flights",
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  });
});

describe("numeric identifiers are accepted", () => {
  // Regression: Ktemia location ids are numeric strings ("29230"), and a model
  // copying one from a lookup result often emits it unquoted. A bare
  // z.string() rejected those with an error the model could not act on.
  const numericCases: Array<{ tool: string; args: Record<string, unknown> }> = [
    {
      tool: "ktemia_search_hotels",
      args: { location: 29230, checkin: "2027-01-15", checkout: "2027-01-17" },
    },
    {
      tool: "ktemia_search_cars",
      args: {
        pickupLocation: 22863,
        pickupDate: "2027-01-15",
        dropoffDate: "2027-01-18",
      },
    },
    { tool: "ktemia_get_hotel_reviews", args: { hotelId: 5782 } },
    {
      tool: "ktemia_get_details",
      args: { vertical: "hotels", token: "tok", resultId: 12345 },
    },
  ];

  for (const { tool, args } of numericCases) {
    test(`${tool} accepts an unquoted id`, async () => {
      const calls = stubUpstream();
      const { client } = await connect();

      const result = await client.callTool({ name: tool, arguments: args });

      assert.notEqual(
        result.isError,
        true,
        `${tool} rejected a numeric id: ${JSON.stringify(
          (result.content as { text: string }[])?.[0]?.text,
        )}`,
      );
      assert.ok(calls.length > 0, "the request should have reached the API");
    });
  }

  test("a malformed date is still rejected", async () => {
    // Coercion must not spread to dates, where a wrong type means a wrong
    // question rather than a JSON round-trip artefact.
    //
    // Schema failures come back as a tool error result rather than a thrown
    // rejection, so the model sees them and can correct the argument.
    stubUpstream();
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_hotels",
      arguments: { location: "29230", checkin: 20270115, checkout: true },
    });

    assert.equal(result.isError, true);
    const text = String((result.content as { text: string }[])[0]?.text);
    assert.match(text, /checkin/);
    assert.match(text, /expected string/i);
  });
});

describe("paging", () => {
  test("a new search starts the search then reads page one", async () => {
    const calls = stubUpstream();
    const { client } = await connect();

    await client.callTool({
      name: "ktemia_search_flights",
      arguments: {
        origin: "LHR",
        destination: "JFK",
        departureDate: "2027-01-15",
      },
    });

    assert.equal(calls.length, 2, "one POST to start, one GET to read");
    assert.equal(calls[0]?.method, "POST");
    assert.match(calls[0]?.url ?? "", /\/flights\/search$/);
    assert.equal(calls[1]?.method, "GET");
    assert.match(calls[1]?.url ?? "", /\/flights\/results\?token=tok_stub/);
  });

  test("nextToken reads a page directly, without starting a new search", async () => {
    const calls = stubUpstream();
    const { client } = await connect();

    await client.callTool({
      name: "ktemia_search_flights",
      arguments: { nextToken: "page2tok" },
    });

    assert.equal(calls.length, 1, "paging must not re-run the search");
    assert.equal(calls[0]?.method, "GET");
    assert.match(calls[0]?.url ?? "", /token=page2tok/);
  });

  test("a paging hint tells the model how to continue", async () => {
    globalThis.fetch = (async (url: URL) => {
      const payload = url.toString().includes("/search")
        ? { searchToken: "t", expiresIn: 3600 }
        : { page: 1, hasMore: true, nextToken: "next_abc", flights: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_flights",
      arguments: { nextToken: "t" },
    });

    const structured = result.structuredContent as { pagingHint?: string };
    assert.match(structured.pagingHint ?? "", /nextToken only/);
  });

  test("the last page says so", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ page: 3, hasMore: false, flights: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_flights",
      arguments: { nextToken: "t" },
    });

    const structured = result.structuredContent as { pagingHint?: string };
    assert.match(structured.pagingHint ?? "", /last page/);
  });

  test("a search that returns no token is reported, not silently paged", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ expiresIn: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const { client } = await connect();

    const result = await client.callTool({
      name: "ktemia_search_flights",
      arguments: {
        origin: "LHR",
        destination: "JFK",
        departureDate: "2027-01-15",
      },
    });

    assert.equal(result.isError, true);
  });
});

describe("lookup routing", () => {
  const routes: Array<[string, RegExp]> = [
    ["airport", /\/flights\/airports/],
    ["airline", /\/flights\/airlines/],
    ["hotelLocation", /\/hotels\/locations/],
    ["carLocation", /\/cars\/locations/],
  ];

  for (const [kind, pattern] of routes) {
    test(`kind=${kind} hits the right endpoint`, async () => {
      const calls = stubUpstream({ query: "x", results: [] });
      const { client } = await connect();

      await client.callTool({
        name: "ktemia_lookup",
        arguments: { kind, query: "London" },
      });

      assert.match(calls[0]?.url ?? "", pattern);
    });
  }

  test("the location type is sent only to the car endpoint", async () => {
    // The other lookup endpoints reject unrecognised fields outright.
    const calls = stubUpstream({ query: "x", results: [] });
    const { client } = await connect();

    await client.callTool({
      name: "ktemia_lookup",
      arguments: { kind: "airport", query: "London", type: "airport" },
    });
    assert.doesNotMatch(calls[0]?.url ?? "", /type=/);

    await client.callTool({
      name: "ktemia_lookup",
      arguments: { kind: "carLocation", query: "Austin", type: "airport" },
    });
    assert.match(calls[1]?.url ?? "", /type=airport/);
  });
});

describe("details routing", () => {
  for (const vertical of ["flights", "hotels", "cars"]) {
    test(`vertical=${vertical} hits its own details endpoint`, async () => {
      const calls = stubUpstream({ resultId: "r" });
      const { client } = await connect();

      await client.callTool({
        name: "ktemia_get_details",
        arguments: { vertical, token: "tok", resultId: "r1" },
      });

      assert.match(calls[0]?.url ?? "", new RegExp(`/${vertical}/details`));
      assert.match(calls[0]?.url ?? "", /resultId=r1/);
    });
  }
});
