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
// TMDB's two "still producing new episodes" show-status values — see
// showAiringBonus() for how this is used.
const AIRING_STATUSES = new Set(['Returning Series', 'In Production']);

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

// Real normalized rewatch signal (dashboard plays-field-semantic-trap
// finding). The naive version of this idea is a trap: Trakt's `plays`
// field means something different per type — for a movie it's a genuine
// repeat-view count, but for a show it's a cumulative episode-play count
// (e.g. "watched 41 episodes total"), not "watched the whole series 41
// times." Using raw `plays` directly would treat every long show anyone
// finished once as their most-rewatched title ever.
//
// The real, normalized version: for a movie, plays IS the rewatch count.
// For a show, plays/episodeCount approximates "how many times through" —
// 1.0 means watched once, 2.0 means watched twice. Clamped to a floor of
// 1 (never below) so a loved show Bill simply hasn't caught up on all
// aired episodes yet (a real case: "Tires," 18 of 30 aired episodes,
// rated 10/10) isn't penalized for incompleteness — this is a rewatch
// *bonus* signal, not a completion-tracking one, so anything at or below
// "watched once" reads as a neutral 1.0, never a negative multiplier.
export function rewatchStrength(t, meta) {
  if (!t || !(t.plays > 0)) return 1;
  if (t.type === 'movie') return Math.max(1, t.plays);
  const episodes = meta?.numberOfEpisodes || t.airedEpisodes;
  if (!episodes) return 1;
  return Math.max(1, t.plays / episodes);
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
  const lovedCollections = new Map();    // TMDB collection id -> [titleKey, ...] of loved titles in it
  const lovedActors = new Map();         // actor name -> count of loved titles they appeared in (topCast)
  const lovedKeywords = new Map();       // free-form TMDB keyword -> count of loved titles carrying it
  const lovedSubgenres = new Map();      // inferSubgenres() tag -> count of loved titles carrying it
  const lovedCountByType = { movie: 0, show: 0 }; // for matchPointScale() below
  // tone -> [ratings], built from EVERY rated title (not just loved) —
  // this is a rating-preference-delta signal (the book side's
  // buildToneProfile()/toneSignal() shape), which needs both liked and
  // disliked examples to compute a real per-tone mean, unlike the
  // loved-only counts above.
  const toneRatingsRaw = new Map();
  let ratedSum = 0, ratedCount = 0;
  // Weighted-by-loved-show-overlap airing-status signal (dashboard
  // recency-curve-not-split-by-type finding) — see showAiringBonus()
  // below for why this replaces the flat +1/+2 credit an earlier session
  // measurably reverted. Tracked across every rated show (not just
  // loved) so the loved rate can be compared against a real baseline
  // rate, not an assumed one.
  let ratedShowsTotal = 0, ratedShowsAiring = 0, lovedShowsAiring = 0;

  for (const t of library.titles || []) {
    if (t.myRating == null) continue;
    const meta = enrichedMeta[t.titleKey];
    const creator = meta ? getCreator(t.type, meta) : null;

    ratedSum += t.myRating;
    ratedCount++;
    for (const tone of inferTones(meta)) {
      if (!toneRatingsRaw.has(tone)) toneRatingsRaw.set(tone, []);
      toneRatingsRaw.get(tone).push(t.myRating);
    }

    if (t.type === 'show') {
      ratedShowsTotal++;
      const airing = AIRING_STATUSES.has(meta?.status);
      if (airing) {
        ratedShowsAiring++;
        if (t.myRating >= LOVED_THRESHOLD) lovedShowsAiring++;
      }
    }

    if (creator) {
      const w = ratingWeight(t.myRating);
      creatorRatingWeight.set(creator, (creatorRatingWeight.get(creator) || 0) + w);
    }

    if (t.myRating >= LOVED_THRESHOLD) {
      lovedTitles.add(t.titleKey);
      lovedCountByType[t.type] = (lovedCountByType[t.type] || 0) + 1;
      // A loved title's contribution to every count below is weighted by
      // how many times Bill has actually watched it, not a flat 1 — see
      // rewatchStrength()'s own comment. This is a true no-op against
      // today's real data (every real rewatchStrength value is exactly
      // 1.0 right now — 0 of 168 movies have plays>1, and no show's
      // plays/episodes ratio exceeds 1.0 either — verified via
      // scripts/eval.js producing byte-identical output before/after),
      // and starts contributing extra weight automatically the moment
      // Bill genuinely rewatches something, with no future code change
      // needed.
      const rw = rewatchStrength(t, meta);
      if (creator) lovedCreators.set(creator, (lovedCreators.get(creator) || 0) + rw);
      for (const g of (meta?.genres || [])) {
        const ng = normalizeGenre(g);
        lovedGenres.set(ng, (lovedGenres.get(ng) || 0) + rw);
      }
      for (const id of [...(meta?.similarToIds || []), ...(meta?.recommendedIds || [])]) {
        const key = titleKey(t.type, id);
        reverseSimilar.set(key, (reverseSimilar.get(key) || 0) + rw);
      }
      const collectionId = meta?.belongsToCollection?.id;
      if (collectionId != null) {
        if (!lovedCollections.has(collectionId)) lovedCollections.set(collectionId, []);
        lovedCollections.get(collectionId).push(t.titleKey);
      }
      for (const actor of (meta?.topCast || [])) {
        lovedActors.set(actor, (lovedActors.get(actor) || 0) + rw);
      }
      for (const kw of (meta?.keywords || [])) {
        if (KEYWORD_STOPLIST.has(kw)) continue;
        lovedKeywords.set(kw, (lovedKeywords.get(kw) || 0) + rw);
      }
      for (const s of inferSubgenres(meta)) {
        lovedSubgenres.set(s, (lovedSubgenres.get(s) || 0) + rw);
      }
    }
  }

  const excluded = new Set(
    (feedback?.interactions || [])
      .filter(e => e.excludeFromRecommendations)
      .map(e => e.titleKey)
  );

  // Dismissal generalization (dashboard dismissal-generalization
  // finding) — the BMTRE equivalent of the book engine's dismissAdjust
  // (Session 12b there): a dismissal shouldn't only remove the one exact
  // title, it should teach the engine "other titles by this same
  // creator" or "titles with this same overall style" are less likely
  // to land too. Two new reason codes carry real generalizable meaning
  // (see dismissAdjust() below for how each is applied):
  //   'creator_dislike' — this title's director/creator specifically
  //     isn't for Bill, regardless of genre/content.
  //   'style_dislike'   — this title's overall genre/subgenre mix isn't
  //     for Bill, regardless of who made it (needs 2+ before it
  //     generalizes, the same floor the book engine's dismissAdjust
  //     uses, so one one-off dismissal can't swing a whole style
  //     bucket).
  // Dormant against today's real data by design, not a bug: all 18 real
  // dismissals recorded so far use other reason codes (already_watched,
  // looks_low_budget, too_urban, too_old, already_have_version_rated,
  // not_interested, aimed_at_older_demographic) — none of them
  // 'creator_dislike'/'style_dislike'. That's deliberate, not an
  // oversight: 'too_urban' looked like the closest real candidate for a
  // style-dislike generalization, but a prior session found it would
  // misfire — Crime/Drama are Bill's #1/#2 loved genres and several of
  // those exact dismissed shows' genres overlap heavily with titles he
  // loves, so a genre-shaped penalty keyed on that reason would
  // wrongly punish real matches. Kept as an exact-title-only exclusion
  // instead, same as before. This mechanism ships ready for a future
  // dismissal (from this session's data or the real app once a dismiss
  // UI exists) that genuinely names a creator or a style as the
  // problem, without needing another engine change when that happens.
  const dismissedCreators = new Set();
  const dismissedGenreProfile = new Map();
  const dismissedSubgenreProfile = new Map();
  let styleDismissCount = 0;
  for (const e of (feedback?.interactions || [])) {
    if (!e.excludeFromRecommendations) continue;
    const dmeta = enrichedMeta[e.titleKey];
    if (e.reasonCode === 'creator_dislike') {
      const dcreator = dmeta ? getCreator(e.type, dmeta) : null;
      if (dcreator) dismissedCreators.add(dcreator);
    } else if (e.reasonCode === 'style_dislike') {
      styleDismissCount++;
      for (const g of (dmeta?.genres || [])) {
        const ng = normalizeGenre(g);
        dismissedGenreProfile.set(ng, (dismissedGenreProfile.get(ng) || 0) + 1);
      }
      for (const s of inferSubgenres(dmeta)) {
        dismissedSubgenreProfile.set(s, (dismissedSubgenreProfile.get(s) || 0) + 1);
      }
    }
  }

  // Only keep tones backed by >=3 rated titles — otherwise a single
  // outlier rating would swing the whole tone's "preference" to a
  // meaningless extreme, the same floor buildToneProfile() uses on the
  // book side.
  const globalMeanRating = ratedCount ? ratedSum / ratedCount : null;
  const toneProfile = new Map();
  for (const [tone, ratings] of toneRatingsRaw) {
    if (ratings.length >= 3) {
      toneProfile.set(tone, ratings.reduce((s, r) => s + r, 0) / ratings.length);
    }
  }

  // Overrepresentation of "still airing" status among loved shows vs. the
  // real baseline rate among all rated shows — 0 if loved shows are no
  // more likely to be airing than the general rated pool (or if there's
  // no data yet), never negative (a show being MORE likely to be ended
  // among loved titles isn't treated as a penalty signal here, since
  // "ended" is also just "you've had time to finish it").
  const showAiringRateAll = ratedShowsTotal ? ratedShowsAiring / ratedShowsTotal : 0;
  const showAiringRateLoved = lovedCountByType.show ? lovedShowsAiring / lovedCountByType.show : 0;
  const showAiringOverrep = Math.max(0, showAiringRateLoved - showAiringRateAll);

  return { watched, lovedTitles, lovedCreators, creatorRatingWeight, lovedGenres, reverseSimilar, lovedCollections, lovedActors, lovedKeywords, lovedSubgenres, toneProfile, globalMeanRating, excluded, lovedCountByType, showAiringOverrep, dismissedCreators, dismissedGenreProfile, dismissedSubgenreProfile, styleDismissCount };
}

