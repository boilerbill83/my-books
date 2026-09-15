#!/usr/bin/env python3
"""
Downloads and commits real poster image FILES for every watched/watchlist/
candidate title, so the dashboard can serve posters from this repo's own
GitHub Pages domain instead of image.tmdb.org at view time.

Bill's real, confirmed report (2026-09-15): on his work computer, "everything
else loads fine" but every poster renders as a blank placeholder — the
dashboard itself (boilerbill83.github.io) loads fine, but image.tmdb.org
specifically doesn't, the classic signature of a corporate network content
filter blocking a third-party media/CDN domain by category while the
generic code-hosting domain it's embedded in stays allowed. Since this is a
static GitHub Pages site with no server-side proxying capability, the only
real fix is to stop depending on a third-party image host at all for
anything the dashboard actually displays — pre-fetch the real bytes once
here and commit them as ordinary files under this same origin.

Scope: the union of library.json + watchlist.json + candidatePool.json
titleKeys (1,156 as of the run that added this script) — everything that
can actually render a poster somewhere in the dashboard — not the full,
much larger enrichedMetadata.json backlog, which includes stale/pruned/
discovered-then-evicted entries no live page ever shows.

Cached at trakt/data/posters/<type>-<tmdbId>.jpg, one fixed size (w185 —
TMDB's own poster size, real ~15-25KB JPEGs; a reasonable middle ground
covering every real on-page display size from 38px up to the 150px hero
poster with a real retina margin at every one of them, since a browser
downscaling a slightly-larger image costs nothing at view time the way an
extra network request would). Resumable via plain file-existence
(same cache-membership idiom as enrich_tmdb.py/enrich_omdb.py) — a title
whose file already exists is never re-fetched.

engine.js's posterUrl() reads this cache directly (a relative
./data/posters/<file>.jpg path) rather than falling back to the live TMDB
CDN URL for anything not yet cached here — deliberately, so a title that
slips through this script can never re-introduce the exact problem this
script exists to solve. A missing/not-yet-cached file just 404s, which
posterImgHtml()'s existing onerror handler already turns into the same
graceful empty-poster placeholder a title with no TMDB poster at all gets.

Run manually:   python3 trakt/scripts/cache_posters.py [batch_size]
GitHub Action:  .github/workflows/trakt-cache-posters.yml

REFRESH_ALL=1 (or --refresh-all) re-fetches every title's poster
regardless of whether a local file already exists — for the rare case a
title's posterPath changes (TMDB swaps a poster) and the cached file
needs to catch up.
"""

import os, sys, time, urllib.request, urllib.error, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
POSTER_DIR = DATA_DIR / 'posters'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 300
REFRESH_ALL = os.environ.get('REFRESH_ALL') == '1' or '--refresh-all' in sys.argv
DELAY = 0.15  # seconds between fetches — a static CDN, not a rate-limited API, but still polite
SIZE = 'w185'
IMAGE_BASE = f'https://image.tmdb.org/t/p/{SIZE}'
HEADERS = {'User-Agent': 'my-books-trakt-poster-cache (personal watch-history app)'}


def load_json(name, default):
    path = DATA_DIR / name
    if not path.exists():
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def local_filename(title_key):
    # 'show:125988' -> 'show-125988.jpg' — the only character titleKey
    # ever contains that isn't filesystem-safe is the colon.
    return title_key.replace(':', '-') + '.jpg'


def fetch_bytes(url):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read(), None
    except urllib.error.HTTPError as e:
        return None, f'HTTP {e.code}'
    except Exception as e:
        return None, str(e)[:200]


def main():
    library = load_json('library.json', {'titles': []})
    watchlist = load_json('watchlist.json', {'titles': []})
    candidate_pool = load_json('candidatePool.json', {'titles': []})
    enriched = load_json('enrichedMetadata.json', {})

    title_keys = {t['titleKey'] for t in
                  library.get('titles', []) + watchlist.get('titles', []) + candidate_pool.get('titles', [])
                  if t.get('titleKey')}
    print(f'{len(title_keys)} real (library+watchlist+candidatePool) title keys in scope')

    POSTER_DIR.mkdir(parents=True, exist_ok=True)

    pending = []
    skipped_no_poster = 0
    for key in sorted(title_keys):
        poster_path = (enriched.get(key) or {}).get('posterPath')
        if not poster_path:
            skipped_no_poster += 1
            continue
        local_path = POSTER_DIR / local_filename(key)
        if local_path.exists() and not REFRESH_ALL:
            continue
        pending.append((key, poster_path, local_path))

    print(f'{len(pending)} posters pending ({skipped_no_poster} titles have no posterPath yet)')

    batch = pending[:BATCH_SIZE]
    fetched, failed = 0, 0
    for key, poster_path, local_path in batch:
        data, err = fetch_bytes(IMAGE_BASE + poster_path)
        if data:
            with open(local_path, 'wb') as f:
                f.write(data)
            fetched += 1
        else:
            failed += 1
            print(f'  FAILED {key}: {err}', file=sys.stderr)
        time.sleep(DELAY)

    print(f'done: {fetched} fetched, {failed} failed, {len(pending) - len(batch)} still pending for a future run')

    if pending and failed == len(batch):
        print('ERROR: every fetch in this batch failed — treat as a real failure, not a quiet success.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
