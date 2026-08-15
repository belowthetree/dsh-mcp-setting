#!/bin/bash
# Build the dsh-mcp-setting host half: compile src/ → lib/ with TypeScript.
# Prefers the plugin's own tsc (pnpm install); falls back to the dsh
# checkout's tsc when DSH_CHECKOUT points at a source checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -x node_modules/.bin/tsc ]; then
  node_modules/.bin/tsc -p tsconfig.json
elif [ -n "${DSH_CHECKOUT:-}" ] && [ -x "$DSH_CHECKOUT/node_modules/.bin/tsc" ]; then
  "$DSH_CHECKOUT/node_modules/.bin/tsc" -p tsconfig.json
else
  echo "build: tsc not found (run pnpm install, or set DSH_CHECKOUT to a dsh checkout)" >&2
  exit 1
fi

echo "=== host build complete ==="
ls -la lib/ 2>/dev/null
