/**
 * Analysis pipeline: page info -> is this a manga page? -> clean the title ->
 * search the stores -> match -> build the state the UI renders.
 *
 * No chrome API is called here: fetchText and cache are injected through deps,
 * which is what makes the whole pipeline end-to-end testable in Node against
 * the HTML snapshots.
 */

import { CONFIG } from './config.js';
import { MESSAGES, STATUS } from '../shared/protocol.js';
import { extractWorkTitle } from './cleaner.js';
import { toStoreQuery } from './text.js';
import { evaluatePage } from './site-filter.js';
import { cacheKeyFor } from './cache.js';
import { classify, matchLabel, rankCandidates } from '../matching/matcher.js';
import { getAdapter } from '../stores/registry.js';

const STORE_LABELS = {
  dlsite: 'DLsite',
  fanza: 'FANZA',
  melonbooks: 'Melonbooks',
  pixiv: 'Pixiv',
  fantia: 'Fantia'
};

function toCandidateCard(item) {
  return {
    productId: item.productId,
    title: item.title,
    url: item.url,
    store: item.store || '',
    storeLabel: STORE_LABELS[item.store] || item.store || '',
    maker: item.maker || '',
    author: item.author || '',
    category: item.category || '',
    price: item.price,
    priceText: item.priceText || '',
    currency: item.currency || '',
    isFree: Boolean(item.isFree),
    originalPriceText: item.originalPriceText || '',
    discountLabel: item.discountLabel || '',
    approxCny: item.approxCny ?? null,
    imageUrl: item.imageUrl || '',
    score: item.score,
    scoreLabel: matchLabel(item.score),
    matchedQuery: item.matchedQuery || '',
    matchMethod: item.method || ''
  };
}

function baseState(pageInfo) {
  return {
    status: STATUS.UNRECOGNIZED,
    reason: null,
    message: '',
    page: {
      url: pageInfo?.url || '',
      host: pageInfo?.host || '',
      title: pageInfo?.title || '',
      /** id of the content-script instance, so a state can be tied to a document */
      scriptId: pageInfo?.scriptId || '',
      /** in-between state of a client-side navigation (content not swapped yet) */
      settled: pageInfo?.settled !== false,
      capturedAt: pageInfo?.capturedAt || 0
    },
    query: null,
    match: null,
    candidates: [],
    stores: [],
    searchUrls: [],
    needsAgeCheck: false,
    ageCheckUrl: '',
    ageCheckStoreLabel: '',
    searchUrl: '',
    storeLabel: 'DLsite',
    meta: {
      storeId: 'dlsite',
      fromCache: false,
      analyzedAt: Date.now(),
      signals: [],
      errors: [],
      preview: [],
      headings: []
    }
  };
}

/**
 * Search one store and score its results.
 * Returns { storeId, storeLabel, kind, best, candidates, preview, searchUrl, needsAgeCheck, errors, fromCache, itemCount }
 * kind: 'high' | 'possible' | 'none' | 'error' | 'age_check'
 */