// Bill has roughly half as many loved movies as loved shows (measured:
// 50 vs 99) — the forward/reverse similar-title match signal below can
// only ever compare a movie against other loved movies (TMDB's /similar
// and /recommendations never cross type), so with half the comparison
// pool, a movie needs roughly twice the "hit rate" to earn the same
// credit a show does purely from having more loved titles to match
// against, not from being a worse match. Scales the smaller-pool type's
// per-match point value up by the ratio to the larger pool (the larger
// pool's own scale is always 1 — unchanged behavior for it), rather than
// hand-picking a number: an explicit, measured compensation for the
// pool-size gap, not a general "movies score too low so boost them" fudge.
// Revisit if the loved-title counts shift substantially (e.g. once Bill
// has rated enough more movies that the pools are closer to even).
function matchPointScale(type, lovedCountByType) {
  const counts = Object.values(lovedCountByType || {});
  const maxCount = Math.max(1, ...counts);
  const thisCount = Math.max(1, lovedCountByType?.[type] || 1);
  return maxCount / thisCount;
}

// ── Scoring ──────────────────────────────────────────────────────────────

// Tiered by how many loved titles share the genre — same shape as the book
// engine's themeBonus(). These thresholds were originally provisional
// (TMDB's ~19 fixed genres saturate far faster than book's free-form
// themes), pending validation once real enrichment data existed — that
// data has existed for a while and was formally checked for the first
// time in Session 53's improvement pass: Bill's real lovedGenres
// distribution spans all 5 tiers with no collapse (Drama 105 alone in
// tier 5, Crime/Comedy in tier 4, Action/Thriller/Mystery in tier 3, 3
// more in tier 2, 7 more in tier 1) — the tiers hold up against real
// data, not just an assumption. No longer provisional.
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

// Dismissal generalization — see buildIndexes()'s own comment for the
// full design and why it's dormant against today's real data (no
// dismissal yet uses either of these two reason codes). A creator-
// dislike is a flat, confident penalty (naming a specific person as the
// problem is about as unambiguous as taste feedback gets). A style-
// dislike is smaller and additive per overlapping genre/subgenre tag,
// capped, and gated behind 2+ real style dismissals — the same
// "needs 2+" floor the book engine's dismissAdjust uses, so one
// one-off dismissal can't swing a whole genre/subgenre bucket against
// every future candidate that happens to share it.
const CREATOR_DISLIKE_PENALTY = -15;
const STYLE_DISLIKE_MIN_COUNT = 2;
const STYLE_DISLIKE_PER_MATCH = -3;
const STYLE_DISLIKE_CAP = -10;
function dismissAdjust(candidate, meta, creator, idx) {
  let penalty = 0;
  if (creator && idx.dismissedCreators.has(creator)) penalty += CREATOR_DISLIKE_PENALTY;
  if (idx.styleDismissCount >= STYLE_DISLIKE_MIN_COUNT) {
    let overlap = 0;
    for (const g of (meta?.genres || [])) {
      if (idx.dismissedGenreProfile.get(normalizeGenre(g)) > 0) overlap++;
    }
    for (const s of inferSubgenres(meta)) {
      if (idx.dismissedSubgenreProfile.get(s) > 0) overlap++;
    }
    if (overlap > 0) penalty += Math.max(STYLE_DISLIKE_CAP, overlap * STYLE_DISLIKE_PER_MATCH);
  }
  return penalty;
}

