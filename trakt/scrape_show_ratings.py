#!/usr/bin/env python3
"""
Closes the real gap found in Session 52: OMDb's API returns Rotten
Tomatoes/Metacritic scores for movies but essentially never for TV shows
(confirmed against OMDb's own GitHub issue tracker — a TV query with
tomatoes=true still comes back N/A for every RT field; not a bug in
enrich_omdb.py's extraction). Both RT and Metacritic genuinely do carry
show-level scores on their own sites, they're just not exposed through
OMDb's API — so this scrapes them directly via Playwright, the same
approach scrape_ratings.py already uses for Amazon on the book side.

Results are cached separately in trakt/data/scrapedShowRatings.json
(never blended into omdbMetadata.json itself, so the source of every
value stays traceable — same discipline that keeps TMDB/OMDb/scraped
data in three separate cache files throughout this project) and merged
at read time by dashboard.js/recommend.js/prune_candidate_pool.js: OMDb's
own rottenTomatoes/metacritic values win when present (movies), this
cache fills the gap only when OMDb has neither (mostly shows).

Keyed by titleKey (exact TMDB id) rather than a fuzzy title match — every
title in this project already carries one, sidestepping the whole
title-matching bug class the book side's scraper has to work around via
book_key(). Each site is searched independently via that site's own
search page (not a third-party search engine, since this sandbox's
network egress proxy blocks Google/DuckDuckGo/Bing too when tested, and
using the site's own intended search feature is also the more legitimate
approach).

RESULT OF 3 REAL LIVE TEST BATCHES (see SCRAPE_RT below): Metacritic
verified accurate via spot-check against real outside sources (Elsbeth
scraped 69, real Metascore is 69 exactly). Rotten Tomatoes was
confirmed WRONG on the same title in all 3 attempts (scraped 62%
against a real 92% Tomatometer, despite correctly identifying the
right show entity) and the root cause couldn't be pinned down further
without live page inspection this sandbox can't do. Per Bill's own
explicit fallback instruction ("if it works for MC but not RT, just
use MC"), RT scraping is now disabled (SCRAPE_RT = False) — only
Metacritic data is trusted and wired into scoring.

A FULL DATA-QUALITY AUDIT of the real 447-title production batch found
Metacritic itself is NOT immune to the same wrong-page failure shape
that killed RT above, just less often: the direct-URL-slug-guess
strategy has no confirmation step, so a title whose bare slug is
already occupied by a DIFFERENT same-named work (an older show, a
reboot's original) silently lands a real but wrong Metascore instead of
a miss. Confirmed via real outside cross-checks on 9 titles: 3 unreleased
shows (Cupertino/Neagley/Crystal Lake, each showing a fabricated 93-97
"critic score" despite zero aired episodes) and 6 title collisions
(Lost in Space 2018 reboot scored 93 from the wrong 1965-original page
vs. its real 58; Perry Mason 2020 scored 96 from the wrong classic-
franchise page vs. its real 68; The Agency 2024 scored 97 vs. its real
"Generally Favorable" band; Legends 2026 scored 59 from the wrong 2014
show's page vs. its real 75; plus Ambitions and Elway, both landing a
score despite genuinely having none yet on Metacritic). All 9 corrected
to null in the committed cache. Root cause fixed with two independent,
conservative guards, both unit-tested (never require a signal to be
present, only reject on an explicit, positive conflict — the same
asymmetric discipline resolve_titles.py's is_confident_match() already
uses): is_unreleased() discards any score for a title with a known
future release/air date outright; extract_metascore()/
page_title_matches() cross-check the fetched page's own JSON-LD date
field and <title> tag against the expected title/year before trusting
anything scraped from it.

A FULL RE-SCRAPE with those guards deployed (447 titles) then exposed a
real gap in that fix: is_unreleased() worked (3/3 real hits), but 6 of
the 9 originally-confirmed-wrong titles (Elway, Ambitions, The Agency,
Lost in Space, Perry Mason, Legends) came back with the EXACT SAME wrong
scores as before — the wrong page for each apparently states no
explicit conflicting year anywhere in its <title> or JSON-LD, so that
guard had nothing to act on (deliberately asymmetric — it was built to
never reject a legitimate no-year match like The Boys or Fleabag, and
that same caution left it with no signal here). All 6 corrected back to
null again. Fixed with a HARDER signal, page_imdb_matches(): every title
reaching this script is already OMDb-eligible, which itself requires a
resolved IMDb id — cross-checking Metacritic's own IMDb reference (a
generic imdb.com/title/ttNNNNNNN scan across the whole page, not one
assumed markup location) against that already-known id is an exact-id
comparison, not fuzzy text matching, and is treated as authoritative
when it can run: a mismatch rejects outright regardless of what the
title check says, a confirmed match skips the title check entirely, and
"no id found on the page at all" falls back to the pre-existing title/
date check unchanged. Unit-tested against all 6 real newly-confirmed-bad
cases (synthetic HTML reconstructing "wrong page, no year signal, wrong
imdb id present" — every one now correctly rejected) plus every prior
regression case (The Boys, Fleabag, no-imdb-known candidates). NOT yet
verified against a real live re-scrape at the time of this commit — this
sandbox still can't fetch metacritic.com to confirm the real wrong pages
actually carry a mismatched (not just absent) IMDb reference the way the
fix assumes; the next real scheduled or manual run is the actual test,
same discipline as every other scraper fix in this project's history.

Run manually:   python3 trakt/scrape_show_ratings.py [batch_size]
GitHub Action:  .github/workflows/trakt-scrape-show-ratings.yml
"""

