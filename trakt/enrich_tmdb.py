#!/usr/bin/env python3
"""
Enriches movies/shows with genres, overview, cast/crew, keywords, community
rating, and TMDB's own similar/recommendations id lists. No LLM involved —
plain HTTP against The Movie Database (TMDB) API.

Results cached in trakt/data/enrichedMetadata.json keyed by titleKey
(`movie:{tmdbId}` / `show:{tmdbId}`) — see CLAUDE.md's "BMTRE" section for
the full schema and how trakt/engine.js consumes this cache.

Every title in this project's library/watchlist already carries a real TMDB
id (from the Trakt export), so this is a direct id lookup per title, never
a fuzzy title/author search chain the way enrich_metadata.py needs for
books — one call per title via append_to_response.

Priority order: watchlist (most decision-relevant — "what should Bill watch
next"), then library (watched titles, lower urgency but still useful for
scoring signals like director/genre affinity).

Run manually:   python3 trakt/enrich_tmdb.py [batch_size]
GitHub Action:  .github/workflows/trakt-enrich-tmdb.yml

REFRESH_ALL=1 (or --refresh-all) re-fetches every title regardless of
cache membership — a one-off backfill for when extract_entry() gains a
new field that already-cached entries don't carry (the cache only ever
stores the extracted subset, so a new field can't be recovered without
a real re-fetch).
"""

import json, os, sys, time, urllib.request, urllib.parse, urllib.error
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
DATA_DIR   = ROOT / 'trakt' / 'data'
CACHE_FILE = DATA_DIR / 'enrichedMetadata.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 150
RETRY_EMPTIES = os.environ.get('RETRY_EMPTIES') == '1' or '--retry-empties' in sys.argv
# One-off backfill mode: re-fetches every title regardless of cache
# membership, needed when a new field is added to extract_entry() (e.g.
# originalLanguage) that already-cached entries don't have — the cache
# only ever stores the extracted subset, not the raw TMDB response, so
# there's no way to backfill a new field without a real re-fetch.
REFRESH_ALL = os.environ.get('REFRESH_ALL') == '1' or '--refresh-all' in sys.argv
API_KEY    = os.environ.get('TMDB_API_KEY', '')
DELAY      = 0.35  # seconds between titles — one call per title, generous TMDB rate limit

HEADERS = {'User-Agent': 'my-books-trakt-enrichment (personal watch-history app)'}
API_BASE = 'https://api.themoviedb.org/3'


def get_json(url, timeout=10):
    """Returns (data, status_code, error_body). error_body is TMDB's own
    error JSON/text on a non-2xx response (e.g. {"status_message": "..."}),
    surfaced so a 401 can be diagnosed from its real reason (revoked key,
    suspended for abuse, malformed key, etc.) rather than the bare status
    code alone."""
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


def tmdb_detail(kind, tmdb_id):
    """kind: 'movie' or 'show' (mapped to TMDB's 'tv'). One call, full detail."""
    tmdb_kind = 'movie' if kind == 'movie' else 'tv'
    url = (f'{API_BASE}/{tmdb_kind}/{tmdb_id}'
           f'?api_key={API_KEY}&append_to_response=credits,keywords,similar,recommendations,external_ids')
    return get_json(url)


