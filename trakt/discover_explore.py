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

This script queries TMDB's own /discover/{movie|tv} endpoint instead, via
TWO independent seeding sources:

1. GENRE-EXPLORE (original) - genre-filtered, seeded from Bill's REAL
   loved-genre mix (derived live from enrichedMetadata.json's cached
   genres on his myRating>=9 titles, never guessed or hardcoded), sorted
   by vote_average with a vote-count floor to exclude obscure/single-vote
   junk.

2. BOOK-THEME-EXPLORE (added later) - a second, independent seed list, not
   from his screen history at all: trakt/data/bookThemeGaps.json (built by
   trakt/scripts/compute_book_theme_gaps.js) ranks BBRE book themes that
   are proportionally BIGGER in Bill's real 5-star-read book taste than
   his current screen taste/candidate pool reflects - e.g. legal (3.1x
   over-represented in books vs. screen), psychological (2.4x), thriller
   (1.9x, but genuinely still real since books skew even more thriller-
   heavy than screen already is), business (1.5x), biography, sports,
   tech history. A gap theme with a real TMDB genre equivalent
   (genre:thriller -> "Thriller") reuses the genre-query path unchanged;
   everything else (business/biography/sports/tech-history/psychological
   have no native TMDB genre at all) resolves a real TMDB keyword id live
   via /search/keyword?query=... (a hand-picked, real-world search
   PHRASE, never a guessed id) and queries /discover with
   with_keywords=<id> instead of with_genres=<id>. This is the FIRST
   candidate-discovery signal in this pipeline not seeded from Trakt watch
   history at all - it can reach genuinely underexplored territory
   (business/finance/legal-thriller candidates, say) that neither the
   citation-graph discoverer NOR genre-explore's own Trakt-genre seeding
   could ever surface, since both of those are bounded by what's already
   in Bill's loved screen titles.

Both sources tag every stub with a distinct `source` field
('genre-explore' / 'book-theme-explore'; the citation-graph discoverer's
own stubs carry a `citedBy` count and no source field) so each pipeline's
real share of the pool - and therefore the "closed-loop" percentage the
dashboard finding tracks - stays directly measurable going forward, never
just assumed fixed by having run something once.

Genre name -> TMDB genre id mapping (and, for book-theme-explore's keyword
mode, keyword name -> TMDB keyword id) is fetched/resolved live from
TMDB's own real endpoints (never hand-typed from memory) - this project's
standing discipline is to verify an id against a real source, not assume a
"well-known" id is still correct.

Writes bare-id stubs only (title/year null) - same convention as
discover_candidates.js and resolve_titles.py - and lets enrich_tmdb.py
backfill full detail (genres/cast/similar/etc.) in the same workflow run,
so every candidate competes on equal footing once scored regardless of
which discovery path found it. Critically, discovery never changes how a
candidate is SCORED once found - every stub from either source still
competes purely on matchScore()'s existing signals (including
bookTasteBonus() itself, which any book-theme-explore stub is especially
likely to score well on, but isn't guaranteed to - a bad match still loses
on its own merits).

