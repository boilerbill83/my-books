# Bill's Books — Claude Code Session Guide

## What This App Does

Static GitHub Pages app that recommends books from Bill's personal to-read list and a curated external candidate pool. The recommendation engine scores candidates by cross-referencing his Goodreads history (ratings, themes, similar titles).

**Live site:** https://boilerbill83.github.io/my-books/

---

## Session Start Checklist

1. **Set the remote** (PAT is stored locally outside any git repo — never commit it or reference its path in committed files):
   ```bash
   PAT=$(cat ~/.github_pat)   # adjust to wherever your PAT lives locally
   git remote set-url origin https://${PAT}@github.com/boilerbill83/my-books.git
   ```
2. **Push to main** (deploy triggers on main only):
   ```bash
   git push origin HEAD:main
   ```

---

## Project Structure

| File | Purpose |
|------|---------|
| `data/goodreadsData.json` | 939 books — all of Bill's Goodreads data |
| `data/candidatePool*.json` | External recommendation candidates (5 files, ~115 books) |
| `engine.js` | Scoring engine — buildIndexes, matchScore, confidenceScore, reason |
| `app.js` | UI + localStorage feedback persistence |
| `descSimilarity.js` | TF-IDF description signal (Session 12) |
| `data/enrichedMetadata.json` | Descriptions/categories/subjects cache (auto-filled daily) |
| `scripts/eval.js` | Honest precision@k eval — run before/after engine changes |
| `scripts/validate_review.js` | Validation gate — Session 12 review keeps must stay in top 25 |
| `scripts/audit.js`, `scripts/full_audit.js` | Manual data-quality audits (duplicates, broken similarToTitles refs, missing themes) |
| `scripts/lib/loadData.js` | Shared loader — merges goodreadsData.json + candidate pools + enrichedMetadata.json + scrapedRatings.json + feedbackData.json into one row set. Used by both export_extract.js and data_quality_report.js so their join logic can't silently drift apart (see Session 13b: the Amazon-rating join bug). |
| `scripts/export_extract.js` | Weekly full extract — writes `output/all-books-YYYY-MM-DD.csv` |
| `scripts/data_quality_report.js` | Daily data quality report — per-field table (Field Name, Percent Populated, Quality Score, How Score is Determined, Suggestions for Improvement) via `FIELD_REGISTRY`; `critical: true` fields (feed a live scoring signal) get a stricter 90% threshold (🔴) vs 80% (⚠️) for everything else. Broken similarToTitles refs are checked against the engine's real title-matching normalization (paren-stripping) and split into near-miss (fixable typo/truncation) vs orphaned (no close match); non-canonical themes used ≥5 times are flagged as canonical-vocabulary-candidates, not just errors. An "Action Items" summary leads the report, plus a trend section (diffed against the most recent prior `output/data-quality-report-*.json` snapshot). Also computes a composite Data Quality Score (0-100, `computeQualityScore` — 5 weighted components: Critical Field Health, Field Completeness, Foundational Signal Integrity, Recommendation Safety, Data Hygiene; recalibrated twice in Session 14/14b) and a ranked Top-5-Impediments list, plus a "Roadmap to 100" (`buildRoadmap`, Session 14c) — a 6-phase cumulative simulation projecting the score after each phase of fixes by re-running the real scoring formula, not hand-typed estimates. Writes `output/data-quality-report-YYYY-MM-DD.md` + `.json` |
| `output/` | Dated CSV/report snapshots from the weekly jobs (one file per run, not overwritten), plus `data-quality-index.json` (manifest of snapshot dates for quality-dashboard.html) |
| `quality-dashboard.html` | Interactive dashboard reading the data-quality-report JSON snapshots — a Data Quality Score ring gauge + component breakdown at the top, At-a-Glance stat tiles, multi-week trend charts, sortable/searchable field and impact-score tables, a tabbed integrity browser, and a Top Impediments section at the bottom. Linked from index.html's header. |
| `index.html` | Entry point |

---

## Perfect Book Entry — Quality Standard

A **perfect** book entry in `goodreadsData.json` has all of the following:

### Required fields (every book)
```json
{
  "title": "Exact title as shown on Goodreads",
  "author": "Author Name",
  "shelf": "read | to-read | currently-reading",
  "myRating": 0,
  "pages": 320,
  "avgRating": 4.12,
  "ratingsCount": 85000,
  "year": 2021
}
```

### Quality fields (must be present and correct)
```json
{
  "themes": ["thriller", "psychological", "domestic suspense"],
  "similarToTitles": ["The Silent Patient", "Behind Closed Doors", "Verity"]
}
```

### Quality rules

| Field | Rule |
|-------|------|
| `themes` | 2–5 tags; must use **canonical vocabulary only** (see below); must match the book's actual genre |
| `similarToTitles` | 3–5 entries; every title must be an **exact character-for-character match** to another book's `title` field in the dataset — the engine uses `Set.has()` for matching, so "The Firm" ≠ "The Firm (The Firm, #1)" |
| `pages` | Non-zero integer; 0 or missing means the pages-fit bonus never fires |
| `ratingsCount` | Positive integer; missing means the popularity bonus never fires |
| `myRating` | 0 (unrated) to 5; 0-star read books don't contribute to `authorRatingWeight` |
| `avgRating` | Goodreads community average; affects `(avg - 3.5) * 10` score term |

### Canonical theme vocabulary

Use **only** these values. Do not invent new tags without updating the engine's fallback constants.

**Fiction / Genre:**
`thriller`, `psychological`, `suspense`, `domestic suspense`, `mystery`, `crime`, `noir`, `horror`, `high-concept`, `spy`, `adventure`, `historical`, `YA`, `romance`, `literary`, `contemporary`, `speculative`, `sci-fi`, `social commentary`, `legal`, `courtroom`

**Nonfiction:**
`narrative nonfiction`, `memoir`, `biography`, `true crime`, `history`, `tech history`, `finance`, `business`, `sports`, `food`, `music history`, `political`, `military`, `psychology`

**Unassigned (use sparingly):**
`humor`, `comedy`

### How themes drive scoring

The engine builds a `fiveStarThemes` map from all 5-star read books. Themes are scored per-book with these thresholds:

| Count in 5★ reads | Bonus per matching theme |
|---|---|
| ≥ 40 | +5 |
| ≥ 25 | +4 |
| ≥ 12 | +3 |
| ≥ 4  | +2 |
| ≥ 1  | +1 |

Cap: +8 total per book regardless of theme count.

Current top themes (as of June 2026): `narrative nonfiction` (104), `thriller` (101), `contemporary` (38), `literary` (36), `memoir` (36), `psychological` (32), `speculative` (31), `suspense` (29), `history` (25), `sports` (25).

### How similarToTitles drives scoring

Two separate engine signals:

1. **Forward match** (candidate → 5★ read): If a to-read/candidate book's `similarToTitles` contains a title that is in the user's 5★ reads → **+8 pts per match**.

2. **Reverse index** (5★ read → candidate): If a 5★ read's `similarToTitles` contains a to-read book's title → **+6 pts per citing 5★ read, capped at +12**. This fires on the `reverseSimilar` map built in `buildIndexes`.

**Critical:** Both signals require exact title string matches. Always verify against the actual title stored in the JSON. Common pitfalls:
- Series notation: "The Firm" vs "The Firm (The Firm, #1)" — use the full title
- Subtitle truncation: "Bourdain: The Definitive Oral Biography" not "Bourdain"
- Subtitle differences: "Quiet: The Power of Introverts..." vs "Quiet Power: The Secret Strengths..."

### Canonical Tone Vocabulary (redesigned Session 16)

