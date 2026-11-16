#!/bin/sh
set -eu
herdr_plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -f "$herdr_plugin_root/runtime/src/cli.mjs" ]; then
  echo "This plugin source has not been packaged: build the herdr-codex plugin first." >&2
  exit 1
fi
exec "${HERDR_CODEX_NODE:-node}" "$herdr_plugin_root/runtime/src/cli.mjs" "$@"
