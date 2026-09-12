/**
 * Store adapter health (requirements doc §30).
 *
 * The point of this module is one rule:
 *
 *   HTTP 200 + parser returned 0 items must NEVER be reported as
 *   "this work does not exist".
 *
 * A "no results" page announces itself (the adapters look for an explicit
 * marker such as `work_not_found`). Everything else — an unexpected page, an
 * unparseable payload, an empty body — means something about the store changed
 * or the request was refused, and has to be surfaced as such so that a broken
 * parser is not mistaken for a missing product.
 */

export const HEALTH = {
  /** search worked and returned candidates */
  HEALTHY: 'healthy',
  /** results were returned, but part of the search plan failed */
  DEGRADED: 'degraded',
  /** blocked by the store: age gate, login wall, rate limit, WAF */
  BLOCKED: 'blocked',
  /** the search page came back, but the parser could not find the result list */
  PARSER_BROKEN: 'parser-broken',
  /** the request itself failed (timeout, empty body, not the search page at all) */
  SEARCH_FAILED: 'search-failed',
  /** the store answered with an explicit "no results" marker */
  NO_RESULT: 'no-result'
};

const PRIORITY = {
  [HEALTH.NO_RESULT]: 1,
  [HEALTH.PARSER_BROKEN]: 2,
  [HEALTH.SEARCH_FAILED]: 3,
  [HEALTH.BLOCKED]: 4
};

const BLOCKED_STATUSES = new Set([401, 403, 429, 451, 503]);
const BLOCKED_REASONS = new Set(['blocked', 'age-check', 'login-required']);
const SEARCH_FAILED_REASONS = new Set(['empty-response', 'unexpected-page']);
const PARSER_BROKEN_REASONS = new Set(['no-items-parsed', 'invalid-json', 'unexpected-payload']);

const LABELS = {
  [HEALTH.HEALTHY]: 'search returned candidates',
  [HEALTH.DEGRADED]: 'candidates returned, but part of the search plan failed',
  [HEALTH.BLOCKED]: 'age gate, login wall or rate limit',
  [HEALTH.PARSER_BROKEN]: 'the search page did not match the expected markup',
  [HEALTH.SEARCH_FAILED]: 'the request did not return a search page',
  [HEALTH.NO_RESULT]: 'the store answered with an explicit "not found"'
};

/** Classify one search step */
export function classifyStep(step = {}) {
  const status = Number(step.httpStatus) || 0;
  const reason = String(step.reason || '');
  const items = Number(step.itemCount ?? (Array.isArray(step.items) ? step.items.length : 0)) || 0;

  if (items > 0) return HEALTH.HEALTHY;
  if (BLOCKED_STATUSES.has(status) || BLOCKED_REASONS.has(reason)) return HEALTH.BLOCKED;
  if (reason === 'not-found') return HEALTH.NO_RESULT;
  if (PARSER_BROKEN_REASONS.has(reason)) return HEALTH.PARSER_BROKEN;
  if (SEARCH_FAILED_REASONS.has(reason)) return HEALTH.SEARCH_FAILED;
  if (status >= 500 || status === 0) return HEALTH.SEARCH_FAILED;
  if (reason === 'ok') return HEALTH.NO_RESULT;
  // HTTP 200 with items and no usable reason: treat it as a parser problem, not as "no result"
  return status === 200 ? HEALTH.PARSER_BROKEN : HEALTH.SEARCH_FAILED;
}

/**
 * Roll the steps of one search plan up into a single verdict.
 * @param {object} input
 * @param {Array} [input.steps]       per-step results ({ httpStatus, ok, reason, itemCount })
 * @param {number} [input.itemCount]  total parsed items, when steps are unknown
 */
export function classifyStoreHealth({ steps = [], itemCount = null } = {}) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const total = itemCount === null
    ? list.reduce((sum, step) => sum + (Number(step.itemCount) || 0), 0)
    : Number(itemCount) || 0;
  const verdicts = list.map(classifyStep);
  const worst = verdicts.reduce((acc, value) => (PRIORITY[value] > PRIORITY[acc] ? value : acc), HEALTH.NO_RESULT);
  const failures = verdicts.filter((value) => value !== HEALTH.NO_RESULT && value !== HEALTH.HEALTHY);

  if (total > 0) return failures.length ? HEALTH.DEGRADED : HEALTH.HEALTHY;
  if (!verdicts.length) return total > 0 ? HEALTH.HEALTHY : HEALTH.NO_RESULT;
  return worst;
}

export function healthLabel(health) {
  return LABELS[health] || String(health || 'unknown');
}

/** Only "healthy" and "degraded" mean the store actually answered the search */
export function storeUsable(health) {
  return health === HEALTH.HEALTHY || health === HEALTH.DEGRADED;
}

/** "There is no such work" may only be concluded from an explicit marker (§30) */
export function canConcludeNoResult(health) {
  return health === HEALTH.NO_RESULT;
}
