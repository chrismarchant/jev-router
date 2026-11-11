'use strict';

/**
 * jev-router MCP tools: route parallel-workstream DECISIONS to the Jev
 * System One model. Jev does not generate text or code — it answers typed
 * questions (noul / choice / score / box) about a `state`, so the host agent
 * keeps doing the work and Jev decides what/where/how urgent/how to verify.
 *
 * Behavior is encoded from the TypeSafe docs:
 * - Speculative fan-out is the DEFAULT: every question that shares a state
 *   goes in ONE request (there is no question-count limit, only context
 *   limits — 64k tokens per-request / 32k per-question). Extra questions are
 *   evaluated in parallel and discarded in code.
 *   https://docs.typesafe.ai/patterns/fan-out.md
 * - Companion Noul beside every Choice (route / plan / box).
 *   https://docs.typesafe.ai/patterns/companion-noul.md
 * - Probability-routing (threshold on the probability of the option you act
 *   on) + confidence-routing (check confidence first; below the floor,
 *   escalate). https://docs.typesafe.ai/patterns/probability-routing.md
 * - Noul three-band reading: >0.7 yes, <0.3 no, in between its own outcome
 *   (Nouls carry no separate `confidence`; |2p-1| puts them on the same
 *   0..1 scale if needed). https://docs.typesafe.ai/confidence.md
 * - Composite scoring: atomic scores combined with weights in code (plan).
 *   https://docs.typesafe.ai/patterns/composite-scoring.md
 * - Jev limitations (AI primer + model jaggedness): Jev never generates text,
 *   is not a calculator (no math/counting/date comparison), reads literally,
 *   suffers context rot with irrelevant state, and Choice option order can
 *   bias answers. So: filter state in code, reference fields by name, never
 *   ask Jev to compute, and draft closed option sets with a small generative
 *   LLM (jev_draft_options, default mistral-small-latest) — Jev only picks.
 */

const fs = require('node:fs');
const path = require('node:path');
const { noul, choice, score, box, normalizeQuestions, validateQuestions } = require('./questions');

// Jev context limits: 64k tokens per-request / 32k per-question, and `state`
// counts against BOTH. ~4 chars/token, so keep state well under 32k tokens.
// Raise via JEV_ROUTER_LONG_CONTEXT=true (TypeSafe-Danger-Zone-Long-Context
// header -> 262k, but slower and less accurate).
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || '120000', 10);
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

// Noul reading bands (docs.typesafe.ai/primitives/noul + confidence).
const NOUL_YES_ABOVE = 0.7;
const NOUL_NO_BELOW = 0.3;
// Confidence floor (docs.typesafe.ai/patterns/confidence-routing.md): below
// this, do not act — escalate.
const CONFIDENCE_FLOOR = 0.5;

