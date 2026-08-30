# BMTRE — How the Recommendation Engine Works

BMTRE (Bill's Movies & TV Recommendation Engine) is the scoring engine behind
`trakt/`'s recommendations — the "You'll Love" panels, the All Titles table's
Predicted Score column, and `trakt/recommend.html`. All of it lives in
`trakt/engine.js`, a pure-function module with no Node-specific imports (so
`trakt/dashboard.js` can import it directly into the browser).

This file documents *every* signal that feeds a score, its exact weight/cap,
and — where it matters — why that number is what it is. Every weight below
was either measured against a real data distribution or validated (and often
tuned) against `trakt/scripts/eval.js`, BMTRE's leave-one-out precision@k/MAE
harness, never guessed. Where a signal is built but not currently contributing
(e.g. `showAiringBonus`), that's called out explicitly — it's real, tested,
inert-by-measurement code, not a bug.

If you're changing a weight here, re-run `node trakt/scripts/eval.js` before
and after. This project's standing rule (mirrored from the book side's
CLAUDE.md): **precision@10 and precision@25 outrank MAE — never trade
top-of-list accuracy away for a lower raw error number.**

---

## 1. The pipeline, end to end

```
buildIndexes(library, enrichedMetadata, feedback, llmTags)
        │
        │  scans Bill's real watched/rated history + OMDb/scraper data
        │  and builds every lookup table matchScore() needs (loved
        │  creators, loved genres, tone-preference deltas, dismissal
        │  profiles, etc.)
        ▼
matchScore(candidate, idx, enrichedMetadata, omdbMeta)
        │
        │  candidate.type routes to matchScoreMovie/matchScoreShow, both
        │  of which just call baseSignals() and clamp the result to 0-100
        ▼
baseSignals(candidate, idx, meta, omdbEntry)
        │
        │  starts at 20 and adds/subtracts every signal in §3 below
        ▼
   final score (0-100), plus reason(...) (a plain-English explanation)
   and confidenceScore(...) (a separate "how much data do we actually
   have" tiebreaker — never affects rank on its own)
```

Two entry points wrap this for real UI consumers:

- **`rankRecommendations(library, watchlist, ...)`** — scores the watchlist
  only, sorted by score then confidence. Used by `recommend.html`.
- **`rankAll(library, watchlist, candidatePool, ...)`** — scores the
  watchlist *and* the discovered candidate pool as two separate ranked
  lists (`fromWatchlist` / `fromCandidates`), so the dashboard can show
  "top picks from what you already queued" alongside "top new discoveries."
  This is where the hard candidate filters in §5 apply.

Everything above runs against `idx`, which is rebuilt once per ranking
pass from Bill's real rated history — not persisted, not cached across
calls. A title's own rating never leaks into its own signal, either:
`computeEvalMetrics()` (§7) rebuilds `idx` with that one title held out
before scoring it, the same leave-one-out discipline the book engine's
`scripts/eval.js` uses.

---

## 2. What "loved" means, and the base score

- **`LOVED_THRESHOLD = 9`** — a rated title counts as "loved" at
  `myRating >= 9` (Trakt's native 1-10 scale). This is roughly Bill's real
  top ~26% (130 of 495 ratings are 9-10). `lovedTitles` (a Set),
  `lovedCreators`, and `lovedCountByType` stay gated strictly to this
  threshold — `lovedTitles` because `buildDescModel()` and `reason()`'s
  "you loved X" display text need a Set of definitively-loved titles, not
  a fuzzy weighted one; `lovedCreators` because `creatorRatingWeight`
  already covers creator-matching continuously (see below); `lovedCountByType`
  because `matchPointScale` (§3k) is about raw loved-pool size, not
  weighted taste strength.
- **`ratingWeight(rating)`** — a continuous -1..+1 weight, computed as
  `(rating - 6.5) / 3.5`, clamped. 6.5 is Bill's real neutral point (his
  rating distribution's mode/median sits at 7-8, not the scale's literal
  midpoint of 5.5) — this is *not* a linear rescale of the book engine's
  1-5 curve, it was measured against Bill's actual distribution.
- **`idx.titleAffinity`** (a Map, titleKey -> weight) — the
  liked-not-loved-signal-gap fix (dashboard Improvement Opportunities,
  implemented): `Math.max(0, ratingWeight(rating)) * rewatchStrength()`
  for *every* rated title, not just loved ones. A rating of 6 or below
  still contributes exactly 0 (unchanged from the old >=9 gate's excluded
  set); 7-10 now contribute a real, graded amount instead of an
  all-or-nothing cutoff (7=>0.14, 8=>0.43, 9=>0.71, 10=>1.0). This is the
  weight now used to build `lovedGenres`, `lovedSubgenres`,
  `lovedKeywords`, `lovedActors`, `lovedCollections`, `lovedSubjects`,
  `reverseSimilar`, and the forward-match sum in §3i — every index the
  original `creatorRatingWeight` precedent (below) hadn't yet been
  extended to. Measured via `scripts/eval.js`: precision@10 unchanged
  (100%), @25 92%->96%, @50 92%->94%, @100 90%->89% (noise) — a real gain
  on the metrics this project's own priority ordering cares about most.
- **`creatorRatingWeight`** — the original continuous-weight index (uses
  `ratingWeight()` directly, no `rewatchStrength()` multiplier), the
  precedent `titleAffinity` above generalized to six more indexes.
