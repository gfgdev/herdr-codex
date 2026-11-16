#!/bin/sh
set -eu
herdr_plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "${HERDR_CODEX_NODE:-node}" "$herdr_plugin_root/runtime/src/agent-mcp.mjs" "$@"
