'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { startMock, mockTypeSafe } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'jev-router.js');

/** Async spawn (the in-process mock server needs the event loop free). */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out. stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 300)}`));
    }, 15000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function runCliSync(args, env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
}

test('CLI help exits 0 and prints usage', () => {
  const r = runCliSync(['help'], { TYPESAFE_API_KEY: '' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /jev-router/);
  assert.match(r.stdout, /plan/);
});

test('CLI unknown command exits 2', () => {
  const r = runCliSync(['frobnicate'], { TYPESAFE_API_KEY: '' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown command/);
});

test('CLI models + ask work end-to-end against a mock API', async () => {
  const mock = mockTypeSafe();
  const { url, close } = await startMock(mock.handler);
  try {
    const env = { TYPESAFE_API_KEY: 'cli-key', TYPESAFE_API_BASE: url };
    const m = await runCli(['models'], env);
    assert.equal(m.status, 0, m.stderr);
    assert.equal(JSON.parse(m.stdout).models.models[0].name, 'jev-latest');

    const a = await runCli(
      ['ask', '--state', 'refund please', '--questions', '{"billing": {"type": "noul", "instructions": "billing?"}}', '--compact'],
      env
    );
    assert.equal(a.status, 0, a.stderr);
    const payload = JSON.parse(a.stdout);
    assert.equal(payload.answers.billing.noul, 0.9);
    assert.equal(JSON.parse(mock.calls.at(-1).body).model, 'jev-latest');
  } finally {
    await close();
  }
});

test('CLI plan reads @file inputs and prints a plan', async () => {
  const mock = mockTypeSafe();
  const { url, close } = await startMock(mock.handler);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cli-'));
    const taskFile = path.join(dir, 'task.txt');
    const candFile = path.join(dir, 'cands.json');
    fs.writeFileSync(taskFile, 'Add rate limiting');
    fs.writeFileSync(candFile, JSON.stringify(['limiter', 'tests']));
    const r = await runCli(['plan', '--task', `@${taskFile}`, '--candidates', `@${candFile}`], { TYPESAFE_API_KEY: 'k', TYPESAFE_API_BASE: url });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.workstreams.length, 2);
    assert.equal(plan.task, 'Add rate limiting');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    await close();
  }
});

test('CLI box reads an image file and returns box coordinates', async () => {
  const mock = mockTypeSafe();
  const { url, close } = await startMock(mock.handler);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cli-box-'));
    const png = path.join(dir, 's.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]));
    const r = await runCli(['box', '--image', png, '--instructions', 'the banner in `img`'], { TYPESAFE_API_KEY: 'k', TYPESAFE_API_BASE: url });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.box, { left: 0.1, top: 0.2, right: 0.5, bottom: 0.6 });
    const sent = JSON.parse(mock.calls[0].body);
    assert.equal(sent.questions.locate.type, 'box');
    assert.equal(sent.assets.img.format, 'png');
    assert.equal(mock.calls[0].headers['typesafe-danger-zone-images'], 'true');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    await close();
  }
});

test('CLI draft-options drafts criteria via a mock Mistral endpoint (mistral-small-latest default)', async () => {
  const { url, close } = await startMock((req) => {
    if (req.url === '/v1/chat/completions') {
      const b = JSON.parse(req.body);
      assert.equal(b.model, 'mistral-small-latest');
      return { body: { model: b.model, choices: [{ message: { content: JSON.stringify({ options: [
        { name: 'billing', description: 'Charges/refunds' }, { name: 'technical', description: 'Bugs' },
      ] }) } }], usage: { prompt_tokens: 40, completion_tokens: 15 } } };
    }
    return { status: 404, body: {} };
  });
  try {
    const r = await runCli(['draft-options', '--topic', 'ticket categories', '--count', '5', '--compact'], {
      MISTRAL_API_KEY: 'mk',
      MISTRAL_API_BASE: `${url}/v1`,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.draft_model, 'mistral-small-latest');
    assert.deepEqual(Object.keys(out.criteria), ['billing', 'technical']);
  } finally {
    await close();
  }
});

test('CLI without API key exits 1 with the actionable error on stderr', () => {
  const r = runCliSync(['models'], { TYPESAFE_API_KEY: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TYPESAFE_API_KEY is not set/);
});
