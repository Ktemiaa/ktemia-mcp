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
import threading

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

    # Keep stdin open until the answer arrives, the way a real MCP client does.
    # Writing every request and closing stdin at once races the server: on
    # end-of-input it may shut down before answering tools/list, which showed
    # up in CI as "got 0 tools" on a cold runner while the wheel was fine.
    proc = subprocess.Popen(  # noqa: S603
        [command],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        # A placeholder key is enough: tools/list must not touch the network,
        # and requiring a real key here would make CI depend on a secret.
        env={**os.environ, "KTEMIA_API_KEY": "smoke-placeholder"},
    )
    timer = threading.Timer(60, proc.kill)
    timer.start()

    names: list[str] = []
    error: object = None
    try:
        assert proc.stdin is not None and proc.stdout is not None
        for request in REQUESTS:
            proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()

        for line in proc.stdout:
            if not line.strip():
                continue
            message = json.loads(line)
            if message.get("id") == 2:
                if "error" in message:
                    error = message["error"]
                else:
                    names = [tool["name"] for tool in message["result"]["tools"]]
                break
    finally:
        timer.cancel()
        if proc.stdin is not None:
            proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    stderr = proc.stderr.read() if proc.stderr is not None else ""

    if error is not None:
        print(f"tools/list failed: {error}", file=sys.stderr)
        return 1

    if len(names) != EXPECTED:
        print(
            f"expected {EXPECTED} tools, got {len(names)}: {names}\n"
            f"--- stderr ---\n{stderr}",
            file=sys.stderr,
        )
        return 1

    print(f"wheel serves {len(names)} tools: {', '.join(names)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
