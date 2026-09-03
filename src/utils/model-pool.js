/**
 * Model pool — fallback chains and per-segment model rotation.
 *
 * Gemini preview models go through demand spikes: every attempt on one model
 * comes back 503 UNAVAILABLE ("this model is currently experiencing high
 * demand") for minutes at a time, and no amount of backoff on that same model
 * helps. A segment lost that way is lost work — the tickets in it nobody
 * recovers by re-watching the call.
 *
 * So two things live here:
 *   1. A fallback chain — when one model stays overloaded, the request moves to
 *      the next model instead of failing the segment.
 *   2. A rotation — parallel segments are dealt DIFFERENT models, so several
 *      segments analyze at once without piling onto one model's capacity.
 *
 * A model that just returned an overload error is put on a short cooldown so
 * sibling segments skip it rather than each discovering it independently.
 */

'use strict';

const config = require('../config');
const { withRetry, describeError, isTransientError } = require('./retry');

/** How long a model stays deprioritised after an overload error. */
const COOLDOWN_MS = 60000;

/** Errors that mean "this model has no capacity right now" — try another one. */
const OVERLOAD_PATTERNS = [
  /\b(?:503|429|500|502|504)\b/,
  /UNAVAILABLE/i,
  /RESOURCE[ _]EXHAUSTED/i,
  /high demand/i,
  /overloaded/i,
  /capacity/i,
  /too many requests/i,
  /quota exceeded/i,
  /\bINTERNAL\b/,
  /model is currently/i,
];

/** modelId -> timestamp (ms) until which the model is considered contended. */
const cooldowns = new Map();

/**
 * Is this failure about the model's capacity rather than the request itself?
 *
 * A bad request (INVALID_ARGUMENT, a corrupt file, an oversized context) fails
 * identically on every model, so switching would only burn money. Capacity
 * errors are the ones worth carrying to another model.
 *
 * @param {any} err
 * @returns {boolean}
 */
function isOverloadError(err) {
  if (!err) return false;
  const text = describeError(err);
  if (/INVALID_ARGUMENT|PERMISSION_DENIED|NOT_FOUND|UNAUTHENTICATED/i.test(text)) return false;

  const statuses = [];
  let cur = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 6; depth++) {
    const st = cur.status || cur.statusCode || 0;
    if (st) statuses.push(Number(st));
    cur = cur.cause;
  }
  if (statuses.some(s => [429, 500, 502, 503, 504].includes(s))) return true;

  return OVERLOAD_PATTERNS.some(p => p.test(text));
}

/** Mark a model as contended so siblings prefer another one for a while. */
function markOverloaded(modelId, ms = COOLDOWN_MS) {
  if (modelId) cooldowns.set(modelId, Date.now() + ms);
}

/** Is this model still inside its overload cooldown? */
function isCoolingDown(modelId) {
  const until = cooldowns.get(modelId);
  if (!until) return false;
  if (Date.now() >= until) {
    cooldowns.delete(modelId);
    return false;
  }
  return true;
}

/** Clear every cooldown — used by tests and at the start of a fresh run. */
function resetCooldowns() {
  cooldowns.clear();
}

/** Cost rank, cheapest first — used to break ties in the fallback order. */
const TIER_RANK = { economy: 0, balanced: 1, premium: 2 };

function tierRank(modelId) {
  const specs = config.GEMINI_MODELS[modelId];
  const rank = TIER_RANK[(specs && specs.tier) || 'balanced'];
  return rank == null ? 1 : rank;
}

/**
 * Fallback chain for a request: the chosen model first, then every other
 * registered model ordered by how close it is to the original — closest tier
 * wins, and a tie goes to the cheaper model so an outage never silently
 * upgrades a run to the premium tier.
 *
 * Models inside their overload cooldown sink to the back of the chain: still
 * reachable as a last resort, just not tried first.
 *
 * @param {string} [primary] - Preferred model (defaults to the active model)
 * @returns {string[]} Model ids, best first
 */
function fallbackChain(primary) {
  const head = config.GEMINI_MODELS[primary] ? primary : config.GEMINI_MODEL;
  const headRank = tierRank(head);

  const rest = Object.keys(config.GEMINI_MODELS)
    .filter(id => id !== head)
    .sort((a, b) => {
      const coolA = isCoolingDown(a) ? 1 : 0;
      const coolB = isCoolingDown(b) ? 1 : 0;
      if (coolA !== coolB) return coolA - coolB;
      const distA = Math.abs(tierRank(a) - headRank);
      const distB = Math.abs(tierRank(b) - headRank);
      if (distA !== distB) return distA - distB;
      return tierRank(a) - tierRank(b);
    });

  return [head, ...rest];
}

/**
 * Deal one model per segment, round-robin over the pool.
 *
 * Spreading segments across models is what makes parallel analysis worth
 * running: three segments on three models are three independent capacity
 * pools, so one model's demand spike costs one retry instead of stalling the
 * whole run. Segment 0 always keeps the primary model — it establishes the
 * baseline every later segment is compared against.
 *
 * @param {number} count - Number of segments
 * @param {object} [opts]
 * @param {string} [opts.primary] - Model for segment 0 (defaults to active model)
 * @param {number} [opts.poolSize] - Cap on how many distinct models to use
 * @returns {string[]} Model id per segment index
 */