async function searchStore({ adapter, queries, extraction, deps }) {
  const result = {
    storeId: adapter.id,
    storeLabel: adapter.label,
    kind: 'none',
    best: null,
    candidates: [],
    preview: [],
    searchUrl: queries[0] ? adapter.buildHumanSearchUrl(queries[0]) : '',
    needsAgeCheck: false,
    ageCheckUrl: adapter.ageCheckUrl || '',
    errors: [],
    fromCache: false,
    itemCount: 0
  };

  const cacheKey = cacheKeyFor(adapter.id, queries);
  let collected = [];
  let sawNotFound = false;
  let attempted = 0;
  const errors = [];

  const cached = await deps.cache.get(cacheKey);
  if (cached && Array.isArray(cached.items) && cached.items.length) {
    collected = cached.items;
    result.fromCache = true;
  } else {
    const rank = () => rankCandidates(queries, collected, { chapterHint: extraction.chapterHint });

    const runStep = async (step) => {
      attempted += 1;
      let response;
      try {
        response = await adapter.searchStep(step, deps);
      } catch (error) {
        errors.push({ step: step.id, error: String((error && error.message) || error) });
        return 'error';
      }
      if (!response.ok) {
        errors.push({ step: step.id, reason: response.reason });
        if (response.reason === 'age-check') {
          result.needsAgeCheck = true;
          return 'age-check';
        }
        return 'error';
      }
      if (!response.items.length) {
        sawNotFound = true;
        return 'empty';
      }
      const known = new Set(collected.map((item) => item.productId));
      for (const item of response.items) {
        if (!known.has(item.productId)) {
          known.add(item.productId);
          collected.push(item);
        }
      }
      return 'ok';
    };

    const primarySteps = [];
    const fallbackSteps = [];
    queries.forEach((query, index) => {
      const plan = adapter.searchPlan(query);
      primarySteps.push(...plan.filter((step) => (step.tier ?? 1) === 1));
      if (index === 0) fallbackSteps.push(...plan.filter((step) => (step.tier ?? 1) === 2));
    });

    // Tier 1 sections: one search per variant, stopping as soon as a high-confidence hit appears
    for (const step of primarySteps) {
      const outcome = await runStep(step);
      if (outcome === 'age-check') break;
      const preview = rank();
      if (preview[0] && preview[0].score >= CONFIG.matcher.high) break;
      if (collected.length >= CONFIG.search.maxItemsTotal) break;
    }

    // Tier 2 sections: searched only when tier 1 produced nothing usable (e.g. DLsite's girls index)
    if (!result.needsAgeCheck) {
      const rankedSoFar = rank();
      if (!rankedSoFar[0] || rankedSoFar[0].score < CONFIG.matcher.possible) {
        for (const step of fallbackSteps) {
          const outcome = await runStep(step);
          if (outcome === 'age-check') break;
          const preview = rank();
          if (preview[0] && preview[0].score >= CONFIG.matcher.possible) break;
          if (collected.length >= CONFIG.search.maxItemsTotal) break;
        }
      }
    }

    if (collected.length) await deps.cache.set(cacheKey, { items: collected });
    else if (sawNotFound && !result.needsAgeCheck) await deps.cache.set(cacheKey, { items: [] });
  }

  result.errors = errors;
  result.itemCount = collected.length;

  const ranked = rankCandidates(queries, collected, { chapterHint: extraction.chapterHint });
  result.preview = ranked.slice(0, 5).map((item) => ({ title: item.title, score: item.score, url: item.url }));

  if (result.needsAgeCheck && !ranked.length) {
    result.kind = 'age_check';
    return result;
  }

  const verdict = classify(ranked);
  if (verdict.kind === 'none') {
    const allFailed = attempted > 0 && errors.length === attempted && !sawNotFound;
    result.kind = allFailed ? 'error' : 'none';
    return result;
  }

  result.best = verdict.best;
  result.candidates = verdict.candidates;
  result.kind = verdict.kind === 'possible' ? 'possible' : 'high';
  return result;
}