- Every candidate's score starts at a flat **base of 20** (mirrors the
  book engine's own starting point), then every signal below is added or
  subtracted, and the total is clamped to **[0, 100]**.
- **`rewatchStrength(title, meta)`** isn't a score term itself — it's a
  *multiplier* folded into `titleAffinity`/`creatorRatingWeight`'s per-title
  contribution above. 1.0 for a title watched once; for a movie, real
  repeat-view count (`plays`); for a show, `plays / episodeCount` (floored
  at 1.0, so a loved show Bill hasn't finished yet — e.g. 18 of 30
  episodes, rated 10/10 — isn't penalized for incompleteness).
  **Currently a true no-op** against real data (0 of 168 movies have
  `plays > 1`; no show's ratio exceeds 1.0) — verified via byte-identical
  `eval.js` output — but starts contributing the moment Bill genuinely
  rewatches something, no code change needed.

---

## 3. Every scoring signal, in the order `baseSignals()` applies them

### 3a. Director/creator match — up to **+15**
```
+ min(10, lovedCreators[creator] × 6)          // up to +10
+ min(5,  creatorRatingWeight[creator] × 1.5)  // up to +5
```
`getCreator()` is a movie's director or a show's `createdBy[0]` — the
closest 1:1 analog to a book's author. `lovedCreators` counts loved titles
by that creator (rewatch-weighted); `creatorRatingWeight` sums the
continuous `ratingWeight()` across *every* rated title by that creator
(so a creator with one 10/10 and one 3/10 nets a smaller bonus than one
with two 10/10s, not just "2 titles either way").

### 3b. Genre match — capped at **+8**
As of the Genre/Subgenre taxonomy redesign, Genre is a **single, clean
value** per title (`inferGenre()`), not TMDB's old raw multi-valued
`genres` array — so `genreBonus()` is a flat tier lookup on one value,
not a sum across several tags (same shape as the book engine's
`themeBonus()`, but single-valued instead of summed):

| Loved-title count for this genre | Bonus |
|---|---|
| ≥ 30 | +8 |
| ≥ 20 | +6 |
| ≥ 10 | +4 |
| ≥ 4  | +2 |
| ≥ 1  | +1 |

Thresholds re-derived empirically against `scripts/eval.js` after the
redesign (an +8-ceiling tier beat a +5-ceiling tier on every metric, not
assumed). `inferGenre()` itself is a 3-tier fallback: a
`trakt/data/reviewedTags.json` curated override (workbook-seeded, checked
first) → a `trakt/data/llmTags.json` per-title LLM tag → a deterministic
classifier for everything else — TMDB's own genre-priority order
(`GENRE_PRIORITY`, e.g. Horror/Western beat the near-universal Drama)
plus a small keyword-override tier (TMDB has no "biography"/"sports"
genre of its own, so those get caught by real overview/keyword phrases
first). `normalizeGenre()` still collapses TMDB's two movie/show genre
vocabularies ("Action" vs. "Action & Adventure") onto one canonical form
before either the classifier or `lovedGenres` ever see them, so a genre
taught to Bill by a loved *show* still credits a matching *movie*
candidate. See §6 for why Genre and Subgenre are now two separate,
differently-grained fields instead of Subgenre alone trying to do both
jobs.

### 3b-2. Genre rating-preference penalty — clamped to **-3 to 0**
```
if (genreMean - globalMeanRating) > -0.5: 0
else: max(-3, (genreMean - globalMeanRating) × 4)
```
`genreBonus()` above only ever rewards a genre Bill has watched a lot of
(a loved-*count* tier) — it has no path to penalize a genre he's actually
rated poorly. `genreSignal()` closes that gap: a real per-genre mean-rating
map (`idx.genreProfile`, same ≥3-rated-title trust floor as `toneProfile`)
compared against Bill's global mean, generalizing §3h's tone-preference-
delta shape one layer up to genre. Two departures from a direct tone-signal
port, both required by real `scripts/eval.js` regressions, not chosen
up front:
- **Asymmetric — capped at 0 on the positive side, never adds.**
  `genreBonus()` already rewards a loved genre by count; a *second*,
  positive rating-derived credit on top of it pushed already-near-100
  candidates past the 100-point score clamp, displacing genuinely better
  matches (precision@25 96%→92% in the eval sweep with a symmetric ±3
  version, at every tested scale/cap — a clamp-saturation artifact, not
  a real disagreement about liked genres).
- **A -0.5 deadzone.** Penalizing every negative delta, however small,
  still reshuffled the tied-at-the-100-clamp bucket: mild negatives like
  action (-0.18, n=29) or science-fiction (-0.37, n=43) are noise-level,
  but knocking a couple of personally-loved candidates a few points below
  100 changed which *other* already-maxed candidates the confidence-score
  tiebreak surfaced in the visible top 25 — same regression, different
  cause. Gating on -0.5 leaves noise-level negatives untouched and applies
  real weight only to genres rated sizably below Bill's own average.

Real measured deltas (globalMeanRating ≈ 7.83): horror 6.37 (-1.47, full
-3.0 penalty), biography 7.13 (-0.70, -2.8), mystery 7.30 (-0.53, -2.1);
action (-0.18) and science-fiction (-0.37) fall inside the deadzone and
score 0. Verified via `scripts/eval.js`: precision@10/25/50 held exactly
at baseline (90/96/92) with genreSignal active, precision@100 improved
88→89, MAE within noise (14.30→14.39) — and via isolated per-candidate
comparison (signal on vs. off, same candidates): every live horror
candidate takes exactly the full -3.0 cap.

### 3c. Dismissal generalization — **-15 (creator) or up to -10 (style)**
A dismissal shouldn't only remove one exact title. Two reason codes carry
generalizable meaning:
- **`creator_dislike`** → flat **-15** to any future candidate from that
  same creator, regardless of genre.
- **`style_dislike`** → **-3 per overlapping genre/subgenre** with the
  dismissed titles' own profile, capped at **-10**, and only activates
  once **2+ real style dismissals** exist (so one one-off dismissal can't
  swing a whole genre bucket).

As of this writing, real dismissal data (18 recorded interactions) uses
neither code — this mechanism is dormant, not broken. `too_urban` looked
like a candidate for a style-dislike generalization but was deliberately
kept as an exact-title-only exclusion: Crime/Drama are Bill's #1/#2 loved
genres, and a genre-shaped penalty there would misfire against real matches.

### 3d. Franchise/collection match — capped at **+15**
```
min(15, 10 × min(1, totalWeight) + max(0, totalWeight - 1) × 3)
  where totalWeight = sum of titleAffinity across every rated entry
  Bill has in the same collection (§2)
```
TMDB's `belongsToCollection` (movies only — no show equivalent). Generalized
from an integer-count formula to a continuous-weight-sum one (the
liked-not-loved-signal-gap fix) — identical output to the old formula
whenever every entry's weight is 1 (a loved, non-rewatched entry, still
the typical case): one loved entry scores +10, two score +13, etc. A
liked-only (7-8 rated) sibling now contributes real partial credit (e.g.
one 8-rated entry: `10 × 0.43 ≈ +4.3`) instead of nothing. `reason()`'s
"Franchise Match" text still only *names* a sibling `idx.lovedTitles`
considers definitively loved (>=9) — a liked-only sibling can move the
score without being called "loved" in the explanation. Real examples this
fires on: Creed I+II, Deadpool 1+2, Sicario 1+2.

### 3e. Cast match — capped at **+8**
```
+3 per top-billed actor with 3+ loved-title appearances
+2 per top-billed actor with 1-2 loved-title appearances
```
Deliberately smaller than the creator-match ceiling — an actor is less
determinative of a title's identity than its director (someone appears in
many unrelated projects; a director's stamp is much stronger).

### 3f. Keyword match — capped at **+1.5**
```
+0.75 per keyword shared with 8+ loved titles
+0.5  per keyword shared with 3-7 loved titles
+0.25 per keyword shared with 1-2 loved titles
```
TMDB's free-form `keywords` field, filtered through a stoplist of
structural (non-taste) tags (`sequel`, `aftercreditsstinger`, `remake`,
`reboot`, etc. — see `KEYWORD_STOPLIST`). This cap was swept against
`eval.js`: an initial cap of 4 improved MAE but dropped precision@10
90%→80% — a regression this project's rules forbid — so it was halved to
1.5, which holds precision@10/25/50/100 exactly unchanged while still
improving MAE.

### 3g. Subgenre match — capped at **+1.5**
```
+0.75 per subgenre shared with 13+ loved titles
+0.5  per subgenre shared with 7-12 loved titles
+0.25 per subgenre shared with 3-6 loved titles
+0.1  per subgenre shared with 1-2 loved titles
```
`inferSubgenres()` is a deterministic, keyword-driven classifier sitting
beneath the (now separate, see §3b) Genre field — see §6 for the full,
post-taxonomy-redesign tag list and vocabulary design. A 3-tier fallback:
a `trakt/data/reviewedTags.json` curated override (workbook-seeded,
checked first) → the keyword tier (computed live from each title's real
TMDB keywords, no persistence) → a `trakt/data/llmTags.json` per-title LLM
tag as a last resort. Cap swept against `eval.js` the same way as
keywords: a cap scaled straight from `genreBonus()`'s own thresholds
regressed precision@50, so it was halved twice to 1.5, which instead
improved precision@10 90%→100% with every other metric held. Thresholds
re-swept again after the taxonomy redesign (the 65-bucket canonical
vocabulary spreads loved-title counts more thinly per bucket than the old
29-bucket list did) — precision held flat across every configuration
tried, confirming the small remaining movement (a slight precision@50 dip
from the redesign itself) traces to real, defensible content-matching
changes rather than a tunable threshold artifact.

### 3h. Tone signal — clamped to **±3**
```
Σ over candidate's tones of (tonePreferenceMean - globalMeanRating) × 4
```
A genuine per-tone rating-*preference delta*, not a loved-count tier —
the same shape as the book engine's `toneSignal()`/`buildToneProfile()`.
For each tone Bill's real rated titles carry, this computes his actual
mean rating on titles with that tone vs. his global mean rating; a tone
only counts once **3+ rated titles** carry it (so one outlier rating can't
swing a tone to a meaningless extreme). Real measured deltas: witty +0.36,
inspirational +0.66, gritty -0.30, melancholy +0.70. The ×4 multiplier was
swept from 1.5 to 15 against `eval.js` — results plateau from ~5 upward
(the ±3 clamp saturates), so 4 was kept deliberately short of that ceiling.

### 3i. Forward similar-title match — capped at **+24**
```
min(24, forwardMatches × 8 × matchPointScale)
```
If this candidate's own `similarToIds`/`recommendedIds` (from TMDB's
`/similar` and `/recommendations` endpoints) includes a title Bill loved,
that's a forward match. `matchPointScale` (see §3k) compensates for the
movie/show loved-pool size imbalance.

