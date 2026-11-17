#!/usr/bin/env bash
# Launches a locally built Ktemia MCP server with the key from .env.local.
#
# Why a wrapper instead of putting the key in the client's config: an MCP host
# config (~/.claude.json, ~/.cursor/mcp.json, ~/.codex/config.toml) is a
# plain file that is easy to screenshot, sync, or commit by accident. Keeping
# the key in a gitignored .env.local and reading it at launch means the only
# copy lives in one ignored file.
#
# Usage, from an MCP client config:
#   command: /absolute/path/to/scripts/dev-server.sh
#   args:    ["node"]   (the TypeScript build)  or  ["python"]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
env_file="$root/.env.local"

if [[ ! -f "$env_file" ]]; then
  echo "dev-server: no $env_file; create it with KTEMIA_API_KEY=..." >&2
  exit 1
fi

# Export only this one variable, and never echo it: stdout is the MCP protocol
# channel, so anything printed there corrupts the stream.
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

runtime="${1:-node}"
case "$runtime" in
  node)
    exec node "$root/typescript/dist/index.js"
    ;;
  python)
    exec uv --directory "$root/python" run ktemia-mcp
    ;;
  *)
    echo "dev-server: unknown runtime '$runtime' (expected node or python)" >&2
    exit 1
    ;;
esac
