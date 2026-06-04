# Bill's Books — Claude Code Session Guide

## What This App Does

Static GitHub Pages app that recommends books from Bill's personal to-read list and a curated external candidate pool. The recommendation engine scores candidates by cross-referencing his Goodreads history (ratings, themes, similar titles).

**Live site:** https://boilerbill83.github.io/my-books/

---

## Session Start Checklist

1. **Set the remote** (PAT is stored in the fishers-house-search-2026 repo, not this one):
   ```bash
   PAT=$(cat /home/user/fishers-house-search-2026/.github_pat)
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
| `data/goodreadsData.json` | 814 books — all of Bill's Goodreads data |
| `data/candidatePool*.json` | External recommendation candidates (5 files, ~115 books) |
| `engine.js` | Scoring engine — buildIndexes, matchScore, confidenceScore, reason |
| `app.js` | React UI |
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
| Forward title match | +8/match | candidate.similarToTitles ∩ fiveStarTitles |
| Reverse title match | +12 | `reverseSimilar` (5★ reads citing this book) |
| Theme bonus | +8 | `themeBonus()` vs fiveStarThemes |
| Popularity bonus | +4 | `ratingsCountBonus()` (>100k ratings) |
| Community rating | variable | `(avgRating - 3.5) * 10` |
| Pages fit | ±4–6 | vs medianPages of read books |

---

## Data Enrichment Sessions Log

| Session | Work done |
|---------|-----------|
| 1–6 | Initial Goodreads import; candidatePool files built; ratingsCount on candidates |
| 7 | ratingsCount added to all 313 to-read books; engine wired ratingsCountBonus for to-read |
| 8 | Pages bonus added to to-read branch; themes tagged on all 260 five-star reads; themeBonus personalized |
| 9 | authorRatingWeight signal (replaces flat allReadAuthors count) |
| 10 | Themes tagged on all 241 un-themed read books; similarToTitles added to all 500 read books; reverseSimilar reverse index added to engine |
