#!/usr/bin/env python3
"""
Enriches movies/shows with audience score (Rotten Tomatoes / Metacritic)
and awards data (Oscar / Emmy wins & nominations) from the OMDb API,
keyed by IMDb id — the join key every Trakt-sourced title already
carries (t.ids.imdb for library/watchlist, straight from the Trakt
export; enrichedMetadata.json's imdbId field for TMDB-discovered
candidates, backfilled by enrich_tmdb.py's external_ids append).

TMDB itself has neither field (see CLAUDE.md's BMTRE section) — this
is a second, independent source, cached separately in
trakt/data/omdbMetadata.json (never blended into enrichedMetadata.json
itself) so trakt/engine.js can always tell which source a signal came
from — same discipline the book side keeps between Google Books/Open
Library and the Amazon scrape.

Run manually:   python3 trakt/enrich_omdb.py [batch_size]
GitHub Action:  .github/workflows/trakt-enrich-omdb.yml

RETRY_NO_RT=1 (or --retry-no-rt) re-fetches cached entries that have
real OMDb data but are missing rottenTomatoes specifically — a real,
confirmed gap: enrich_omdb.py only ever fetches a title once
(`t['titleKey'] not in cache`), so if OMDb's own upstream RT data was
backfilled after the original fetch (a known behavior of aggregator
APIs — verified against real examples: Rocketman/TÁR/Maestro, all
well-known titles with hundreds of thousands of IMDb votes, still show
no RT in the cache), this script previously had no way to ever pick
it up. Mirrors enrich_tmdb.py's RETRY_EMPTIES pattern exactly,
including the one-retry-only guard (`rtRetriedAt`) so a title that
genuinely has no RT score in OMDb isn't re-fetched forever.

RETRY_NO_DIRECTOR=1 (or --retry-no-director) is the same one-shot
retry pattern, for backfilling the 'director' field onto every
already-cached MOVIE entry from before extract_entry() started
capturing it (a new field on an existing OMDb response, same as the
publisher/googleRatingsCount backfill pattern documented on the book
side — old cache entries don't retroactively gain a field a script
starts reading later without a forced re-fetch). Movies only: OMDb has
no analogous director/creator field for shows, so retrying those would
just burn API calls re-confirming a permanent null. Guarded by
`directorRetriedAt` so a movie OMDb genuinely has no Director for
isn't re-fetched forever either.

Needs an OMDB_API_KEY — free tier at omdbapi.com/apikey.aspx (1,000
requests/day), same pattern as TMDB_API_KEY/GOOGLE_BOOKS_API_KEY: Bill
creates it himself and sets it as a repo secret; no tool here can do
either step.
"""

import json, os, re, sys, time, urllib.request, urllib.parse, urllib.error
from pathlib import Path

ROOT         = Path(__file__).resolve().parent.parent
DATA_DIR     = ROOT / 'trakt' / 'data'
CACHE_FILE   = DATA_DIR / 'omdbMetadata.json'
BATCH_SIZE   = int(sys.argv[1]) if len(sys.argv) > 1 else 150
API_KEY      = os.environ.get('OMDB_API_KEY', '')
RETRY_NO_RT  = os.environ.get('RETRY_NO_RT') == '1' or '--retry-no-rt' in sys.argv
RETRY_NO_DIRECTOR = os.environ.get('RETRY_NO_DIRECTOR') == '1' or '--retry-no-director' in sys.argv
DELAY        = 0.4
API_BASE     = 'https://www.omdbapi.com/'
HEADERS      = {'User-Agent': 'my-books-trakt-omdb-enrichment (personal watch-history app)'}