function noulBand(p) {
  if (p === null || p === undefined) return null;
  return p > NOUL_YES_ABOVE ? 'clear_yes' : p < NOUL_NO_BELOW ? 'clear_no' : 'uncertain';
}

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
    limits_note:
      'Jev context limits: 64k tokens per-request AND 32k per-question (state counts against both). ' +
      'Long context (262k) needs TypeSafe-Danger-Zone-Long-Context: true (JEV_ROUTER_LONG_CONTEXT=true) but is slower and less accurate. ' +
      'Box questions need Jev 1.14+. Aliases (jev-latest) move between releases — the response "model" field has the versioned ID; pin it if you tuned thresholds. ' +
      'Input is billed per token (~$0.042/M); output tokens are free.',
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
  // Speculative fan-out: ONE request, all questions evaluated in parallel; the
  // caller (or this tool) discards the answers it does not need afterwards.
  const discarded = [];
  if (minConfidence !== null) {
    for (const [id, a] of Object.entries(res.answers || {})) {
      let conf = a && typeof a.confidence === 'number' ? a.confidence : null;
      // Nouls carry no confidence; |2p-1| puts the noul on the same 0..1 scale
      // (docs.typesafe.ai/confidence.md) when noul_confidence is enabled.
      if (conf === null && args.noul_confidence === true && a && a.type === 'noul' && typeof a.noul === 'number') {
        conf = Math.abs(2 * a.noul - 1);
      }
      if (conf !== null && conf < minConfidence) discarded.push({ id, confidence: conf });
    }
  }
  return {
    model: res.model,
    answers: res.answers,
    usage: res.usage,
    question_count: Object.keys(questions).length,
    discarded_below_confidence: discarded,
    note: 'One request, all questions evaluated in parallel (no question-count limit — only context limits). Answers you do not need are simply ignored in code.',
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
  // Composite-scoring weights (docs.typesafe.ai/patterns/composite-scoring.md):
  // atomic scores normalized to 0..1, combined with weights in code.
  const weights = args.weights && typeof args.weights === 'object'
    ? { priority: num(args.weights.priority, 1), risk: num(args.weights.risk, -1), size: num(args.weights.size, 0) }
    : { priority: 1, risk: -1, size: 0 };

  const candidates = args.candidates.map((c, i) => {
    if (typeof c === 'string') return { id: sanitizeId(`ws${i + 1}`, `ws${i + 1}`), description: c };
    if (c && typeof c === 'object' && c.description) {
      return { id: sanitizeId(c.id || `ws${i + 1}`, `ws${i + 1}`), description: String(c.description) };
    }
    throw new TypeError(`candidates[${i}] must be a string or { id?, description }.`);
  });
  const seen = new Set();
  for (const c of candidates) {
    let id = c.id, n = 2;
    while (seen.has(id)) id = `${c.id}_${n++}`;
    seen.add(id);
    c.id = id;
  }

  // ONE request, all questions in parallel (speculative fan-out). Instructions
  // reference state fields by name/path (jaggedness: avoid indirection).
  const questions = {
    approach: choice('Should this task be executed as parallel workstreams, sequentially, or a hybrid?', {
      parallel: 'The workstreams are independent enough to run all at once',
      sequential: 'Workstreams depend on each other and must run one after another',
      hybrid: 'Some workstreams can run in parallel; others must wait',
    }),
    task_complexity: score('How complex is the overall task `task`?', RISK_LEVELS),
  };
  candidates.forEach((c, i) => {
    const id = c.id;
    const ref = `\`candidates[${i}].description\``;
    questions[`${id}__lane`] = choice(`Which lane best fits the workstream described at ${ref}?`, lanes);
    // companion noul: a Choice always picks one — this says whether any lane fits
    questions[`${id}__lane_fits`] = noul(`Does at least one of the lanes fit the workstream described at ${ref}?`);
    questions[`${id}__priority`] = score(`How important/urgent is the workstream at ${ref} for the overall task \`task\`?`, PRIORITY_LEVELS);
    questions[`${id}__risk`] = score(`How risky is the workstream at ${ref} (chance of breaking or conflicting with other parts)?`, RISK_LEVELS);
    questions[`${id}__size`] = score(`How big is the workstream at ${ref}?`, SIZE_LEVELS);
    questions[`${id}__independent`] = noul(`Is the workstream at ${ref} independent — can it run in parallel without waiting for any other workstream in \`candidates\`?`);
    questions[`${id}__conflicts`] = noul(`Does the workstream at ${ref} modify or depend on files/code that another entry in \`candidates\` also modifies (merge-conflict risk)?`);
  });

  const state = {
    task: args.task,
    candidates: candidates.map((c) => ({ id: c.id, description: c.description })),
    context_files: readFileContext(args.files),
    note: 'Answer every question. The coordinator combines the answers in code; speculative answers are simply ignored.',
  };

  const res = await client.systemOne({ model: args.model, state, questions, timeoutMs: args.timeout_ms });
  const answers = res.answers || {};
  const norm = (v, max) => (typeof v === 'number' ? v / max : null);

  const workstreams = candidates.map((c, i) => {
    const lane = answers[`${c.id}__lane`];
    const laneFits = answers[`${c.id}__lane_fits`];
    const priority = answers[`${c.id}__priority`];
    const risk = answers[`${c.id}__risk`];
    const size = answers[`${c.id}__size`];
    const independent = answers[`${c.id}__independent`];
    const conflicts = answers[`${c.id}__conflicts`];
    const p = priority ? priority.score : null;
    const r = risk ? risk.score : null;
    const s = size ? size.score : null;
    const laneConfidence = lane && typeof lane.confidence === 'number' ? lane.confidence : null;
    const fits = laneFits ? laneFits.noul : null;
    const parts = [weights.priority * (norm(p, 3) ?? 0), weights.risk * (norm(r, 4) ?? 0), weights.size * (norm(s, 4) ?? 0)];
    const composite = (p === null && r === null && s === null) ? null : parts.reduce((a, b) => a + b, 0);
    return {
      id: c.id,
      description: c.description,
      lane: lane ? lane.choice : null,
      lane_confidence: laneConfidence,
      lane_fits: fits,
      lane_fits_band: noulBand(fits),
      lane_uncertain: (fits !== null && fits <= NOUL_YES_ABOVE) || (laneConfidence !== null && laneConfidence < CONFIDENCE_FLOOR),
      priority: p,
      priority_confidence: priority && typeof priority.confidence === 'number' ? priority.confidence : null,
      risk: r,
      size: s,
      independent: independent ? independent.noul >= 0.5 : null,
      conflicts: conflicts ? conflicts.noul >= 0.5 : null,
      conflict_probability: conflicts ? conflicts.noul : null,
      composite,
    };
  });

  // Composite ordering: weighted normalized scores, highest first.
  workstreams.sort((a, b) => (b.composite ?? -Infinity) - (a.composite ?? -Infinity));

  return {
    task: args.task,
    approach: answers.approach ? answers.approach.choice : null,
    task_complexity: answers.task_complexity ? answers.task_complexity.score : null,
    weights,
    workstreams,
    parallel_safe: workstreams.filter((w) => w.independent === true && w.conflicts !== true).map((w) => w.id),
    needs_sequential: workstreams.filter((w) => w.independent === false || w.conflicts === true).map((w) => w.id),
    model: res.model,
    usage: res.usage,
    question_count: Object.keys(questions).length,
    note: 'Host agent executes the plan with its own subagents/workers; Jev only made the structured decisions. One request, all questions in parallel.',
  };
}

