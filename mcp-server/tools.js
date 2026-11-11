'use strict';

/**
 * jev-router MCP tools: route parallel-workstream DECISIONS to the Jev
 * System One model. Jev does not generate text or code — it answers typed
 * questions (noul / choice / score / box) about a `state`, so the host agent
 * keeps doing the work and Jev decides what/where/how urgent/how to verify.
 *
 * Docs: https://docs.typesafe.ai/patterns/fan-out.md (speculative fan-out),
 *       https://docs.typesafe.ai/primitives/box.md
 */

const fs = require('node:fs');
const path = require('node:path');
const { noul, choice, score, box, normalizeQuestions, validateQuestions } = require('./questions');

const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || '200000', 10);
const DEFAULT_MAX_CANDIDATES = parseInt(process.env.JEV_ROUTER_MAX_CANDIDATES || '24', 10);
const DEFAULT_CONCURRENCY = Math.min(16, Math.max(1, parseInt(process.env.JEV_ROUTER_CONCURRENCY || '6', 10)));

const DEFAULT_LANES = {
  feature: 'New functionality or user-facing behavior',
  bugfix: 'Fixing broken or incorrect behavior',
  refactor: 'Internal restructuring with no behavior change',
  tests: 'Adding, fixing, or improving tests',
  docs: 'Documentation, examples, comments',
  infra: 'Build, CI, dependencies, configuration, tooling',
  review: 'Analysis, audit, or verification only (no code changes)',
  research: 'Investigation or spike; output is findings, not code',
};

const PRIORITY_LEVELS = [
  '0 — P0: blocks every other workstream',
  '1 — P1: required for the overall task to be complete',
  '2 — P2: should have, task works without it',
  '3 — P3: nice to have',
];

const RISK_LEVELS = [
  '0 — trivial, no side effects',
  '1 — low, isolated change',
  '2 — medium, touches shared code',
  '3 — high, likely conflicts or regressions',
  '4 — critical, core paths affected',
];

const SIZE_LEVELS = [
  '0 — tiny (minutes)',
  '1 — small (under a day)',
  '2 — medium (1-2 days)',
  '3 — large (multi-day)',
  '4 — epic (should be split further)',
];

/* ---------- helpers ---------- */

function readFileContext(files) {
  if (!Array.isArray(files) || files.length === 0) return {};
  const out = {};
  let remaining = MAX_CONTEXT_CHARS;
  for (const f of files) {
    if (remaining <= 0) break;
    const p = path.resolve(process.cwd(), String(f));
    try {
      let content = fs.readFileSync(p, 'utf8');
      if (content.length > remaining) content = content.slice(0, remaining) + '\n... [truncated by MAX_CONTEXT_CHARS]';
      remaining -= content.length;
      out[String(f)] = content;
    } catch (err) {
      out[String(f)] = `[unreadable: ${err.message}]`;
    }
  }
  return out;
}

function sanitizeId(id, fallback) {
  const clean = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean || fallback;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve assets given as { placeholder: { data_base64, format } } or { placeholder: { path, format? } }. */
function resolveAssets(assets) {
  if (!assets || typeof assets !== 'object') return assets;
  const out = {};
  for (const [key, a] of Object.entries(assets)) {
    if (!a || typeof a !== 'object') throw new TypeError(`assets.${key} must be an object.`);
    if (a.path) {
      const p = path.resolve(process.cwd(), String(a.path));
      const buf = fs.readFileSync(p);
      out[key] = { type: 'image', format: a.format || detectImageFormat(buf, p), data_base64: buf.toString('base64') };
    } else if (a.data_base64) {
      out[key] = { type: 'image', format: a.format || 'png', data_base64: a.data_base64 };
    } else {
      throw new TypeError(`assets.${key} needs either "path" or "data_base64".`);
    }
  }
  return out;
}

function detectImageFormat(buf, p) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  const ext = path.extname(String(p || '')).replace('.', '').toLowerCase();
  if (ext === 'jpeg' || ext === 'jpe') return 'jpeg';
  if (ext === 'jpg' || ext === 'png') return ext;
  throw new TypeError('Image must be PNG or JPEG (detected from bytes or file extension).');
}

