'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, TypeSafeError } = require('../mcp-server/client');
const { startMock, mockTypeSafe } = require('./helpers');

test('systemOne sends the right request shape and parses the response', async () => {
  const mock = mockTypeSafe();
  const { server, url, close } = await startMock(mock.handler);
  try {
    const client = createClient({ apiBase: url, apiKey: 'test-key', maxRetries: 0 });
    const res = await client.systemOne({
      state: 'I was charged twice. Please refund.',
      questions: { billing: { type: 'noul', instructions: 'Is this about billing?' } },
    });
    assert.equal(res.model, 'jev-latest');
    assert.equal(res.answers.billing.noul, 0.9);
    assert.deepEqual(res.usage, { input_tokens: 100, output_tokens: 10 });

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/v1/systemone');
    assert.equal(call.headers.authorization, 'Bearer test-key');
    assert.match(call.headers['content-type'], /application\/json/);
    const body = JSON.parse(call.body);
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.state, 'I was charged twice. Please refund.');
    assert.equal(body.questions.billing.type, 'noul');
  } finally {
    await close();
  }
});

test('model override and TYPESAFE_MODEL env are respected', async () => {
  const mock = mockTypeSafe();
  const { url, close } = await startMock(mock.handler);
  try {
    const c1 = createClient({ apiBase: url, apiKey: 'k', model: 'jev-preview', maxRetries: 0 });
    await c1.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } });
    assert.equal(JSON.parse(mock.calls[0].body).model, 'jev-preview');
    const c2 = createClient({ apiBase: url, apiKey: 'k', maxRetries: 0 });
    process.env.TYPESAFE_MODEL = 'jev-env';
    const c3 = createClient({ apiBase: url, apiKey: 'k', maxRetries: 0 });
    await c3.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } });
    assert.equal(JSON.parse(mock.calls[1].body).model, 'jev-env');
    delete process.env.TYPESAFE_MODEL;
  } finally {
    await close();
  }
});

test('429 is retried with backoff and then succeeds', async () => {
  const mock = mockTypeSafe({ failOnce429: true });
  const { url, close } = await startMock(mock.handler);
  try {
    const client = createClient({ apiBase: url, apiKey: 'k', maxRetries: 2 });
    const res = await client.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } });
    assert.equal(res.answers.q.noul, 0.9);
    assert.equal(mock.calls.filter((c) => c.url === '/v1/systemone').length, 2);
  } finally {
    await close();
  }
});

test('422 is NOT retried and surfaces status + body', async () => {
  const mock = mockTypeSafe({ always422: true });
  const { url, close } = await startMock(mock.handler);
  try {
    const client = createClient({ apiBase: url, apiKey: 'k', maxRetries: 3 });
    await assert.rejects(
      client.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }),
      (err) => {
        assert.ok(err instanceof TypeSafeError);
        assert.equal(err.status, 422);
        assert.match(err.message, /422/);
        return true;
      }
    );
    assert.equal(mock.calls.filter((c) => c.url === '/v1/systemone').length, 1);
  } finally {
    await close();
  }
});

test('box questions send the images danger-zone header; allowImages=false refuses', async () => {
  const mock = mockTypeSafe();
  const { url, close } = await startMock(mock.handler);
  try {
    const client = createClient({ apiBase: url, apiKey: 'k', maxRetries: 0 });
    await client.systemOne({
      state: { image: 'img' },
      questions: { locate: { type: 'box', instructions: 'the mug in `img`' } },
      assets: { img: { type: 'image', format: 'png', data_base64: 'aGk=' } },
    });
    assert.equal(mock.calls[0].headers['typesafe-danger-zone-images'], 'true');

    const strict = createClient({ apiBase: url, apiKey: 'k', maxRetries: 0, allowImages: false });
    await assert.rejects(
      strict.systemOne({ state: { image: 'img' }, questions: { locate: { type: 'box', instructions: 'x' } }, assets: { img: { type: 'image', format: 'png', data_base64: 'aGk=' } } }),
      /JEV_ROUTER_ALLOW_IMAGES=true/
    );
  } finally {
    await close();
  }
});

test('missing API key produces a clean actionable error', async () => {
  const client = createClient({ apiKey: '', apiBase: 'http://127.0.0.1:1', maxRetries: 0 });
  await assert.rejects(client.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }), /TYPESAFE_API_KEY is not set/);
});

test('request timeout aborts with a clear message', async () => {
  const mock = mockTypeSafe({ delayMs: 400 });
  const { url, close } = await startMock(mock.handler);
  try {
    const client = createClient({ apiBase: url, apiKey: 'k', maxRetries: 0, timeoutMs: 60 });
    await assert.rejects(client.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }), /timed out after 60ms/);
  } finally {
    await close();
  }
});

test('listModels hits GET /v1/models', async () => {
  const mock = mockTypeSafe();
  const { url, close } = await startMock(mock.handler);
  try {
    const client = createClient({ apiBase: url, apiKey: 'k', maxRetries: 0 });
    const res = await client.listModels();
    assert.equal(res.models[0].name, 'jev-latest');
    assert.equal(mock.calls[0].method, 'GET');
    assert.equal(mock.calls[0].url, '/v1/models');
  } finally {
    await close();
  }
});

test('validation: state and non-empty questions are required', async () => {
  const client = createClient({ apiKey: 'k', apiBase: 'http://127.0.0.1:1', maxRetries: 0 });
  await assert.rejects(client.systemOne({ questions: { q: { type: 'noul', instructions: '?' } } }), /"state" is required/);
  await assert.rejects(client.systemOne({ state: 'x', questions: {} }), /non-empty/);
});