import json, re, sys, time, random
from datetime import datetime, timedelta
from html import unescape
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
CACHE_FILE = DATA_DIR / 'scrapedShowRatings.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 40
# Calibrated for RT originally (known aggressive bot protection); with RT
# now disabled, 3 real Metacritic-only test batches showed no sign of
# rate-limiting or blocking at all, so this can run faster. Still a real
# delay, not zero, since this is still a live third-party site.
MIN_DELAY = 3
MAX_DELAY = 6
RETRY_COOLDOWN_DAYS = 14   # same convention as scrape_ratings.py: a miss
                            # (not a permanent "no score exists") is retried
                            # after this long, a real score is cached forever

# RE-ENABLED after root-causing the real bug (see extract_rt_scores()'s
# docstring): the failure across all 3 prior attempts wasn't a wrong
# page or a scale-confusion bug (both already ruled out/fixed earlier) —
# it was the scraper accepting ANY aggregateRating block with
# bestRating==100 on the page, last-one-wins, with no check that the
# block's own `name` actually named the show being looked up. A show
# page can embed more than one such block (a "similar shows" rail is
# common). Fixed via name_field_matches_title() preferring a
# name-matched block, re-verified against 12 real, independently
# researched Tomatometer scores (12/12 matched within a few points —
# see the trakt-verify-rt.yml workflow run history) before being
# trusted here. rtAttempted (stamped on every cache write once RT is
# genuinely attempted, hit or miss) lets load_pending() backfill RT for
# titles that already had a real Metacritic score cached from the
# SCRAPE_RT=False era, without re-scraping Metacritic needlessly.
SCRAPE_RT = True


def load_cache():
    if CACHE_FILE.exists():
        return json.load(open(CACHE_FILE))
    return {}


def save_cache(cache):
    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    with open(CACHE_FILE, 'a') as f:
        f.write('\n')


def is_unreleased(release_date):
    """A title with a known future release/air date can't have a real
    critic score yet, no matter what a scrape returns for it — a
    confirmed real bug in the wild (a full data-quality analysis pass
    found 3 unreleased titles, Cupertino/Neagley/Crystal Lake, each with
    an implausible 93-97 "critic score" despite zero episodes having
    aired; cross-checked against real outside sources, which confirmed
    none of the three has any critic reviews yet). Root cause not fully
    pinned down without live access to the actual page (this sandbox
    can't fetch metacritic.com directly), but the leading hypothesis is
    an "anticipation"/hype-poll widget on the pre-release page getting
    misread as a critic aggregateRating by scrape_metacritic()'s JSON-LD
    parser, which assumes a missing bestRating means a 0-100 critic
    scale rather than treating it as ambiguous. Rather than chase the
    exact parsing bug blind, this is a robust plausibility gate at the
    point of use: any score for a title we already know hasn't aired yet
    is impossible on its face and discarded regardless of source."""
    if not release_date:
        return False
    try:
        return datetime.strptime(release_date, '%Y-%m-%d') > datetime.utcnow()
    except ValueError:
        return False


def page_imdb_matches(expected_imdb_id, html_content):
    """Cross-check Metacritic's own IMDb reference against the IMDb id
    already known for this title (every title reaching this scraper is
    OMDb-eligible, which itself requires a resolved IMDb id — see
    load_pending()) — an exact-id comparison, not fuzzy text matching, so
    it's a much harder signal than page_title_matches() below.

    Built after a real production run exposed that title/date checking
    alone isn't sufficient: a full re-scrape (447 titles, after
    page_title_matches()/extract_metascore() first shipped) still landed
    the exact same wrong scores on 6 of the 9 originally-confirmed-wrong
    titles (Elway, Ambitions, The Agency, Lost in Space, Perry Mason,
    Legends) — the guessed wrong page for each apparently doesn't state
    an explicit conflicting year anywhere in its <title> or JSON-LD, so
    that check had nothing to act on. An id is a much smaller surface for
    a "looks right but isn't" false negative than a human-readable title
    string.

    Scans the raw page HTML for ANY imdb.com/title/ttNNNNNNN reference
    rather than depending on one specific markup location (an infobox
    link, a JSON-LD sameAs field, etc.) — this sandbox can't fetch a real
    page to know exactly where Metacritic embeds it, so a generic scan is
    the more robust choice over guessing one exact selector/field.

    Returns True (a matching id was found — treat as strongly confirmed,
    the caller may skip the softer title check entirely), False (an id
    was found and it does NOT match — a confirmed wrong page, reject
    regardless of what the title check would say), or None (no IMDb id
    found anywhere on the page — can't verify this way, caller should
    fall back to page_title_matches())."""
    if not expected_imdb_id:
        return None
    ids_found = set(re.findall(r'imdb\.com/title/(tt\d+)', html_content))
    if not ids_found:
        return None
    return expected_imdb_id in ids_found


