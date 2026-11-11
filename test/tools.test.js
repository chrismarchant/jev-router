'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { noul, choice, score, box, normalizeQuestions, validateQuestions } = require('../mcp-server/questions');
const { callTool, TOOLS } = require('../mcp-server/tools');
const { fakeClient, startMock } = require('./helpers');

test('catalogue exposes exactly the 9 jev_* tools', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
    'jev_ask', 'jev_batch', 'jev_box', 'jev_draft_options', 'jev_fan_out', 'jev_models', 'jev_plan_workstreams', 'jev_review', 'jev_route',
  ]);
});

test('question builders produce API-shaped questions', () => {
  assert.deepEqual(noul('Is it billing?'), { type: 'noul', instructions: 'Is it billing?' });
  assert.deepEqual(noul('Refund?', { true: 'asks for money back', false: 'no refund asked' }).criteria, { true: 'asks for money back', false: 'no refund asked' });
  assert.deepEqual(choice('Tone?', ['angry', 'calm']), {
    type: 'choice', instructions: 'Tone?', criteria: { angry: null, calm: null },
  });
  assert.deepEqual(choice('Tone?', { angry: 'hostile' }), { type: 'choice', instructions: 'Tone?', criteria: { angry: 'hostile' } });
  assert.deepEqual(score('Severity?', ['low', 'high']), { type: 'score', instructions: 'Severity?', criteria: ['low', 'high'] });
  assert.deepEqual(box('the mug in `img`'), { type: 'box', instructions: 'the mug in `img`' });
  assert.throws(() => score('x', ['only-one']), /at least 2/);
  assert.throws(() => choice('x', []), /at least one option/);
  assert.throws(() => choice('x', Array.from({ length: 256 }, (_, i) => `o${i}`)), /255/);
  assert.deepEqual(normalizeQuestions([{ id: 'a', type: 'noul', instructions: '?' }]), { a: { type: 'noul', instructions: '?' } });
  assert.throws(() => validateQuestions({ a: { type: 'wat' } }), /unknown type/);
  assert.throws(() => validateQuestions({ a: { type: 'choice', instructions: '?' } }), /criteria/);
});

test('jev_route: probability-routing + companion any_fit noul + confidence floor', async () => {
  const client = fakeClient(); // route -> first option prob 0.8, confidence 0.8; any_fit noul 0.9
  const res = await callTool('jev_route', {
    item: 'I was charged twice, refund please',
    destinations: { billing: 'charges/refunds', technical: 'bugs' },
    threshold: 0.6,
  }, client);
  assert.equal(res.route, 'billing');
  assert.equal(res.probability, 0.8);
  assert.equal(res.confidence, 0.8);
  assert.equal(res.any_fit, 0.9);
  assert.equal(res.fit_band, 'clear_yes');
  assert.equal(res.act, true);
  assert.match(res.recommendation, /route to "billing"/);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(Object.keys(client.calls[0].questions).sort(), ['any_fit', 'route']);
});