def extract_entry(kind, data):
    entry = {
        'genres': [g['name'] for g in (data.get('genres') or [])],
        'overview': (data.get('overview') or '')[:2000],
        'keywords': [],
        'originalLanguage': data.get('original_language'),
        # Movies carry imdb_id at the top level; shows only get it via the
        # external_ids append (added alongside credits/keywords/similar/
        # recommendations above) — needed to join against OMDb, which is
        # keyed by IMDb id, not TMDB id.
        'imdbId': data.get('imdb_id') or (data.get('external_ids') or {}).get('imdb_id'),
        'voteAverage': data.get('vote_average'),
        'voteCount': data.get('vote_count'),
        'popularity': data.get('popularity'),
        'posterPath': data.get('poster_path'),
        'similarToIds': [r['id'] for r in ((data.get('similar') or {}).get('results') or [])[:20]],
        'recommendedIds': [r['id'] for r in ((data.get('recommendations') or {}).get('results') or [])[:20]],
    }

    # discover_candidates.js used to have no way to tell a genuinely
    # popular citation from TMDB algorithmically bulk-citing a near-zero-
    # vote title as filler "similar" content (the real incident: La La
    # Land, rated 10/10, cites "Alpha Quail" — a 13-minute short with a
    # single TMDB vote — as similar; it ranked #3 of 82 candidates before
    # a scoring-time fix caught it). similar/recommendations results are
    # already full TMDB summary objects with vote_count on them — this
    # was being fetched and discarded the moment before, right above.
    # Cached here so discovery can filter BEFORE ever creating a stub,
    # not just after scoring one — see isTooObscure() in engine.js for
    # the (still-kept, defense-in-depth) scoring-time equivalent, which
    # catches any candidate added another way (a manual resolve_titles.py
    # batch, or one discovered before this field existed).
    cited = {}
    for r in ((data.get('similar') or {}).get('results') or [])[:20]:
        if r.get('id') is not None and r.get('vote_count') is not None:
            cited[r['id']] = r['vote_count']
    for r in ((data.get('recommendations') or {}).get('results') or [])[:20]:
        if r.get('id') is not None and r.get('vote_count') is not None:
            cited[r['id']] = r['vote_count']
    entry['citedVoteCounts'] = cited

    kw = data.get('keywords') or {}
    kw_list = kw.get('keywords') if kind == 'movie' else kw.get('results')  # TMDB uses a different key per type
    entry['keywords'] = [k['name'] for k in (kw_list or [])][:15]

    credits = data.get('credits') or {}
    cast = credits.get('cast') or []
    sorted_cast = sorted(cast, key=lambda c: c.get('order', 999))[:5]
    entry['topCast'] = [c['name'] for c in sorted_cast]
    # Bill: "maybe if the lead female is over 70, I rarely like those" -
    # a follow-up to the network-TV finding (Matlock's lead, Kathy Bates,
    # is over 70). TMDB's credits.cast objects already carry `id` and
    # `gender` (0 unspecified/1 female/2 male/3 non-binary) - captured
    # here alongside the existing name-only topCast (kept as-is, since
    # engine.js's castBonus()/lovedActors/reason() all key off it by name
    # already and changing its shape would be a much larger, riskier
    # refactor for no benefit). `id` is what a future person-lookup pass
    # (birthday, for real age) will need - TMDB's TV/movie detail
    # response has no birthdate itself, only a separate `/person/{id}`
    # call does. Not yet used for scoring - this is the data half of the
    # investigation, not the signal itself.
    entry['topCastDetail'] = [
        {'id': c.get('id'), 'name': c.get('name'), 'gender': c.get('gender')}
        for c in sorted_cast
    ]

    if kind == 'movie':
        entry['releaseDate'] = data.get('release_date')
        entry['runtime'] = data.get('runtime')
        crew = credits.get('crew') or []
        directors = [c['name'] for c in crew if c.get('job') == 'Director']
        entry['director'] = directors[0] if directors else None
        # Full co-director list — real bug found via a manual spot-check of
        # engine.js's creator crediting (external metadata-plan review):
        # this always collected every real TMDB 'Director' crew credit into
        # `directors` above but then silently discarded everyone past
        # index 0. Confirmed on a well-known real example: Avengers:
        # Infinity War is genuinely co-directed by Joe AND Anthony Russo,
        # both credited by TMDB, but `director` alone only ever showed
        # "Joe Russo" — the same undercount pattern already fixed for
        # shows' createdBy[] earlier this session, just never checked for
        # movies. Old cache entries won't have this field until re-fetched
        # (REFRESH_ALL=1) — engine.js's getCreators() falls back to
        # [director] for those.
        entry['directors'] = directors
        coll = data.get('belongs_to_collection')
        entry['belongsToCollection'] = {'id': coll['id'], 'name': coll['name']} if coll else None
    else:
        entry['firstAirDate'] = data.get('first_air_date')
        ert = data.get('episode_run_time') or []
        entry['episodeRunTime'] = ert[0] if ert else None
        entry['createdBy'] = [c['name'] for c in (data.get('created_by') or [])]
        entry['status'] = data.get('status')
        entry['numberOfSeasons'] = data.get('number_of_seasons')
        entry['numberOfEpisodes'] = data.get('number_of_episodes')
        # Bill: "I only watch a season once that season is complete" - a
        # show can sit at status="Returning Series" for years between
        # seasons while everything released so far is fully watchable, so
        # status alone can't tell isActivelyAiring() (engine.js) whether a
        # season is genuinely mid-release right now. next_episode_to_air is
        # only populated by TMDB when a specific next episode is actually
        # scheduled/recent - the real "still airing" signal.
        next_ep = data.get('next_episode_to_air')
        entry['nextEpisodeToAir'] = {
            'airDate': next_ep.get('air_date'),
            'seasonNumber': next_ep.get('season_number'),
            'episodeNumber': next_ep.get('episode_number'),
        } if next_ep else None

        # Bill: Matlock is "a network show aimed at an older audience" -
        # asked to capture and downgrade that pattern. TMDB's own
        # `networks` field (CBS/NBC/ABC/Fox/The CW = broadcast vs. Netflix/
        # HBO/Apple TV+/etc. = streaming/cable) is a real, orthogonal-to-
        # genre signal never captured before now - genre-based attempts at
        # this exact idea (too_urban, too_low_brow reason codes in
        # feedbackData.json) were already tried and reverted because Bill's
        # own loved titles share the same genres/subgenres a genre penalty
        # would hit. Whether broadcast-network status actually correlates
        # with Bill's real ratings needs checking against his real data
        # before any engine.js signal is built on it - not assumed here.
        entry['networks'] = [n['name'] for n in (data.get('networks') or [])]

    return entry


