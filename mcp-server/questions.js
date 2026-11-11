'use strict';

/**
 * Builders + validation for System One question types.
 * Docs: https://docs.typesafe.ai/primitives (choice / score / noul / box)
 */

const QUESTION_TYPES = new Set(['noul', 'choice', 'score', 'box']);

/** Noul: yes/no probability. criteria optional. */
function noul(instructions, criteria) {
  const q = { type: 'noul', instructions };
  if (criteria !== undefined && criteria !== null) q.criteria = criteria;
  return q;
}

/**
 * Choice: pick one option. `options` is either an object map
 * { option: description|null } or an array of option strings.
 */
function choice(instructions, options) {
  let criteria;
  if (Array.isArray(options)) {
    criteria = Object.fromEntries(options.map((o) => [String(o), null]));
  } else if (options && typeof options === 'object') {
    criteria = options;
  } else {
    throw new TypeError('choice() needs an options object map or an array of option strings.');
  }
  if (Object.keys(criteria).length === 0) throw new TypeError('choice() needs at least one option.');
  if (Object.keys(criteria).length > 255) throw new TypeError('choice() accepts at most 255 options.');
  return { type: 'choice', instructions, criteria };
}

/** Score: position on an ordered rubric. `levels` is an array of >=2 level descriptions, lowest first. */
function score(instructions, levels) {
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new TypeError('score() needs an array of at least 2 level descriptions (lowest first).');
  }
  return { type: 'score', instructions, criteria: levels.map(String) };
}

/** Box: locate something in the request's image. Requires an image asset + images header. */
function box(instructions) {
  return { type: 'box', instructions };
}

/** Accepts either { name: question } or [{ id, ...question }] and returns the { name: question } form. */
function normalizeQuestions(input) {
  if (Array.isArray(input)) {
    const out = {};
    for (const item of input) {
      if (!item || typeof item !== 'object' || !item.id) throw new TypeError('Array-form questions need an "id" field.');
      const { id, ...q } = item;
      if (out[id]) throw new TypeError(`Duplicate question id "${id}".`);
      out[id] = q;
    }
    return out;
  }
  if (input && typeof input === 'object') return input;
  throw new TypeError('"questions" must be an object map or an array of { id, ...question }.');
}

function validateQuestions(questions) {
  const names = Object.keys(questions);
  if (names.length === 0) throw new TypeError('At least one question is required.');
  for (const [name, q] of Object.entries(questions)) {
    if (!q || typeof q !== 'object') throw new TypeError(`Question "${name}" must be an object.`);
    if (!QUESTION_TYPES.has(q.type)) {
      throw new TypeError(`Question "${name}" has unknown type "${q.type}" (expected one of ${[...QUESTION_TYPES].join(', ')}).`);
    }
    if (q.type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object' || Object.keys(q.criteria).length === 0) {
        throw new TypeError(`Choice question "${name}" needs a non-empty "criteria" map.`);
      }
    }
    if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        throw new TypeError(`Score question "${name}" needs "criteria" as an array of >=2 levels.`);
      }
    }
  }
  return questions;
}

module.exports = { QUESTION_TYPES, noul, choice, score, box, normalizeQuestions, validateQuestions };
