"""Entry point for ``ktemia-mcp`` (and ``python -m ktemia_mcp``).

Speaks MCP over stdio: the transport every local host launcher uses. The SDK's
stdio loop serves both the legacy handshake era and the modern
per-request-envelope era, deciding from the client's first request, so one
binary works with 2025-era and current hosts alike.
"""

from __future__ import annotations

import sys

from .server import create_server


def main() -> int:
    # stdout is the protocol channel; a stray print would corrupt the stream,
    # so anything we say goes to stderr, which hosts surface as server logs.
    try:
        create_server().run(transport="stdio")
    except KeyboardInterrupt:
        return 130
    except Exception as error:  # noqa: BLE001 - last resort, must not traceback
        print(f"ktemia-mcp failed to start: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
