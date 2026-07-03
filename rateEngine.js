/**
 * rateEngine.js — Predicted Rating Engine v3
 *
 * Predicts the user's personal star rating (1.0–5.0) for unread books
 * using a Bayesian combination of evidence signals learned from their
 * reading history.
 *
 * Methodology: Bayesian shrinkage toward a genre-specific prior
 * ─────────────────────────────────────────────────────────────
 * Every signal is combined as a weighted mean anchored to the genre prior:
 *
 *   predicted = Σ(signal_value × signal_weight) / (PRIOR_K + Σ signal_weights)
 *
 * When evidence is thin the prediction stays near the prior; as evidence
 * accumulates the prediction moves toward the weighted signal mean.
 *
 * Key design choices (validated by leave-one-out cross-validation on 490 books):
 *
 *   1. Genre-split prior instead of global mean
 *      Fiction mean = 4.41, Nonfiction mean = 4.07, Global mean = 4.22.
 *      Using the wrong anchor introduced 0.19★ systematic bias.
 *      Improvement: Spearman +6.8% (from 0.306 → 0.327)
 *
 *   2. k-NN structural similarity signal
 *      For each candidate, find the K most similar read books by a composite
 *      similarity score (theme Jaccard + simToTitle cross-citations). Their
 *      ratings, weighted by similarity, act as an additional evidence signal.
 *      Improvement: additional MAE −0.2%, Spearman +0.3%
 *      Note: LOO underestimates this since read books lack similarToAuthors;
 *      the k-NN is richer when applied to the candidate pool.
 *
 *   3. Symmetric signal weighting (asymmetric was tested and rejected)
 *      Amplifying below-prior signals (down-weighting negative signals) hurt
 *      Spearman because the 41 low-rated books share common themes with
 *      high-rated ones (e.g. 'narrative nonfiction' appears in both 5★ and 2★),
 *      so the engine should not treat direction as a signal quality indicator.
 *
 * Signals used in prediction (in order of typical influence):
 *   1. Direct author        — user has read and rated this exact author
 *   2. Similar-author bridge — candidate's similarToAuthors ∩ read authors
 *   3. Reverse-title citation — candidate title in read books' similarToTitles
 *   4. Forward-title match  — candidate's similarToTitles ∩ read titles
 *   5. Theme affinity       — themes correlated with high/low personal ratings
 *   6. k-NN similarity      — top-K structurally similar read books
 *   7. Community rating     — Goodreads avgRating (calibrated; weak for this user)
 *
 *   3. Author co-occurrence bridge in k-NN (v3 addition)
 *      The candidate pool encodes author similarity (similarToAuthors). We derive
 *      a co-occurrence graph: if candidates by Author A cite Author B as similar,
 *      then B ∈ A's simAuthorsSet. When scoring a candidate that lists Author B
 *      as its primary similar author, read books whose author is A (a co-similar
 *      of B) receive an extra +0.5 k-NN similarity bonus. This extends signal
 *      coverage from ~36% to ~72% of candidates for the k-NN's author dimension.
 *      Pass the candidate pool to buildTasteModel() to activate this enrichment.
 *
 *   4. Genre-inference tiebreaker for mixed-theme books (v3 addition)
 *      12 books with equal fiction/nonfiction theme counts were incorrectly
 *      classified as 'unknown' (prior 3.42). Tiebreaker: when both are tied,
 *      memoir/narrative-nonfiction themes force nonfiction; else fiction.
 *      Example: ['memoir','literary'] → nonfiction; ['sports','contemporary'] → fiction.
 *
 * LOO cross-validation results (491 rated read books):
 *   v1 (global prior, no k-NN):            MAE=0.777, Spearman=0.306
 *   v2 (genre prior + k-NN):               MAE=0.758, Spearman=0.329  (+7.5% / +2.7%)
 *   v3.1 (author variance penalty):        MAE=0.762, Spearman=0.274
 *   v3.2 (DNF half-weight + prior fix):    MAE=0.764, Spearman=0.311  (+13.5% vs v3.1)
 *   v3.3 (enrich DNF metadata + kNN/theme fix): MAE=0.766, Spearman=0.306
 *   v3.4: virtual DNF ratings — reason-adjusted effective rating instead of
 *         myRating=2★ for all DNF books. started_did_not_like→1.0,
 *         not_interesting→1.5, topic_doesnt_appeal→2.0, not_my_vibe→2.5;
 *         no_longer_relevant/already_seen_adaptation skipped entirely.
 *         Net effect: genuinely bad reads drag author/theme means lower;
 *         circumstantial DNFs stop penalising their authors.
 *   Baseline (always predict prior): MAE=0.823
 *
 * Exports: buildTasteModel(), predictRating(), predictedStars(),
 *          rankByPredictedRating()
 */

