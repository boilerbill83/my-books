/**
 * bbreEngine.js  —  Bills Books Recommendation Engine (BBRE) v3
 *
 * Combines two engines to leverage each one's strengths:
 *
 *   rateEngine.js  — Bayesian shrinkage model trained on all 1–5★ ratings.
 *                    LOO MAE 0.763 vs baseline 0.820; standalone LOO Spearman 0.462.
 *                    Weakness: clusters on dominant authors.
 *
 *   engine.js      — Rule-based 5★ citation network.
 *                    Broad author/theme coverage, human-readable reasons.
 *                    Weakness: score ceiling (34 books all score 100), 5★-only data.
 *
 * BBRE v4 algorithm:
 *   1. Run both models and attach predictions to each eligible candidate.
 *   2. Normalise within genre (fiction / nonfiction) so each genre's top book
 *      competes at score 1.0.  Prevents the fiction-skewed 5★ network from
 *      burying nonfiction.
 *   3. Confidence-adaptive combination: at conf=1 the tuned 40/60 split applies;
 *      at lower confidence the engine.js signal absorbs the slack.
 *   4. Apply three additive signal adjustments:
 *        a. Series continuity  — boost/penalise sequels based on earlier-book ratings.
 *        b. Temporal recency   — small bias toward authors trending up in last 2 years.
 *        c. DNF/low-rated penalty — themes over-represented in DNF books penalised;
 *           authors with ≥2 reads all rated ≤2.5★ also penalised.
 *        d. (Confidence-adaptive handled in step 3.)
 *   5. Greedy author + sub-genre diversity re-ranking to break clusters at both levels.
 *   6. Return same shape as rankRecommendations() so app.js needs no changes.
 *
 * Tuning history (full-pool LOO Spearman from grid search):
 *   v1: BAYES=0.65, global norm, no adjustments                   → 0.627
 *   v2: BAYES=0.40, within-genre norm                             → 0.656  (+0.029)
 *   v3: conf-adaptive + series + recency + DNF lift               → 0.656  (structural)
 *   v4: + low-rated author penalty + sub-genre theme MMR          → see eval below
 *
 * Exports:
 *   rankBBRE(goodreads, feedback, candidatePool, history) → { selected, profile, eligibleCount }
 */

import { buildTasteModel, predictRating } from './rateEngine.js';
import { rankRecommendations }            from './engine.js';

// ── Tuning constants ───────────────────────────────────────────────────────

// Base Bayes weight at full confidence (conf=1.0).  Engine absorbs the rest.
// LOO-tuned optimum: 0.40 (engine.js citation signal is more discriminating).
const BAYES_WEIGHT = 0.40;

// Author-diversity MMR penalty per additional same-author book already ranked.
const DIVERSITY_PENALTY = [0, 0.10, 0.18, 0.25, 0.30];

// Sub-genre (primary theme) diversity penalty — softer than author penalty.
const THEME_DIVERSITY_PENALTY = [0, 0.04, 0.07, 0.09, 0.10];

// How many calendar years to look back for the "recent taste" recency window.
const RECENCY_WINDOW_YEARS = 2;

// DNF theme lift threshold.  Themes appearing at 2× or more the rate in DNF
// books vs overall reads are treated as mild negative signals.
const DNF_LIFT_THRESHOLD = 2.0;
const DNF_THEME_MIN_RATE = 0.08;   // theme must appear in ≥8% of DNFs to count

// ── Genre helpers ──────────────────────────────────────────────────────────

const NF_THEMES = new Set([
  'narrative nonfiction','memoir','biography','true crime','history','military',
  'tech history','business','finance','sports','food','psychology','political',
  'social commentary','music history',
]);
const FIC_THEMES = new Set([
  'thriller','mystery','literary','contemporary','romance','horror','sci-fi',
  'speculative','crime','suspense','domestic suspense','psychological',
  'historical fiction','ya','adventure','high-concept','noir','legal','courtroom',
]);

function inferGenre(themes) {
  let nf = 0, f = 0;
  for (const t of (themes || [])) {
    const tl = String(t).toLowerCase();
    if (NF_THEMES.has(tl))  nf++;
    if (FIC_THEMES.has(tl)) f++;
  }
  if (nf > f) return 'nonfiction';
  if (f > nf) return 'fiction';
  return 'unknown';
}

// ── Normalisation ──────────────────────────────────────────────────────────

function normaliseField(books, srcField, dstField) {
  if (books.length === 0) return books;
  const vals = books.map(b => b[srcField]);
  const min  = Math.min(...vals), max = Math.max(...vals);
  const rng  = max - min || 1;
  return books.map(b => ({ ...b, [dstField]: (b[srcField] - min) / rng }));
}

