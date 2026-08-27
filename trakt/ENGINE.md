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
  top ~26% (130 of 495 ratings are 9-10). Every creator/genre/similar-title/
  franchise/cast/keyword/subgenre index in `buildIndexes()` is built *only*
  from loved titles — the direct analog of the book engine's
  `fiveStarAuthors`/`fiveStarThemes`.
- **`ratingWeight(rating)`** — a separate, continuous -1..+1 weight used
  for the `creatorRatingWeight` index (see §3a), computed as
  `(rating - 6.5) / 3.5`, clamped. 6.5 is Bill's real neutral point
  (his rating distribution's mode/median sits at 7-8, not the scale's
  literal midpoint of 5.5) — this is *not* a linear rescale of the book
  engine's 1-5 curve, it was measured against Bill's actual distribution.
- Every candidate's score starts at a flat **base of 20** (mirrors the
  book engine's own starting point), then every signal below is added or
  subtracted, and the total is clamped to **[0, 100]**.
- **`rewatchStrength(title, meta)`** isn't a score term itself — it's a
  *multiplier* applied when a loved title's rating contributes to the
  creator/genre/similar-title/franchise/cast/keyword/subgenre indexes.
  1.0 for a title watched once; for a movie, real repeat-view count
  (`plays`); for a show, `plays / episodeCount` (floored at 1.0, so a
  loved show Bill hasn't finished yet — e.g. 18 of 30 episodes, rated
  10/10 — isn't penalized for incompleteness). **Currently a true no-op**
  against real data (0 of 168 movies have `plays > 1`; no show's ratio
  exceeds 1.0) — verified via byte-identical `eval.js` output — but starts
  contributing the moment Bill genuinely rewatches something, no code
  change needed.

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
Tiered by how many loved titles share the genre (same shape as the book
engine's `themeBonus()`):

| Loved-title count for this genre | Bonus per genre tag |
|---|---|
| ≥ 60 | +5 |
| ≥ 35 | +4 |
| ≥ 18 | +3 |
| ≥ 6  | +2 |
| ≥ 1  | +1 |

Summed across all of a candidate's genres, capped at +8 total. TMDB uses
two different genre vocabularies for movies vs. shows ("Action" vs.
"Action & Adventure" for the same concept) — `normalizeGenre()` maps both
to one canonical form before counting, so a genre taught to Bill by a
loved *show* still credits a matching *movie* candidate.

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
min(15, 10 + (lovedEntriesInSameCollection - 1) × 3)
```
TMDB's `belongsToCollection` (movies only — no show equivalent). A single
loved entry in the same franchise already scores +10 (about as concrete a
signal as this engine has — an actual sequel/prequel to something Bill
rated a favorite); each additional loved entry in the same franchise adds
+3 more. Real examples this fires on: Creed I+II, Deadpool 1+2, Sicario 1+2.

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
+0.75 per subgenre shared with 18+ loved titles
+0.5  per subgenre shared with 10-17 loved titles
+0.25 per subgenre shared with 4-9 loved titles
+0.1  per subgenre shared with 1-3 loved titles
```
`inferSubgenres()` is a deterministic, keyword-driven classifier sitting
beneath TMDB's blunt ~19-27 genre taxonomy (Drama alone covers ~69% of the
dataset) — see §6 for the full tag list. Not persisted anywhere; computed
live from each title's real TMDB keywords. Cap swept against `eval.js`
the same way as keywords: a cap scaled straight from `genreBonus()`'s own
thresholds regressed precision@50, so it was halved twice to 1.5, which
instead improved precision@10 90%→100% with every other metric held.

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

## 6. Subgenres and tones — the taxonomy beneath TMDB's genres

`inferSubgenres()`/`inferTones()` are deterministic keyword classifiers,
**not persisted** to any data file (computed live, unlike the book side's
hand-edited, persisted theme/tone arrays) — a value returned here can only
ever be a literal key of `SUBGENRE_KEYWORDS`/`TONE_KEYWORDS`, so
vocabulary drift has no code path to occur through. Three-tier fallback:
(1) TMDB keyword match, (2) — tones only — a regex scan of the overview
text for mood/craft phrases, (3) a per-title LLM tag cache
(`trakt/data/llmTags.json`) when both free tiers come back empty.

21 subgenre tags (`crime-drama`, `procedural`, `legal`, `heist`,
`spy-espionage`, `psychological-thriller`, `biopic`, `historical`, `war`,
`political`, `family-drama`, `coming-of-age`, `romance`, `romcom`,
`workplace-comedy`, `dark-comedy`, `superhero`, `sci-fi-fantasy`,
`sports`, `medical`, `prison`, `horror`, `musical`) and 14 tone tags
(`gritty`, `dark`, `witty`, `satirical`, `hilarious`, `inspirational`,
`intense`, `suspenseful`, `twisty`, `slow-burn`, `character-driven`,
`nostalgic`, `melancholy`, `offbeat`, `thoughtful`). Every keyword in both
lists was verified present at real, non-trivial frequency in the live
dataset before inclusion — several plausible-looking keywords were tested
and *rejected* for producing real false positives (documented inline in
`engine.js`, e.g. `based on comic` wrongly flagged the historical war
epic "300" as a superhero film).

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
| Dismissal (creator) | -15 flat | `creator_dislike` reason code |
| Dismissal (style) | 0 to -10 | `style_dislike`, needs 2+ dismissals |
| Franchise/collection | +0 to +15 | Movies only |
| Cast match | +0 to +8 | Top-billed actors |
| Keyword match | +0 to +1.5 | Free-form TMDB keywords |
| Subgenre match | +0 to +1.5 | Beneath TMDB's genre taxonomy |
| Tone signal | -3 to +3 | Real per-tone rating-preference delta |
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