def load_titles():
    """watchlist first (most decision-relevant), then library, then
    discovered candidates (trakt/scripts/discover_candidates.js) last —
    those are real TMDB ids but bare stubs with no title/year yet."""
    titles = []
    for name in ('watchlist.json', 'library.json', 'candidatePool.json'):
        p = DATA_DIR / name
        if p.exists():
            titles += json.load(open(p)).get('titles', [])
    return titles


def main():
    if not API_KEY:
        print('ERROR: TMDB_API_KEY is not set. Create a free key at themoviedb.org and set it as an env var '
              '(or the TMDB_API_KEY repo secret for the GitHub Action).', file=sys.stderr)
        sys.exit(1)

    cache = json.load(open(CACHE_FILE)) if CACHE_FILE.exists() else {}
    if REFRESH_ALL:
        pending = [t for t in load_titles() if t.get('titleKey')]
    elif RETRY_EMPTIES:
        pending = [t for t in load_titles()
                   if t.get('titleKey') and t['titleKey'] in cache
                   and not cache[t['titleKey']].get('overview')
                   and not cache[t['titleKey']].get('retriedAt')]
    else:
        pending = [t for t in load_titles()
                   if t.get('titleKey') and t['titleKey'] not in cache]
    # de-dupe while preserving priority order (a title can appear in both files)
    seen, deduped = set(), []
    for t in pending:
        if t['titleKey'] not in seen:
            seen.add(t['titleKey'])
            deduped.append(t)
    pending = deduped

    batch = pending[:BATCH_SIZE]
    print(f'{len(pending)} titles pending, processing {len(batch)}')

    failures = 0
    for i, t in enumerate(batch, 1):
        key, kind = t['titleKey'], t['type']
        tmdb_id = (t.get('ids') or {}).get('tmdb')
        if not tmdb_id:
            print(f'  [{i}/{len(batch)}] ---- (no tmdb id) | {(t.get("title") or "?")[:50]}')
            continue

        data, status, error_body = tmdb_detail(kind, tmdb_id)
        if status == 401:
            print(f'ERROR: TMDB rejected the API key (401). TMDB\'s own response: {error_body!r}. '
                  'Check TMDB_API_KEY and stop — no point burning through the rest of the batch '
                  'on a bad key.', file=sys.stderr)
            sys.exit(1)
        if not data:
            failures += 1
            print(f'  [{i}/{len(batch)}] FAIL (status {status}, {error_body!r}) | {(t.get("title") or "?")[:50]}')
            continue

        entry = extract_entry(kind, data)
        # Discovered candidates (discover_candidates.js) are bare-id stubs
        # with no title/year of their own — backfill from TMDB's response.
        if kind == 'movie':
            date_field, name_field = 'release_date', 'title'
        else:
            date_field, name_field = 'first_air_date', 'name'
        entry['title'] = t.get('title') or data.get(name_field)
        year = t.get('year')
        if not year:
            date_str = data.get(date_field)
            year = int(date_str[:4]) if date_str else None
        entry['year'] = year
        entry['type'] = kind
        entry['fetchedAt'] = time.strftime('%Y-%m-%d')
        if RETRY_EMPTIES:
            entry['retriedAt'] = entry['fetchedAt']
        cache[key] = entry

        got = 'ok' if entry.get('overview') else '----'
        print(f'  [{i}/{len(batch)}] {got} | {(t.get("title") or "?")[:50]}')
        if i % 25 == 0:
            json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
        time.sleep(DELAY)

    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    if batch and failures == len(batch):
        print('ERROR: every title in this batch failed — treat as a real failure, not a quiet success.',
              file=sys.stderr)
        sys.exit(1)

    with_overview = sum(1 for v in cache.values() if v.get('overview'))
    print(f'done: {len(cache)} cached, {with_overview} with an overview')


if __name__ == '__main__':
    main()