/* ---------- tool handlers (each returns a plain object) ---------- */

async function hModels(args, client) {
  const models = await client.listModels({ timeoutMs: args.timeout_ms });
  return {
    endpoint: `${client.apiBase}/v1/models`,
    default_model: client.defaultModel,
    models,
  };
}

async function hAsk(args, client) {
  const questions = validateQuestions(normalizeQuestions(args.questions));
  const res = await client.systemOne({
    model: args.model,
    state: args.state,
    questions,
    assets: resolveAssets(args.assets),
    headers: args.headers,
    timeoutMs: args.timeout_ms,
  });
  return res;
}

async function hFanOut(args, client) {
  const questions = validateQuestions(normalizeQuestions(args.questions));
  const minConfidence = args.min_confidence === undefined ? null : num(args.min_confidence, null);
  const res = await client.systemOne({
    model: args.model,
    state: args.state,
    questions,
    assets: resolveAssets(args.assets),
    headers: args.headers,
    timeoutMs: args.timeout_ms,
  });
  // Speculative fan-out: every question is answered in parallel in one request;
  // the caller (or this tool) discards answers it does not need afterwards.
  const discarded = [];
  if (minConfidence !== null) {
    for (const [id, a] of Object.entries(res.answers || {})) {
      const conf = a && typeof a.confidence === 'number' ? a.confidence : null;
      if (conf !== null && conf < minConfidence) discarded.push({ id, confidence: conf });
    }
  }
  return {
    model: res.model,
    answers: res.answers,
    usage: res.usage,
    question_count: Object.keys(questions).length,
    discarded_below_confidence: discarded,
    note: 'One request, all questions evaluated in parallel. Answers you do not need are simply ignored in code.',
  };
}

