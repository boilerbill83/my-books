# Bill's Books Import Plan (BBIP)

Plan for merging a fresh Goodreads library export into `data/goodreadsData.json`.
Living document — update this file as the plan changes or the import proceeds,
rather than re-deriving it from scratch in a future session.

**Status as of this writing: three dry runs complete** (`goodreads_library_export_1.csv`,
822 rows; `goodreads_library_export_3.csv`, 806 rows; `goodreads_library_export (1).csv`,
803 rows, pulled from `input/goodreadsextract/` on `main`). No
`goodreadsData.json`/`feedbackData.json` changes have been written yet —
the only real writes so far are the candidate-pool `bookId` backfill (side
task, complete) and a merge with `main` (see "Branch sync" below).

**Third dry run confirmed the remaining 2 duplicates and the Behind Closed
Doors rating are both fixed** — 0 duplicate groups, B.A. Paris's copy back
at 5★. Two new absences surfaced: a *second, different* "Behind Closed
Doors" (by Lisa Renee Jones — a separate book that happens to share the
bare title) is now gone from Goodreads entirely, and so is **Stoner**
(previously progressing nicely to `currently-reading`). Missing-book count
is now **11**, up from 9 — see the "Second dry run" section below for the
original findings and add these 2 to the same review-file treatment.

**All 11 missing books now resolved.** Bill edited the review file directly
on GitHub (commit `8695441`) rather than sending it back:
- **7 real dismissals written** to `feedbackData.json` (commits `46220e3`,
  `d159ef1`): *Number Go Up* (started_did_not_like), *Stoner*
  (started_did_not_like), *Unhinged Habits* (not_interesting), *The Real
  Hoosiers* (not_my_vibe), *Children of Time* (started_did_not_like),
  *Survival of the Thickest* (started_did_not_like), *Behind Closed Doors*
  by Lisa Renee Jones — not the B.A. Paris novel, that one's fine
  (no_longer_relevant).
- **4 rows needed no action at all**: *The Origins of the Cornbread Mafia,
  11/22/63, World Travel, Coach* — Bill confirmed he genuinely read all
  four; checked `goodreadsData.json` and each already correctly shows
  `shelf: read` with a real rating and `dnf: false` — no dismissal or DNF
  flag was ever set, so there was nothing to remove. Their absence from the
  fresh export is just Bill tidying his Goodreads account, not a data bug.