### 3j. Reverse similar-title match — capped at **+12**
```
min(12, reverseSimilarCount × 6 × matchPointScale)
```
The mirror signal: a loved title's own `similarToIds`/`recommendedIds`
cites *this* candidate. Unlike the book engine (gated to to-read-shelf
titles only, since hand-curated `similarToTitles` coverage was sparse),
this applies unconditionally — TMDB's similar/recommendations network is
comprehensive, not scarce hand-curated data.

### 3k. `matchPointScale` — the movie/show pool-size compensation
Bill has roughly half as many loved movies as loved shows (measured: 50
vs. 99). Since TMDB's similar/recommendations network never crosses
movie/show, a movie candidate can only ever be compared against the
smaller loved-movie pool — needing roughly 2x the "hit rate" to earn the
same credit a show gets purely from pool size, not from being a worse
match. `matchPointScale(type, lovedCountByType)` returns
`max(lovedCount) / thisTypeLovedCount` — 1.0 for the larger pool
(unchanged), a measured multiplier (not a guessed "movies score too low"
fudge) for the smaller one. Revisit if the loved counts shift substantially.

### 3l. Community rating (TMDB) — uncapped, but bounded by TMDB's own 0-10 scale
```
(voteAverage - 6.0) × 8
```
`COMMUNITY_NEUTRAL = 6.0` is TMDB's real typical rating for popular
titles. TMDB-only in Phase 1 — no multi-source bias offset yet (the book
engine only added a second-source offset, `AMAZON_BIAS_OFFSET`, after its
Goodreads-only signal had matured; same sequencing planned here).