async function hPlan(args, client) {
  if (!args.task || typeof args.task !== 'string') throw new TypeError('"task" (string) is required.');
  if (!Array.isArray(args.candidates) || args.candidates.length === 0) {
    throw new TypeError('"candidates" must be a non-empty array of workstream descriptions (strings or {id, description}).');
  }
  const maxCandidates = Math.max(1, num(args.max_candidates, DEFAULT_MAX_CANDIDATES));
  if (args.candidates.length > maxCandidates) {
    throw new TypeError(`Too many candidates (${args.candidates.length}); max is ${maxCandidates} (set max_candidates / JEV_ROUTER_MAX_CANDIDATES).`);
  }
  const lanes = args.lanes && typeof args.lanes === 'object' && Object.keys(args.lanes).length > 0 ? args.lanes : DEFAULT_LANES;

  const candidates = args.candidates.map((c, i) => {
    if (typeof c === 'string') return { id: sanitizeId(`ws${i + 1}`, `ws${i + 1}`), description: c };
    if (c && typeof c === 'object' && c.description) {
      return { id: sanitizeId(c.id || `ws${i + 1}`, `ws${i + 1}`), description: String(c.description) };
    }
    throw new TypeError(`candidates[${i}] must be a string or { id?, description }.`);
  });
  // guarantee unique ids
  const seen = new Set();
  for (const c of candidates) {
    let id = c.id, n = 2;
    while (seen.has(id)) id = `${c.id}_${n++}`;
    seen.add(id);
    c.id = id;
  }

  const questions = {
    approach: choice('Should this task be executed as parallel workstreams, sequentially, or a hybrid (some workstreams in parallel, some after others)?', {
      parallel: 'The workstreams are independent enough to run all at once',
      sequential: 'Workstreams depend on each other and must run one after another',
      hybrid: 'Some workstreams can run in parallel; others must wait',
    }),
    task_complexity: score('How complex is the overall task?', RISK_LEVELS),
  };
  for (const c of candidates) {
    const id = c.id;
    questions[`${id}__lane`] = choice(`Which lane best fits this workstream: "${c.description}"?`, lanes);
    questions[`${id}__priority`] = score(`How important/urgent is this workstream for the overall task: "${c.description}"?`, PRIORITY_LEVELS);
    questions[`${id}__risk`] = score(`How risky is this workstream (chance of breaking or conflicting with other parts): "${c.description}"?`, RISK_LEVELS);
    questions[`${id}__size`] = score(`How big is this workstream: "${c.description}"?`, SIZE_LEVELS);
    questions[`${id}__independent`] = noul(`Is this workstream independent — can it run in parallel without waiting for any other workstream's output: "${c.description}"?`);
    questions[`${id}__conflicts`] = noul(`Does this workstream modify or depend on files/code that another listed workstream also modifies (merge-conflict risk): "${c.description}"?`);
  }

  const state = {
    task: args.task,
    candidates: candidates.map((c) => ({ id: c.id, description: c.description })),
    context_files: readFileContext(args.files),
    note: 'Answer every question. The coordinator combines the answers in code; speculative answers are simply ignored.',
  };

  const res = await client.systemOne({ model: args.model, state, questions, timeoutMs: args.timeout_ms });
  const answers = res.answers || {};

  const workstreams = candidates.map((c) => {
    const lane = answers[`${c.id}__lane`];
    const priority = answers[`${c.id}__priority`];
    const risk = answers[`${c.id}__risk`];
    const size = answers[`${c.id}__size`];
    const independent = answers[`${c.id}__independent`];
    const conflicts = answers[`${c.id}__conflicts`];
    return {
      id: c.id,
      description: c.description,
      lane: lane ? lane.choice : null,
      lane_confidence: lane && typeof lane.confidence === 'number' ? lane.confidence : null,
      priority: priority ? priority.score : null,
      risk: risk ? risk.score : null,
      size: size ? size.score : null,
      independent: independent ? independent.noul >= 0.5 : null,
      conflicts: conflicts ? conflicts.noul >= 0.5 : null,
      conflict_probability: conflicts ? conflicts.noul : null,
    };
  });

  // Execution order: higher priority first, lower risk first within a priority band.
  workstreams.sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1) || (a.risk ?? 99) - (b.risk ?? 99));

  return {
    task: args.task,
    approach: answers.approach ? answers.approach.choice : null,
    task_complexity: answers.task_complexity ? answers.task_complexity.score : null,
    workstreams,
    parallel_safe: workstreams.filter((w) => w.independent === true && w.conflicts !== true).map((w) => w.id),
    needs_sequential: workstreams.filter((w) => w.independent === false || w.conflicts === true).map((w) => w.id),
    model: res.model,
    usage: res.usage,
    question_count: Object.keys(questions).length,
    note: 'Host agent executes the plan with its own subagents/workers; Jev only made the structured decisions.',
  };
}

async function hRoute(args, client) {
  if (args.item === undefined || args.item === null) throw new TypeError('"item" is required.');
  if (!args.destinations) throw new TypeError('"destinations" (map of name -> description, or array of names) is required.');
  const threshold = num(args.threshold, 0.6);
  const destinations = Array.isArray(args.destinations)
    ? Object.fromEntries(args.destinations.map((d) => [String(d), null]))
    : args.destinations;
  const questions = {
    route: choice('Which destination should handle this item?', destinations),
    // Companion Noul (https://docs.typesafe.ai/patterns/companion-noul.md):
    // lets the caller tell when NO destination fits.
    none_fit: noul('Does NONE of the destinations fit this item (answer yes if it needs a fallback, human review, or a new destination)?'),
  };
  const res = await client.systemOne({ model: args.model, state: args.item, questions, timeoutMs: args.timeout_ms });
  const r = (res.answers || {}).route || {};
  const noneFit = (res.answers || {}).none_fit ? (res.answers || {}).none_fit.noul : null;
  const prob = r.probabilities && r.choice !== undefined ? r.probabilities[r.choice] : undefined;
  const confidence = typeof r.confidence === 'number' ? r.confidence : null;
  const strength = prob ?? confidence ?? 0;
  const act = strength >= threshold && (noneFit === null || noneFit < 0.5);
  return {
    route: r.choice ?? null,
    probability: prob ?? null,
    confidence,
    none_fit: noneFit,
    threshold,
    act,
    recommendation: act ? `route to "${r.choice}"` : 'do not auto-route — low confidence or no destination fits; escalate or add a destination',
    answers: res.answers,
    usage: res.usage,
    model: res.model,
  };
}

