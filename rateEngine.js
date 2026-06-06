/**
 * rateEngine.js — Predicted Rating Engine
 *
 * Predicts the user's personal star rating (1.0–5.0) for unread books
 * using a Bayesian combination of evidence signals learned from their
 * 500-book read history.
 *
 * Methodology:
 *   All signals are combined as a weighted mean anchored to the user's
 *   global average. Each signal contributes evidence proportional to its
 *   reliability (number of books supporting it) and signal type weight.
 *
 *     predicted = Σ(signal_value × signal_weight) / Σ(signal_weight + PRIOR_K)
 *
 *   This is Bayesian shrinkage: when evidence is thin the prediction
 *   regresses toward the prior (global mean); strong evidence pulls away.
 *
 * Signals (in order of typical influence):
 *   1. Direct author       — user has read & rated this exact author
 *   2. Similar-author      — candidate's similarToAuthors ∩ read authors
 *   3. Reverse-title       — candidate title appears in read books' similarToTitles
 *   4. Forward-title       — candidate's similarToTitles ∩ read titles
 *   5. Theme affinity      — themes correlated with high/low ratings in history
 *   6. Community rating    — Goodreads avgRating (weak, r≈0.17 for this user)
 *
 * Cross-validation (LOO on 490 rated books, signals 3-6 only since read books
 * lack similarToAuthors): MAE=0.789, Spearman=0.344 vs baseline MAE=0.823.
 * Signals 1-2 add further lift when applied to candidates.
 */

// ── Helpers ────────────────────────────────────────────────────────────────