### 3m. Vote count (TMDB "how many people rated this") — capped at **+4**
```
≥5,000 votes → +4   ≥1,000 → +3   ≥200 → +2   ≥50 → +1   else 0
```

### 3n. IMDb vote count — a second, independent "how many ratings" signal
```
≥400,000 votes → +3    ≥150,000 → +2.25    ≥40,000 → +1.5    ≥10,000 → +0.75    else 0
```
From OMDb's `imdbVotes` (folded into `omdbSignal()`, see §3q). IMDb's
voter base runs roughly 15-25x larger than TMDB's `voteCount` at
equivalent percentiles in this dataset (real measured distribution: min 7,
p10 1,725, p25 10,423, median 46,933, p75 163,999, p90 410,756, p99
1,148,210, max 2,606,100) — the tiers above are re-derived from *these*
percentiles, not reused from `voteCountBonus`'s TMDB-scale thresholds.
The magnitude was swept 0.5x-2x against `eval.js`: the "obvious" 1x scale
(4/3/2/1) improved precision@10 but cost one title off precision@50; 0.75x
(shown above) was the smallest scale that kept the full precision@10 gain
with zero regression anywhere else.

### 3o. Recency — movies **+8 to -15**, shows **+15 to -30**
Bill's explicit request: "strongly favor movies from the last 5-10 years,
nothing before 2000."

**Movies** (`recencyBonusMovie`, unchanged):
| Age | Bonus |
|---|---|
| ≤5 years | +8 |
| ≤10 years | +6 |
| ≤15 years | +1 |
| ≤20 years | -4 |
| ≤26 years | -9 |
| older (pre-2000-adjacent) | -15 |

**Shows** (`recencyBonusShow`) — originally a much gentler curve (max +3,
floors at 0, no penalty at all for an old show). Revised after a second,
separate Bill request: "it keeps showing me old TV shows and I dont like
them. Build in a very strong bias towards new TV shows; I should almost
never see a strong recommendation for a tv show that debuted before
2000; do not touch the engine for movies." Verified live before the fix:
10 real pre-2000 shows in the pool scored 72-80 (Miami Vice 80, NYPD
Blue 78) purely on creator/genre/similar-title signal, since recency
contributed nothing either way:
| Year / Age | Bonus |
|---|---|
| < 2000 (absolute year, not age-relative) | **-30** |
| age ≤3 years | +15 |
| age ≤6 years | +8 |
| age ≤10 years | +3 |
| age ≤15 years | -6 |
| older (2000s, not yet pre-2000) | -14 |

