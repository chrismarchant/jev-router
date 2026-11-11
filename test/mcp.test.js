'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startMock, mockTypeSafe } = require('./helpers');

const ROOT = path.join(__dirname, '..');

/** Run the MCP server over stdio, send newline-delimited JSON-RPC messages, collect responses. */
function mcpSession(env, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server', 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) responses.push(JSON.parse(line));
      }
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    // give the server a moment to answer, then close stdin and collect
    setTimeout(() => {
      child.stdin.end();
      setTimeout(() => {
        child.kill();
        resolve({ responses, stderr });
      }, 300);
    }, 600);
  });
}

test('MCP handshake: initialize + tools/list exposes 9 jev_* tools', async () => {
  const { responses } = await mcpSession(
    { TYPESAFE_API_KEY: 'test-key' },
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ]
  );
  const init = responses.find((r) => r.id === 1);
  assert.equal(init.result.serverInfo.name, 'jev-router');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = responses.find((r) => r.id === 2);
  assert.equal(list.result.tools.length, 9);
  assert.ok(list.result.tools.every((t) => t.name.startsWith('jev_')));
  const ping = responses.find((r) => r.id === 3);
  assert.deepEqual(ping.result, {});
});

test('MCP tools/call jev_ask works end-to-end against a mock API', async () => {
  const mock = mockTypeSafe();
  const { url, close } = await startMock(mock.handler);
  try {
    const { responses } = await mcpSession(
      { TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_BASE: url },
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
        {
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'jev_ask', arguments: { state: 'refund please', questions: { billing: { type: 'noul', instructions: 'billing?' } } } },
        },
      ]
    );
    const call = responses.find((r) => r.id === 2);
    assert.ok(!call.result.isError, call.result.content?.[0]?.text);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.answers.billing.noul, 0.9);
    assert.equal(mock.calls[0].headers.authorization, 'Bearer test-key');
  } finally {
    await close();
  }
});

test('MCP tools/call without API key returns an isError result, not a crash', async () => {
  const { responses } = await mcpSession(
    { TYPESAFE_API_KEY: '' },
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jev_models', arguments: {} } },
    ]
  );
  const call = responses.find((r) => r.id === 2);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /TYPESAFE_API_KEY is not set/);
});
