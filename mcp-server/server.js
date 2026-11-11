#!/usr/bin/env node
'use strict';

/**
 * jev-router MCP server — zero-dependency, stdio transport.
 *
 * Speaks MCP (JSON-RPC 2.0 over newline-delimited stdio) and exposes the
 * jev_* tools, which route parallel-workstream decisions to TypeSafe's
 * Jev System One model via POST {TYPESAFE_API_BASE}/v1/systemone.
 *
 * Harness-agnostic: any MCP client can run this — Claude Code (.mcp.json /
 * .claude-plugin), Mistral Vibe (plugin.json mcp.json / `vibe mcp add
 * --transport stdio`), Codex, Cursor, etc. A plain CLI twin lives in
 * bin/jev-router.js for agents that only shell out.
 *
 * Env:
 *   TYPESAFE_API_KEY          required (https://console.typesafe.ai/keys)
 *   TYPESAFE_API_BASE         default https://api.typesafe.ai
 *   TYPESAFE_MODEL            default jev-latest
 *   JEV_ROUTER_TIMEOUT_MS     default 60000
 *   JEV_ROUTER_MAX_RETRIES    default 3 (429/529/5xx, exponential backoff)
 *   JEV_ROUTER_CONCURRENCY    default 6  (jev_batch)
 *   JEV_ROUTER_ALLOW_IMAGES   default true (TypeSafe-Danger-Zone-Images header for assets/box)
 *   JEV_ROUTER_LONG_CONTEXT   default false (TypeSafe-Danger-Zone-Long-Context header)
 *   JEV_ROUTER_MAX_CANDIDATES default 24 (jev_plan_workstreams)
 *   MAX_CONTEXT_CHARS         default 200000 (file context cap)
 *
 * No npm install required: Node standard library only (Node >= 18).
 */

const readline = require('node:readline');
const { createClient } = require('./client');
const { TOOLS, callTool } = require('./tools');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'jev-router', version: '0.1.0' };

const client = createClient();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'jev-router: routes parallel-workstream decisions to the TypeSafe Jev System One model. ' +
          'Set TYPESAFE_API_KEY (https://console.typesafe.ai/keys). Tools: ' + TOOLS.map((t) => t.name).join(', ') + '.',
      });
      return;
    }
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      try {
        const result = await callTool(params.name, params.arguments, client);
        sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        sendResult(id, {
          content: [{ type: 'text', text: String(err.message || err) }],
          isError: true,
        });
      }
      return;
    }
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON noise on stdin
  }
  if (msg.id === undefined || msg.id === null) return; // notification: nothing to answer
  handleRequest(msg).catch((err) => sendError(msg.id, -32603, String(err.message || err)));
});