async function hRoute(args, client) {
  if (args.item === undefined || args.item === null) throw new TypeError('"item" is required.');
  if (!args.destinations) throw new TypeError('"destinations" (map of name -> description, or array of names) is required.');
  const threshold = num(args.threshold, 0.6); // probability-routing: threshold on the probability of the option you act on
  const confidenceFloor = num(args.confidence_floor, CONFIDENCE_FLOOR); // confidence-routing: check confidence first
  const destinations = Array.isArray(args.destinations)
    ? Object.fromEntries(args.destinations.map((d) => [String(d), null]))
    : args.destinations;
  const questions = {
    route: choice('Which destination should handle this item? Reference fields of the item by name where useful.', destinations),
    // companion noul (patterns/companion-noul.md): a Choice always picks one,
    // even when nothing fits — this noul says whether any destination fits.
    any_fit: noul('Does at least one of the listed destinations fit this item?'),
  };
  const res = await client.systemOne({ model: args.model, state: args.item, questions, timeoutMs: args.timeout_ms });
  const answers = res.answers || {};
  const r = answers.route || {};
  const anyFit = answers.any_fit ? answers.any_fit.noul : null;
  const prob = r.probabilities && r.choice !== undefined ? r.probabilities[r.choice] : undefined;
  const confidence = typeof r.confidence === 'number' ? r.confidence : null;
  const fitBand = noulBand(anyFit);
  const strength = prob ?? confidence ?? 0;
  const confidentEnough = confidence === null || confidence >= confidenceFloor;
  const act = strength >= threshold && fitBand === 'clear_yes' && confidentEnough;
  let recommendation;
  if (fitBand === 'clear_no') recommendation = 'no destination fits — use a fallback, human review, or add a destination';
  else if (!confidentEnough) recommendation = `low confidence (${confidence}) — escalate to a person instead of auto-routing`;
  else if (strength < threshold) recommendation = `probability ${strength} below threshold ${threshold} — clarify or escalate`;
  else recommendation = `route to "${r.choice}"`;
  return {
    route: r.choice ?? null,
    probability: prob ?? null,
    confidence,
    any_fit: anyFit,
    fit_band: fitBand,
    threshold,
    confidence_floor: confidenceFloor,
    act,
    recommendation,
    answers,
    usage: res.usage,
    model: res.model,
  };
}

