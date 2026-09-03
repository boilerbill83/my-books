#!/usr/bin/env python3
"""
A genuinely independent candidate-discovery source, added to close a real
gap the Data Quality dashboard's "closed-loop-discovery" finding measured
live: trakt/scripts/discover_candidates.js (and therefore everything
prune_candidate_pool.js scores and caps) only ever draws candidates from
loved titles' own TMDB similarToIds/recommendedIds - the SAME graph
baseSignals()'s forward/reverse-match signal (worth up to +24/+12) then
rewards a candidate for appearing in. Verified live (Sep 2026, before this
script existed): 96% of the pool was directly cited by a loved title's own
similar/recommended list - discovery and scoring were structurally the
same TMDB algorithm queried twice, so nothing genuinely outside what
TMDB's own similarity model already associates with an existing favorite
could ever enter the pool, no matter how good a match it might actually be.

This script queries TMDB's own /discover/{movie|tv} endpoint instead -
genre-filtered, seeded from Bill's REAL loved-genre mix (derived live from
enrichedMetadata.json's cached genres on his myRating>=9 titles, never
guessed or hardcoded), sorted by vote_average with a vote-count floor to
exclude obscure/single-vote junk. A title reaching the pool this way was
never cited by anything Bill has already loved - a structurally different
signal from the similarity-graph path, exactly the "second, independent
discovery source" the dashboard finding calls for.

Genre name -> TMDB genre id mapping is fetched live from TMDB's own
/genre/movie/list and /genre/tv/list (never hand-typed from memory) -
this project's standing discipline is to verify an id against a real
source, not assume a "well-known" id is still correct.

Every stub this script adds is tagged source: 'genre-explore' (the
existing discover_candidates.js stubs carry a citedBy count instead and no
source field) so this pipeline's own share of the pool - and therefore the
closed-loop percentage the dashboard finding tracks - is directly
measurable going forward, not just assumed fixed by having run this once.

Writes bare-id stubs only (title/year null) - same convention as
discover_candidates.js and resolve_titles.py - and lets enrich_tmdb.py
backfill full detail (genres/cast/similar/etc.) in the same workflow run,
so every candidate competes on equal footing once scored regardless of
which discovery path found it.

Run manually:   TMDB_API_KEY=... python3 trakt/discover_explore.py [max_new_per_type] [top_genres_per_type]
GitHub Action:  .github/workflows/trakt-discover-candidates.yml
"""

import json, os, sys, time, urllib.request, urllib.parse, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
MAX_NEW_PER_TYPE = int(sys.argv[1]) if len(sys.argv) > 1 else 20
TOP_GENRES_PER_TYPE = int(sys.argv[2]) if len(sys.argv) > 2 else 4
LOVED_THRESHOLD = 9  # same constant as discover_candidates.js
MIN_VOTE_COUNT = 150  # a "genuinely well-regarded, not a fluke" floor - deliberately
                       # higher than discover_candidates.js's MIN_CANDIDATE_VOTE_COUNT=5,
                       # since that one only screens out near-zero-data filler citations,
                       # while this source is explicitly hunting for well-established titles
                       # outside the similarity bubble, not just anything non-obscure.

API_KEY = os.environ.get('TMDB_API_KEY', '')
HEADERS = {'User-Agent': 'my-books-trakt-enrichment (personal watch-history app)'}
API_BASE = 'https://api.themoviedb.org/3'
DELAY = 0.35


def get_json(url, timeout=10):
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


def read_json(p, fallback):
    try:
        return json.load(open(p))
    except Exception:
        return fallback


def write_json(p, data):
    # 2-space indent + trailing newline, matching prune_candidate_pool.js's
    # own JSON.stringify(data, null, 2) + '\n' convention for this same file.
    open(p, 'w').write(json.dumps(data, indent=2) + '\n')