def page_title_matches(expected_title, expected_year, html_content):
    """Verify the fetched page's own <title> tag plausibly refers to the
    title being looked up, not a different work landed via the direct-
    URL-slug-guess strategy (see scrape_metacritic()'s docstring — that
    strategy has no built-in confirmation step at all). A real, confirmed
    bug found by a full data-quality audit: guessing
    metacritic.com/tv/lost-in-space/ silently resolved to a DIFFERENT
    "Lost in Space" page than the 2018 reboot actually being tracked
    here, landing a fabricated Metascore of 93 vs. the real 2018 reboot's
    actual 58 (verified against real outside sources) — the exact same
    failure hit /tv/perry-mason/ (96 vs. the real perry-mason-2020's 68)
    and /tv/the-agency/ (97 vs. the real the-agency-2024's "Generally
    Favorable" band, nowhere near 97). All three are reboots/remakes that
    share a bare title with an older, unrelated work — the same title-
    collision failure shape resolve_titles.py's is_confident_match() was
    already built to guard against on the manual-resolution side of this
    pipeline, just missing here on the scraping side until now.

    Deliberately asymmetric, and only ever rejects on a POSITIVE
    conflict — an earlier version of this function required a year to be
    present in the title for anything under 15 normalized characters,
    which sounded like the same discipline is_confident_match() uses,
    but a unit test replaying real confirmed-good matches (The Boys,
    Fleabag, Squid Game, Ambitions — none of which show a year in their
    real Metacritic <title>, since none of them actually collide with an
    older same-named work) immediately caught it as wrong: it would have
    silently discarded a large share of genuinely correct short-title
    matches, not just the real bad ones. A title with no collision risk
    simply never gets a year suffix at all, so requiring one can't tell
    "no collision" apart from "wrong page" — only an explicit,
    disagreeing year can.

    Returns True (title matches, and either no year is stated or it
    agrees), False (confirmed mismatch — either the title itself doesn't
    match, or the page states an explicit year that conflicts with the
    one expected — the caller should discard the result, same as a real
    miss), or None (couldn't check at all — no <title> tag found —
    caller should fall back to the pre-existing, unverified behavior
    rather than discard a possibly-good result on a technicality)."""
    m = re.search(r'<title[^>]*>(.*?)</title>', html_content, re.I | re.S)
    if not m:
        return None
    page_title = unescape(m.group(1))
    norm = lambda s: re.sub(r'[^a-z0-9]+', '', s.lower())
    exp_norm = norm(expected_title)
    page_norm = norm(page_title)
    if not exp_norm or exp_norm not in page_norm:
        return False
    if expected_year:
        year_match = re.search(r'\((\d{4})\)', page_title)
        if year_match and int(year_match.group(1)) != int(expected_year):
            return False
    return True


