#!/usr/bin/env python3
"""
Builds a real, curated review list for the "old dislikes missing data" gap
(Data Quality dashboard's library-recency-selection-bias finding, Opportunity
#1): Bill's library has an asymmetric selection bias by era — old titles
were only ever logged when he already loved them, so every myRating-derived
preference signal has zero negative examples for content before ~2010. A
content-age-decay fix was tried and PROVEN to make things worse (see that
finding's own record) — the only real fix is real data. This script pulls
that real data's raw material.

Deliberately targets Bill's real UNDER-represented genres (computed live
from his actual rated-title counts per TMDB genre, never guessed) rather
than a random or popularity-only sample — a well-known old movie in a genre
he already has 180+ rated titles in (Crime, Drama, Comedy) mostly just
re-confirms what the model already knows; a well-known old movie in a genre
he has under ~20 rated titles in (Horror, Western, Romance, Documentary,
War, Music, Fantasy) is where a genuine, informative dislike is statistically
most likely AND most valuable if found.

Sourced entirely from TMDB's own /discover endpoint, sorted by vote_count
(a recognizability proxy — a title needs to be genuinely well-known for
Bill to have a real opinion to report, not just critically well-regarded
with a handful of votes), pre-2010, English-language, non-animated — same
"real, well-regarded, not obscure" discipline as discover_explore.py, just
aimed at Bill's own genre gaps instead of his existing loved-genre mix.

Excludes anything already in library/watchlist/candidatePool/
discoveredHistory (the exact same `known` set every other discovery script
in this pipeline uses) — no point re-showing something already logged.

Writes trakt/output/old-title-review-manifest.json (title, year, type,
targetGenre, overview, tmdbId, imdbId, voteCount) — NOT trakt/data/, since
this is a one-off working artifact for a single review exercise, not
ongoing app data. build_old_title_review_xlsx.mjs (run locally afterward)
turns this into the actual spreadsheet Bill fills in.

Run manually only (one-off, not scheduled):
  TMDB_API_KEY=... python3 trakt/build_old_title_review_list.py [target_count]
GitHub Action: .github/workflows/trakt-build-review-list.yml (workflow_dispatch)
"""

import json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
OUTPUT_DIR = ROOT / 'trakt' / 'output'
TARGET_COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 100
CUTOFF_YEAR = 2010  # matches the exact boundary the library-recency-selection-bias finding uses
# Bill, born 1983: "basically almost any movie or tv show before 1990 I have
# never wanted to see" - confirmed by real research, not just his own
# impression: the "reminiscence bump" (cross-cultural, consistently ages
# 5-30, peak impact in the teens - see Vice/HuffPost/Medium coverage of the
# underlying psychology research) means pop-culture preference forms almost
# entirely inside that window. Content from before it opens isn't a taste
# judgment at all, just outside the window his brain was ever forming
# preferences in - the first real batch (2026-09) confirmed this exactly:
# every pre-1990 title in that batch came back "never wanted to see it."
# Floored here so future batches don't keep spending review-list slots on
# titles that can only ever produce a non-informative "not interested"
# result, never the real watched-and-disliked data this whole exercise
# exists to find.
MIN_YEAR = 1990
MIN_VOTE_COUNT_MOVIE = 800   # a real "everyone's heard of this" bar for movies
MIN_VOTE_COUNT_SHOW = 150    # TV shows carry far fewer TMDB votes than movies at any popularity tier
MAX_PAGES_PER_GENRE = 3

API_KEY = os.environ.get('TMDB_API_KEY', '')
HEADERS = {'User-Agent': 'my-books-trakt-enrichment (personal watch-history app)'}
API_BASE = 'https://api.themoviedb.org/3'
DELAY = 0.35

# Real, under-represented genres per type — computed live from Bill's
# actual rated-title counts before this script was written (see the
# library-recency-selection-bias finding's own investigation), not guessed.
# Genres already carrying 100+ rated titles (Drama, Crime, Comedy, Mystery)
# are deliberately excluded — more titles there mostly re-confirm what the
# model already knows, not fill a real gap. A name with no match in a
# given type's real genre list (checked live below) is skipped, same
# defensive pattern discover_explore.py already uses.
TARGET_GENRES = {
    'movie': ['Horror', 'Western', 'Romance', 'Documentary', 'War', 'Music', 'Fantasy', 'Adventure', 'Science Fiction', 'History'],
    'show': ['War & Politics', 'Sci-Fi & Fantasy', 'Documentary', 'Western', 'Family'],
}


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
    p.parent.mkdir(parents=True, exist_ok=True)
    open(p, 'w').write(json.dumps(data, indent=2) + '\n')


