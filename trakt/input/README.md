# trakt/input/

Manual data-entry drop folder — the fallback for a title whose real
Rotten Tomatoes / Metacritic critic score genuinely cannot be resolved
automatically (this sandbox can't fetch either site directly, and
WebSearch snippets don't always surface an exact numeric score for a
lower-profile title).

Only used after real effort to fix it in code first — a URL-guessing
bug, a title collision, a year/season disambiguation gap — per this
project's standing discipline (see `scrape_show_ratings.py`'s own
history of fixed bugs). This folder is for the genuine residual: a
title where the real page was found (or confirmed to exist) but the
exact score couldn't be confirmed here, or a title confirmed to have no
review coverage on one or both sites.

`critic_score_manual_entry.csv` columns: `titleKey`, `title`, `year`,
`field` (one of `rottenTomatoes`/`rtAudience`/`metacritic`/
`metacriticUser`), `currentValue` (always blank/null — that's why it's
listed), `note` (what was tried / where the real page is, if known).
Fill in a real value from the actual RT/MC page and it can be applied
directly to `trakt/data/scrapedShowRatings.json`.