def extract_metascore(html, title, year, imdb_id=None):
    """Parses a fetched Metacritic page's raw HTML for a critic Metascore
    and/or user score. Pulled out of scrape_metacritic() into its own
    pure function (no Playwright dependency) specifically so it's
    directly unit-testable against synthetic HTML — the same discipline
    resolve_titles.py's is_confident_match() already gets, applied here
    after a full data-quality audit found this exact code path producing
    confirmed-wrong scores for several real titles (see
    page_title_matches()'s docstring). Returns (metascore, userScore),
    either or both possibly None."""
    metascore = user_score = None
    # Round 5, a real production re-scrape this session: rounds 3 and 4
    # (the ratingCount=0 guard, then the exact-97/98 guard) were BOTH
    # verified live and BOTH found not working — Elway/Ambitions/Thieves'
    # Highway/Kyle XY all came back with the exact same wrong scores a
    # second time, guards live and all. Root cause, found by re-reading
    # this function's own control flow rather than guessing at a 5th
    # content heuristic: when a guard above does `continue`, it correctly
    # skips setting `metascore` from THIS aggregateRating block — but the
    # regex fallback below (`if metascore is None: ...`) doesn't know a
    # value was deliberately rejected versus never found at all, and
    # re-scans the ENTIRE raw HTML for any text matching "Metascore: NN"
    # — which finds the identical fabricated number rendered as plain
    # text elsewhere on the same page, completely bypassing every content
    # guard above it. This `rejected` flag is the actual fix: any guard
    # that deliberately discards a candidate value now also sets it, and
    # the regex fallback is skipped entirely when set — a considered "no,"
    # not a "we don't know, keep looking."
    rejected = False
    for ld_raw in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            obj = json.loads(ld_raw)
            objs = obj if isinstance(obj, list) else [obj]
            for o in objs:
                if not isinstance(o, dict):
                    continue
                ar = o.get('aggregateRating')
                if ar and ar.get('ratingValue'):
                    # Cross-check the SAME object's own date field
                    # against the year expected, when both are present —
                    # more reliable than the <title>-tag check below
                    # since it's structured data tied directly to the
                    # entity that produced this aggregateRating, not a
                    # human-facing string that may or may not mention a
                    # year at all. Same asymmetric rule as
                    # page_title_matches(): only a positive, explicit
                    # conflict disqualifies — a missing date field can't
                    # tell "no collision" apart from "wrong page," so it
                    # falls through unchanged.
                    own_date = o.get('datePublished') or o.get('startDate')
                    if year and own_date:
                        dm = re.match(r'(\d{4})', str(own_date))
                        if dm and int(dm.group(1)) != int(year):
                            continue
                    # Two content guards, both real-data-audit findings this
                    # session (Elway/Ambitions/Thieves' Highway/Kyle XY all
                    # scraped a suspiciously high score from their own
                    # correct page despite having zero real critic reviews,
                    # confirmed via WebSearch): (1) reject when the JSON-LD's
                    # own ratingCount/reviewCount is explicitly present and
                    # zero; (2) reject a Metascore of exactly 97 or 98 with
                    # no real count to back it — every score >=90 in the
                    # real cache that landed on exactly 97 or 98 turned out
                    # fabricated, while every genuine acclaimed title lands
                    # at 90-95, never exactly 97/98. Both asymmetric like
                    # every guard here: an absent count can't tell "no
                    # reviews" from "count just isn't emitted," so it never
                    # blocks a title that lacks the count field entirely.
                    count = ar.get('ratingCount')
                    if count is None:
                        count = ar.get('reviewCount')
                    val = float(ar['ratingValue'])
                    best = ar.get('bestRating')
                    best_num = float(best) if best not in (None, '') else None
                    if best_num == 100 or best_num is None:
                        candidate = round(val)
                        if (count is not None and int(count) == 0) or (candidate in (97, 98) and count is None):
                            # Confirmed live this session: simply skipping
                            # the assignment here used to still let the
                            # regex fallback below re-find this exact same
                            # fabricated number elsewhere in the raw page
                            # text — both content guards above were
                            # verified working in isolation but verified
                            # NOT working end-to-end for that reason, twice,
                            # against real re-scrapes. `rejected` closes
                            # that hole: a deliberate rejection here now
                            # means "no," not "keep looking."
                            rejected = True
                            continue
                        metascore = candidate
                    elif best_num == 10:
                        user_score = round(val * 10)
        except Exception:
            pass

    if metascore is None and not rejected:
        mm = re.search(r'Metascore["\s:]+(\d{1,3})\b', html)
        if mm:
            metascore = int(mm.group(1))

    # Confirm the page we actually landed on is the title we meant to
    # look up before trusting anything scraped from it. Try the hard
    # signal first (an exact IMDb id match, per page_imdb_matches()'s
    # docstring — built after a real production run showed the softer
    # title/date check alone wasn't sufficient); an id match is treated
    # as authoritative and skips the title check entirely, an id
    # mismatch rejects immediately regardless of what the title check
    # would say, and "no id found at all" falls back to the pre-existing
    # title/date check unchanged.
    if metascore is not None or user_score is not None:
        imdb_check = page_imdb_matches(imdb_id, html)
        if imdb_check is False:
            return None, None
        if imdb_check is None and page_title_matches(title, year, html) is False:
            return None, None

    return metascore, user_score


def _in_cooldown(entry):
    """A real score is permanent; a total miss is retried after
    RETRY_COOLDOWN_DAYS — the same one-off-failure-vs-real-no-data
    distinction scrape_ratings.py already makes for Amazon. Factored out
    of is_cached_done() so load_pending() can reuse it for the
    MC-specific "still worth retrying" check independent of RT."""
    if entry is None:
        return False
    checked_at = entry.get('checkedAt')
    if not checked_at:
        return False
    try:
        age = datetime.utcnow() - datetime.strptime(checked_at, '%Y-%m-%d')
    except ValueError:
        return False
    return age < timedelta(days=RETRY_COOLDOWN_DAYS)


def is_cached_done(entry):
    """A real score (rt or mc found) is permanent. A total miss is on
    cooldown for a while before being retried."""
    if entry is None:
        return False
    if entry.get('rottenTomatoes') is not None or entry.get('metacritic') is not None:
        return True
    return _in_cooldown(entry)


