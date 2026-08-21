// BMTRE — Bill's Movies & TV Recommendation Engine, Phase 1.
//
// Rule-based scorer for trakt/data/watchlist.json candidates, mirroring
// the book project's engine.js mechanics but keyed on exact TMDB ids
// instead of fuzzy title/author normalization (every title here already
// carries a real tmdb id from the Trakt export, so no norm()-style
// slugify/matching is needed at all).
//
// Phase 1 signals only — see CLAUDE.md's "BMTRE" section for the full
// port-vs-redesign table against the book engine, and for what's
// deliberately deferred (Bayesian predictor, MMR diversity, dismissal
// rules, franchise/rewatch/dropped-show signals — all need either more
// rated volume or real feedback data to calibrate against, same
// discipline the book engine always followed via scripts/eval.js).

// Rating-weight curve, calibrated against Bill's real 1-10 rating
// distribution (from trakt/data/dashboard.json: mode/median sits at 7-8,
// not the scale's midpoint) rather than assuming a linear mapping from
// the book engine's 1-5 curve. Neutral point ~6.5, not ~5.5.
const RATING_NEUTRAL = 6.5;
const RATING_SCALE = 3.5;
function ratingWeight(rating) {
  return Math.max(-1, Math.min(1, (rating - RATING_NEUTRAL) / RATING_SCALE));
}

// "Loved" = top ~25% of Bill's real rating distribution (9s and 10s are
// 130 of 495 ratings, ~26%) — used to seed the director/genre/similar-
// title signals, mirroring the book engine's fiveStarAuthors/fiveStarThemes.
const LOVED_THRESHOLD = 9;

export function titleKey(type, tmdbId) {
  return tmdbId != null ? `${type}:${tmdbId}` : null;
}

// Candidate-pool stubs carry title:null/year:null until enrich_tmdb.py
// backfills a real title into enrichedMetadata.json — but only there,
// never back onto the stub itself — so any consumer reading candidate.title/
// .year directly needs this fallback (the pool's raw JSON staying
// title:null is intentional per resolve_titles.py/discover_candidates.js's
// own comments; fixing it here once is cheaper than a repo-wide backfill).
export function hydrateTitle(c, enrichedMeta) {
  const meta = enrichedMeta[c.titleKey];
  return { ...c, title: c.title || meta?.title || c.title, year: c.year || meta?.year || c.year };
}

// The single "creative author" signal for a title: a movie's director or
// a show's primary creator — the closest 1:1 analog to a book's author
// (usually one person per title, same as the book engine's model).
export function getCreator(type, meta) {
  if (!meta) return null;
  if (type === 'movie') return meta.director || null;
  return (meta.createdBy && meta.createdBy[0]) || null;
}

// ── Indexes built from watched history + enriched metadata ─────────────

// TMDB uses two different genre vocabularies — movies get "Action",
// "Science Fiction", "War"; shows get "Action & Adventure", "Sci-Fi &
// Fantasy", "War & Politics", "Kids" — for the same real concepts. Left
// unnormalized, a loved movie's "Action" tag and a loved show's "Action &
// Adventure" tag were accumulating into separate lovedGenres buckets,
// silently halving genre-preference credit for whichever type Bill has
// fewer loved titles in. Normalized to the movie-side name (arbitrary
// choice of canonical form, not a value judgment) at both the point
// lovedGenres is built and the point a candidate's genres are looked up,
// so a genre is counted once regardless of which type taught it to Bill.
const GENRE_ALIASES = {
  'Action & Adventure': 'Action',
  'Sci-Fi & Fantasy': 'Science Fiction',
  'War & Politics': 'War',
  'Kids': 'Family',
};
function normalizeGenre(g) {
  return GENRE_ALIASES[g] || g;
}

export function buildIndexes(library, enrichedMeta, feedback) {
  const watched = new Map();
  for (const t of library.titles || []) watched.set(t.titleKey, t);

  const lovedTitles = new Set();
  const lovedCreators = new Map();       // creator name -> count of loved titles
  const creatorRatingWeight = new Map(); // creator name -> summed rating-weight across all rated titles
  const lovedGenres = new Map();         // genre name -> count of loved titles
  const reverseSimilar = new Map();      // titleKey -> count of loved titles citing it as similar/recommended

  for (const t of library.titles || []) {
    if (t.myRating == null) continue;
    const meta = enrichedMeta[t.titleKey];
    const creator = meta ? getCreator(t.type, meta) : null;

    if (creator) {
      const w = ratingWeight(t.myRating);
      creatorRatingWeight.set(creator, (creatorRatingWeight.get(creator) || 0) + w);
    }

    if (t.myRating >= LOVED_THRESHOLD) {
      lovedTitles.add(t.titleKey);
      if (creator) lovedCreators.set(creator, (lovedCreators.get(creator) || 0) + 1);
      for (const g of (meta?.genres || [])) {
        const ng = normalizeGenre(g);
        lovedGenres.set(ng, (lovedGenres.get(ng) || 0) + 1);
      }
      for (const id of [...(meta?.similarToIds || []), ...(meta?.recommendedIds || [])]) {
        const key = titleKey(t.type, id);
        reverseSimilar.set(key, (reverseSimilar.get(key) || 0) + 1);
      }
    }
  }

  const excluded = new Set(
    (feedback?.interactions || [])
      .filter(e => e.excludeFromRecommendations)
      .map(e => e.titleKey)
  );

  return { watched, lovedTitles, lovedCreators, creatorRatingWeight, lovedGenres, reverseSimilar, excluded };
}

