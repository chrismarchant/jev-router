#!/usr/bin/env zsh
# Safely add TYPESAFE_API_KEY to a project's .claude/settings.local.json.
# The key is read with `read -s` (never echoed) and only ever expanded from
# the environment at runtime by the MCP server.
#
# Usage: zsh scripts/set-typesafe-key.sh
#
# Mistral Vibe users: do NOT run this for Vibe — add the key to ~/.vibe/.env
# yourself (TYPESAFE_API_KEY=...) and run /reload; Vibe injects .env into the
# environment of every MCP server it starts.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Paste your TypeSafe API key (https://console.typesafe.ai/keys). Input is hidden:"
read -s "KEY?TYPESAFE_API_KEY: "
echo
if [ -z "$KEY" ]; then echo "empty key, aborting"; exit 1; fi

FILE=".claude/settings.local.json"
mkdir -p .claude
if [ -f "$FILE" ]; then
  TMP="$(mktemp)"
  jq --arg k "$KEY" '.env = ((.env // {}) + {TYPESAFE_API_KEY: $k})' "$FILE" > "$TMP" && mv "$TMP" "$FILE"
  echo "updated $FILE — other env keys preserved: $(jq -r '(.env // {}) | keys | map(select(. != "TYPESAFE_API_KEY")) | join(", ")' "$FILE")"
else
  printf '{\n  "env": {\n    "TYPESAFE_API_KEY": "%s"\n  }\n}\n' "$KEY" > "$FILE"
  echo "created $FILE"
fi
grep -q 'settings.local.json' .gitignore 2>/dev/null || echo ".claude/settings.local.json" >> .gitignore

echo "done. Relaunch your agent in this project so the MCP server picks up the env."
echo "Mistral Vibe: add TYPESAFE_API_KEY=... to ~/.vibe/.env yourself, then /reload."