async function hReview(args, client) {
  if (args.output === undefined || args.output === null) throw new TypeError('"output" is required.');
  if (!Array.isArray(args.criteria) || args.criteria.length === 0) {
    throw new TypeError('"criteria" must be a non-empty array of { id, check, threshold?, fail_below? }.');
  }
  const passThreshold = num(args.pass_threshold, NOUL_YES_ABOVE);
  const failBelow = num(args.fail_below, NOUL_NO_BELOW);
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
    const fb = num(c.fail_below, failBelow);
    // three-band noul reading: >= threshold pass, < fail_below fail, else uncertain
    const status = p === null || p === undefined ? 'unknown' : p >= t ? 'pass' : p < fb ? 'fail' : 'uncertain';
    return { id: c.id, check: c.check, noul: p, threshold: t, fail_below: fb, status, passed: status === 'pass' };
  });
  const quality = answers.quality ? answers.quality.score : null;
  const qualityConfidence = answers.quality && typeof answers.quality.confidence === 'number' ? answers.quality.confidence : null;
  // confidence-routing on the quality score: check confidence first
  const qualityUncertain = qualityConfidence !== null && qualityConfidence < CONFIDENCE_FLOOR;
  return {
    pass: checks.every((c) => c.passed),
    checks,
    quality,
    quality_confidence: qualityConfidence,
    quality_uncertain: quality ? qualityUncertain : null,
    needs_human_review: checks.some((c) => c.status !== 'pass') || qualityUncertain,
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
    note: 'Each item has its OWN state, so each gets its own request (use jev_fan_out when many questions share ONE state); requests ran in parallel up to "concurrency". Per-item failures do not fail the batch.',
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
  const target = String(args.instructions).replace(/"/g, "'");
  const questions = {
    locate: box(String(args.instructions)),
    // a Box always returns a location — pair it with a Noul asking whether the
    // target is in the image at all (docs.typesafe.ai/primitives).
    present: noul(`Is the target described as "${target}" actually present and visible in the image \`img\`?`),
  };
  const res = await client.systemOne({
    model: args.model,
    state: { image: 'img' }, // 'img' is the asset placeholder; it is replaced by the image bytes
    questions,
    assets,
    timeoutMs: args.timeout_ms,
  });
  const locate = (res.answers || {}).locate || {};
  const present = (res.answers || {}).present || {};
  const presentNoul = typeof present.noul === 'number' ? present.noul : null;
  return {
    present: presentNoul,
    present_band: noulBand(presentNoul),
    box: locate.box || null, // { left, top, right, bottom } as fractions of width/height from top-left
    confidence: typeof locate.confidence === 'number' ? locate.confidence : null,
    instructions: args.instructions,
    model: res.model,
    usage: res.usage,
    note: 'Box answers are dreamer-ready/experimental and need Jev 1.14+. Edges are fractions of the image size. There is no recommended confidence threshold: if confidence is low, re-ask on a larger image or a higher-resolution crop, and pad the box edges before cropping so the target is not cut off. If present is clear_no, the box is meaningless.',
  };
}

/**
 * Draft a closed option set with a SMALL generative LLM (default
 * mistral-small-latest via the Mistral API). Jev never generates text
 * (model jaggedness: "Generation"), so option sets for Choice criteria /
 * route destinations / plan lanes are drafted here and Jev only PICKS from
 * them. Requires MISTRAL_API_KEY; Jev decisions still need TYPESAFE_API_KEY.
 */
async function hDraftOptions(args) {
  if (!args.topic || typeof args.topic !== 'string') throw new TypeError('"topic" (string) is required.');
  const apiKey = process.env.MISTRAL_API_KEY || '';
  if (!apiKey) {
    throw new TypeError(
      'MISTRAL_API_KEY is not set. jev_draft_options uses a lightweight generative model (default mistral-small-latest, ' +
      'override with "model" / JEV_ROUTER_DRAFT_MODEL) ONLY to draft closed option sets for Choice criteria / destinations / lanes — ' +
      'Jev still makes every decision. Set MISTRAL_API_KEY (https://console.mistral.ai) or write the options yourself and skip this tool.'
    );
  }
  const base = String(process.env.MISTRAL_API_BASE || 'https://api.mistral.ai/v1').replace(/\/+$/, '');
  const model = args.model || process.env.JEV_ROUTER_DRAFT_MODEL || 'mistral-small-latest';
  const count = Math.min(64, Math.max(2, num(args.count, 8)));
  const timeoutMs = num(args.timeout_ms, 30000);
  const system =
    'You draft closed option sets for a decision model (TypeSafe Jev, System One). You NEVER make the decision yourself; you only ' +
    'propose a clear, mutually exclusive set of options, each with a one-line description usable as a Choice criterion. Reply with ' +
    'STRICT JSON only, no markdown fences: {"options": [{"name": "snake_case_id", "description": "one line"}, ...]}. Produce exactly ' +
    'the requested number of options unless fewer are genuinely distinct. Never include secrets, personal data, or credentials.';
  const user = `Topic: ${args.topic}\n${args.context ? `Context:\n${String(args.context).slice(0, 4000)}\n` : ''}Propose up to ${count} options for a Choice question about this topic.`;
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 1024,
  };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`Mistral draft request failed: ${err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt === 1) {
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    if (!res.ok) throw new Error(`Mistral API error ${res.status} on POST /chat/completions: ${text.slice(0, 500)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from Mistral: ${text.slice(0, 300)}`);
    }
    lastErr = null;
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Draft model did not return valid JSON: ${content.slice(0, 300)}`);
    }
    const options = Array.isArray(parsed.options) ? parsed.options.filter((o) => o && o.name) : [];
    if (options.length === 0) throw new Error('Draft model returned no options.');
    const criteria = {};
    for (const o of options) criteria[String(o.name)] = o.description ?? null;
    return {
      draft_model: model,
      topic: args.topic,
      options,
      criteria, // ready to pass as Choice criteria / destinations / lanes
      usage: data.usage,
      note: 'Options are proposals from a small generative LLM; Jev (System One) makes the actual decision. Review/edit before sending as Choice criteria, destinations, or lanes. Never send secrets to the draft model.',
    };
  }
  throw lastErr || new Error('Mistral draft request failed.');
}

