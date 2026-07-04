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
`thriller`, `psychological`, `suspense`, `domestic suspense`, `mystery`, `crime`, `noir`, `horror`, `high-concept`, `spy`, `adventure`, `historical`, `YA`, `romance`, `literary`, `contemporary`, `speculative`, `sci-fi`, `social commentary`

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
      scripts/validate_review.js after any engine change.

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
- All 136 DNFs carry myRating=2. engine.js treats them as ordinary 2★;
  rateEngine uses virtual ratings. Inconsistent — known, unresolved.
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
