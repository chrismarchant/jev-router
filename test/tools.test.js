'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { noul, choice, score, box, normalizeQuestions, validateQuestions } = require('../mcp-server/questions');
const { callTool, TOOLS } = require('../mcp-server/tools');
const { fakeClient } = require('./helpers');

test('catalogue exposes exactly the 8 jev_* tools', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
    'jev_ask', 'jev_batch', 'jev_box', 'jev_fan_out', 'jev_models', 'jev_plan_workstreams', 'jev_review', 'jev_route',
  ]);
});

test('question builders produce API-shaped questions', () => {
  assert.deepEqual(noul('Is it billing?'), { type: 'noul', instructions: 'Is it billing?' });
  assert.deepEqual(choice('Tone?', ['angry', 'calm']), {
    type: 'choice', instructions: 'Tone?', criteria: { angry: null, calm: null },
  });
  assert.deepEqual(choice('Tone?', { angry: 'hostile' }), { type: 'choice', instructions: 'Tone?', criteria: { angry: 'hostile' } });
  assert.deepEqual(score('Severity?', ['low', 'high']), { type: 'score', instructions: 'Severity?', criteria: ['low', 'high'] });
  assert.deepEqual(box('the mug in `img`'), { type: 'box', instructions: 'the mug in `img`' });
  assert.throws(() => score('x', ['only-one']), /at least 2/);
  assert.throws(() => choice('x', []), /at least one option/);
  assert.deepEqual(normalizeQuestions([{ id: 'a', type: 'noul', instructions: '?' }]), { a: { type: 'noul', instructions: '?' } });
  assert.throws(() => validateQuestions({ a: { type: 'wat' } }), /unknown type/);
  assert.throws(() => validateQuestions({ a: { type: 'choice', instructions: '?' } }), /criteria/);
});

test('jev_route combines choice + companion noul + threshold', async () => {
  const client = fakeClient();
  const res = await callTool('jev_route', {
    item: 'I was charged twice, refund please',
    destinations: { billing: 'charges/refunds', technical: 'bugs' },
    threshold: 0.6,
  }, client);
  // mock picks first option with probability 0.8 >= 0.6, none_fit 0.9... fake returns noul 0.9 for none_fit
  assert.equal(res.route, 'billing');
  assert.equal(res.probability, 0.8);
  assert.equal(res.none_fit, 0.9);
  assert.equal(res.act, false, 'none_fit 0.9 >= 0.5 must block auto-routing');
  assert.match(res.recommendation, /do not auto-route/);
  // exactly one request, two questions
  assert.equal(client.calls.length, 1);
  assert.deepEqual(Object.keys(client.calls[0].questions).sort(), ['none_fit', 'route']);
});

test('jev_route acts when confidence is high and nothing else fits', async () => {
  const client = fakeClient({
    systemOne: async (args) => ({
      model: 'jev-latest',
      answers: {
        route: { type: 'choice', choice: 'technical', probabilities: { technical: 0.95, billing: 0.05 }, confidence: 0.95 },
        none_fit: { type: 'noul', noul: 0.02 },
      },
      usage: { input_tokens: 50, output_tokens: 5 },
    }),
  });
  const res = await callTool('jev_route', { item: '500 on /search', destinations: ['billing', 'technical'] }, client);
  assert.equal(res.act, true);
  assert.equal(res.route, 'technical');
});

test('jev_plan_workstreams fans out ONE request and aggregates a plan', async () => {
  const client = fakeClient();
  const res = await callTool('jev_plan_workstreams', {
    task: 'Add rate limiting to the public API',
    candidates: ['implement limiter', { id: 'tests', description: 'add tests' }, 'update docs'],
  }, client);
  assert.equal(client.calls.length, 1, 'plan must be a single fan-out request');
  const q = client.calls[0].questions;
  for (const id of ['ws1', 'tests', 'ws3']) {
    for (const suffix of ['__lane', '__priority', '__risk', '__size', '__independent', '__conflicts']) {
      assert.ok(q[`${id}${suffix}`], `missing question ${id}${suffix}`);
    }
  }
  assert.ok(q.approach && q.task_complexity);
  assert.equal(res.workstreams.length, 3);
  assert.equal(res.approach, 'parallel');
  // fake client: independent noul 0.9 -> independent=true; conflicts noul 0.9 -> conflicts=true
  assert.deepEqual(res.parallel_safe, []);
  assert.deepEqual(res.needs_sequential.sort(), ['tests', 'ws1', 'ws3']);
  // state carries the task and candidates
  assert.equal(client.calls[0].state.task, 'Add rate limiting to the public API');
  assert.equal(client.calls[0].state.candidates.length, 3);
  assert.equal(res.usage.input_tokens, 100);
});