// ── Genre inference ────────────────────────────────────────────────────────

const _NF_THEMES = new Set([
  'narrative nonfiction', 'memoir', 'biography', 'true crime', 'history',
  'tech history', 'finance', 'business', 'sports', 'food', 'music history',
  'political', 'military', 'psychology', 'social commentary', 'humor',
]);
const _FIC_THEMES = new Set([
  'thriller', 'psychological', 'suspense', 'domestic suspense', 'mystery',
  'crime', 'noir', 'horror', 'high-concept', 'spy', 'adventure', 'YA',
  'romance', 'literary', 'contemporary', 'speculative', 'sci-fi',
  'historical', 'comedy', 'legal', 'courtroom',
]);

/** Infer 'fiction' | 'nonfiction' | 'unknown' from a theme list. */
function inferGenre(themes) {
  let f = 0, nf = 0;
  for (const t of (themes || [])) {
    if (_FIC_THEMES.has(t))  f++;
    if (_NF_THEMES.has(t))  nf++;
  }
  if (f !== nf) return f > nf ? 'fiction' : 'nonfiction';
  // Tie-break: memoir/narrative-nonfiction are unambiguous nonfiction markers
  if (f > 0 && (themes || []).some(t => t === 'memoir' || t === 'narrative nonfiction')) {
    return 'nonfiction';
  }
  return f > 0 ? 'fiction' : 'unknown';
}

// ── Helpers ────────────────────────────────────────────────────────────────