// ── Shared key helper ──────────────────────────────────────────────────────

const normA = a => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Primary sub-genre for theme-level MMR (first theme tag, or null if none).
function primaryTheme(book) {
  return book.themes && book.themes.length > 0 ? book.themes[0] : null;
}

// ── 1. Series continuity ───────────────────────────────────────────────────
// Parse "(Series Name, #N)" from Goodreads-style titles.

function parseSeries(title) {
  const m = String(title || '').match(/\(([^,#)]+),?\s*#(\d+)\)/);
  return m ? { name: m[1].trim().toLowerCase(), num: parseInt(m[2], 10) } : null;
}

function buildSeriesMap(readBooks) {
  // seriesKey → { ratings[], mean }
  const map = new Map();
  for (const b of readBooks) {
    const s = parseSeries(b.title);
    if (!s) continue;
    if (!map.has(s.name)) map.set(s.name, { ratings: [] });
    // DNF books contribute rating=2 (same as their stored myRating)
    if (b.myRating > 0) map.get(s.name).ratings.push(b.myRating);
  }
  for (const e of map.values()) {
    e.mean = e.ratings.length
      ? e.ratings.reduce((s, v) => s + v, 0) / e.ratings.length
      : null;
  }
  return map;
}

// Returns a score delta in roughly [-0.08, +0.07] applied before diversity.
function seriesSignal(book, seriesMap) {
  const s = parseSeries(book.title);
  if (!s || s.num <= 1) return 0;       // only applies to book 2, 3, 4, …
  const entry = seriesMap.get(s.name);
  if (!entry || entry.mean === null) return 0;
  // Deviation from neutral 3.5★; scale so ±1.5★ → ±0.075
  return (entry.mean - 3.5) * 0.05;
}

// ── 2. Temporal recency ────────────────────────────────────────────────────
// Small bias toward authors whose recent reads (last 2 years) are trending
// above or below their all-time average.

function buildTemporalMaps(readBooks) {
  const cutoffMs = Date.now() - RECENCY_WINDOW_YEARS * 365.25 * 24 * 3600 * 1000;
  const recent   = new Map();  // normAuthor → { sum, count }
  const allTime  = new Map();

  for (const b of readBooks) {
    if (b.dnf || !b.myRating) continue;
    const ak = normA(b.author);

    // All-time
    if (!allTime.has(ak)) allTime.set(ak, { sum: 0, count: 0 });
    const at = allTime.get(ak);
    at.sum += b.myRating; at.count++;

    // Recent
    if (b.dateRead && new Date(b.dateRead).getTime() >= cutoffMs) {
      if (!recent.has(ak)) recent.set(ak, { sum: 0, count: 0 });
      const rc = recent.get(ak);
      rc.sum += b.myRating; rc.count++;
    }
  }

  for (const e of allTime.values()) e.mean = e.sum / e.count;
  for (const e of recent.values())  e.mean = e.sum / e.count;
  return { recent, allTime };
}

// Returns a score delta in roughly [-0.05, +0.05].
function recencySignal(book, recent, allTime) {
  const ak = normA(book.author);
  const r  = recent.get(ak);
  const a  = allTime.get(ak);
  if (!r || !a || r.count < 2) return 0;  // need ≥2 recent reads to detect a trend
  const drift = r.mean - a.mean;          // positive = trending up
  return drift * 0.025;
}

// ── 3. DNF lift penalty ───────────────────────────────────────────────────
// Penalise themes that are statistically over-represented in DNF books
// relative to the user's overall reading (lift = dnf_rate / all_read_rate).
// Does NOT penalise themes the user simply reads a lot of — only themes
// specifically associated with abandonment.

function buildDnfSignal(readBooks) {
  const dnfBooks    = readBooks.filter(b => b.dnf);
  const totalReads  = readBooks.length;
  const totalDnf    = dnfBooks.length;
  if (totalDnf === 0) return { dnfThemeLift: new Map(), dnfOnlyAuthors: new Set() };

  // Theme counts across all reads and DNF-only
  const allThemeCnt = new Map();
  const dnfThemeCnt = new Map();
  for (const b of readBooks) {
    for (const t of (b.themes || [])) {
      allThemeCnt.set(t, (allThemeCnt.get(t) || 0) + 1);
      if (b.dnf) dnfThemeCnt.set(t, (dnfThemeCnt.get(t) || 0) + 1);
    }
  }

  // Compute lift per theme
  const dnfThemeLift = new Map();
  for (const [t, dnfCnt] of dnfThemeCnt) {
    const dnfRate  = dnfCnt / totalDnf;
    const allRate  = (allThemeCnt.get(t) || 0) / totalReads;
    if (allRate === 0 || dnfRate < DNF_THEME_MIN_RATE) continue;
    const lift = dnfRate / allRate;
    if (lift >= DNF_LIFT_THRESHOLD) dnfThemeLift.set(t, lift);
  }

  // Authors who appear only in DNF (zero completed reads) with 2+ DNFs
  const ratedAuthorSet = new Set(
    readBooks.filter(b => !b.dnf && b.myRating > 0).map(b => normA(b.author))
  );
  const dnfAuthorCnt = new Map();
  for (const b of dnfBooks) dnfAuthorCnt.set(normA(b.author), (dnfAuthorCnt.get(normA(b.author)) || 0) + 1);
  const dnfOnlyAuthors = new Set(
    [...dnfAuthorCnt.entries()]
      .filter(([ak, cnt]) => cnt >= 2 && !ratedAuthorSet.has(ak))
      .map(([ak]) => ak)
  );

  // Authors with ≥2 completed reads whose mean rating is < 2.5★ — you've tried
  // them and consistently didn't enjoy the work.
  const authorRatings = new Map();
  for (const b of readBooks) {
    if (!b.dnf && b.myRating > 0) {
      const ak = normA(b.author);
      if (!authorRatings.has(ak)) authorRatings.set(ak, { sum: 0, count: 0 });
      const e = authorRatings.get(ak);
      e.sum += b.myRating; e.count++;
    }
  }
  const lowRatedAuthors = new Set(
    [...authorRatings.entries()]
      .filter(([, e]) => e.count >= 2 && e.sum / e.count < 2.5)
      .map(([ak]) => ak)
  );

  return { dnfThemeLift, dnfOnlyAuthors, lowRatedAuthors };
}

// Returns a non-negative penalty in [0, 0.12].
function dnfPenalty(book, dnfSignal) {
  const { dnfThemeLift, dnfOnlyAuthors, lowRatedAuthors } = dnfSignal;
  let pen = 0;
  if (dnfOnlyAuthors.has(normA(book.author)))  pen += 0.08;
  if (lowRatedAuthors.has(normA(book.author))) pen += 0.08;
  for (const t of (book.themes || [])) {
    if (dnfThemeLift.has(t)) pen += 0.015;
  }
  return Math.min(pen, 0.12);
}

// ── 4. Confidence-adaptive combination ────────────────────────────────────
// At full confidence (conf=1): tuned 40/60 Bayes/Engine split.
// At lower confidence: engine.js signal absorbs the slack so cold-start
// books aren't pulled down by a weak Bayesian prior.

function adaptiveCombine(normBayes, normEngine, conf) {
  const bw = BAYES_WEIGHT * conf;         // 0 at conf=0, 0.40 at conf=1
  return bw * normBayes + (1 - bw) * normEngine;
}

// ── Main export ────────────────────────────────────────────────────────────

export function rankBBRE(goodreads, feedback, candidatePool, history) {

  // ── Step 1: run both models ──────────────────────────────────────────────
  const model        = buildTasteModel(goodreads, candidatePool);
  const engineResult = rankRecommendations(goodreads, feedback, candidatePool, history);

  if (engineResult.selected.length === 0) {
    return { selected: [], profile: engineResult.profile, eligibleCount: 0 };
  }

  const allReadBooks = (goodreads.books || []).filter(b => b.shelf === 'read');

  // ── Step 2: pre-build all signal maps ───────────────────────────────────
  const seriesMap          = buildSeriesMap(allReadBooks);
  const { recent, allTime } = buildTemporalMaps(allReadBooks);
  const dnfSig             = buildDnfSignal(allReadBooks);

  // ── Step 3: attach rateEngine predictions ───────────────────────────────
  const withPred = engineResult.selected.map(eb => {
    const rr = predictRating(eb, model);
    return { ...eb, _pred: rr.predicted, _conf: rr.confidence, _bayesBD: rr.breakdown };
  });

  // ── Step 4: within-genre normalisation ──────────────────────────────────
  const groups = { fiction: [], nonfiction: [], unknown: [] };
  for (const b of withPred) groups[inferGenre(b.themes)].push(b);

  const normalised = Object.values(groups).flatMap(grp => {
    let g = normaliseField(grp, '_pred',      '_normBayes');
    g     = normaliseField(g,   'matchScore', '_normEngine');
    return g;
  });

  // ── Step 5: combine with adjustments ────────────────────────────────────
  const withScores = normalised.map(b => {
    const base       = adaptiveCombine(b._normBayes, b._normEngine, b._conf);
    const seriesAdj  = seriesSignal(b, seriesMap);
    const recencyAdj = recencySignal(b, recent, allTime);
    const dnfPen     = dnfPenalty(b, dnfSig);
    const combined   = Math.max(0, base + seriesAdj + recencyAdj - dnfPen);
    return { ...b, _combined: combined, _base: base, _seriesAdj: seriesAdj, _recencyAdj: recencyAdj, _dnfPen: dnfPen };
  });

  withScores.sort((a, b) => b._combined - a._combined);

  // ── Step 6: greedy author-diversity re-ranking ───────────────────────────
  const pool       = [...withScores];
  const authorSeen = new Map();
  const themeSeen  = new Map();
  const reranked   = [];

  while (pool.length > 0) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const b       = pool[i];
      const authCnt = authorSeen.get(normA(b.author)) || 0;
      const authPen = DIVERSITY_PENALTY[Math.min(authCnt, DIVERSITY_PENALTY.length - 1)];
      const pt      = primaryTheme(b);
      const themCnt = pt ? (themeSeen.get(pt) || 0) : 0;
      const themPen = THEME_DIVERSITY_PENALTY[Math.min(themCnt, THEME_DIVERSITY_PENALTY.length - 1)];
      const s       = b._combined - authPen - themPen;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    const sel  = pool.splice(bestIdx, 1)[0];
    const ak   = normA(sel.author);
    const pt   = primaryTheme(sel);
    const prev = authorSeen.get(ak) || 0;
    authorSeen.set(ak, prev + 1);
    if (pt) themeSeen.set(pt, (themeSeen.get(pt) || 0) + 1);
    reranked.push({ ...sel, _bbreScore: bestScore, _diversityPen: sel._combined - bestScore, _authorSlot: prev + 1 });
  }

  // ── Step 7: shape output ─────────────────────────────────────────────────
  const selected = reranked.map((b, i) => {
    const matchScore = Math.max(1, Math.round(b._bbreScore * 100));

    // Bayesian component pts: scale by adaptive weight
    const bayesPts = Math.round(BAYES_WEIGHT * b._conf * b._normBayes * 100);
    const engPts   = Math.round((1 - BAYES_WEIGHT * b._conf) * b._normEngine * 100);

    // Adjustment entries (only show non-zero)
    const adj = [
      b._seriesAdj > 0.005   && { label: `series continuity — prior books avg ${((b._seriesAdj / 0.05) + 3.5).toFixed(1)}★`, pts: Math.round(b._seriesAdj * 100) },
      b._seriesAdj < -0.005  && { label: `series continuity — prior books below expectations`,                                  pts: Math.round(b._seriesAdj * 100) },
      b._recencyAdj > 0.005  && { label: `author trending up in your recent reads`,   pts: Math.round(b._recencyAdj * 100) },
      b._recencyAdj < -0.005 && { label: `author trending down in recent reads`,       pts: Math.round(b._recencyAdj * 100) },
      b._dnfPen > 0.005      && { label: `theme or author overlap with low-rated/DNF books`, pts: -Math.round(b._dnfPen * 100) },
      b._diversityPen > 0.005 && { label: `variety discount`, pts: -Math.round(b._diversityPen * 100) || -1 },
    ].filter(Boolean);

    const breakdown = [
      { label: `Taste model: ${b._pred.toFixed(2)}★ predicted (${Math.round(b._conf * 100)}% confident)`, pts: bayesPts },
      ..._distPts(b._bayesBD, bayesPts),
      { label: `Citation network score ${b.matchScore}`, pts: engPts },
      ...adj,
    ].filter(s => s.pts !== 0).sort((a, x) => Math.abs(x.pts) - Math.abs(a.pts));

    return {
      ...b,
      rank:      i + 1,
      matchScore,
      reason:    b.reason || '',
      breakdown,
      bbreDetails: {
        genre:        inferGenre(b.themes),
        predicted:    b._pred,
        confidence:   b._conf,
        normBayes:    b._normBayes,
        normEngine:   b._normEngine,
        base:         b._base,
        seriesAdj:    b._seriesAdj,
        recencyAdj:   b._recencyAdj,
        dnfPen:       b._dnfPen,
        diversityPen: b._diversityPen,
        combined:     b._combined,
        bbreScore:    b._bbreScore,
        authorSlot:   b._authorSlot,
      },
    };
  });

  return { selected, profile: engineResult.profile, eligibleCount: engineResult.eligibleCount };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _distPts(breakdown, totalPts) {
  if (!breakdown || breakdown.length === 0) return [];
  const totalW = breakdown.reduce((s, x) => s + x.weight, 0);
  if (totalW === 0) return [];
  return breakdown
    .map(sig => ({ label: sig.label, pts: Math.round((sig.weight / totalW) * totalPts) }))
    .filter(s => s.pts !== 0);
}
