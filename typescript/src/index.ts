#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * `serveStdio` negotiates the protocol revision per connection, so one build
 * serves both 2026-07-28 clients and clients that still open with the 2025-era
 * `initialize` handshake. Wiring `StdioServerTransport` by hand compiles but
 * serves only the older clients, which is why it is not used here.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { VERSION } from "./client.js";

serveStdio(() => createServer(), {
  onerror: (error) => {
    // stdout is the protocol channel: diagnostics must go to stderr or they
    // corrupt the message stream.
    console.error("ktemia-mcp:", error.message);
  },
});

console.error(`ktemia-mcp ${VERSION} running on stdio`);
