/**
 * bbreEngine.js  —  Bills Books Recommendation Engine (BBRE) v5.5
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
 * BBRE v5 algorithm:
 *   1. Run both models and attach predictions to each eligible candidate.
 *   2. Normalise within genre (fiction / nonfiction) so each genre's top book
 *      competes at score 1.0.  Prevents the fiction-skewed 5★ network from
 *      burying nonfiction.
 *   3. Confidence-adaptive combination: at conf=1 the tuned 40/60 split applies;
 *      at lower confidence the engine.js signal absorbs the slack.
 *   4. Apply four additive signal adjustments:
 *        a. Series continuity  — boost/penalise sequels based on earlier-book ratings.
 *        b. Temporal recency   — small bias toward authors trending up in last 2 years.
 *        c. DNF/low-rated penalty — themes AND tones over-represented in DNF books
 *           penalised; authors with ≥2 reads all rated ≤2.5★ also penalised.
 *        d. Tone preference    — ±0.08 signal from user's mean rating per tone tag.
 *   5. Three-layer greedy MMR: author → sub-genre theme → granular tone diversity.
 *   6. Return same shape as rankRecommendations() so app.js needs no changes.
 *
 * Tuning history (full-pool LOO Spearman from grid search):
 *   v1: BAYES=0.65, global norm, no adjustments                   → 0.627
 *   v2: BAYES=0.40, within-genre norm                             → 0.656  (+0.029)
 *   v3: conf-adaptive + series + recency + DNF lift               → 0.656  (structural)
 *   v4: + low-rated author penalty + sub-genre theme MMR          → 0.656  (structural)
 *   v5: + tone preference signal + tone DNF lift + tone MMR layer → see eval below
 *   v5.1: + community signal (ratingsCount × avgRating + optional googleRating)
 *   v5.2: recalibrate tone signal (0.02→0.030, cap 0.08→0.12), raise community
 *         neutral (3.75→3.80) and max lift (0.04→0.06), lower DNF threshold
 *         (2.0→1.7).  Data: twisty +0.45★, compulsive +0.38★, tense +0.28★
 *         vs revelatory -0.40★, conversational -0.27★ vs Bill's 4.23 mean.
 *   v5.3: allTimeFave books (Goodreads "all-time-faves" shelf) weighted 2× in
 *         rateEngine author/theme maps — equivalent to treating them as 6★.
 *   v5.4: lift-scaled DNF penalties (lift×0.008/0.006 vs flat 0.015/0.012);
 *         dismissed reason codes feed theme/tone signal (wrong_genre 0.6×,
 *         author_not_appealing 0.4×, etc.); combo multiplier 1.5× when ≥2
 *         themes have lift > 2.0; penalty cap raised 0.12 → 0.30.
 *   v5.5: reason-weighted DNF lift
 *   v5.6: (a) type-conditioned DNF lift — fiction and nonfiction candidates
 *         each get their own lift map computed from same-type DNF books only,
 *         preventing nonfiction social-commentary DNFs from penalising fiction;
 *         (b) compound author signal — DNF + dismiss contributions accumulate
 *         into a single author score (dismiss at 0.7× weight); authors with
 *         combined score ≥ 0.6 and no completed reads get a +0.05 penalty,
 *         catching 1-DNF+1-dismiss combos missed by the binary thresholds;
 *         (c) rateEngine.js v3.4 virtual DNF ratings applied in parallel.
 *
 * Exports:
 *
 * Exports:
 *   rankBBRE(goodreads, feedback, candidatePool, history) → { selected, profile, eligibleCount }
 */

import { buildTasteModel, predictRating } from './rateEngine.js';
import { tokenize, cosine } from './descSimilarity.js';
import { rankRecommendations }            from './engine.js';

// ── Tuning constants ───────────────────────────────────────────────────────

// Base Bayes weight at full confidence (conf=1.0).  Engine absorbs the rest.
// LOO-tuned optimum: 0.40 (engine.js citation signal is more discriminating).
const BAYES_WEIGHT = 0.40;

// Author-diversity MMR penalty per additional same-author book already ranked.
const DIVERSITY_PENALTY = [0, 0.10, 0.18, 0.25, 0.30];

// Sub-genre (primary theme) diversity penalty — softer than author penalty.
const THEME_DIVERSITY_PENALTY = [0, 0.04, 0.07, 0.09, 0.10];

// Granular tone diversity penalty — softest layer (L3 in the theme hierarchy).
const TONE_DIVERSITY_PENALTY = [0, 0.02, 0.04, 0.05, 0.06];

// How many calendar years to look back for the "recent taste" recency window.
const RECENCY_WINDOW_YEARS = 2;