def main():
    if not API_KEY:
        print('ERROR: TMDB_API_KEY is not set. Create a free key at themoviedb.org and set it as an env var '
              '(or the TMDB_API_KEY repo secret for the GitHub Action).', file=sys.stderr)
        sys.exit(1)

    library = read_json(DATA_DIR / 'library.json', {'titles': []})
    watchlist = read_json(DATA_DIR / 'watchlist.json', {'titles': []})
    enriched = read_json(DATA_DIR / 'enrichedMetadata.json', {})
    pool = read_json(DATA_DIR / 'candidatePool.json', {'titles': []})
    history = read_json(DATA_DIR / 'discoveredHistory.json', {'titleKeys': []})

    known = set(history.get('titleKeys', []))
    for t in library.get('titles', []) + watchlist.get('titles', []) + pool.get('titles', []):
        if t.get('titleKey'):
            known.add(t['titleKey'])

    # 1. Bill's real loved-genre mix, per type, from his own rating history -
    # never guessed. Raw TMDB genre names (not the engine's canonical
    # inferGenre() bucket) since this script deliberately stays a standalone,
    # dependency-free network script, same spirit as discover_candidates.js
    # staying dependency-free for its own local-only computation.
    genre_counts = {'movie': {}, 'show': {}}
    for t in library.get('titles', []):
        if (t.get('myRating') or 0) < LOVED_THRESHOLD:
            continue
        meta = enriched.get(t.get('titleKey'))
        if not meta:
            continue
        for g in (meta.get('genres') or []):
            genre_counts[t['type']][g] = genre_counts[t['type']].get(g, 0) + 1

    for kind in ('movie', 'show'):
        top = sorted(genre_counts[kind].items(), key=lambda kv: -kv[1])[:TOP_GENRES_PER_TYPE]
        print(f'Top {kind} genres from real loved (myRating>={LOVED_THRESHOLD}) titles: '
              + ', '.join(f'{g} ({n})' for g, n in top))

    # 2. Real TMDB genre id lists - fetched live, never hand-typed.
    genre_id_maps = {}
    for kind, tmdb_kind in (('movie', 'movie'), ('show', 'tv')):
        data, status, err = get_json(f'{API_BASE}/genre/{tmdb_kind}/list?api_key={API_KEY}')
        if status == 401:
            print(f'ERROR: TMDB rejected the API key (401). Response: {err!r}', file=sys.stderr)
            sys.exit(1)
        if not data:
            print(f'ERROR: could not fetch {tmdb_kind} genre list (status {status}, {err!r})', file=sys.stderr)
            sys.exit(1)
        genre_id_maps[kind] = {g['name']: g['id'] for g in data.get('genres', [])}
        time.sleep(DELAY)

    added = {'movie': [], 'show': []}
    skipped_unmapped = []
    total_raw = 0

    for kind, tmdb_kind in (('movie', 'movie'), ('show', 'tv')):
        top_genres = sorted(genre_counts[kind].items(), key=lambda kv: -kv[1])[:TOP_GENRES_PER_TYPE]
        date_gte_param = None
        if kind == 'movie':
            # Mirrors engine.js's isPreMillenniumMovie() hard filter (movies
            # only) - no point discovering a candidate that can never surface.
            date_gte_param = 'primary_release_date.gte=2000-01-01'

        per_genre_results = []  # list of lists, one per genre, already vote_average-sorted by TMDB
        for genre_name, loved_count in top_genres:
            genre_id = genre_id_maps[kind].get(genre_name)
            if genre_id is None:
                skipped_unmapped.append(f'{kind}:{genre_name}')
                continue
            url = (f'{API_BASE}/discover/{tmdb_kind}?api_key={API_KEY}'
                   f'&with_genres={genre_id}&sort_by=vote_average.desc'
                   f'&vote_count.gte={MIN_VOTE_COUNT}&with_original_language=en&page=1')
            if date_gte_param:
                url += f'&{date_gte_param}'
            data, status, err = get_json(url)
            time.sleep(DELAY)
            if status == 401:
                print(f'ERROR: TMDB rejected the API key (401) mid-run. Response: {err!r}', file=sys.stderr)
                sys.exit(1)
            if not data:
                print(f'  WARNING: /discover/{tmdb_kind} for genre {genre_name!r} failed '
                      f'(status {status}, {err!r}) - skipping this genre.', file=sys.stderr)
                continue
            results = data.get('results') or []
            total_raw += len(results)
            per_genre_results.append((genre_name, results))
            print(f'  {kind}/{genre_name}: {len(results)} raw results (vote_count>={MIN_VOTE_COUNT}, en, sorted by vote_average)')

        # Round-robin across genres so the cap doesn't get consumed entirely
        # by whichever genre happened to be queried first - keeps the added
        # set genre-diverse, matching the spread of Bill's real preferences
        # rather than his single top genre alone.
        seen_this_run = set()
        idx_per_genre = [0] * len(per_genre_results)
        made_progress = True
        while len(added[kind]) < MAX_NEW_PER_TYPE and made_progress:
            made_progress = False
            for gi, (genre_name, results) in enumerate(per_genre_results):
                if len(added[kind]) >= MAX_NEW_PER_TYPE:
                    break
                while idx_per_genre[gi] < len(results):
                    r = results[idx_per_genre[gi]]
                    idx_per_genre[gi] += 1
                    tmdb_id = r.get('id')
                    if tmdb_id is None:
                        continue
                    title_key = f'{kind}:{tmdb_id}'
                    if title_key in known or title_key in seen_this_run:
                        continue
                    seen_this_run.add(title_key)
                    date_field = 'release_date' if kind == 'movie' else 'first_air_date'
                    name_field = 'title' if kind == 'movie' else 'name'
                    year = None
                    date_str = r.get(date_field)
                    if date_str:
                        try:
                            year = int(date_str[:4])
                        except ValueError:
                            year = None
                    added[kind].append({
                        'type': kind,
                        'titleKey': title_key,
                        'ids': {'tmdb': tmdb_id},
                        'title': r.get(name_field),
                        'year': year,
                        'source': 'genre-explore',
                        'discoveredVia': genre_name,
                    })
                    made_progress = True
                    break  # move to the next genre's turn

    all_added = added['movie'] + added['show']
    pool['titles'] = pool.get('titles', []) + all_added
    pool['meta'] = {**pool.get('meta', {}), 'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
                     'count': len(pool['titles'])}
    write_json(DATA_DIR / 'candidatePool.json', pool)

    history_keys = set(history.get('titleKeys', []))
    for c in all_added:
        history_keys.add(c['titleKey'])
    write_json(DATA_DIR / 'discoveredHistory.json', {'titleKeys': sorted(history_keys)})

    print(f'\n{total_raw} raw /discover results fetched across both types.')
    if skipped_unmapped:
        print(f'{len(skipped_unmapped)} genre(s) had no matching TMDB id, skipped: {", ".join(skipped_unmapped)}')
    print(f'Added {len(added["movie"])} new movie candidate(s), {len(added["show"])} new show candidate(s) '
          f'via genre-explore (all tagged source: "genre-explore", none were cited by any loved title\'s '
          f'similar/recommendations list).')
    print(f'trakt/data/candidatePool.json now has {len(pool["titles"])} total candidates.')


if __name__ == '__main__':
    main()