test('jev_route: clear_no on any_fit means fallback, not routing', async () => {
  const client = fakeClient({
    systemOne: async () => ({
      model: 'jev-latest',
      answers: {
        route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.9 },
        any_fit: { type: 'noul', noul: 0.1 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  });
  const res = await callTool('jev_route', { item: 'random noise', destinations: ['billing', 'technical'] }, client);
  assert.equal(res.fit_band, 'clear_no');
  assert.equal(res.act, false);
  assert.match(res.recommendation, /no destination fits/);
});

test('jev_route: low confidence escalates even with high probability (confidence-routing)', async () => {
  const client = fakeClient({
    systemOne: async () => ({
      model: 'jev-latest',
      answers: {
        route: { type: 'choice', choice: 'technical', probabilities: { technical: 0.95, billing: 0.05 }, confidence: 0.3 },
        any_fit: { type: 'noul', noul: 0.95 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  });
  const res = await callTool('jev_route', { item: '500 on /search', destinations: ['billing', 'technical'] }, client);
  assert.equal(res.act, false);
  assert.match(res.recommendation, /low confidence/);
});

test('jev_route: probability below threshold does not act (probability-routing)', async () => {
  const client = fakeClient(); // prob 0.8
  const res = await callTool('jev_route', { item: 'x', destinations: ['a', 'b'], threshold: 0.9 }, client);
  assert.equal(res.act, false);
  assert.match(res.recommendation, /below threshold/);
});

test('jev_plan_workstreams fans out ONE request and aggregates a weighted plan', async () => {
  const client = fakeClient();
  const res = await callTool('jev_plan_workstreams', {
    task: 'Add rate limiting to the public API',
    candidates: ['implement limiter', { id: 'tests', description: 'add tests' }, 'update docs'],
  }, client);
  assert.equal(client.calls.length, 1, 'plan must be a single fan-out request');
  const q = client.calls[0].questions;
  for (const id of ['ws1', 'tests', 'ws3']) {
    for (const suffix of ['__lane', '__lane_fits', '__priority', '__risk', '__size', '__independent', '__conflicts']) {
      assert.ok(q[`${id}${suffix}`], `missing question ${id}${suffix}`);
    }
  }
  assert.ok(q.approach && q.task_complexity);
  // instructions reference state by path (jaggedness: no indirection)
  assert.match(q.ws1__lane.instructions, /candidates\[0\]\.description/);
  assert.equal(res.workstreams.length, 3);
  assert.equal(res.approach, 'parallel');
  // fake client: lane_fits noul 0.9 -> clear_yes, not uncertain; independent 0.9 -> true; conflicts 0.9 -> true
  assert.ok(res.workstreams.every((w) => w.lane_fits === 0.9 && w.lane_fits_band === 'clear_yes'));
  assert.deepEqual(res.parallel_safe, []);
  assert.deepEqual(res.needs_sequential.sort(), ['tests', 'ws1', 'ws3']);
  // composite = 1*(priority/3) + (-1)*(risk/4) + 0*(size/4) with fake scores 1.5/1.5/1.5
  assert.ok(res.workstreams.every((w) => Math.abs(w.composite - (1.5 / 3 - 1.5 / 4)) < 1e-9));
  assert.equal(client.calls[0].state.task, 'Add rate limiting to the public API');
  assert.equal(res.usage.input_tokens, 100);
});

test('jev_plan_workstreams rejects too many candidates', async () => {
  const client = fakeClient();
  const candidates = Array.from({ length: 30 }, (_, i) => `ws-${i}`);
  await assert.rejects(callTool('jev_plan_workstreams', { task: 't', candidates, max_candidates: 24 }, client), /Too many candidates/);
});

test('jev_review: three-band noul checks (pass/uncertain/fail)', async () => {
  const client = fakeClient(); // all nouls 0.9
  const res = await callTool('jev_review', {
    output: 'diff --git a/x ...',
    criteria: [{ id: 'tests', check: 'adds tests' }, { id: 'no-secrets', check: 'no credentials' }],
  }, client);
  assert.equal(res.pass, true);
  assert.ok(res.checks.every((c) => c.status === 'pass' && c.passed));
  assert.equal(res.needs_human_review, false);
});

test('jev_review: uncertain band (0.3..0.7) flags human review; fail below 0.3', async () => {
  const client = fakeClient({
    systemOne: async (args) => ({
      model: 'jev-latest',
      answers: Object.fromEntries(Object.keys(args.questions).map((id, i) => [id, { type: 'noul', noul: i === 0 ? 0.4 : 0.1 }])),
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  });
  const res = await callTool('jev_review', { output: 'x', criteria: [{ id: 'a', check: 'ok?' }, { id: 'b', check: 'fine?' }] }, client);
  assert.equal(res.pass, false);
  assert.equal(res.checks[0].status, 'uncertain');
  assert.equal(res.checks[1].status, 'fail');
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

test('jev_fan_out: min_confidence discards low-confidence answers; noul_confidence scores nouls via |2p-1|', async () => {
  const client = fakeClient(); // choice a: confidence 0.8; noul b: 0.9 -> |2*0.9-1| = 0.8
  const res = await callTool('jev_fan_out', {
    state: 'ticket text',
    questions: { a: { type: 'choice', instructions: '?', criteria: { x: null, y: null } }, b: { type: 'noul', instructions: '?' } },
    min_confidence: 0.85,
    noul_confidence: true,
  }, client);
  assert.equal(res.question_count, 2);
  assert.deepEqual(res.discarded_below_confidence, [{ id: 'a', confidence: 0.8 }, { id: 'b', confidence: 0.8 }]);

  const res2 = await callTool('jev_fan_out', {
    state: 't',
    questions: { a: { type: 'choice', instructions: '?', criteria: { x: null, y: null } }, b: { type: 'noul', instructions: '?' } },
    min_confidence: 0.85,
  }, client);
  assert.deepEqual(res2.discarded_below_confidence, [{ id: 'a', confidence: 0.8 }], 'nouls skipped without noul_confidence');
});

test('jev_box sends image asset + box question + companion present noul', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-box-'));
  const png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const client = fakeClient();
  const res = await callTool('jev_box', { image: png, instructions: 'the error banner in `img`' }, client);
  assert.deepEqual(res.box, { left: 0.1, top: 0.2, right: 0.5, bottom: 0.6 });
  assert.equal(res.present, 0.9);
  assert.equal(res.present_band, 'clear_yes');
  const sent = client.calls[0];
  assert.equal(sent.questions.locate.type, 'box');
  assert.equal(sent.questions.present.type, 'noul');
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

test('jev_draft_options drafts criteria via a small LLM (mistral-small-latest default)', async () => {
  const { url, close } = await startMock((req) => {
    if (req.url === '/v1/chat/completions') {
      const b = JSON.parse(req.body);
      return {
        body: {
          model: b.model,
          choices: [{ message: { content: JSON.stringify({ options: [
            { name: 'billing', description: 'Charges, invoices, refunds' },
            { name: 'technical', description: 'Bugs and integration problems' },
          ] }) } }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        },
      };
    }
    return { status: 404, body: { detail: 'nf' } };
  });
  const savedKey = process.env.MISTRAL_API_KEY;
  const savedBase = process.env.MISTRAL_API_BASE;
  process.env.MISTRAL_API_KEY = 'mk';
  process.env.MISTRAL_API_BASE = `${url}/v1`;
  try {
    const client = fakeClient();
    const res = await callTool('jev_draft_options', { topic: 'support ticket categories', count: 5 }, client);
    assert.equal(res.draft_model, 'mistral-small-latest');
    assert.equal(res.options.length, 2);
    assert.deepEqual(res.criteria, { billing: 'Charges, invoices, refunds', technical: 'Bugs and integration problems' });
    assert.equal(res.usage.prompt_tokens, 50);
  } finally {
    if (savedKey === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.MISTRAL_API_BASE; else process.env.MISTRAL_API_BASE = savedBase;
    await close();
  }
});

test('jev_draft_options without MISTRAL_API_KEY gives a clear error', async () => {
  const savedKey = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  try {
    await assert.rejects(callTool('jev_draft_options', { topic: 'x' }, fakeClient()), /MISTRAL_API_KEY is not set/);
  } finally {
    if (savedKey !== undefined) process.env.MISTRAL_API_KEY = savedKey;
  }
});