def get_json(url, timeout=10):
    """Returns (data, status_code, error_body). error_body is OMDb's own
    error JSON/text on a non-2xx response, surfaced so a 401 can be
    diagnosed from its real reason (e.g. {"Response":"False","Error":
    "Invalid API key!"}) rather than the bare status code alone — mirrors
    the identical fix enrich_tmdb.py's get_json() got after a real
    dead-key incident there; this sibling script had the same gap until
    now (a real Improvement Opportunities finding, not hypothetical:
    OMDb genuinely does return a JSON error body on a bad key, but the
    old version discarded it unconditionally on any HTTPError, so even a
    real, specific error message never reached the caller)."""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8')), resp.status, None
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode('utf-8', errors='replace')[:500]
        except Exception:
            body = None
        return None, e.code, body
    except Exception as e:
        return None, None, str(e)[:500]


def omdb_lookup(imdb_id):
    url = f'{API_BASE}?i={urllib.parse.quote(imdb_id)}&apikey={API_KEY}'
    return get_json(url)


# OMDb's Awards field is free text, e.g. "Won 1 Oscar. 128 wins & 233
# nominations total" or "Won 16 Primetime Emmys. 165 wins & 258
# nominations total" or "N/A". Extracts only what's literally present —
# never infers a count that isn't in the text.
#
# The per-award Oscar/Emmy counts (AWARD_WIN_RE/AWARD_NOM_RE) and the
# aggregate win/nomination totals (parse_totals(), below) are independent
# and can both be nonzero for the same text (e.g. "Won 1 Primetime Emmy.
# 1 win total" — 1 Emmy win specifically, 1 win overall).
#
# A real parsing gap was found and fixed here: the original single
# TOTAL_RE only matched the combined "N wins & M nominations total"
# shape, silently reading every other real OMDb format as zero
# recognition — confirmed against the live cache (149 of 433
# zero-recognition records had real, non-"N/A" award text that should
# have parsed to a nonzero total). Real formats this now also covers:
# "N win(s) total" alone, "N nomination(s) total" alone, "N wins & M
# nominations" with no trailing "total", and bare "N nomination(s)"/"N
# win(s)" with nothing else in the field. Also tolerates a real OMDb text
# quirk with a missing space/word before the trailing count (e.g.
# "Nominated for 1 BAFTA Award4 nominations total") since the digit-
# adjacent "nominations total"/"wins total" suffix is searched anywhere
# in the text, not anchored to a word boundary.
AWARD_WIN_RE = re.compile(r'Won (\d+) ([A-Za-z][\w .&-]*?)s?(?:\.|,| \()', re.IGNORECASE)
AWARD_NOM_RE = re.compile(r'Nominated for (\d+) ([A-Za-z][\w .&-]*?)s?(?:\.|,| \()', re.IGNORECASE)
BOTH_TOTAL_RE = re.compile(r'(\d+) wins?\s*&\s*(\d+) nominations?(?:\s*total)?', re.IGNORECASE)
WIN_TOTAL_RE = re.compile(r'(\d+) wins?\s*total', re.IGNORECASE)
NOM_TOTAL_RE = re.compile(r'(\d+) nominations?\s*total', re.IGNORECASE)
BARE_WIN_RE = re.compile(r'^(\d+) wins?\.?$', re.IGNORECASE)
BARE_NOM_RE = re.compile(r'^(\d+) nominations?\.?$', re.IGNORECASE)


def parse_totals(text):
    """Returns (totalWins, totalNominations) — see the module comment
    above for the real-world text shapes this covers."""
    both = BOTH_TOTAL_RE.search(text)
    if both:
        return int(both.group(1)), int(both.group(2))
    wins, noms = 0, 0
    w = WIN_TOTAL_RE.search(text)
    if w:
        wins = int(w.group(1))
    else:
        bw = BARE_WIN_RE.match(text.strip())
        if bw:
            wins = int(bw.group(1))
    nom_m = NOM_TOTAL_RE.search(text)
    if nom_m:
        noms = int(nom_m.group(1))
    else:
        bn = BARE_NOM_RE.match(text.strip())
        if bn:
            noms = int(bn.group(1))
    return wins, noms


