#!/usr/bin/env python3
"""
Resolves plain title lists to real TMDB ids via TMDB's own search API,
adding new stub candidates to trakt/data/candidatePool.json for
enrich_tmdb.py to fill in on a later run. Never guesses an id — takes
TMDB's own top search result (its relevance+popularity ranking), and
titles with no result are logged as unresolved, not silently dropped.

Also runs a title-similarity confidence check before auto-accepting a
match (added after a real incident: a past run took the #1 search result
unconditionally and got 11 of 196 titles wrong — short/common titles like
"Bros", "Dredd", "Chad" matched an unrelated same-named title instead of
what was meant, e.g. Bros -> The Super Mario Bros. Movie). A low-
confidence match is never added automatically — it's logged separately
for manual verification, the same "flag, don't guess" discipline the
"no result at all" case already used.

Input: trakt/data/manualCandidateTitles.json — {"movies": [...], "shows": [...]}
(currently Bill's own hand-picked titles, added directly to widen the
candidate pool after Session 46 found the movie pool too thin relative
to the show pool to trust its recommendations).

Run manually only (not scheduled — this is a one-off per batch of
titles, not a recurring job): python3 trakt/resolve_titles.py
GitHub Action: .github/workflows/trakt-resolve-titles.yml (workflow_dispatch)
"""

import json, os, re, sys, time, urllib.request, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
API_KEY = os.environ.get('TMDB_API_KEY', '')
DELAY = 0.35
HEADERS = {'User-Agent': 'my-books-trakt-resolve (personal watch-history app)'}


def get_json(url):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


def search(kind, title):
    """kind: 'movie' or 'show' (mapped to TMDB's 'tv' search endpoint)."""
    tmdb_kind = 'movie' if kind == 'movie' else 'tv'
    q = urllib.parse.quote(title)
    data = get_json(f'https://api.themoviedb.org/3/search/{tmdb_kind}?api_key={API_KEY}&query={q}')
    results = (data or {}).get('results') or []
    return results[0] if results else None


def normalize(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def is_confident_match(query_title, matched_title):
    """
    Guards against the real Session 47 failure mode: taking TMDB's #1 search
    result unconditionally matched the wrong same-named title 11/196 times
    (e.g. "Bros" -> The Super Mario Bros. Movie, "Dredd" -> the 1995 film,
    "Chad" -> Chad Powers) - every one of those false matches was a short,
    common query word. An exact match (after stripping punctuation/case) is
    always trusted. A partial/substring match is only trusted once the query
    is long enough that a coincidental short-word collision is implausible -
    below that length, only an exact match counts as confident.
    """
    q = normalize(query_title)
    m = normalize(matched_title)
    if not q or not m:
        return False
    if q == m:
        return True
    MIN_LEN_FOR_PARTIAL = 12
    if len(q) < MIN_LEN_FOR_PARTIAL:
        return False
    if q in m or m in q:
        ratio = min(len(q), len(m)) / max(len(q), len(m))
        return ratio >= 0.5
    return False


def resolve_batch(kind, titles, known, pool_titles):
    added, skipped, unresolved, low_confidence = [], [], [], []
    name_field = 'title' if kind == 'movie' else 'name'
    date_field = 'release_date' if kind == 'movie' else 'first_air_date'
    for title in titles:
        result = search(kind, title)
        time.sleep(DELAY)
        if not result:
            unresolved.append(title)
            print(f'  ---- no match | {title}')
            continue
        tmdb_id = result['id']
        key = f'{kind}:{tmdb_id}'
        matched_title = result.get(name_field) or title
        matched_year = (result.get(date_field) or '')[:4] or '?'
        if not is_confident_match(title, matched_title):
            low_confidence.append((title, matched_title, matched_year))
            print(f'  ?LOW-CONF? | {title} -> {matched_title} ({matched_year}) — not added, needs manual review')
            continue
        if key in known:
            skipped.append(title)
            print(f'  skip (already known) | {title} -> {matched_title} ({matched_year})')
            continue
        pool_titles.append({
            'type': kind, 'titleKey': key, 'ids': {'tmdb': tmdb_id},
            'title': None, 'year': None, 'source': 'bill-manual',
        })
        known.add(key)
        added.append(title)
        print(f'  added | {title} -> {matched_title} ({matched_year})')
    return added, skipped, unresolved, low_confidence


def main():
    if not API_KEY:
        print('ERROR: TMDB_API_KEY is not set.', file=sys.stderr)
        sys.exit(1)

    titles_path = DATA_DIR / 'manualCandidateTitles.json'
    if not titles_path.exists():
        print(f'ERROR: {titles_path} not found.', file=sys.stderr)
        sys.exit(1)
    titles_input = json.load(open(titles_path))
    movie_titles = titles_input.get('movies', [])
    show_titles = titles_input.get('shows', [])

    library = json.load(open(DATA_DIR / 'library.json'))
    watchlist = json.load(open(DATA_DIR / 'watchlist.json'))
    pool_path = DATA_DIR / 'candidatePool.json'
    pool = json.load(open(pool_path)) if pool_path.exists() else {'titles': []}

    known = set()
    for t in library['titles'] + watchlist['titles'] + pool['titles']:
        if t.get('titleKey'):
            known.add(t['titleKey'])

    print(f'Resolving {len(movie_titles)} movies...')
    m_added, m_skipped, m_unresolved, m_lowconf = resolve_batch('movie', movie_titles, known, pool['titles'])
    print(f'\nResolving {len(show_titles)} shows...')
    s_added, s_skipped, s_unresolved, s_lowconf = resolve_batch('show', show_titles, known, pool['titles'])

    pool['meta'] = {'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S') + 'Z', 'count': len(pool['titles'])}
    json.dump(pool, open(pool_path, 'w'), indent=2)

    added = m_added + s_added
    skipped = m_skipped + s_skipped
    unresolved = m_unresolved + s_unresolved
    low_confidence = m_lowconf + s_lowconf
    print(f'\n{len(added)} new candidates added ({len(m_added)} movies, {len(s_added)} shows), '
          f'{len(skipped)} already known, {len(unresolved)} unresolved, '
          f'{len(low_confidence)} low-confidence (not added).')
    if unresolved:
        print('Unresolved (no TMDB match at all — verify title spelling):')
        for t in unresolved:
            print(f'  - {t}')
    if low_confidence:
        print('Low-confidence matches (NOT added — TMDB\'s top result did not look like the same title; '
              'verify by hand and add manually if correct):')
        for query, matched, year in low_confidence:
            print(f'  - "{query}" -> best TMDB match was "{matched}" ({year})')


if __name__ == '__main__':
    main()
