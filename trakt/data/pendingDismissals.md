# Pending Streaming Top 10 Dismissals

Bill (2026-09-26): "Is there a way to do this that doesn't require my
intervention?" — the honest answer is that a static site with no backend
genuinely can't commit to a public repo on its own without exposing a
write credential in the browser, a real security risk this project has
always avoided. This file is the safe alternative: you already have
real write access to this repo, so editing this file yourself (via
GitHub's own web editor, or however you like) and committing it IS the
real commit — no token, no proxy, no new infrastructure.

**How to use it:** whenever you want to log a dismissal (from The
Streaming Top 10, or anywhere else), add one line below the `---`
marker, in this exact format:

```
- Title | reasonCode
```

`trakt/streaming-top10.js`'s "Copy for pendingDismissals.md" button
copies your locally-queued dismissals in this exact format, so you can
paste them straight in during a periodic batch — but typing a line by
hand works just as well.

**Valid reasonCodes** (the same 14 real, currently-used codes the
Streaming Top 10 page's own dismiss dialog offers — see
`trakt/streaming-top10.js`'s `REASON_LABELS` for the source of truth):

| reasonCode | Meaning |
|---|---|
| `not_interested` | General pass, no specific reason |
| `doesnt_look_good` | Doesn't look good from the trailer/premise |
| `too_boring` | Looks boring/slow-paced |
| `too_hokey` | Too hokey/campy |
| `too_comicbooky` | Too comic-booky/superhero |
| `too_low_brow` | Feels lower-brow/network procedural |
| `too_urban` | Urban crime-drama fatigue |
| `too_kiddish` | Too young-skewing/juvenile |
| `aimed_at_older_demographic` | Skews toward an older demographic |
| `too_old` | Feels dated |
| `looks_low_budget` | Looks low-budget |
| `not_english_language` | Feels too foreign-language/subtitled |
| `already_watched` | Already watched (missing from your Trakt data) |
| `already_have_version_rated` | Already have a different version rated |

A typo or unrecognized code isn't a problem — `trakt/process_pending_
dismissals.py` records whatever you write rather than dropping the
line, so nothing you add here is ever silently lost.

**What happens next:** `.github/workflows/trakt-process-pending-
dismissals.yml` picks up any commit that touches this file automatically
(usually within a few minutes), resolves each title against your real
library/watchlist/candidatePool data, converts each line into a real
`trakt/data/feedbackData.json` interaction, and clears the processed
lines from below — so this file only ever shows what's still waiting to
be picked up.

---

- ZZZ_TEST_ENTRY_DELETE_ME_DO_NOT_KEEP | not_interested