Run manually:   TMDB_API_KEY=... python3 trakt/discover_explore.py [max_new_per_type] [top_genres_per_type] [max_new_per_type_book_theme]
GitHub Action:  .github/workflows/trakt-discover-candidates.yml
"""

import json, os, sys, time, urllib.request, urllib.parse, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
MAX_NEW_PER_TYPE = int(sys.argv[1]) if len(sys.argv) > 1 else 20
TOP_GENRES_PER_TYPE = int(sys.argv[2]) if len(sys.argv) > 2 else 4
MAX_NEW_PER_TYPE_BOOK_THEME = int(sys.argv[3]) if len(sys.argv) > 3 else 15
LOVED_THRESHOLD = 9  # same constant as discover_candidates.js
MIN_VOTE_COUNT = 150  # a "genuinely well-regarded, not a fluke" floor - deliberately
                       # higher than discover_candidates.js's MIN_CANDIDATE_VOTE_COUNT=5,
                       # since that one only screens out near-zero-data filler citations,
                       # while this source is explicitly hunting for well-established titles
                       # outside the similarity bubble, not just anything non-obscure.
MAX_PAGES_PER_GENRE = 5  # Real bug found and fixed 2026-09: page=1 only, forever, meant
                          # each genre query returned the SAME top-20-by-vote_average titles
                          # every run - after 3 real production runs querying the same top
                          # genres, discoveredHistory.json's permanent "known" tracking had
                          # exhausted nearly all of page 1 (a 4th real run: 320 raw results
                          # across 16 genre queries yielded just 1 new candidate total).
                          # TMDB's own vote_average-sorted list is far longer than 20 items -
                          # paginating deeper (still vote_average-sorted, so quality doesn't
                          # degrade, it just reaches further down the same ranked list) finds
                          # genuinely new candidates the exact same query has simply not
                          # reached yet. Bounded at 5 pages/genre (100 titles) to keep the
                          # per-run API-call count reasonable; stops early per-genre once a
                          # page returns fewer than 20 results (real end of TMDB's data).
MAX_PAGES_PER_BOOK_THEME = 3  # Kept shallower than genre-explore's 5 - a book-theme
                               # gap's query (a specific keyword, or a single already-
                               # real-TMDB-genre) is inherently narrower than a broad
                               # top-loved-genre query, so 60 titles/query is plenty to
                               # find real new candidates without inflating the per-run
                               # API-call count for a still-experimental second channel.

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


def fetch_discover_pages(tmdb_kind, filter_param, date_gte_param, animation_exclude_param, max_pages, label):
    """Shared pagination loop for both /discover seeding paths (genre-mode
    passes with_genres=, book-theme keyword-mode passes with_keywords=) -
    same vote_average sort/vote-count floor/language/date/animation-
    exclusion contract either way, so a candidate found via either path
    competes on identically-filtered TMDB results."""
    results = []
    for page in range(1, max_pages + 1):
        url = (f'{API_BASE}/discover/{tmdb_kind}?api_key={API_KEY}'
               f'&{filter_param}&sort_by=vote_average.desc'
               f'&vote_count.gte={MIN_VOTE_COUNT}&with_original_language=en&page={page}')
        if date_gte_param:
            url += f'&{date_gte_param}'
        if animation_exclude_param:
            url += f'&{animation_exclude_param}'
        data, status, err = get_json(url)
        time.sleep(DELAY)
        if status == 401:
            print(f'ERROR: TMDB rejected the API key (401) mid-run. Response: {err!r}', file=sys.stderr)
            sys.exit(1)
        if not data:
            if page == 1:
                print(f'  WARNING: /discover/{tmdb_kind} for {label} failed (status {status}, {err!r}) - skipping.',
                      file=sys.stderr)
            break
        page_results = data.get('results') or []
        results.extend(page_results)
        if len(page_results) < 20:
            break  # real end of TMDB's result list for this query
    return results


def resolve_keyword_id(query, cache):
    """Real TMDB keyword id, resolved live via /search/keyword - never a
    hand-typed guess. Takes the first (most relevant, per TMDB's own
    ranking) result. Cached across calls so the same query string (e.g.
    'business' queried once, reused for both movie and show passes) only
    ever costs one real API call per run."""
    if query in cache:
        return cache[query]
    url = f'{API_BASE}/search/keyword?api_key={API_KEY}&query={urllib.parse.quote(query)}'
    data, status, err = get_json(url)
    time.sleep(DELAY)
    if status == 401:
        print(f'ERROR: TMDB rejected the API key (401) mid-run. Response: {err!r}', file=sys.stderr)
        sys.exit(1)
    results = (data or {}).get('results') or []
    keyword_id = results[0]['id'] if results else None
    cache[query] = keyword_id
    if keyword_id is None:
        print(f'  WARNING: no TMDB keyword found for query {query!r} - skipping this book-theme gap.', file=sys.stderr)
    return keyword_id


def round_robin_add(kind, per_source_results, known, seen_this_run, cap, added_list, source, via_prefix=''):
    """Shared round-robin fill (originally the genre-explore loop's own
    inline logic, extracted so book-theme-explore can reuse it exactly -
    keeps the cap from being consumed entirely by whichever source/theme
    happened to be queried first, same fairness guarantee both discovery
    passes now share)."""
    idx_per_source = [0] * len(per_source_results)
    made_progress = True
    while len(added_list) < cap and made_progress:
        made_progress = False
        for gi, (via_name, results) in enumerate(per_source_results):
            if len(added_list) >= cap:
                break
            while idx_per_source[gi] < len(results):
                r = results[idx_per_source[gi]]
                idx_per_source[gi] += 1
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
                added_list.append({
                    'type': kind,
                    'titleKey': title_key,
                    'ids': {'tmdb': tmdb_id},
                    'title': r.get(name_field),
                    'year': year,
                    'source': source,
                    'discoveredVia': f'{via_prefix}{via_name}',
                })
                made_progress = True
                break  # move to the next source's turn


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
    book_theme_gaps = read_json(DATA_DIR / 'bookThemeGaps.json', {'gaps': []}).get('gaps', [])

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

    if book_theme_gaps:
        print('Book-theme discovery gaps (from trakt/data/bookThemeGaps.json, real BBRE 5-star-read theme counts '
              'vs. real BMTRE loved-title genre/subgenre/subject scores): '
              + ', '.join(f'{g["key"]} ({g["ratio"]}x, mode={g["mode"]})' for g in book_theme_gaps))
    else:
        print('No trakt/data/bookThemeGaps.json found or it has no gaps - run '
              'node trakt/scripts/compute_book_theme_gaps.js first to enable book-theme-explore. Skipping that pass.')

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
    added_book_theme = {'movie': [], 'show': []}
    skipped_unmapped = []
    skipped_book_theme = []
    total_raw = 0
    keyword_id_cache = {}

    for kind, tmdb_kind in (('movie', 'movie'), ('show', 'tv')):
        top_genres = sorted(genre_counts[kind].items(), key=lambda kv: -kv[1])[:TOP_GENRES_PER_TYPE]
        date_gte_param = None
        if kind == 'movie':
            # Mirrors engine.js's isPreMillenniumMovie() hard filter (movies
            # only) - no point discovering a candidate that can never surface.
            date_gte_param = 'primary_release_date.gte=2000-01-01'
        # Mirrors engine.js's isAnimation() hard filter (both types) - real,
        # verified waste found 2026-09-11: a run's own stale-removal log
        # showed a large share of "new this run" candidates were animated
        # titles (Kung Fu Panda 4, Toy Story 3, My Little Pony, Scooby-Doo,
        # Steven Universe, etc.) surfaced as secondary matches within
        # Comedy/Adventure/Action-family /discover queries, then thrown away
        # on the very next prune pass regardless of score or reserved-share
        # protection - wasted API calls, wasted enrichment, wasted discovery
        # slots that never had a real chance to compete. Fetched live from
        # the same genre_id_maps already built above, never hand-typed.
        animation_id = genre_id_maps[kind].get('Animation')
        animation_exclude_param = f'without_genres={animation_id}' if animation_id is not None else None

        per_genre_results = []  # list of (genre_name, results), already vote_average-sorted by TMDB
        for genre_name, loved_count in top_genres:
            genre_id = genre_id_maps[kind].get(genre_name)
            if genre_id is None:
                skipped_unmapped.append(f'{kind}:{genre_name}')
                continue
            this_animation_exclude = animation_exclude_param if genre_id != animation_id else None
            genre_results = fetch_discover_pages(
                tmdb_kind, f'with_genres={genre_id}', date_gte_param, this_animation_exclude,
                MAX_PAGES_PER_GENRE, f'genre {genre_name!r}')
            total_raw += len(genre_results)
            per_genre_results.append((genre_name, genre_results))
            print(f'  {kind}/{genre_name}: {len(genre_results)} raw results across up to {MAX_PAGES_PER_GENRE} pages '
                  f'(vote_count>={MIN_VOTE_COUNT}, en, sorted by vote_average)')

        # Round-robin across genres so the cap doesn't get consumed entirely
        # by whichever genre happened to be queried first - keeps the added
        # set genre-diverse, matching the spread of Bill's real preferences
        # rather than his single top genre alone.
        seen_this_run = set()
        round_robin_add(kind, per_genre_results, known, seen_this_run, MAX_NEW_PER_TYPE, added[kind], 'genre-explore')

    # 3. Book-theme-explore - a second, independent seed list per type, not
    # from Trakt watch history at all (see module docstring). Runs AFTER
    # genre-explore so `known` already reflects this run's own genre-explore
    # additions (no double-adding the same title via both passes in one run).
    for c in added['movie'] + added['show']:
        known.add(c['titleKey'])

    if book_theme_gaps:
        for kind, tmdb_kind in (('movie', 'movie'), ('show', 'tv')):
            date_gte_param = 'primary_release_date.gte=2000-01-01' if kind == 'movie' else None
            animation_id = genre_id_maps[kind].get('Animation')
            animation_exclude_param = f'without_genres={animation_id}' if animation_id is not None else None

            per_gap_results = []
            for gap in book_theme_gaps:
                filter_param = None
                if gap['mode'] == 'genre':
                    tmdb_name = (gap.get('tmdbGenreNames') or {}).get(kind)
                    if not tmdb_name:
                        continue  # this gap's genre mode doesn't apply to this type (e.g. Thriller is movie-only)
                    genre_id = genre_id_maps[kind].get(tmdb_name)
                    if genre_id is None:
                        skipped_book_theme.append(f'{kind}:{gap["key"]} (genre {tmdb_name!r} not found on TMDB)')
                        continue
                    filter_param = f'with_genres={genre_id}'
                else:  # keyword mode
                    keyword_id = resolve_keyword_id(gap['searchQuery'], keyword_id_cache)
                    if keyword_id is None:
                        skipped_book_theme.append(f'{kind}:{gap["key"]} (no TMDB keyword match for {gap["searchQuery"]!r})')
                        continue
                    filter_param = f'with_keywords={keyword_id}'

                # Unlike genre-explore's loop over ALL of Bill's top loved
                # genres (which could legitimately include Animation itself,
                # needing a self-exclusion guard), none of the curated
                # book-theme gaps ever target Animation - always safe to
                # exclude it outright here.
                gap_results = fetch_discover_pages(
                    tmdb_kind, filter_param, date_gte_param, animation_exclude_param,
                    MAX_PAGES_PER_BOOK_THEME, f'book-theme {gap["key"]!r} ({gap["mode"]})')
                total_raw += len(gap_results)
                per_gap_results.append((gap['key'], gap_results))
                print(f'  {kind}/book-theme:{gap["key"]}: {len(gap_results)} raw results '
                      f'(mode={gap["mode"]}, vote_count>={MIN_VOTE_COUNT}, en, sorted by vote_average)')

            seen_this_run_bt = set()
            round_robin_add(kind, per_gap_results, known, seen_this_run_bt, MAX_NEW_PER_TYPE_BOOK_THEME,
                             added_book_theme[kind], 'book-theme-explore', via_prefix='book-theme:')

    all_added = added['movie'] + added['show'] + added_book_theme['movie'] + added_book_theme['show']
    pool['titles'] = pool.get('titles', []) + all_added
    pool['meta'] = {**pool.get('meta', {}), 'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
                     'count': len(pool['titles'])}
    write_json(DATA_DIR / 'candidatePool.json', pool)

    history_keys = set(history.get('titleKeys', []))
    for c in all_added:
        history_keys.add(c['titleKey'])
    write_json(DATA_DIR / 'discoveredHistory.json', {'titleKeys': sorted(history_keys)})

    print(f'\n{total_raw} raw /discover results fetched across both types and both discovery sources.')
    if skipped_unmapped:
        print(f'{len(skipped_unmapped)} genre-explore genre(s) had no matching TMDB id, skipped: {", ".join(skipped_unmapped)}')
    if skipped_book_theme:
        print(f'{len(skipped_book_theme)} book-theme gap(s) skipped: {", ".join(skipped_book_theme)}')
    print(f'Added {len(added["movie"])} new movie candidate(s), {len(added["show"])} new show candidate(s) '
          f'via genre-explore (source: "genre-explore").')
    print(f'Added {len(added_book_theme["movie"])} new movie candidate(s), {len(added_book_theme["show"])} new show '
          f'candidate(s) via book-theme-explore (source: "book-theme-explore") - none cited by any loved title\'s '
          f'similar/recommendations list, and seeded from Bill\'s real book taste rather than his screen history.')
    print(f'trakt/data/candidatePool.json now has {len(pool["titles"])} total candidates.')


if __name__ == '__main__':
    main()
