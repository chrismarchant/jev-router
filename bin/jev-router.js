#!/usr/bin/env node
'use strict';

/**
 * jev-router CLI — the harness-agnostic twin of the MCP server. Any agent
 * that can run a shell command can use it; output is JSON on stdout.
 *
 * Usage:
 *   jev-router models
 *   jev-router ask      --state <text|@file|json> --questions <json|@file> [--model M] [--assets <json|@file>] [--timeout-ms N] [--compact]
 *   jev-router fan-out  --state ... --questions ... [--min-confidence 0.7]
 *   jev-router plan     --task <text|@file> --candidates <json|@file> [--files <json|@file>] [--lanes <json|@file>] [--max-candidates N]
 *   jev-router route    --item <text|json|@file> --destinations <json|@file> [--threshold 0.6]
 *   jev-router review   --output <text|json|@file> --criteria <json|@file> [--rubric <json|@file>] [--pass-threshold 0.7]
 *   jev-router batch    --items <json|@file> [--concurrency N] [--model M]
 *   jev-router box      --image <path|base64> --instructions <text> [--format png|jpg|jpeg]
 *   jev-router draft-options --topic <text> [--context <text>] [--count N] [--model M]
 *               Draft a closed option set (Choice criteria / destinations / lanes) with a
 *               small generative LLM (default mistral-small-latest, needs MISTRAL_API_KEY);
 *               Jev never generates text, so it only PICKS from these options.
 *
 * Values prefixed with @ are read from a file. Requires TYPESAFE_API_KEY
 * (https://console.typesafe.ai/keys). Env overrides: TYPESAFE_API_BASE,
 * TYPESAFE_MODEL, JEV_ROUTER_TIMEOUT_MS, JEV_ROUTER_MAX_RETRIES, ...
 */

const fs = require('node:fs');
const { createClient } = require('../mcp-server/client');
const { callTool } = require('../mcp-server/tools');

const USAGE = `jev-router — route parallel-workstream decisions to the TypeSafe Jev System One model

Usage:
  jev-router <command> [options]

Commands:
  models      List available TypeSafe models (GET /v1/models)
  ask         One System One request: --state + --questions
  fan-out     Speculative fan-out: many questions in one request (--state + --questions [--min-confidence F])
  plan        Plan parallel workstreams: --task + --candidates [--files JSON] [--lanes JSON]
  route       Route an item to a destination: --item + --destinations [--threshold F]
  review      Verify an output: --output + --criteria [--rubric JSON] [--pass-threshold F]
  batch       Many items in parallel: --items <json|@file> [--concurrency N]
  box         Locate something in an image: --image <path|base64> --instructions <text>
  draft-options  Draft Choice criteria/destinations/lanes with a small LLM: --topic <text> [--context T] [--count N] [--model M] (needs MISTRAL_API_KEY; default model mistral-small-latest)
  help        Show this help

Options:
  --model NAME          Model alias (default: TYPESAFE_MODEL or jev-latest)
  --timeout-ms N        Per-request timeout (default 60000)
  --compact             Single-line JSON output (default: pretty)
  @file                 Any --value starting with @ is read from that file

Env: TYPESAFE_API_KEY (required), TYPESAFE_API_BASE, TYPESAFE_MODEL,
     JEV_ROUTER_TIMEOUT_MS, JEV_ROUTER_MAX_RETRIES, JEV_ROUTER_CONCURRENCY,
     JEV_ROUTER_ALLOW_IMAGES, JEV_ROUTER_LONG_CONTEXT, MAX_CONTEXT_CHARS,
     MISTRAL_API_KEY + MISTRAL_API_BASE + JEV_ROUTER_DRAFT_MODEL (draft-options only)

Examples:
  jev-router models
  jev-router ask --state "I was charged twice. Please refund." \
    --questions '{"billing": {"type": "noul", "instructions": "Is this about billing?"}}'
  jev-router plan --task @task.txt --candidates '["add auth to API", "write tests for auth", "update docs"]' \
    --files '["src/server.js"]'
  jev-router batch --items @examples/triage-items.json
  jev-router box --image screenshot.png --instructions "the error banner in \`img\`"
  jev-router draft-options --topic "support ticket categories" --count 8   # needs MISTRAL_API_KEY
`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _pos: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const k = a.slice(2);
        if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) opts[k] = rest[++i];
        else opts[k] = true;
      }
    } else {
      opts._pos.push(a);
    }
  }
  return { cmd, opts };
}

function readMaybeFile(v) {
  if (typeof v === 'string' && v.startsWith('@')) return fs.readFileSync(v.slice(1), 'utf8');
  return v;
}

function tryJson(raw) {
  if (typeof raw !== 'string') return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: raw };
  }
}

