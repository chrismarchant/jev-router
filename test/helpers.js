'use strict';

const http = require('node:http');

/** Start a mock TypeSafe API on 127.0.0.1:<random>. handler(req) may return a value or a Promise. */
function startMock(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      try {
        const out = (await handler(rec)) || {};
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json', ...(out.headers || {}) });
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: String(err) }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })
    );
  });
}

/** A canned /v1/systemone + /v1/models handler. Records every request in `calls`. */
function mockTypeSafe(opts = {}) {
  const calls = [];
  const handler = async (req) => {
    calls.push(req);
    if (req.url === '/v1/models') return { body: { models: [{ name: 'jev-latest' }, { name: 'jev-preview', description: 'preview' }] } };
    if (req.url === '/v1/systemone') {
      const systemOneCalls = calls.filter((c) => c.url === '/v1/systemone');
      if (opts.failOnce429 && systemOneCalls.length === 1) {
        return { status: 429, body: { detail: 'rate limited' }, headers: { 'retry-after': '0' } };
      }
      if (opts.always422) return { status: 422, body: { detail: [{ loc: ['body', 'questions'], msg: 'malformed question' }] } };
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const b = JSON.parse(req.body);
      return { body: { model: b.model, answers: answerAll(b.questions), usage: { input_tokens: 100, output_tokens: 10 } } };
    }
    return { status: 404, body: { detail: 'not found' } };
  };
  return { handler, calls };
}

/** Produce a canned answer for every question, like the real API would. */
function answerAll(questions) {
  const answers = {};
  for (const [id, q] of Object.entries(questions || {})) {
    if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
    else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      answers[id] = { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.8 : 0.2])), confidence: 0.8 };
    } else if (q.type === 'score') {
      answers[id] = { type: 'score', score: 1.5, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, legend: {}, confidence: 0.7 };
    } else if (q.type === 'box') {
      answers[id] = { type: 'box', box: { left: 0.1, top: 0.2, right: 0.5, bottom: 0.6 }, confidence: 0.66 };
    }
  }
  return answers;
}

/** A fake client object with the same surface as createClient(), backed by answerAll(). */
function fakeClient(overrides = {}) {
  const calls = [];
  return {
    apiBase: 'http://fake',
    defaultModel: 'jev-latest',
    calls,
    async systemOne(args) {
      calls.push(args);
      if (overrides.systemOne) return overrides.systemOne(args);
      return { model: args.model || 'jev-latest', answers: answerAll(args.questions), usage: { input_tokens: 100, output_tokens: 10 } };
    },
    async listModels() {
      return { models: [{ name: 'jev-latest' }] };
    },
  };
}

module.exports = { startMock, mockTypeSafe, answerAll, fakeClient };