def parse_awards(text):
    result = {'oscarWins': 0, 'oscarNominations': 0, 'emmyWins': 0,
              'emmyNominations': 0, 'totalWins': 0, 'totalNominations': 0,
              'raw': text or ''}
    if not text or text == 'N/A':
        return result
    for count, name in AWARD_WIN_RE.findall(text):
        n = name.strip().lower()
        if 'oscar' in n:
            result['oscarWins'] += int(count)
        elif 'emmy' in n:
            result['emmyWins'] += int(count)
    for count, name in AWARD_NOM_RE.findall(text):
        n = name.strip().lower()
        if 'oscar' in n:
            result['oscarNominations'] += int(count)
        elif 'emmy' in n:
            result['emmyNominations'] += int(count)
    result['totalWins'], result['totalNominations'] = parse_totals(text)
    return result


def extract_entry(data):
    ratings = {r.get('Source'): r.get('Value') for r in (data.get('Ratings') or [])}
    rt = ratings.get('Rotten Tomatoes')  # e.g. "87%"
    rt_score = int(rt.rstrip('%')) if rt and rt.rstrip('%').isdigit() else None
    mc = data.get('Metascore')  # e.g. "74" or "N/A"
    mc_score = int(mc) if mc and mc.isdigit() else None
    imdb_rating = data.get('imdbRating')
    imdb_votes = data.get('imdbVotes')
    # OMDb's own 'Director' field, captured alongside everything else on
    # the same already-fetched call — a real, independent second source for
    # cross-checking TMDB's crew-credit 'director' (movies only; OMDb has
    # no per-episode/creator equivalent for shows, so this stays null for
    # type=show). "N/A" and multi-director "A, B" strings are both real
    # OMDb responses, not errors — kept as-is (raw string), not parsed
    # further, since this is a manual-review cross-check, not a scoring
    # signal that needs a single canonical name.
    director = data.get('Director')
    return {
        'rottenTomatoes': rt_score,
        'metacritic': mc_score,
        'awards': parse_awards(data.get('Awards')),
        'imdbRating': float(imdb_rating) if imdb_rating not in (None, 'N/A') else None,
        'imdbVotes': int(imdb_votes.replace(',', '')) if imdb_votes not in (None, 'N/A') else None,
        'director': director if director and director != 'N/A' else None,
        'fetchedAt': time.strftime('%Y-%m-%d'),
    }


def load_titles():
    """Same watchlist -> library -> candidatePool priority as
    enrich_tmdb.py. Needs each title's IMDb id: library/watchlist carry
    it natively (t.ids.imdb, from the Trakt export); candidatePool
    stubs don't, so those join via enrichedMetadata.json's imdbId field
    (backfilled by enrich_tmdb.py's external_ids append) — a candidate
    not yet TMDB-enriched, or enriched before that field existed, is
    simply skipped until it has one."""
    enriched_path = DATA_DIR / 'enrichedMetadata.json'
    enriched = json.load(open(enriched_path)) if enriched_path.exists() else {}
    titles = []
    for name in ('watchlist.json', 'library.json', 'candidatePool.json'):
        p = DATA_DIR / name
        if not p.exists():
            continue
        for t in json.load(open(p)).get('titles', []):
            title_key = t.get('titleKey')
            if not title_key:
                continue
            imdb_id = (t.get('ids') or {}).get('imdb') or enriched.get(title_key, {}).get('imdbId')
            if imdb_id:
                titles.append({'titleKey': title_key, 'imdbId': imdb_id, 'title': t.get('title'),
                                'type': t.get('type')})
    return titles