def load_pending(cache):
    """OMDb-enriched titles where OMDb itself has neither RT nor MC — the
    exact gap this script exists to close. No point scraping a title
    OMDb already answered (mostly movies), and no point scraping a title
    with no OMDb record at all yet (enrich_omdb.py needs to run first;
    title/year for the search query come from enrichedMetadata.json,
    which every title here already has by construction).

    Each returned title carries needsMC/needsRT so main() knows exactly
    what to (re)scrape — critically, a title whose Metacritic score is
    already real and cached does NOT get needsMC=True just because it
    also needs an RT backfill (see below), so main() never re-touches an
    already-good MC value. needsRT is gated on rtAttempted, a stamp
    added to every cache write once RT is genuinely attempted (hit or
    miss) — this makes the RT-was-disabled-for-a-while backfill
    self-limiting: a title only ever needs one real RT attempt, and
    every already-cached MC-only entry from the SCRAPE_RT=False era
    naturally gets exactly one such attempt across however many runs it
    takes, never repeatedly."""
    omdb = json.load(open(DATA_DIR / 'omdbMetadata.json')) if (DATA_DIR / 'omdbMetadata.json').exists() else {}
    enriched = json.load(open(DATA_DIR / 'enrichedMetadata.json')) if (DATA_DIR / 'enrichedMetadata.json').exists() else {}

    titles = []
    seen = set()
    for name in ('watchlist.json', 'library.json', 'candidatePool.json'):
        p = DATA_DIR / name
        if not p.exists():
            continue
        for t in json.load(open(p)).get('titles', []):
            key = t.get('titleKey')
            if not key or key in seen:
                continue
            omdb_entry = omdb.get(key)
            if not omdb_entry:
                continue  # not OMDb-enriched yet, out of scope for this script
            if omdb_entry.get('rottenTomatoes') is not None or omdb_entry.get('metacritic') is not None:
                continue  # OMDb already answered this one (almost always a movie)
            meta = enriched.get(key, {})
            title = meta.get('title') or t.get('title')
            year = meta.get('year') or t.get('year')
            if not title:
                continue
            seen.add(key)

            cached = cache.get(key)
            needs_mc = cached is None or (cached.get('metacritic') is None and not _in_cooldown(cached))
            needs_rt = SCRAPE_RT and (cached is None or not cached.get('rtAttempted'))
            if not needs_mc and not needs_rt:
                continue  # fully resolved already (or a fresh miss still on cooldown)

            release_date = meta.get('releaseDate') or meta.get('firstAirDate')
            # Every title reaching this point is OMDb-eligible (checked
            # above), which itself requires a resolved IMDb id — so this
            # should be present for essentially every title, from either
            # the raw Trakt export (library/watchlist) or TMDB's
            # external_ids backfill (candidatePool stubs, which have no
            # ids.imdb of their own). Threaded through to
            # page_imdb_matches() for a real, verified fix — see its
            # docstring.
            imdb_id = t.get('ids', {}).get('imdb') or meta.get('imdbId')
            titles.append({'titleKey': key, 'type': t.get('type'), 'title': title, 'year': year,
                            'releaseDate': release_date, 'imdbId': imdb_id,
                            'needsMC': needs_mc, 'needsRT': needs_rt})

    return titles


# ── Rotten Tomatoes ──────────────────────────────────────────────────────

def name_field_matches_title(name, expected_title):
    """Does a JSON-LD block's own `name` field plausibly refer to the
    title being looked up? Same normalized-substring discipline as
    page_title_matches(), applied per-block instead of to the whole
    page — built for a real gap found while investigating RT's 3x
    Elsbeth failure (62% scraped vs. a real 92% Tomatometer, on a page
    that WAS the correct show — see extract_rt_scores()'s docstring for
    why this is a different bug than the wrong-page problem
    page_imdb_matches()/page_title_matches() already guard against).

    scrape_rt()'s original version accepted ANY aggregateRating block on
    the page with bestRating==100, last-one-wins — with no check that
    the block's own `name` actually names the show being looked up. A
    show page can legitimately embed more than one aggregateRating block
    (a "similar shows"/recommendations rail is common), so a wrong block
    can pass the scale check while belonging to a different title
    entirely. Returns True/False when `name` is present, None when it's
    absent (can't check — caller should treat as unverified, not
    rejected, since RT's own structured data doesn't always include a
    name on every block)."""
    if not name:
        return None
    norm = lambda s: re.sub(r'[^a-z0-9]+', '', s.lower())
    exp_norm, name_norm = norm(expected_title), norm(name)
    if not exp_norm or not name_norm:
        return None
    return exp_norm in name_norm or name_norm in exp_norm