function assignSegmentModels(count, opts = {}) {
  const { primary, poolSize } = opts;
  const chain = fallbackChain(primary);
  const pool = poolSize > 0 ? chain.slice(0, Math.max(1, poolSize)) : chain;
  return Array.from({ length: Math.max(0, count) }, (_, i) => pool[i % pool.length]);
}

/**
 * Clamp a thinking budget to what the target model actually accepts.
 * Models differ (pro allows 32768, the flash line 24576) and an over-budget
 * request is rejected outright — which would look like another model failure.
 *
 * @param {number} budget
 * @param {string} modelId
 * @returns {number}
 */
function clampThinkingBudget(budget, modelId) {
  const specs = config.GEMINI_MODELS[modelId];
  const max = (specs && specs.maxThinkingBudget) || config.getMaxThinkingBudget();
  if (!Number.isFinite(budget)) return budget;
  if (budget <= 0) return budget;   // 0 means "thinking off" — keep it
  return Math.min(budget, max);
}

/** Pricing block for a model id, so a mixed-model run costs out correctly. */
function pricingFor(modelId) {
  const specs = config.GEMINI_MODELS[modelId];
  return specs ? specs.pricing : null;
}

/**
 * Run generateContent with retries, then with other models.
 *
 * Retries first (the spike may be seconds long), and only when a model keeps
 * answering "no capacity" does the request move down the chain. Anything that
 * is not a capacity error is thrown straight through — a malformed request
 * fails the same way on every model.
 *
 * `payload.model` is UPDATED IN PLACE to the model that answered, so callers
 * that keep using the payload (an internal re-upload retry, a no-thinking
 * retry) stay on the model that works, and can report it as the run's model.
 *
 * @param {object} ai - GoogleGenAI instance
 * @param {object} payload - generateContent request (payload.model is rewritten)
 * @param {object} [opts]
 * @param {string} [opts.label] - Log label
 * @param {number} [opts.maxRetries] - Retries on the primary model
 * @param {number} [opts.baseDelay] - Backoff base in ms
 * @param {Function} [opts.onRetry] - Passed through to withRetry
 * @param {boolean} [opts.fallback=true] - Set false to stay on one model
 * @param {string[]} [opts.pool] - Explicit chain (defaults to fallbackChain)
 * @param {number} [opts.overloadAttempts=2] - Capacity failures tolerated on one
 *   model before moving on. Backoff cannot outwait a demand spike, and each
 *   attempt can burn the full request timeout, so waiting out five of them on a
 *   model that has no capacity costs ~10 minutes and still fails.
 * @param {Function} [opts.onModelSwitch] - (from, to, err) before each switch
 * @returns {Promise<object>} The generateContent response
 */
async function generateWithFallback(ai, payload, opts = {}) {
  const {
    label = 'Gemini request',
    maxRetries = 4,
    baseDelay = 5000,
    onRetry = null,
    fallback = true,
    pool = null,
    overloadAttempts = 2,
    onModelSwitch = null,
  } = opts;

  const chain = fallback
    ? (pool && pool.length > 0 ? pool : fallbackChain(payload.model))
    : [payload.model || config.GEMINI_MODEL];

  const requested = (payload.config && payload.config.thinkingConfig)
    ? payload.config.thinkingConfig.thinkingBudget
    : null;

  let lastError;
  for (let i = 0; i < chain.length; i++) {
    const modelId = chain[i];
    payload.model = modelId;
    // Re-clamp from the ORIGINAL budget, not the previous model's clamped one,
    // so walking pro -> flash -> pro doesn't ratchet the budget down for good.
    if (requested != null && payload.config && payload.config.thinkingConfig) {
      payload.config.thinkingConfig = { thinkingBudget: clampThinkingBudget(requested, modelId) };
    }

    const hasNext = i < chain.length - 1;
    let overloads = 0;

    try {
      return await withRetry(
        () => ai.models.generateContent(payload),
        {
          label: i === 0 ? label : `${label} [${modelId}]`,
          // Later models get fewer attempts: the point of switching is to stop
          // waiting, and a run that walks the whole chain still ends in minutes.
          maxRetries: i === 0 ? maxRetries : Math.min(maxRetries, 2),
          baseDelay,
          onRetry,
          // Capacity failures are handed to the next model early; every other
          // transient failure (a reset socket, a stalled request) keeps the
          // full retry budget on this model, where it belongs.
          shouldRetry: (err) => {
            if (isOverloadError(err)) {
              overloads++;
              return !(hasNext && overloads >= overloadAttempts);
            }
            return isTransientError(err);
          },
        }
      );
    } catch (err) {
      lastError = err;
      if (isOverloadError(err)) markOverloaded(modelId);

      const next = chain[i + 1];
      if (!next || !isOverloadError(err)) throw err;
      if (onModelSwitch) onModelSwitch(modelId, next, err);
    }
  }

  throw lastError;
}

module.exports = {
  COOLDOWN_MS,
  isOverloadError,
  markOverloaded,
  isCoolingDown,
  resetCooldowns,
  fallbackChain,
  assignSegmentModels,
  clampThinkingBudget,
  pricingFor,
  generateWithFallback,
};