def main():
    if not API_KEY:
        print('ERROR: OMDB_API_KEY is not set. Create a free key at omdbapi.com/apikey.aspx '
              '(1,000 requests/day) and set it as an env var (or the OMDB_API_KEY repo secret '
              'for the GitHub Action).', file=sys.stderr)
        sys.exit(1)

    cache = json.load(open(CACHE_FILE)) if CACHE_FILE.exists() else {}
    if RETRY_NO_RT:
        # Movies only — checked live before shipping this mode: OMDb
        # returns an RT score for ~91% of movies but essentially never
        # for shows (0.8%, a real structural gap, not staleness), so
        # scoping to all 481 "no RT" shows here would burn ~500 API
        # calls mostly re-confirming an absence that was never a
        # staleness issue, and permanently mark them rtRetriedAt in the
        # process for a check unlikely to ever change.
        pending_raw = [t for t in load_titles()
                       if t['type'] == 'movie'
                       and t['titleKey'] in cache
                       and cache[t['titleKey']].get('rottenTomatoes') is None
                       and not cache[t['titleKey']].get('rtRetriedAt')]
    elif RETRY_NO_DIRECTOR:
        pending_raw = [t for t in load_titles()
                       if t['type'] == 'movie'
                       and t['titleKey'] in cache
                       and cache[t['titleKey']].get('director') is None
                       and not cache[t['titleKey']].get('directorRetriedAt')]
    else:
        pending_raw = [t for t in load_titles() if t['titleKey'] not in cache]
    seen, pending = set(), []
    for t in pending_raw:
        if t['titleKey'] not in seen:
            seen.add(t['titleKey'])
            pending.append(t)

    batch = pending[:BATCH_SIZE]
    if RETRY_NO_RT:
        print(f'{len(pending)} cached titles missing Rotten Tomatoes, not yet retried, processing {len(batch)}')
    elif RETRY_NO_DIRECTOR:
        print(f'{len(pending)} cached movies missing director, not yet retried, processing {len(batch)}')
    else:
        print(f'{len(pending)} titles pending (have an IMDb id, not yet OMDb-enriched), processing {len(batch)}')

    failures = 0
    for i, t in enumerate(batch, 1):
        data, status, error_body = omdb_lookup(t['imdbId'])
        if status == 401:
            print(f'ERROR: OMDb rejected the API key (401). OMDb\'s own response: {error_body!r}. '
                  'Check OMDB_API_KEY and stop — no point burning through the rest of the batch '
                  'on a bad key.', file=sys.stderr)
            sys.exit(1)
        if not data or data.get('Response') == 'False':
            failures += 1
            err = (data or {}).get('Error') or error_body or f'status {status}'
            print(f'  [{i}/{len(batch)}] FAIL ({err}) | {t["title"] or t["imdbId"]}')
            time.sleep(DELAY)
            continue

        cache[t['titleKey']] = extract_entry(data)
        if RETRY_NO_RT:
            cache[t['titleKey']]['rtRetriedAt'] = cache[t['titleKey']]['fetchedAt']
        if RETRY_NO_DIRECTOR:
            cache[t['titleKey']]['directorRetriedAt'] = cache[t['titleKey']]['fetchedAt']
        rt = cache[t['titleKey']]['rottenTomatoes']
        director = cache[t['titleKey']]['director']
        found = ' (found!)' if RETRY_NO_RT and rt is not None else ''
        dfound = ' (found!)' if RETRY_NO_DIRECTOR and director is not None else ''
        if RETRY_NO_DIRECTOR:
            print(f'  [{i}/{len(batch)}] ok (director {director or "—"}{dfound}) | {t["title"] or t["imdbId"]}')
        else:
            print(f'  [{i}/{len(batch)}] ok (RT {rt if rt is not None else "—"}{found}) | {t["title"] or t["imdbId"]}')
        if i % 25 == 0:
            json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
        time.sleep(DELAY)

    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    if batch and failures == len(batch):
        print('ERROR: every title in this batch failed — treat as a real failure, not a quiet success.',
              file=sys.stderr)
        sys.exit(1)

    with_rt = sum(1 for v in cache.values() if v.get('rottenTomatoes') is not None)
    with_director = sum(1 for v in cache.values() if v.get('director') is not None)
    print(f'done: {len(cache)} cached, {with_rt} with a Rotten Tomatoes score, {with_director} with a director')


if __name__ == '__main__':
    main()