def extract_rt_scores(html, title, year, imdb_id=None):
    """Parses a fetched RT page's raw HTML for a Tomatometer (critic) /
    Popcornmeter (audience) score. Pulled out of scrape_rt() into its
    own pure function (no Playwright dependency), mirroring
    extract_metascore()'s design exactly — directly unit-testable, and
    subject to the same guard discipline that fixed the Metacritic
    scraper after its own 5-round saga.

    Two independent problems, addressed separately:

    (1) WRONG BLOCK on the RIGHT page. Session 52's first live test
    found RT's page embeds MORE THAN ONE JSON-LD aggregateRating block
    (a 0-100 critic score and a 5-star audience score are both present,
    sometimes for MULTIPLE titles via a same-page "similar shows" rail)
    — a naive "value > 5 means it's already a percentage" heuristic
    grabbed the wrong one on Elsbeth (scraped 62%, real Tomatometer 92%
    — 62 = round(3.1 * 20), consistent with an audience block).
    Disambiguating by `bestRating` (100 vs. 5) fixed the scale confusion,
    but 3 real live test batches STILL scraped the same wrong 62% on the
    same title afterward, despite correctly landing on Elsbeth's own
    page — meaning scale alone isn't enough to pick the RIGHT
    aggregateRating block when a page embeds more than one. Fixed here
    by preferring a block whose own `name` field matches the expected
    title (name_field_matches_title()) over one that doesn't or has no
    name at all — the same "verify identity, not just shape" discipline
    extract_metascore() already uses at the whole-page level, applied
    here at the per-block level where the actual ambiguity lives.

    (2) WRONG PAGE entirely (the title-collision failure class that hit
    Metacritic — a bare-slug guess or search-result click landing on a
    different, same-named work). Guarded the same way as
    extract_metascore(): page_imdb_matches() first (exact IMDb id
    cross-check, authoritative when it can run), falling back to
    page_title_matches() only when no IMDb id reference is found on the
    page at all.

    NOT YET VERIFIED against a real live page at the time this was
    written — this sandbox can't fetch rottentomatoes.com directly (like
    every other scraper fix in this project's history). A real small,
    curated verification batch cross-checked against outside sources is
    the actual test, not this function running without raising.

    Returns (critic, audience, debug) — debug is a list of every
    aggregateRating block seen (value/scale/name/whether it name-matched)
    plus a raw-text Tomatometer mention scan, so a job log shows exactly
    what was on the page even when nothing gets accepted."""
    critic = audience = None
    critic_name_matched = audience_name_matched = False
    debug = []
    ld_scripts = re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S)
    for ld_raw in ld_scripts:
        try:
            obj = json.loads(ld_raw)
            objs = obj if isinstance(obj, list) else [obj]
            for o in objs:
                ar = o.get('aggregateRating') if isinstance(o, dict) else None
                if ar and ar.get('ratingValue'):
                    val = float(ar['ratingValue'])
                    best = ar.get('bestRating')
                    best_num = float(best) if best not in (None, '') else None
                    name = o.get('name')
                    name_match = name_field_matches_title(name, title)
                    # Full diagnostic tuple, not just the number — @type/name
                    # tell us whether this aggregateRating block actually
                    # belongs to the show itself or to something else
                    # embedded on the same page (a "similar titles" rail,
                    # a review-count-only widget, etc.)
                    debug.append({
                        'ratingValue': val, 'bestRating': best,
                        'type': o.get('@type'), 'name': name, 'nameMatch': name_match,
                        'ratingCount': ar.get('ratingCount') or ar.get('reviewCount'),
                    })
                    if best_num == 100:
                        # A name-matched block always wins over a not-yet-
                        # matched one; among equally-confident blocks
                        # (both matched, or both unverified), the first one
                        # found is kept rather than the last — no evidence
                        # either way which is more reliable, so don't
                        # introduce a new assumption beyond "prefer a
                        # confirmed identity."
                        if critic is None or (name_match and not critic_name_matched):
                            critic = round(val)
                            critic_name_matched = bool(name_match)
                    elif best_num == 5:
                        if audience is None or (name_match and not audience_name_matched):
                            audience = round(val * 20)
                            audience_name_matched = bool(name_match)
                    # bestRating missing/ambiguous -> skip rather than guess
        except Exception:
            pass
    debug.append({'ld_script_count': len(ld_scripts),
                   'criticNameMatched': critic_name_matched, 'audienceNameMatched': audience_name_matched})
    # Cross-check: does the raw page text mention a *different* Tomatometer
    # number near the literal word "Tomatometer" than what the JSON-LD gave
    # us? If so, the JSON-LD block above isn't the real headline score.
    text_matches = re.findall(r'.{0,20}[Tt]omatometer.{0,40}', html)
    if text_matches:
        debug.append({'tomatometer_text_context': text_matches[:3]})

    if critic is None:
        cm = re.search(r'tomatometer["\s:]+(\d{1,3})\s*%', html, re.I)
        if cm:
            critic = int(cm.group(1))
    if audience is None:
        am = re.search(r'(?:popcornmeter|audience\s*score)["\s:]+(\d{1,3})\s*%', html, re.I)
        if am:
            audience = int(am.group(1))

    # Same wrong-page guard extract_metascore() applies: an exact IMDb id
    # cross-check first (authoritative when it can run), falling back to
    # the softer title/date check only when no id reference is found on
    # the page at all. A confirmed mismatch discards BOTH scores — a
    # wrong page invalidates whatever it appeared to say either way.
    if critic is not None or audience is not None:
        imdb_check = page_imdb_matches(imdb_id, html)
        if imdb_check is False:
            return None, None, debug
        if imdb_check is None and page_title_matches(title, year, html) is False:
            return None, None, debug

    return critic, audience, debug