// A real, verified gap (a dashboard Improvement Opportunities finding):
// belongsToCollection is cached on every enriched movie TMDB actually
// groups into a franchise (146 of 1,493 enriched titles as of this
// build) but was never scored — despite this being one of the most
// concrete, high-confidence taste signals available. Not hypothetical:
// a live check found 17 of Bill's real loved (9-10 rated) titles belong
// to a collection he's demonstrably following (Creed I+II, Deadpool
// 1+2, Sicario 1+2, both Anchorman films). TMDB's "collection" concept
// is movie-only (shows have no equivalent field), so this is a no-op
// for shows by construction, not a special-cased exclusion. Franchises
// are small in practice (most run 2-5 entries), so this is a flat-ish
// bonus rather than genreBonus()'s open-ended count-based tiers — a
// single loved entry in the same franchise is already about as
// concrete a signal as this engine has (an actual sequel/prequel to
// something Bill rated a favorite), with a small additional credit if
// more than one entry in the franchise was loved. Capped at 15, the
// same order of magnitude as the creator-match bonus above (max 10+5).
function franchiseBonus(collectionId, lovedCollections) {
  if (collectionId == null) return 0;
  const lovedInCollection = lovedCollections.get(collectionId);
  if (!lovedInCollection || !lovedInCollection.length) return 0;
  return Math.min(15, 10 + (lovedInCollection.length - 1) * 3);
}

// A real, verified gap (a dashboard Improvement Opportunities finding):
// topCast (top 5 billed actors, TMDB-sourced) is well-populated
// (93.5%+) but was never scored. CLAUDE.md's own port table already
// flagged this as needing real design thought — an actor is less
// determinative of a title's identity than its director (someone can
// appear in dozens of unrelated projects; a director's stamp on a
// project is much stronger), so this is deliberately a smaller,
// corroborating bonus, not scaled anywhere near the creator-match or
// franchise-match ceiling. Same simple tiered-per-item-summed-and-capped
// shape as genreBonus() (this codebase's existing convention for a
// secondary signal), capped at the same 8-point ceiling.
function castBonus(topCast, lovedActors) {
  let bonus = 0;
  for (const actor of (topCast || [])) {
    const count = lovedActors.get(actor) || 0;
    if      (count >= 3) bonus += 3;
    else if (count >= 1) bonus += 2;
  }
  return Math.min(8, bonus);
}

// Structural/production tags, not thematic ones — TMDB's free-form
// keyword field mixes both, and these carry zero content-taste signal
// (every sequel gets "sequel," every mid-credits-scene movie gets
// "aftercreditsstinger," regardless of what the title is actually
// about). Excluded from lovedKeywords entirely so they can never earn
// or cost a candidate points.
const KEYWORD_STOPLIST = new Set([
  'aftercreditsstinger', 'duringcreditsstinger', 'sequel', 'spin off',
  'spinoff', 'miniseries', 'remake', 'reboot', 'anthology', 'standalone',
]);

// A real Improvement Opportunities finding (Session 53): keywords are
// well-populated (93%+) and sit completely unused for anything but the
// isReEdit() re-cut filter, despite being the closest BMTRE equivalent to
// the book engine's free-form theme vocabulary — TMDB's genre taxonomy
// alone is a blunt ~19-27 fixed values. Deliberately kept as a small,
// capped, corroborating signal beneath genreBonus() rather than a primary
// one: free-form keywords are noisier than a fixed genre vocabulary (see
// KEYWORD_STOPLIST above), and the real per-keyword counts among Bill's
// loved titles are much thinner than genre counts (top keyword "based on
// novel or book" at 19, vs. top genre Drama at 105). Cap tuned against
// scripts/eval.js, not guessed: an initial cap of 4 measurably improved
// MAE (20.21→18.55) but dropped precision@10 90%→80% — a real regression
// on the metric CLAUDE.md says to never trade away for MAE. Halved to a
// cap of 2, which keeps precision@10/25/50/100 exactly unchanged
// (90/92/94/91) while still improving MAE (20.21→19.34), the same
// precision-first discipline the book side's eval gate already enforces.
function keywordBonus(keywords, lovedKeywords) {
  let bonus = 0;
  for (const kw of (keywords || [])) {
    if (KEYWORD_STOPLIST.has(kw)) continue;
    const count = lovedKeywords.get(kw) || 0;
    if      (count >= 8) bonus += 0.75;
    else if (count >= 3) bonus += 0.5;
    else if (count >= 1) bonus += 0.25;
  }
  return Math.min(1.5, bonus);
}

// The scoring-integration step the taxonomy plan deliberately deferred
// ("a scoring weight needs the same eval.js-gated validation keywordBonus()
// went through") — attempted and validated this session, not bundled into
// the classifier's own commit. Reuses genreBonus()'s exact tiered-count
// shape (the book side's themeBonus() has the identical shape, confirmed
// via a full code read while planning the classifier), scaled to this
// signal's real, smaller loved-count range (max 23 among 149 loved titles,
// vs. lovedGenres' max of 105) rather than reusing genreBonus()'s literal
// thresholds unscaled. Cap tuned against scripts/eval.js: the tier weights
// scaled straight from genreBonus() (max ~5 combined) measurably regressed
// precision@50 (92%→90%) even though MAE improved — this project's
// precision-first rule (see keywordBonus()'s own comment) means that
// doesn't ship. Roughly halved twice to a 1.5 cap, which not only avoided
// the regression but genuinely improved precision@10 90%→100% with every
// other metric held or improved.
function subgenreBonus(subgenres, lovedSubgenres) {
  let bonus = 0;
  for (const s of (subgenres || [])) {
    const count = lovedSubgenres.get(s) || 0;
    if      (count >= 18) bonus += 0.75;
    else if (count >= 10) bonus += 0.5;
    else if (count >= 4)  bonus += 0.25;
    else if (count >= 1)  bonus += 0.1;
  }
  return Math.min(1.5, bonus);
}

// The book side's toneSignal() equivalent: a genuine per-tone rating-
// preference delta, not a loved-count tier — bbreEngine.js's own formula
// is `(tonePersonalMean - globalMean) * 0.030`, summed across a
// candidate's tones, clamped to [-0.12, +0.12], on the book engine's
// ~0-5 internal score scale. Rescaled here for BMTRE's 0-100 score scale
// and 1-10 myRating (real per-tone deltas checked against the actual
// data before picking a multiplier: witty +0.36, inspirational +0.66,
// gritty -0.30, melancholy +0.70 — comparable magnitude to the book
// side's own real deltas, and, unlike tone coverage overall, most of the
// 13 real tones clear the >=3-rated-titles trust floor). Multiplier swept
// from 1.5 to 15 against scripts/eval.js — results plateau from ~5
// upward (the +-3 cap saturates), so a moderate 4 was kept deliberately
// short of the observed ceiling rather than chasing the exact best
// leave-one-out decimal on a 533-title eval set. Real result: precision@10
// 90%->100%, precision@50 92%->94%, precision@100 86%->88%, MAE
// 20.17->19.98 — every metric held or improved, no tradeoffs needed.
function toneSignal(tones, toneProfile, globalMean) {
  if (!toneProfile || !toneProfile.size || globalMean == null) return 0;
  let adj = 0;
  for (const t of (tones || [])) {
    if (toneProfile.has(t)) {
      adj += (toneProfile.get(t) - globalMean) * 4;
    }
  }
  return Math.max(-3, Math.min(3, adj));
}