// DNF theme lift threshold.  Themes appearing at 1.7× or more the rate in DNF
// books vs overall reads are treated as mild negative signals.  Lowered from
// 2.0 → 1.7 based on Bill's nonfiction/literary DNF patterns.
const DNF_LIFT_THRESHOLD = 1.7;
const DNF_THEME_MIN_RATE = 0.08;   // theme must appear in ≥8% of DNFs to count

// Community signal tuning.
// Raised neutral 3.75→3.80: Bill's global mean is 4.23, so 3.80 is a better
// proxy for "meh" on his scale.  Max lift raised 0.04→0.06 since community
// ratings are a reliable signal for him (fiction 4.40 mean, nonfiction 4.05).
const COMMUNITY_NEUTRAL  = 3.80;
const COMMUNITY_MAX_LIFT = 0.06;   // max ±6 pts on the final score
const COMMUNITY_POP_MIN  = Math.log10(1_000);    // 1k ratings → weight 0
const COMMUNITY_POP_MAX  = Math.log10(500_000);  // 500k ratings → weight 1

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

// Primary tone for tone-level MMR (first tone tag from effective tones, or null).
function primaryTone(book) {
  const tones = inferTones(book);
  return tones.length > 0 ? tones[0] : null;
}

// ── Tone inference ─────────────────────────────────────────────────────────
// For candidates that lack a tones[] array (external books), derive tones
// from themes using the same mapping as the enrichment script.

const THEME_TONES_MAP = {
  'thriller':           ['fast-paced', 'tense', 'plot-driven'],
  'domestic suspense':  ['fast-paced', 'twisty', 'dark'],
  'psychological':      ['dark', 'tense', 'character-driven'],
  'legal':              ['procedural', 'fast-paced'],
  'courtroom':          ['procedural', 'fast-paced', 'tense'],
  'literary':           ['slow-burn', 'character-driven', 'atmospheric'],
  'memoir':             ['personal', 'character-study', 'conversational'],
  'narrative nonfiction': ['narrative-driven', 'accessible'],
  'true crime':         ['investigative', 'dark'],
  'mystery':            ['whodunit', 'plot-driven'],
  'noir':               ['dark', 'gritty', 'atmospheric'],
  'crime':              ['dark', 'gritty', 'procedural'],
  'horror':             ['dark', 'disturbing', 'atmospheric'],
  'contemporary':       ['character-driven', 'heartwarming'],
  'romance':            ['heartwarming', 'fast-paced'],
  'historical fiction': ['atmospheric', 'slow-burn', 'character-driven'],
  'sci-fi':             ['atmospheric', 'plot-driven'],
  'speculative':        ['atmospheric', 'slow-burn'],
  'suspense':           ['tense', 'fast-paced'],
  'high-concept':       ['fast-paced', 'plot-driven'],
  'adventure':          ['fast-paced', 'plot-driven'],
  'ya':                 ['fast-paced', 'character-driven'],
  'biography':          ['character-study', 'narrative-driven'],
  'history':            ['narrative-driven', 'dense'],
  'military':           ['narrative-driven', 'gritty'],
  'business':           ['narrative-driven', 'accessible'],
  'tech history':       ['narrative-driven', 'accessible'],
  'finance':            ['narrative-driven', 'accessible'],
  'sports':             ['narrative-driven', 'character-study'],
  'food':               ['narrative-driven', 'conversational'],
  'psychology':         ['dense', 'accessible'],
  'political':          ['dense', 'investigative'],
  'social commentary':  ['dense', 'polemic'],
  'music history':      ['narrative-driven', 'character-study'],
};

const TONE_PRIORITY = [
  'compulsive','twisty','unreliable-narrator','whodunit',
  'fast-paced','slow-burn','procedural','cat-and-mouse',
  'dark','disturbing','gritty','tense',
  'character-study','character-driven','anti-hero','ensemble',
  'atmospheric','immersive-journalism','investigative',
  'humorous','satirical','personal','conversational',
  'polemic','revelatory','dense','accessible',
  'narrative-driven','plot-driven','inspiring','heartwarming',
  'melancholic','hopeful','dual-timeline','nonlinear',
];

export function inferTones(book) {
  if (book.tones && book.tones.length > 0) return book.tones;
  const collected = new Set();
  for (const theme of (book.themes || [])) {
    const tl = theme.toLowerCase();
    for (const tone of (THEME_TONES_MAP[tl] || [])) collected.add(tone);
  }
  // Return in TONE_PRIORITY order, capped at 4
  return TONE_PRIORITY.filter(t => collected.has(t)).slice(0, 4);
}

// ── 1. Series continuity ───────────────────────────────────────────────────
// Parse "(Series Name, #N)" from Goodreads-style titles.