def scrape_rt(page, title, year, kind, imdb_id=None):
    """kind: 'movie' or 'show'. Uses RT's own search page, takes the
    first result under the matching /m/ or /tv/ path, then reads the
    Tomatometer (critic) / Popcornmeter (audience) scores off that page
    via extract_rt_scores() (see its docstring for the two real bugs
    that function guards against — a wrong same-page JSON-LD block, and
    a wrong page entirely).

    Returns {'critic': int|None, 'audience': int|None, 'url': str,
    'debug': [...]} — debug carries every aggregateRating block found so
    a job log can show exactly what was on the page even when nothing
    gets accepted, the same "print enough to diagnose it from the log
    alone" discipline this project used for the TMDB/OMDb dead-key
    incidents."""
    from playwright.sync_api import TimeoutError as PWTimeout
    try:
        page.goto(f'https://www.rottentomatoes.com/search?search={quote(title)}',
                   wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_timeout(random.randint(2500, 4000))
        html = page.content()
    except PWTimeout:
        return None

    path_prefix = '/tv/' if kind == 'show' else '/m/'
    # RT's search results render as <a> tags to /m/<slug> or /tv/<slug>;
    # take the first one under the right type path (not doing year-
    # disambiguation here — imprecise, but a wrong RT match just means a
    # wrong score gets cached, so this needs real-run verification before
    # being trusted at scale, noted in the module docstring above).
    m = re.search(r'href="(https://www\.rottentomatoes\.com' + re.escape(path_prefix) + r'[a-z0-9_-]+)"', html)
    if not m:
        return None
    url = m.group(1)

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_timeout(random.randint(2000, 3500))
        html = page.content()
    except PWTimeout:
        return None

    critic, audience, debug = extract_rt_scores(html, title, year, imdb_id)

    if critic is None and audience is None:
        return {'critic': None, 'audience': None, 'url': url, 'debug': debug}
    return {'critic': critic, 'audience': audience, 'url': url, 'debug': debug}


# ── Metacritic ────────────────────────────────────────────────────────────

def scrape_metacritic(page, title, year, kind, imdb_id=None):
    """kind: 'movie' or 'show'. Same search-then-scrape shape as RT.

    Session 52's first live test found 0/5 matches here — the search-
    page href regex (scoped to a specific results-list shape) never
    matched anything. Widened to accept ANY /movie/<slug> or /tv/<slug>
    href found anywhere on the search page (Metacritic's search results
    render via client-side JS into whatever component shape is current,
    which this sandbox can't inspect directly — see the module
    docstring), plus a longer render wait. Returns a debug count of how
    many candidate links were found at all, so the next real run's job
    log shows whether the page rendered zero result links (a wait-time/
    selector problem) vs. rendered links that just don't match the
    regex (a pattern problem) — a different failure mode needs a
    different fix, and guessing which one happened from a bare "0/5
    found" isn't enough to fix it correctly."""
    from playwright.sync_api import TimeoutError as PWTimeout
    path_prefix = '/tv/' if kind == 'show' else '/movie/'
    debug_link_count = None
    url = None

    # Verified reliable across 3 real live test batches (5/5 direct-slug
    # matches, all confirmed correct on spot-check) — Metacritic's own URL
    # convention is predictable (lowercase, non-alphanumeric runs -> single
    # hyphen), so try it FIRST rather than the search page. The search
    # page's href regex found 0 result links in all 3 test batches (its
    # results likely render via a JS mechanism this regex-on-static-HTML
    # approach can't see) — still kept as a fallback below for a title
    # whose real slug doesn't match the naive lowercase-hyphenate guess,
    # but trying it first on every title would waste a full page load on
    # something that has never once worked.
    slug = re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', title.lower())).strip('-')
    guess_url = f'https://www.metacritic.com{path_prefix}{slug}/'
    try:
        resp = page.goto(guess_url, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_timeout(random.randint(2000, 3000))
        if resp and resp.status < 400 and 'Page Not Found' not in page.content()[:3000]:
            url = guess_url
    except PWTimeout:
        pass

    if url is None:
        try:
            page.goto(f'https://www.metacritic.com/search/{quote(title)}/',
                       wait_until='domcontentloaded', timeout=20_000)
            page.wait_for_timeout(random.randint(3500, 5000))
            html = page.content()
            all_links = re.findall(r'href="(https://www\.metacritic\.com(?:/tv/|/movie/)[a-z0-9_-]+/?)"', html)
            debug_link_count = len(all_links)
            matching = [u for u in all_links if path_prefix in u]
            if matching:
                url = matching[0]
        except PWTimeout:
            pass

    if url is None:
        return {'metascore': None, 'userScore': None, 'url': None,
                'debug_link_count': debug_link_count}

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_timeout(random.randint(2500, 4000))
        html = page.content()
    except PWTimeout:
        return {'metascore': None, 'userScore': None, 'url': url, 'debug_link_count': debug_link_count}

    metascore, user_score = extract_metascore(html, title, year, imdb_id)
    if metascore is None and user_score is None:
        return {'metascore': None, 'userScore': None, 'url': url, 'debug_link_count': debug_link_count}
    return {'metascore': metascore, 'userScore': user_score, 'url': url, 'debug_link_count': debug_link_count}


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    cache = load_cache()
    pending = load_pending(cache)

    if not pending:
        print('Nothing pending — every OMDb-gap title has already been scraped, RT-backfilled, or is on cooldown.')
        return

    batch = pending[:BATCH_SIZE]
    rt_backfill_only = sum(1 for t in batch if t['needsRT'] and not t['needsMC'])
    print(f'Queue: {len(pending)} remaining (OMDb-enriched, no RT/MC from OMDb, or an RT backfill) | '
          f'processing {len(batch)} this run ({rt_backfill_only} are RT-only backfills of an already-good MC entry)\n')

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('ERROR: playwright not installed. Run: pip install playwright && playwright install chromium --with-deps')
        sys.exit(1)

    rt_attempted = mc_attempted = rt_found = mc_found = neither = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        )
        ctx = browser.new_context(
            user_agent=('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
            viewport={'width': 1280, 'height': 900},
            locale='en-US',
        )
        page = ctx.new_page()
        page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,svg}', lambda r: r.abort())

        for i, t in enumerate(batch, 1):
            label = f"{t['title']} ({t['year']})" if t['year'] else t['title']
            print(f"[{i:3}/{len(batch)}] {label[:60]} [{t['type']}]")

            rt = None
            if t['needsRT']:
                rt_attempted += 1
                try:
                    rt = scrape_rt(page, t['title'], t['year'], t['type'], t.get('imdbId'))
                except Exception as e:
                    print(f'         RT error: {e}')
                time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))

            mc = None
            if t['needsMC']:
                mc_attempted += 1
                try:
                    mc = scrape_metacritic(page, t['title'], t['year'], t['type'], t.get('imdbId'))
                except Exception as e:
                    print(f'         MC error: {e}')
                time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))

            unreleased = is_unreleased(t.get('releaseDate'))
            if unreleased and (rt or mc) and ((rt and rt.get('critic') is not None) or (mc and mc.get('metascore') is not None)):
                print(f"         discarded — {t['title']} hasn't released yet ({t.get('releaseDate')}), a critic "
                      f"score for it is impossible on its face regardless of what the scrape found")

            # Merge onto whatever's already cached rather than replacing
            # wholesale — an RT-only backfill run (needsMC=False) must
            # never wipe out an already-good metacritic/metacriticUser/
            # mcUrl value just because mc is None here (it was never
            # attempted this run, not a real miss).
            entry = dict(cache.get(t['titleKey']) or {})
            if t['needsRT']:
                entry['rottenTomatoes'] = None if unreleased else (rt.get('critic') if rt else None)
                entry['rtAudience'] = None if unreleased else (rt.get('audience') if rt else None)
                entry['rtUrl'] = rt.get('url') if rt else None
                entry['rtAttempted'] = time.strftime('%Y-%m-%d')
            if t['needsMC']:
                entry['metacritic'] = None if unreleased else (mc.get('metascore') if mc else None)
                entry['metacriticUser'] = None if unreleased else (mc.get('userScore') if mc else None)
                entry['mcUrl'] = mc.get('url') if mc else None
            entry['checkedAt'] = time.strftime('%Y-%m-%d')
            cache[t['titleKey']] = entry

            if t['needsRT'] and entry.get('rottenTomatoes') is not None:
                rt_found += 1
            if t['needsMC'] and entry.get('metacritic') is not None:
                mc_found += 1
            if entry.get('rottenTomatoes') is None and entry.get('metacritic') is None:
                neither += 1

            rt_str = f"RT {entry.get('rottenTomatoes')}%" if entry.get('rottenTomatoes') is not None else 'RT —'
            mc_str = f"MC {entry.get('metacritic')}" if entry.get('metacritic') is not None else 'MC —'
            print(f'         {rt_str}  |  {mc_str}')
            if rt and rt.get('url'):
                print(f"         RT url: {rt['url']}")
            if rt and rt.get('debug'):
                print(f"         RT JSON-LD blocks seen: {rt['debug']}")
            if mc and mc.get('url'):
                print(f"         MC url: {mc['url']}")
            if mc and mc.get('debug_link_count') is not None and entry.get('metacritic') is None:
                print(f"         MC search page had {mc['debug_link_count']} /tv//movie/ links total")

            if i % 10 == 0:
                save_cache(cache)

        browser.close()

    save_cache(cache)
    print(f'\nBatch done: {rt_found}/{rt_attempted} found on RT ({rt_attempted} attempted), '
          f'{mc_found}/{mc_attempted} found on Metacritic ({mc_attempted} attempted), '
          f'{neither}/{len(batch)} found on neither.')
    # Only warn against an actually-attempted denominator — a pure RT
    # backfill batch legitimately has mc_attempted=0, and that's not a
    # failure signal for Metacritic.
    if rt_attempted >= 5 and rt_found == 0:
        print('WARNING: zero titles matched on Rotten Tomatoes this batch — likely a real scraping failure '
              '(search/slug pattern changed, bot detection) rather than a genuine data gap for every single '
              'title. Check the per-title debug output above before trusting this cache.', file=sys.stderr)
    if mc_attempted >= 5 and mc_found == 0:
        print('WARNING: zero titles matched on Metacritic this batch — likely a real scraping failure '
              '(search page structure changed, bot detection, or a wrong URL pattern), not a genuine '
              'data gap for every single title. Check the per-title output above before trusting this cache.',
              file=sys.stderr)


if __name__ == '__main__':
    main()
