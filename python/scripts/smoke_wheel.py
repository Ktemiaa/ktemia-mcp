"""Smoke-test an installed ``ktemia-mcp``, as a user's client would launch it.

Run against the built wheel in a clean environment, not the source tree: the
packaged copy of ``tools.json`` is a separate build step, and if it is missing
the server cannot start. Nothing in the normal test suite catches that, because
those tests read the spec from the repository.

Usage::

    python scripts/smoke_wheel.py            # uses ktemia-mcp on PATH
    python scripts/smoke_wheel.py /path/to/ktemia-mcp
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

EXPECTED = 7

REQUESTS = [
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "smoke", "version": "1"},
        },
    },
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
]


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "ktemia-mcp"

    result = subprocess.run(  # noqa: S603
        [command],
        input="\n".join(json.dumps(r) for r in REQUESTS) + "\n",
        capture_output=True,
        text=True,
        timeout=60,
        # A placeholder key is enough: tools/list must not touch the network,
        # and requiring a real key here would make CI depend on a secret.
        env={**os.environ, "KTEMIA_API_KEY": "smoke-placeholder"},
        check=False,
    )

    names: list[str] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        message = json.loads(line)
        if message.get("id") == 2:
            if "error" in message:
                print(f"tools/list failed: {message['error']}", file=sys.stderr)
                return 1
            names = [tool["name"] for tool in message["result"]["tools"]]

    if len(names) != EXPECTED:
        print(
            f"expected {EXPECTED} tools, got {len(names)}: {names}\n"
            f"--- stderr ---\n{result.stderr}",
            file=sys.stderr,
        )
        return 1

    print(f"wheel serves {len(names)} tools: {', '.join(names)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
