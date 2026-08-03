# Missing / Deleted Books — Review Needed

Generated 2026-08-03, updated after the third BBIP dry run
(`goodreads_library_export (1).csv`, pulled from `input/goodreadsextract/`
on `main`) — 2 new books added since the first version of this file.

These are books currently in `data/goodreadsData.json` that do not appear anywhere
in the latest Goodreads export — meaning they've been removed from your
Goodreads shelves entirely. Since there's no DNF shelf, this absence is the
only signal we have that you're no longer interested in a book (per your
Aug 2026 call on how BBIP should detect this).

**Fill in a reason for each book below and hand this file back.** Nothing
gets written to `feedbackData.json` until you do — no reason is ever
guessed. Pick a reason code from the list below, or write your own note if
none fit.

## Valid reason codes

| Code | Meaning |
|---|---|
| `not_interesting` | Doesn't look interesting |
| `topic_doesnt_appeal` | Topic doesn't appeal |
| `not_my_vibe` | Not my vibe |
| `started_did_not_like` | Started it, didn't like it |
| `no_longer_relevant` | No longer relevant (timing/life circumstances) |
| `already_seen_adaptation` | Already saw the movie/show |
| `already_read_or_owned` | Already read or own it |
| `dont_know_author` | Don't know the author |
| `too_long` | Too long for what it offers |

(These are the same codes the live site's dismiss button writes — using one
of these means the dismissal feeds BBRE's real generalization signal, not
just a data-hygiene note.)

## Books to review

| Title | Author | Last Known Shelf | Last Known Rating | Reason code | Notes |
|---|---|---|---|---|---|
| Unhinged Habits: A Counterintuitive Guide for Humans to Have More by Doing Less | Jonathan Goodman | to-read | — | | |
| The Origins of the Cornbread Mafia: A Memoir of Sorts | Joe Keith Bickett | read | 4★ | | |
| 11/22/63 | Stephen King | read | 5★ | | |
| World Travel: An Irreverent Guide | Anthony Bourdain | read | 5★ | | |
| Coach: Lessons on the Game of Life | Michael Lewis | read | 5★ | | |
| The Real Hoosiers: Crispus Attucks High School, Oscar Robertson, and the Hidden History of Hoops | Jack McCallum | read | 2★ | | |
| Children of Time (Children of Time, #1) | Adrian Tchaikovsky | to-read | — | | |
| Number Go Up: Inside Crypto's Wild Rise and Staggering Fall | Zeke Faux | read | 2★ | | |
| Survival of the Thickest: Essays | Michelle Buteau | to-read | — | | |
| Behind Closed Doors (Behind Closed Doors, #1) | Lisa Renee Jones | read | 3★ | | |
| Stoner | John Williams | to-read / currently-reading | — | | |

## Notes on the two new additions

- **"Behind Closed Doors" by Lisa Renee Jones** is a *different book* from
  the B.A. Paris novel of the same bare title — that one is fine, still
  correctly matched at 5★. This is the separate Lisa Renee Jones series
  entry, which is the one that's now gone from your account.
- **Stoner** was also being tracked separately in `currentlyReading.json`
  (its own sync, `currently-reading`) — it's disappeared from the main
  export entirely, so worth confirming whether that was intentional.

## Not on this list (already resolved, no action needed)

- **The Antisocial Network** and **Raised** looked missing in the raw diff
  but both resolve fine on inspection (retitled edition, truncated title on
  our side) — not actually gone, not on this list.
- 135+ other absent books already carry `dnf: true` in our data — their
  absence is expected and already accounted for, not re-litigated here.