async function hReview(args, client) {
  if (args.output === undefined || args.output === null) throw new TypeError('"output" is required.');
  if (!Array.isArray(args.criteria) || args.criteria.length === 0) {
    throw new TypeError('"criteria" must be a non-empty array of { id, check, threshold? }.');
  }
  const passThreshold = num(args.pass_threshold, 0.7);
  const questions = {};
  for (const c of args.criteria) {
    if (!c || !c.id || !c.check) throw new TypeError('each criterion needs { id, check }.');
    questions[sanitizeId(c.id, 'check')] = noul(`Does the output satisfy this acceptance criterion? ${c.check}`);
  }
  if (Array.isArray(args.rubric) && args.rubric.length >= 2) {
    questions.quality = score('Overall quality of the output against this rubric.', args.rubric.map(String));
  }
  const state = {
    output: args.output,
    acceptance_criteria: args.criteria.map((c) => c.check),
  };
  const res = await client.systemOne({ model: args.model, state, questions, timeoutMs: args.timeout_ms });
  const answers = res.answers || {};
  const checks = args.criteria.map((c) => {
    const a = answers[sanitizeId(c.id, 'check')];
    const p = a ? a.noul : null;
    const t = num(c.threshold, passThreshold);
    return { id: c.id, check: c.check, noul: p, threshold: t, passed: p !== null ? p >= t : false };
  });
  const quality = answers.quality ? answers.quality.score : null;
  return {
    pass: checks.every((c) => c.passed),
    checks,
    quality,
    quality_confidence: answers.quality && typeof answers.quality.confidence === 'number' ? answers.quality.confidence : null,
    // Confidence routing (https://docs.typesafe.ai/patterns/confidence-routing.md):
    // low-confidence answers should be re-checked by a stronger route instead of trusted.
    needs_human_review: checks.some((c) => c.noul !== null && c.noul < 0.5),
    usage: res.usage,
    model: res.model,
  };
}