The pre-2000 tier is an absolute year check (`year < 2000`), not age-
relative like the rest of the curve — matches Bill's literal words and
`MOVIE_MIN_YEAR`'s own style, and doesn't quietly drift as later
sessions run this in future calendar years. Deliberately a steep scoring
penalty, not a hard candidate-pool filter like movies get (§5) — Bill's
phrasing ("almost never," not "nothing before 2000") leaves room for an
exceptional multi-signal match to still climb back over the "strong"
(≥70) bar, verified live: post-fix, every pre-2000 show in the pool caps
at 50, none reach 70. Movies before 2000 are also **hard-excluded** from
discovered candidates entirely (§5) — the steep negative tail above is
belt-and-suspenders for watchlist movies, which are never hard-excluded
(Bill's own explicit picks stay rankable, just honestly low). Shows have
no equivalent hard filter, matching the softer ask.

### 3p. Show-airing-status bonus — **currently 0 (built, tested, not applied)**
```
showAiringOverrep × SHOW_AIRING_SCALE   // SHOW_AIRING_SCALE = 0
```
A weighted signal for "this show is still airing new episodes" —
`showAiringOverrep` is a real, computed index (loved shows air 32.3% of
the time vs. 25.1% for the general rated pool). A sweep of
`SHOW_AIRING_SCALE` from 0 to 50 against `eval.js` found **no** value that
improves precision@10 over baseline (it drops to 90% at the very first
nonzero value and keeps falling), even though MAE improves the whole way
— exactly the trade this project's rules forbid. Left at scale 0
(computed but inert) rather than removed, so it's ready the moment either
the signal shape changes or more rated-show volume exists.

### 3q. `omdbSignal()` — OMDb/scraper-sourced signals, combined
Three sub-signals, summed:

1. **Critic score swing, clamped to ±6**:
   ```
   clamp((criticScore - 80) / 20 × 6, -6, +6)
   ```
   `criticScore()` averages RT Tomatometer + Metacritic Metascore (only
   the professional-critic aggregate — see §4 for the audience-opinion
   counterpart, which is *not* wired into scoring). `CRITIC_NEUTRAL = 80`
   is this dataset's real median among titles with any critic score
   (mean 76.1) — Bill's pool skews toward well-regarded titles. Missing
   critic data contributes nothing (not a penalty).
2. **Awards, scaled to 0-+4**: `(awardsScore / 100) × 4`. `awardsScore()`
   itself weights Oscar wins ×40, Oscar noms ×15, Emmy wins ×20, Emmy
   noms ×8, other wins ×2, other noms ×1, clamped 0-100. Scaled down
   from that raw 0-100 range because the real distribution is heavily
   right-skewed (many legitimate 0s, but p75+ saturates at 100) — full
   weight would collapse "won something" and "won everything" into the
   same signal strength.
3. **IMDb vote count** — §3n above.

### 3r. `descSimilarityBonus()` — plot/description similarity — capped at **+3**
A direct port of the book engine's `descSimilarity.js` (same TF-IDF
tokenizer/vector/cosine-similarity math, `trakt/descSimilarity.js`),
adapted to BMTRE's additive-bonus scoring shape instead of the book
engine's Bayesian `rateEngine.js` ensemble — BMTRE has no
`predictRating()`-style blend to plug a k-NN mean-rating signal into, so
this returns a capped bonus the same way `keywordBonus()`/
`subgenreBonus()` do, not a rating prediction. `buildIndexes()` builds one
TF-IDF model per ranking pass from every loved title's real TMDB
`overview` text (coverage-gated at `MIN_LOVED_DOCS=100`; real coverage is
159 loved titles, all with a usable overview). Each candidate's own
overview is scored via cosine similarity against its top-10 nearest loved
neighbors (`minSim=0.03`); the bonus is `min(3, simMass × 4)`. Cap swept
1→2→3 against `scripts/eval.js` (each step measurably improved
precision@100/MAE with p10/p25/p50 held, plateauing at 3 since real
`simMass` values never exceed it); `k` swept 5-20 (15+ traded precision@50
for a better MAE, the tradeoff this project forbids, so `k=10` held).
`reason()` gained a "Reads Like" explanation tier naming the specific
matched loved title, checked after genre/subject/tone but before the
generic community-rating fallback.

---

## 4. Real but display-only (not wired into `matchScore()`)

These are computed and shown to Bill (rec-card text, the All Titles
table, CSV export) but deliberately don't affect ranking yet — each would
need the same `eval.js`-validated tuning pass every scoring signal above
went through, and hasn't gotten one:

- **`realAudienceScore()`** — RT Popcornmeter + Metacritic user score, the
  genuine *viewer*-opinion counterpart to the critic aggregate in §3q.
  Only ever populated via `trakt/scrape_show_ratings.py` (OMDb's API never
  returns either value).
- **`resolveSimilarTitles()` / `resolveSimilarDirectors()`** — human-
  readable names resolved from `similarToIds`/`recommendedIds`, and
  directors corroborated by 2+ resolved similar titles. The book engine's
  `similarToTitles`/`similarToAuthors` equivalent, audit/display only.
- **`popularityScore()` / `imdbPopularityScore()`** — log-scaled 0-100
  display versions of TMDB `voteCount` / OMDb `imdbVotes`, shown on the
  All Titles table and CSV export. The underlying raw counts *do* feed
  scoring (§3m, §3n) — only the 0-100 display transform itself is unused
  by `matchScore()`.

---

## 4b. `reason()` — the explanation string, and its tag prefix

`reason(candidate, idx, enrichedMeta, omdbMeta)` returns one human-readable
sentence explaining a candidate's score — checked in the same priority
order the branches are listed here (the first branch that fires wins; that
branch's signal is, by construction, the strongest evidence available for
that candidate). As of the external metadata-improvement-plan review, every
branch's string now starts with a short, stable tag followed by ` — ` and
then the full explanatory sentence — e.g. `"Creator Match — You've loved 2
titles from creator Taylor Sheridan before."` The tag makes every reason
machine-groupable (split on the first ` — `) for analysis/debugging without
sacrificing the prose Bill has consistently preferred over a terser format.