// A real Improvement Opportunities finding (Session 53): similarToIds/
// recommendedIds are 100% populated and already drive matchScore()'s
// forward/reverse match signal, but there was no human-readable
// similarToTitles field the way the book side's goodreadsData.json has —
// only raw TMDB ids. This resolves a title's cited ids to real names via
// a self-referential lookup against enrichedMetadata.json itself (no new
// fetch needed): only ids that happen to already be in our own tracked
// catalog (library/watchlist/candidatePool, all TMDB-enriched) resolve —
// checked live against the real dataset, that's 31.2% of all citations
// (18,525 of 59,336) — the rest cite titles outside what Bill has watched,
// queued, or been offered as a candidate, which is expected and not a bug:
// TMDB's similar/recommendations network reaches far beyond any one
// person's own catalog. Deduped and capped at `limit`, citation order
// preserved (similarToIds before recommendedIds, matching baseSignals()'s
// own citedIds construction).
export function resolveSimilarTitles(meta, type, enrichedMeta, limit = 5) {
  if (!meta) return [];
  const seen = new Set();
  const out = [];
  for (const id of [...(meta.similarToIds || []), ...(meta.recommendedIds || [])]) {
    if (out.length >= limit) break;
    const key = titleKey(type, id);
    if (seen.has(key)) continue;
    seen.add(key);
    const cited = enrichedMeta[key];
    if (cited?.title) out.push({ titleKey: key, title: cited.title, year: cited.year ?? null });
  }
  return out;
}

