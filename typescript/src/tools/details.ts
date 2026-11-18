/**
 * Detail tools: expanding one result, and reading a hotel's reviews.
 *
 * Prose comes from `spec/tools.json`; only the zod schemas are local.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { KtemiaClient } from "../client.js";
import { describe, param, tool, values } from "../spec.js";
import { compact, fail, idString, ok } from "../result.js";

export function registerDetailTools(
  server: McpServer,
  getClient: () => KtemiaClient,
) {
  const details = tool("ktemia_get_details");
  server.registerTool(
    details.name,
    {
      title: details.title,
      description: describe(details.name, [
        "tokenLifetimeNote",
        "quotaNote",
        "searchNotBookNote",
      ]),
      inputSchema: z.object({
        vertical: z
          .enum(values("vertical"))
          .describe(param(details.name, "vertical")),
        token: idString().describe(param(details.name, "token")),
        resultId: idString().describe(param(details.name, "resultId")),
      }),
      annotations: details.annotations,
    },
    async ({
      vertical,
      token,
      resultId,
    }: {
      vertical: string;
      token: string;
      resultId: string;
    }) => {
      try {
        const data = await getClient().get<Record<string, unknown>>(
          `/${vertical}/details`,
          { token, resultId },
        );
        return ok({ vertical, ...data });
      } catch (error) {
        return fail(error);
      }
    },
  );

  const reviews = tool("ktemia_get_hotel_reviews");
  server.registerTool(
    reviews.name,
    {
      title: reviews.title,
      description: describe(reviews.name, ["quotaNote"]),
      inputSchema: z.object({
        hotelId: idString().describe(param(reviews.name, "hotelId")),
        sortBy: z
          .enum(values("reviewSort"))
          .optional()
          .describe(param(reviews.name, "sortBy")),
        travelerTypes: z
          .array(z.enum(values("travelerType")))
          .min(1)
          .optional()
          .describe(param(reviews.name, "travelerTypes")),
        months: z
          .array(z.number().int().min(1).max(12))
          .min(1)
          .max(12)
          .optional()
          .describe(param(reviews.name, "months")),
        sources: z
          .array(z.enum(values("reviewSource")))
          .min(1)
          .optional()
          .describe(param(reviews.name, "sources")),
        search: z.string().optional().describe(param(reviews.name, "search")),
        page: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(param(reviews.name, "page")),
      }),
      annotations: reviews.annotations,
    },
    async (args: Record<string, unknown>) => {
      try {
        const data = await getClient().get<Record<string, unknown>>(
          "/hotels/reviews",
          compact(args),
        );
        return ok(data);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