async function hBatch(args, client) {
  if (!Array.isArray(args.items) || args.items.length === 0) throw new TypeError('"items" must be a non-empty array of { id, state, questions, model? }.');
  const concurrency = Math.min(16, Math.max(1, num(args.concurrency, DEFAULT_CONCURRENCY)));
  const results = new Array(args.items.length);
  let next = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let failed = 0;

  async function worker() {
    while (next < args.items.length) {
      const i = next++;
      const item = args.items[i];
      const id = item.id !== undefined ? String(item.id) : `item-${i}`;
      try {
        if (item.state === undefined) throw new TypeError(`items[${i}] ("${id}") is missing "state".`);
        const questions = validateQuestions(normalizeQuestions(item.questions));
        const res = await client.systemOne({
          model: item.model || args.model,
          state: item.state,
          questions,
          assets: resolveAssets(item.assets),
          timeoutMs: item.timeout_ms || args.timeout_ms,
        });
        results[i] = { id, ok: true, model: res.model, answers: res.answers, usage: res.usage };
        if (res.usage) {
          usage.input_tokens += res.usage.input_tokens || 0;
          usage.output_tokens += res.usage.output_tokens || 0;
        }
      } catch (err) {
        failed++;
        results[i] = { id, ok: false, error: String(err.message || err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, args.items.length) }, worker));
  return {
    item_count: args.items.length,
    ok_count: args.items.length - failed,
    failed_count: failed,
    concurrency,
    results,
    total_usage: usage,
    note: 'Each item got its own request; requests ran in parallel up to "concurrency". Per-item failures do not fail the batch.',
  };
}

async function hBox(args, client) {
  if (!args.image) throw new TypeError('"image" (file path or base64 data) is required.');
  if (!args.instructions) throw new TypeError('"instructions" (what to locate in the image) is required.');
  let buf;
  let format = args.format;
  const img = String(args.image);
  if (img.length < 4096 && !/^[A-Za-z0-9+/=\s]+$/.test(img) && fs.existsSync(path.resolve(process.cwd(), img))) {
    const p = path.resolve(process.cwd(), img);
    buf = fs.readFileSync(p);
    format = format || detectImageFormat(buf, p);
  } else {
    buf = Buffer.from(img.replace(/\s+/g, ''), 'base64');
    format = format || detectImageFormat(buf, '');
  }
  if (!['png', 'jpg', 'jpeg'].includes(format)) throw new TypeError('Image format must be png, jpg, or jpeg (PNG/JPEG only).');
  const assets = { img: { type: 'image', format, data_base64: buf.toString('base64') } };
  const questions = { locate: box(String(args.instructions)) };
  const res = await client.systemOne({
    model: args.model,
    state: { image: 'img' }, // 'img' is the asset placeholder; it is replaced by the image bytes
    questions,
    assets,
    timeoutMs: args.timeout_ms,
  });
  const locate = (res.answers || {}).locate || {};
  return {
    box: locate.box || null, // { left, top, right, bottom } as fractions of width/height from top-left
    confidence: typeof locate.confidence === 'number' ? locate.confidence : null,
    instructions: args.instructions,
    model: res.model,
    usage: res.usage,
    note: 'Box answers are dreamer-ready/experimental. Edges are fractions of the image size, so they work at any resolution.',
  };
}

/* ---------- MCP tool catalogue ---------- */

const TOOLS = [
  {
    name: 'jev_models',
    description:
      'List the TypeSafe System One models/aliases available to TYPESAFE_API_KEY (GET /v1/models) and the router default model.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'integer', description: 'Request timeout in ms (default JEV_ROUTER_TIMEOUT_MS or 60000).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'jev_ask',
    description:
      'Ask the Jev System One model typed questions about a "state" in ONE request (POST /v1/systemone). ' +
      'Questions: { name: { type: "noul"|"choice"|"score"|"box", instructions, criteria? } }. ' +
      'choice criteria = map of option->description; score criteria = array of ordered level descriptions (>=2); box needs an image asset. ' +
      'Returns { model, answers, usage }. Answers are keyed by question name.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model name/alias (default TYPESAFE_MODEL or jev-latest).' },
        state: { description: 'Content to evaluate: a string or any JSON object.', },
        questions: { type: 'object', description: 'Map of question name -> question ({type, instructions, criteria?}), or array of {id, type, instructions, criteria?}.' },
        assets: { type: 'object', description: 'Optional image assets: { placeholder: { path } or { data_base64, format } }. Placeholder strings inside state/instructions are replaced by the image. Requires the images danger-zone header (JEV_ROUTER_ALLOW_IMAGES=true, default).' },
        headers: { type: 'object', description: 'Extra request headers (e.g. {"TypeSafe-Danger-Zone-Long-Context": "true"}).' },
        timeout_ms: { type: 'integer' },
      },
      required: ['state', 'questions'],
      additionalProperties: false,
    },
  },
  {
    name: 'jev_fan_out',
    description:
      'Speculative fan-out (https://docs.typesafe.ai/patterns/fan-out.md): send MANY questions about one state in a single request — ' +
      'they are all evaluated in parallel, so extra (even speculative) questions cost little latency — then keep only the answers you need in code. ' +
      'Optionally pass min_confidence to list answers below that confidence as discarded.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        state: { description: 'String or JSON object all questions refer to.' },
        questions: { type: 'object', description: 'Many questions at once: { name: {type, instructions, criteria?} } or array form.' },
        assets: { type: 'object' },
        headers: { type: 'object' },
        min_confidence: { type: 'number', description: 'If set, answers with confidence below this are reported in discarded_below_confidence.' },
        timeout_ms: { type: 'integer' },
      },
      required: ['state', 'questions'],
      additionalProperties: false,
    },
  },
  {
    name: 'jev_plan_workstreams',
    description:
      'Open parallel workstreams for a task: the host agent proposes candidate workstreams, and ONE speculative fan-out request asks Jev ' +
      'per candidate for lane (choice), priority/risk/size (scores), independence and conflict risk (nouls), plus a global approach (parallel/sequential/hybrid). ' +
      'Returns a structured plan: ordered workstreams, parallel_safe ids, needs_sequential ids, usage. The host agent then executes the plan with its own subagents.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The overall task to decompose.' },
        candidates: {
          type: 'array',
          description: 'Candidate workstreams: strings or { id?, description } objects. Max 24 by default (max_candidates).',
          items: {},
        },
        files: { type: 'array', items: { type: 'string' }, description: 'Repo files (relative to cwd) to include as context, capped by MAX_CONTEXT_CHARS.' },
        lanes: { type: 'object', description: 'Override the default lane map { lane: description }.' },
        max_candidates: { type: 'integer' },
        model: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['task', 'candidates'],
      additionalProperties: false,
    },
  },
  {
    name: 'jev_route',
    description:
      'Route one item to a destination: a Choice over destinations plus a companion Noul ("none fit"), combined with a probability/confidence ' +
      'threshold (https://docs.typesafe.ai/patterns/probability-routing.md). Returns { route, probability, confidence, act, recommendation, answers, usage }.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { description: 'The thing to route (string or JSON object): ticket, PR, file, message...' },
        destinations: { description: 'Map of destination name -> description, or array of names.' },
        threshold: { type: 'number', description: 'Min probability (or confidence) of the chosen destination to auto-route (default 0.6).' },
        model: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['item', 'destinations'],
      additionalProperties: false,
    },
  },
  {
    name: 'jev_review',
    description:
      'Verify a workstream output against acceptance criteria: one Noul per criterion plus an optional overall quality Score, ' +
      'with per-check thresholds (default pass_threshold 0.7). Returns { pass, checks[], quality, needs_human_review, usage }.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { description: 'The output to verify (string or JSON object): diff, report, answer...' },
        criteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, check: { type: 'string' }, threshold: { type: 'number' } }, required: ['id', 'check'] } },
        rubric: { type: 'array', items: { type: 'string' }, description: 'Optional ordered quality levels (>=2) for one overall Score question.' },
        pass_threshold: { type: 'number', description: 'Default per-check Noul threshold (default 0.7).' },
        model: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['output', 'criteria'],
      additionalProperties: false,
    },
  },
  {
    name: 'jev_batch',
    description:
      'Offload MANY independent items to Jev in parallel: each item has its own state + questions and gets its own request; ' +
      'requests run concurrently up to "concurrency" (default 6, max 16). Per-item failures are reported, not fatal. Returns per-item answers + total usage.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              state: {},
              questions: { type: 'object' },
              assets: { type: 'object' },
              model: { type: 'string' },
              timeout_ms: { type: 'integer' },
            },
            required: ['state', 'questions'],
          },
        },
        concurrency: { type: 'integer', description: 'Max in-flight requests (default JEV_ROUTER_CONCURRENCY or 6, max 16).' },
        model: { type: 'string', description: 'Default model for items that do not set one.' },
        timeout_ms: { type: 'integer' },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'jev_box',
    description:
      'Locate something in an image with the Box primitive (https://docs.typesafe.ai/primitives/box.md): sends the image as an asset ' +
      '(with the experimental images header) and one box question. Returns { box: {left, top, right, bottom} } as fractions of the image size, plus confidence. Dreamer-ready/experimental.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Path to a PNG/JPEG file (relative to cwd) or base64 data.' },
        instructions: { type: 'string', description: 'What to locate, e.g. "the submit button in `img`" (does not have to be a question).' },
        format: { type: 'string', enum: ['png', 'jpg', 'jpeg'], description: 'Image format; auto-detected from bytes/extension when omitted.' },
        model: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['image', 'instructions'],
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  jev_models: hModels,
  jev_ask: hAsk,
  jev_fan_out: hFanOut,
  jev_plan_workstreams: hPlan,
  jev_route: hRoute,
  jev_review: hReview,
  jev_batch: hBatch,
  jev_box: hBox,
};

/** Call a tool by name; returns a plain object (the MCP layer stringifies it). */
async function callTool(name, args, client) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}. Available: ${Object.keys(HANDLERS).join(', ')}`);
  return handler(args || {}, client);
}

module.exports = { TOOLS, HANDLERS, callTool };
