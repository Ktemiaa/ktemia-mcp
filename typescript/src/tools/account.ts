/**
 * Account and reference-data tools: quota inspection and code lookup.
 *
 * All prose comes from `spec/tools.json` so the Python package says the same
 * thing. Only the zod schemas are local.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { KtemiaClient } from "../client.js";
import { describe, param, tool, values } from "../spec.js";
import { fail, ok } from "../result.js";

/** The four lookup endpoints, keyed by what the model is resolving. */
const LOOKUP_ENDPOINTS: Record<string, string> = {
  airport: "/flights/airports",
  airline: "/flights/airlines",
  hotelLocation: "/hotels/locations",
  carLocation: "/cars/locations",
};

export function registerAccountTools(
  server: McpServer,
  getClient: () => KtemiaClient,
) {
  const keyStatus = tool("ktemia_key_status");
  server.registerTool(
    keyStatus.name,
    {
      title: keyStatus.title,
      description: keyStatus.description,
      // The spec recommends this exact shape for a parameterless tool.
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        key: z.object({
          fingerprint: z.string(),
          status: z.string(),
          createdAt: z.string().nullable().optional(),
        }),
        plan: z.object({
          name: z.string(),
          monthlyQuota: z.number(),
          requestsPerSecond: z.number(),
          burst: z.number(),
        }),
        usage: z.object({
          month: z.string(),
          used: z.number(),
          remaining: z.number(),
          resetsAt: z.string(),
          scope: z.string(),
        }),
        metered: z.boolean(),
      }),
      annotations: keyStatus.annotations,
    },
    async () => {
      try {
        return ok(await getClient().get<Record<string, unknown>>("/key"));
      } catch (error) {
        return fail(error);
      }
    },
  );

  const lookup = tool("ktemia_lookup");
  server.registerTool(
    lookup.name,
    {
      title: lookup.title,
      description: describe(lookup.name, ["quotaNote"]),
      inputSchema: z.object({
        kind: z
          .enum(values("lookupKind"))
          .describe(param(lookup.name, "kind")),
        query: z.string().min(1).describe(param(lookup.name, "query")),
        type: z
          .enum(values("locationType"))
          .optional()
          .describe(param(lookup.name, "type")),
        country: z
          .string()
          .length(2)
          .optional()
          .describe(param(lookup.name, "country")),
        locale: z.string().optional().describe(param(lookup.name, "locale")),
      }),
      annotations: lookup.annotations,
    },
    async ({
      kind,
      query,
      type,
      country,
      locale,
    }: {
      kind: string;
      query: string;
      type?: string;
      country?: string;
      locale?: string;
    }) => {
      try {
        const endpoint = LOOKUP_ENDPOINTS[kind];
        if (!endpoint) {
          throw new Error(`Unknown lookup kind "${kind}".`);
        }
        const data = await getClient().get<Record<string, unknown>>(endpoint, {
          query,
          country,
          locale,
          // Only the car endpoint accepts a location type; sending it
          // elsewhere would be rejected as an unrecognised field.
          ...(kind === "carLocation" && type ? { type } : {}),
        });
        return ok({ kind, ...data });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