// ── Scoring ──────────────────────────────────────────────────────────────

// Tiered by how many loved titles share the genre — same shape as the book
// engine's themeBonus(), but tier thresholds are provisional (TMDB's ~19
// fixed genres saturate far faster than book's free-form themes) and
// should be recalibrated once real enrichment data exists — see the
// "Roadmap" note in CLAUDE.md's BMTRE section.
function genreBonus(genres, lovedGenres) {
  let bonus = 0;
  for (const g of (genres || [])) {
    const count = lovedGenres.get(normalizeGenre(g)) || 0;
    if      (count >= 60) bonus += 5;
    else if (count >= 35) bonus += 4;
    else if (count >= 18) bonus += 3;
    else if (count >= 6)  bonus += 2;
    else if (count >= 1)  bonus += 1;
  }
  return Math.min(bonus, 8);
}

function voteCountBonus(voteCount) {
  const n = voteCount || 0;
  if (n >= 5000) return 4;
  if (n >= 1000) return 3;
  if (n >= 200)  return 2;
  if (n >= 50)   return 1;
  return 0;
}

// Popularity as a real 0-100 display metric (not just a small scoring
// bonus) — TMDB's own vote_count, log-scaled since raw counts span
// 0-30,000+ and a linear scale would make everything below a blockbuster
// look like zero. Cap tuned against this dataset's real p99 (~21k, max
// ~33k as of this build) rather than a guessed ceiling.
const POPULARITY_VOTE_CAP = 30000;
export function popularityScore(voteCount) {
  const n = Math.max(0, voteCount || 0);
  const score = (Math.log10(n + 1) / Math.log10(POPULARITY_VOTE_CAP + 1)) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── OMDb-sourced signals (audience score, awards) ───────────────────────
// TMDB has neither Rotten Tomatoes/Metacritic scores nor awards data —
// these come from a second, independent source (trakt/enrich_omdb.py,
// keyed by IMDb id), cached separately in omdbMetadata.json so it's
// never blended silently into the TMDB cache. `omdbEntry` is that
// cache's per-title value (or undefined if not yet OMDb-enriched —
// distinct from "enriched but has no data," which these treat as a
// real 0, not unknown).
//
// Display-only for now, deliberately not wired into matchScore(): with
// zero real OMDb data in this dataset as of this build (needs a new
// OMDB_API_KEY only Bill can create), any scoring weight here would be
// guessed rather than validated — the same discipline the book engine
// always used via scripts/eval.js before trusting a new signal. Once
// real data exists, folding these into baseSignals() is a natural
// follow-up, calibrated against it rather than assumed now.

export function audienceScore(omdbEntry) {
  if (!omdbEntry) return null;
  const scores = [omdbEntry.rottenTomatoes, omdbEntry.metacritic].filter(v => v != null);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export function awardsScore(omdbEntry) {
  if (!omdbEntry) return null;
  const a = omdbEntry.awards;
  if (!a) return 0;
  // Oscar/Emmy weighted heaviest (the two Bill named explicitly), a
  // generic wins/nominations total contributes a smaller amount — a
  // hand-picked weighting, not a derived one, same as the book engine's
  // themeBonus tiers or recencyBonus curve.
  const raw = (a.oscarWins || 0) * 40 + (a.oscarNominations || 0) * 15
    + (a.emmyWins || 0) * 20 + (a.emmyNominations || 0) * 8
    + (a.totalWins || 0) * 2 + (a.totalNominations || 0) * 1;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// TMDB's global vote_average tends to sit around 6.0-6.5 across popular
// titles — a provisional neutral point, TMDB-only in Phase 1 (no multi-
// source bias-offset the way the book engine's communitySignal() has for
// Amazon vs Goodreads; that's a later-phase addition once a second rating
// source is actually wired in).
const COMMUNITY_NEUTRAL = 6.0;
const COMMUNITY_WEIGHT = 8;

function recencyBonus(year, nowYear = new Date().getFullYear()) {
  if (!year) return 0;
  const age = nowYear - year;
  if (age <= 1) return 3;
  if (age <= 3) return 2;
  if (age <= 6) return 1;
  return 0;
}

export function matchScore(candidate, idx, enrichedMeta) {
  return candidate.type === 'movie'
    ? matchScoreMovie(candidate, idx, enrichedMeta)
    : matchScoreShow(candidate, idx, enrichedMeta);
}

function baseSignals(candidate, idx, meta) {
  let score = 20; // base, mirrors the book engine's starting point
  const creator = getCreator(candidate.type, meta);

  if (creator) {
    score += Math.min(10, (idx.lovedCreators.get(creator) || 0) * 6);
    score += Math.min(5, (idx.creatorRatingWeight.get(creator) || 0) * 1.5);
  }

  score += genreBonus(meta?.genres, idx.lovedGenres);

  // Forward match: this candidate's own TMDB-similar/recommended list
  // includes a title Bill loved.
  const citedIds = new Set([...(meta?.similarToIds || []), ...(meta?.recommendedIds || [])]
    .map(id => titleKey(candidate.type, id)));
  let forwardMatches = 0;
  for (const id of citedIds) if (idx.lovedTitles.has(id)) forwardMatches++;
  score += Math.min(24, forwardMatches * 8);

  // Reverse match: a title Bill loved cites this candidate as similar/
  // recommended. Unlike the book engine (gated to to-read-shelf only,
  // because hand-curated similarToTitles coverage was sparse), this
  // applies unconditionally — TMDB's similar/recommendations coverage is
  // comprehensive, not a scarce hand-curated signal.
  score += Math.min(12, (idx.reverseSimilar.get(candidate.titleKey) || 0) * 6);

  if (meta?.voteAverage != null) {
    score += (meta.voteAverage - COMMUNITY_NEUTRAL) * COMMUNITY_WEIGHT;
  }
  score += voteCountBonus(meta?.voteCount);
  score += recencyBonus(candidate.year);

  return { score, forwardMatches, creator };
}

function matchScoreMovie(candidate, idx, enrichedMeta) {
  const meta = enrichedMeta[candidate.titleKey];
  const { score } = baseSignals(candidate, idx, meta);
  return Math.max(0, Math.min(100, score));
}

function matchScoreShow(candidate, idx, enrichedMeta) {
  const meta = enrichedMeta[candidate.titleKey];
  const { score } = baseSignals(candidate, idx, meta);
  return Math.max(0, Math.min(100, score));
}

// "How much data do we actually have to trust this ranking" — a tiebreaker,
// same role as the book engine's confidenceScore(), not a quality signal.
export function confidenceScore(candidate, enrichedMeta) {
  const meta = enrichedMeta[candidate.titleKey];
  if (!meta) return 0;
  let c = 20;
  if (meta.genres?.length) c += 15;
  if (meta.overview) c += 10;
  if (getCreator(candidate.type, meta)) c += 15;
  const simCount = (meta.similarToIds?.length || 0) + (meta.recommendedIds?.length || 0);
  c += Math.min(20, simCount);
  c += voteCountBonus(meta.voteCount) * 5;
  return Math.min(100, c);
}

export function reason(candidate, idx, enrichedMeta) {
  const meta = enrichedMeta[candidate.titleKey];
  if (!meta) return 'Not enough data yet to explain this one — needs TMDB enrichment.';

  const creator = getCreator(candidate.type, meta);
  const creatorLabel = candidate.type === 'movie' ? 'director' : 'creator';
  const creatorCount = creator ? (idx.lovedCreators.get(creator) || 0) : 0;
  if (creatorCount > 0) {
    return `You've loved ${creatorCount} title${creatorCount > 1 ? 's' : ''} from ${creatorLabel} ${creator} before.`;
  }

  const citedIds = new Set([...(meta.similarToIds || []), ...(meta.recommendedIds || [])]
    .map(id => titleKey(candidate.type, id)));
  const matchedLoved = [...citedIds].filter(id => idx.lovedTitles.has(id));
  if (matchedLoved.length) {
    const names = matchedLoved
      .map(k => idx.watched.get(k)?.title)
      .filter(Boolean)
      .slice(0, 2);
    if (names.length) return `Similar to ${names.join(' and ')}, which you loved.`;
  }

  const reverseCount = idx.reverseSimilar.get(candidate.titleKey) || 0;
  if (reverseCount > 0) {
    return `Titles you loved list this as similar or recommended (${reverseCount} time${reverseCount > 1 ? 's' : ''}).`;
  }

  const topGenres = (meta.genres || []).filter(g => idx.lovedGenres.has(g)).slice(0, 2);
  if (topGenres.length) {
    return `Fits your taste for ${topGenres.join(' / ')}.`;
  }

  if (meta.voteAverage != null && meta.voteAverage >= 7.5) {
    return `Broadly well-regarded (${meta.voteAverage.toFixed(1)}/10 on TMDB).`;
  }

  return 'A newer or less-connected title — worth a look, lower confidence.';
}

// ── Entry point ──────────────────────────────────────────────────────────

export function rankRecommendations(library, watchlist, enrichedMeta, feedback = { interactions: [] }) {
  const idx = buildIndexes(library, enrichedMeta, feedback);

  const candidates = (watchlist.titles || []).filter(c => !idx.excluded.has(c.titleKey));
  const scored = candidates.map(c => ({
    ...c,
    bmtreScore: matchScore(c, idx, enrichedMeta),
    confidenceScore: confidenceScore(c, enrichedMeta),
    reason: reason(c, idx, enrichedMeta),
  }));

  scored.sort((a, b) => (b.bmtreScore - a.bmtreScore) || (b.confidenceScore - a.confidenceScore));

  return { selected: scored, idx };
}

// Same scoring machinery as rankRecommendations, but scores the watchlist
// and the discovered/manually-added candidate pool as two separate ranked
// lists (tagged via `origin`) instead of one. Lets a UI show "top picks
// from what you already plan to watch" alongside "top picks you haven't
// queued up yet" without re-deriving the indexes twice. A candidate whose
// titleKey already sits in the watchlist is dropped from the candidate
// list (structurally shouldn't happen — both resolve_titles.py and
// discover_candidates.js already exclude known watchlist/library keys —
// but checked here too since a UI silently double-counting the same title
// under two origins would be worse than a defensive filter).
export function rankAll(library, watchlist, candidatePool, enrichedMeta, feedback = { interactions: [] }) {
  const idx = buildIndexes(library, enrichedMeta, feedback);
  const watchlistKeys = new Set((watchlist.titles || []).map(c => c.titleKey));

  const scoreOne = (c, origin) => {
    const h = hydrateTitle(c, enrichedMeta);
    return {
      ...h,
      origin,
      bmtreScore: matchScore(h, idx, enrichedMeta),
      confidenceScore: confidenceScore(h, enrichedMeta),
      reason: reason(h, idx, enrichedMeta),
    };
  };

  const byScore = (a, b) => (b.bmtreScore - a.bmtreScore) || (b.confidenceScore - a.confidenceScore);

  const fromWatchlist = (watchlist.titles || [])
    .filter(c => !idx.excluded.has(c.titleKey))
    .map(c => scoreOne(c, 'watchlist'))
    .sort(byScore);

  // TMDB tags theatrical re-cuts/re-releases with the literal keyword
  // "edited from film" (e.g. Once Upon a Deadpool, a PG-13 re-edit of
  // Deadpool 2, which Bill already watched and rated 9/10 under its own
  // titleKey) — a real, well-supported signal that this "new pick" isn't
  // actually a new title, not a guess. Watchlist items are exempt: those
  // are Bill's own explicit picks, not the engine's discovery.
  const isReEdit = c => (enrichedMeta[c.titleKey]?.keywords || []).includes('edited from film');

  // TMDB's similar/recommendations network frequently surfaces foreign-
  // language titles that don't match Bill's real (near-entirely English)
  // taste profile — a real source of "way off" recommendations, not a
  // guess. Only applied to discovered/manually-resolved candidates,
  // never to the watchlist: a title Bill explicitly queued up himself is
  // his own real data, not the engine's discovery, and is never
  // filtered regardless of language. A missing originalLanguage (not
  // yet enriched, or enriched before this field existed) defaults to
  // allowed rather than excluded — silently hiding an unenriched title
  // would look like a bug, not a filter.
  const isNonEnglish = c => {
    const lang = enrichedMeta[c.titleKey]?.originalLanguage;
    return lang != null && lang !== 'en';
  };

  // A candidate can also go stale the other direction: Bill watches or
  // watchlists something on Trakt directly (outside this pipeline) that
  // happens to already be sitting in candidatePool.json from an earlier
  // discovery/resolve run. idx.watched already indexes every library
  // title by titleKey, so this reuses it rather than a second lookup.
  const fromCandidates = (candidatePool.titles || [])
    .filter(c => !idx.excluded.has(c.titleKey) && !watchlistKeys.has(c.titleKey)
      && !idx.watched.has(c.titleKey) && !isReEdit(c) && !isNonEnglish(c))
    .map(c => scoreOne(c, 'candidate'))
    .sort(byScore);

  return { idx, fromWatchlist, fromCandidates };
}