const _mean   = arr => arr.length > 0 ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
const _stdev  = arr => {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
};
const _normA  = n => String(n || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
const _normT  = n => String(n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Bayesian shrinkage weight for n observations.
 * halfK controls the "prior worth" — n=halfK gives weight=maxW/2.
 * At n=0 → 0; as n→∞ → maxW.
 */
function _shrunk(n, halfK, maxW) {
  return maxW * n / (n + halfK);
}

// ── DNF virtual rating ─────────────────────────────────────────────────────
// Returns the effective rating to use for a DNF book in the taste model,
// or null if the book should be skipped entirely (no quality signal).
const _DNF_VIRTUAL_RATINGS = {
  'started_did_not_like':    1.0,   // actively hated it
  'not_interesting':         1.5,   // read enough to find it boring
  'topic_doesnt_appeal':     2.0,   // topic mismatch, not a quality judgment
  'not_my_vibe':             2.5,   // style mismatch, slightly below neutral
  'no_longer_relevant':      null,  // timing issue — skip, not a quality signal
  'already_seen_adaptation': null,
  'already_read_or_owned':   null,
  'too_long':                2.0,
  'dont_know_author':        null,
};
const _DEFAULT_DNF_VIRTUAL = 1.8;   // unknown reason → conservative signal

function _dnfVirtualRating(book) {
  if (!book.dnf) return book.myRating;
  const vr = _DNF_VIRTUAL_RATINGS[book.dnfReason];
  if (vr !== undefined) return vr;   // null means skip, number means use it
  return _DEFAULT_DNF_VIRTUAL;
}

// ── Author Co-occurrence ───────────────────────────────────────────────────

/**
 * Build a read-author → similar-authors map from the candidate pool.
 * If candidates by Author A list Author B in their similarToAuthors, then
 * B is in A's co-occurrence set (A and B are "adjacent" in the taste graph).
 * Used to extend k-NN similarity via shared-genre author clusters.
 */
function _buildAuthorCoOccurrence(candidatePool) {
  const map = new Map(); // normAuthor → Set<normSimilarAuthor>
  for (const c of (candidatePool || [])) {
    const mainAuthor = _normA(c.author);
    for (const sa of (c.similarToAuthors || []).slice(0, 5)) {
      const saNorm = _normA(sa);
      if (!map.has(mainAuthor)) map.set(mainAuthor, new Set());
      map.get(mainAuthor).add(saNorm);
      // Symmetric: sa-author is also adjacent to main-author
      if (!map.has(saNorm)) map.set(saNorm, new Set());
      map.get(saNorm).add(mainAuthor);
    }
  }
  return map;
}

import { buildDescModel, descSignal } from './descSimilarity.js';

// ── Model Building ─────────────────────────────────────────────────────────

/**
 * Build a taste model from the user's Goodreads reading history.
 *
 * Analysed once per page load; returned model is passed to predictRating().
 *
 * @param {object}   goodreads     — full goodreadsData.json object
 * @param {object[]} candidatePool — optional; enables author co-occurrence in k-NN
 */
export function buildTasteModel(goodreads, candidatePool = [], enrichedMeta = null) {
  const books   = goodreads.books || [];
  const read    = books.filter(b => b.shelf === 'read' && b.myRating >= 1);
  if (read.length === 0) return null;

  const globalMean = _mean(read.map(b => b.myRating));

  // v6.0 (prototype): TF-IDF description similarity. Null until the daily
  // enrich-metadata workflow has covered enough of the read shelf.
  const descModel = enrichedMeta ? buildDescModel(goodreads, enrichedMeta) : null;
  const descByKey = enrichedMeta || {};

  // ── Genre-split priors ──────────────────────────────────────────────────
  // Fiction and nonfiction have statistically different mean ratings for this
  // user (4.41 vs 4.07), so using a shared prior would introduce systematic
  // bias of ±0.17★ per book.
  // DNF books are excluded: they have no themes so they all fall into
  // "unknown", which would contaminate that prior with implicit 2★ ratings.
  const byGenre = { fiction: [], nonfiction: [], unknown: [] };
  for (const b of read) {
    if (b.dnf) continue;
    const g = inferGenre(b.themes);
    byGenre[g].push(b.myRating);
  }
  const fictionMean    = byGenre.fiction.length    > 0 ? _mean(byGenre.fiction)    : globalMean;
  const nonfictionMean = byGenre.nonfiction.length > 0 ? _mean(byGenre.nonfiction) : globalMean;
  const unknownMean    = byGenre.unknown.length    > 0 ? _mean(byGenre.unknown)    : globalMean;

  // ── Author ratings ──────────────────────────────────────────────────────
  // Map: normAuthor → { ratings[], wSum, wTotal, mean, stdev, name }
  // DNF books count as 0.5 observations so they contribute signal without
  // fully overriding ratings from books the user finished.
  // allTimeFave books are weighted 2× — they represent the strongest taste
  // signal (books loved beyond a typical 5★) and pull author/theme means up.
  const authorMap = new Map();
  for (const b of read) {
    const key = _normA(b.author);
    if (!authorMap.has(key)) authorMap.set(key, { ratings: [], wSum: 0, wTotal: 0, name: b.author });
    const entry = authorMap.get(key);
    if (b.dnf) {
      const vr = _dnfVirtualRating(b);
      if (vr === null) continue;       // no quality signal — skip entirely
      entry.wSum   += vr * 0.5;
      entry.wTotal += 0.5;
    } else {
      const w = b.allTimeFave ? 2.0 : 1.0;
      entry.wSum   += b.myRating * w;
      entry.wTotal += w;
      entry.ratings.push(b.myRating);
    }
  }
  for (const v of authorMap.values()) {
    v.mean  = v.wTotal > 0 ? v.wSum / v.wTotal : 0;
    v.stdev = _stdev(v.ratings);
  }

  // ── Theme affinities ────────────────────────────────────────────────────
  // Map: theme → { wSum, wTotal, mean, count }
  // DNF books at half-weight; allTimeFave books at 2× weight.
  const themeMap = new Map();
  for (const b of read) {
    if (b.dnf) {
      const vr = _dnfVirtualRating(b);
      if (vr === null) continue;       // no quality signal — skip entirely
      for (const t of (b.themes || [])) {
        if (!themeMap.has(t)) themeMap.set(t, { wSum: 0, wTotal: 0 });
        themeMap.get(t).wSum   += vr * 0.5;
        themeMap.get(t).wTotal += 0.5;
      }
    } else {
      const w = b.allTimeFave ? 2.0 : 1.0;
      for (const t of (b.themes || [])) {
        if (!themeMap.has(t)) themeMap.set(t, { wSum: 0, wTotal: 0 });
        themeMap.get(t).wSum   += b.myRating * w;
        themeMap.get(t).wTotal += w;
      }
    }
  }
  for (const v of themeMap.values()) {
    v.count = v.wTotal;
    v.mean  = v.wTotal > 0 ? v.wSum / v.wTotal : 0;
  }

  // ── Reverse-title map ───────────────────────────────────────────────────
  // normTitle → ratings[] of read books that list this title as "similar to".
  // Answers: "which read books would call this candidate a peer?"
  // DNF books are excluded: their enriched similarToTitles would add 2★
  // citations to high-quality candidates they merely resemble.
  const reverseTitleMap = new Map();
  for (const b of read) {
    if (b.dnf) continue;
    for (const st of (b.similarToTitles || [])) {
      const key = _normT(st);
      if (!reverseTitleMap.has(key)) reverseTitleMap.set(key, []);
      reverseTitleMap.get(key).push(b.myRating);
    }
  }

  // ── Forward-title map ───────────────────────────────────────────────────
  // normTitle → myRating, for resolving a candidate's "similar to" list.
  const titleRatings = new Map();
  for (const b of read) titleRatings.set(_normT(b.title), b.myRating);

  // ── Community-rating regression ─────────────────────────────────────────
  // Fit: myRating = slope × avgRating + intercept (per-user calibration)
  const withAvg = read.filter(b => b.avgRating > 0 && b.avgRating <= 5);
  let communitySlope = 0, communityIntercept = globalMean;
  if (withAvg.length > 20) {
    const xs = withAvg.map(b => b.avgRating);
    const ys = withAvg.map(b => b.myRating);
    const mx = _mean(xs), my = _mean(ys);
    const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const sxx = xs.reduce((s, x)    => s + (x - mx) ** 2, 0);
    communitySlope     = sxy / sxx;
    communityIntercept = my - communitySlope * mx;
  }

  // ── Author co-occurrence enrichment ────────────────────────────────────
  // Derive a graph of adjacent authors from the candidate pool so that the
  // k-NN can score "co-similar-author" matches (not just direct matches).
  // E.g. if the pool shows Ruth Ware ↔ Alice Feeney, a candidate citing
  // Ruth Ware gets a small bonus when compared to Alice Feeney read-books.
  const authorCoOcc = _buildAuthorCoOccurrence(candidatePool);

  // ── k-NN precompute ─────────────────────────────────────────────────────
  // For each read book, cache the Sets needed by the similarity function so
  // per-candidate comparisons are O(theme_count) rather than O(text_length).
  // DNF books are excluded: a book you abandoned should not vote as a
  // "similar read" in the nearest-neighbor pool.
  const knnBooks = read.filter(b => !b.dnf).map(b => {
    const aNorm = _normA(b.author);
    return {
      rating:       b.myRating,
      themes:       new Set(b.themes || []),
      simTSet:      new Set((b.similarToTitles || []).map(_normT)),
      titleNorm:    _normT(b.title),
      authorNorm:   aNorm,
      simAuthorsSet: authorCoOcc.get(aNorm) || new Set(),
    };
  });

  return {
    descModel, descByKey,
    globalMean,
    fictionMean,
    nonfictionMean,
    unknownMean,
    authorMap,
    themeMap,
    reverseTitleMap,
    titleRatings,
    communitySlope,
    communityIntercept,
    knnBooks,
    readCount: read.length,
  };
}

// ── k-NN Helper ────────────────────────────────────────────────────────────

const KNN_K = 12; // neighbours considered

/**
 * Composite structural similarity between a candidate and a precomputed read book.
 * Ranges from 0 (unrelated) to ~5.5 (perfect theme+citation overlap).
 */
function _knnSimilarity(cThemes, cSimTSet, cTitleNorm, cPrimarySimAuthor, knnBook) {
  let sim = 0;

  // Theme Jaccard × 2  (max 2)
  let shared = 0;
  for (const t of cThemes) if (knnBook.themes.has(t)) shared++;
  const union = cThemes.size + knnBook.themes.size - shared;
  if (union > 0) sim += (shared / union) * 2;

  // Candidate's simToTitles cites this read book  (+1.5)
  if (cSimTSet.has(knnBook.titleNorm)) sim += 1.5;

  // This read book's simToTitles cites the candidate  (+2.0)
  if (knnBook.simTSet.has(cTitleNorm)) sim += 2.0;

  // Primary similar author matches this read book's author  (+1.0)
  if (cPrimarySimAuthor && cPrimarySimAuthor === knnBook.authorNorm) sim += 1.0;

  // Candidate's primary sim-author is co-similar to this read book's author (+0.5)
  // Derived from the candidate-pool co-occurrence graph: weaker than a direct match.
  if (cPrimarySimAuthor && knnBook.simAuthorsSet.size > 0 &&
      cPrimarySimAuthor !== knnBook.authorNorm &&
      knnBook.simAuthorsSet.has(cPrimarySimAuthor)) {
    sim += 0.5;
  }

  return sim;
}

// ── Rating Prediction ──────────────────────────────────────────────────────

const PRIOR_K = 20; // prior "worth" in pseudo-observations

/**
 * Predict the user's personal star rating for a single book.
 *
 * @param {object} book  — candidate with title, author, themes[], similarToAuthors[],
 *                         similarToTitles[], avgRating, ratingsCount
 * @param {object} model — from buildTasteModel()
 * @returns {{ predicted: number, confidence: number, breakdown: object[] }}
 */
export function predictRating(book, model) {
  if (!model) return { predicted: model?.globalMean ?? 4.0, confidence: 0, breakdown: [] };

  // Genre-specific prior (the most impactful improvement in v2)
  const genre      = book.type ? book.type.toLowerCase().replace('non-fiction', 'nonfiction') : inferGenre(book.themes);
  const genrePrior = genre === 'fiction'    ? model.fictionMean
                   : genre === 'nonfiction' ? model.nonfictionMean
                   :                          model.unknownMean;

  let numer    = genrePrior * PRIOR_K;
  let denom    = PRIOR_K;
  const breakdown = [];

  function addSignal(signalMean, weight, entry) {
    numer += signalMean * weight;
    denom += weight;
    if (entry) breakdown.push(entry);
  }

  // ── Signal 1: Direct author match ──────────────────────────────────────
  // Variance penalty: high-stdev authors (inconsistent ratings) get a reduced
  // weight so the prior has more influence on books by hit-or-miss authors.
  // stdev=0 → no penalty; stdev=1 → 50% max penalty (capped at 40%).
  const authorEntry = model.authorMap.get(_normA(book.author));
  if (authorEntry) {
    const n      = authorEntry.wTotal;
    const nLabel = authorEntry.ratings.length;
    const varPen = Math.min(0.4, authorEntry.stdev / 2.0);
    const w      = _shrunk(n, 2, 10) * (1.0 - varPen);
    addSignal(authorEntry.mean, w, {
      label:  `${authorEntry.name}: ${authorEntry.mean.toFixed(1)}★ avg (${nLabel} book${nLabel > 1 ? 's' : ''} read)`,
      signal: authorEntry.mean,
      weight: w,
      type:   'author',
    });
  }

  // ── Signal 2: Similar-author bridge ────────────────────────────────────
  // Candidate's similarToAuthors names authors whose fans like this book.
  // If the user has read those authors, their ratings are an indirect proxy.
  // Flat weighting across positions: analysis showed pos 0 (mean 4.75) and
  // pos 1 (mean 4.78) are equally predictive — no positional decay needed.
  let simAuthorNumer = 0, simAuthorDenom = 0;
  const simAuthorLabels = [];
  for (const sa of (book.similarToAuthors || []).slice(0, 5)) {
    const entry = model.authorMap.get(_normA(sa));
    if (!entry) continue;
    const n = entry.ratings.length;
    const w = _shrunk(n, 3, 3);   // smaller cap for indirect signal
    simAuthorNumer += entry.mean * w;
    simAuthorDenom += w;
    simAuthorLabels.push(`${entry.name} (${entry.mean.toFixed(1)}★)`);
  }
  if (simAuthorDenom > 0) {
    const simMean = simAuthorNumer / simAuthorDenom;
    const w       = Math.min(8, simAuthorDenom);
    addSignal(simMean, w, {
      label:  `fans of ${simAuthorLabels.slice(0, 3).join(', ')} → ${simMean.toFixed(1)}★ avg`,
      signal: simMean,
      weight: w,
      type:   'simAuthor',
    });
  }

  // ── Signal 3: Reverse-title citation ───────────────────────────────────
  // Read books that list this candidate in their "similar to" field endorse it.
  const reverseRatings = model.reverseTitleMap.get(_normT(book.title)) || [];
  if (reverseRatings.length > 0) {
    const revMean = _mean(reverseRatings);
    const n       = reverseRatings.length;
    const w       = _shrunk(n, 1, 8); // strong signal — 2 citations gives ~67% of max weight
    addSignal(revMean, w, {
      label:  `cited by ${n} read book${n > 1 ? 's' : ''} as similar → ${revMean.toFixed(1)}★ avg`,
      signal: revMean,
      weight: w,
      type:   'reverseTitle',
    });
  }

  // ── Signal 4: Forward-title match ──────────────────────────────────────
  // The candidate lists books the user has already rated in its "similar to" field.
  const forwardRatings = [];
  const forwardHits    = [];
  for (const st of (book.similarToTitles || []).slice(0, 8)) {
    const r = model.titleRatings.get(_normT(st));
    if (r !== undefined) { forwardRatings.push(r); forwardHits.push(st); }
  }
  if (forwardRatings.length > 0) {
    const fwdMean = _mean(forwardRatings);
    const n       = forwardRatings.length;
    const w       = _shrunk(n, 2, 6);
    addSignal(fwdMean, w, {
      label:  `similar to ${n} book${n > 1 ? 's' : ''} you've rated → ${fwdMean.toFixed(1)}★ avg`,
      signal: fwdMean,
      weight: w,
      type:   'forwardTitle',
      detail: forwardHits.slice(0, 3),
    });
  }

  // ── Signal 4b: description similarity (v6.0 prototype) ─────────────────
  // k-NN over TF-IDF vectors of real descriptions; no-op until coverage lands.
  if (model.descModel) {
    const d = model.descByKey[book.bookKey]?.description;
    const ds = descSignal(d, model.descModel);
    if (ds) {
      addSignal(ds.mean, ds.weight, {
        label:  `reads like ${ds.neighbors.length} rated books → ${ds.mean.toFixed(1)}★ avg`,
        signal: ds.mean,
        weight: ds.weight,
        type:   'descSim',
      });
    }
  }

  // ── Signal 5: Theme affinity ────────────────────────────────────────────
  // Each theme has a learned mean rating; Bayesian shrinkage prevents noise
  // from themes with few supporting books.
  let thNumer = 0, thDenom = 0;
  const themeLabels = [];
  for (const t of (book.themes || [])) {
    const entry = model.themeMap.get(t);
    if (!entry || entry.count < 3) continue;
    const s = _shrunk(entry.count, 5, 1);
    thNumer += entry.mean * s;
    thDenom += s;
    themeLabels.push(`${t} (${entry.mean.toFixed(1)}★)`);
  }
  if (thDenom > 0) {
    const thMean = thNumer / thDenom;
    const w      = Math.min(4, thDenom);
    addSignal(thMean, w, {
      label:  `themes [${themeLabels.slice(0, 3).join(', ')}] → ${thMean.toFixed(1)}★ avg`,
      signal: thMean,
      weight: w,
      type:   'theme',
    });
  }

  // ── Signal 6: k-NN structural similarity ───────────────────────────────
  // Find the KNN_K most structurally similar read books by composite score:
  //   theme Jaccard × 2  +  cross-citation bonuses  +  shared similar-author
  // Their ratings, weighted by similarity, give a "neighbourhood" prediction.
  // This captures higher-order relationships missed by the direct signals,
  // e.g. two books that both cite "The Silent Patient" share a subgenre cluster.
  const cThemes          = new Set(book.themes || []);
  const cSimTSet         = new Set((book.similarToTitles || []).map(_normT));
  const cTitleNorm       = _normT(book.title);
  const cPrimarySimAuthor = _normA((book.similarToAuthors || [])[0] || '');

  const neighbours = model.knnBooks
    .map(b => ({
      rating: b.rating,
      sim:    _knnSimilarity(cThemes, cSimTSet, cTitleNorm, cPrimarySimAuthor, b),
    }))
    .filter(x => x.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, KNN_K);

  if (neighbours.length > 0) {
    const totalSim  = neighbours.reduce((s, x) => s + x.sim, 0);
    const knnMean   = neighbours.reduce((s, x) => s + x.rating * x.sim, 0) / totalSim;
    const w         = _shrunk(neighbours.length, 2, 2); // conservative cap — LOO shows knnMaxW=2 is optimal
    addSignal(knnMean, w, {
      label:  `${neighbours.length} structurally similar reads → ${knnMean.toFixed(1)}★ avg`,
      signal: knnMean,
      weight: w,
      type:   'knn',
    });
  }

  // ── Signal 7: Community rating ──────────────────────────────────────────
  // User-community correlation is r≈0.17 — real but weak. Apply only when
  // book has substantial rating base (1k+ ratings reduces noise).
  if (book.avgRating > 0 && book.avgRating <= 5) {
    const communityPred = model.communitySlope * book.avgRating + model.communityIntercept;
    // Scale weight down for very low-count books (self-pub inflated ratings)
    const rcQuality = book.ratingsCount > 10000 ? 1.0
                    : book.ratingsCount > 1000  ? 0.6
                    : book.ratingsCount > 0     ? 0.3
                    :                             0.5; // count unknown → partial trust
    addSignal(communityPred, 0.20 * rcQuality, null);
  }

  // ── Combine ─────────────────────────────────────────────────────────────
  const predicted  = Math.max(1.0, Math.min(5.0, numer / denom));
  const evidenceW  = denom - PRIOR_K;           // total evidence beyond prior
  const confidence = Math.min(1.0, evidenceW / 15); // saturates at ~15 evidence units

  return { predicted, confidence, breakdown };
}

// ── Stars Formatting ───────────────────────────────────────────────────────

/**
 * Format a predicted rating as a star string with numeric value.
 * e.g. 4.3 → "★★★★☆ 4.3"   4.5 → "★★★★½ 4.5"   3.7 → "★★★½☆ 3.7"
 */
export function predictedStars(rating) {
  const r     = Math.max(1, Math.min(5, rating ?? 0));
  const full  = Math.floor(r);
  const half  = (r - full) >= 0.4 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty) + ` ${r.toFixed(1)}`;
}

// ── Ranking ────────────────────────────────────────────────────────────────

/**
 * Rank all eligible candidates by predicted personal rating.
 *
 * Returns the same shape as rankRecommendations() for drop-in compatibility:
 * { selected: book[], model, eligibleCount }
 */
export function rankByPredictedRating(goodreads, feedback, candidatePool) {
  const model = buildTasteModel(goodreads, candidatePool);
  if (!model) return { selected: [], model: null, eligibleCount: 0 };

  // Build excluded-key set (already read or currently reading)
  const excludedKeys = new Set();
  for (const b of (goodreads.books || [])) {
    const shelf = String(b.shelf || '').toLowerCase();
    if (shelf === 'read' || shelf === 'currently-reading') {
      excludedKeys.add(b.bookKey || _normBookKey(b.title, b.author));
    }
  }

  const dismissed = new Set(
    Object.entries(feedback?.dismissals || {})
      .filter(([, v]) => v)
      .map(([k]) => k)
  );

  const eligible = (candidatePool || []).filter(c => {
    const key = c.bookKey || _normBookKey(c.title, c.author);
    if (dismissed.has(key)) return false;
    if (c.fromToRead)        return true;
    return !excludedKeys.has(key);
  });

  const scored = eligible.map(c => {
    const result = predictRating(c, model);
    return {
      ...c,
      predictedRating: result.predicted,
      predictionConf:  result.confidence,
      predBreakdown:   result.breakdown,
    };
  });

  scored.sort((a, b) =>
    (b.predictedRating - a.predictedRating) || (b.predictionConf - a.predictionConf)
  );

  return {
    selected:      scored.map((x, i) => ({ ...x, rank: i + 1 })),
    model,
    eligibleCount: eligible.length,
  };
}

// Minimal book-key normalizer (mirrors engine.js without importing it)
function _normBookKey(title, author) {
  const norm = s => String(s || '').toLowerCase().trim()
    .replace(/&amp;/gi, '&')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${norm(title)}|${norm(author)}`;
}