/** JSON-valued option; throws on invalid JSON. @file supported. */
function jsonOpt(opts, name) {
  if (opts[name] === undefined) return undefined;
  const raw = readMaybeFile(opts[name]);
  const r = tryJson(raw);
  if (!r.ok) throw new Error(`--${name}: not valid JSON (${r.value.slice(0, 80)}...). Use @file to load JSON from a file.`);
  return r.value;
}

/** String-or-JSON option: raw text is fine, JSON is parsed when it parses. @file supported. */
function textOrJsonOpt(opts, name, posIndex) {
  let raw = opts[name] !== undefined ? readMaybeFile(opts[name]) : opts._pos[posIndex];
  if (raw === undefined) return undefined;
  return tryJson(raw).value;
}

function numOpt(opts, name) {
  if (opts[name] === undefined || opts[name] === true) return undefined;
  const n = Number(opts[name]);
  if (!Number.isFinite(n)) throw new Error(`--${name}: expected a number, got "${opts[name]}".`);
  return n;
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help' || cmd === '--help' || opts.help) {
    process.stdout.write(USAGE);
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 0 : (cmd ? 0 : 2));
  }

  const client = createClient();
  let args;
  switch (cmd) {
    case 'models':
      args = { timeout_ms: numOpt(opts, 'timeout-ms') };
      break;
    case 'ask':
      args = {
        model: opts.model === true ? undefined : opts.model,
        state: textOrJsonOpt(opts, 'state', 0),
        questions: jsonOpt(opts, 'questions'),
        assets: jsonOpt(opts, 'assets'),
        headers: jsonOpt(opts, 'headers'),
        timeout_ms: numOpt(opts, 'timeout-ms'),
      };
      break;
    case 'fan-out':
    case 'fanout':
      args = {
        model: opts.model === true ? undefined : opts.model,
        state: textOrJsonOpt(opts, 'state', 0),
        questions: jsonOpt(opts, 'questions'),
        assets: jsonOpt(opts, 'assets'),
        headers: jsonOpt(opts, 'headers'),
        min_confidence: numOpt(opts, 'min-confidence'),
        timeout_ms: numOpt(opts, 'timeout-ms'),
      };
      break;
    case 'plan':
      args = {
        task: textOrJsonOpt(opts, 'task', 0),
        candidates: jsonOpt(opts, 'candidates'),
        files: jsonOpt(opts, 'files'),
        lanes: jsonOpt(opts, 'lanes'),
        max_candidates: numOpt(opts, 'max-candidates'),
        model: opts.model === true ? undefined : opts.model,
        timeout_ms: numOpt(opts, 'timeout-ms'),
      };
      break;
    case 'route':
      args = {
        item: textOrJsonOpt(opts, 'item', 0),
        destinations: jsonOpt(opts, 'destinations'),
        threshold: numOpt(opts, 'threshold'),
        model: opts.model === true ? undefined : opts.model,
        timeout_ms: numOpt(opts, 'timeout-ms'),
      };
      break;
    case 'review':
      args = {
        output: textOrJsonOpt(opts, 'output', 0),
        criteria: jsonOpt(opts, 'criteria'),
        rubric: jsonOpt(opts, 'rubric'),
        pass_threshold: numOpt(opts, 'pass-threshold'),
        model: opts.model === true ? undefined : opts.model,
        timeout_ms: numOpt(opts, 'timeout-ms'),
      };
      break;
    case 'batch':
      args = {
        items: jsonOpt(opts, 'items'),
        concurrency: numOpt(opts, 'concurrency'),
        model: opts.model === true ? undefined : opts.model,
        timeout_ms: numOpt(opts, 'timeout-ms'),
      };
      break;
    case 'box':
      args = {
        image: opts.image === true ? undefined : opts.image,
        instructions: opts.instructions === true ? opts._pos[0] : opts.instructions,
        format: opts.format === true ? undefined : opts.format,
        model: opts.model === true ? undefined : opts.model,
        timeout_ms: numOpt(opts, 'timeout-ms'),
      };
      break;
    case 'draft-options':
    case 'draft_options':
      args = {
        topic: textOrJsonOpt(opts, 'topic', 0),
        context: opts.context === true ? undefined : opts.context,
        count: numOpt(opts, 'count'),
        model: opts.model === true ? undefined : opts.model,
        timeout_ms: numOpt(opts, 'timeout-ms'),
      };
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }

  const result = await callTool(
    { models: 'jev_models', ask: 'jev_ask', 'fan-out': 'jev_fan_out', fanout: 'jev_fan_out', plan: 'jev_plan_workstreams', route: 'jev_route', review: 'jev_review', batch: 'jev_batch', box: 'jev_box', 'draft-options': 'jev_draft_options', draft_options: 'jev_draft_options' }[cmd],
    args,
    client
  );
  process.stdout.write(JSON.stringify(result, null, opts.compact ? 0 : 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`${err.name || 'Error'}: ${err.message || err}\n`);
  process.exit(1);
});