/* ---------- MCP tool catalogue ---------- */

const TOOLS = [
  {
    name: 'jev_models',
    description:
      'List the TypeSafe System One models/aliases available to TYPESAFE_API_KEY (GET /v1/models), the router default model, and the model limits (context, pricing, Box requirements).',
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
      'choice criteria = map of option->description; score criteria = array of ordered level descriptions (>=2); noul criteria = optional {true, false} descriptions; box needs an image asset. ' +
      'instructions/criteria also accept objects/arrays (structured questions). ' +
      'Returns { model, answers, usage }. Answers are keyed by question name; choice/score/box answers carry probabilities + confidence, noul answers carry just the noul probability.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model name/alias (default TYPESAFE_MODEL or jev-latest). Pin a versioned ID (e.g. jev-1.14.0) if you tuned thresholds.' },
        state: { description: 'Content to evaluate: a string or any JSON object/array.' },
        questions: { type: 'object', description: 'Map of question name -> question ({type, instructions, criteria?}), or array of {id, type, instructions, criteria?}. Question IDs are for your code; write the full question in instructions and reference state fields by `path`.' },
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
      'Speculative fan-out — the DEFAULT way to use Jev (https://docs.typesafe.ai/patterns/fan-out.md): send MANY questions about one state in a SINGLE request. ' +
      'All questions are evaluated in parallel and there is no question-count limit (only context limits), so ask everything you might need and keep only the answers you use in code. ' +
      'Optionally pass min_confidence to list answers below that confidence as discarded (noul_confidence=true also scores nouls via |2p-1|).',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        state: { description: 'String or JSON object all questions refer to.' },
        questions: { type: 'object', description: 'Many questions at once: { name: {type, instructions, criteria?} } or array form.' },
        assets: { type: 'object' },
        headers: { type: 'object' },
        min_confidence: { type: 'number', description: 'If set, answers with confidence below this are reported in discarded_below_confidence.' },
        noul_confidence: { type: 'boolean', description: 'With min_confidence: also score noul answers as |2*noul-1| (nouls carry no confidence of their own).' },
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
      'per candidate for lane (choice + companion noul), priority/risk/size (scores), independence and conflict risk (nouls), plus a global approach (parallel/sequential/hybrid). ' +
      'Atomic scores are combined with "weights" in code (composite scoring). ' +
      'Returns a structured plan: workstreams ordered by composite score, parallel_safe ids, needs_sequential ids, lane_uncertain flags, usage. The host agent then executes the plan with its own subagents.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The overall task to decompose.' },
        candidates: {
          type: 'array',
          description: 'Candidate workstreams: strings or { id?, description } objects. Max 24 by default (max_candidates).',
          items: {},
        },
        files: { type: 'array', items: { type: 'string' }, description: 'Repo files (relative to cwd) to include as context. Keep state lean — Jev suffers context rot; capped by MAX_CONTEXT_CHARS (default 120000; Jev limits are 64k tokens/request and 32k/question).' },
        lanes: { type: 'object', description: 'Override the default lane map { lane: description }. Tip: draft with jev_draft_options.' },
        weights: { type: 'object', description: 'Composite-scoring weights { priority, risk, size } (default { priority: 1, risk: -1, size: 0 }); scores are normalized to 0..1 and combined in code.' },
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
      'Route one item to a destination: a Choice over destinations plus a companion any_fit Noul (patterns/companion-noul.md). ' +
      'Acts only when the probability of the chosen destination clears "threshold" (probability-routing), the companion noul is a clear yes (>0.7), and confidence clears "confidence_floor" (confidence-routing; default 0.5). ' +
      'Returns { route, probability, confidence, any_fit, fit_band, act, recommendation, answers, usage }.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { description: 'The thing to route (string or JSON object): ticket, PR, file, message...' },
        destinations: { description: 'Map of destination name -> description, or array of names. Tip: draft with jev_draft_options.' },
        threshold: { type: 'number', description: 'Min probability of the chosen destination to auto-route (default 0.6). Riskier actions deserve higher thresholds.' },
        confidence_floor: { type: 'number', description: 'Min choice confidence to auto-route (default 0.5); below it, escalate (confidence-routing).' },
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
      'with three-band noul reading (pass >= pass_threshold 0.7, fail < fail_below 0.3, else "uncertain") and a confidence check on the quality score (confidence-routing). ' +
      'Returns { pass, checks[] with status, quality, quality_confidence, needs_human_review, usage }.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { description: 'The output to verify (string or JSON object): diff, report, answer...' },
        criteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, check: { type: 'string' }, threshold: { type: 'number' }, fail_below: { type: 'number' } }, required: ['id', 'check'] } },
        rubric: { type: 'array', items: { type: 'string' }, description: 'Optional ordered quality levels (>=2) for one overall Score question.' },
        pass_threshold: { type: 'number', description: 'Per-check noul threshold for "pass" (default 0.7).' },
        fail_below: { type: 'number', description: 'Per-check noul below which the check "fails" (default 0.3); between fail_below and pass_threshold it is "uncertain".' },
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
      'Offload MANY independent items to Jev in parallel. Use when each item has its OWN state (each gets its own request — when many questions share ONE state, use jev_fan_out instead). ' +
      'Requests run concurrently up to "concurrency" (default 6, max 16). Per-item failures are reported, not fatal. Returns per-item answers + total usage.',
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
      'Locate something in an image with the Box primitive (https://docs.typesafe.ai/primitives/box.md; needs Jev 1.14+ and the experimental images header): sends the image as an asset ' +
      'plus one box question AND a companion "present" Noul (a Box always returns a location, so check the target is actually in the image). ' +
      'Returns { present, present_band, box: {left, top, right, bottom}, confidence } — edges are fractions of the image size.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Path to a PNG/JPEG file (relative to cwd) or base64 data.' },
        instructions: { type: 'string', description: 'What to locate, e.g. "the submit button in `img`" (does not have to be a question).' },
        format: { type: 'string', enum: ['png', 'jpg', 'jpeg'], description: 'Image format; auto-detected from bytes/extension when omitted.' },
        model: { type: 'string', description: 'Use a Jev 1.14+ model (jev-latest default).' },
        timeout_ms: { type: 'integer' },
      },
      required: ['image', 'instructions'],
      additionalProperties: false,
    },
  },
  {
    name: 'jev_draft_options',
    description:
      'Draft a closed option set for Choice criteria / route destinations / plan lanes using a SMALL generative LLM (default mistral-small-latest via the Mistral API; override with "model" / JEV_ROUTER_DRAFT_MODEL). ' +
      'Jev never generates text (model jaggedness), so options are drafted here and Jev only picks from them. Requires MISTRAL_API_KEY. ' +
      'Returns { draft_model, options: [{name, description}], criteria } ready to pass as Choice criteria. Never send secrets to the draft model.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'What the option set is for, e.g. "support ticket categories" or "lanes for a coding task".' },
        context: { type: 'string', description: 'Optional extra context (domain, existing labels, constraints).' },
        count: { type: 'integer', description: 'Number of options to propose (default 8, max 64).' },
        model: { type: 'string', description: 'Draft model (default JEV_ROUTER_DRAFT_MODEL or mistral-small-latest).' },
        timeout_ms: { type: 'integer', description: 'Default 30000.' },
      },
      required: ['topic'],
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
  jev_draft_options: hDraftOptions,
};

/** Call a tool by name; returns a plain object (the MCP layer stringifies it). */
async function callTool(name, args, client) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}. Available: ${Object.keys(HANDLERS).join(', ')}`);
  return handler(args || {}, client);
}

module.exports = { TOOLS, HANDLERS, callTool };