- Checked all 7 dismissed titles against every candidate-pool file for a
  lurking duplicate under a different bookKey (Session 32's bug class) —
  none found.
- Verified after both dismissal batches: `eval.js` unchanged (p10=100,
  p25=96), `validate_review.js` unchanged (informational, same 9/13 keeps
  below top 25).

**Real import complete (commits `b133a85`, `4b4c1f2`, `b4104ef`).** All
remaining phases executed:
- Applied the matched-book shelf/rating/dateRead updates (*In Good Faith*
  → read/5★, *The Three-Body Problem* 3★→2★, plus dateRead fills/corrections
  on 6 more books). Deliberately skipped `pages`/`year`/`isbn`/`isbn13` on
  this batch — the fresh export had implausible page counts on several rows
  (e.g. "Legends and Soles" 304→1) even on confirmed-`Book Id` matches, a
  genuine Goodreads CSV data-quality issue, not an edition-mismatch
  artifact — too risky to propagate blind.
- Backfilled 15 missing `bookId`s and corrected 11 stale/mismatched ones
  (adopted the CSV's ID — Bill's own export is ground truth for his own
  library, unlike the earlier candidate-pool bookId project where neither
  side was authoritative).
- Added the 3 genuinely new books found in the export: *Injustice For All*
  (Joe Dillard #3, Scott Pratt, researched via WebSearch), *The Last Word:
  A Legal Thriller* (D.B. Easton, researched via WebSearch — unfamiliar
  small-press title), and *The Last Flight* (Julie Clark — reused its
  existing `candidatePool.json` enrichment wholesale, just swapped in
  Bill's real read-copy `bookId`). All three verified: no bookKey
  collision, every `similarToTitles` entry resolves to a real dataset
  title.
- Fixed the already-read-in-pool bug flagged during the dry run: removed
  *The Last Flight* (bookId `52652923`) from `candidatePool.json` now that
  Bill's real copy (bookId `51197260`) is a confirmed 5★ read.
- Reconciled `top10` drift against the export's `top-10` custom shelf: *An
  Innocent Client* and *Ark* dropped off, *I Am Not a Robot* and
  *Culpability* were added — 4 books, net count still 22. No
  `allTimeFave` drift this round.
- Guardrails re-run after every write: dataset-wide broken-`similarToTitles`
  scan (0, using the engine's real `norm()`), duplicate-book scan (0 new),
  self-citation scan (same 2 pre-existing Session-14-documented
  `engineNorm` false positives, no new ones), `eval.js` (p10=100/p25=96/MAE
  0.758, unchanged throughout), `validate_review.js` (unchanged,
  informational-only per Session 35).

BBIP's active import work is done. Future sessions: re-run the same
dry-run pipeline (`/tmp/gr_import/full_diff.mjs`-style scripts, or rebuild
if `/tmp` has been cleared) against Bill's next export whenever he provides
one — the matching strategy, phase list, and guardrail discipline
documented below all still apply unchanged.

## Branch sync with `main` (completed)

`main` had moved ahead independently — several automated jobs (ISBN13
backfill via Google Books, metadata enrichment, daily quality reports,
weekly extract) plus Bill's new export upload to
`input/goodreadsextract/`. Merged `main` into this working branch before
running the third dry run, so the comparison is against fully current data.

4 real conflicts, resolved by hand:
- **`data/goodreadsData.json`** (8 blocks) — main's automated ISBN13
  backfill script did a full `JSON.stringify` rewrite instead of a surgical
  edit, so its in-memory copy of 8 books predated this branch's
  `similarToTitles` completion work (Sessions 27-31) and never had that
  field. Kept this branch's `similarToTitles` (real work main never had),
  merged in main's `isbn13` values (auto-merged cleanly elsewhere in the
  file), kept identical `tones` values from either side.
- **`data/candidatePool6.json`** (8 blocks) — main still had all 12 of the
  pool-to-pool duplicate objects Session 32 deliberately removed (Boys in
  the Boat, Open, Killers of the Flower Moon, Empire of Pain, Bad Blood,
  Catch and Kill, The Feather Thief, Going Clear, The Lincoln Lawyer, All
  Systems Red, Endurance, Fourth Wing). Kept this branch's deletions —
  verified duplicate-merge work, not re-litigated by an unrelated automated
  job that ran against a stale base.
- **`output/data-quality-report-2026-08-01.{json,md}`** (add/add) — both
  branches independently generated a snapshot for the same date from
  different states. Kept main's (the automated daily pipeline's official
  record) rather than hand-merging point-in-time report content.

Verified post-merge: JSON valid across all 8 data files; 0 duplicate groups
/ 0 broken `similarToTitles` refs / 0 self-citations dataset-wide (1,106
books, unchanged); `eval.js` identical (p10=100, p25=96, MAE=0.758);
`validate_review.js` unchanged. Re-ran the export_(1) dry run after the
merge to confirm findings didn't shift — identical results before/after.
Committed (`ca72901`) and pushed.

**Lesson for future dry runs**: check `git log HEAD..origin/main` before
trusting a comparison — an automated job on `main` can silently diverge
from this branch's data between sessions, and (as seen here) an automated
script's full-file rewrite can make it *look* like data was lost when it
was really just two branches each holding a real, non-overlapping
improvement.

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

1. **Bill fixes the remaining Goodreads-side duplicates** and clarifies any
   status-reversion / unexpectedly-deleted books. *(blocking — waiting on
   this)*
2. **Generate a missing/deleted-books review file after every dry run**:
   `output/missing-books-review-YYYY-MM-DD.md` — one row per book absent
   from the latest export (excluding ones already `dnf: true`, and
   excluding any the matcher's known blind spots resolve on inspection —
   see "Matching strategy" point 3), with a blank reason-code column for
   Bill to fill in and hand back. Never guess a reason; nothing gets
   written to `feedbackData.json` until Bill returns the file. Regenerate
   this fresh on each dry run rather than patching the previous one, since
   the missing set can grow or shrink between exports.
3. **Bill hands back the filled-in review file** — for each book, capture a
   real `reasonCode`/`reasonLabel` dismissal in `feedbackData.json` (same
   schema the app's dismiss button writes), exactly as given, never a
   guessed reason.
4. **Re-export and re-run the matcher** against the cleaned-up Goodreads
   state (removes the 15-duplicate noise from the real diff).
5. **Apply matched-book updates**: shelf/rating/date/pages/year/isbn
   changes, logged individually. `avgRating` always overwritable
   (Goodreads' own live community average); `pages`/`year` only overwritten
   if it doesn't regress a value that looks hand-corrected (cross-check
   against session history in CLAUDE.md before blindly trusting a stale
   Goodreads value over an existing one).
6. **Backfill `bookId`** on every matched book missing one (17 known so
   far, more likely once the duplicates are resolved and re-matched).
7. **Add the new books** (themes/tones/similarToTitles researched inline,
   per Bill's choice) — for each, immediately verify: no bookKey collision,
   all 5 `similarToTitles` resolve to real dataset titles, and — the step
   that just proved itself necessary — check every candidate-pool file for
   an existing unread duplicate of a book that just became `read`.
8. **Reconcile `top10`/`allTimeFave` drift** against the export's custom
   shelves.
9. **Re-run integrity guardrails**: `findDuplicateBooksFuzzy`, broken-ref
   scan, self-citation scan (Session 32's checks) — confirm the merge
   introduced nothing new.
10. **Write via targeted string replacement**, never a full JSON round-trip,
   even at this scale — same discipline as every prior data-editing
   session. Verify via `git diff` that only intended fields changed.
11. **Verify**: JSON validity, `node scripts/eval.js` (protect p10/p25),
    `node scripts/validate_review.js` (informational only, per Session 35),
    regenerate `data_quality_report.js`, commit in logical batches (e.g.
    "shelf/rating updates," "new books added," "bookId backfill," "missing-
    book dismissals" as separate commits).

## Open questions / decisions pending

All resolved:

- **Status-reversion books** (Number Go Up, To Sleep in a Sea of Stars) —
  turned out to be moot by the later dry runs, not an accident needing
  `shelf`/`myRating` changes. *Number Go Up* was captured as a genuinely
  missing book and dismissed (`started_did_not_like`). *To Sleep in a Sea
  of Stars* stayed absent, consistent with its pre-existing `dnf: true`
  flag and an existing `feedbackData.json` entry that predates this whole
  import effort — nothing to touch.
- **`Read Count` (re-reads)** — Bill's call: leave it out of scope. Not
  used by any scoring signal today; adding a field with no consumer is
  dead weight. The 5 books with `Read Count` > 1 (Steve Jobs ×3, Lessons
  in Chemistry ×2, LIV and Let Die ×2, American Overdose ×2, The Hike ×2)
  are left as-is.
- **Final validation + reasons for the missing books** — done; all 11
  resolved (see "All 11 missing books now resolved" above).

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
- **Resolved (Bill's call): use the pre-existing `goodreadsUrl` over the
  fresh search result for all 31 disagreements** — extracted the ID already
  embedded in each book's `goodreadsUrl` and wrote it as an explicit
  `bookId` field (previously only implicit in the URL string). All 159
  candidate-pool books now carry an explicit `bookId`.
- Committed and pushed (`8832a8f` blank-book backfill, `a05b2a3`
  goodreadsUrl-derived backfill for the other 67). Verified: JSON valid,
  diffs show only the intended insertions, `eval.js` unaffected (bookId
  isn't read by any scoring path).

## Second dry run: export_3.csv (806 rows, after Bill's Goodreads cleanup)

Bill fixed data directly on Goodreads and re-exported. Re-ran the same
matcher (no data files changed — explicitly another test run).

**Progress confirmed:**
- Duplicate groups: **15 → 2 remaining** (*Black Sheep*, *Cassandra in
  Reverse* — both still two to-read entries each).

**New issue found:** *Behind Closed Doors* now shows a single Goodreads
entry (same `Book Id` 29437949 on both sides — not a duplicate-merge
artifact this time) with its rating cleared: `read, 5★` on our side vs.
`read, unrated` in the export. Looks like the rating got wiped while
resolving the duplicate, not left over from the other copy. Worth checking
directly on Goodreads.

**Two books now fully gone (not just reverted) — previously softer findings
that hardened**:
- *Number Go Up* — was `to-read, unrated` (same single entry, reverted)
  last run; now absent from the export entirely.
- *Survival of the Thickest* — was one of the 15 duplicate pairs; now
  neither copy is present.

**Unchanged from the first dry run:**
- *In Good Faith* (currently-reading → read, 5★) and *Stoner* (to-read →
  currently-reading) — real progress, still just waiting on the actual
  import to apply.
- *The Three-Body Problem* (3★ → 2★) — still looks like a genuine re-rate.
- *To Sleep in a Sea of Stars* — still absent, still consistent with its
  existing `dnf: true` flag, nothing new.

**Missing-books list, now 9 confirmed real** (up from 7): the original 7
(*Unhinged Habits, The Origins of the Cornbread Mafia, 11/22/63, World
Travel, Coach, The Real Hoosiers, Children of Time*) plus the 2 new ones
above (*Number Go Up, Survival of the Thickest*). The raw diff also flagged
*The Antisocial Network* and *Raised* again — confirmed both are still just
the same matcher blind spot from the first run (retitled book, truncated
title), not really missing; re-verified by hand both still resolve.

---

## Lessons Learned (post-import retrospective)

Written after the real import landed on `main` and after a live bug (stale
Stoner entry) surfaced post-deploy. For whoever runs the next import.

### What went well

- **Zero data corruption.** Every write used surgical byte-span
  text-splices, never `JSON.parse`+`stringify`, verified with `git diff`
  before every commit. Across ~15 writes touching 3 files, not one
  accidental reformat or unrelated-field change.
- **Cheap, consistent verification.** `eval.js`/`validate_review.js` after
  every batch caught nothing wrong, but at near-zero cost — worth keeping
  as a reflex on any data change, not just imports.
- **Caught the already-read-in-pool bug proactively.** Recognized mid-import
  that adding a new read (*The Last Flight*) meant it needed to come out of
  `candidatePool.json` too, rather than waiting for a report to flag it.
- **Conservative on bad source data.** The export had implausible page
  counts on some rows even with confirmed `Book Id` matches (e.g. 304→1) —
  chose to skip `pages`/`year`/`isbn` for this round rather than risk
  propagating garbage.

### What didn't go well

1. **`currentlyReading.json` was never in scope, and it should have been.**
   The plan was framed as "reconcile the CSV export against
   `goodreadsData.json`," but a book's real state lives across three files
   that sync on different schedules (manual CSV import,
   RSS-based `sync_goodreads.py`, RSS-based `sync_currently_reading.py`).
   Stoner got dismissed correctly in `feedbackData.json` and correctly
   marked absent in `goodreadsData.json`, but nobody cross-checked the
   third file — it sat stale until Bill caught it live on the site. The
   plan's blast radius was too narrow for what "one book's state" actually
   means in this repo.
2. **Open questions went stale in this doc.** When asked to walk through
   remaining open items, two ("status reversions," "Read Count") were
   reported as still unresolved when in fact later dry runs had already
   settled them — this doc just hadn't been updated in real time as new
   evidence closed them out. The living-doc discipline slipped: questions
   need to close the moment they're resolved, not in a later cleanup pass.
3. **Branch divergence with `main` cost real time.** Automated GitHub
   Actions kept moving `main` independently (ISBN backfill, metadata
   enrichment, daily reports) while dry runs were happening on the feature
   branch, forcing a real merge with conflict resolution mid-import. This
   should be a pre-flight check at the start of every dry run, not
   something discovered partway through (see "Lesson for future dry runs"
   above, from Session-level branch sync — this generalizes it).
4. **Briefly conflated two unrelated "duplicate" problems**: Session 32's
   internal `candidatePool*.json` duplicate-book-object issue vs. this
   import's "Bill has the same book shelved twice on Goodreads under
   different Book Ids." Superficially similar, structurally unrelated —
   cost a few minutes of confusion before checking the data directly and
   separating them.
5. **No live-site verification step.** Nothing in the process checked the
   actual deployed app after pushing to `main`. The Stoner bug was only
   caught because Bill happened to look — a post-push smoke check would
   have caught it without requiring a manual report.

### Concrete improvements for next import

- **Build a cross-file consistency check** (same spirit as
  `data_quality_report.js`'s existing checks): flag any book dismissed/
  excluded in `feedbackData.json` but still present in
  `currentlyReading.json` or any `candidatePool*.json`, or any book absent
  from the latest export but not marked `dnf`. Turns the ad hoc checking
  done by hand this session into something repeatable and automatic.
- **Check `git log HEAD..origin/main` before every dry run**, not just
  once — make it step 0 of the phase list.
- **Update "open questions" the moment they resolve**, not in a batch
  cleanup later.
- **Add a cheap post-push sanity step**: after pushing to `main`, pull the
  2-3 highest-visibility data surfaces (currently-reading, top
  recommendations) and eyeball them against what should be there.
