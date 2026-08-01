# Bill's Books Import Plan (BBIP)

Plan for merging a fresh Goodreads library export into `data/goodreadsData.json`.
Living document — update this file as the plan changes or the import proceeds,
rather than re-deriving it from scratch in a future session.

**Status as of this writing: dry run complete against a real export
(`goodreads_library_export_1.csv`, 822 rows). No data files have been
written. Waiting on Bill to (a) fix the Goodreads-side duplicates listed
below, (b) confirm the two genuine status-reversion books, (c) validate the
7 genuinely-missing books one by one.**

---

## Source format

Goodreads "Export Library" CSV. Columns actually present (confirmed from the
real file): `Book Id, Title, Author, Author l-f, Additional Authors, ISBN,
ISBN13, My Rating, Publisher, Binding, Number of Pages, Year Published,
Original Publication Year, Date Read, Date Added, Bookshelves, Bookshelves
with positions, Exclusive Shelf, My Review, Spoiler, Private Notes, Read
Count, Owned Copies`.

Parsing notes confirmed against the real file:
- `ISBN`/`ISBN13` are Excel-escaped as `="1234567890"` — must strip the
  `="..."` wrapper.
- `Author` is single "First Last" (primary author only) — matches our
  existing convention of one author string per book (confirmed 0 of 947
  existing books use a comma-joined multi-author string). Ignore
  `Additional Authors` for consistency.
- Custom `Bookshelves` values in use: `top-10` (22 books), `all-time-faves`
  (106 books), `library-unavailable` (100 books, personal logistics tag,
  not tracked by us). `top-10`/`all-time-faves` counts match our `top10`
  (22) / `allTimeFave` (106) fields exactly — confirms these Goodreads
  shelves are the real source for those fields. Use them to detect drift
  going forward.
