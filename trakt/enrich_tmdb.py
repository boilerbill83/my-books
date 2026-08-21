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
"""

import json, os, sys, time, urllib.request, urllib.parse, urllib.error
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
DATA_DIR   = ROOT / 'trakt' / 'data'
CACHE_FILE = DATA_DIR / 'enrichedMetadata.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 150
RETRY_EMPTIES = os.environ.get('RETRY_EMPTIES') == '1' or '--retry-empties' in sys.argv
API_KEY    = os.environ.get('TMDB_API_KEY', '')
DELAY      = 0.35  # seconds between titles — one call per title, generous TMDB rate limit

HEADERS = {'User-Agent': 'my-books-trakt-enrichment (personal watch-history app)'}
API_BASE = 'https://api.themoviedb.org/3'


def get_json(url, timeout=10):
    """Returns (data, status_code). status_code is None on network/parse failure."""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8')), resp.status
    except urllib.error.HTTPError as e:
        return None, e.code
    except Exception:
        return None, None


def tmdb_detail(kind, tmdb_id):
    """kind: 'movie' or 'show' (mapped to TMDB's 'tv'). One call, full detail."""
    tmdb_kind = 'movie' if kind == 'movie' else 'tv'
    url = (f'{API_BASE}/{tmdb_kind}/{tmdb_id}'
           f'?api_key={API_KEY}&append_to_response=credits,keywords,similar,recommendations')
    return get_json(url)


def extract_entry(kind, data):
    entry = {
        'genres': [g['name'] for g in (data.get('genres') or [])],
        'overview': (data.get('overview') or '')[:2000],
        'keywords': [],
        'voteAverage': data.get('vote_average'),
        'voteCount': data.get('vote_count'),
        'popularity': data.get('popularity'),
        'posterPath': data.get('poster_path'),
        'similarToIds': [r['id'] for r in ((data.get('similar') or {}).get('results') or [])[:20]],
        'recommendedIds': [r['id'] for r in ((data.get('recommendations') or {}).get('results') or [])[:20]],
    }

    kw = data.get('keywords') or {}
    kw_list = kw.get('keywords') if kind == 'movie' else kw.get('results')  # TMDB uses a different key per type
    entry['keywords'] = [k['name'] for k in (kw_list or [])][:15]

    credits = data.get('credits') or {}
    cast = credits.get('cast') or []
    entry['topCast'] = [c['name'] for c in sorted(cast, key=lambda c: c.get('order', 999))[:5]]

    if kind == 'movie':
        entry['releaseDate'] = data.get('release_date')
        entry['runtime'] = data.get('runtime')
        crew = credits.get('crew') or []
        directors = [c['name'] for c in crew if c.get('job') == 'Director']
        entry['director'] = directors[0] if directors else None
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
    if RETRY_EMPTIES:
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

        data, status = tmdb_detail(kind, tmdb_id)
        if status == 401:
            print('ERROR: TMDB rejected the API key (401). Check TMDB_API_KEY and stop — '
                  'no point burning through the rest of the batch on a bad key.', file=sys.stderr)
            sys.exit(1)
        if not data:
            failures += 1
            print(f'  [{i}/{len(batch)}] FAIL (status {status}) | {(t.get("title") or "?")[:50]}')
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