| Priority | Tag | Fires when |
|---|---|---|
| 1 | `Franchise Match` | Candidate shares a TMDB collection with a loved title |
| 2 | `Creator Match` | Candidate's director/creator matches a loved title's |
| 3 | `Cast Affinity` | Candidate's `topCast` includes an actor from a loved title |
| 4 | `Similar Title` | Candidate cited in a loved title's `similarToIds`/`recommendedIds` (forward), or a loved title cites the candidate (reverse) |
| 5 | `Genre Match` | Candidate shares a genre with `idx.lovedGenres` |
| 6 | `Community Rating` | TMDB `voteAverage` ≥ 7.5, no stronger signal fired |
| 7 | `Critically Acclaimed` | OMDb critic score ≥ neutral, no stronger signal fired |
| 8 | `Award Recognition` | Real OMDb award wins/nominations, no stronger signal fired |
| — | *(no tag)* | Fallback: `"A newer or less-connected title — worth a look, lower confidence."` |

---

## 5. Hard candidate filters (never score adjustments — full exclusion)

Applied only in `rankAll()`'s `fromCandidates` list — **never to the
watchlist**, which is Bill's own explicit picks and is only ever ranked
honestly low, never hidden:

| Filter | What it excludes |
|---|---|
| `isPreMillenniumMovie` | Any movie released before **2000** |
| `isAnimation` | Any title carrying the TMDB "Animation" genre |
| `isReEdit` | Titles carrying TMDB's `edited from film` keyword (theatrical re-cuts of something Bill already watched under a different id) |
| `isNonEnglish` | `originalLanguage` present and not `en` (missing language defaults to *allowed*, not excluded) |
| already watched/watchlisted | A candidate whose `titleKey` is already in the library or watchlist (handles the case where Bill watches/watchlists something on Trakt directly that was also sitting in the discovered pool) |
| `idx.excluded` | Any title with an explicit `excludeFromRecommendations` feedback entry |

---

## 6. Genre, Subgenre, Tones, Subjects, Era — the taxonomy layers beneath TMDB

Bill's brief for the redesign that produced the current shape: **"I want
genre to be fairly high level and sub-genre to be very specific."** Before
this, "Genre" was TMDB's raw multi-valued `genres` field (Drama alone sat
on 75%+ of every enriched title — nominally high-level but too blunt to
discriminate at all) and "Subgenre" was a 29-bucket keyword classifier that
had drifted into doing genre's job too — roughly half its buckets
(`historical`, `war`, `political`, `sci-fi-fantasy`, `sports`, `horror`,
`biopic`, `crime-drama`, etc.) were really genre-level concepts sitting
flat in the wrong field. The fix, assessed with real cross-tab numbers
before any code changed (a hand-reviewed metadata workbook covering all
793 eligible titles at the time supplied both a clean 18-value Genre
vocabulary and a rich, if fragmented, 484-value raw Subgenre vocabulary to
build from):

- **Genre** (`inferGenre()`) is now a single, clean, high-level value per
  title — 17 canonical values (`drama`, `comedy`, `thriller`, `crime`,
  `action`, `science-fiction`, `fantasy`, `horror`, `mystery`, `war`,
  `western`, `romance`, `documentary`, `animation`, `adventure`,
  `biography`, `sports`). See §3b for its 3-tier resolution and scoring.
- **Subgenre** (`inferSubgenres()`) is now a curated, ~65-bucket canonical
  vocabulary built specifically to be *very specific* and non-redundant
  with Genre — every genre-duplicative bucket the old 29-bucket list had
  (`crime-drama`, `sci-fi-fantasy`, `war`, `sports`, `horror`, `biopic`)
  was retired, since that signal now lives in Genre itself. New buckets
  came from the workbook's real, high-frequency, genre-orthogonal values:
  `neo-noir`, `character-study`, `psychological-drama`, `ensemble`,
  `workplace-drama`, `crime-thriller`, `biography` (a title's specific
  *biopic-ness* as a secondary descriptor — distinct from Genre=biography
  as a title's *primary* classification; both can be true at once, e.g. a
  Genre=drama title can still carry Subgenre=biography), `mystery-drama`,
  `military-drama`, `dramedy`, `conspiracy-thriller`, `survival-drama`,
  `sitcom`, `satire`, `true-crime`, `anthology`, `docudrama`,
  `buddy-comedy`, `post-apocalyptic`, `psychological-horror`, `dystopian`,
  `supernatural-horror`, `friendship-comedy`, `mockumentary`,
  `family-comedy`, `journalism-drama`, `time-travel`, `crime-comedy`,
  `action-comedy`, `survival-horror`, `financial-drama`,
  `techno-thriller`, `space-opera`, `absurdist-comedy`, `social-drama`,
  `creature-feature`, `alien-invasion`, `comedy-mystery`,
  `supernatural-mystery`, `chamber-drama`, `disaster-drama`,
  `horror-comedy` — alongside the buckets retained unchanged from the old
  list (`procedural`, `legal`, `heist`, `spy-espionage`,
  `psychological-thriller`, `family-drama`, `coming-of-age`, `romcom`,
  `workplace-comedy`, `dark-comedy`, `prison`, `neo-western`,
  `organized-crime`, `drug-trade`, `assassin-hitman`, `murder-mystery`,
  `police-procedural`, `historical`, `political`, `romance`, `medical`,
  `superhero`, `musical` — confirmed via a real correlation check
  *not* genre-duplicative before being kept). Real distribution checked
  before shipping: no bucket exceeds the project's own 15%-of-dataset
  concentration cap (the same cap the book side's tone-vocabulary redesign
  established) — `family-drama`, the largest, sits at 14.1%.
