/**
 * bbreEngine.js  —  Bills Books Recommendation Engine (BBRE)
 *
 * Combines two engines to leverage each one's strengths:
 *
 *   rateEngine.js  — Bayesian shrinkage model trained on all 1–5★ ratings.
 *                    LOO MAE 0.763 vs baseline 0.820; LOO Spearman 0.462.
 *                    Weakness: clusters on dominant authors.
 *
 *   engine.js      — Rule-based 5★ citation network.
 *                    Broad author/theme coverage, human-readable reasons.
 *                    Weakness: score ceiling (34 books all score 100), 5★-only data.
 *
 * BBRE algorithm:
 *   1. Compute raw scores from both models.
 *   2. Normalize within each genre (fiction / nonfiction) separately so each
 *      genre's best book competes at score 1.0 — prevents the fiction-skewed
 *      5★ citation network from systematically burying nonfiction.
 *   3. Combine: 40% Bayesian + 60% citation network (LOO-tuned optimum).
 *   4. Greedy author-diversity re-ranking (MMR-style) to break author clusters.
 *   5. Return same shape as rankRecommendations() so app.js needs no changes.
 *
 * Tuning history (LOO Spearman):
 *   BAYES=0.65 (original)  → 0.627
 *   BAYES=0.40 (current)   → 0.656  (+0.029)
 *
 * Exports:
 *   rankBBRE(goodreads, feedback, candidatePool, history) → { selected, profile, eligibleCount }
 */

import { buildTasteModel, predictRating } from './rateEngine.js';
import { rankRecommendations }            from './engine.js';

// ── Tuning knobs ───────────────────────────────────────────────────────────

// LOO-optimised at BAYES=0.40; engine.js citation signal is more discriminating
// for this user's catalogue (Spearman 0.634 vs rateEngine 0.462 standalone).
const BAYES_WEIGHT  = 0.40;
const ENGINE_WEIGHT = 0.60;

// Diversity penalty for the Nth book by the same author already ranked above.
// count=0 (first book): no penalty; count=1 (second): -0.10; etc.
const DIVERSITY_PENALTY = [0, 0.10, 0.18, 0.25, 0.30];

// Genre tags used to split the normalisation pool so fiction and nonfiction
// compete on equal footing despite the fiction-skewed 5★ citation network.
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

const normAuthorKey = a => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase();

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

// Normalise a field to [0,1] within an array of books; returns new objects.
function normaliseField(books, field, outField) {
  if (books.length === 0) return books;
  const vals = books.map(b => b[field]);
  const min  = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  return books.map(b => ({ ...b, [outField]: (b[field] - min) / range }));
}

// ── Main export ────────────────────────────────────────────────────────────

export function rankBBRE(goodreads, feedback, candidatePool, history) {

  // ── 1. Bayesian model ────────────────────────────────────────────────────
  const model = buildTasteModel(goodreads, candidatePool);

  // ── 2. Engine.js (handles exclusion filtering & supplies profile) ────────
  const engineResult = rankRecommendations(goodreads, feedback, candidatePool, history);

  if (engineResult.selected.length === 0) {
    return { selected: [], profile: engineResult.profile, eligibleCount: 0 };
  }

  // Attach rateEngine predictions to each eligible book
  const withPred = engineResult.selected.map(eb => {
    const rr = predictRating(eb, model);
    return { ...eb, _pred: rr.predicted, _conf: rr.confidence, _bayesBD: rr.breakdown };
  });

  // ── 3. Within-genre normalisation ───────────────────────────────────────
  // Split into fiction / nonfiction / unknown, normalise each group
  // independently, then re-merge.  Prevents the fiction-heavy 5★ network
  // from compressing all nonfiction scores to the bottom of the range.
  const groups = { fiction: [], nonfiction: [], unknown: [] };
  for (const b of withPred) groups[inferGenre(b.themes)].push(b);

  const normalised = Object.values(groups).flatMap(grp => {
    let g = normaliseField(grp,  '_pred',     '_normBayes');
    g     = normaliseField(g,    'matchScore','_normEngine');
    return g.map(b => ({ ...b, _combined: BAYES_WEIGHT * b._normBayes + ENGINE_WEIGHT * b._normEngine }));
  });

  normalised.sort((a, b) => b._combined - a._combined);

  // ── 4. Greedy author-diversity re-ranking ────────────────────────────────
  const pool       = [...normalised];
  const authorSeen = new Map();
  const reranked   = [];

  while (pool.length > 0) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const b     = pool[i];
      const count = authorSeen.get(normAuthorKey(b.author)) || 0;
      const pen   = DIVERSITY_PENALTY[Math.min(count, DIVERSITY_PENALTY.length - 1)];
      const s     = b._combined - pen;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    const sel = pool.splice(bestIdx, 1)[0];
    const ak  = normAuthorKey(sel.author);
    const prev = authorSeen.get(ak) || 0;
    authorSeen.set(ak, prev + 1);
    reranked.push({ ...sel, _bbreScore: bestScore, _authorSlot: prev + 1 });
  }

  // ── 5. Shape output ──────────────────────────────────────────────────────
  const selected = reranked.map((b, i) => {
    const matchScore = Math.max(1, Math.round(b._bbreScore * 100));
    const bayesPts   = Math.round(b._normBayes  * BAYES_WEIGHT  * 100);
    const engPts     = Math.round(b._normEngine * ENGINE_WEIGHT * 100);

    // Bayesian signals: distribute bayesPts proportionally across rateEngine signals.
    // Show them in detail; do NOT repeat engine.js's individual breakdown entries
    // because both engines draw from the same similarToAuthors edges (duplicates).
    const bayesSignals = _distPts(b._bayesBD, bayesPts);

    // Diversity adjustment
    const penPts = Math.round((b._combined - b._bbreScore) * -100);
    const divEntry = b._authorSlot > 1 && penPts > 0
      ? [{ label: `book ${b._authorSlot} by ${b.author.replace(/\s+/g,' ')} — variety discount`, pts: -penPts }]
      : [];

    const breakdown = [
      { label: `Taste model: ${b._pred.toFixed(2)}★ predicted (${Math.round(b._conf * 100)}% confident)`, pts: bayesPts },
      ...bayesSignals,
      { label: `Citation network score ${b.matchScore}`, pts: engPts },
      ...divEntry,
    ].filter(s => s.pts !== 0).sort((a, x) => Math.abs(x.pts) - Math.abs(a.pts));

    return {
      ...b,
      rank:      i + 1,
      matchScore,
      reason:    b.reason || '',
      breakdown,
      bbreDetails: {
        genre:      inferGenre(b.themes),
        predicted:  b._pred,
        confidence: b._conf,
        normBayes:  b._normBayes,
        normEngine: b._normEngine,
        combined:   b._combined,
        bbreScore:  b._bbreScore,
        authorSlot: b._authorSlot,
      },
    };
  });

  return { selected, profile: engineResult.profile, eligibleCount: engineResult.eligibleCount };
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Distribute totalPts across rateEngine breakdown signals proportionally to weight.
function _distPts(breakdown, totalPts) {
  if (!breakdown || breakdown.length === 0) return [];
  const totalW = breakdown.reduce((s, x) => s + x.weight, 0);
  if (totalW === 0) return [];
  return breakdown
    .map(sig => ({ label: sig.label, pts: Math.round((sig.weight / totalW) * totalPts) }))
    .filter(s => s.pts !== 0);
}