// A real Improvement Opportunities finding (Session 53): the book engine's
// similarToAuthors bridges a candidate to loved authors directly; BMTRE had
// no equivalent. Real design decision this needed before building (per the
// finding's own text): a corroboration threshold, since a single incidental
// director match among dozens of cited titles is noise, not signal. Scans
// the FULL similarToIds/recommendedIds citation list (unlike
// resolveSimilarTitles() above, which caps early for display purposes) so
// a director cited by, say, title #8 and #14 isn't missed just because
// resolveSimilarTitles()'s own default limit=5 cut off before reaching
// them. Requires 2+ resolved similar titles sharing the same director/
// creator before it counts — one shared director among many cited titles
// is exactly the kind of coincidental, low-confidence match this project's
// history (e.g. the Session 47 resolve_titles.py false-match incidents)
// has repeatedly shown is worth a real bar, not a bare "any match" rule.
// Display/data-shape only, like resolveSimilarTitles() — not wired into
// matchScore(), since a real scoring weight would need the same
// eval.js-validated tuning keywordBonus() just went through, and this is
// a smaller, noisier signal (fewer resolved titles to draw from per
// candidate) than keywords were.
export function resolveSimilarDirectors(meta, type, enrichedMeta, limit = 3) {
  if (!meta) return [];
  const counts = new Map(); // director name -> count of resolved similar titles crediting them
  const seenTitles = new Set();
  for (const id of [...(meta.similarToIds || []), ...(meta.recommendedIds || [])]) {
    const key = titleKey(type, id);
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    const cited = enrichedMeta[key];
    if (!cited?.title) continue;
    const creator = getCreator(type, cited);
    if (creator) counts.set(creator, (counts.get(creator) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

// ── Subgenres + tones (beneath TMDB's blunt ~19-27 genre taxonomy) ─────────
//
// Real gap this closes (dashboard Improvement Opportunities findings
// themes-field-missing/tones-field-missing/genre-subgenre-split-missing):
// TMDB's genre taxonomy is heavily concentrated — Drama alone covers 68.9%
// of the 1,793-title dataset this was designed against. The book side's
// answer to the exact same problem was two curated vocabularies (37 themes,
// 24 tones), built and hand-corrected over many sessions. This is the
// movie/TV equivalent, deliberately architected differently: computed live
// from each title's real TMDB `keywords` (98.7% populated) as a pure
// function, never persisted to enrichedMetadata.json or any data file.
// Unlike the book side's persisted, hand-edited arrays — which needed 4
// files kept in sync, a load-time disjointness assertion, and two dedicated
// drift-detection functions because hand-edited data can drift from its own
// vocabulary — a value returned here can only ever be a literal key of
// SUBGENRE_KEYWORDS/TONE_KEYWORDS, so "non-canonical drift" has no code
// path to occur through. Iterating on the classifier is just editing these
// two objects; every title's tags update immediately everywhere, with no
// migration and none of the JSON-corruption bug classes the book side's
// surgical-edit history repeatedly hit.
//
// Every keyword below was verified present in the real dataset before
// being included — not assumed. Two real false positives were caught and
// fixed during that verification (documented inline) via the same
// spot-check discipline the book side's Session 16c/17 audits used:
// checking real titles' actual assigned tags against real knowledge of
// those titles, not just checking that the code runs.
//
// Display/audit only for now (CSV export, dashboard) — deliberately NOT
// wired into matchScore(). A scoring weight needs the same eval.js-gated
// validation keywordBonus() went through this session before it's safe to
// add (see that function's own comment for the exact regression that
// caught and avoided).

const SUBGENRE_KEYWORDS = {
  // Real additions this session (field-quality-subgenres coverage pass):
  // every added keyword was verified present at real, non-trivial
  // frequency in the live enrichedMetadata.json keyword set first, never
  // guessed — see the session's own keyword-frequency scan. Extends
  // existing tag buckets with real synonyms/phrasings TMDB actually uses
  // rather than inventing new sub-buckets off thin, single-keyword
  // evidence (the exact over-reach the book side's Session 16b rejected).
  'crime-drama': ['organized crime', 'drug dealer', 'drugs', 'gangster', 'mafia', 'mob', 'outlaw', 'criminal', 'hitman', 'assassin'],
  'procedural': ['police', 'detective', 'investigation', 'fbi', 'murder investigation', 'police detective', 'cop', 'murder', 'murder mystery', 'whodunit', 'police procedural', 'crime investigation', 'criminal investigation'],
  'legal': ['lawyer', 'courtroom', 'trial', 'attorney', 'judge', 'legal drama'],
  'heist': ['heist', 'robbery', 'con artist', 'bank robbery'],
  'spy-espionage': ['spy', 'espionage', 'undercover', 'secret agent'],
  'psychological-thriller': ['psychopath', 'disturbed', 'serial killer', 'psychological thriller', 'stalking', 'obsession', 'kidnapping'],
  'biopic': ['biography', 'biopic'],
  // Deliberately just these two — a first version also matched bare decade
  // markers ('1970s', '1920s', etc.), which produced real false positives
  // on titles merely SET in a past decade rather than genuinely historical
  // in tone (Anchorman: The Legend of Ron Burgundy, a broad 1970s-set
  // comedy, got tagged 'historical' off its '1970s' keyword alone).
  // Trades some recall (a genuine period piece with only a decade keyword
  // and no 'period drama'/'historical' tag of its own, e.g. 1923, won't
  // get this tag) for real precision — an intentional choice per the
  // rollout plan's "trim/merge during calibration, decided empirically."
  // Trades some recall for real precision, still — kept 'wild west' out
  // of a would-be dedicated 'western' bucket (only 12 real occurrences,
  // too thin for its own tag per the same "decided empirically, not
  // guessed" discipline as the superhero/historical carve-outs above)
  // and folded it in here instead, since an Old West setting is a period
  // piece too.
  'historical': ['period drama', 'historical', 'historical fiction', 'historical drama', 'costume drama', 'wild west'],
  'war': ['war', 'military', 'soldier', 'world war ii', 'world war i', 'vietnam war'],
  'political': ['politics', 'president', 'election', 'corruption', 'government', 'conspiracy'],
  'family-drama': ['dysfunctional family', 'family relationships', 'family', 'husband wife relationship', 'sibling relationship'],
  'coming-of-age': ['coming of age', 'high school', 'teenager'],
  'romance': ['romance', 'love', 'love triangle'],
  'romcom': ['romcom'],
  'workplace-comedy': ['workplace comedy', 'office'],
  'dark-comedy': ['dark comedy', 'satire', 'absurd'],
  // Deliberately just these two — a first version also matched 'based on
  // comic', which produced a real false positive on "300" (a historical
  // war epic based on Frank Miller's graphic novel, not remotely a
  // superhero film) — being adapted from a comic doesn't imply the genre.
  'superhero': ['superhero', 'supervillain', 'super power', 'superhero team'],
  'sci-fi-fantasy': ['dystopia', 'supernatural', 'alien', 'time travel', 'zombie', 'vampire', 'post-apocalyptic future', 'alien invasion', 'space'],
  'sports': ['sports', 'basketball', 'baseball', 'wrestling', 'boxing'],
  'medical': ['doctor', 'hospital', 'surgeon', 'nurse', 'medical', 'medical drama'],
  'prison': ['prison', 'death row'],
};

const TONE_KEYWORDS = {
  // Real additions this session (field-quality-tones coverage pass, the
  // most under-covered of the two — TMDB genuinely carries far fewer
  // mood/craft keywords than content/subject ones). Every addition below
  // was verified at real, non-trivial frequency in the live dataset
  // first — deliberately excluded several higher-frequency but too-
  // generic candidates that would risk becoming filler the way the book
  // side's Session 16 "any positive score becomes default filler" bug
  // did (e.g. 'dramatic' 30x, 'complex' 21x, 'serious' 11x, 'bold' 18x —
  // all real but not specific enough to any one tone to be a safe signal).
  'gritty': ['gritty', 'grim', 'macabre', 'aggressive', 'brutality', 'angry'],
  'dark': ['dark', 'hopeless', 'tragic', 'depressing', 'tragedy'],
  'witty': ['witty', 'amused', 'playful'],
  'satirical': ['satire', 'satirical', 'parody', 'black comedy', 'biting', 'irreverent'],
  'hilarious': ['hilarious'],
  'inspirational': ['inspirational', 'inspiring', 'hopeful'],
  'intense': ['intense', 'tension', 'tense', 'anxious'],
  'suspenseful': ['suspenseful', 'suspense', 'cliffhanger'],
  'twisty': ['plot twist'],
  'slow-burn': ['slow burn'],
  'character-driven': ['character study', 'intimate'],
  'nostalgic': ['nostalgic', 'nostalgia'],
  'melancholy': ['melancholy', 'tearjerker'],
  'offbeat': ['offbeat', 'whimsical', 'surreal'],
  // New tag — both keywords are exact, unambiguous matches for the tag
  // itself (not inferred from a looser synonym the way most tags above
  // are), the safest kind of addition per this file's own established
  // discipline.
  'thoughtful': ['thoughtful', 'philosophical'],
};

function scoreKeywordTags(keywords, map) {
  const kws = keywords || [];
  const scored = [];
  for (const [tag, list] of Object.entries(map)) {
    let score = 0;
    for (const kw of kws) if (list.includes(kw)) score++;
    if (score >= 1) scored.push([tag, score]);
  }
  return scored.sort((a, b) => b[1] - a[1]);
}

export function inferSubgenres(meta, limit = 3) {
  if (!meta) return [];
  return scoreKeywordTags(meta.keywords, SUBGENRE_KEYWORDS).slice(0, limit).map(([tag]) => tag);
}

export function inferTones(meta, limit = 4) {
  if (!meta) return [];
  return scoreKeywordTags(meta.keywords, TONE_KEYWORDS).slice(0, limit).map(([tag]) => tag);
}

function voteCountBonus(voteCount) {
  const n = voteCount || 0;
  if (n >= 5000) return 4;
  if (n >= 1000) return 3;
  if (n >= 200)  return 2;
  if (n >= 50)   return 1;
  return 0;
}

// Cover images: enrich_tmdb.py already captures TMDB's posterPath on
// 99%+ of enriched titles, but nothing in trakt/ ever rendered it (a
// real Improvement Opportunities finding — data existed, no UI ever
// used it). TMDB's image CDN is public with no auth/CORS restriction,
// same as any <img src> — image.tmdb.org, not api.themoviedb.org (the
// API host this sandbox's proxy blocks; the CDN is unrelated and is the
// end user's own browser fetching it at view time, not this session).
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';
export function posterUrl(titleKey, enrichedMeta, size = 'w154') {
  const path = enrichedMeta[titleKey]?.posterPath;
  return path ? `${TMDB_IMAGE_BASE}${size}${path}` : null;
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
// Wired into baseSignals() below (omdbSignal()) now that real OMDb data
// exists (890 titles enriched as of this build) — the weights there were
// calibrated against this dataset's actual audienceScore/awardsScore
// distributions, not guessed, the same discipline the book engine always
// used via scripts/eval.js before trusting a new signal.

// Fills the real gap Session 52 found: OMDb's API returns RT/Metacritic
// for movies but essentially never for shows (confirmed against OMDb's
// own issue tracker), so trakt/scrape_show_ratings.py scrapes Metacritic
// directly for exactly that gap, cached separately in
// trakt/data/scrapedShowRatings.json so the source of every value stays
// traceable. Only metacritic is merged in — RT scraping was verified
// wrong against real outside sources (Elsbeth: scraped 62%, real
// Tomatometer 92%) across 3 live test batches and is disabled at the
// source (scrape_show_ratings.py's SCRAPE_RT = False), so scraped
// rottenTomatoes/rtAudience values are never trusted here even if
// present in an old cache entry. OMDb's own metacritic value always
// wins when present (the movie case); this only fills a null.
export function mergeScrapedShowRatings(omdbMeta, scrapedShowRatings) {
  if (!scrapedShowRatings) return omdbMeta;
  const merged = { ...omdbMeta };
  for (const [key, scraped] of Object.entries(scrapedShowRatings)) {
    if (scraped.metacritic == null) continue;
    const existing = merged[key];
    if (existing?.metacritic != null) continue; // OMDb's own value wins
    merged[key] = { ...(existing || {}), metacritic: scraped.metacritic };
  }
  return merged;
}

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

// Audience-score neutral point measured from this dataset's real OMDb
// coverage (283 titles with a Rotten Tomatoes and/or Metacritic score:
// mean 76.1, median 80) rather than assumed — Bill's watched/candidate
// pool skews toward well-regarded titles, and RT/MC coverage itself
// skews toward more notable titles (obscure titles are the ones most
// often missing a score entirely), so a generic "50 is neutral" would
// have quietly penalized most of the catalog. Capped modestly (±6) since
// this is a corroborating secondary signal, not a primary one — smaller
// than genre/creator/similar-title but comparable to voteCountBonus/
// recencyBonus. Missing audience data contributes nothing, not a penalty
// (only 283 of 890 OMDb-enriched titles as of this build even have an
// RT/MC score at all — most titles legitimately don't carry one).
const AUDIENCE_NEUTRAL = 80;
const AUDIENCE_MAX_SWING = 6;

// Awards score is real but heavily right-skewed in this dataset (206 of
// 890 titles score exactly 0 — no recognition found, a legitimate answer
// per awardsScore()'s own contract, not a gap — while p75/p90/p99 all
// saturate at 100). Scaled down rather than used at full 0-100 weight so
// "won something" and "won everything" don't collapse into the same
// signal strength as forward/reverse similar-title matches — capped at
// +4, the same scale as voteCountBonus, since award recognition here is
// a modest corroborating signal (this is a taste engine, not an Oscars
// predictor) rather than a primary differentiator.
const AWARDS_MAX = 4;

function omdbSignal(omdbEntry) {
  let score = 0;
  const aud = audienceScore(omdbEntry);
  if (aud != null) {
    score += Math.max(-AUDIENCE_MAX_SWING, Math.min(AUDIENCE_MAX_SWING,
      (aud - AUDIENCE_NEUTRAL) / 20 * AUDIENCE_MAX_SWING));
  }
  const awd = awardsScore(omdbEntry);
  if (awd != null) {
    score += (awd / 100) * AWARDS_MAX;
  }
  return score;
}

// Recency curves, split by type (Bill's explicit request: "strongly favor
// movies from the last 5-10 years, nothing before 2000" — plain
// recencyBonus() using one universal curve for both types was also
// flagged as a real gap in its own right, see the dashboard's Engine
// Improvements finding this fixes as a side effect). Movies get a much
// steeper curve than before (old max swing was +3; this one runs +8 to
// -15) since "strongly favor" implies a real behavioral shift, not a
// nudge — the actual pre-2000 exclusion is enforced separately as a hard
// candidate filter (see MOVIE_MIN_YEAR below); this curve's very negative
// tail is belt-and-suspenders for watchlist movies, which are never
// hard-excluded (Bill's own explicit picks, same precedent as isReEdit/
// isNonEnglish never applying to the watchlist).
function recencyBonusMovie(year, nowYear) {
  if (!year) return 0;
  const age = nowYear - year;
  if (age <= 5)  return 8;
  if (age <= 10) return 6;
  if (age <= 15) return 1;
  if (age <= 20) return -4;
  if (age <= 26) return -9;  // approaching year 2000
  return -15;                // pre-2000
}

// Shows keep the original, gentler curve — Bill's ask was specifically
// about movies ("strongly favor movies from the last 5-10 years"), and a
// show's relevance doesn't age the same way a movie's release date does
// (an old show can still be "current" via new seasons) — a real, separate
// gap already flagged, not addressed here since it wasn't what was asked.
//
// A fix was attempted in an earlier session: a small flat credit when
// TMDB's own `status` field says a show is still "Returning Series"/
// "In Production", on top of the unchanged year curve. Tried at +2, then
// +1 — both measurably hurt scripts/eval.js: precision@10 90%→80%,
// precision@100 91%→86%, and MAE got WORSE, not better. Reverted rather
// than shipped, and the fix flagged for a future differently-shaped
// signal — weighted by how many loved shows share the "still airing"
// status, the way genreBonus/keywordBonus weight by loved-title overlap,
// rather than a flat bonus applied to every airing show regardless of
// fit.
//
// That weighted version is showAiringBonus() below, built and tested
// this session. Real numbers behind it (from buildIndexes()'s
// showAiringOverrep): loved shows are airing 32.3% of the time vs. 25.1%
// for the general rated-show pool — a real but modest 7.2-point
// overrepresentation, not the large effect the flat +1/+2 assumed. A
// SHOW_AIRING_SCALE sweep against scripts/eval.js (0 through 50) found
// NO value in that range that improves precision@10 over baseline —
// precision@10 drops to 90% at the very first nonzero value tested (2)
// and keeps falling as the scale increases (80% by 15+), while MAE keeps
// improving the whole way (19.89→19.56 at scale=50) — exactly the
// MAE-improves-while-precision-drops trade CLAUDE.md says never to make.
// precision@25/50 hold roughly flat regardless of scale, so they can't
// rescue it. Confirms the original note's own prediction: this needs
// either a different signal shape entirely or more rated-show volume,
// not just a better-calibrated magnitude of the same shape.
// SHOW_AIRING_SCALE is left at 0 (the function computes but doesn't
// apply the bonus) rather than removing the machinery — the
// showAiringOverrep index is real, computed correctly, and ready to use
// the moment either condition changes; re-sweep via eval.js before
// raising it above 0.
const SHOW_AIRING_SCALE = 0;
function showAiringBonus(candidate, meta, idx) {
  if (candidate.type !== 'show' || !AIRING_STATUSES.has(meta?.status)) return 0;
  return idx.showAiringOverrep * SHOW_AIRING_SCALE;
}

function recencyBonusShow(year, nowYear) {
  if (!year) return 0;
  const age = nowYear - year;
  if (age <= 1) return 3;
  if (age <= 3) return 2;
  if (age <= 6) return 1;
  return 0;
}

function recencyBonus(year, type, nowYear = new Date().getFullYear()) {
  return type === 'movie' ? recencyBonusMovie(year, nowYear) : recencyBonusShow(year, nowYear);
}

// Hard cutoff for discovered/manually-resolved movie candidates — "nothing
// before 2000," applied the same way isReEdit/isNonEnglish are: never to
// the watchlist (Bill's own real picks aren't censored, they're just
// ranked honestly low by the steep recencyBonusMovie tail above).
const MOVIE_MIN_YEAR = 2000;
export function isPreMillenniumMovie(candidate, enrichedMeta) {
  if (candidate.type !== 'movie') return false;
  const year = candidate.year || enrichedMeta[candidate.titleKey]?.year;
  return year != null && year < MOVIE_MIN_YEAR;
}

// Bill's explicit request: exclude all animation (movies and shows) from
// recommendations — same precedent as isReEdit/isNonEnglish/
// isPreMillenniumMovie, never applied to the watchlist (his own real
// picks, e.g. The Boys Presents: Diabolical which he's already watched
// and rated 7, stay untouched — only discovered/resolved candidates are
// filtered).
export function isAnimation(candidate, enrichedMeta) {
  return (enrichedMeta[candidate.titleKey]?.genres || []).includes('Animation');
}

export function matchScore(candidate, idx, enrichedMeta, omdbMeta = {}) {
  return candidate.type === 'movie'
    ? matchScoreMovie(candidate, idx, enrichedMeta, omdbMeta)
    : matchScoreShow(candidate, idx, enrichedMeta, omdbMeta);
}

function baseSignals(candidate, idx, meta, omdbEntry) {
  let score = 20; // base, mirrors the book engine's starting point
  const creator = getCreator(candidate.type, meta);

  if (creator) {
    score += Math.min(10, (idx.lovedCreators.get(creator) || 0) * 6);
    score += Math.min(5, (idx.creatorRatingWeight.get(creator) || 0) * 1.5);
  }

  score += genreBonus(meta?.genres, idx.lovedGenres);
  score += dismissAdjust(candidate, meta, creator, idx);
  score += franchiseBonus(meta?.belongsToCollection?.id, idx.lovedCollections);
  score += castBonus(meta?.topCast, idx.lovedActors);
  score += keywordBonus(meta?.keywords, idx.lovedKeywords);
  score += subgenreBonus(inferSubgenres(meta), idx.lovedSubgenres);
  score += toneSignal(inferTones(meta), idx.toneProfile, idx.globalMeanRating);

  // Forward match: this candidate's own TMDB-similar/recommended list
  // includes a title Bill loved.
  const citedIds = new Set([...(meta?.similarToIds || []), ...(meta?.recommendedIds || [])]
    .map(id => titleKey(candidate.type, id)));
  let forwardMatches = 0;
  for (const id of citedIds) if (idx.lovedTitles.has(id)) forwardMatches++;
  const scale = matchPointScale(candidate.type, idx.lovedCountByType);
  score += Math.min(24, forwardMatches * 8 * scale);

  // Reverse match: a title Bill loved cites this candidate as similar/
  // recommended. Unlike the book engine (gated to to-read-shelf only,
  // because hand-curated similarToTitles coverage was sparse), this
  // applies unconditionally — TMDB's similar/recommendations coverage is
  // comprehensive, not a scarce hand-curated signal.
  score += Math.min(12, (idx.reverseSimilar.get(candidate.titleKey) || 0) * 6 * scale);

  if (meta?.voteAverage != null) {
    score += (meta.voteAverage - COMMUNITY_NEUTRAL) * COMMUNITY_WEIGHT;
  }
  score += voteCountBonus(meta?.voteCount);
  score += recencyBonus(candidate.year, candidate.type);
  score += showAiringBonus(candidate, meta, idx);
  score += omdbSignal(omdbEntry);

  return { score, forwardMatches, creator };
}

function matchScoreMovie(candidate, idx, enrichedMeta, omdbMeta) {
  const meta = enrichedMeta[candidate.titleKey];
  const { score } = baseSignals(candidate, idx, meta, omdbMeta[candidate.titleKey]);
  return Math.max(0, Math.min(100, score));
}

function matchScoreShow(candidate, idx, enrichedMeta, omdbMeta) {
  const meta = enrichedMeta[candidate.titleKey];
  const { score } = baseSignals(candidate, idx, meta, omdbMeta[candidate.titleKey]);
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

export function reason(candidate, idx, enrichedMeta, omdbMeta = {}) {
  const meta = enrichedMeta[candidate.titleKey];
  if (!meta) return 'Not enough data yet to explain this one — needs TMDB enrichment.';

  // Checked first — a franchise entry Bill already loved a sibling of is
  // about as concrete and specific a signal as this engine has, more so
  // than a general director/creator match.
  const collectionId = meta.belongsToCollection?.id;
  const lovedInCollection = collectionId != null ? idx.lovedCollections.get(collectionId) : null;
  if (lovedInCollection?.length) {
    const names = lovedInCollection.map(k => idx.watched.get(k)?.title).filter(Boolean).slice(0, 2);
    if (names.length) {
      return `You loved ${names.join(' and ')} — this is another entry in the same ${meta.belongsToCollection.name.replace(/ Collection$/, '')} franchise.`;
    }
  }

  const creator = getCreator(candidate.type, meta);
  const creatorLabel = candidate.type === 'movie' ? 'director' : 'creator';
  const creatorCount = creator ? (idx.lovedCreators.get(creator) || 0) : 0;
  if (creatorCount > 0) {
    return `You've loved ${creatorCount} title${creatorCount > 1 ? 's' : ''} from ${creatorLabel} ${creator} before.`;
  }

  // Checked after creator match, before the general similar-title
  // network — a real actor you've loved before, but a smaller signal
  // than a director/creator match (see castBonus()'s own reasoning).
  const lovedCastMember = (meta.topCast || []).find(actor => idx.lovedActors.get(actor) > 0);
  if (lovedCastMember) {
    const count = idx.lovedActors.get(lovedCastMember);
    return `You've loved ${count} title${count > 1 ? 's' : ''} with ${lovedCastMember} before.`;
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

  const omdbEntry = omdbMeta[candidate.titleKey];
  const aud = audienceScore(omdbEntry);
  if (aud != null && aud >= AUDIENCE_NEUTRAL) {
    return `Well-reviewed by critics and audiences (${aud}/100 audience score).`;
  }
  const awd = awardsScore(omdbEntry);
  if (awd) {
    return `Real award recognition (${omdbEntry.awards?.raw || 'wins/nominations found'}).`;
  }

  return 'A newer or less-connected title — worth a look, lower confidence.';
}

// ── Entry point ──────────────────────────────────────────────────────────

export function rankRecommendations(library, watchlist, enrichedMeta, feedback = { interactions: [] }, omdbMeta = {}) {
  const idx = buildIndexes(library, enrichedMeta, feedback);

  const candidates = (watchlist.titles || []).filter(c => !idx.excluded.has(c.titleKey));
  const scored = candidates.map(c => ({
    ...c,
    bmtreScore: matchScore(c, idx, enrichedMeta, omdbMeta),
    confidenceScore: confidenceScore(c, enrichedMeta),
    reason: reason(c, idx, enrichedMeta, omdbMeta),
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
export function rankAll(library, watchlist, candidatePool, enrichedMeta, feedback = { interactions: [] }, omdbMeta = {}) {
  const idx = buildIndexes(library, enrichedMeta, feedback);
  const watchlistKeys = new Set((watchlist.titles || []).map(c => c.titleKey));

  const scoreOne = (c, origin) => {
    const h = hydrateTitle(c, enrichedMeta);
    return {
      ...h,
      origin,
      bmtreScore: matchScore(h, idx, enrichedMeta, omdbMeta),
      confidenceScore: confidenceScore(h, enrichedMeta),
      reason: reason(h, idx, enrichedMeta, omdbMeta),
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
      && !idx.watched.has(c.titleKey) && !isReEdit(c) && !isNonEnglish(c)
      && !isPreMillenniumMovie(c, enrichedMeta) && !isAnimation(c, enrichedMeta))
    .map(c => scoreOne(c, 'candidate'))
    .sort(byScore);

  return { idx, fromWatchlist, fromCandidates };
}

// ── Diversity re-ranking ─────────────────────────────────────────────────
// Real, verified gap (a dashboard Improvement Opportunities finding): with
// no anti-clustering pass, the top of a score-sorted show list can be a
// genre monoculture — a live check found 20 of 20 top-scored shows tagged
// Drama, 13 also Crime, purely because that's what scores highest, not
// because nothing else was available. Mirrors the book engine's author-
// diversity MMR pass in spirit (stop one dominant signal from crowding out
// everything else at the top of a list) but scoped to genre, the
// dimension the finding actually measured, and implemented as a soft
// per-genre cap within a display window rather than a penalty folded into
// matchScore() — this only reorders an already-scored, already-sorted
// list for DISPLAY, it never changes an individual title's bmtreScore, so
// it has zero effect on computeEvalMetrics()'s precision@k (which scores
// one title at a time, never a list) and needs no re-validation against
// the eval harness.
//
// A title whose primary genre already has maxPerGenre picks within the
// window gets deferred past titles that add real variety, not excluded —
// deferred titles still surface later in the same returned list. If the
// candidate pool genuinely doesn't have enough genre-diverse titles to
// fill the window (a real possibility with a thin pool), the window is
// backfilled from the deferred queue in original score order rather than
// left under-filled — running out of diversity is never a reason to show
// fewer picks than requested.
export function diversityRerank(scoredList, enrichedMeta, { windowSize = 8, maxPerGenre = 3 } = {}) {
  if (!scoredList.length) return scoredList;
  const primaryGenre = c => {
    const genres = enrichedMeta[c.titleKey]?.genres || [];
    return genres.length ? normalizeGenre(genres[0]) : null;
  };

  const genreCounts = new Map();
  const placed = [];
  const deferred = [];

  for (const c of scoredList) {
    const g = primaryGenre(c);
    const count = g ? (genreCounts.get(g) || 0) : 0;
    if (placed.length < windowSize && (!g || count < maxPerGenre)) {
      placed.push(c);
      if (g) genreCounts.set(g, count + 1);
    } else {
      deferred.push(c);
    }
  }

  while (placed.length < windowSize && deferred.length) {
    placed.push(deferred.shift());
  }

  return [...placed, ...deferred];
}

// ── Evaluation harness ────────────────────────────────────────────────────
// Answers the #1 Improvement Opportunities finding this dashboard has
// flagged since Session 51: BMTRE had no equivalent of the book side's
// scripts/eval.js — every scoring constant (matchPointScale,
// AUDIENCE_NEUTRAL, AWARDS_MAX, genre tiers, the movie recency curve)
// was calibrated against a real input *distribution*, never validated
// against actual held-out prediction accuracy.
//
// Real difference from the book side: BBRE has a separate Bayesian rating
// predictor (rateEngine.js) distinct from its ranking engine. BMTRE has
// no such predictor — matchScore() (0-100) is the only scoring function
// that exists, so this eval treats it as the thing under test: does a
// title's own predicted match-score, computed against an index that
// leaves that title OUT (so its own rating can't leak into its own
// creator/genre/similar-title signal — the same reason the book side's
// eval.js rebuilds buildTasteModel per held-out book), actually track
// how Bill rated it for real.
//
// Lives here (not in scripts/eval.js) specifically so dashboard.js can
// import it directly into the browser for the "BMTRE Accuracy Score"
// dial — engine.js has no Node-specific imports (fs/path/url), unlike
// scripts/eval.js's CLI wrapper, which would fail to load in a browser.
const LIKED_THRESHOLD = 8;    // myRating >= 8/10 — the same looser "would he
                                // enjoy this" bar the dashboard's own Best
                                // Matches section already established, not
                                // the stricter myRating >= 9 "loved" bar
                                // buildIndexes() uses for signal-building.
const DISLIKED_THRESHOLD = 5; // myRating <= 5/10, for the bottom-catch check

export function computeEvalMetrics(library, enrichedMeta, feedback, omdbMeta) {
  const rated = (library.titles || []).filter(t => t.myRating != null && enrichedMeta[t.titleKey]);

  const preds = [];
  for (const t of rated) {
    const looLibrary = { titles: (library.titles || []).filter(x => x.titleKey !== t.titleKey) };
    const idx = buildIndexes(looLibrary, enrichedMeta, feedback);
    const h = hydrateTitle(t, enrichedMeta);
    const predicted = matchScore(h, idx, enrichedMeta, omdbMeta);
    if (Number.isFinite(predicted)) {
      preds.push({ predicted, actual: t.myRating * 10, myRating: t.myRating, title: h.title, type: h.type });
    }
  }
  preds.sort((a, b) => b.predicted - a.predicted);

  const n = preds.length;
  const liked = x => x.myRating >= LIKED_THRESHOLD;
  const disliked = x => x.myRating <= DISLIKED_THRESHOLD;
  const baseRate = preds.filter(liked).length / n;
  const mae = preds.reduce((s, x) => s + Math.abs(x.predicted - x.actual), 0) / n;

  // A real, honest baseline check: Bill's ratings skew high (mean ~78/100
  // in this dataset), so a trivial "always predict the mean" guess can
  // score deceptively well on raw MAE alone without ranking anything
  // correctly — exactly why CLAUDE.md already states precision@k
  // outranks MAE for the book side, and why this dial weights MAE low.
  const meanActual = preds.reduce((s, x) => s + x.actual, 0) / n;
  const meanBaselineMae = preds.reduce((s, x) => s + Math.abs(meanActual - x.actual), 0) / n;

  const precisionAtK = {};
  for (const k of [10, 25, 50, 100]) {
    if (k > n) continue;
    const hit = preds.slice(0, k).filter(liked).length;
    precisionAtK[k] = 100 * hit / k;
  }

  const bottom = preds.slice(-50);
  const bottomCatch = bottom.filter(disliked).length;
  const totalDisliked = preds.filter(disliked).length;
  const bottomDislikeRate = totalDisliked / n;
  const bottomChance = Math.min(50, n) * bottomDislikeRate;
  // The achievable ceiling for bottomCatch isn't always 50 — a model can
  // only ever catch as many real dislikes as exist in the whole dataset.
  // Bill's ratings skew high enough that dislikes (myRating<=5) are rare
  // (~30 of 533 titles here), so a perfect model still only catches ~30,
  // not 50. Exposed separately so a consumer (the BMTRE Accuracy dial)
  // can grade bottomCatch against its real ceiling instead of an
  // unreachable one, the same "measure the real ceiling, don't assume
  // it" discipline meanBaselineMae already applies to the MAE component.
  const bottomPossible = Math.min(50, totalDisliked);

  const worstMisses = preds.filter(x => x.myRating <= 4).slice(0, 8)
    .map(x => ({ predicted: x.predicted, myRating: x.myRating, title: x.title, type: x.type }));
  const worstUnderrated = [...preds].filter(x => x.myRating >= 9).sort((a, b) => a.predicted - b.predicted).slice(0, 8)
    .map(x => ({ predicted: x.predicted, myRating: x.myRating, title: x.title, type: x.type }));

  // By-type breakdown — BMTRE's own scoring already splits movies/shows
  // (recencyBonusMovie/Show, matchPointScale per type), so a single
  // combined precision number could hide one type dragging the other.
  const byType = {};
  for (const type of ['movie', 'show']) {
    const typePreds = preds.filter(x => x.type === type);
    if (!typePreds.length) continue;
    const tn = typePreds.length;
    const tMae = typePreds.reduce((s, x) => s + Math.abs(x.predicted - x.actual), 0) / tn;
    const top10 = [...typePreds].sort((a, b) => b.predicted - a.predicted).slice(0, Math.min(10, tn));
    byType[type] = { n: tn, mae: tMae, precisionAt10: 100 * top10.filter(liked).length / top10.length };
  }

  return {
    n, baseRate, mae, meanBaselineMae, precisionAtK, bottomCatch, bottomChance, bottomPossible,
    worstMisses, worstUnderrated, byType, likedThreshold: LIKED_THRESHOLD,
  };
}
