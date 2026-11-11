'use strict';

/**
 * Zero-dependency client for the TypeSafe System One API (the Jev model).
 *
 *   POST {apiBase}/v1/systemone   — answer one or more typed questions about `state`
 *   GET  {apiBase}/v1/models      — list models/aliases for the API key
 *
 * Docs: https://docs.typesafe.ai/api/system-one.md
 * Spec: https://api.typesafe.ai/openapi.json
 *
 * Uses only the Node standard library (global fetch, Node >= 18).
 */

const DEFAULT_API_BASE = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';

function intOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TypeSafeError extends Error {
  constructor(message, { status, body, pathname } = {}) {
    super(message);
    this.name = 'TypeSafeError';
    this.status = status;
    this.body = body;
    this.pathname = pathname;
  }
}

function backoffMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const s = Number(retryAfterHeader);
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 30000);
  }
  // exponential backoff with jitter: 500ms, 1s, 2s, ... capped at 8s
  return Math.min(500 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
}

function createClient(opts = {}) {
  const apiBase = String(opts.apiBase || process.env.TYPESAFE_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : (process.env.TYPESAFE_API_KEY || '');
  const defaultModel = opts.model || process.env.TYPESAFE_MODEL || DEFAULT_MODEL;
  const timeoutMs = intOr(opts.timeoutMs ?? process.env.JEV_ROUTER_TIMEOUT_MS, 60000);
  const maxRetries = Math.max(0, intOr(opts.maxRetries ?? process.env.JEV_ROUTER_MAX_RETRIES, 3));
  const allowImages = String(opts.allowImages ?? process.env.JEV_ROUTER_ALLOW_IMAGES ?? 'true') !== 'false';
  const longContext = String(opts.longContext ?? process.env.JEV_ROUTER_LONG_CONTEXT ?? 'false') === 'true';

  function requireKey() {
    if (!apiKey) {
      throw new TypeSafeError(
        'TYPESAFE_API_KEY is not set. Get a key at https://console.typesafe.ai/keys ' +
        '(early access is waitlisted) or via the Vercel AI gateway, then export it — ' +
        'e.g. add it to ~/.vibe/.env (Mistral Vibe) or .claude/settings.local.json "env" (Claude Code), ' +
        'or run scripts/set-typesafe-key.sh.'
      );
    }
  }

  async function request(pathname, { method = 'GET', body, extraHeaders, timeoutMs: perReqTimeoutMs } = {}) {
    requireKey();
    const url = `${apiBase}${pathname}`;
    const headers = { Authorization: `Bearer ${apiKey}`, ...(extraHeaders || {}) };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(body);
    }
    if (longContext) headers['TypeSafe-Danger-Zone-Long-Context'] = 'true';

    const effectiveTimeout = perReqTimeoutMs ?? timeoutMs;
    const maxAttempts = maxRetries + 1;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), effectiveTimeout);
      let res;
      try {
        res = await fetch(url, { method, headers, body: payload, signal: ctrl.signal });
      } catch (err) {
        clearTimeout(timer);
        const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
        lastErr = new TypeSafeError(
          `TypeSafe API request failed: ${aborted ? `timed out after ${effectiveTimeout}ms` : err.message}`,
          { pathname }
        );
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw lastErr;
      }
      clearTimeout(timer);
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new TypeSafeError(`Non-JSON response from ${method} ${pathname}: ${text.slice(0, 500)}`, { pathname });
        }
      }
      // 429 / 529 / 5xx are retryable; everything else (400/401/413/415/422/404) is not.
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      lastErr = new TypeSafeError(
        `TypeSafe API error ${res.status} on ${method} ${pathname}: ${text.slice(0, 1000)}`,
        { status: res.status, body: text, pathname }
      );
      if (retryable && attempt < maxAttempts) {
        await sleep(backoffMs(attempt, res.headers.get('retry-after')));
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  function wantsImages(body) {
    if (!body) return false;
    if (body.assets && Object.keys(body.assets).length > 0) return true;
    if (body.questions && Object.values(body.questions).some((q) => q && q.type === 'box')) return true;
    return false;
  }

  /**
   * POST /v1/systemone
   * args: { model?, state, questions, assets?, headers?, timeoutMs? }
   * Returns the parsed { model, answers, usage } response.
   */
  async function systemOne(args = {}) {
    const { state, questions, assets } = args;
    if (state === undefined || state === null) throw new TypeSafeError('"state" is required.');
    if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
      throw new TypeSafeError('"questions" must be a non-empty object mapping question names to questions.');
    }
    const body = { model: args.model || defaultModel, state, questions };
    if (assets && Object.keys(assets).length > 0) body.assets = assets;

    const extraHeaders = { ...(args.headers || {}) };
    if (wantsImages(body)) {
      if (!allowImages) {
        throw new TypeSafeError(
          'This request uses images or a Box question, which require the experimental ' +
          '"TypeSafe-Danger-Zone-Images: true" header. Set JEV_ROUTER_ALLOW_IMAGES=true to opt in.'
        );
      }
      extraHeaders['TypeSafe-Danger-Zone-Images'] = 'true';
    }
    return request('/v1/systemone', { method: 'POST', body, extraHeaders, timeoutMs: args.timeoutMs });
  }

  /** GET /v1/models — list models/aliases available to the API key. */
  async function listModels(args = {}) {
    return request('/v1/models', { method: 'GET', timeoutMs: args.timeoutMs });
  }

  return {
    apiBase,
    defaultModel,
    systemOne,
    listModels,
    request,
  };
}

module.exports = { createClient, TypeSafeError, DEFAULT_API_BASE, DEFAULT_MODEL };