export async function analyzePage({ pageInfo, settings = {}, deps }) {
  const adapter = getAdapter(settings.storeId || 'dlsite');
  const state = baseState(pageInfo);
  state.storeLabel = adapter.label;
  state.meta.storeId = adapter.id;
  state.meta.analyzedAt = Date.now();

  const evaluation = evaluatePage(pageInfo, settings);
  state.meta.signals = evaluation.signals;
  // Diagnostics: record the title-like elements found on the page, so "why this title?" is answerable
  state.meta.headings = (Array.isArray(pageInfo?.headings) ? pageInfo.headings : [])
    .slice(0, 6)
    .map((item) => `${String(item.tag || 'h')}${item.level}: ${String(item.text || '').slice(0, 60)}`);

  if (!evaluation.allowed) {
    state.status = STATUS.UNRECOGNIZED;
    state.reason = evaluation.reason;
    state.message = evaluation.reason === 'no-page-info'
      ? MESSAGES.READ_FAILED
      : (evaluation.reason === 'page-settling' ? MESSAGES.PAGE_SETTLING : MESSAGES.NOT_A_COMIC_PAGE);
    return state;
  }

  const extraction = extractWorkTitle(pageInfo);
  state.query = {
    rawTitle: extraction.rawTitle,
    cleanedTitle: extraction.cleanedTitle,
    source: extraction.source,
    confidence: extraction.confidence,
    variants: extraction.variants,
    notes: extraction.notes
  };
  state.searchUrl = extraction.cleanedTitle
    ? adapter.buildHumanSearchUrl(extraction.cleanedTitle)
    : '';

  if (!extraction.cleanedTitle || extraction.confidence === 'low') {
    state.status = STATUS.UNRECOGNIZED;
    state.reason = 'title-unrecognized';
    state.message = MESSAGES.TITLE_UNRECOGNIZED;
    return state;
  }

  // Measured on DLsite: keywords shorter than 3 characters return 0 results, so longer variants come first
  const longVariants = extraction.variants.filter((query) => query.length >= CONFIG.search.minQueryLength);
  const effectiveQueries = (longVariants.length ? longVariants : extraction.variants).slice(0, CONFIG.search.maxQueries);

  // Doujinshi sites often show a romanised title next to the Japanese original;
  // the first N variants are each searched once and the matcher scores them
  // together, so a subtitle or translated title alone cannot cause a false "not found".
  const searchQueries = effectiveQueries.slice(0, Math.max(1, CONFIG.search.maxVariantsToSearch));

  // Store search engines are punctuation-sensitive: a keyword such as
  // `サンプル！作品 第2巻` silently returns 0 items while `サンプル 作品 第2巻`
  // finds the product, so the keyword actually sent to a store has punctuation
  // replaced by spaces. The displayed title keeps its original form, and
  // scoring is unaffected because the matcher strips punctuation before comparing.
  const storeQueries = [...new Set(searchQueries.map((query) => toStoreQuery(query)).filter(Boolean))];
  const queriesToSearch = storeQueries.length ? storeQueries : searchQueries;
  state.query.searched = queriesToSearch;

  // Author / circle names from the page (on by default): a work can be stored
  // under a different title elsewhere, so the artist is the most useful hint.
  // Pixiv's user-search API only returns a few preview works per artist, so
  // instead of searching and guessing we hand the user a link to the artist.
  const artists = settings.artistFallback === false ? [] : (extraction.artists || []);
  state.query.artists = artists;
  const artistLinks = artists.map((artist) => ({
    storeLabel: `Pixiv 作者: ${artist}`,
    url: getAdapter('pixiv').buildArtistSearchUrl(artist)
  }));

  // Ask each store in turn: stop at DLsite when it is convincing, otherwise continue to FANZA / Melonbooks
  const storeResults = [];
  let bestOverall = null;
  for (const storeId of CONFIG.stores.enabled) {
    const storeAdapter = getAdapter(storeId);
    const queries = storeId === 'dlsite'
      ? queriesToSearch
      : queriesToSearch.slice(0, Math.max(1, CONFIG.search.maxVariantsForExtraStores));
    const result = await searchStore({ adapter: storeAdapter, queries, extraction, deps });
    storeResults.push(result);
    if (result.best && (!bestOverall || result.best.score > bestOverall.score)) bestOverall = result.best;
    if (result.kind === 'high') break;
  }

  const dlsiteResult = storeResults.find((item) => item.storeId === 'dlsite');
  state.meta.fromCache = storeResults.length > 0 && storeResults.every((item) => item.fromCache);
  state.meta.errors = dlsiteResult ? dlsiteResult.errors : [];
  state.meta.preview = storeResults
    .flatMap((item) => item.preview)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Per-store summary (the popup shows one row per store)
  state.stores = storeResults.map((item) => ({
    storeId: item.storeId,
    storeLabel: item.storeLabel,
    kind: item.kind,
    searchUrl: item.searchUrl,
    needsAgeCheck: item.needsAgeCheck,
    ageCheckUrl: item.ageCheckUrl,
    itemCount: item.itemCount,
    match: item.best ? toCandidateCard(item.best) : null,
    error: item.errors[0] ? (item.errors[0].reason || item.errors[0].error || '') : '',
    /** Stores can explain an empty result (e.g. Pixiv hides R-18 without a session). */
    note: item.kind === 'none' ? (getAdapter(item.storeId).emptyResultNote || '') : ''
  }));
  state.searchUrls = storeResults
    .filter((item) => item.searchUrl)
    .map((item) => ({ storeLabel: item.storeLabel, url: item.searchUrl }));
  // Artist links are shown next to the store search links, so the user can look
  // the author up themselves (see the artist note above).
  state.searchUrls = [...state.searchUrls, ...artistLinks];
  state.searchUrl = (dlsiteResult && dlsiteResult.searchUrl)
    || (state.searchUrls[0] && state.searchUrls[0].url)
    || '';

  const ageCheckStore = storeResults.find((item) => item.needsAgeCheck);
  state.needsAgeCheck = Boolean(ageCheckStore);
  state.ageCheckUrl = ageCheckStore ? ageCheckStore.ageCheckUrl : '';
  state.ageCheckStoreLabel = ageCheckStore ? ageCheckStore.storeLabel : '';

  if (bestOverall) {
    const high = bestOverall.score >= CONFIG.matcher.high;
    state.match = toCandidateCard(bestOverall);
    state.candidates = storeResults
      .flatMap((item) => item.candidates)
      .sort((a, b) => b.score - a.score)
      .filter((item, index, list) => list.findIndex((other) => other.store === item.store && other.productId === item.productId) === index)
      .slice(0, CONFIG.matcher.maxCandidates)
      .map(toCandidateCard);
    state.status = high ? STATUS.OK_HIGH : STATUS.OK_POSSIBLE;
    state.reason = high ? 'high' : 'possible';
    state.message = high ? '找到正版商品' : '找到可能的正版商品';
    return state;
  }

  const allFailed = storeResults.length > 0 && storeResults.every((item) => item.kind === 'error');
  if (allFailed) {
    state.status = STATUS.ERROR;
    state.reason = 'search-failed';
    state.message = MESSAGES.SEARCH_FAILED;
    return state;
  }

  state.status = STATUS.NO_RESULT;
  state.reason = 'no-match';
  state.message = MESSAGES.NO_RESULT;
  // Low-scoring candidates are not shown as recommendations (requirements doc §22)
  state.candidates = [];
  return state;
}
