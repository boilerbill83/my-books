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

Needs an OMDB_API_KEY — free tier at omdbapi.com/apikey.aspx (1,000
requests/day), same pattern as TMDB_API_KEY/GOOGLE_BOOKS_API_KEY: Bill
creates it himself and sets it as a repo secret; no tool here can do
either step.
"""

import json, os, re, sys, time, urllib.request, urllib.parse, urllib.error
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
DATA_DIR   = ROOT / 'trakt' / 'data'
CACHE_FILE = DATA_DIR / 'omdbMetadata.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 150
API_KEY    = os.environ.get('OMDB_API_KEY', '')
DELAY      = 0.4
API_BASE   = 'https://www.omdbapi.com/'
HEADERS    = {'User-Agent': 'my-books-trakt-omdb-enrichment (personal watch-history app)'}


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


def omdb_lookup(imdb_id):
    url = f'{API_BASE}?i={urllib.parse.quote(imdb_id)}&apikey={API_KEY}'
    return get_json(url)


# OMDb's Awards field is free text, e.g. "Won 1 Oscar. 128 wins & 233
# nominations total" or "Won 16 Primetime Emmys. 165 wins & 258
# nominations total" or "N/A". Extracts only what's literally present —
# never infers a count that isn't in the text.
AWARD_WIN_RE = re.compile(r'Won (\d+) ([A-Za-z][\w .&-]*?)s?(?:\.|,| \()', re.IGNORECASE)
AWARD_NOM_RE = re.compile(r'Nominated for (\d+) ([A-Za-z][\w .&-]*?)s?(?:\.|,| \()', re.IGNORECASE)
TOTAL_RE = re.compile(r'(\d+) wins? & (\d+) nominations? total', re.IGNORECASE)


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
    m = TOTAL_RE.search(text)
    if m:
        result['totalWins'] = int(m.group(1))
        result['totalNominations'] = int(m.group(2))
    return result


def extract_entry(data):
    ratings = {r.get('Source'): r.get('Value') for r in (data.get('Ratings') or [])}
    rt = ratings.get('Rotten Tomatoes')  # e.g. "87%"
    rt_score = int(rt.rstrip('%')) if rt and rt.rstrip('%').isdigit() else None
    mc = data.get('Metascore')  # e.g. "74" or "N/A"
    mc_score = int(mc) if mc and mc.isdigit() else None
    imdb_rating = data.get('imdbRating')
    imdb_votes = data.get('imdbVotes')
    return {
        'rottenTomatoes': rt_score,
        'metacritic': mc_score,
        'awards': parse_awards(data.get('Awards')),
        'imdbRating': float(imdb_rating) if imdb_rating not in (None, 'N/A') else None,
        'imdbVotes': int(imdb_votes.replace(',', '')) if imdb_votes not in (None, 'N/A') else None,
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
                titles.append({'titleKey': title_key, 'imdbId': imdb_id, 'title': t.get('title')})
    return titles


def main():
    if not API_KEY:
        print('ERROR: OMDB_API_KEY is not set. Create a free key at omdbapi.com/apikey.aspx '
              '(1,000 requests/day) and set it as an env var (or the OMDB_API_KEY repo secret '
              'for the GitHub Action).', file=sys.stderr)
        sys.exit(1)

    cache = json.load(open(CACHE_FILE)) if CACHE_FILE.exists() else {}
    pending_raw = [t for t in load_titles() if t['titleKey'] not in cache]
    seen, pending = set(), []
    for t in pending_raw:
        if t['titleKey'] not in seen:
            seen.add(t['titleKey'])
            pending.append(t)

    batch = pending[:BATCH_SIZE]
    print(f'{len(pending)} titles pending (have an IMDb id, not yet OMDb-enriched), processing {len(batch)}')

    failures = 0
    for i, t in enumerate(batch, 1):
        data, status = omdb_lookup(t['imdbId'])
        if status == 401:
            print('ERROR: OMDb rejected the API key (401). Check OMDB_API_KEY and stop — '
                  'no point burning through the rest of the batch on a bad key.', file=sys.stderr)
            sys.exit(1)
        if not data or data.get('Response') == 'False':
            failures += 1
            err = (data or {}).get('Error', f'status {status}')
            print(f'  [{i}/{len(batch)}] FAIL ({err}) | {t["title"] or t["imdbId"]}')
            time.sleep(DELAY)
            continue

        cache[t['titleKey']] = extract_entry(data)
        rt = cache[t['titleKey']]['rottenTomatoes']
        print(f'  [{i}/{len(batch)}] ok (RT {rt if rt is not None else "—"}) | {t["title"] or t["imdbId"]}')
        if i % 25 == 0:
            json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
        time.sleep(DELAY)

    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    if batch and failures == len(batch):
        print('ERROR: every title in this batch failed — treat as a real failure, not a quiet success.',
              file=sys.stderr)
        sys.exit(1)

    with_rt = sum(1 for v in cache.values() if v.get('rottenTomatoes') is not None)
    print(f'done: {len(cache)} cached, {with_rt} with a Rotten Tomatoes score')


if __name__ == '__main__':
    main()
