# my-books

A browser-based Goodreads recommendation app designed to run from GitHub Pages.

## Included

- `index.html` — app shell
- `styles.css` — bookish/nerdy styling
- `app.js` — orchestration, rendering, dismiss flow, CSV import
- `storage.js` — local loading + optional GitHub write-back helpers
- `importer.js` — Goodreads CSV parser + transformer
- `engine.js` — normalization, analytics, filtering, scoring, ranking
- `data/goodreadsData.json` — placeholder Goodreads data file
- `data/feedbackData.json` — seeded dislike/exclusion data
- `data/recommendationHistory.json` — starter history file
- `data/candidatePool.json` — starter recommendation catalog

## Setup

1. Create the GitHub repo: `boilerbill83/my-books`
2. Upload all files from this zip.
3. Enable GitHub Pages from the `main` branch root.
4. Open the site.
5. Click **Import Goodreads CSV** to load your Goodreads export.
6. If you want write-back, update `storage.js`:
   - replace `__REPLACE_WITH_GITHUB_TOKEN__` with your token locally
   - change `writeEnabled` to `true`

## What already works

- Goodreads CSV import in-browser
- Analytics tiles and short insights
- 10 recommendations at once (where the candidate pool supports it)
- Match and Confidence scores
- Dismiss with reason picker
- Feedback and history model ready for GitHub persistence

## Notes

- The candidate pool is a starter list, not a full catalog.
- The Goodreads file in `/data` starts as a placeholder until you import your CSV.
- Seeded negative books are already loaded into `feedbackData.json`.
