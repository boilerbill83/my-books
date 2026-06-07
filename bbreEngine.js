/**
 * bbreEngine.js  —  Bills Books Recommendation Engine (BBRE)
 *
 * Combines two engines to leverage each one's strengths:
 *
 *   rateEngine.js  — Bayesian shrinkage model trained on all 1–5★ ratings.
 *                    Accurate predicted rating, LOO MAE 0.76 vs baseline 0.82.
 *                    Weakness: clusters on dominant authors.
 *
 *   engine.js      — Rule-based 5★ citation network.
 *                    Broad author/theme coverage, human-readable reasons.
 *                    Weakness: score ceiling (34 books all score 100), 5★-only data.
 *
 * BBRE algorithm:
 *   1. Normalize both scores to [0, 1] against observed range.
 *   2. Combine: 65% Bayesian + 35% Engine.
 *   3. Greedy author-diversity re-ranking (MMR-style) to break author clusters.
 *   4. Return same shape as rankRecommendations() so app.js needs no changes.
 *
 * Exports:
 *   rankBBRE(goodreads, feedback, candidatePool, history) → { selected, profile, eligibleCount }
 */

import { buildTasteModel, predictRating } from './rateEngine.js';
import { rankRecommendations }            from './engine.js';

// ── Tuning knobs ───────────────────────────────────────────────────────────

const BAYES_WEIGHT  = 0.65;   // share of combined score from Bayesian prediction
const ENGINE_WEIGHT = 0.35;   // share from engine.js citation/breadth signals

// Diversity penalty applied to the Nth book by the same author (0-indexed count
// of how many books by this author have already been selected above this one).
// A penalty of 0.10 shifts a book down roughly 10 points in a 0–100 display.
const DIVERSITY_PENALTY = [0, 0.10, 0.18, 0.25, 0.30];

const normAuthorKey = a => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase();

// ── Main export ────────────────────────────────────────────────────────────

export function rankBBRE(goodreads, feedback, candidatePool, history) {

  // ── 1. Bayesian model ────────────────────────────────────────────────────
  const model = buildTasteModel(goodreads, candidatePool);

  // ── 2. Engine.js (also handles exclusion filtering & profile) ───────────
  const engineResult = rankRecommendations(goodreads, feedback, candidatePool, history);
  const engineByKey  = new Map(engineResult.selected.map(b => [b.bookKey, b]));

  // Only books that passed engine.js exclusion filter are eligible
  const eligible = engineResult.selected.map(eb => {
    const rr = predictRating(eb, model);
    return {
      ...eb,
      _pred:          rr.predicted,
      _conf:          rr.confidence,
      _bayesBreakdown: rr.breakdown,   // [{label, signal, weight, type}]
    };
  });

  if (eligible.length === 0) {
    return { selected: [], profile: engineResult.profile, eligibleCount: 0 };
  }

  // ── 3. Normalize both dimensions to [0, 1] ──────────────────────────────
  const preds  = eligible.map(b => b._pred);
  const eScores = eligible.map(b => b.matchScore);
  const pMin = Math.min(...preds),  pMax = Math.max(...preds);
  const eMin = Math.min(...eScores), eMax = Math.max(...eScores);
  const pRange = pMax - pMin || 1;
  const eRange = eMax - eMin || 1;

  const withCombined = eligible.map(b => ({
    ...b,
    _normBayes:  (b._pred  - pMin) / pRange,
    _normEngine: (b.matchScore - eMin) / eRange,
    get _combined() { return BAYES_WEIGHT * this._normBayes + ENGINE_WEIGHT * this._normEngine; },
  })).map(b => ({ ...b, _combined: b._combined }));

  withCombined.sort((a, b) => b._combined - a._combined);

  // ── 4. Greedy author-diversity re-ranking ────────────────────────────────
  // At each position pick the book with the highest (combined − diversity_penalty).
  // This is O(n²) but n ≤ ~350 so negligible.
  const pool       = [...withCombined];
  const authorSeen = new Map();
  const reranked   = [];

  while (pool.length > 0) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const b     = pool[i];
      const ak    = normAuthorKey(b.author);
      const count = authorSeen.get(ak) || 0;
      const pen   = DIVERSITY_PENALTY[Math.min(count, DIVERSITY_PENALTY.length - 1)];
      const score = b._combined - pen;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    const sel  = pool.splice(bestIdx, 1)[0];
    const ak   = normAuthorKey(sel.author);
    const prev = authorSeen.get(ak) || 0;
    authorSeen.set(ak, prev + 1);
    reranked.push({ ...sel, _bbreScore: bestScore, _authorSlot: prev + 1 });
  }

  // ── 5. Shape output to match rankRecommendations() contract ─────────────
  const selected = reranked.map((b, i) => {
    const matchScore = Math.max(1, Math.round(b._bbreScore * 100));

    // Bayesian signals → pts (deviation from genre-expected mean, scaled for display)
    const bayesPts = Math.round(b._normBayes * BAYES_WEIGHT * 100);
    const engPts   = Math.round(b._normEngine * ENGINE_WEIGHT * 100);

    // Convert rateEngine signals to displayable pts
    const bayesSigPts = _bayesBreakdownToPts(b._bayesBreakdown, bayesPts);

    // Scale engine.js breakdown pts by ENGINE_WEIGHT so combined makes sense
    const engineSigPts = (b.breakdown || []).map(s => ({
      label: s.label,
      pts:   Math.round(s.pts * ENGINE_WEIGHT),
    })).filter(s => s.pts !== 0);

    // Diversity adjustment entry (if not the first book by this author)
    const diversityEntry = b._authorSlot > 1
      ? [{ label: `book ${b._authorSlot} by ${b.author.replace(/\s+/g,' ')} — variety discount`, pts: Math.round((b._combined - b._bbreScore) * -100) || 0 }]
      : [];

    const breakdown = [
      { label: `Taste model: ${b._pred.toFixed(2)}★ predicted (${Math.round(b._conf * 100)}% confident)`, pts: bayesPts },
      ...bayesSigPts,
      { label: `Citation network score ${b.matchScore}`, pts: engPts },
      ...engineSigPts,
      ...diversityEntry,
    ].filter(s => s.pts !== 0).sort((a, x) => Math.abs(x.pts) - Math.abs(a.pts));

    return {
      ...b,
      rank:       i + 1,
      matchScore,
      reason:     b.reason || '',
      breakdown,
      // Extra fields for debugging / future use
      bbreDetails: {
        predicted:   b._pred,
        confidence:  b._conf,
        normBayes:   b._normBayes,
        normEngine:  b._normEngine,
        combined:    b._combined,
        bbreScore:   b._bbreScore,
        authorSlot:  b._authorSlot,
      },
    };
  });

  return {
    selected,
    profile:       engineResult.profile,
    eligibleCount: engineResult.eligibleCount,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Convert rateEngine's [{label, signal, weight, type}] signals into pts
// by measuring each signal's pull relative to the estimated genre prior.
// The total bayesPts (0–65) is distributed proportionally to signal weights.
function _bayesBreakdownToPts(breakdown, totalBayesPts) {
  if (!breakdown || breakdown.length === 0) return [];
  const totalWeight = breakdown.reduce((s, x) => s + x.weight, 0);
  if (totalWeight === 0) return [];

  return breakdown.map(sig => {
    const share = sig.weight / totalWeight;
    const pts   = Math.round(share * totalBayesPts);
    return { label: sig.label, pts };
  }).filter(s => s.pts !== 0);
}