Use **only** these 24 values in a book's `tones` field. Unlike themes (which describe genre/subject), tones describe *how a book reads* — pacing, mood, voice, craft — so the same word can and should apply across fiction and nonfiction alike.

**Pacing & structure:** `propulsive`, `compulsive`, `slow-burn`, `twisty`, `procedural`, `nonlinear`, `ensemble`
**Mood & emotional register:** `dark`, `bleak`, `tense`, `heartwarming`, `poignant`, `inspiring`
**Voice & humor:** `funny`, `satirical`, `conversational`
**Craft & style:** `atmospheric`, `lyrical`, `gritty`, `character-driven`
**Intellectual register:** `revelatory`, `dense`, `thoughtful`, `investigative`

**Balance rule:** no tone may sit on more than 15% of the dataset (~166 of 1,111 books as of Session 16). This isn't cosmetic — `bbreEngine.js`'s `buildToneProfile()`/`toneSignal()` computes a real per-tone rating-preference delta from Bill's history and applies it live to every candidate. A tone used on a third of the dataset (as `accessible`/`narrative-driven`/`fast-paced` were under the old free-form vocabulary) can't produce a meaningful signal — it's just "most books." 2–4 tones per book, same as before.

Enforced in three places, which must be kept in sync if the vocabulary ever changes: `bbreEngine.js`'s `THEME_TONES_MAP` (theme→tone fallback for a book with no real tags) and `TONE_PRIORITY` (tie-break order), `tag_with_haiku.py`'s `TONES` constant, and `app.js`'s `TONE_FILTER_ORDER` (the live site's tone filter chips). `scripts/data_quality_report.js`'s `findNonCanonicalTones()` flags any future drift back toward free-form tags (mirrors the theme vocabulary's equivalent check).

---

## Adding a New Book

When adding a new book to `goodreadsData.json`, a complete entry looks like:

```json
{
  "title": "The Last Trial",
  "author": "Scott Turow",
  "shelf": "to-read",
  "myRating": 0,
  "pages": 384,
  "avgRating": 4.01,
  "ratingsCount": 12500,
  "year": 2020,
  "themes": ["legal", "thriller", "courtroom"],
  "similarToTitles": ["Presumed Innocent", "A Time to Kill", "The Client"]
}
```

- `similarToTitles` values must be exact matches to `title` fields in the dataset
- Check the canonical theme list above before inventing a new tag

---

## Engine Summary (key scoring terms for to-read books)

| Signal | Max pts | Source |
|--------|---------|--------|
| fromToRead base | +10 | shelf === "to-read" |
| 5★ author bonus | +15 | `fiveStarAuthors` map |
| Author rating weight | +7.5 | `authorRatingWeight` (weighted by rating: 5★=+1.0, 4★=+0.8, 3★=+0.3, 2★=−0.5, 1★=−1.0) |
| Similar-author bonus | +15/author | `candidate.similarToAuthors` ∩ fiveStarAuthors/authorRatingWeight (same formula as pool books) |
| Forward title match | +8/match | candidate.similarToTitles ∩ fiveStarTitles |
| Reverse title match | +12 | `reverseSimilar` (5★ reads citing this book) |
| Theme bonus | +8 | `themeBonus()` vs fiveStarThemes |
| Popularity bonus | +4 | `ratingsCountBonus()` (>100k ratings) |
| Community rating | variable | `(avgRating - 3.5) * 10` |
| Pages fit | ±4–6 | vs medianPages of read books |

---

## Evaluation Discipline (added Session 12 — do not skip)

Run `node scripts/eval.js` BEFORE and AFTER any engine change. It reports
precision@k over completed rated reads (leave-one-out, DNFs excluded — DNF
virtual ratings leak the answer and inflate metrics; header Spearman claims
predate this fix). Baseline as of Jul 3 2026: p10=100, p25=96, p50=96,
MAE=0.770. Top-of-list precision (p10/p25) outranks MAE: never trade it away.

**Measured dead ends — do not re-attempt without new data:**
- Author/theme weight tuning (upweighting low ratings, asymmetric variance
  penalty, halving PRIOR_K): flat or traded p25 for MAE. The model is at its
  ceiling; completed 2★ books look identical to 5★ books in all features.
- Negative-only description voting: strictly worse than symmetric.

**Real bottleneck:** negative training data. Only 39 dismissals and 106
low-rated completions whose features match loved books.

## TF-IDF Description Signal (descSimilarity.js, Session 12)

k-NN over TF-IDF vectors of real descriptions from data/enrichedMetadata.json
(filled daily by the enrich-metadata workflow, 150 books/run). Coverage-gated:
inactive until 150+ rated reads have descriptions. Tunables in exported CFG
(k=12, cap=6 — sweep-confirmed optimal). Flows: app.js → rankBBRE(…, meta) →
buildTasteModel(…, meta) → Signal 4b in predictRating.

## Workflows

- enrich-metadata.yml: daily 07:00 UTC; Google Books + Open Library →
  data/enrichedMetadata.json. Also usable for tag audits (publisher categories).
- tag-books.yml: manual; Claude Haiku 4.5 tags from descriptions; needs
  ANTHROPIC_API_KEY repo secret (unused so far — Session 12 tagged by hand).
- enrich-covers.yml: Sundays 05:00 UTC; backfills cover URLs (OpenLibrary +
  Google Books) via enrich_covers.py.
- enrich-isbn.yml: Sundays 04:00 UTC; backfills ISBN13 via enrich_isbn.py.
- enrich-goodreads.yml: manual; last-resort description scrape of each book's
  own Goodreads page via enrich_from_goodreads.py.
- scrape-ratings.yml: 5x/day; Amazon + StoryGraph ratings via Playwright
  (scrape_ratings.py), batched to avoid rate limits.
- sync-goodreads.yml: twice daily (6 AM / 6 PM UTC); syncs read/to-read
  shelves from Goodreads RSS via sync_goodreads.py.
- sync-currently-reading.yml: 4x/day; syncs the currently-reading shelf via
  sync_currently_reading.py into data/currentlyReading.json.
- export-extract.yml: Mondays 08:00 UTC; runs scripts/export_extract.js and
  commits a fresh dated `output/all-books-YYYY-MM-DD.csv` snapshot (previous
  dated files are kept, not overwritten). Requires this workflow file to live
  on `main` — GitHub only fires `schedule:` triggers for the default branch.
- data-quality-report.yml: daily 09:00 UTC (changed from weekly in Session
  13j); runs scripts/data_quality_report.js and commits a dated
  `output/data-quality-report-YYYY-MM-DD.md` + `.json` snapshot. Same
  main-branch requirement as export-extract.yml.
- Data conflicts: sync + enrichment commit daily. Rebase carefully; prefer
  re-layering enrichment fields (themes/tones/similarToTitles) onto upstream.

## Session 12b: Dismissal Generalization (complete)

Status legend: [ ] todo, [x] done. Update as items complete.

- [x] 1. Generalize dismissals in bbreEngine: author-dislike penalizes the
      author's other books; style-not-for-me builds a dismissed profile
      (themes + TF-IDF description centroid) and penalizes lookalikes
- [x] 2. Soft-relationship-fiction penalty: no hook theme (thriller/mystery/
      crime/legal/speculative/etc.) AND similar to dismissed style profile.
      CAUTION: One Day and One True Loves are 5-star keeps in this shape —
      penalty must key on dismissed-profile similarity, not romance tags alone
- [x] 3. Pre-1900 fiction filter: description keyword scan (civil war,
      victorian, frontier, regency, 1800s...); exempt lonesome-dove
- [x] 4. Validation gate: scripts/validate_review.js — the 14 Session 12
      review keeps must stay in top 25; eval p10 must stay 100
