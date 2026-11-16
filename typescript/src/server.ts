/**
 * Server factory.
 *
 * Exported separately from the stdio entry point so the hosted HTTP transport
 * can reuse it later with a per-request credential.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { KtemiaClient, type ClientOptions, VERSION } from "./client.js";
import { registerAccountTools } from "./tools/account.js";
import { registerSearchTools } from "./tools/search.js";
import { registerDetailTools } from "./tools/details.js";

/**
 * Builds a server with all seven tools registered.
 *
 * `serveStdio` calls this more than once - including for a `server/discover`
 * probe whose instance is discarded - so it must return a fresh server every
 * time rather than a shared singleton.
 *
 * The client is created lazily on first use. Constructing it eagerly would
 * throw for a missing API key before any tool ran, which turns a fixable
 * configuration problem into a server that will not start and reports nothing
 * useful to the user.
 */
export function createServer(options: ClientOptions = {}): McpServer {
  const server = new McpServer(
    { name: "ktemia", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Ktemia searches and compares flights, hotels, and rental cars across " +
        "100+ providers. It does not book: results carry links that hand off " +
        "to the provider's own site.\n\n" +
        "Working rules:\n" +
        "- Ask for missing trip details instead of guessing. A guessed city " +
        "or date spends quota and answers the wrong question.\n" +
        "- Hotel and car searches need a location id from ktemia_lookup, not " +
        "a free-text place name.\n" +
        "- Every call except ktemia_key_status spends one request from the " +
        "account's monthly quota, and a search costs at least two. Check the " +
        "budget with ktemia_key_status, which is free, before a long run.\n" +
        "- On QUOTA_EXCEEDED, stop and tell the user; retrying cannot help. " +
        "On RATE_LIMIT_EXCEEDED, wait and retry.\n" +
        "- Prices and availability come from live providers and move. Quote " +
        "them as of now, not as fixed facts.",
    },
  );

  let client: KtemiaClient | undefined;
  const getClient = () => (client ??= new KtemiaClient(options));

  registerAccountTools(server, getClient);
  registerSearchTools(server, getClient);
  registerDetailTools(server, getClient);

  return server;
}