test('jev_plan_workstreams rejects too many candidates', async () => {
  const client = fakeClient();
  const candidates = Array.from({ length: 30 }, (_, i) => `ws-${i}`);
  await assert.rejects(callTool('jev_plan_workstreams', { task: 't', candidates, max_candidates: 24 }, client), /Too many candidates/);
});

test('jev_review passes when all criteria clear the threshold', async () => {
  const client = fakeClient();
  const res = await callTool('jev_review', {
    output: 'diff --git a/x ...',
    criteria: [{ id: 'tests', check: 'adds tests' }, { id: 'no-secrets', check: 'no credentials' }],
    pass_threshold: 0.7,
  }, client);
  assert.equal(res.pass, true);
  assert.equal(res.checks.length, 2);
  assert.ok(res.checks.every((c) => c.passed && c.noul === 0.9));
  assert.equal(res.needs_human_review, false);
});

test('jev_review flags low-confidence checks for human review', async () => {
  const client = fakeClient({
    systemOne: async (args) => ({
      model: 'jev-latest',
      answers: Object.fromEntries(Object.keys(args.questions).map((id) => [id, { type: 'noul', noul: 0.4 }])),
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  });
  const res = await callTool('jev_review', { output: 'x', criteria: [{ id: 'a', check: 'ok?' }] }, client);
  assert.equal(res.pass, false);
  assert.equal(res.needs_human_review, true);
});

test('jev_batch runs items in parallel with a bounded pool and aggregates usage', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const client = fakeClient({
    systemOne: async (args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { model: 'jev-latest', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 10 } };
    },
  });
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, state: `item ${i}`, questions: { q: { type: 'noul', instructions: '?' } } }));
  const res = await callTool('jev_batch', { items, concurrency: 2 }, client);
  assert.equal(res.item_count, 7);
  assert.equal(res.ok_count, 7);
  assert.ok(maxInFlight <= 2, `max in-flight ${maxInFlight} must be <= 2`);
  assert.equal(res.results.length, 7);
  assert.equal(res.total_usage.input_tokens, 700);
  assert.equal(res.results[3].answers.q.noul, 0.9);
});

test('jev_batch tolerates per-item failures', async () => {
  const client = fakeClient();
  const items = [
    { id: 'good', state: 'ok', questions: { q: { type: 'noul', instructions: '?' } } },
    { id: 'bad', state: 'x', questions: { q: { type: 'nope', instructions: '?' } } },
  ];
  const res = await callTool('jev_batch', { items, concurrency: 2 }, client);
  assert.equal(res.failed_count, 1);
  assert.equal(res.results[1].ok, false);
  assert.match(res.results[1].error, /unknown type/);
  assert.equal(res.results[0].ok, true);
});

test('jev_fan_out reports discarded answers below min_confidence', async () => {
  const client = fakeClient();
  const res = await callTool('jev_fan_out', {
    state: 'ticket text',
    questions: { a: { type: 'choice', instructions: '?' , criteria: { x: null, y: null } }, b: { type: 'noul', instructions: '?' } },
    min_confidence: 0.85, // fake choice confidence is 0.8 -> discarded
  }, client);
  assert.equal(res.question_count, 2);
  assert.deepEqual(res.discarded_below_confidence, [{ id: 'a', confidence: 0.8 }]);
});

test('jev_box sends image asset + box question and returns coordinates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-box-'));
  const png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const client = fakeClient();
  const res = await callTool('jev_box', { image: png, instructions: 'the error banner in `img`' }, client);
  assert.deepEqual(res.box, { left: 0.1, top: 0.2, right: 0.5, bottom: 0.6 });
  const sent = client.calls[0];
  assert.equal(sent.questions.locate.type, 'box');
  assert.equal(sent.state.image, 'img');
  assert.equal(sent.assets.img.format, 'png');
  assert.ok(sent.assets.img.data_base64.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('jev_ask passes through and validates questions', async () => {
  const client = fakeClient();
  const res = await callTool('jev_ask', { state: 'hello', questions: [{ id: 'q1', type: 'noul', instructions: 'greeting?' }] }, client);
  assert.equal(res.answers.q1.noul, 0.9);
  await assert.rejects(callTool('jev_ask', { state: 'x', questions: { q: { type: 'bogus' } } }, client), /unknown type/);
  await assert.rejects(callTool('nope', {}, client), /Unknown tool/);
});
