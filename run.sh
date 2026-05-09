#!/usr/bin/env bash
# Run Zalo-TG bridge with system Node.js (bypasses Python venv which overrides node/npm)
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")"
exec /usr/local/bin/node node_modules/.bin/tsx watch src/index.ts