- **Detail layer** (`inferSubgenreDetail()`/`GENRE_DETAIL_KEYWORDS`) —
  Bill: *"I want that level of specificity for all genres and
  subgenres"* — nests an even finer label under a subgenre when a
  confident keyword match exists (`historical` → WWII/Vietnam/Cold War
  era buckets, `organized-crime` → Mafia/Cartel, etc.). Repurposed rather
  than retired during the redesign: `sci-fi-fantasy`'s old detail groups
  (Dystopia, Post-Apocalyptic, Alien Invasion, Time Travel) graduated into
  real, independently-scored top-level Subgenre buckets since they proved
  common enough to earn their own tier; `biopic`'s detail group was
  renamed to `biography`; `supernatural-horror`/`techno-thriller` gained
  new detail groups. Display-only — never wired into `matchScore()`.
  Currently a partial pass: most subgenre categories don't have an
  obvious further split the way `historical` naturally splits into eras
  (see the dashboard's own live-computed `remaining-subgenre-genre-
  specificity` Improvement Opportunities finding for current coverage).
- **Tones** (`inferTones()`) — mood/craft descriptors (`gritty`, `dark`,
  `witty`, `satirical`, `hilarious`, `inspirational`, `intense`,
  `suspenseful`, `twisty`, `slow-burn`, `character-driven`, `nostalgic`,
  `melancholy`, `offbeat`, `thoughtful`, `atmospheric`, `fast-paced` — 17
  tags), scored via a genuine per-tone rating-preference delta, not a
  loved-count tier (§3h). The reviewed-override tier (`reviewedTags.json`)
  had drifted to 139 near-free-form values (the same fragmentation bug
  Subjects hit) before a consolidation pass remapped them onto this
  canonical set — Specificity 71%→90%, `scripts/eval.js` held or improved
  on every metric (precision@10/25/50 unchanged, @100 87%→88%, MAE
  14.48→14.30).
- **Subjects** (`inferSubjects()`) — real social/human-condition subject
  matter beneath genre/subgenre, the BBRE-themes-inspired addition.
  Honestly partial by design (~52% of titles) — not every story genuinely
  has one. `SUBJECT_KEYWORDS` (17 keyword-triggered buckets:
  `addiction-recovery`, `drug-addiction`, `grief-loss`, `suicide`,
  `terminal-illness`, `trauma-abuse`, `domestic-abuse`,
  `racism-civil-rights`, `historical-atrocities`, `immigration-refugee`,
  `infidelity`, `journalism-media`, `cult-extremism`, `mental-health`,
  `class-wealth-corporate`, `corporate-power`, `lgbtq`, `survival`) plus
  ~40 more canonical bucket names reachable only via the reviewed-override
  tier below, documented in `SUBJECT_CANONICAL_VOCABULARY`. Rebalanced
  twice to a "5-25 titles per bucket, nothing under 3" target (Bill's
  explicit ask, most recently) — see the dashboard's
  `subjects-taxonomy-consolidated` Improvement Opportunities finding for
  the live before/after numbers; several original `SUBJECT_KEYWORDS`
  buckets that had grown past 25 by combining genuinely distinct real
  themes (grief + suicide + terminal illness; trauma + domestic abuse;
  wealth/class + corporate misconduct; racism + historical atrocities)
  were split into their real keyword sub-groups.
- **Era** (`inferEra()`) — when the *story* is set, not when the title was
  made. A coarse 4-bucket keyword scheme (`ancient-to-1900`,
  `early-1900s`, `mid-late-1900s`, `future-setting`) on its own, but
  mostly resolved (99.7%) via the workbook's much richer 17-value era
  vocabulary through the same reviewed-override tier below.

**All five layers share the same reviewed-override-first priority**: every
`infer*()` function checks `trakt/data/reviewedTags.json` (the curated,
per-title override sourced from the hand-reviewed metadata workbook)
first, then its own free-tier logic (keyword match, and for tones a
regex scan of the overview text for mood/craft phrases), then
`trakt/data/llmTags.json` (a per-title Claude Haiku 4.5 tag, used only
when the free tiers come back empty) as a last resort. None of Subgenre/
Tone/Subject/Era is persisted to any data file on its own — each is
computed live from a title's real TMDB keywords/overview plus the
reviewed-override and LLM caches, so a returned value can only ever be a
literal key of its own canonical-vocabulary constant (`SUBGENRE_KEYWORDS`
/`TONE_KEYWORDS`/`SUBJECT_KEYWORDS`), closing off the vocabulary-drift
code path entirely. Genre is the one exception worth noting: its
deterministic fallback tier (TMDB genre-priority order + a small keyword-
override list) almost never returns null, unlike the other four layers'
honestly-partial keyword tiers, since Genre is meant to be a
near-universal field the way Subgenre/Subject/Era are not.

Every keyword in every vocabulary was verified present at real,
non-trivial frequency in the live dataset before inclusion — several
plausible-looking keywords were tested and *rejected* for producing real
false positives (documented inline in `engine.js`, e.g. `based on comic`
wrongly flagged the historical war epic "300" as a superhero film, and
bare decade-marker keywords wrongly flagged the 1970s-set comedy
"Anchorman" as historical).

**Drift guardrail**: `findTaxonomyCollisions()` (engine.js) is a
permanent, live check — mirroring the book side's `findNonCanonicalTones()`
— that confirms Subgenre/Tone/Subject stay at genuinely different
conceptual levels (content type vs. emotional feel vs. major theme) and
that no `GENRE_DETAIL_KEYWORDS` nested label duplicates an unrelated
top-level bucket name. It deliberately does **not** include Genre in this
check — a Subgenre bucket sharing a literal name with a Genre value (e.g.
`romance`, `biography`) is expected and intentional, not drift, since the
two fields operate at genuinely different specificity levels by design
(a title can be Genre=drama with Subgenre=romance as a secondary
descriptor, or Genre=romance itself for a pure romance film). Rendered
live on the dashboard's Improvement Opportunities list.

---

## 7. Evaluation harness — how every weight above got validated

`computeEvalMetrics()` (in `engine.js`, wrapped by the CLI in
`trakt/scripts/eval.js`) is BMTRE's yardstick, mirroring the book side's
own `eval.js` in spirit: leave-one-out precision@k and MAE over every
watched+rated+enriched title. For each rated title, it rebuilds `idx`
with that title excluded (so its own rating can't leak into its own
signal), scores it, and checks whether the predicted score actually
tracks how Bill rated it.

Reports:
- **precision@10/25/50/100** — of the top-K titles by predicted score,
  what fraction did Bill actually rate ≥8/10? **This is the metric that
  matters most** (per this project's precision-first rule) — never
  sacrifice it for a better MAE.
- **MAE** — mean absolute error between predicted (0-100) and actual
  (myRating × 10), also compared against a naive "always predict the
  mean" baseline (Bill's ratings skew high enough that this trivial
  baseline can beat a real model on MAE alone without ranking anything
  correctly — a known, documented, non-alarming pattern here).
- **Bottom-50 catch rate** — of the 50 lowest-scored titles, how many did
  Bill genuinely dislike (≤5/10)? Graded against the *real* achievable
  ceiling (`bottomPossible`), not a flat 50, since dislikes are rare in
  Bill's real distribution (~30 of 533 titles).
- **By-type breakdown** (movie vs. show), since BMTRE's own signals split
  by type (recency curves, `matchPointScale`) and a combined number could
  hide one type dragging the other.

Run it: `node trakt/scripts/eval.js` from the repo root.

---

## 8. Quick-reference: every weight and cap

| Signal | Range | Notes |
|---|---|---|
| Base score | +20 flat | Starting point before any signal |
| Creator/director match | +0 to +15 | +10 loved-count, +5 rating-weight |
| Genre match | +0 to +8 | Tiered by loved-genre count |
| Genre rating penalty | -3 to 0 | Rating-preference delta, -0.5 deadzone, penalty-only |
| Dismissal (creator) | -15 flat | `creator_dislike` reason code |
| Dismissal (style) | 0 to -10 | `style_dislike`, needs 2+ dismissals |
| Franchise/collection | +0 to +15 | Movies only |
| Cast match | +0 to +8 | Top-billed actors |
| Keyword match | +0 to +1.5 | Free-form TMDB keywords |
| Subgenre match | +0 to +1.5 | Beneath TMDB's genre taxonomy |
| Tone signal | -3 to +3 | Real per-tone rating-preference delta |
| Description similarity | +0 to +3 | TF-IDF plot-text cosine similarity to loved titles |
| Forward similar-title | +0 to +24 | Scaled by `matchPointScale` |
| Reverse similar-title | +0 to +12 | Scaled by `matchPointScale` |
| Community rating (TMDB) | unbounded* | `(voteAverage - 6.0) × 8` |
| Vote count (TMDB) | +0 to +4 | "How many ratings" #1 |
| IMDb vote count | +0 to +3 | "How many ratings" #2 |
| Recency (movie) | -15 to +8 | Steep, per Bill's explicit ask |
| Recency (show) | 0 to +3 | Gentle — shows don't age like movies |
| Show-airing bonus | 0 | Built, tested, currently inert (scale=0) |
| Critic score (OMDb) | -6 to +6 | RT/Metacritic critic aggregate |
| Awards (OMDb) | +0 to +4 | Oscar/Emmy-weighted |
| **Final score** | **clamped 0-100** | |

\* Bounded in practice by TMDB's 0-10 rating scale (roughly -48 to +32,
though real values cluster far tighter around the neutral point).

---

## 9. Where to make a change

**Standing rule (Bill's explicit instruction): this file must be updated in
the same commit as any `engine.js` change that adds, removes, or re-weights
a scoring signal or filter.** §3's weight table, §4's display-only list, §5's
filter table, and/or §8's quick-reference must all stay accurate — don't let
this drift into a stale snapshot of one point in time.

- **Adding/adjusting a weight**: change the constant in `engine.js`, then
  `node trakt/scripts/eval.js` before and after. Never ship a change that
  drops precision@10 or precision@25, even if MAE improves. Update the
  relevant §3 entry and the §8 table with the new value and the real
  before/after `eval.js` numbers, in the same commit.
- **Adding a new signal**: start it display-only (computed, shown, not
  added to `baseSignals()`) until real data exists to validate it against
  — every signal in §3 above followed this path (keyword/subgenre/tone/
  cast/franchise/IMDb-votes all shipped display-only first). Document it in
  §4 while display-only; move it to §3/§8 once wired into scoring.
- **Adding a new hard filter**: add it to `rankAll()`'s `fromCandidates`
  filter chain (§5), never to the watchlist. Add a row to §5's table.
- **Full architecture context, session history, and the BBRE (book-side)
  comparison table**: see `CLAUDE.md`'s "BMTRE" section.