def main():
    if not API_KEY:
        print('ERROR: TMDB_API_KEY is not set.', file=sys.stderr)
        sys.exit(1)

    library = read_json(DATA_DIR / 'library.json', {'titles': []})
    watchlist = read_json(DATA_DIR / 'watchlist.json', {'titles': []})
    pool = read_json(DATA_DIR / 'candidatePool.json', {'titles': []})
    history = read_json(DATA_DIR / 'discoveredHistory.json', {'titleKeys': []})

    known = set(history.get('titleKeys', []))
    for t in library.get('titles', []) + watchlist.get('titles', []) + pool.get('titles', []):
        if t.get('titleKey'):
            known.add(t['titleKey'])
    print(f'{len(known)} already-known titleKeys excluded from consideration.')

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

    all_candidates = []  # list of dicts, before trimming to TARGET_COUNT
    skipped_unmapped = []
    total_raw = 0

    for kind, tmdb_kind in (('movie', 'movie'), ('show', 'tv')):
        animation_id = genre_id_maps[kind].get('Animation')
        date_field_param = 'primary_release_date.lte' if kind == 'movie' else 'first_air_date.lte'
        min_votes = MIN_VOTE_COUNT_MOVIE if kind == 'movie' else MIN_VOTE_COUNT_SHOW
        # Global across ALL target genres for this type, not reset per genre -
        # a title that legitimately matches two queried genres (Star Wars:
        # Adventure AND Science Fiction) must only ever occupy one review-list
        # slot, not one per matching genre. Real bug found in the first real
        # batch (2026-09): 12 titles appeared twice (Star Wars, Back to the
        # Future, Braveheart, ALF, and 8 more) because the old per-genre-only
        # `seen_this_genre` reset let the same TMDB id through a second time
        # under a different targetGenre - Bill had to manually dedupe the
        # returned spreadsheet by hand (min-of-duplicate-ratings) before the
        # data could be used. Fixed at the source here so no future batch
        # repeats it.
        seen_titlekeys = set()

        for genre_name in TARGET_GENRES[kind]:
            genre_id = genre_id_maps[kind].get(genre_name)
            if genre_id is None:
                skipped_unmapped.append(f'{kind}:{genre_name}')
                continue

            genre_results = []
            for page in range(1, MAX_PAGES_PER_GENRE + 1):
                date_field_gte = 'primary_release_date.gte' if kind == 'movie' else 'first_air_date.gte'
                url = (f'{API_BASE}/discover/{tmdb_kind}?api_key={API_KEY}'
                       f'&with_genres={genre_id}&sort_by=vote_count.desc'
                       f'&vote_count.gte={min_votes}&with_original_language=en'
                       f'&{date_field_param}={CUTOFF_YEAR - 1}-12-31'
                       f'&{date_field_gte}={MIN_YEAR}-01-01&page={page}')
                if animation_id is not None and genre_id != animation_id:
                    url += f'&without_genres={animation_id}'
                data, status, err = get_json(url)
                time.sleep(DELAY)
                if status == 401:
                    print(f'ERROR: TMDB rejected the API key (401) mid-run.', file=sys.stderr)
                    sys.exit(1)
                if not data:
                    if page == 1:
                        print(f'  WARNING: /discover/{tmdb_kind} for genre {genre_name!r} failed '
                              f'(status {status}, {err!r}) - skipping.', file=sys.stderr)
                    break
                page_results = data.get('results') or []
                genre_results.extend(page_results)
                if len(page_results) < 20:
                    break
            total_raw += len(genre_results)
            print(f'  {kind}/{genre_name}: {len(genre_results)} raw results (vote_count>={min_votes}, pre-{CUTOFF_YEAR}, en)')

            for r in genre_results:
                tmdb_id = r.get('id')
                if tmdb_id is None:
                    continue
                title_key = f'{kind}:{tmdb_id}'
                if title_key in known or title_key in seen_titlekeys:
                    continue
                seen_titlekeys.add(title_key)
                date_field = 'release_date' if kind == 'movie' else 'first_air_date'
                name_field = 'title' if kind == 'movie' else 'name'
                date_str = r.get(date_field)
                year = None
                if date_str:
                    try:
                        year = int(date_str[:4])
                    except ValueError:
                        year = None
                all_candidates.append({
                    'type': kind,
                    'titleKey': title_key,
                    'tmdbId': tmdb_id,
                    'title': r.get(name_field),
                    'year': year,
                    'targetGenre': genre_name,
                    'overview': (r.get('overview') or '')[:300],
                    'voteCount': r.get('vote_count'),
                    'voteAverage': r.get('vote_average'),
                })

    # Round-robin trim to TARGET_COUNT, preserving genre spread rather than
    # letting whichever genre queried first (or has the deepest TMDB
    # catalog) dominate the final list - same fairness principle
    # discover_explore.py's own round_robin_add() already established.
    by_genre = {}
    for c in all_candidates:
        by_genre.setdefault((c['type'], c['targetGenre']), []).append(c)
    for key in by_genre:
        by_genre[key].sort(key=lambda c: -(c['voteCount'] or 0))

    final = []
    keys_cycle = list(by_genre.keys())
    idx_per_key = {k: 0 for k in keys_cycle}
    made_progress = True
    while len(final) < TARGET_COUNT and made_progress:
        made_progress = False
        for k in keys_cycle:
            if len(final) >= TARGET_COUNT:
                break
            lst = by_genre[k]
            i = idx_per_key[k]
            if i < len(lst):
                final.append(lst[i])
                idx_per_key[k] = i + 1
                made_progress = True

    final.sort(key=lambda c: (c['type'], c['targetGenre'], -(c['voteCount'] or 0)))

    out = {
        'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
        'cutoffYear': CUTOFF_YEAR,
        'purpose': 'library-recency-selection-bias / Opportunity #1 - real candidates for Bill to react to, '
                   'targeting his real under-represented genres so genuine old dislikes have somewhere to be found.',
        'titles': final,
    }
    write_json(OUTPUT_DIR / 'old-title-review-manifest.json', out)

    print(f'\n{total_raw} raw /discover results fetched across {len(TARGET_GENRES["movie"]) + len(TARGET_GENRES["show"])} genre queries.')
    if skipped_unmapped:
        print(f'{len(skipped_unmapped)} genre(s) had no matching TMDB id for their type, skipped: {", ".join(skipped_unmapped)}')
    movies_final = sum(1 for c in final if c['type'] == 'movie')
    shows_final = sum(1 for c in final if c['type'] == 'show')
    print(f'Final review list: {len(final)} titles ({movies_final} movies, {shows_final} shows).')
    print('Written to trakt/output/old-title-review-manifest.json')


if __name__ == '__main__':
    main()