function parseSeries(title) {
  // handles decimal entries like (Molly the Maid, #2.5)
  const m = String(title || '').match(/\(([^,#)]+),?\s*#(\d+(?:\.\d+)?)\)/);
  return m ? { name: m[1].trim().toLowerCase(), num: parseFloat(m[2]) } : null;
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
  // The map only contains series Bill has actually read, so entry #1 of a
  // collection he's rated other entries of (e.g. Forward Collection) counts too.
  if (!s) return 0;
  const entry = seriesMap.get(s.name);
  // Bill rule (Session 12): don't push mid-series entries of UNREAD series —
  // he wants to start at book 1. Books #2+ of a series with no read history
  // get a penalty; book #1 is unaffected.
  if (!entry || entry.mean === null) return s.num > 1 ? -0.06 : 0;
  // Deviation from neutral 3.5★; scale so ±1.5★ → ±0.075
  return (entry.mean - 3.5) * 0.05;
}


// ── Session 12b: dismissal generalization + era filter ──────────────────────
// Bill's review dismissals carry reason codes; generalize them beyond the
// single dismissed book. See CLAUDE.md "Bill's Taste Rules".

const HOOK_THEMES = new Set(['thriller','mystery','suspense','crime','legal',
  'courtroom','speculative','sci-fi','horror','spy','high-concept','noir',
  'domestic suspense','psychological']);

const PRE1900_RX = /civil war|victorian|regency|frontier|wild west|confederate|union army|medieval|ancient (rome|greece|egypt)|18th century|19th century|17th century|\b1[678]\d\d\b|napoleonic|antebellum|colonial america|revolutionary war/i;
const PRE1900_EXEMPT = new Set(['lonesome-dove|larry-mcmurtry']);

function buildDismissProfile(feedback, model) {
  const inter = (feedback?.interactions || []).filter(e => e.excludeFromRecommendations);
  const badAuthors = new Set(inter
    .filter(e => e.reasonCode === 'author-dislike')
    .map(e => normA(e.author)));
  const styleBooks = inter.filter(e => e.reasonCode === 'style-not-for-me');
  const styleThemes = new Map();
  for (const e of styleBooks) {
    for (const t of (e.themes || [])) {
      const k = String(t).toLowerCase();
      styleThemes.set(k, (styleThemes.get(k) || 0) + 1);
    }
  }
  // TF-IDF centroid of dismissed-style descriptions (when signal is active)
  let styleVecs = [];
  if (model?.descModel && model?.descByKey) {
    for (const e of styleBooks) {
      const d = model.descByKey[e.bookKey]?.description;
      if (d && d.length >= 80) styleVecs.push(model.descModel.vec(tokenize(d)));
    }
  }
  return { badAuthors, styleThemes, styleVecs, styleCount: styleBooks.length };
}

function dismissAdjust(book, profile, model) {
  let adj = 0;
  const reasons = [];
  if (profile.badAuthors.has(normA(book.author))) {
    adj -= 0.15; reasons.push('disliked-author');
  }
  if (profile.styleCount >= 2 && book.type === 'fiction') {
    const themes = (book.themes || []).map(t => String(t).toLowerCase());
    const hasHook = themes.some(t => HOOK_THEMES.has(t));
    if (!hasHook) {
      const themeOverlap = themes.filter(t => profile.styleThemes.has(t)).length;
      let descSim = 0;
      if (profile.styleVecs.length && model?.descModel && model?.descByKey) {
        const d = model.descByKey[book.bookKey]?.description;
        if (d && d.length >= 80) {
          const v = model.descModel.vec(tokenize(d));
          descSim = Math.max(...profile.styleVecs.map(sv => cosine(v, sv)));
        }
      }
      if (themeOverlap >= 2 || descSim > 0.08) {
        adj -= 0.08; reasons.push('dismissed-style-match');
      }
    }
  }
  return { adj, reasons };
}

function pre1900Penalty(book, model) {
  if (book.type !== 'fiction') return 0;                 // rule is fiction-only
  if (PRE1900_EXEMPT.has(book.bookKey)) return 0;
  // Require the historical tag: descriptions of contemporary books often
  // mention old artifacts (heist plots, family histories) without the story
  // being SET pre-1900 — gate caught The Maid's Secret this way.
  const themes = (book.themes || []).map(t => String(t).toLowerCase());
  if (!themes.includes('historical')) return 0;
  const d = model?.descByKey?.[book.bookKey]?.description || '';
  const hay = d + ' ' + (book.title || '');
  return PRE1900_RX.test(hay) ? 0.12 : 0;
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

// How much each DNF reason's abandonment counts toward the lift signal.
// Higher = "I actively disliked this" (strong topic/theme signal).
// Lower = "circumstances changed, not a quality judgment".
const DNF_REASON_WEIGHT = {
  'started_did_not_like':    1.0,   // read it, hated it — strongest signal
  'not_interesting':         0.7,   // read it, found it boring
  'topic_doesnt_appeal':     0.6,   // topic/theme mismatch
  'not_my_vibe':             0.3,   // style mismatch, mild signal
  'no_longer_relevant':      0.05,  // timing/life issue, not quality — nearly excluded
  'already_seen_adaptation': 0.0,   // no quality judgment at all
  'already_read_or_owned':   0.0,
  'too_long':                0.1,
  'dont_know_author':        0.0,
};
const DEFAULT_DNF_WEIGHT = 0.5;  // for books without a stored dnfReason

function buildDnfSignal(readBooks, feedback) {
  const dnfBooks   = readBooks.filter(b => b.dnf);
  const totalReads = readBooks.length;
  const EMPTY = { dnfThemeLift: new Map(), dnfToneLift: new Map(),
    ficDnfThemeLift: new Map(), nfDnfThemeLift: new Map(),
    ficDnfToneLift: new Map(),  nfDnfToneLift: new Map(),
    dnfOnlyAuthors: new Set(), lowRatedAuthors: new Set(),
    dismissedThemeWeights: new Map(), dismissedToneWeights: new Map(),
    softPenaltyAuthors: new Set(), compoundPenaltyAuthors: new Set() };
  if (dnfBooks.length === 0) return EMPTY;

  // ── Baseline counts (all reads, unweighted) ───────────────────────────
  const allThemeCnt    = new Map();
  const allToneCnt     = new Map();
  const ficThemeCnt    = new Map();  // fiction reads only
  const ficToneCnt     = new Map();
  const nfThemeCnt     = new Map();  // nonfiction reads only
  const nfToneCnt      = new Map();
  const totalFicReads  = readBooks.filter(b => b.type === 'fiction').length;
  const totalNfReads   = readBooks.filter(b => b.type === 'nonfiction').length;

  for (const b of readBooks) {
    for (const t of (b.themes || [])) allThemeCnt.set(t, (allThemeCnt.get(t) || 0) + 1);
    for (const t of (b.tones  || [])) allToneCnt.set(t,  (allToneCnt.get(t)  || 0) + 1);
    if (b.type === 'fiction') {
      for (const t of (b.themes || [])) ficThemeCnt.set(t, (ficThemeCnt.get(t) || 0) + 1);
      for (const t of (b.tones  || [])) ficToneCnt.set(t,  (ficToneCnt.get(t)  || 0) + 1);
    } else if (b.type === 'nonfiction') {
      for (const t of (b.themes || [])) nfThemeCnt.set(t,  (nfThemeCnt.get(t)  || 0) + 1);
      for (const t of (b.tones  || [])) nfToneCnt.set(t,   (nfToneCnt.get(t)   || 0) + 1);
    }
  }

  // ── Weighted DNF counts (combined + type-split) ───────────────────────
  const dnfThemeWt    = new Map();
  const dnfToneWt     = new Map();
  const ficDnfThemeWt = new Map();
  const ficDnfToneWt  = new Map();
  const nfDnfThemeWt  = new Map();
  const nfDnfToneWt   = new Map();
  let totalDnfWt = 0, totalFicDnfWt = 0, totalNfDnfWt = 0;

  for (const b of dnfBooks) {
    const w = DNF_REASON_WEIGHT[b.dnfReason] ?? DEFAULT_DNF_WEIGHT;
    if (w === 0) continue;
    totalDnfWt += w;
    for (const t of (b.themes || [])) dnfThemeWt.set(t, (dnfThemeWt.get(t) || 0) + w);
    for (const t of (b.tones  || [])) dnfToneWt.set(t,  (dnfToneWt.get(t)  || 0) + w);
    if (b.type === 'fiction') {
      totalFicDnfWt += w;
      for (const t of (b.themes || [])) ficDnfThemeWt.set(t, (ficDnfThemeWt.get(t) || 0) + w);
      for (const t of (b.tones  || [])) ficDnfToneWt.set(t,  (ficDnfToneWt.get(t)  || 0) + w);
    } else if (b.type === 'nonfiction') {
      totalNfDnfWt += w;
      for (const t of (b.themes || [])) nfDnfThemeWt.set(t,  (nfDnfThemeWt.get(t)  || 0) + w);
      for (const t of (b.tones  || [])) nfDnfToneWt.set(t,   (nfDnfToneWt.get(t)   || 0) + w);
    }
  }
  if (totalDnfWt    === 0) totalDnfWt    = dnfBooks.length;
  if (totalFicDnfWt === 0) totalFicDnfWt = 1;
  if (totalNfDnfWt  === 0) totalNfDnfWt  = 1;

  // ── Lift helpers ──────────────────────────────────────────────────────
  function buildLift(wMap, totalWt, allCntMap, totalAll) {
    const liftMap = new Map();
    if (totalAll === 0) return liftMap;
    for (const [t, wt] of wMap) {
      const dnfRate = wt / totalWt;
      const allRate = (allCntMap.get(t) || 0) / totalAll;
      if (allRate === 0 || dnfRate < DNF_THEME_MIN_RATE) continue;
      const lift = dnfRate / allRate;
      if (lift >= DNF_LIFT_THRESHOLD) liftMap.set(t, lift);
    }
    return liftMap;
  }

  // Combined lift (fallback for unknown type)
  const dnfThemeLift   = buildLift(dnfThemeWt,    totalDnfWt,    allThemeCnt, totalReads);
  const dnfToneLift    = buildLift(dnfToneWt,     totalDnfWt,    allToneCnt,  totalReads);
  // Type-conditioned lifts: DNF rate among same-type reads
  const ficDnfThemeLift = buildLift(ficDnfThemeWt, totalFicDnfWt, ficThemeCnt, totalFicReads);
  const ficDnfToneLift  = buildLift(ficDnfToneWt,  totalFicDnfWt, ficToneCnt,  totalFicReads);
  const nfDnfThemeLift  = buildLift(nfDnfThemeWt,  totalNfDnfWt,  nfThemeCnt,  totalNfReads);
  const nfDnfToneLift   = buildLift(nfDnfToneWt,   totalNfDnfWt,  nfToneCnt,   totalNfReads);

  // ── Author signals ────────────────────────────────────────────────────
  const ratedAuthorSet = new Set(
    readBooks.filter(b => !b.dnf && b.myRating > 0).map(b => normA(b.author))
  );

  // dnfOnlyAuthors: quality-signal DNFs only, no completed reads
  const dnfAuthorWt = new Map();
  for (const b of dnfBooks) {
    const w = DNF_REASON_WEIGHT[b.dnfReason] ?? DEFAULT_DNF_WEIGHT;
    if (w >= 0.3) {
      const ak = normA(b.author);
      dnfAuthorWt.set(ak, (dnfAuthorWt.get(ak) || 0) + w);
    }
  }
  const dnfOnlyAuthors = new Set(
    [...dnfAuthorWt.entries()]
      .filter(([ak, wt]) => wt >= 0.6 && !ratedAuthorSet.has(ak))
      .map(([ak]) => ak)
  );

  // lowRatedAuthors: ≥2 completed reads, mean < 2.5★
  const authorRatings = new Map();
  for (const b of readBooks) {
    if (!b.dnf && b.myRating > 0) {
      const ak = normA(b.author);
      if (!authorRatings.has(ak)) authorRatings.set(ak, { sum: 0, count: 0 });
      const e = authorRatings.get(ak); e.sum += b.myRating; e.count++;
    }
  }
  const lowRatedAuthors = new Set(
    [...authorRatings.entries()]
      .filter(([, e]) => e.count >= 2 && e.sum / e.count < 2.5)
      .map(([ak]) => ak)
  );

  // ── Dismissed-reason signal ───────────────────────────────────────────
  const REASON_WEIGHT = {
    'started_did_not_like':   1.0,
    'topic_doesnt_appeal':    0.5,
    'not_my_vibe':            0.4,
    'dont_know_author':       0.2,
    'not_interesting':        0.1,
    'no_longer_relevant':     0,
    'already_seen_adaptation':0,
    'already_read_or_owned':  0,
    'too_long':               0,
    // Legacy codes
    'wrong_genre_or_vibe':           0.5,
    'author_or_topic_not_appealing': 0.4,
    'overrated':                     0.25,
    'too_similar':                   0.15,
  };
  const dismissedThemeWeights = new Map();
  const dismissedToneWeights  = new Map();
  const softPenaltyAuthors    = new Set();
  const dnfBookKeys = new Set(dnfBooks.map(b => b.bookKey).filter(Boolean));

  for (const ix of (feedback?.interactions || [])) {
    const w = REASON_WEIGHT[ix.reasonCode] ?? 0;
    if (w === 0) continue;
    if (w === 1.0 && dnfBookKeys.has(ix.bookKey)) continue; // already in DNF
    for (const t of (ix.themes || [])) dismissedThemeWeights.set(t, (dismissedThemeWeights.get(t) || 0) + w);
    for (const t of (ix.tones  || [])) dismissedToneWeights.set(t,  (dismissedToneWeights.get(t)  || 0) + w);
    if (ix.reasonCode === 'not_my_vibe' || ix.reasonCode === 'author_or_topic_not_appealing') {
      softPenaltyAuthors.add(normA(ix.author));
    }
  }

  // ── Compound author signal (DNF + dismiss combined) ───────────────────
  // Accumulates weighted negative signals across both DNF books and
  // dismissals for each author.  Fires for authors below the dnfOnlyAuthors
  // binary threshold but with a meaningful combined signal — e.g. 1 DNF
  // (not_interesting, 0.7) + 1 dismiss (topic_doesnt_appeal, 0.5×0.7=0.35)
  // = 1.05, well above the 0.6 threshold.
  const compoundAuthorScore = new Map();
  for (const b of dnfBooks) {
    const w = DNF_REASON_WEIGHT[b.dnfReason] ?? DEFAULT_DNF_WEIGHT;
    if (w > 0) compoundAuthorScore.set(normA(b.author), (compoundAuthorScore.get(normA(b.author)) || 0) + w);
  }
  for (const ix of (feedback?.interactions || [])) {
    const w = REASON_WEIGHT[ix.reasonCode] ?? 0;
    if (w > 0) {
      const ak = normA(ix.author);
      compoundAuthorScore.set(ak, (compoundAuthorScore.get(ak) || 0) + w * 0.7);
    }
  }
  const COMPOUND_THRESHOLD = 0.6;
  const compoundPenaltyAuthors = new Set(
    [...compoundAuthorScore.entries()]
      .filter(([ak, score]) =>
        score >= COMPOUND_THRESHOLD &&
        !ratedAuthorSet.has(ak) &&
        !dnfOnlyAuthors.has(ak)   // already gets the stronger 0.08 penalty
      )
      .map(([ak]) => ak)
  );

  return {
    dnfThemeLift, dnfToneLift,
    ficDnfThemeLift, nfDnfThemeLift,
    ficDnfToneLift,  nfDnfToneLift,
    dnfOnlyAuthors, lowRatedAuthors,
    dismissedThemeWeights, dismissedToneWeights,
    softPenaltyAuthors, compoundPenaltyAuthors,
  };
}

// ── 5. Tone preference signal ─────────────────────────────────────────────
// For each tone tag, compute the user's mean rating on books carrying that
// tone (min 3 rated books to trust the signal).  Compare against the global
// mean to get a preference delta, then sum across the candidate's tones.

function buildToneProfile(readBooks) {
  const rated = readBooks.filter(b => !b.dnf && b.myRating > 0);
  const toneMap = new Map();  // tone → { sum, count }
  for (const b of rated) {
    for (const t of (b.tones || [])) {
      if (!toneMap.has(t)) toneMap.set(t, { sum: 0, count: 0 });
      const e = toneMap.get(t);
      e.sum += b.myRating; e.count++;
    }
  }
  // Only keep tones with ≥3 rated books (otherwise signal is too noisy).
  const profile = new Map();
  for (const [t, e] of toneMap) {
    if (e.count >= 3) profile.set(t, e.sum / e.count);
  }
  return profile;
}

// Returns a score delta in [-0.12, +0.12].
// Multiplier raised 0.02→0.030 and cap raised 0.08→0.12.
// Tone deltas from Bill's history are strong (twisty +0.45★, compulsive
// +0.38★, tense +0.28★ vs revelatory -0.40★, conversational -0.27★) so
// the old 0.02 multiplier was underselling the signal.
function toneSignal(book, toneProfile, globalMean) {
  if (!toneProfile.size || !globalMean) return 0;
  let adj = 0;
  for (const t of inferTones(book)) {
    if (toneProfile.has(t)) {
      adj += (toneProfile.get(t) - globalMean) * 0.030;
    }
  }
  return Math.max(-0.12, Math.min(0.12, adj));
}

// Returns a non-negative penalty in [0, 0.30].
function dnfPenalty(book, dnfSignal) {
  const { dnfThemeLift, dnfToneLift,
          ficDnfThemeLift, nfDnfThemeLift, ficDnfToneLift, nfDnfToneLift,
          dnfOnlyAuthors, lowRatedAuthors,
          dismissedThemeWeights, dismissedToneWeights,
          softPenaltyAuthors, compoundPenaltyAuthors } = dnfSignal;
  let pen = 0;
  let highLiftCount = 0;

  if (dnfOnlyAuthors.has(normA(book.author)))          pen += 0.08;
  if (lowRatedAuthors.has(normA(book.author)))         pen += 0.08;
  if (softPenaltyAuthors.has(normA(book.author)))      pen += 0.04;
  if (compoundPenaltyAuthors.has(normA(book.author)))  pen += 0.05;

  // Type-conditioned lift: use the map for this book's type.
  // Falls back to combined map when type is unknown.
  const bookType  = book.type?.toLowerCase();
  const themeLift = bookType === 'fiction'    ? ficDnfThemeLift
                  : bookType === 'nonfiction' ? nfDnfThemeLift
                  :                             dnfThemeLift;
  const toneLift  = bookType === 'fiction'    ? ficDnfToneLift
                  : bookType === 'nonfiction' ? nfDnfToneLift
                  :                             dnfToneLift;

  for (const t of (book.themes || [])) {
    const lift = themeLift.get(t);
    if (lift) {
      pen += lift * 0.008;
      if (lift > 2.0) highLiftCount++;
    }
    const dw = dismissedThemeWeights.get(t);
    if (dw) pen += dw * 0.005;
  }

  for (const t of inferTones(book)) {
    const lift = toneLift.get(t);
    if (lift) pen += lift * 0.006;
    const dw = dismissedToneWeights.get(t);
    if (dw) pen += dw * 0.004;
  }

  // Combo penalty: ≥2 themes with lift > 2.0 → 1.5× multiplier
  if (highLiftCount >= 2) pen *= 1.5;

  return Math.min(pen, 0.30);       // raised cap: was 0.12
}

// ── 4. Community popularity signal ────────────────────────────────────────
// Prefers freshly-scraped StoryGraph data; falls back to Amazon then Goodreads.
// Popular books (>500k ratings) get full weight; obscure books (<1k) get
// near-zero weight, so an unknown book's 4.8★ average doesn't sway the score.

function communitySignal(book) {
  let avg, cnt;
  if (book.storyGraphRating) {
    avg = Number(book.storyGraphRating);
    cnt = Number(book.storyGraphRatingCount) || 0;
  } else if (book.amazonRating) {
    avg = Number(book.amazonRating);
    cnt = Number(book.amazonRatingCount) || 0;
  } else {
    avg = Number(book.avgRating)    || 0;
    cnt = Number(book.ratingsCount) || 0;
  }
  if (!avg || !cnt) return 0;

  // Log-scale popularity weight: 0 below 1k ratings, 1 at 500k+
  const logCnt    = Math.log10(Math.max(cnt, 1));
  const popWeight = Math.max(0, Math.min(1, (logCnt - COMMUNITY_POP_MIN) / (COMMUNITY_POP_MAX - COMMUNITY_POP_MIN)));

  const signal = (avg - COMMUNITY_NEUTRAL) * 0.06 * popWeight;
  return Math.max(-COMMUNITY_MAX_LIFT, Math.min(COMMUNITY_MAX_LIFT, signal));
}

// ── 5. Confidence-adaptive combination ────────────────────────────────────
// At full confidence (conf=1): tuned 40/60 Bayes/Engine split.
// At lower confidence: engine.js signal absorbs the slack so cold-start
// books aren't pulled down by a weak Bayesian prior.

function adaptiveCombine(normBayes, normEngine, conf) {
  const bw = BAYES_WEIGHT * conf;         // 0 at conf=0, 0.40 at conf=1
  return bw * normBayes + (1 - bw) * normEngine;
}

// ── Main export ────────────────────────────────────────────────────────────

export function rankBBRE(goodreads, feedback, candidatePool, history, enrichedMeta = null) {

  // ── Step 1: run both models ──────────────────────────────────────────────
  const model        = buildTasteModel(goodreads, candidatePool, enrichedMeta);
  const engineResult = rankRecommendations(goodreads, feedback, candidatePool, history);

  if (engineResult.selected.length === 0) {
    return { selected: [], profile: engineResult.profile, eligibleCount: 0 };
  }

  const allReadBooks = (goodreads.books || []).filter(b => b.shelf === 'read');

  // ── Step 2: pre-build all signal maps ───────────────────────────────────
  const seriesMap           = buildSeriesMap(allReadBooks);
  const { recent, allTime } = buildTemporalMaps(allReadBooks);
  const dnfSig              = buildDnfSignal(allReadBooks, feedback);
  const toneProfile         = buildToneProfile(allReadBooks);
  const ratedBooks          = allReadBooks.filter(b => !b.dnf && b.myRating > 0);
  const globalMean          = ratedBooks.length
    ? ratedBooks.reduce((s, b) => s + b.myRating, 0) / ratedBooks.length
    : 3.5;

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
  const dismissProfile = buildDismissProfile(feedback, model);
  const withScores = normalised.map(b => {
    const base        = adaptiveCombine(b._normBayes, b._normEngine, b._conf);
    const seriesAdj   = seriesSignal(b, seriesMap);
    const recencyAdj  = recencySignal(b, recent, allTime);
    const toneAdj     = toneSignal(b, toneProfile, globalMean);
    const communityAdj = communitySignal(b);
    const dnfPen      = dnfPenalty(b, dnfSig);
    const dis         = dismissAdjust(b, dismissProfile, model);
    const eraPen      = pre1900Penalty(b, model);
    const combined    = Math.max(0, base + seriesAdj + recencyAdj + toneAdj + communityAdj - dnfPen + dis.adj - eraPen);
    return { ...b, _combined: combined, _base: base, _seriesAdj: seriesAdj, _recencyAdj: recencyAdj, _toneAdj: toneAdj, _communityAdj: communityAdj, _dnfPen: dnfPen, _dismissAdj: dis.adj, _dismissReasons: dis.reasons, _eraPen: eraPen };
  });

  withScores.sort((a, b) => b._combined - a._combined);

  // ── Step 6: greedy three-layer diversity re-ranking ──────────────────────
  // Layer 1: author MMR  (strongest — prevents same-author clusters)
  // Layer 2: theme MMR   (sub-genre level — prevents same-genre monotony)
  // Layer 3: tone MMR    (granular style level — softest, broadens feel variety)
  const pool       = [...withScores];
  const authorSeen = new Map();
  const themeSeen  = new Map();
  const toneSeen   = new Map();
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
      const ptn     = primaryTone(b);
      const tonCnt  = ptn ? (toneSeen.get(ptn) || 0) : 0;
      const tonPen  = TONE_DIVERSITY_PENALTY[Math.min(tonCnt, TONE_DIVERSITY_PENALTY.length - 1)];
      const s       = b._combined - authPen - themPen - tonPen;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    const sel  = pool.splice(bestIdx, 1)[0];
    const ak   = normA(sel.author);
    const pt   = primaryTheme(sel);
    const ptn  = primaryTone(sel);
    const prev = authorSeen.get(ak) || 0;
    authorSeen.set(ak, prev + 1);
    if (pt)  themeSeen.set(pt,  (themeSeen.get(pt)  || 0) + 1);
    if (ptn) toneSeen.set(ptn,  (toneSeen.get(ptn)  || 0) + 1);
    reranked.push({ ...sel, _bbreScore: bestScore, _diversityPen: sel._combined - bestScore, _authorSlot: prev + 1 });
  }

  // ── Step 7: shape output ─────────────────────────────────────────────────
  const selected = reranked.map((b, i) => {
    const matchScore = Math.max(1, Math.min(100, Math.round(b._bbreScore * 100)));

    // Bayesian component pts: scale by adaptive weight
    const bayesPts = Math.round(BAYES_WEIGHT * b._conf * b._normBayes * 100);
    const engPts   = Math.round((1 - BAYES_WEIGHT * b._conf) * b._normEngine * 100);

    // Adjustment entries (only show non-zero)
    const adj = [
      b._seriesAdj > 0.005   && { label: `series continuity — prior books avg ${((b._seriesAdj / 0.05) + 3.5).toFixed(1)}★`, pts: Math.round(b._seriesAdj * 100) },
      b._seriesAdj < -0.005  && { label: `series continuity — prior books below expectations`,                                  pts: Math.round(b._seriesAdj * 100) },
      b._recencyAdj > 0.005  && { label: `author trending up in your recent reads`,   pts: Math.round(b._recencyAdj * 100) },
      b._recencyAdj < -0.005 && { label: `author trending down in recent reads`,       pts: Math.round(b._recencyAdj * 100) },
      b._toneAdj > 0.005      && { label: `matches your preferred reading styles`,      pts: Math.round(b._toneAdj * 100) },
      b._toneAdj < -0.005     && { label: `style or mood outside your comfort zone`,    pts: Math.round(b._toneAdj * 100) },
      b._communityAdj > 0.005  && { label: `highly rated — ${b.storyGraphRating ? 'StoryGraph' : b.amazonRating ? 'Amazon' : 'Goodreads'} community`, pts: Math.round(b._communityAdj * 100) },
      b._communityAdj < -0.005 && { label: `lower ${b.storyGraphRating ? 'StoryGraph' : b.amazonRating ? 'Amazon' : 'Goodreads'} community rating`, pts: Math.round(b._communityAdj * 100) },
      b._dnfPen > 0.005       && { label: `theme or author overlap with low-rated/DNF books`, pts: -Math.round(b._dnfPen * 100) },
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
        toneAdj:      b._toneAdj,
        communityAdj: b._communityAdj,
        dnfPen:       b._dnfPen,
        diversityPen: b._diversityPen,
        combined:     b._combined,
        bbreScore:    b._bbreScore,
        authorSlot:   b._authorSlot,
        tones:        inferTones(b),
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