- No DNF shelf exists and none will be added (Bill's call) — the *only*
  DNF/no-longer-interested signal is a book's total absence from a fresh
  export. See "Missing books" below.

## Matching strategy (validated against real data)

1. **Match on `Book Id` first** wherever our record has one — most
   reliable, zero ambiguity risk. 780 of 822 rows resolved this way in the
   dry run.
2. **Fall back to normalized title+author** (strip parenthetical/series
   notation and, separately, strip subtitle-after-colon; fuzzy author
   match by word-set containment so "Adam Grant" vs "Adam M. Grant" style
   variance still resolves) only when `Book Id` doesn't match. 38 rows
   resolved this way in the dry run, 0 automated ambiguities.
3. **Known gap, needs a second pass**: the matcher only checks one
   direction (do multiple *our* books match one CSV row). It missed two
   real matches the first time through:
   - A book retitled/re-editioned on Goodreads (*The Antisocial Network* →
     *The Dumb Money... (Previously Published as The Antisocial Network)*,
     new Book Id) — same book, not new, not missing.
   - A truncated title on our side (*"Raised"* → really *"Raised by a
     Serial Killer"* on the to-read shelf) — same book, not missing.
   Fix: after the primary pass, for every unmatched "missing" book, check
   whether its author has any plausible fuzzy-title candidate among *new*
   CSV rows before concluding it's genuinely absent.
4. **Critical bug found and fixed in the matching script itself**: the
   first version of the diff logic iterated over every CSV row that
   matched a given book, rather than picking one canonical match per book.
   When Goodreads had two entries for the same title (see Duplicates
   below), this made it look like 6 books had lost their ratings/shelf
   status, when in fact each was correctly and safely matched to the real
   rated copy via `Book Id`, and the "change" was an artifact of the
   *other*, blank duplicate entry also fuzzy-matching by title+author.
   Fixed by requiring exactly one canonical match per book (`Book Id` match
   wins outright; title+author fallback only considered if no `Book Id`
   match exists).

## Findings from the real dry run (822 rows)

- **818 matched, 4 new, 144 absent from export.**
- Of the 144 absent: **135 already carry `dnf: true` in our data** —
  expected, consistent, no action needed (confirms these were already
  known-gone). **9 needed individual digging**; 2 turned out to be matching
  gaps (see above), leaving **7 genuinely gone**: *Unhinged Habits, The
  Origins of the Cornbread Mafia, 11/22/63, World Travel, Coach, The Real
  Hoosiers, Children of Time* — pending Bill's one-by-one validation before
  any dismissal gets written.
- Of the 4 "new": *When the Game Was Ours* is already tracked separately in
  `currentlyReading.json` (per Session 14d/15's established convention —
  not added to `goodreadsData.json`, excluded from scoring regardless). The
  other 3 are genuinely new: *Injustice For All (Joe Dillard #3)* (read,
  4★), *The Last Flight* (read, 5★), *The Last Word: A Legal Thriller*
  (read, 5★).
- **Confirmed a live "already-read-in-pool" risk, not hypothetical**: *The
  Last Flight* is sitting unread in `candidatePool.json` right now, and the
  export shows Bill has read and loved it. Confirms the plan's "re-check
  candidate-pool overlap after every new read" step is load-bearing, not
  precautionary.
- **15 duplicate-entry groups found on Goodreads itself** (same book
  shelved twice, different Book Ids) — see the fix-it list delivered to
  Bill in chat. 6 of these had a real rated/read copy sitting next to a
  blank duplicate; the other 9 are inert to-read duplicates.
- **Only 2 genuine single-entry status reversions** (not duplicates):
  *Number Go Up* and *To Sleep in a Sea of Stars*, both `read` → `to-read`
  with rating cleared. Pending Bill's explanation before any auto-apply.
- **21 `bookId` mismatches** where our stored ID didn't match any CSV row
  but title+author did — all explained by the duplicate-entry pattern
  above (our stored ID pointed to the correct copy; the "mismatch" was
  against the *other* copy's ID) or by our own stored ID simply being
  wrong from an early enrichment pass. Resolution: adopt the CSV's ID for
  the canonically-matched row.
- **17 `bookId` backfill opportunities** (we had none stored) — free,
  comes directly from the matched row.
- **7 `top10` / 1 `allTimeFave` drift** — minor, easy to reconcile from the
  export's `top-10`/`all-time-faves` shelves.
- **5 books with `Read Count` > 1** (real re-reads: Steve Jobs ×3, Lessons
  in Chemistry ×2, LIV and Let Die ×2, American Overdose ×2, The Hike ×2).
  We don't currently track read count anywhere — open question, not yet
  decided, not added on our own initiative.

## Phases (updated)

1. **Bill fixes the 15 Goodreads-side duplicates** and clarifies the 2
   status-reversion books. *(blocking — waiting on this)*
2. **Bill validates the 7 genuinely-missing books one by one** — for each,
   capture a real `reasonCode`/`reasonLabel` dismissal in
   `feedbackData.json` (same schema the app's dismiss button writes),
   never a guessed reason.
3. **Re-export and re-run the matcher** against the cleaned-up Goodreads
   state (removes the 15-duplicate noise from the real diff).
4. **Apply matched-book updates**: shelf/rating/date/pages/year/isbn
   changes, logged individually. `avgRating` always overwritable
   (Goodreads' own live community average); `pages`/`year` only overwritten
   if it doesn't regress a value that looks hand-corrected (cross-check
   against session history in CLAUDE.md before blindly trusting a stale
   Goodreads value over an existing one).
5. **Backfill `bookId`** on every matched book missing one (17 known so
   far, more likely once the duplicates are resolved and re-matched).
6. **Add the new books** (themes/tones/similarToTitles researched inline,
   per Bill's choice) — for each, immediately verify: no bookKey collision,
   all 5 `similarToTitles` resolve to real dataset titles, and — the step
   that just proved itself necessary — check every candidate-pool file for
   an existing unread duplicate of a book that just became `read`.
7. **Reconcile `top10`/`allTimeFave` drift** against the export's custom
   shelves.
8. **Re-run integrity guardrails**: `findDuplicateBooksFuzzy`, broken-ref
   scan, self-citation scan (Session 32's checks) — confirm the merge
   introduced nothing new.
9. **Write via targeted string replacement**, never a full JSON round-trip,
   even at this scale — same discipline as every prior data-editing
   session. Verify via `git diff` that only intended fields changed.
10. **Verify**: JSON validity, `node scripts/eval.js` (protect p10/p25),
    `node scripts/validate_review.js` (informational only, per Session 35),
    regenerate `data_quality_report.js`, commit in logical batches (e.g.
    "shelf/rating updates," "new books added," "bookId backfill," "missing-
    book dismissals" as separate commits).

## Open questions / decisions pending

- Do the 2 status-reversion books (Number Go Up, To Sleep in a Sea of
  Stars) reflect deliberate re-shelving for a reread, or an accident? Governs
  whether we touch their `shelf`/`myRating` at all.
- Do we want to start tracking `Read Count` (re-reads) anywhere in the
  schema, or leave it out of scope?
- Final validation + reasons for the 7 genuinely-missing books.

## Side task completed: candidate-pool `bookId` backfill

Separate from the main import (candidate-pool books were never on Bill's
Goodreads shelves, so none of this came from the CSV export) — manually
searched Goodreads for all 159 external candidate-pool books.

- 67 already carried a `goodreadsUrl` with an embedded ID from earlier
  enrichment. Cross-checked fresh search results against these as a sanity
  check: only 36 agreed, 31 disagreed (different edition IDs or ambiguous
  listings — `goodreads.com` itself is still blocked for direct fetches in
  this environment, so neither side could be independently confirmed).
- Per Bill's call: left all 67 existing values untouched (overwriting
  already-integrated data with a less-certain fresh guess is pure downside)
  and backfilled `bookId` only on the **92 books that had no ID at all**.
  All 159 candidate-pool books now carry a resolvable Goodreads ID.
- The 31 disagreements are flagged, not resolved — worth a manual spot-check
  on Goodreads directly if it matters later, but out of scope for now.
- Committed and pushed (`8832a8f`). Verified: JSON valid, diff shows only
  the 92 intended insertions, `eval.js` unaffected (bookId isn't read by any
  scoring path).
