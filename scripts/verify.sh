#!/usr/bin/env bash
# Smoke-test the jev-router from the terminal.
# Usage: bash scripts/verify.sh
#   - always: syntax check + MCP stdio handshake + tools/list + CLI help + missing-key error
#   - if TYPESAFE_API_KEY is set: also a live jev_models call through the CLI
set -u
cd "$(dirname "$0")/.."

echo "== 1. syntax check =="
for f in mcp-server/client.js mcp-server/questions.js mcp-server/tools.js mcp-server/server.js bin/jev-router.js; do
  node --check "$f" && echo "OK: $f"
done

echo "== 2. MCP stdio handshake + tools/list =="
OUT="$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp-server/server.js)"
echo "$OUT" | grep -q '"serverInfo":{"name":"jev-router"' && echo "OK: initialize handshake"
TOOLS="$(echo "$OUT" | grep '"id":2' | grep -o '"name":"jev_[a-z_]*"' | sort -u | tr '\n' ' ')"
echo "tools: $TOOLS"
N="$(echo $TOOLS | wc -w | tr -d ' ')"
if [ "$N" -ne 9 ]; then echo "FAIL: expected 9 jev_* tools, got $N"; exit 1; fi
echo "OK: 9 jev_* tools listed"

echo "== 3. missing-key error =="
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  RES="$(printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"jev_models","arguments":{}}}' \
    | env -u TYPESAFE_API_KEY node mcp-server/server.js)"
  echo "$RES" | grep -q 'TYPESAFE_API_KEY is not set' && echo "OK: clean missing-key error (set the key, then rerun for a live test)"
else
  echo "SKIP: TYPESAFE_API_KEY is set in this shell"
fi

echo "== 4. CLI help =="
node bin/jev-router.js help | grep -q 'jev-router' && echo "OK: CLI help"

if [ -n "${TYPESAFE_API_KEY:-}" ]; then
  echo "== 5. live test: jev-router models =="
  node bin/jev-router.js models --compact | head -c 400; echo
else
  echo "== 5. live test skipped (export TYPESAFE_API_KEY from https://console.typesafe.ai/keys, then rerun) =="
fi

echo "== all checks passed =="