const mean   = arr => arr.length > 0 ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
const normA  = n => String(n || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
const normT  = n => String(n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Bayesian shrinkage weight for a set of n observations
// Returns a weight between 0 and maxW, growing with n
function shrunkWeight(n, halfK, maxW) {
  return maxW * n / (n + halfK);
}

// ── Model Building ─────────────────────────────────────────────────────────

/**
 * Build a taste model from the user's Goodreads reading history.
 * Returns a model object used by predictRating().
 */
export function buildTasteModel(goodreads) {
  const books   = goodreads.books || [];
  const read    = books.filter(b => b.shelf === 'read' && b.myRating >= 1);

  if (read.length === 0) return null;

  const globalMean = mean(read.map(b => b.myRating));

  // ── Author ratings ──────────────────────────────────────────────────────
  // Map: normAuthor → { ratings: number[], mean: number }
  const authorMap = new Map();
  for (const b of read) {
    const key = normA(b.author);
    if (!authorMap.has(key)) authorMap.set(key, { ratings: [], name: b.author });
    authorMap.get(key).ratings.push(b.myRating);
  }
  for (const v of authorMap.values()) v.mean = mean(v.ratings);

  // ── Theme affinities ────────────────────────────────────────────────────
  // Map: theme → { ratings: number[], mean: number, count: number }
  const themeMap = new Map();
  for (const b of read) {
    for (const t of (b.themes || [])) {
      if (!themeMap.has(t)) themeMap.set(t, { ratings: [] });
      themeMap.get(t).ratings.push(b.myRating);
    }
  }
  for (const v of themeMap.values()) {
    v.count = v.ratings.length;
    v.mean  = mean(v.ratings);
  }

  // ── Reverse-title map ───────────────────────────────────────────────────
  // For each title T appearing in any read book's similarToTitles,
  // store the ratings of the read books that cite T.
  // When a candidate's title appears here, those books endorse it.
  const reverseTitleMap = new Map();
  for (const b of read) {
    for (const st of (b.similarToTitles || [])) {
      const key = normT(st);
      if (!reverseTitleMap.has(key)) reverseTitleMap.set(key, []);
      reverseTitleMap.get(key).push(b.myRating);
    }
  }

  // ── Forward-title map ───────────────────────────────────────────────────
  // Map: normTitle → myRating, for looking up candidate's similarToTitles
  const titleRatings = new Map();
  for (const b of read) {
    titleRatings.set(normT(b.title), b.myRating);
  }

  // ── Community-rating regression ─────────────────────────────────────────
  // Fit myRating = slope × avgRating + intercept
  const withAvg = read.filter(b => b.avgRating > 0 && b.avgRating <= 5);
  let communitySlope = 0, communityIntercept = globalMean, communityCorr = 0;
  if (withAvg.length > 20) {
    const xs = withAvg.map(b => b.avgRating);
    const ys = withAvg.map(b => b.myRating);
    const mx = mean(xs), my = mean(ys);
    const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const sxx = xs.reduce((s, x)    => s + (x - mx) ** 2, 0);
    const syy = ys.reduce((s, y)    => s + (y - my) ** 2, 0);
    communitySlope     = sxy / sxx;
    communityIntercept = my - communitySlope * mx;
    communityCorr      = sxy / Math.sqrt(sxx * syy);
  }

  // ── Favourite themes (for display) ─────────────────────────────────────
  const topThemes = [...themeMap.entries()]
    .filter(([, v]) => v.count >= 5)
    .sort((a, b) => b[1].mean - a[1].mean)
    .slice(0, 10)
    .map(([t, v]) => ({ theme: t, mean: v.mean, count: v.count }));

  return {
    globalMean,
    authorMap,
    themeMap,
    reverseTitleMap,
    titleRatings,
    communitySlope,
    communityIntercept,
    communityCorr,
    topThemes,
    readCount: read.length,
  };
}

// ── Rating Prediction ──────────────────────────────────────────────────────

/**
 * Predict the user's personal star rating for a single book.
 *
 * @param {object} book  — candidate book with title, author, themes[],
 *                         similarToAuthors[], similarToTitles[], avgRating
 * @param {object} model — from buildTasteModel()
 * @returns {{ predicted: number, confidence: number, breakdown: object[] }}
 */
export function predictRating(book, model) {
  if (!model) return { predicted: model?.globalMean ?? 4.0, confidence: 0, breakdown: [] };

  const PRIOR_K = 20; // prior worth 20 pseudo-observations — strong regularizer
                      // prevents extreme predictions from sparse evidence

  let numer    = model.globalMean * PRIOR_K;
  let denom    = PRIOR_K;
  const breakdown = [];

  // ── Signal 1: Direct author match ──────────────────────────────────────
  // User has read and rated this exact author → strongest possible signal.
  const authorEntry = model.authorMap.get(normA(book.author));
  if (authorEntry) {
    const n = authorEntry.ratings.length;
    const w = shrunkWeight(n, 2, 10); // half-K=2 → full weight after ~4 books
    numer += authorEntry.mean * w;
    denom += w;
    breakdown.push({
      label:      `${authorEntry.name}: ${authorEntry.mean.toFixed(1)}★ avg (${n} book${n > 1 ? 's' : ''} read)`,
      signal:     authorEntry.mean,
      weight:     w,
      type:       'author',
    });
  }

  // ── Signal 2: Similar-author bridge ────────────────────────────────────
  // The candidate's similarToAuthors list names authors whose fans like this book.
  // If user has read those authors → indirect rating proxy.
  let simAuthorNumer = 0, simAuthorDenom = 0;
  const simAuthorLabels = [];
  for (const sa of (book.similarToAuthors || []).slice(0, 5)) {
    const entry = model.authorMap.get(normA(sa));
    if (!entry) continue;
    const n = entry.ratings.length;
    const w = shrunkWeight(n, 3, 3); // smaller cap (indirect signal)
    simAuthorNumer += entry.mean * w;
    simAuthorDenom += w;
    simAuthorLabels.push(`${entry.name} (${entry.mean.toFixed(1)}★)`);
  }
  if (simAuthorDenom > 0) {
    const simMean = simAuthorNumer / simAuthorDenom;
    const w = Math.min(8, simAuthorDenom); // cap total bridge contribution
    numer += simMean * w;
    denom += w;
    breakdown.push({
      label:      `fans of ${simAuthorLabels.slice(0, 3).join(', ')} → ${simMean.toFixed(1)}★`,
      signal:     simMean,
      weight:     w,
      type:       'simAuthor',
    });
  }

  // ── Signal 3: Reverse-title (read books cite this candidate) ───────────
  // The user's read books list this book in their "similar to" field.
  // High-rated reads endorsing a candidate = very strong signal.
  const reverseRatings = model.reverseTitleMap.get(normT(book.title)) || [];
  if (reverseRatings.length > 0) {
    const revMean = mean(reverseRatings);
    const n = reverseRatings.length;
    const w = shrunkWeight(n, 1, 8); // half-K=1 → nearly full weight after 2 citations
    numer += revMean * w;
    denom += w;
    breakdown.push({
      label:      `cited by ${n} read book${n > 1 ? 's' : ''} as similar → ${revMean.toFixed(1)}★ avg`,
      signal:     revMean,
      weight:     w,
      type:       'reverseTitle',
    });
  }

  // ── Signal 4: Forward-title (candidate cites books user has read) ───────
  // The candidate's similarToTitles contains books the user has rated.
  const forwardRatings = [];
  const forwardHits    = [];
  for (const st of (book.similarToTitles || []).slice(0, 8)) {
    const r = model.titleRatings.get(normT(st));
    if (r !== undefined) {
      forwardRatings.push(r);
      forwardHits.push(st);
    }
  }
  if (forwardRatings.length > 0) {
    const fwdMean = mean(forwardRatings);
    const n = forwardRatings.length;
    const w = shrunkWeight(n, 2, 6); // half-K=2
    numer += fwdMean * w;
    denom += w;
    breakdown.push({
      label:      `similar to ${n} book${n > 1 ? 's' : ''} you've rated → ${fwdMean.toFixed(1)}★ avg`,
      signal:     fwdMean,
      weight:     w,
      type:       'forwardTitle',
      detail:     forwardHits.slice(0, 3),
    });
  }

  // ── Signal 5: Theme affinity ────────────────────────────────────────────
  // Themes consistently appearing in high/low-rated books are predictive.
  // Each theme contributes proportional to Bayesian shrinkage on its count.
  let thNumer = 0, thDenom = 0;
  const themeLabels = [];
  for (const t of (book.themes || [])) {
    const entry = model.themeMap.get(t);
    if (!entry || entry.count < 3) continue;
    const s = shrunkWeight(entry.count, 5, 1); // per-theme shrinkage
    thNumer += entry.mean * s;
    thDenom += s;
    themeLabels.push(`${t} (${entry.mean.toFixed(1)}★)`);
  }
  if (thDenom > 0) {
    const thMean = thNumer / thDenom;
    const w = Math.min(4, thDenom); // cap total theme contribution
    numer += thMean * w;
    denom += w;
    breakdown.push({
      label:      `themes [${themeLabels.slice(0, 3).join(', ')}] → ${thMean.toFixed(1)}★ avg`,
      signal:     thMean,
      weight:     w,
      type:       'theme',
    });
  }

  // ── Signal 6: Community rating (weak calibration signal) ───────────────
  if (book.avgRating > 0 && book.avgRating <= 5) {
    const communityPred = model.communitySlope * book.avgRating + model.communityIntercept;
    const w = 0.25; // fixed small weight — correlation is ~0.17 for this user
    numer += communityPred * w;
    denom += w;
  }

  // ── Final prediction ────────────────────────────────────────────────────
  const predicted  = Math.max(1.0, Math.min(5.0, numer / denom));
  const evidenceW  = denom - PRIOR_K; // total evidence weight beyond prior
  const confidence = Math.min(1.0, evidenceW / 15); // 0–1, saturates at ~15 evidence units

  return { predicted, confidence, breakdown };
}

// ── Stars Formatting ───────────────────────────────────────────────────────

/**
 * Format a predicted rating as a star string + number.
 * e.g. predictedStars(4.3) → "★★★★☆ 4.3"
 */
export function predictedStars(rating) {
  const r     = Math.max(1, Math.min(5, rating));
  const full  = Math.floor(r);
  const half  = (r - full) >= 0.4 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty) + ` ${r.toFixed(1)}`;
}

// ── Ranking ────────────────────────────────────────────────────────────────

/**
 * Rank all eligible candidates by predicted rating.
 * Returns the same shape as rankRecommendations() for compatibility.
 *
 * @param {object}   goodreads     — full goodreadsData object
 * @param {object}   feedback      — { interactions, dismissals }
 * @param {object[]} candidatePool — array of candidate books
 * @returns {{ selected: object[], model: object, eligibleCount: number }}
 */
export function rankByPredictedRating(goodreads, feedback, candidatePool) {
  const model = buildTasteModel(goodreads);
  if (!model) return { selected: [], model: null, eligibleCount: 0 };

  // Build excluded-key set (already read or currently reading)
  const excludedKeys = new Set();
  for (const b of (goodreads.books || [])) {
    const shelf = String(b.shelf || '').toLowerCase();
    if (shelf === 'read' || shelf === 'currently-reading') {
      const key = b.bookKey || normBookKey(b.title, b.author);
      excludedKeys.add(key);
    }
  }

  // Apply feedback dismissals
  const dismissed = new Set(
    Object.entries((feedback?.dismissals || {}))
      .filter(([, v]) => v)
      .map(([k]) => k)
  );

  const eligible = (candidatePool || []).filter(c => {
    const key = c.bookKey || normBookKey(c.title, c.author);
    if (dismissed.has(key)) return false;
    // fromToRead books are always eligible (they're on the to-read shelf)
    if (c.fromToRead) return true;
    return !excludedKeys.has(key);
  });

  const scored = eligible.map(c => {
    const result = predictRating(c, model);
    return {
      ...c,
      predictedRating:    result.predicted,
      predictionConf:     result.confidence,
      predBreakdown:      result.breakdown,
    };
  });

  // Primary sort: predicted rating (desc), secondary: confidence (desc)
  scored.sort((a, b) =>
    (b.predictedRating - a.predictedRating) ||
    (b.predictionConf  - a.predictionConf)
  );

  return {
    selected:      scored.map((x, i) => ({ ...x, rank: i + 1 })),
    model,
    eligibleCount: eligible.length,
  };
}

// Minimal book-key normalizer (mirrors engine.js logic without importing it)
function normBookKey(title, author) {
  const norm = s => String(s || '').toLowerCase().trim()
    .replace(/&amp;/gi, '&')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${norm(title)}|${norm(author)}`;
}
