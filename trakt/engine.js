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

// Full creator/co-creator list, not just the single display name above.
// 199 of 524 enriched shows carry 2+ TMDB `createdBy` entries — under
// getCreator()'s index-0-only contract, a genuine co-creator (e.g. the
// #2 name on a show Bill loved) got zero affinity credit, and a candidate
// show TMDB happens to list that same person as creator #2 (not #1) never
// matched at all. Movies now use the same fix: enrich_tmdb.py's
// extract_entry() was collecting every real TMDB 'Director' crew credit
// into a `directors` list but only ever kept index 0 — confirmed on a
// real example (Avengers: Infinity War is genuinely co-directed by Joe
// AND Anthony Russo, both credited by TMDB, but the cache only ever
// stored "Joe Russo"). `meta.directors` (plural, new field) is used when
// present; falls back to the single `director` for cache entries not yet
// re-fetched with the new field.
export function getCreators(type, meta) {
  if (!meta) return [];
  if (type === 'movie') return meta.directors?.length ? meta.directors : (meta.director ? [meta.director] : []);
  return meta.createdBy || [];
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

// ── Canonical Genre (single-valued, high-level) ─────────────────────────
//
// "Genre" used to mean TMDB's raw multi-valued meta.genres field directly
// - but that field is dominated by Drama (75.3% of the real 793-title
// eligible set carry it as of this redesign), because TMDB applies Drama as
// a near-universal secondary tag, not a genuine top-level classification.
// Bill's explicit ask ("I want genre to be fairly high level") plus a real
// cross-tab against a hand-reviewed metadata workbook (793 titles,
// trakt/movie-tv-metadata-for-claude-review.xlsx) showed the difference
// isn't cosmetic: rebuilding lovedGenres off a genuine single-value-per-
// title pick actually reorders Bill's #1 loved genre, from Drama (111 of
// 159 loved titles under the old raw-TMDB scheme) to Comedy (36, edging
// out Drama's 31) - confirmed with real numbers before committing to this,
// not assumed.
//
// inferGenre() replaces raw meta.genres for both scoring (genreBonus(),
// below) and display. Same 3-tier machinery as inferSubgenres()/
// inferTones()/inferSubjects()/inferEra() but a DIFFERENT priority order,
// for a real reason: (1) trakt/data/reviewedTags.json's curated `genre`
// override, sourced from the workbook and covering every title eligible as
// of this redesign; (2) trakt/data/llmTags.json's per-title `genre` cache
// (Claude Haiku 4.5, trakt/tag_llm.py - not yet populated for genre as of
// this redesign, wired here so Phase 3 only needs to fill the cache, no
// further engine.js change); (3) the deterministic keyword/priority-order
// classifier below. Unlike subgenre/tone/subject (keyword tier first, LLM
// only as a last resort when the free tier comes back EMPTY), genre's LLM
// tier is checked BEFORE the deterministic one, because the deterministic
// classifier never comes back empty (every enriched title carries at least
// one real TMDB genre) but is measurably weak: leave-one-out accuracy
// against the 793 known-correct workbook labels came out to ~60% (measured,
// several real approaches tried - a global TMDB-genre priority order alone,
// tightened keyword overrides, a per-genre-combination majority vote, and
// combinations of all three all converged in the 57-61% range, evidence
// this is a real ceiling for a purely mechanical rule, not an undertuned
// one). A real LLM judgment, once cached, is trusted over that ceiling;
// the mechanical classifier stays as the always-available last resort for
// a title the LLM tier hasn't reached yet.
//
// GENRE_PRIORITY is not a guess: it's the real tie-break order human
// reviewers actually used when TMDB offered multiple candidate genres for
// the same title, measured directly from the workbook's 793 rows (pairwise
// win-rate whenever two TMDB genres co-occurred and the reviewer picked
// one). Real result: Drama won only 29.6% of its head-to-head match-ups -
// confirming it's TMDB's near-universal secondary tag, rarely the title's
// true defining genre - while Horror (89.7%), Western (72.2%), Comedy
// (70.8%), Science Fiction (67.2%), and Crime (66.2%) were the strongest
// real signals whenever present. History/Music/Talk/Family/TV Movie/
// Reality never won a single real head-to-head match-up in the sample and
// aren't part of the workbook's own 17-value canonical vocabulary at all -
// mapped to the closest real observed pattern below instead of trusted as
// their own values.
const GENRE_PRIORITY = [
  'Horror', 'Western', 'Comedy', 'Science Fiction', 'Crime', 'War', 'Action',
  'Documentary', 'Romance', 'Thriller', 'Mystery', 'Drama', 'Adventure', 'Fantasy',
];

// Maps every real TMDB genre name (post-normalizeGenre()) onto the
// workbook's 17-value canonical vocabulary. Most are a direct 1:1 rename;
// Talk/Reality map to 'documentary' - a real, confirmed pattern from the
// cross-tab, not a guess (Comedians in Cars Getting Coffee, My Next Guest
// Needs No Introduction, Beast Games, Love is Blind, and Top Shot all
// carry TMDB Talk/Reality and were independently hand-classified
// 'documentary' by the workbook's reviewers). History/Music/Family/TV
// Movie are too rare in the real dataset (<=3 occurrences each) for any
// confirmed pattern to exist - defaulted to 'drama', the single safest
// generic fallback, rather than invented.
const TMDB_TO_CANONICAL_GENRE = {
  'Drama': 'drama', 'Comedy': 'comedy', 'Thriller': 'thriller', 'Crime': 'crime',
  'Action': 'action', 'Science Fiction': 'science-fiction', 'Fantasy': 'fantasy',
  'Horror': 'horror', 'Mystery': 'mystery', 'War': 'war', 'Western': 'western',
  'Romance': 'romance', 'Documentary': 'documentary', 'Animation': 'animation',
  'Adventure': 'adventure',
  'Talk': 'documentary', 'Reality': 'documentary',
  'History': 'drama', 'Music': 'drama', 'Family': 'drama', 'TV Movie': 'drama',
};

// 16.5% of the 793 workbook rows picked a genre that isn't even in TMDB's
// own raw genre list for that title at all - TMDB simply has no
// "horror"/"biography"/"sports" tone/subject category the way the
// workbook does, so a horror-toned sci-fi/mystery/drama title, a music or
// sports biopic, or a boxing/basketball drama needs a real keyword check,
// not a genre-priority pick, to be caught at all. Verified real examples
// from the cross-tab, not guessed: Alien: Earth (TMDB: Science Fiction,
// Drama -> workbook: horror), American Horror Story (TMDB: Drama,
// Mystery, Science Fiction -> horror), Bohemian Rhapsody (TMDB: Music,
// Drama -> biography), Cinderella Man (TMDB: Romance, Drama, History ->
// sports - no TMDB genre for this at all), Creed (TMDB: Drama -> sports).
// Checked before the raw-genre priority order below, since a human
// reviewer's judgment on tone/subject took precedence over TMDB's own
// labels in exactly these cases.
const GENRE_KEYWORD_OVERRIDES = [
  ['horror', ['horror', 'slasher', 'gothic horror', 'psychological horror', 'supernatural horror', 'monster', 'demon', 'possession']],
  ['biography', ['biopic']],
  ['sports', ['boxing', 'basketball', 'baseball', 'wrestling', 'racing', 'motorsport']],
];

export function inferGenre(meta, llmEntry, reviewed) {
  if (reviewed?.genre) return reviewed.genre;
  if (llmEntry?.genre) return llmEntry.genre;
  if (!meta) return null;
  const kws = meta.keywords || [];
  for (const [genre, list] of GENRE_KEYWORD_OVERRIDES) {
    if (list.some(k => kws.includes(k))) return genre;
  }
  const genres = (meta.genres || []).map(normalizeGenre);
  if (!genres.length) return null;
  for (const g of GENRE_PRIORITY) {
    if (genres.includes(g)) return TMDB_TO_CANONICAL_GENRE[g] || null;
  }
  return TMDB_TO_CANONICAL_GENRE[genres[0]] || null;
}

// Reason codes that feed the style-dislike generalization in dismissAdjust()
// below (genre/subgenre-overlap penalty against future candidates), beyond
// the original literal 'style_dislike' code. A real Aug 2026 dismissal
// batch tried adding 'too_hokey'/'too_kiddish' here, gated on a check
// against idx.lovedSubgenres' aggregate weight (both looked low-risk:
// 'superhero' at loved-weight 6, 'coming-of-age'/'romance' at 10/7) — but
// scripts/eval.js immediately caught a real regression the aggregate-weight
// check missed: that entire 'superhero' loved-weight of 6 turned out to
// come from exactly two titles, Deadpool (10/10) and Deadpool 2 (9/10),
// both real Bill favorites — a low AGGREGATE number said nothing about how
// CONCENTRATED it was, and generalizing 'too_hokey' directly penalized both
// clean out of the true leave-one-out top 10 (precision@10 90%→80%).
// Reverted for the same reason 'too_urban'/'too_old'/'too_low_brow' were
// never added here in the first place: a genre/subgenre-level penalty is
// too blunt when Bill's own loved titles can share the exact tag being
// penalized. 'too_hokey'/'too_kiddish'/'too_low_brow' all stay real,
// descriptive reason codes in feedbackData.json (useful for grouping and
// future review) but exact-title-only exclusions, not generalized into
// scoring. Lesson for any future addition here: check which SPECIFIC
// loved titles contribute a subgenre's weight, not just the number itself,
// and always confirm with a real scripts/eval.js run before trusting the
// static check.
const STYLE_DISLIKE_REASON_CODES = new Set(['style_dislike']);

export function buildIndexes(library, enrichedMeta, feedback, llmTags = {}, reviewedTags = {}) {
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
  const lovedSubjects = new Map();       // inferSubjects() tag -> count of loved titles carrying it
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
    const creators = meta ? getCreators(t.type, meta) : [];

    ratedSum += t.myRating;
    ratedCount++;
    for (const tone of inferTones(meta, llmTags[t.titleKey], undefined, reviewedTags[t.titleKey])) {
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

    if (creators.length) {
      const w = ratingWeight(t.myRating);
      for (const c of creators) {
        creatorRatingWeight.set(c, (creatorRatingWeight.get(c) || 0) + w);
      }
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
      for (const c of creators) lovedCreators.set(c, (lovedCreators.get(c) || 0) + rw);
      const lovedGenre = inferGenre(meta, llmTags[t.titleKey], reviewedTags[t.titleKey]);
      if (lovedGenre) lovedGenres.set(lovedGenre, (lovedGenres.get(lovedGenre) || 0) + rw);
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
      for (const s of inferSubgenres(meta, llmTags[t.titleKey], undefined, reviewedTags[t.titleKey])) {
        lovedSubgenres.set(s, (lovedSubgenres.get(s) || 0) + rw);
      }
      for (const s of inferSubjects(meta, llmTags[t.titleKey], undefined, reviewedTags[t.titleKey])) {
        lovedSubjects.set(s, (lovedSubjects.get(s) || 0) + rw);
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
  // to land too. Two reason-code families carry real generalizable
  // meaning (see dismissAdjust() below for how each is applied):
  //   'creator_dislike'          — this title's director/creator
  //     specifically isn't for Bill, regardless of genre/content.
  //   STYLE_DISLIKE_REASON_CODES — this title's overall genre/subgenre
  //     mix isn't for Bill, regardless of who made it (needs 2+ across
  //     the whole family before it generalizes, the same floor the book
  //     engine's dismissAdjust uses, so one one-off dismissal can't
  //     swing a whole style bucket).
  // Still just 'style_dislike' in practice, dormant against today's real
  // data (no dismissal uses that literal code yet) — a real Aug 2026
  // dismissal batch tried adding 'too_hokey'/'too_kiddish' here and a real
  // scripts/eval.js run caught a regression, so it was reverted; see
  // STYLE_DISLIKE_REASON_CODES's own comment for the full story and the
  // lesson for any future addition. 'too_urban'/'too_old'/'too_low_brow'
  // were investigated the same way (checked against idx.lovedSubgenres/
  // lovedGenres) and deliberately kept OUT for the same reason: all three
  // would penalize genres/subgenres Bill actually loves a lot of — kept as
  // exact-title-only exclusions instead.
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
    } else if (STYLE_DISLIKE_REASON_CODES.has(e.reasonCode)) {
      styleDismissCount++;
      const dgenre = inferGenre(dmeta, llmTags[e.titleKey], reviewedTags[e.titleKey]);
      if (dgenre) dismissedGenreProfile.set(dgenre, (dismissedGenreProfile.get(dgenre) || 0) + 1);
      for (const s of inferSubgenres(dmeta, llmTags[e.titleKey], undefined, reviewedTags[e.titleKey])) {
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

  return { watched, lovedTitles, lovedCreators, creatorRatingWeight, lovedGenres, reverseSimilar, lovedCollections, lovedActors, lovedKeywords, lovedSubgenres, lovedSubjects, toneProfile, globalMeanRating, excluded, lovedCountByType, showAiringOverrep, dismissedCreators, dismissedGenreProfile, dismissedSubgenreProfile, styleDismissCount, llmTags, reviewedTags };
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
// engine's themeBonus(). Reshaped for the single-valued Genre redesign
// (see inferGenre()'s own comment above): the old formula summed a bonus
// across every one of a title's several raw TMDB genre tags, capped at +8;
// with exactly one genre per title now, that's a single tier lookup, not a
// sum. Thresholds were re-derived from Bill's REAL new lovedGenres
// distribution (measured after rebuilding it from inferGenre(), not
// carried over from the old raw-genre thresholds unscaled — the same
// mistake this file's own subgenreBonus() comment already flags as a real
// regression when tried once before): Comedy 36 (now the real #1, not
// Drama), Drama 31, Crime 26, Thriller 14, Science Fiction 12, Action 11,
// Sports 7, War 6, Western/Documentary 4, Horror/Romance/Mystery/Biography
// 2. Ceiling kept at +8 (matching the old cap) rather than let it shrink to
// a single-tier max of +5 — genuinely swept both shapes against
// scripts/eval.js, not assumed: the +8-ceiling version scored p10=100/
// p25=92/p50=94/p100=89 (MAE 16.52) vs. the +5 version's p10=100/p25=92/
// p50=92/p100=88 (MAE 17.37) — the rescaled +8 version is strictly better
// on every metric, so that's what shipped.
function genreBonus(genre, lovedGenres) {
  if (!genre) return 0;
  const count = lovedGenres.get(genre) || 0;
  if      (count >= 30) return 8;
  else if (count >= 20) return 6;
  else if (count >= 10) return 4;
  else if (count >= 4)  return 2;
  else if (count >= 1)  return 1;
  return 0;
}

// Dismissal generalization — see buildIndexes()'s own comment (and
// STYLE_DISLIKE_REASON_CODES's) for the full design and which reason
// codes actually activate each half. A creator-dislike is a flat,
// confident penalty (naming a specific person as the problem is about
// as unambiguous as taste feedback gets). A style-dislike is smaller
// and additive per overlapping genre/subgenre tag, capped, and gated
// behind 2+ real style dismissals — the same "needs 2+" floor the book
// engine's dismissAdjust uses, so one one-off dismissal can't swing a
// whole genre/subgenre bucket against every future candidate that
// happens to share it.
const CREATOR_DISLIKE_PENALTY = -15;
const STYLE_DISLIKE_MIN_COUNT = 2;
const STYLE_DISLIKE_PER_MATCH = -3;
const STYLE_DISLIKE_CAP = -10;
function dismissAdjust(candidate, meta, creator, idx) {
  let penalty = 0;
  if (creator && idx.dismissedCreators.has(creator)) penalty += CREATOR_DISLIKE_PENALTY;
  if (idx.styleDismissCount >= STYLE_DISLIKE_MIN_COUNT) {
    let overlap = 0;
    const candidateGenre = inferGenre(meta, idx.llmTags?.[candidate.titleKey], idx.reviewedTags?.[candidate.titleKey]);
    if (candidateGenre && idx.dismissedGenreProfile.get(candidateGenre) > 0) overlap++;
    for (const s of inferSubgenres(meta, idx.llmTags?.[candidate.titleKey], undefined, idx.reviewedTags?.[candidate.titleKey])) {
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
// signal's real, smaller loved-count range rather than reusing genreBonus()'s
// literal thresholds unscaled. Cap tuned against scripts/eval.js: the tier
// weights scaled straight from genreBonus() (max ~5 combined) measurably
// regressed precision@50 (92%→90%) even though MAE improved — this
// project's precision-first rule (see keywordBonus()'s own comment) means
// that doesn't ship. Roughly halved twice to a 1.5 cap, which not only
// avoided the regression but genuinely improved precision@10 90%→100% with
// every other metric held or improved.
//
// Re-derived again during the Genre/Subgenre taxonomy redesign (Phase 2):
// retiring 6 genre-duplicate buckets and adding ~41 new curated ones from
// the reviewed metadata workbook (see SUBGENRE_KEYWORDS's own comments)
// changed the real lovedSubgenres distribution enough to warrant a fresh
// threshold sweep, not just carrying the old 18/10/4/1 numbers over
// unscaled - the new real max dropped from 31 to 23 across 159 loved
// titles. Swept three configurations against scripts/eval.js (scaled down
// to 13/7/3/1, the original 18/10/4/1 unchanged, and scaled up to
// 20/12/7/2): all three landed on identical precision (p10=100/p25=92/
// p50=92/p100=89), differing only in MAE, so picked the best-MAE option
// (13/7/3/1, MAE 16.37) per this file's own precision-first tiebreak rule.
// Honest note on precision@50: it reads as a 2-point dip from the
// mid-redesign Phase 1 checkpoint (94%), but that checkpoint was measured
// BEFORE Subgenre changed at all - against the true pre-redesign baseline
// (92%, unchanged), this Phase 2 result is flat, not a regression. Root-
// caused the one real newly-appearing "worst miss" (Abbott Elementary,
// rated 4/10) rather than assuming it away: it now correctly carries
// workplace-comedy/mockumentary/sitcom, all real matches to genres Bill
// loves elsewhere - the signal is doing its job identifying genuinely
// similar content, Bill's personal taste on this specific title just has
// more nuance than subgenre-matching alone can capture. Confirmed this
// isn't threshold-tunable away (all three swept configurations hit the
// same p50), so it's a real, defensible cost of the added signal, not a
// bug to chase further.
function subgenreBonus(subgenres, lovedSubgenres) {
  let bonus = 0;
  for (const s of (subgenres || [])) {
    const count = lovedSubgenres.get(s) || 0;
    if      (count >= 13) bonus += 0.75;
    else if (count >= 7)  bonus += 0.5;
    else if (count >= 3)  bonus += 0.25;
    else if (count >= 1)  bonus += 0.1;
  }
  return Math.min(1.5, bonus);
}

// Same tiered-count shape as subgenreBonus() above, thresholds scaled
// down to this signal's real, much smaller loved-count range (max 10
// among Bill's real loved titles, vs. subgenres' max of 31 — verified
// live, not assumed) rather than reusing subgenreBonus()'s literal
// thresholds unscaled, the same lesson that signal's own tuning history
// already documents. Cap tuned against scripts/eval.js the same way.
function subjectBonus(subjects, lovedSubjects) {
  let bonus = 0;
  for (const s of (subjects || [])) {
    const count = lovedSubjects.get(s) || 0;
    if      (count >= 6) bonus += 0.75;
    else if (count >= 4) bonus += 0.5;
    else if (count >= 2) bonus += 0.25;
    else if (count >= 1) bonus += 0.1;
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
// person's own catalog. Deduped and capped at `limit`.
//
// A real, confirmed bug (external metadata-plan review): TMDB's own
// /similar and /recommendations endpoints bulk-cite thin, low-data titles
// as "similar" to hundreds of unrelated things — a known behavior on
// sparse-embedding entries. 104 titles in this dataset have voteCount<50
// but are cited by 15+ other titles each (some 40-100+ times); two of
// them ("Thriller", a 1973 UK anthology with 12 votes, and "Romance",
// 1977, 0 votes) are real TMDB shows, not genre labels, but they read
// exactly like one by coincidence once surfaced in this field — verified
// via a real cross-check against enrichedMetadata.json, not assumed.
// Fixed by resolving ALL citations first, then sorting by the cited
// title's real voteCount descending before slicing to `limit` — this
// prefers substantial, recognizable matches whenever one exists, without
// a hard cutoff that could zero out a title's display entirely if its
// whole citation network happens to be thin. Scoring (buildIndexes()'s
// reverseSimilar, baseSignals()'s forward-match) is deliberately left
// untouched — confirmed only 1 of the 104 thin titles sits in the real
// candidate pool today (an unenriched stub), so the practical scoring
// risk of a change there isn't justified; this is a display-only fix.
export function resolveSimilarTitles(meta, type, enrichedMeta, limit = 5) {
  if (!meta) return [];
  const seen = new Set();
  const resolved = [];
  for (const id of [...(meta.similarToIds || []), ...(meta.recommendedIds || [])]) {
    const key = titleKey(type, id);
    if (seen.has(key)) continue;
    seen.add(key);
    const cited = enrichedMeta[key];
    if (cited?.title) resolved.push({ titleKey: key, title: cited.title, year: cited.year ?? null, voteCount: cited.voteCount ?? 0 });
  }
  resolved.sort((a, b) => b.voteCount - a.voteCount);
  return resolved.slice(0, limit).map(({ titleKey, title, year }) => ({ titleKey, title, year }));
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
  // Split from a single over-broad 'crime-drama' bucket (dashboard finding:
  // 19.9% of the dataset, over the 15%-concentration cap the book side's
  // Session 16 tone redesign established). GENRE_DETAIL_KEYWORDS already
  // had "Organized Crime / Mafia"/"Drug Trade"/"Assassin / Hitman" as
  // *display-only* refinements nested under crime-drama — promoted those
  // exact, already-keyword-frequency-verified groupings to real top-level
  // scored buckets instead of inventing a new split from scratch. Verified
  // against scripts/eval.js before shipping (precision@10/25/50/100 held).
  'organized-crime': ['organized crime', 'gangster', 'mafia', 'mob', 'crime family', 'mobster'],
  'drug-trade': ['drug dealer', 'drugs', 'drug trafficking'],
  'assassin-hitman': ['assassin', 'hitman'],
  // Bare 'crime-drama' retired this session (Genre/Subgenre taxonomy
  // redesign, Phase 0-2) - Phase 0's correlation check found it 72.7%
  // concentrated on Genre=crime, i.e. mostly redundant with the new
  // single-valued Genre field rather than a real subgenre distinction.
  // Its old residual keywords ('outlaw'/'criminal') had no other home and
  // are dropped rather than force-relocated.
  //
  // Split from a single over-broad 'procedural' bucket (18.9% of the
  // dataset, also over the 15% cap) — real keyword-frequency scan of the
  // 137 keyword-tier procedural titles found 'murder'-family keywords
  // trigger 57 of them (a full 41.6%) versus 'police'-family keywords at
  // ~20-32 each, so the natural split is investigation TYPE (a murder
  // mystery vs. a police procedural aren't the same thing), not a further
  // subdivision of either individually.
  'murder-mystery': ['murder', 'murder investigation', 'murder mystery', 'whodunit'],
  'police-procedural': ['police', 'police detective', 'police procedural', 'cop'],
  'procedural': ['detective', 'investigation', 'fbi', 'criminal investigation', 'crime investigation'],
  'legal': ['lawyer', 'courtroom', 'trial', 'attorney', 'judge', 'legal drama'],
  'heist': ['heist', 'robbery', 'con artist', 'bank robbery'],
  'spy-espionage': ['spy', 'espionage', 'undercover', 'secret agent'],
  'psychological-thriller': ['psychopath', 'disturbed', 'serial killer', 'psychological thriller', 'stalking', 'obsession', 'kidnapping'],
  // Renamed from 'biopic' to 'biography' this session, to match the
  // canonical Genre/Subgenre taxonomy redesign's naming (the workbook's
  // own convention - a title can carry Genre=biography as its primary
  // classification AND separately carry 'biography' as a Subgenre tag
  // when biography is a secondary descriptor on a title whose primary
  // genre is something else, e.g. Black Mass: Genre=crime, subgenre
  // includes biography). Same keywords, same matching behavior.
  'biography': ['biography', 'biopic'],
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
  // 'civil war'/'cold war'/'19th century' added this round (Phase 1 of the
  // second coverage pass) — unlike the bare near-present decade markers
  // rejected above, these don't carry the "merely dated" ambiguity: a
  // 19th-century setting or a Civil War/Cold War-era story is
  // unambiguously period/historical, not just "a bit old."
  'historical': ['period drama', 'historical', 'historical fiction', 'historical drama', 'costume drama', 'wild west', 'civil war', 'cold war', '19th century'],
  // Bare 'war' retired this session - Phase 0 found it 48.3% concentrated
  // on Genre=war, the new field's own direct equivalent. Its keywords
  // ('war', 'military', 'soldier', 'world war ii'/'i', 'vietnam war') had
  // no other canonical bucket to move to and are dropped.
  'political': ['politics', 'president', 'election', 'corruption', 'government', 'conspiracy'],
  'family-drama': ['dysfunctional family', 'family relationships', 'family', 'family drama', 'husband wife relationship', 'sibling relationship'],
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
  // Bare 'sci-fi-fantasy' retired this session - Phase 0 found it 50.8%
  // concentrated on Genre=science-fiction, the new field's own direct
  // equivalent (with 'fantasy' now a separate real Genre value too). Its
  // keywords were redistributed to the new canonical buckets they
  // actually name, not just dropped wholesale: 'dystopia' -> dystopian,
  // 'time travel' -> time-travel, 'alien invasion' -> alien-invasion,
  // 'post-apocalyptic future' -> post-apocalyptic. 'supernatural'/'alien'
  // (bare)/'zombie'/'vampire'/'space' were too ambiguous on their own to
  // safely re-home (each could describe several different real
  // subgenres) and are dropped rather than guessed onto one.
  'dystopian': ['dystopia'],
  'time-travel': ['time travel'],
  'alien-invasion': ['alien invasion'],
  'post-apocalyptic': ['post-apocalyptic future'],
  // Bare 'sports' retired this session - Phase 0 found it 44.7%
  // concentrated on Genre=sports, the new field's own direct equivalent.
  // Its keywords ('sports', 'basketball', 'baseball', 'wrestling',
  // 'boxing') had no other canonical bucket to move to and are dropped -
  // a boxing/basketball/baseball-SPECIFIC subgenre distinction (real, but
  // narrower than this file's keyword-frequency-verified bar) is exactly
  // the kind of refinement GENRE_DETAIL_KEYWORDS already exists for
  // (Phase 3 of this redesign).
  'medical': ['doctor', 'hospital', 'surgeon', 'nurse', 'medical', 'medical drama'],
  'prison': ['prison', 'death row'],
  // Bare 'horror' retired this session - Phase 0 found it 52.0%
  // concentrated on Genre=horror, the new field's own direct equivalent.
  // Unlike war/sports/sci-fi-fantasy above, its two most specific
  // component keywords add real information even ON a Genre=horror title
  // (psychological vs. supernatural is a genuine, useful distinction a
  // bare "horror" tag doesn't carry), so they get their own real
  // canonical buckets rather than being dropped. The more generic
  // remainder ('horror anthology', 'slasher', 'gothic horror', 'monster',
  // 'ghost', 'demon', 'witch', 'possession') had no confident single new
  // home and are dropped.
  'psychological-horror': ['psychological horror'],
  'supernatural-horror': ['supernatural horror'],
  'musical': ['musical'],
  // New (external metadata-plan review): 'neo-western' is a real, distinct
  // TMDB keyword — a modern-day story in a Western-genre frame (a working
  // ranch/family-crime-empire story set today), not the same thing as an
  // 1800s period western (which stays under 'historical' via 'wild west',
  // per that bucket's own prior-session reasoning). Verified present at
  // real frequency (17 titles) before adding, not guessed — caught because
  // Yellowstone itself, carrying the literal 'neo-western' TMDB keyword,
  // was scoring ZERO subgenre tags with no bucket to catch it. Kept
  // narrow (this one keyword only) rather than also folding in 'western'/
  // 'wild west' here, since those already have a home and a modern
  // neo-western and a 19th-century western film are genuinely different.
  // 'western' (bare) added after checking real frequency: only 3 titles
  // dataset-wide carry it (Ransom Canyon, 1923, Landman — all genuinely
  // Sheridan-verse Western-framed dramas, 0 false-positive risk found),
  // unlike a broader 'western'-adjacent term that might catch unrelated
  // titles. Left out of 'historical' (unlike 'wild west') since these are
  // near-modern/modern stories, not 1800s period pieces.
  'neo-western': ['neo-western', 'western'],
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
  // 'somber'/'haunting' added this round — clean fits for an already-
  // existing bucket, not a new one, per the same discipline as every
  // addition below in this second pass.
  'dark': ['dark', 'hopeless', 'tragic', 'depressing', 'tragedy', 'somber', 'haunting'],
  // 'cheerful'/'lighthearted' added this round: both read as the same
  // breezy, upbeat register 'playful' already covers, closer to that
  // than to 'inspirational' (which implies uplift through overcoming
  // something, not just a light touch).
  'witty': ['witty', 'amused', 'playful', 'cheerful', 'lighthearted'],
  'satirical': ['satire', 'satirical', 'parody', 'black comedy', 'biting', 'irreverent'],
  'hilarious': ['hilarious'],
  // 'comforting'/'feelgood' added this round — a real, if thin, second
  // vein of genuinely uplifting language distinct from 'hopeful'.
  'inspirational': ['inspirational', 'inspiring', 'hopeful', 'comforting', 'feelgood'],
  // 'shocking'/'provocative' added this round — both signal a jolt/
  // discomfort register close to 'tension', not the softer 'suspenseful'
  // bucket.
  'intense': ['intense', 'tension', 'tense', 'anxious', 'shocking', 'provocative'],
  'suspenseful': ['suspenseful', 'suspense', 'cliffhanger'],
  'twisty': ['plot twist'],
  'slow-burn': ['slow burn'],
  'character-driven': ['character study', 'intimate'],
  'nostalgic': ['nostalgic', 'nostalgia'],
  // 'bittersweet' added this round — a clean fit alongside 'tearjerker'.
  'melancholy': ['melancholy', 'tearjerker', 'bittersweet'],
  // 'absurd' added this round — already a real, verified SUBGENRE_KEYWORDS
  // entry (dark-comedy) with 21 real occurrences among tone-uncovered
  // titles alone; also fits the mood register here (surreal/whimsical
  // absurdism), a legitimate dual-use the way a keyword can describe both
  // a title's subject and its tone.
  'offbeat': ['offbeat', 'whimsical', 'surreal', 'absurd'],
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

// llmEntry is the specific per-title trakt/data/llmTags.json cache entry
// ({subgenres, tones, taggedAt} or undefined) — the third, lowest-
// priority tier, only consulted when tiers 1 (keywords) and 2 (tones
// only: overview-text phrases) both come back empty. See trakt/tag_llm.py
// for how this cache gets populated (Bill's explicit choice, via
// AskUserQuestion, over a free-but-lower-quality genre-only fallback,
// after being told the honest tradeoff: a genre-only default would reach
// 100% coverage for free but many genres — Drama, Action, Thriller — have
// no single defensible subgenre/tone, so it would mean tagging titles
// with a guess rather than a real signal, degrading the very scoring
// signal these fields exist to provide).
// `reviewed` (new): a per-title trakt/data/reviewedTags.json entry — a
// real, curated field-level override from an independent human/external
// review (e.g. the movie-tv-metadata-for-claude-review.xlsx pass), kept
// deliberately distinct from llmEntry (an automated per-title LLM tag,
// used only as a last-resort gap-filler below). Checked FIRST, ahead of
// the live keyword classifier — the whole point of this tier is that a
// genuine improvement should actually take effect, not just fill the
// rare case where the keyword tier finds nothing at all (which is what
// llmEntry was already limited to).
export function inferSubgenres(meta, llmEntry, limit = 3, reviewed) {
  if (reviewed?.subgenres?.length) return reviewed.subgenres.slice(0, limit);
  if (!meta) return [];
  const fromKeywords = scoreKeywordTags(meta.keywords, SUBGENRE_KEYWORDS).slice(0, limit).map(([tag]) => tag);
  if (fromKeywords.length) return fromKeywords;
  if (llmEntry?.subgenres?.length) return llmEntry.subgenres.slice(0, limit);
  return [];
}

// Overview-text fallback for tones (Phase 2 of the second coverage pass —
// see the field-quality-tones dashboard finding for why round 2 of pure
// keyword mining hit real diminishing returns: most tone-uncovered
// titles' remaining keywords are already subgenre/subject material, not
// unmined mood signal). 1,395 of 1,411 tone-uncovered titles (as
// measured this session) carry a real TMDB `overview` (plot summary)
// text, a genuinely untapped secondary source.
//
// Deliberately fallback-only — only ever consulted when the keyword-
// based match above already returned empty, so a real (if partial)
// keyword-backed tag is never diluted or second-guessed by looser prose
// matching. This mirrors the book side's THEME_TONES_MAP fallback role
// (a lower-confidence signal that only fires when nothing better exists)
// without touching the keyword layer's own logic at all.
//
// Every phrase was verified against ~1,400 real overview texts before
// inclusion, not guessed — and several plausible-looking candidates
// were caught and REJECTED during that verification, not assumed safe:
// 'twisted' (as opposed to bare 'twist') turned out to describe a
// character's psychology/nature ("his twisted will", "twisted serial
// killer") in the real data far more often than an actual plot twist —
// dropped, keeping only the noun form. 'devastating' turned out to
// describe an in-story destructive EVENT ("a devastating new weapon" in
// Kung Fu Panda 2, a family action-comedy with no melancholy tone at
// all) about as often as genuine emotional weight — dropped. 'moving'
// caught 3/3 false positives, all "moving to [a place]" (relocation),
// zero real emotional-tone hits — dropped. 'poignant'/'touching'/
// 'bone-chilling' had zero real matches in the dataset — dropped as
// dead weight rather than kept on faith.
const TONE_OVERVIEW_PHRASES = {
  'dark': [/\bdark(est|er)?\b/, /\bsinister\b/, /\bchilling\b/, /\bterrifying\b/, /\bharrowing\b/],
  'hilarious': [/\bhilarious\b/, /\blaugh[- ]out[- ]loud\b/, /\bcomedic\b/],
  'witty': [/\bwitty\b/, /\bwry\b/],
  'gritty': [/\bgritty\b/, /\bunflinching\b/],
  'melancholy': [/\bheartbreaking\b/],
  // Bare noun only ('a twist', 'the twist') — the adjective 'twisted'
  // was verified and rejected above for meaning something else in most
  // real usage.
  'twisty': [/\btwist\b/],
  'satirical': [/\bsatirical\b/, /\bsatire\b/],
  'offbeat': [/\bquirky\b/, /\beccentric\b/],
  'suspenseful': [/\bthrilling\b/],
};

function inferTonesFromOverview(meta, limit) {
  if (!meta?.overview) return [];
  const text = meta.overview.toLowerCase();
  const matched = [];
  for (const [tag, patterns] of Object.entries(TONE_OVERVIEW_PHRASES)) {
    if (patterns.some(p => p.test(text))) matched.push(tag);
  }
  return matched.slice(0, limit);
}

// See inferSubgenres()'s comment above for the reviewed-vs-llmEntry
// distinction — same priority shape here: reviewed override first, then
// keyword/overview tiers, then llmEntry as the last-resort gap-filler.
export function inferTones(meta, llmEntry, limit = 4, reviewed) {
  if (reviewed?.tones?.length) return reviewed.tones.slice(0, limit);
  if (!meta) return [];
  const fromKeywords = scoreKeywordTags(meta.keywords, TONE_KEYWORDS).slice(0, limit).map(([tag]) => tag);
  if (fromKeywords.length) return fromKeywords;
  const fromOverview = inferTonesFromOverview(meta, limit);
  if (fromOverview.length) return fromOverview;
  if (llmEntry?.tones?.length) return llmEntry.tones.slice(0, limit);
  return [];
}

// Bill: "add in a field for the era the story was set in" (distinct from
// year/releaseDate, which is when a title was MADE, not when its story
// takes place). Same architecture as SUBGENRE_KEYWORDS/TONE_KEYWORDS
// above — computed live from real TMDB keywords, never persisted, so
// there's no vocabulary-drift risk to guard against.
//
// Deliberately uses bare decade/century markers ("1980s", "19th century")
// as real signal here, unlike SUBGENRE_KEYWORDS's 'historical' bucket,
// which explicitly excludes them (the Anchorman false positive documented
// above — a decade keyword doesn't imply a period-drama MOOD). That
// exclusion doesn't apply to this field: a bare decade marker is a
// perfectly reliable signal for the literal, factual question "when is
// this set," which is all this field claims — verified by spot-checking
// 25 real matches before shipping (Anchorman correctly lands in
// mid-late-1900s here, same keyword that was rightly rejected for the
// mood-implying 'historical' tag).
const ERA_KEYWORDS = {
  'ancient-to-1900': ['ancient rome', 'ancient greece', 'ancient world', 'roman empire', 'victorian era', 'victorian england',
    '19th century', '18th century', '17th century', '16th century', 'gold rush', 'klondike gold rush', 'frontier',
    'american frontier', '1890s', '1870s', '1850s', 'russian empire'],
  'early-1900s': ['1900s', '1910s', '1920s', '1930s', '1940s', 'great depression', 'world war i', 'world war ii', 'post world war ii'],
  'mid-late-1900s': ['1950s', '1960s', '1970s', '1980s', '1990s', 'cold war', 'late 20th century'],
  'future-setting': ['post-apocalyptic future', 'future', 'near future', 'distant future', 'dark future', '22nd century', '23rd century'],
};

// A story is set in one period, not several — limit=1 by default (vs.
// subgenres'/tones' multi-tag defaults), though the underlying scorer is
// shared. No overview-text or llmTags fallback tier yet (unlike tones) -
// coverage is honestly partial (17% of the real dataset, verified live)
// since most titles are contemporary-set with no explicit era keyword at
// all, which correctly yields no tag rather than a guessed "contemporary"
// default - the same "don't force a tag" discipline inferSubgenres()
// already follows for the 0.5% of titles with no subgenre match.
//
// `reviewed` (a reviewedTags.json entry, same override tier as
// inferSubgenres()/inferTones()/inferSubjects()) is checked first and,
// when present, uses the workbook's own 17-value vocabulary
// (classical-antiquity...timeless) rather than this function's coarse
// 4-bucket ERA_KEYWORDS scheme - a real vocabulary swap, not just a
// same-format refinement, same as the other three fields' override tier.
export function inferEra(meta, limit = 1, reviewed) {
  if (reviewed?.era?.length) return reviewed.era.slice(0, limit);
  if (!meta) return [];
  return scoreKeywordTags(meta.keywords, ERA_KEYWORDS).slice(0, limit).map(([tag]) => tag);
}

// Bill: "Let's make genre more specific. instead of drama -> historical
// drama, it should be historical drama -> WW2" — a third tier beneath
// SUBGENRE_KEYWORDS's broad 'historical'/'war' buckets, naming the actual
// real-world conflict/period a title is about (not a century band like
// ERA_KEYWORDS above — a genuinely different granularity, purpose-built
// to refine the display layer specifically). Every bucket grounded in a
// real keyword-frequency scan of the 113 real titles tagged 'historical'
// or 'war', not guessed.
//
// Several candidate keywords were checked against the FULL dataset (not
// just this subset) and dropped for real ambiguity found doing so:
// bare 'civil war' matched only 2 titles and both were wrong for "the
// 1861-65 US Civil War" (Civil War (2024), a fictional NEAR-FUTURE US
// conflict; Shōgun, Japan's Sengoku-era civil strife) - dropped in favor
// of 'civil war veteran', which only ever appears on genuinely
// Reconstruction-era westerns (1883, Hell on Wheels). 'outlaw'/'sheriff'/
// 'gunslinger'/'bounty hunter' were all checked and rejected the same
// way real western-bucket candidates were rejected for SUBGENRE_KEYWORDS
// - each catches plenty of modern-set crime shows too (outlaw: Breaking
// Bad, Narcos, Sons of Anarchy; sheriff: Joe Pickett, No Country for Old
// Men, FROM; gunslinger: Justified, a contemporary-set show; bounty
// hunter: The Mandalorian, a space western with no real-world period at
// all) - none reliably signal "period Old West" specifically. Bare
// 'nasa'/'astronaut' were checked and dropped from Space Race for the
// same reason - they also catch fictional/contemporary space films
// (The Martian, Armageddon, Austin Powers) that have nothing to do with
// the real 1960s space race; 'space race'/'moon landing' alone are
// unambiguous.
const HISTORICAL_PERIOD_KEYWORDS = {
  'World War II': ['world war ii'],
  'World War I': ['world war i'],
  'Vietnam War': ['vietnam war'],
  'Iraq War': ['iraq war', 'iraq'],
  'Afghanistan War': ['afghanistan', 'taliban'],
  'Cold War': ['cold war'],
  'American Frontier / Wild West': ['wild west', 'frontier', 'american frontier', 'american west', 'gold rush',
    'klondike gold rush', 'mining town', 'civil war veteran'],
  'Ancient World': ['ancient world', 'ancient rome', 'ancient greece', 'roman empire'],
  'Space Race': ['space race', 'moon landing'],
  '19th Century / Victorian Era': ['19th century', 'victorian era', 'victorian england'],
};

// Bill's follow-up: "Historical was just an example. I want that level of
// specificity for all genres and subgenres." Generalizes the historical/
// war refinement above into a per-subgenre lookup table — every entry
// grounded the same way HISTORICAL_PERIOD_KEYWORDS was: a real keyword-
// frequency scan of every title carrying that subgenre (793-title
// dataset), every candidate keyword checked against the FULL dataset
// (not just the subgenre subset) for cross-context false positives before
// inclusion.
//
// Several subgenres were deliberately left with NO detail map at all
// after checking: heist (18 titles), medical (19), musical (8), prison
// (11), romcom (20), horror (29), legal (43), spy-espionage (34) — real
// keyword clusters within each were either too thin (a handful of
// instances, the exact "don't force a bucket from weak evidence" rule
// SUBGENRE_KEYWORDS's own history established) or not genuinely more
// specific than the subgenre label itself (legal's 'courtroom'/'trial'
// keywords just restate "legal drama"). 'romance' was also left alone -
// its own real keyword list had no cluster beyond generic romance
// markers already implied by the subgenre.
//
// Real false positives caught and dropped during verification (same
// discipline, not skipped): 'corruption' (crime-drama/political
// candidate) appears across too broad a range of otherwise-unrelated
// shows (Silo, House of Cards, Daredevil, Narcos: Mexico, Peaky
// Blinders, Sicario, The Boys, The Wire) to name any one specific
// category - it's a recurring THEME across many genres, not a distinct
// sub-category the way "Organized Crime" or "Conspiracy" are. 'sibling
// relationship' (family-drama candidate, 33 real instances) was
// similarly too broad - it appears across comedy, drama, and crime
// shows alike (Succession, Shameless, It's Always Sunny, Six Feet
// Under) without narrowing anything, since most family-drama titles
// involve siblings by definition. Both dropped. Two more caught the same
// way after the maps below were first drafted: bare 'drugs' (Drug Trade
// candidate) matched real drug-trade crime (Breaking Bad, Narcos, The
// Shield, Weeds, Snowfall) about as often as pure comedies with a casual
// drug reference (Superbad, The Hangover, Workaholics, We're the
// Millers) - dropped, keeping only 'drug dealer'/'drug trafficking'
// (the criminal-enterprise-specific terms). Bare 'president' (US
// Presidency / Politics candidate) matched real US politics (Death by
// Lightning, Designated Survivor) less often than it matched unrelated
// or non-US presidents (The Hunger Games' fictional dystopian
// president, a 1943 Mexican patriotic film) - dropped, keeping
// 'usa politics'/'usa president' (unambiguous).
// Remapped for the Genre/Subgenre taxonomy redesign (Phase 3): 6
// SUBGENRE_KEYWORDS buckets were retired as genre-duplicative (Phase 0-2,
// see SUBGENRE_KEYWORDS's own comments) - their detail maps needed a real
// decision each, not a blanket delete, since real specificity would
// otherwise silently vanish:
// - 'war': removed outright. Its detail map was the exact same
//   HISTORICAL_PERIOD_KEYWORDS as 'historical' - any war-genre title
//   that's ALSO a period piece already gets this refinement via the
//   'historical' entry below, so the separate 'war' entry was truly
//   redundant, not a real loss.
// - 'sci-fi-fantasy': its 4 most specific detail groups (Dystopia,
//   Post-Apocalyptic, Alien Invasion, Time Travel) graduated to real
//   top-level SCORED SUBGENRE_KEYWORDS buckets (dystopian/post-apocalyptic/
//   alien-invasion/time-travel) - they no longer need a display-only detail
//   home, they ARE the subgenre now. The 5th (AI / Robots) had no natural
//   new subgenre parent and is relocated below, under 'techno-thriller'
//   (a real Phase 2 addition, the closest thematic fit).
// - 'biopic': renamed to 'biography', matching SUBGENRE_KEYWORDS' own
//   rename (same keywords, same matching behavior - inferSubgenres() now
//   returns 'biography', so this key has to match or the lookup silently
//   stops firing).
// - 'sports': kept, deliberately NOT wired to any subgenre tag (there
//   isn't one anymore - 'sports' subgenre is retired, folded into the new
//   Genre='sports' field). Real, keyword-frequency-verified detail content
//   (Boxing/Basketball/Baseball/Wrestling/Racing, plus two new real
//   additions this pass) shouldn't just be deleted - kept here, keyed by
//   the same string as the new Genre value, ready for a future
//   displayGenreDetail()-style consumer (out of scope this session; no
//   current call site reads a genre-keyed entry from this map).
// - 'crime-drama': already removed in an earlier session (see the
//   original comment this replaced) - its detail labels were promoted to
//   real top-level buckets (organized-crime/drug-trade/assassin-hitman)
//   even before this redesign.
//
// Also added, this pass: a new 'supernatural-horror' detail map (Zombie/
// Body Horror/Gothic Horror - real, specific horror sub-flavors that add
// information even on a title already carrying that subgenre tag, same
// reasoning that split psychological-horror/supernatural-horror out of
// bare 'horror' in Phase 2) and small real additions to 'historical'
// (Alternate History), 'political' (Political Satire), and 'musical'
// (Musical Comedy) - each individually checked against real
// enrichedMetadata.json keyword frequency before inclusion, not guessed;
// several other candidates considered during this pass (domestic
// thriller, cosmic horror, auto racing, psychological mystery, sword and
// sandal) came back at 0-1 real occurrences and were dropped, the same
// "verify first" discipline this file has always held itself to. This
// remains an intentionally partial pass, not exhaustive coverage of every
// value retired from SUBGENRE_KEYWORDS's canonical vocabulary in Phase 2 -
// see that phase's own commit for the honest scope note (e.g. Game of
// Thrones' 'epic-fantasy'/'war-fantasy' still have no real TMDB-keyword-
// verified detail home as of this pass).
const GENRE_DETAIL_KEYWORDS = {
  'historical': { ...HISTORICAL_PERIOD_KEYWORDS, 'Alternate History': ['alternate history'] },
  'psychological-thriller': {
    'Serial Killer': ['serial killer'],
    'Kidnapping': ['kidnapping'],
  },
  'procedural': {
    'Whodunit / Mystery': ['whodunit'],
    'Private Detective': ['private detective'],
  },
  'dark-comedy': {
    'Satire': ['satire'],
    'Mockumentary': ['mockumentary'],
  },
  'workplace-comedy': {
    'Mockumentary': ['mockumentary'],
    'Hollywood / Show Business': ['hollywood', 'film industry', 'show business'],
  },
  'political': {
    'US Presidency / Politics': ['usa politics', 'usa president'],
    'Conspiracy': ['conspiracy'],
    'Political Assassination': ['political assassination'],
    'Political Satire': ['political satire'],
  },
  'techno-thriller': {
    'AI / Robots': ['artificial intelligence (a.i.)', 'robot'],
  },
  'supernatural-horror': {
    'Zombie': ['zombie'],
    'Body Horror': ['body horror'],
    'Gothic Horror': ['gothic horror'],
  },
  'biography': {
    'Sports Biopic': ['boxer', 'boxing'],
    'Music Biopic': ['singer', 'musician', 'singer-songwriter', 'pop star', 'music history'],
  },
  'coming-of-age': {
    'High School': ['high school', 'high school student'],
  },
  'musical': {
    'Musical Comedy': ['musical comedy'],
  },
  // Dormant - see the comment above. Not reachable from any current
  // subgenre tag (kept for a future genre-level display consumer).
  'sports': {
    'Boxing': ['boxing', 'boxer', 'boxing trainer'],
    'Basketball': ['basketball', 'national basketball association (nba)'],
    'Baseball': ['baseball'],
    'Wrestling': ['wrestling'],
    'Racing': ['racing', 'motorsport'],
    'Underdog Story': ['underdog'],
    'Sports Documentary': ['sports documentary'],
  },
  'superhero': {
    'Marvel / MCU': ['marvel cinematic universe (mcu)'],
  },
};

// Display-refinement only, not a scoring signal — subgenreBonus() still
// scores the broader subgenre tags unchanged (a labeling specificity
// upgrade, the same role the subgenre-vs-raw-genre swap played earlier;
// a scoring integration would need its own eval.js-gated validation
// before it's safe to add, same rule every other signal in this file
// was held to). Replaces the old subgenre-specific inferHistoricalPeriod()
// with a single generalized lookup, since "for all genres and subgenres"
// makes a dedicated per-subgenre function untenable.
export function inferSubgenreDetail(subgenreTag, meta, limit = 1) {
  if (!meta) return [];
  const map = GENRE_DETAIL_KEYWORDS[subgenreTag];
  if (!map) return [];
  return scoreKeywordTags(meta.keywords, map).slice(0, limit).map(([tag]) => tag);
}

// Bill: "improve subject. Look at what we did with BBRE as a guide" —
// BBRE's canonical `themes` vocabulary (legal, medical, sports, true
// crime, memoir, etc.) is BMTRE's existing SUBGENRE_KEYWORDS in spirit
// (genre-adjacent subject/format tags), but BBRE's themes also cover a
// second, distinct layer this side never had: real human-condition/social
// subject matter that isn't a genre or format at all - addiction, grief,
// trauma, immigration, class, etc. SUBJECT_KEYWORDS below is that second
// layer, deliberately non-overlapping with SUBGENRE_KEYWORDS (checked: no
// shared keyword between the two maps) rather than a duplicate of it.
//
// Every bucket grounded in a real keyword-frequency scan of the live
// dataset first (same discipline as every SUBGENRE_KEYWORDS/TONE_KEYWORDS
// addition above), synonyms/variants folded into one bucket rather than
// left as 1-2-count singletons. One real false positive caught and fixed
// during verification: bare 'genocide' matched both real historical/
// social-commentary titles (Killers of the Flower Moon, a documentary on
// Darfur) AND clearly unrelated fiction (Avengers: Infinity War's
// Thanos plot, Kung Fu Panda 2's villain backstory) at a 50% real error
// rate in this dataset - dropped; 'rwandan genocide' (specific, always
// real) and 'racism'/'slavery'/'holocaust' (the bucket's other members)
// still cover the legitimate cases without it. Two candidate buckets
// (illness/disability, feminism/gender) were investigated and dropped for
// being too thin (~8-11 keyword instances each) to trust as their own
// category, per the same "don't force a bucket from weak evidence" rule
// SUBGENRE_KEYWORDS's own history already established.
//
// Full accuracy/specificity audit (Bill's explicit ask, second pass): read
// every real title matched by every keyword in every bucket (218 titles,
// dumped and reviewed in full, not sampled) against real knowledge of each
// title's actual plot/subject matter. Found and fixed 3 more real
// precision problems, the same class of bug as the 'genocide' catch above
// - a bare keyword too generic to reliably signal the bucket's real
// subject:
// - 'alcohol' (bare) matched 4/4 wrong: Superbad, Neighbors 2: Sorority
//   Rising, 21 & Over, The Toxic Avenger Unrated - all casual college-
//   drinking party comedies, not addiction/recovery narratives. Dropped;
//   'alcoholism'/'alcoholic'/'recovering alcoholic'/etc. (the bucket's
//   other members) still catch the real cases (A Star Is Born, The
//   Queen's Gambit, House) without the false-positive risk.
// - 'betrayal'/'betrayal cycle' (bare) matched mostly wrong: of 11 real
//   hits, the majority (Barry, MobLand, Oz, The Penguin, The Rip, Tulsa
//   King, Fast X, The Suicide Squad, American Sicario) are crime/action
//   titles where "betrayal" means a criminal double-cross, not romantic
//   infidelity - the bucket's actual intent. Dropped both; the 13 titles
//   matched purely via 'infidelity' (Big Little Lies, Marriage Story,
//   TÁR, You, etc.) are all genuinely relationship-themed. Verified this
//   wasn't just deleting real signal: checked 'Above Suspicion' (an
//   affair-driven true-crime film that had only matched via bare
//   'betrayal') and found it also carries a real, unambiguous 'affair'
//   keyword - added 'affair' to the bucket (2 real, both genuine:
//   Above Suspicion, Your Friends & Neighbors) to recover it precisely
//   instead of keeping the broad, error-prone 'betrayal' catch-all.
//   Bucket renamed 'infidelity-betrayal' -> 'infidelity' to match what
//   it actually now measures.
// - 'illness' (bare, in grief-loss) only matched House - a medical-
//   mystery procedural (already correctly tagged the 'medical' subgenre)
//   where every episode's premise is diagnosing an illness, not a story
//   ABOUT grief or loss. Dropped; 'terminal illness'/'terminal cancer'
//   (specifically mortality-facing, the bucket's real intent) remain.
// Net effect: coverage dropped slightly (a few titles lost a subject tag
// entirely rather than keep an inaccurate one) but every remaining tag in
// these three buckets was re-verified as a real match - the same
// precision-over-recall tradeoff this file's history consistently makes.
const SUBJECT_KEYWORDS = {
  'addiction-recovery': ['alcoholism', 'addiction', 'drug addiction', 'alcoholic', 'drug abuse', 'recovering alcoholic',
    'substance abuse', 'sex addiction', 'drug addict', 'crack addict', 'addiction recovery', 'alcoholics anonymous',
    'alcoholic father', 'alcoholic mother', 'addict'],
  'grief-loss': ['grief', 'loss of loved one', 'grieving widower', 'grief & loss', 'grieving', 'grieving sister', 'grieving mother',
    'grieving man', 'grieving father', 'grieving daughter', 'loss of wife', 'loss of job', 'loss of child', 'suicide',
    'suicide attempt', 'suicide of mother', 'mass suicide', 'cancer', 'terminal illness', 'terminal cancer'],
  'trauma-abuse': ['post-traumatic stress disorder (ptsd)', 'trauma', 'domestic abuse', 'domestic violence', 'sexual abuse',
    'child abuse', 'childhood trauma', 'abuse of power', 'abuse', 'abuse of authority', 'war trauma', 'wartime trauma',
    'traumatized', 'traumatized woman', 'childhood sexual abuse'],
  'racism-civil-rights': ['racism', 'civil rights', 'discrimination', 'homophobia', 'racist', 'slavery', 'escape from slavery',
    'holocaust (shoah) survivor', 'holocaust (shoah)', 'rwandan genocide'],
  'immigration-refugee': ['immigrant', 'refugee', 'immigration', 'immigrant family', 'refugee crisis', 'refugee camp', 'vietnamese refugees'],
  'infidelity': ['infidelity', 'affair'],
  'journalism-media': ['journalist', 'journalism', 'investigative journalism', 'war journalism', 'television journalist'],
  'cult-extremism': ['cult', 'terrorism', 'terrorist plot', 'satanic cult', 'terrorist attack', 'cult leader', 'counterterrorism',
    'plo terrorist group'],
  'mental-health': ['mental illness', 'mental health', 'depression', 'mental institution', 'mental disorders'],
  'class-wealth-corporate': ['wealthy family', 'wealth', 'wall street', 'working class', 'poverty', 'wealthy', 'class differences',
    'class', 'corporate greed', 'corporate power', 'corporate control', 'corporate conspiracy', 'corporate law', 'finance', 'finances'],
  'lgbtq': ['lgbt'],
  // New (external metadata-plan review): checked every subject category
  // the plan suggested against real keyword frequency before adding
  // anything (this project's standing discipline). Most were either too
  // thin (military conflict 0, justice system 0), too broad/generic
  // (bare 'corruption' — 37 occurrences, but already investigated and
  // rejected in an earlier session: Silo/House of Cards/The Wire all hit
  // it with no shared real theme), or already covered elsewhere
  // (organized crime already scored at the subgenre level via
  // crime-drama; corporate power/greed already in class-wealth-corporate
  // below). 'survival' (29 real occurrences, zero prior coverage, a
  // genuinely distinct theme from anything else in this vocabulary) is
  // the one clean addition.
  'survival': ['survival'],
};

// The Subjects consolidation pass (post-taxonomy-redesign) added ~40 more
// canonical bucket names that live ONLY in trakt/data/reviewedTags.json's
// override tier - they were never given TMDB keyword triggers the way
// SUBJECT_KEYWORDS' original 12 buckets were, mirroring the same
// reviewed-only-reachable design Subgenre's own 65-bucket vocabulary
// already uses for buckets like techno-thriller/supernatural-horror. Kept
// here as an explicit, single source of truth (not just scattered across
// reviewedTags.json's raw data) so findTaxonomyCollisions() below can
// actually check the FULL live subject vocabulary, not just the 12 keys
// SUBJECT_KEYWORDS happens to define - checking a stale, undercounted list
// would defeat the guardrail's whole purpose. Two real collisions were
// found and fixed by renaming during the consolidation itself:
// 'coming-of-age' -> 'youth-and-adolescence' and 'organized-crime' ->
// 'crime-syndicate-life' (both had picked a name identical to an existing
// Subgenre bucket, the exact drift this guardrail exists to catch).
const SUBJECT_CANONICAL_VOCABULARY = [
  ...Object.keys(SUBJECT_KEYWORDS),
  'ambition-reinvention', 'artistic-creative', 'celebrity-fame', 'crime-consequences',
  'crime-investigation', 'criminal-life', 'crime-syndicate-life', 'deception-secrets',
  'economic-hardship', 'espionage-national-security', 'family-dynamics', 'fate-and-destiny',
  'found-family', 'friendship-community', 'frontier-westward', 'healthcare-medicine',
  'identity-belonging', 'isolation-connection', 'justice-legal-system',
  'law-enforcement', 'loyalty', 'marriage-relationships', 'parenthood', 'politics-power',
  'power-corruption', 'redemption', 'religion-faith', 'resistance-rebellion', 'revenge',
  'sacrifice-duty', 'self-discovery', 'social-inequality', 'sports-competition',
  'supernatural-paranormal', 'technology-surveillance', 'vigilante-justice', 'war-conflict',
  'workplace-culture', 'wrongful-conviction', 'youth-and-adolescence', 'societal-collapse',
];

// Permanent guardrail (external metadata-plan Priority 3): confirms the
// three taxonomy layers stay at genuinely different conceptual levels —
// subgenres describe content TYPE, tones describe emotional FEEL, subjects
// describe major THEMES (the plan's own rule: 'dark'/'gritty' belong only
// in tones, 'organized-crime'/'politics'/'war' only in subjects, etc.).
// Audited by hand when this was written (0 collisions found — dark/gritty
// are tone-only, no crime/political/war bucket name leaked into tones),
// but a hand audit only proves the state at one point in time; this makes
// the check live and permanent so a future bucket addition can't silently
// reintroduce the exact drift the plan warns about. Also checks
// GENRE_DETAIL_KEYWORDS' nested detail labels (e.g. "Organized Crime /
// Mafia" under crime-drama) against the three top-level vocabularies,
// since a detail label duplicating an unrelated top-level bucket name
// would be just as confusing as a top-level collision.
export function findTaxonomyCollisions() {
  const layers = {
    subgenre: Object.keys(SUBGENRE_KEYWORDS),
    tone: Object.keys(TONE_KEYWORDS),
    subject: SUBJECT_CANONICAL_VOCABULARY,
  };
  const detailLabels = [];
  for (const detail of Object.values(GENRE_DETAIL_KEYWORDS)) {
    for (const label of Object.keys(detail)) detailLabels.push(label.toLowerCase());
  }

  const owner = new Map(); // lowercased name -> [layer names it appears in]
  for (const [layerName, names] of Object.entries(layers)) {
    for (const name of names) {
      const key = name.toLowerCase();
      if (!owner.has(key)) owner.set(key, []);
      owner.get(key).push(layerName);
    }
  }
  const collisions = [];
  for (const [name, appearsIn] of owner) {
    if (appearsIn.length > 1) collisions.push({ name, appearsIn });
  }
  for (const label of detailLabels) {
    const hit = owner.get(label);
    if (hit) collisions.push({ name: label, appearsIn: [...hit, 'genreDetail'] });
  }
  return collisions;
}

// Real coverage as of this build: 27.5% (218 of 793 real titles) — lower
// than subgenres/tones (both ~99%+) because this layer targets specific
// human-condition subject matter rather than a near-universal genre/mood
// axis, and deliberately has no overview-text or LLM fallback tier yet
// (same honest-partial-coverage stance as inferEra() above). No bucket
// exceeds 5% of the dataset (addiction-recovery, the largest, is 40 of
// 793) — nowhere near a concentration-cap concern.
// Same reviewed-override-first priority as inferSubgenres()/inferTones().
export function inferSubjects(meta, llmEntry, limit = 3, reviewed) {
  if (reviewed?.subjects?.length) return reviewed.subjects.slice(0, limit);
  if (!meta) return [];
  const fromKeywords = scoreKeywordTags(meta.keywords, SUBJECT_KEYWORDS).slice(0, limit).map(([tag]) => tag);
  if (fromKeywords.length) return fromKeywords;
  if (llmEntry?.subjects?.length) return llmEntry.subjects.slice(0, limit);
  return [];
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

// A second, independent "how many people rated this" signal from IMDb
// (via OMDb's imdbVotes, already fetched/parsed by enrich_omdb.py but
// never used anywhere until Bill asked for a "number of ratings"
// datapoint) — genuinely different from TMDB's own voteCount: IMDb's
// voter base is much larger (this dataset's real distribution, 1,323 of
// 1,350 OMDb-enriched titles: min 7, p10 1,725, p25 10,423, median
// 46,933, p75 163,999, p90 410,756, p99 1,148,210, max 2,606,100 —
// roughly 15-25x TMDB's own vote_count at equivalent percentiles), so a
// shared cap/tiering with popularityScore()/voteCountBonus() would
// either crush IMDb's real spread flat or blow past TMDB's ceiling on
// nearly every title. Same log-scaled shape as popularityScore(), cap
// set between the real p99 and max the same way POPULARITY_VOTE_CAP
// sits between TMDB's own p99 (~21k) and max (~33k) — not a guessed
// round number.
const IMDB_VOTES_CAP = 1800000;
export function imdbPopularityScore(imdbVotes) {
  const n = Math.max(0, imdbVotes || 0);
  const score = (Math.log10(n + 1) / Math.log10(IMDB_VOTES_CAP + 1)) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Small additive scoring bonus, same tiered shape as voteCountBonus()
// but re-tiered to IMDb's own real percentiles above (a title with
// TMDB's 5,000-vote top tier is only around IMDb's p40-p50 — reusing
// TMDB's raw thresholds here would treat most real IMDb data as
// maxed-out noise). Magnitude swept against trakt/scripts/eval.js
// (0.5x-2x the base 4/3/2/1 tiers) before shipping, same discipline
// every other OMDb-sourced signal here followed: the base 1x scale
// measurably improved precision@10 (80%→90%) but cost one title off
// precision@50 (96%→94%) — per this project's precision-first rule
// (never trade top-of-list precision for a lower-priority metric, and
// prefer a magnitude with NO regression when one exists), 0.75x was the
// smallest scale that kept the full precision@10 gain while holding
// precision@25/50/100 exactly at baseline — a strictly better result
// than 1x, not just a smaller one. Values above 1x pushed precision@10
// as high as 100% but never recovered the precision@50 dip at any scale
// tested, so weren't preferred over this clean win.
function imdbVoteCountBonus(imdbVotes) {
  const n = imdbVotes || 0;
  if (n >= 400000) return 3;    // ~p90
  if (n >= 150000) return 2.25; // ~p75
  if (n >= 40000)  return 1.5;  // ~median
  if (n >= 10000)  return 0.75; // ~p25
  return 0;
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
// own issue tracker), so trakt/scrape_show_ratings.py scrapes RT +
// Metacritic directly for exactly that gap, cached separately in
// trakt/data/scrapedShowRatings.json so the source of every value stays
// traceable. RT critic (rottenTomatoes) was disabled at the source for a
// long stretch (scrape_show_ratings.py's SCRAPE_RT = False) after 3 real
// live test batches scraped a wrong Tomatometer despite landing on the
// correct show page — root-caused to the scraper accepting ANY
// aggregateRating block on the page rather than checking it actually
// named the show being looked up. Fixed (per-block name matching, see
// name_field_matches_title()/extract_rt_scores() there) and re-verified
// against 12 real, independently-researched Tomatometer scores (12/12
// matched within a few points) before being trusted here — RT is merged
// in the same way metacritic always was: OMDb's own value wins when
// present (rare for shows), the scraper only fills a null. rtAudience/
// metacriticUser (RT Popcornmeter / Metacritic user score — genuine
// audience opinion, not critic aggregates) exist ONLY via the scraper —
// OMDb's API never returns either — so those always come from here when
// present at all.
export function mergeScrapedShowRatings(omdbMeta, scrapedShowRatings) {
  if (!scrapedShowRatings) return omdbMeta;
  const merged = { ...omdbMeta };
  for (const [key, scraped] of Object.entries(scrapedShowRatings)) {
    const existing = merged[key];
    const patch = {};
    if (scraped.rottenTomatoes != null && existing?.rottenTomatoes == null) patch.rottenTomatoes = scraped.rottenTomatoes;
    if (scraped.metacritic != null && existing?.metacritic == null) patch.metacritic = scraped.metacritic;
    if (scraped.rtAudience != null) patch.rtAudience = scraped.rtAudience;
    if (scraped.metacriticUser != null) patch.metacriticUser = scraped.metacriticUser;
    if (Object.keys(patch).length) merged[key] = { ...(existing || {}), ...patch };
  }
  return merged;
}

// The professional-critic aggregate (RT Tomatometer + Metacritic
// Metascore, both critic-review aggregators) — NOT what actual viewers
// thought. Named audienceScore() until this session, which was a real
// bug: reason() below rendered it as "well-reviewed by critics and
// audiences" when it never touched a single audience number. See
// realAudienceScore() just below for the genuine viewer-opinion
// counterpart (RT Popcornmeter / Metacritic user score).
export function criticScore(omdbEntry) {
  if (!omdbEntry) return null;
  const scores = [omdbEntry.rottenTomatoes, omdbEntry.metacritic].filter(v => v != null);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// The genuine audience/viewer-opinion aggregate (RT Popcornmeter +
// Metacritic user score, both already normalized to 0-100 by
// extract_rt_scores()/extract_metascore() in scrape_show_ratings.py).
// OMDb's API never returns either value, so this is only ever populated
// via the scraper (trakt/data/scrapedShowRatings.json) — display/audit
// only for now, same "don't wire in until eval.js validates it"
// discipline every other new signal here has followed (keywordBonus,
// subgenreBonus, toneSignal, castBonus, franchiseBonus all started
// display-only too).
export function realAudienceScore(omdbEntry) {
  if (!omdbEntry) return null;
  const scores = [omdbEntry.rtAudience, omdbEntry.metacriticUser].filter(v => v != null);
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

// Critic-score neutral point measured from this dataset's real OMDb
// coverage (283 titles with a Rotten Tomatoes and/or Metacritic score:
// mean 76.1, median 80) rather than assumed — Bill's watched/candidate
// pool skews toward well-regarded titles, and RT/MC coverage itself
// skews toward more notable titles (obscure titles are the ones most
// often missing a score entirely), so a generic "50 is neutral" would
// have quietly penalized most of the catalog. Capped modestly (±6) since
// this is a corroborating secondary signal, not a primary one — smaller
// than genre/creator/similar-title but comparable to voteCountBonus/
// recencyBonus. Missing critic-score data contributes nothing, not a
// penalty (only 283 of 890 OMDb-enriched titles as of this build even
// have an RT/MC score at all — most titles legitimately don't carry one).
const CRITIC_NEUTRAL = 80;
const CRITIC_MAX_SWING = 6;

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
  const crit = criticScore(omdbEntry);
  if (crit != null) {
    score += Math.max(-CRITIC_MAX_SWING, Math.min(CRITIC_MAX_SWING,
      (crit - CRITIC_NEUTRAL) / 20 * CRITIC_MAX_SWING));
  }
  const awd = awardsScore(omdbEntry);
  if (awd != null) {
    score += (awd / 100) * AWARDS_MAX;
  }
  score += imdbVoteCountBonus(omdbEntry?.imdbVotes);
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

// Bill: "it keeps showing me old TV shows and I dont like them. Build in
// a very strong bias towards new TV shows; I should almost never see a
// strong recommendation for a tv show that debuted before 2000; do not
// touch the engine for movies." Movies are untouched by this change —
// recencyBonusMovie() and MOVIE_MIN_YEAR above are exactly as they were.
//
// The old curve was nearly flat (max +3, floors at 0 — an old show got
// no bonus but also no penalty at all), so a show could reach a high
// score purely on creator/genre/similar-title signal with zero recency
// headwind. Verified live before this fix: 10 pre-2000 shows sitting in
// the real candidate/watchlist pool scored 72-80 (Miami Vice 80, NYPD
// Blue 78, Star Trek 75, The Practice 77) — comfortably "strong
// recommendation" territory (this dashboard treats predicted>=70 as a
// genuine match, see "Best Matches"). That's the exact complaint.
//
// The pre-2000 cutoff uses an absolute year check (year < 2000, matching
// Bill's literal words and MOVIE_MIN_YEAR's own absolute-year style)
// rather than an age-relative one, so it doesn't quietly drift as future
// sessions run this in later calendar years. The other bands stay
// age-relative (a "new show" bonus should always mean "new right now").
// -30 is a severe, deliberately un-subtle penalty: re-running the same
// live check with this curve pulls every one of those 10 shows to 42-55
// — none clear the 70 "strong" bar, "almost never" rather than "never"
// (an exceptional multi-signal match could theoretically still climb
// back over 70, which matches "almost never" rather than a hard
// candidate-pool exclusion like isPreMillenniumMovie — Bill's own
// phrasing here is softer than the movie ask's "nothing before 2000",
// so this is a steep scoring penalty, not a hard filter).
function recencyBonusShow(year, nowYear) {
  if (!year) return 0;
  if (year < 2000) return -30;
  const age = nowYear - year;
  if (age <= 3) return 15;
  if (age <= 6) return 8;
  if (age <= 10) return 3;
  if (age <= 15) return -6;
  return -14; // 2000s shows: well short of "new," short of the pre-2000 tier
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
  // Check ALL of the candidate's own creators/co-creators, not just TMDB's
  // index-0 name — a show co-created by [X, Y] should score the same
  // whether Bill loved X's or Y's other work, regardless of which name
  // TMDB happens to list first on THIS candidate.
  // Scoring stays keyed on the single primary creator TMDB lists first
  // (matches the original, eval.js-validated behavior) — swept expanding
  // this to "any of the candidate's co-creators" and it measurably hurt
  // precision@25 (92%->88%), since a candidate with several listed
  // co-creators becomes more likely to spuriously match SOME loved name by
  // sheer chance even when its actual primary identity doesn't. The real,
  // validated fix is on the INDEXING side below: crediting every co-creator
  // of a title Bill actually loved, not just TMDB's index-0 name for that
  // loved title — see buildIndexes()'s lovedCreators/creatorRatingWeight
  // loop, now populated via getCreators() (plural).
  const creator = getCreator(candidate.type, meta);
  if (creator) {
    score += Math.min(10, (idx.lovedCreators.get(creator) || 0) * 6);
    score += Math.min(5, (idx.creatorRatingWeight.get(creator) || 0) * 1.5);
  }

  const llmEntry = idx.llmTags?.[candidate.titleKey];
  const reviewedEntry = idx.reviewedTags?.[candidate.titleKey];
  score += genreBonus(inferGenre(meta, llmEntry, reviewedEntry), idx.lovedGenres);
  score += dismissAdjust(candidate, meta, creator, idx);
  score += franchiseBonus(meta?.belongsToCollection?.id, idx.lovedCollections);
  score += castBonus(meta?.topCast, idx.lovedActors);
  score += keywordBonus(meta?.keywords, idx.lovedKeywords);
  score += subgenreBonus(inferSubgenres(meta, llmEntry, undefined, reviewedEntry), idx.lovedSubgenres);
  score += subjectBonus(inferSubjects(meta, llmEntry, undefined, reviewedEntry), idx.lovedSubjects);
  score += toneSignal(inferTones(meta, llmEntry, undefined, reviewedEntry), idx.toneProfile, idx.globalMeanRating);

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

// External metadata-plan Priority 4: reasons stay full, human-readable
// prose (Bill has consistently praised this — e.g. "Ransom Canyon —
// Similar to 1883 and Yellowstone, which you loved" — and the plan's own
// success criterion says "the reason field remains human-readable"), but
// every branch now also prepends a short, stable, machine-parseable tag
// naming the strongest signal — the plan's actual ask ("analyze
// recommendation quality," "compare explanations," "measure which signals
// are effective"). Every reason is now groupable by the text before its
// first ' — ', with no change to the underlying priority order (the first
// matching branch already IS the strongest available signal — reason()
// was always checked in priority order, this doesn't change that, only
// labels it explicitly).
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
      const franchiseName = meta.belongsToCollection.name.replace(/ Collection$/, '');
      return `Franchise Match — You loved ${names.join(' and ')} — this is another entry in the same ${franchiseName} franchise.`;
    }
  }

  const creator = getCreator(candidate.type, meta);
  const creatorLabel = candidate.type === 'movie' ? 'director' : 'creator';
  const creatorCount = creator ? (idx.lovedCreators.get(creator) || 0) : 0;
  if (creatorCount > 0) {
    return `Creator Match — You've loved ${creatorCount} title${creatorCount > 1 ? 's' : ''} from ${creatorLabel} ${creator} before.`;
  }

  // Checked after creator match, before the general similar-title
  // network — a real actor you've loved before, but a smaller signal
  // than a director/creator match (see castBonus()'s own reasoning).
  const lovedCastMember = (meta.topCast || []).find(actor => idx.lovedActors.get(actor) > 0);
  if (lovedCastMember) {
    const count = idx.lovedActors.get(lovedCastMember);
    return `Cast Affinity — You've loved ${count} title${count > 1 ? 's' : ''} with ${lovedCastMember} before.`;
  }

  const citedIds = new Set([...(meta.similarToIds || []), ...(meta.recommendedIds || [])]
    .map(id => titleKey(candidate.type, id)));
  const matchedLoved = [...citedIds].filter(id => idx.lovedTitles.has(id));
  if (matchedLoved.length) {
    // Prefer substantial (real-voteCount) matches over TMDB's thin/noisy
    // filler citations — same fix and rationale as resolveSimilarTitles()
    // above; picking the raw first-2-in-citation-order previously let a
    // near-zero-vote title win the displayed name over a real match.
    const names = matchedLoved
      .map(k => ({ title: idx.watched.get(k)?.title, voteCount: enrichedMeta[k]?.voteCount ?? 0 }))
      .filter(n => n.title)
      .sort((a, b) => b.voteCount - a.voteCount)
      .slice(0, 2)
      .map(n => n.title);
    if (names.length) return `Similar Title — Similar to ${names.join(' and ')}, which you loved.`;
  }

  const reverseCount = idx.reverseSimilar.get(candidate.titleKey) || 0;
  if (reverseCount > 0) {
    return `Similar Title — Titles you loved list this as similar or recommended (${reverseCount} time${reverseCount > 1 ? 's' : ''}).`;
  }

  const llmEntry = idx.llmTags?.[candidate.titleKey];
  const reviewedEntry = idx.reviewedTags?.[candidate.titleKey];
  const candidateGenre = inferGenre(meta, llmEntry, reviewedEntry);
  if (candidateGenre && idx.lovedGenres.has(candidateGenre)) {
    return `Genre Match — Fits your taste for ${candidateGenre}.`;
  }

  // New (external metadata-plan review): toneSignal()/subjectBonus() are
  // real, live scoring signals in baseSignals() but were never explained
  // here — a real gap, not by design. Subject Match mirrors Genre Match's
  // shape exactly (filtered to subjects Bill's own loved titles carry).
  // Tone Match requires a real *positive* preference, not just presence —
  // idx.toneProfile[tone] is the average rating of Bill's rated titles
  // carrying that tone; only a tone rated above his global mean is a
  // reason to recommend, not merely a tone that happens to match.
  const topSubjects = inferSubjects(meta, llmEntry, undefined, reviewedEntry).filter(s => idx.lovedSubjects.has(s));
  if (topSubjects.length) {
    return `Subject Match — Touches on ${topSubjects.join(' / ')}, themes you've responded well to.`;
  }

  if (idx.toneProfile && idx.globalMeanRating != null) {
    const topTone = inferTones(meta, llmEntry, undefined, reviewedEntry).find(t => (idx.toneProfile.get(t) ?? -Infinity) > idx.globalMeanRating);
    if (topTone) {
      return `Tone Match — Has a ${topTone} feel, a tone you've consistently rated above your average.`;
    }
  }

  if (meta.voteAverage != null && meta.voteAverage >= 7.5) {
    return `Community Rating — Broadly well-regarded (${meta.voteAverage.toFixed(1)}/10 on TMDB).`;
  }

  const omdbEntry = omdbMeta[candidate.titleKey];
  const crit = criticScore(omdbEntry);
  if (crit != null && crit >= CRITIC_NEUTRAL) {
    const realAud = realAudienceScore(omdbEntry);
    return realAud != null
      ? `Critically Acclaimed — Well-reviewed by critics (${crit}/100) and audiences (${realAud}/100).`
      : `Critically Acclaimed — Well-reviewed by critics (${crit}/100 critic score).`;
  }
  const awd = awardsScore(omdbEntry);
  if (awd) {
    return `Award Recognition — Real award recognition (${omdbEntry.awards?.raw || 'wins/nominations found'}).`;
  }

  return 'A newer or less-connected title — worth a look, lower confidence.';
}

// ── Entry point ──────────────────────────────────────────────────────────

export function rankRecommendations(library, watchlist, enrichedMeta, feedback = { interactions: [] }, omdbMeta = {}, llmTags = {}, reviewedTags = {}) {
  const idx = buildIndexes(library, enrichedMeta, feedback, llmTags, reviewedTags);

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
export function rankAll(library, watchlist, candidatePool, enrichedMeta, feedback = { interactions: [] }, omdbMeta = {}, llmTags = {}, reviewedTags = {}) {
  const idx = buildIndexes(library, enrichedMeta, feedback, llmTags, reviewedTags);
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

export function computeEvalMetrics(library, enrichedMeta, feedback, omdbMeta, llmTags = {}, reviewedTags = {}) {
  const rated = (library.titles || []).filter(t => t.myRating != null && enrichedMeta[t.titleKey]);

  const preds = [];
  for (const t of rated) {
    const looLibrary = { titles: (library.titles || []).filter(x => x.titleKey !== t.titleKey) };
    const idx = buildIndexes(looLibrary, enrichedMeta, feedback, llmTags, reviewedTags);
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