- [x] 5. Done Jul 3 2026. Gate result: all 13 keeps in top 25, eval p10=100.
      Gate itself caught 2 bugs pre-ship (era regex hit contemporary heist
      descriptions; style penalty hit nonfiction memoirs). Penalties live in
      bbreEngine: dismissAdjust (author -0.15, style-match -0.08, fiction
      only, needs 2+ style dismissals) and pre1900Penalty (-0.12, requires
      historical theme + era keywords, lonesome-dove exempt). Rerun
      scripts/validate_review.js after any engine change. Also in 12b:
      fiction/nonfiction balance pass (final step of rankBBRE — no type
      leads by more than 1 in any prefix; Bill's request), and dismissal
      exclusion now matches derived title|author keys too (pool candidates
      carry OL ids or no key; Bad Blood stayed ranked until this fix).

Review results (Jul 3 2026, ranks 1-20): KEEPS = The Tenant, Local Woman
Missing, Th1rt3en, Heartland, The Wise Men, The Idaho Four, Everything Is
Tuberculosis, Empire of AI, Be Ready When the Luck Happens, The Maid's
Secret, You Must Remember This, The Trolls of Wall Street, The Midnight
Lawyer (+ Rich Blood → currently reading). DISMISSES with reasons in
feedbackData.json: Jackal's Mistress (pre-1900), I'm Glad My Mom Died
(author), Tom Lake / People We Meet on Vacation / Hello Goodbye (style),
A Good Girl's Guide (adaptation), Bad Blood (already attempted).

## Bill's Taste Rules (explicit, from Session 12 review)

- NO fiction set before 1900. Nonfiction pre-1900 settings are sometimes fine.
  Exception: Lonesome Dove (kept for its reputation). When tagging or
  dismissing, check historical fiction settings against this rule.
- Recommend book 1 of a series, not mid-series entries, unless Bill has read
  the earlier books (engine: unread-series #2+ penalty in seriesSignal).
  Exception: Th1rt3en (#4) explicitly kept in Session 12 review.

## Data Caveats

- Session 12 similarToTitles are validated-to-exist but unverified-as-good:
  picked from model knowledge, not measured. Treat as draft; description
  similarity can eventually audit them.
- All 136 DNFs carry myRating=2 as a placeholder. Both engines now use
  reason-scaled virtual ratings (resolved Session 12b; circumstantial DNFs
  are skipped in the author signal).
- similarToTitles entries MUST be exact 5★ read titles (norm() tolerates
  series suffixes, but stay exact).

## Data Enrichment Sessions Log

| Session | Work done |
|---------|-----------|
| 1–6 | Initial Goodreads import; candidatePool files built; ratingsCount on candidates |
| 7 | ratingsCount added to all 313 to-read books; engine wired ratingsCountBonus for to-read |
| 8 | Pages bonus added to to-read branch; themes tagged on all 260 five-star reads; themeBonus personalized |
| 9 | authorRatingWeight signal (replaces flat allReadAuthors count) |
| 10 | Themes tagged on all 241 un-themed read books; similarToTitles added to all 500 read books; reverseSimilar reverse index added to engine |
| 10b | Data quality audit: 1,065 broken similarToTitles refs fixed; 6 non-canonical themes corrected; single-theme books enriched; CLAUDE.md created |
| 11 | similarToAuthors signal added to to-read branch (was already in pool branch); pages fixed on 2 to-read books |
| 12 (Jul 2026, claude.ai) | Persistence: dismissals now survive refresh via localStorage; "Copy feedback JSON" button commits them. Title matching normalized (norm()) in fiveStarTitles/reverseSimilar — series-notation mismatch bug class eliminated. similarToTitles enriched on all 292 to-read books (214 hand-tagged, 49 same-author auto-fill, all validated against exact 5★ titles). Dead themes remapped; 'domestic suspense' added to 19 clear cases. 9 missing bookKeys backfilled. 7 type errors fixed via publisher-category audit (incl. two 5★ reads: Best Offer Wins, The Stowaway). Series signal bugs fixed: decimal entries (#2.5) and collection first-entries now parse. NEW: descSimilarity.js TF-IDF signal (see below). NEW: scripts/eval.js. NEW: enrich_metadata.py + tag_with_haiku.py workflows. Repo hygiene: audit scripts → scripts/, 3.5MB PNG removed, text logo replaces image. |
| 13 (Jul 2026, claude code) | Repo cleanup: removed committed __pycache__ (+ added .gitignore), removed 4 one-off hardcoded patch scripts already applied to goodreadsData.json (tag_read_themes.py, tag_similar_5star.py, tag_similar_lower.py, enrich_read_ratings.py), removed orphaned input/ folder and stale output/dismissed-books.csv. NEW: scripts/export_extract.js + export-extract.yml — weekly (Mondays) full extract merging goodreadsData.json, all candidate pools, enrichedMetadata.json, scrapedRatings.json, and feedbackData.json into a dated output/all-books-YYYY-MM-DD.csv snapshot. |
| 13b (Jul 2026, claude code) | Extract field-population audit + fixes. amazonRating/amazonRatingsCount were only joining ~22% of books despite 90% real scrape coverage — scrapedRatings.json is keyed by scrape_ratings.py's normalized title (subtitle/series stripped) + first-listed author only, but the extract joined on the raw full title; fixed the join key to match, coverage now ~100% of what's actually scraped. goodreadsUrl was 6% populated (library books never had the field, only bookId) — now constructed as `goodreadsUrl \|\| goodreads.com/book/show/{bookId} \|\| search-URL fallback`, 100% coverage. googleRatingsCount was 3.6% because enrich_metadata.py's daily job read averageRating from the Google Books API response but never read the adjacent ratingsCount field — added (affects future runs; existing cache entries need a re-fetch to backfill). Backfilled bookKey on 107 books (7 in goodreadsData.json, 100 across candidatePool2-5) that had none and were therefore silently skipped by enrich_metadata.py, which requires a bookKey to attempt a book at all — done via a surgical text-splice insert, not a full JSON.stringify rewrite, to avoid reformatting unrelated fields (stringify was flattening 4.0→4 and unescaping \u unicode sequences repo-wide). bookKey slug format confirmed by reverse-engineering 1009 existing keys: strip all parenthetical content, lowercase, non-alphanumeric runs → single hyphen. 4 collisions hit during backfill (duplicate title+author already present elsewhere, e.g. same book listed in two candidate pools) — resolved with a -2 suffix rather than merging, since deduping candidate pools was out of scope. Removed storyGraphRating from the extract entirely — scrape_ratings.py hardcodes `storyGraph: None` for every book; the workflow name ("Scrape StoryGraph + Amazon Ratings") overpromises, only Amazon was ever implemented. googleRating (20%, real Google Books API ceiling) and dismissReason (1.6%, expected — only 46/1117 books have any feedback at all) are not bugs, left as-is. |
| 13c (Jul 2026, claude code) | Removed googleRating/googleRatingsCount entirely — grep confirmed neither field is read anywhere in bbreEngine.js/rateEngine.js/engine.js/app.js despite a v5.1 changelog comment calling it "optional"; combined with the ~20% coverage ceiling, it was pure dead weight. Deleted enrich_google_books.py and its enrich-ratings.yml workflow (manual-only, the only thing that ever wrote googleRatingsCount). Stopped enrich_metadata.py from capturing either field. Stripped the existing fields from goodreadsData.json (287 books had the key, mostly null) and enrichedMetadata.json (1005 entries) via per-object text-splice removal — same surgical approach as the 13b bookKey backfill, to avoid a full JSON.stringify rewrite reformatting unrelated fields. Dropped both columns from the export. |
| 13d (Jul 2026, claude code) | Deep-dived the 46 books with no Amazon rating despite ~90% scrape coverage — un-shallowed the git clone (was depth-50, hiding real history) and traced each stuck book back to its actual write commit. 40 of 46 clustered in a 3-day window (Jun 8-10) during the scraper's initial backlog clear, coinciding with 4 same-day fix commits in scrape_ratings.py including "Strip StoryGraph (Cloudflare blocked)" — consistent with transient bot-detection during that high-volume burst, not missing data (several are bestsellers: Outliers, Anxious People, Spare, Atonement). Root cause: `load_pending()` treated any cached entry as permanently done regardless of success/failure, so a one-off miss was never retried. Cleared the 46 stuck entries (surgical top-level-key removal, scrapedRatings.json is a flat map) and manually triggered the workflow to re-attempt them. Permanent fix: added `checkedAt` timestamp to every cache write and a `RETRY_COOLDOWN_DAYS` (14) check in `is_cached_done()` — only `source=="amazon"` (a real rating) is permanent; not_found/cover_only now retry after the cooldown. |
| 13e (Jul 2026, claude code) | NEW: scripts/lib/loadData.js — extracted export_extract.js's load/join logic into a shared module so a future new consumer can't silently duplicate-and-diverge the join key (the exact bug fixed in 13b). NEW: scripts/data_quality_report.js + data-quality-report.yml (weekly, Mondays 09:00 UTC, after the extract) — per-field table (Field Name, Percent Populated, Quality Score, How Score is Determined, Suggestions for Improvement) driven by a `FIELD_REGISTRY` that scores each field against its *eligible* row subset (e.g. myRating against read-shelf books only) rather than all 1117 books, so by-design sparsity doesn't read as a bug. Also runs data-integrity checks: found 4 books duplicated between the library and a candidate pool (already-read books still sitting in the recommendation pool), 570 broken similarToTitles references (titles that don't exact-match any book in the dataset), and 156 uses of non-canonical themes (chiefly "legal"/"courtroom" on legal thrillers) — none of these were previously visible in any existing tooling. |
| 13f (Jul 2026, claude code) | Data quality report v2, 5 improvements. (1) Broken similarToTitles check now uses the engine's real title-matching normalization (engineNorm, mirrors norm() in engine.js — strips parenthetical/series notation) instead of a naive string compare; this alone cut the reported broken-ref count from 570 to 431, eliminating false positives the engine already resolves fine. (2) Remaining broken refs split into near-miss (97 — substring/prefix overlap or Levenshtein distance ≤3 against some real title; almost always a fixable typo/subtitle-truncation, e.g. "The Big Short" citing the full "The Big Short: Inside the Doomsday Machine") vs orphaned (334 — no close match, likely never added to the dataset). (3) Non-canonical themes used ≥5 times ("legal" 86x, "courtroom" 56x, "historical fiction" 6x) surfaced as canonical-vocabulary-candidates rather than buried in a flat error list. (4) FIELD_REGISTRY entries gained a `critical: true` flag for fields feeding a live scoring signal (bookKey, author, shelf, pages, myRating, avgRating, ratingsCount, themes, similarToTitles, similarToAuthors) — these get a stricter 90% warning threshold (🔴) vs 80% (⚠️) for everything else, so a scoring-relevant gap can't hide among cosmetic ones. (5) Report now leads with an Action Items summary (critical fields below threshold, top other low scores, integrity highlights) plus a week-over-week trend section — each run writes a machine-readable `output/data-quality-report-YYYY-MM-DD.json` snapshot, diffed against the most recent prior one to flag ±3-point Quality Score swings and integrity-count deltas, so regressions surface automatically instead of requiring a manual re-read every week. |
| 13g (Jul 2026, claude code) | Data quality report v3 — redesigned per Bill's explicit steer away from generic population stats toward "what actually helps BBRE recommend better." New sections, all leading the report ahead of the field table: (1) 5★-Read Signal Gaps — 5★ reads missing themes/similarToTitles/similarToAuthors get their own top-priority section since fiveStarThemes/fiveStarAuthors/reverseSimilar are built entirely from them (currently 0 — clean). (2) Already-read-in-candidate-pool elevated from an integrity footnote to a severity-1 "Bill could be recommended a book he's already read" bug — found 5 (Number Go Up, The Real Hoosiers, The Heaven & Earth Grocery Store, Red Rising, All the Light We Cannot See; 2 are genuine low ratings, 3 are DNFs using the documented myRating=2 placeholder convention, not a bug). (3) High-Leverage Candidate Gaps — to-read/candidate books with avgRating≥4.0 and ratingsCount≥10k missing scoring fields (0 currently). (4) Broken similarToTitles near-misses now sorted so refs touching a 5★ read (corrupting a live signal) surface first, not alphabetically. (5) Self-referential checks — a book citing itself, or listing its own author in similarToAuthors; found 19, including a genuine bug (Moneyball by Michael Lewis lists "Michael Lewis" in its own similarToAuthors). (6) Per-book BBRE Impact Score — worst-20 ranked list weighted by 5★-foundational status, high-leverage-candidate status, and integrity involvement, not a raw missing-field count; de-duplicated by title+author so a book sitting in multiple candidate pools doesn't inflate the list (caught and fixed this exact bug during testing — "Number Go Up" initially appeared 3x). (7) Multi-week trend table (last 6 snapshots) for the above BBRE-relevant metrics plus critical field scores, not just a single-week diff. Snapshot JSON now carries full structured findings (not just counts) under a `findings` key — dashboard-ready. Bug found and fixed while building the dashboard (below): the near-miss/orphaned dedup logic cached by normalized ref string and silently dropped every citation after the first occurrence of a given broken title, undercounting real broken references — 97/334 (reported in 13f) was wrong; corrected count is **140 near-miss / 418 orphaned** (61 of the near-misses touch a 5★ read). Each individual (citing-book, cited-title) pair is now counted, matching how every other check in this report counts occurrences. |
| 13h (Jul 2026, claude code) | NEW: quality-dashboard.html — interactive dashboard for the data quality report, linked from index.html's header ("Data Quality →"). Static page matching the site's existing warm palette (cream/brown/gold, Playfair Display + Inter) rather than a generic theme; per the dataviz skill, ran validate_palette.js against the site's actual surface color to confirm the status palette (good/warning/serious/critical) needs mandatory icon+label pairing on this background (warning/serious both fall under 3:1 contrast) — implemented accordingly, never color alone. Trend charts are single-hue small multiples (site accent brown) rather than one crowded multi-line chart, per the skill's series-count guidance. Sections: At-a-Glance stat tiles (linking to detail sections), Multi-Week Trend small multiples (reads history from scripts/data_quality_report.js's dated JSON snapshots), sortable/searchable Field Population and Impact Score tables, and a tabbed Data Integrity browser (Already-Read-in-Pool, Self-Referential, Broken References with near-miss/orphaned toggle, Non-Canonical Themes, Duplicates). data_quality_report.js now also writes output/data-quality-index.json (a manifest of snapshot dates) since a static page can't list a directory on GitHub Pages. Tested end-to-end with a local static server + Playwright (not just eyeballed): verified tab switching, search/sort/filter interactivity, and no console errors other than the Google Fonts request (blocked in the sandbox network, not a real bug — same font-loading pattern as the existing index.html). |
| 13i (Jul 2026, claude code) | Added a composite Data Quality Score (0-100) + a ranked Top-5-Impediments section, per Bill's request for "a big dial" and a bottom section stating what's blocking a perfect score. Computed once in data_quality_report.js (`computeQualityScore`) and embedded in the JSON snapshot so the .md report and the dashboard share one source of truth — no duplicate scoring logic. Score is a weighted average of 4 rate-based sub-scores (not raw point deductions, which wouldn't scale with dataset size): Critical Field Health 30% (avg Quality Score of critical fields), Foundational Signal Integrity 30% (5★-signal gaps + broken refs touching a 5★ read — corrupts a live signal every candidate is scored against), Recommendation Safety 20% (already-read-in-pool + high-leverage gaps — could a bad recommendation actually surface), Data Hygiene 20% (self-referential + candidate-to-candidate near-miss refs + non-canonical themes). Deliberately excludes brokenOrphaned from scoring — most are legitimate external-book references never added to the dataset, not a fixable defect, and penalizing for them would make the number less trustworthy. Current score: 91/100 ("Excellent"). Top 5 impediments ranked by isolated points-lost contribution: broken refs touching a 5★ read (−3.4), non-canonical themes (−2.0), already-read-in-pool (−1.8), candidate-to-candidate near-miss refs (−1.1), self-referential entries (−0.7). Dashboard renders the score as a ring gauge (stroke-dasharray meter, single hue by severity tier — never a rainbow) with the 4 components as labeled meter bars beside it (so the breakdown is reachable without hovering), plus a week-over-week delta once 2+ snapshots exist. Impediments render as ranked cards with points lost, description, fix, and a "jump to detail" link; fixed a bug where those links only scrolled to a tab button without activating it — added a delegated click handler so `#tab-*` links also trigger the tab switch. |
| 13j (Jul 2026, claude code) | Changed data-quality-report.yml from weekly (Mondays) to daily 09:00 UTC per Bill's request. Since "last 6 snapshots" meant 6 weeks before and would mean under a week at daily cadence, widened the trend window to 14 snapshots (`HISTORY_SNAPSHOTS`, renamed from `HISTORY_WEEKS`) in both the .md report's Recent Trend table and the dashboard's small multiples — 2 weeks of daily data, not 6 days. Relabeled all "week-over-week"/"weekly" copy in the script and dashboard to cadence-neutral language ("since last report", "History starts next run") so it doesn't misdescribe the new schedule. export-extract.yml (the CSV extract) is unchanged — still weekly; data_quality_report.js doesn't depend on its output (reads data/ directly via loadData.js), so the two schedules are independent. |
| 13k (Jul 2026, claude code) | 5 dashboard improvements, all implemented. (1) Date-range filter (7d/14d/30d/90d/All) above everything it scopes (score dial, at-a-glance tile sparklines, trend grid) — fetches up to 100 snapshots once, slices client-side on click (no refetch). (2) Score-history sparkline added under the dial's component meters (stat-tile pattern: hero number + trend). (3) "Resolved since last report" banner — green callout listing any BBRE-impact metric that dropped from >0 to exactly 0 since the immediately-prior snapshot; always compares against the true previous report regardless of the date-range filter, since it's a fact about the last run, not a view option. (4) CSV download buttons on the Field Population and Impact Score tables — reads the currently-rendered DOM rows (post search-filter, post sort) so the export always matches what's on screen, not a recomputed set. (5) Mobile pass: made the dial SVG responsive (was fixed 200x200 px, now scales via viewBox + 100% width/height so the existing max-width:640px media query can actually shrink it); found and fixed the dial's "EXCELLENT · OUT OF 100" label clipping at the smaller mobile size (font-size 0.72rem → 0.6rem under the breakpoint); impediment cards drop the rank-number column on narrow screens via existing grid-template-columns override. Tested end-to-end with local server + Playwright at both desktop and 375px mobile viewport widths: no horizontal overflow, no console errors, range-filter clicks/CSV downloads/resolved-banner-suppression (correctly empty with only 1 snapshot so far) all verified. |
| 14 (Jul 30 2026, claude code) | Two-part session: fixed the four highest-severity data-quality findings, then recalibrated the Data Quality Score per Bill's explicit pushback that 91/100 "Excellent" read as too generous (his estimate: ~60) and that the bar for "Excellent" should be much higher. **Fixes**: (1) Already-read-in-pool — removed Number Go Up, The Real Hoosiers, All the Light We Cannot See, Red Rising, The Heaven & Earth Grocery Store from the candidate pool files they were sitting in (all 5, across candidatePool.json/2/5/6) via surgical text-splice deletion, not JSON.stringify rewrite (confirmed via git diff that stringify silently unescapes `—` to a literal em-dash across the whole file — same pitfall as Session 13b/13c — reverted and redid by hand). (2) Self-referential entries — fixed all 17 genuine bugs (16 author-cites-own-name-in-similarToAuthors incl. the known Moneyball/Michael Lewis case, 1 title-cites-itself: Another Day (Every Day, #2)); the other 2 of the reported 19 (The Firm (Penguin Readers, Level 5) citing "The Firm", Behind Closed Doors (Behind Closed Doors, #1) citing "Behind Closed Doors") turned out to be a **script bug**, not a data bug — engineNorm's series/edition stripping collided two genuinely different books that happen to share a bare title (a real B.A. Paris novel exists separately from the Lisa Renee Jones series); fixed `findSelfReferential()` to only flag a title self-citation when the normalized title is unambiguous (exactly one book owns it dataset-wide). (3) Non-canonical themes — promoted `legal`/`courtroom` to canonical vocabulary (142 of 156 uses; already load-bearing in app.js's THEME_MACROS "Legal" filter chip, so they were functioning, just undocumented) and hand-remapped the remaining 14: "historical fiction"→"historical" (6), "coming-of-age" dropped (4, each book already had 2-3 other canonical themes), "fantasy"→"speculative" or dropped depending on whether the book already had it (2), "science"→"history" (1, judgment call — no exact nonfiction-science canonical bucket exists), "medical thriller" dropped (1). Also corrected a factual error in the report's own copy: "non-canonical themes don't contribute to themeBonus scoring" was false — engine.js's `fiveStarThemes` map has no canonical filter at all, so non-canonical themes score identically; the real cost is vocabulary fragmentation, not lost signal. (4) Broken similarToTitles refs touching a 5★ read — investigating the reported 61 surfaced a second **script bug**: `findNearMatch()`'s substring check (min length 5) and flat Levenshtein≤3 threshold produced confident-looking but wrong matches on short titles ("Grant" is a substring of "flagrant"; "It"/"We"/"Joe" are Levenshtein-distance-2 from "Me"; auditing all 28 pre-fix Levenshtein hits found exactly 1 real catch and 27 false positives) — raised the substring minimum to 8 chars and gated Levenshtein to titles ≥15 chars with a distance ratio ≤10% instead of a flat ≤3, which correctly reclassified 24 of the reported 61 as orphaned (real books just not in the dataset) and left 35 genuine subtitle-truncation citations (e.g. "The Big Short" → "The Big Short: Inside the Doomsday Machine", "Going Infinite", "Dream Team", "The Everything Store", "Fantasyland", "The Extra 2%", "The Innovators", etc.) which were corrected to their exact dataset title via a line-verified splice script (each edit asserted the expected old string was present before writing, so a stale line number fails loud instead of silently corrupting a neighboring line). Result: brokenNearMissTouchingFiveStar 61→0. **Recalibration**: reworked `computeQualityScore` — original rubric divided raw issue counts by huge denominators (total citations/theme tags across 1118 books), mathematically crushing any real count into a fraction of a point, and excluded whole categories (orphaned refs, duplicate-book groups) from scoring entirely. New version uses smaller, more honest denominators (5★-read count instead of total-citation count for the foundational check; total book count for duplicates), folds orphaned refs and duplicate-book groups into Hygiene/Safety at reduced weight, and raises penalty multipliers substantially (e.g. already-read-in-pool rate multiplier 3→8, self-referential 2→4, non-canonical 2→4); component weights shifted from a flat-ish 30/30/20/20 to 15/30/25/30 (Critical Field Health de-emphasized since it was already near-100% and had no real room to be critical; weight redistributed to Foundational/Safety/Hygiene where the real findings live). Tuned by hand against the exact pre-fix Jul 30 snapshot (5 already-read-in-pool, 19 self-referential, 61 broken-touching-5★, 156 non-canonical, 418 orphaned, 12 duplicate groups) to land at 65/100 — an intentional recalibration of the bar for "Excellent," not a re-derivation of the old thresholds. After the fixes above landed, the live score is **93/100** (up from the old rubric's 91, but now honestly earned rather than diluted); remaining impediments are 463 orphaned refs (documented as mostly legitimate, still scored at reduced weight), 52 candidate-to-candidate near-miss refs, and 5 duplicate-book groups (to-read books also sitting in a candidate pool — distinct from the already-read bug, lower severity, not yet fixed). Verified no regression: `scripts/eval.js` unchanged (p10=100, p25=96, MAE=0.769 vs 0.770 baseline); `scripts/validate_review.js`'s one failure (Heartland) is pre-existing on the untouched branch, confirmed via `git stash` before/after, not introduced by this session. |
| 14b (Jul 30 2026, claude code) | Second recalibration pass, same session — Bill explicitly said 93/100 was still too high ("set it at 65, be more critical, aim higher") after the acute-bug fixes above mechanically pushed Foundational Signal Integrity and most of Recommendation Safety to a genuine 100. Diagnosis: with those two components maxed and weighted ~55% of the old formula, no combination of the remaining findings (52 candidate-to-candidate near-misses, 463 orphaned refs, 5 duplicate groups) could mathematically pull the total below the high 70s — fixing the acute bugs is a floor, not the bar for "Excellent." Added a 5th component, **Field Completeness** (average Quality Score across *all* ~30 tracked fields, not just the 10 scoring-critical ones — isbn 65.9%, dateRead 72%, subjects 75%, dismissReason 78%, tones 84%, publisher 87% were previously invisible to the composite score entirely despite being in the Field Population table all along), with a 5.7x shortfall multiplier. Reweighted components from 15/30/25/30 (criticalHealth/foundational/safety/hygiene) to 8/33/8/11/40 (criticalHealth/completeness/foundational/safety/hygiene) — shrinking the now-maxed Foundational and most-maxed Safety components' influence and shifting weight to Completeness and Hygiene, where the dataset's real remaining gaps live. Raised Hygiene multipliers again (near-miss-other 5→8.5, orphaned 1.5→4.3) and Safety's duplicate multiplier (6→10). Tuned by hand against the exact post-fix Jul 30 snapshot (0 already-read-in-pool, 0 self-referential, 0 broken-touching-5★, 0 non-canonical, 463 orphaned, 52 near-miss, 5 duplicates, 93.7% average field completeness) to land at exactly 65/100 — a second, explicit, higher bar: even a dataset with every acute bug fixed shouldn't read as "Excellent" while a tenth of its similarToTitles citations don't resolve and whole fields sit at 65-87% populated. Added a matching "Field completeness gaps (all fields)" impediment card. Dashboard needed no changes — it renders `qualityScore.components` generically, so the 5th component appeared automatically. Confirmed `scripts/eval.js` unaffected (script-only change, no engine touch). |
| 14c (Jul 30 2026, claude code) | Built a "Roadmap to 100" per Bill's request for a comprehensive plan to close the 65→100 gap, integrated into the dashboard. Investigated the actual remaining findings before writing anything: the 463 orphaned refs turned out to have a steep long tail (377 unique titles; "Blood, Bones, and Butter" alone is cited by 20 different food-memoir books, "Kitchen Confidential" by 7, but 330 of the 377 are cited exactly once) — top-30 by-citation-count resolves 21% of all orphaned refs, top-100 resolves 40%, and each addition beyond that is a single-citation long tail. Also hand-audited the 52 remaining candidate-to-candidate near-misses: roughly 35 are genuine subtitle-truncation fixes (same pattern as Session 14's 35), ~14 are still false-positive matches from `findNearMatch()`'s substring/Levenshtein heuristics on coincidental word-prefix collisions ("The Road to Somewhere"→"The Road", "Superintelligence"→an unrelated book that happens to have "Superintelligence" in its subtitle, "Influence"→"Influence Empire"), and 2 are a previously-missed bug class: a book citing its own *abbreviated* title ("The Origins of the Cornbread Mafia" citing bare "Cornbread Mafia"), which normalizes differently from the full title so the Session 14 self-referential fix didn't catch it. Implemented `buildRoadmap()` in data_quality_report.js: a 6-scenario cumulative simulation (Current → Phase 1 quick fixes → Phase 2 top-30 books → Phase 3 top-100 books → Phase 4 automation/backfills → theoretical ceiling) that re-runs the actual `computeQualityScore()` against a hypothetical fixed stats/integ state for each phase, so projected scores are computed, not hand-typed — verified real output: 65→71→75→79→85→100. Phase 4's field-completeness targets are realistic-improvement estimates (e.g. subjects 75%→80%, categories 96%→97%) rather than 100%, because FIELD_REGISTRY's own notes say subjects (Open Library) and categories (Google Books) genuinely don't respond to retrying with current logic — the report's honest conclusion is that Phase 4 (~85) is the practical ceiling without a new data source, not the theoretical 100. Added the roadmap to both the .md report (new "Roadmap to 100" section after the Impediments list) and the JSON snapshot (`roadmap` key), plus a new dashboard section (`#roadmapSection`) rendering it as a connected sequence of phase cards — score number colored by the existing `scoreTier()` function, dashed border on the ceiling card to visually distinguish "requires external data" from the actionable phases. Found and fixed a real mobile bug while Playwright-testing at 375px: a long slash-joined field list ("similarToAuthors/themes/similarToTitles/ratingsCount") had no break points, and CSS Grid's default `min-width:auto` on grid items ignored the `overflow-wrap:break-word` fix on its own — needed `min-width:0` on the grid item too, a classic CSS Grid overflow trap. Verified end-to-end with local server + Playwright at desktop and 375px mobile: 6 phases render correctly, projected scores match the JSON, no horizontal overflow, no real console errors. |
| 14d (Jul 30 2026, claude code) | Filled `similarToAuthors` on the 13 books that had it entirely missing (per Bill's request, using option 1 from the "what are our options" discussion — hand-tag now, no new infrastructure). Picks grounded three ways, in priority order: (1) reuse the in-dataset convention already established for the same author elsewhere — Malcolm Gladwell's other 4 books all use [Michael Lewis, Daniel Kahneman, Nassim Taleb, Dan Ariely], applied identically to "The American Way of Killing"; James Patterson's crime titles use [Harlan Coben, Michael Connelly, Lee Child, David Baldacci], applied to "The Munich Affair"; Chuck Klosterman's music-specific books use [Jeff Pearlman, Bill Bryson] vs. his general-culture books' different set, and "Rock*" (a music book) got the music-specific pair. (2) cross-reference the book's own already-tagged `similarToTitles` against Bill's actual 5★-read authors — "Endurance" already cited Into Thin Air/The Wager/Unbroken, all by 5★ authors (Jon Krakauer, David Grann, Laura Hillenbrand), so used those directly instead of guessing. (3) independent judgment grounded in Bill's real 5★-author list for the rest (e.g. "Operation Bounce House," a LitRPG novel → Andy Weir, Max Brooks; "Cancel Me If You Can," a media-mogul memoir → Phil Knight, Jeff Pearlman). Caught one real anomaly before tagging: "The American Way of Killing" by "Malcolm Gladwell" had an enriched description about colonial-American-Revolution warfare essays that matched neither the title nor any Gladwell book — web search confirmed the title/author pairing is correct (a real, upcoming Sept 2026 Gladwell book on gun violence) but the enrich_metadata.py description is mismatched, likely because Google Books/Open Library have no real data yet for an unreleased book; flagged as a separate pre-existing enrichment bug, not blocking the similarToAuthors fix. The 14th missing book, "When the Game Was Ours" (Larry Bird), was deliberately left alone: it lives in data/currentlyReading.json, a file sync_currently_reading.py fully rebuilds from the Goodreads RSS feed every run with no merge step, so anything added there would silently vanish on the next sync (every few hours); more importantly, engine.js's `isExcluded` check (`idx.read.has(k) || idx.currentlyReading.has(k)`) removes currently-reading books from the candidate pool entirely, so similarToAuthors on this record has zero effect on BBRE regardless — tagging it would be both pointless and non-durable. similarToAuthors field Quality Score: 98.7%→99.9% (13 of 14 real gaps closed). Verified no regressions: `scripts/eval.js` unchanged, no new self-referential entries introduced, all data files remain valid JSON. |
| 15 (Jul 31 2026, claude code) | Started on impediment #2 (Field Completeness gaps). This session's remote environment blocks openlibrary.org (403, proxy policy denial) and rate-limits googleapis.com immediately (429) — confirmed the enrichment scripts can't be run locally in this sandbox, so pivoted to triggering the real GitHub Actions workflows instead. **isbn13 (82.0%→98.0%, score 65→66):** triggered `enrich-isbn.yml` and found it only ever attempted ~2 books despite a 200-book gap — root-caused to two bugs in `enrich_isbn.py`: (1) the skip check was `if isbn13 or isbn: continue`, so any book with an old ISBN-10 but no ISBN-13 was permanently skipped (14 books, unfixable by any number of reruns); (2) `enrich_goodreads()` only ever processed `shelf=='to-read'`, so all 181 read-shelf gaps were structurally out of scope by design. Together these accounted for 195 of the 200 missing (97.5%) — the existing automation was only ever reachable for ~5 books. Fixed both (drop the isbn10 skip; drop the to-read-only filter, since isbn13 isn't scoring-critical but read-shelf incompleteness is still real), pushed to main, re-triggered the workflow: it ran clean and backfilled 178 of 200 in a single ~3.5 minute run. Verified the diff was pure isbn13-value changes, no collateral reformatting. **publisher (86.9%, code fixed but not yet reflected):** noticed `enrich_metadata.py`'s Google Books call already receives a `publisher` field in every response but never captured it, and `loadData.js` only ever read `b.publisher` directly with no fallback to the enrichment cache (same bug shape as Session 13b's `googleRatingsCount` miss). Fixed both call sites, but — same caveat as 13b — this only affects newly-fetched cache entries; existing already-attempted books (~99.7% of the dataset, since `metadataFetchedAt` is near-complete) won't retroactively gain a publisher without a fresh re-fetch pass, which wasn't run this session (would mean invalidating a large slice of `enrichedMetadata.json`, a bigger call than fits under "let's start with impediment #2"). **dateRead (72%, no automation exists):** traced through `sync_goodreads.py` — `dateRead` is only ever set at the moment a book's shelf transitions from to-read→read during a sync run (`if book.get('shelf') == 'to-read': ... book['dateRead'] = date`); it has no backfill path for already-read books that were bulk-imported or transitioned before this logic existed. Confirmed goodreads.com itself is also blocked from this sandbox (403), so a prospective new backfill script couldn't be tested locally either — flagged as needing dedicated future work, not something to build blind. **subjects (75.1%) and dateAdded (83.6%):** re-confirmed as pre-existing, already-documented ceilings (Open Library coverage gap; cosmetic-only field respectively) — no new findings. **tones (84.0%→99.9%, 177 of 178 hand-tagged, score 66→67):** Bill chose hand-tagging over running the untested `tag-books.yml`. Read `tag_with_haiku.py`'s source to get the actual canonical 12-word tone vocabulary (twisty, compulsive, tense, dark, funny, warm, bleak, thoughtful, revelatory, conversational, propulsive, atmospheric) since CLAUDE.md never documented one. Tagged all 177 addressable books (13 library, 164 across 6 candidate pools) using themes + real enriched descriptions for grounding. Wrote a generic text-patcher (`/tmp/apply_tones.mjs`, not committed) rather than JSON.parse/stringify: it maps each JSON array's element order directly onto raw-text object byte-spans (found via brace-depth scanning), so insertion never risks the unicode/number reformatting damage seen in earlier sessions — verified every file's diff was exactly 3 changed lines per matched book (comma + new tones line + realigned brace), nothing else touched. Left "When the Game Was Ours" alone for the same reason as its similarToAuthors gap in 14d (currentlyReading.json is sync-rebuilt with no merge step, and engine.js excludes currently-reading books from the candidate pool entirely). **Important discovery while grounding tone choices**: tones is not cosmetic — `bbreEngine.js`'s `buildToneProfile()`/`toneSignal()` computes a real preference delta per tone from Bill's actual read-book ratings (comment cites twisty +0.45★, compulsive +0.38★, tense +0.28★ vs. revelatory -0.40★, conversational -0.27★) and applies it to candidates, gated on ≥3 rated read-books carrying that tone. Checked which of the 12 canonical tones already clear that bar: twisty (64 read+rated books, avg 4.16), tense (125, avg 4.37), dark (134, avg 3.92), revelatory (43, avg 2.77), conversational (89, avg 3.60), atmospheric (104, avg 3.58), compulsive (23, avg 4.61) all have live signal already; funny/warm/bleak/thoughtful/propulsive currently have zero read-book usage so contribute no delta yet. This means the 177-book tagging pass immediately feeds real scoring for most of its tags, not just the Field Completeness metric — directly serves the earlier "optimize BBRE" goal, not only the dashboard. Also found (not fixed, out of scope for this pass): read books carry a much broader, pre-existing tone vocabulary (fast-paced, procedural, gritty, unreliable-narrator, humorous, character-driven, and more) that doesn't overlap with tag_with_haiku.py's 12-word list — a vocabulary-fragmentation gap analogous to the historical non-canonical-themes issue, flagged for a future session rather than addressed here. No regressions: `scripts/eval.js` unchanged, no new self-referential/already-read-in-pool/non-canonical-theme entries, all tags verified against the canonical 12-word list, all JSON valid. |
| 15b (Jul 31 2026, claude code) | Fixed a "Percent Populated" honesty bug per Bill's request: fields restricted to a subset of books (dateRead/myRating → read-shelf only; amazonRating/amazonRatingsCount → to-read/candidate-pool only; subjects/categories → already-attempted-by-enrich_metadata.py only; dismissReason → dismissed-only; isbn → pre-2007 books) had their "Percent Populated" column computed against the FULL 1,112-book dataset (`rawPct = raw.length / rows.length`) even though the adjacent "Quality Score" column already correctly scoped itself to the eligible subset (`scorePct`, via `FIELD_REGISTRY`'s `eligible` function) — so e.g. dateRead showed 42.0% looking like a huge gap when its real ceiling, scored against its true 649-book-eligible denominator, is 72%. `populationStats()` was already computing `eligibleTotal`/`eligiblePopulated` correctly, just not surfacing them. Fixed `renderPopulationTable()` in data_quality_report.js to append `(target: N eligible, not all 1,112)` to the Percent Populated cell whenever a field's eligible pool is smaller than the full dataset; added `eligibleTotal` to the JSON snapshot's per-field serialization so quality-dashboard.html could replicate it client-side (compares `f.eligibleTotal` against the already-present `current.totalBooks`), with a small muted note line under the percentage in the Field Population table. No scoring logic touched — `computeQualityScore()`'s `completenessScore` already used the eligible-scoped `scorePct`, not the raw one, so the Data Quality Score is unaffected (still 67/100). Verified end-to-end: regenerated report shows correct target annotations for dateRead/myRating/amazonRating/amazonRatingsCount/subjects/categories/dismissReason, unrestricted fields (avgRating, dismissed) show no annotation; dashboard Playwright-tested live against the regenerated JSON — dateRead row renders the target note, avgRating row doesn't, no new console errors. `scripts/eval.js` unchanged (p10=100, p25=96, MAE=0.769). |
| 16 (Jul 31 2026, claude code) | Redesigned the tone vocabulary from scratch per Bill's explicit request ("a set of 24 tones... no tone should account for more than 15% of books... do deep research and put together a plan") after establishing that the dataset actually had 39 different free-form tags in use, with `accessible` (38%), `narrative-driven` (37%), and `fast-paced` (31%) each diluting the one real tone-based signal (`bbreEngine.js`'s `buildToneProfile()`/`toneSignal()`) past the point of usefulness. Planned via EnterPlanMode/ExitPlanMode given the scale (1,111 books, 4 codebase touch-points) — see plan file for full research notes. **New 24-tone vocabulary** (documented above in its own section): 7 pacing/structure, 6 mood, 3 voice/humor, 4 craft/style, 4 intellectual-register tones. **Migration**: hand-tagging 1,111 books wasn't practical, and an LLM pass was both untested and something Bill had already opted out of, so built a deterministic scored classifier instead — scored every book against all 24 tones using its real `enrichedMetadata.json` description text (100% coverage confirmed), themes (inverse-frequency weighted so mega-themes like `narrative nonfiction` at 481 books don't dominate), and its *existing* legacy tone tags as a strong prior (carries forward prior human judgment rather than discarding it). Iterated the scoring three times after catching real problems: (1) naive keyword lists matched generic blurb hype-language ("forensic" substring-matched "forensics" in a non-procedural cadaver-science book; "social commentary" theme wrongly implied `satirical` on an analytical NBA book) — tightened to more specific phrases. (2) A flat "any positive score” rule let weak theme-only signals become default filler on hundreds of books (`lyrical`/`inspiring`/`thoughtful` matched 100-142 books off theme alone with zero keyword or prior support) — added a `MIN_SCORE=1.0` floor so a tag needs a real keyword hit or legacy-prior match, with theme affinity alone capped low enough to only break ties. (3) The cap-enforcement rebalancing loop initially reassigned an over-cap book's tone to *whatever tone had spare capacity*, regardless of fit — caught via spot-check ("The Good Girl," a Mary Kubica psychological thriller, lost both its real `dark`/`tense` tags to array-order ties among 254 equally-scored books and got assigned `nonlinear`/`ensemble` instead) — root cause was arbitrary tie-breaking among identically-scored legacy-only carryovers; fixed by rewriting as a single global greedy pass (sort all (book,tone) pairs by score desc, breaking ties by scarcity-of-alternatives so a book with only 2 viable tones is processed before one with 10) plus a capped-weight `weakThemes` layer so the 2-tone floor backfill has *some* real ranking signal instead of defaulting to a zero-score coin-flip. Also discovered en route: 13 books (the ones hand-tagged in Session 15) carried a **duplicate `"tones"` key** — Session 15's insertion script appended a new tag line instead of replacing the pre-existing empty `"tones": []`, so JSON.parse silently took the last key (the engine read the right value all along) but the file itself had 13 dead/shadowed lines; this migration's apply script detects and removes them as part of the same surgical pass. **Result**: all 24 tones ≤166 books (14.9%, the exact cap), graded tail down to `lyrical` (3 books) — a legitimately rare craft-quality descriptor no blurb reliably signals, same as the intentionally-rare `ensemble` (11) and `nonlinear` (16) structural tags. Applied via the same surgical text-splice technique as Sessions 13b/13c/15 (never JSON.parse+stringify a whole file) — verified every book's final tones exactly match the migration plan and zero non-tones fields changed, via a full round-trip diff, not just a sample. Also fixed a subtle ordering issue while validating: `bbreEngine.js`'s diversity re-ranking keys off `primaryTone(book)` = `tones[0]`, but the greedy assignment pass built each book's array in *global* cross-book processing order, which has nothing to do with that book's own confidence ranking — added a final per-book sort (each book's own tones by its own score) so `tones[0]` is always its most-confident match, the same property a human tagger's array order would have had. **Codebase updated in sync**: `bbreEngine.js`'s `THEME_TONES_MAP` (theme→tone fallback) and `TONE_PRIORITY` (tie-break order) rewritten to the new 24 words — also fixed a latent dead key (`historical fiction` never matched any real theme, which is `historical`); `tag_with_haiku.py`'s `TONES` constant and `app.js`'s `TONE_FILTER_ORDER` (live site tone filter chips) updated too. **NEW**: `findNonCanonicalTones()` in `scripts/data_quality_report.js`, mirroring the theme vocabulary's existing check (0 violations right after this migration, as expected) — deliberately *not* wired into `computeQualityScore()`, since folding it in would silently move the calibrated 65-baseline score without Bill asking for a fresh recalibration, the exact drift Session 14b pushed back on; reported only, plus a new dashboard tab. **Verification found a real bug and a real trade-off**: `scripts/validate_review.js` initially flagged 3 new failures beyond the single pre-existing Heartland one (The Tenant, The Wise Men, Empire of AI, all previously top-25). Root-caused before asking Bill anything: (1) a genuine classifier bug — the legacy-tag mapping sent `polemic` → `satirical` (the single worst-rated tone in Bill's whole profile, -0.375★), wrongly tagging 3 serious AI/tech-industry nonfiction books (Empire of AI, The Age of AI and Our Human Future, Nexus) as satirical; fixed the mapping to `polemic` → `thoughtful`/`investigative` and corrected all 3 books directly. (2) The remaining 3 failures traced to `bbreEngine.js`'s author-diversity MMR (penalty up to 0.30, steep) — since every book's tones changed at once, tiny toneSignal shifts reshuffled which specific title from a prolific author (e.g. Freida McFadden, many books in the pool) wins the author's top slot in the greedy re-ranking; a book itself didn't get worse, a sibling edged past it by a hair and the steep per-author penalty did the rest. Not fixable without either reverting the redesign or hand-rigging specific books' tags against their real classifier signal, so surfaced to Bill directly (via AskUserQuestion) rather than silently shipped or endlessly chased — his call: **proceed as-is**, these are ranks 28/47/76 of 1,100+ candidates, not banished, and forcing exact rank preservation would undermine the point of the redesign. `scripts/eval.js` (the precision@k gate) is structurally unaffected regardless — confirmed via grep that `rateEngine.js`, which the eval gate actually uses, doesn't read tones at all — and unchanged in practice (p10=100, p25=96, MAE=0.769). Data Quality Score unchanged at 67/100 (tones population was already ~100%, this was a value redistribution, not a completeness change). One important process note for future sessions: **do not re-run a migration script against already-migrated data** — mid-session, a second run of the classifier was accidentally pointed at the just-written new-tone files instead of the original legacy tags, silently corrupting the signal (caught by a distribution sanity check, not by luck); recovered via `git checkout` on the still-uncommitted data files and rebuilding cleanly from the original legacy tags. |
