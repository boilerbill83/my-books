#!/usr/bin/env python3
"""
Enriches books with descriptions, categories, and subjects from
Google Books + Open Library. No LLM involved — plain HTTP.

Results cached in data/enrichedMetadata.json keyed by bookKey.
tag_with_haiku.py consumes this cache to re-tag themes/tones/similarToTitles.

Priority order: to-read shelf, then read shelf, then candidate pools.

Run manually:   python3 enrich_metadata.py [batch_size]
GitHub Action:  .github/workflows/enrich-metadata.yml
"""

import json, os, re, sys, time, urllib.request, urllib.parse
from pathlib import Path

DATA_DIR   = Path('data')
CACHE_FILE = DATA_DIR / 'enrichedMetadata.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 150
RETRY_EMPTIES = os.environ.get('RETRY_EMPTIES') == '1' or '--retry-empties' in sys.argv
API_KEY    = os.environ.get('GOOGLE_BOOKS_API_KEY', '')
DELAY      = 1.2   # seconds between books (both APIs are rate-friendly)

HEADERS = {'User-Agent': 'my-books-enrichment (personal reading app)'}


def get_json(url, timeout=10):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


def clean_html(text):
    text = re.sub(r'<[^>]+>', ' ', str(text or ''))
    return re.sub(r'\s+', ' ', text).strip()


def google_books(title, author, isbn13):
    """Description + categories from Google Books."""
    queries = []
    if isbn13:
        queries.append(f'isbn:{isbn13}')
    queries.append(f'intitle:{title} inauthor:{author}')
    queries.append(f'intitle:{title}')
    short = title.split(':')[0].split('(')[0].strip()
    if short and short != title:
        queries.append(f'intitle:{short}')
    for q in queries:
        url = ('https://www.googleapis.com/books/v1/volumes?q='
               + urllib.parse.quote(q) + '&maxResults=1&country=US')
        if API_KEY:
            url += f'&key={API_KEY}'
        data = get_json(url)
        items = (data or {}).get('items') or []
        if items:
            info = items[0].get('volumeInfo', {})
            desc = clean_html(info.get('description'))
            if desc or info.get('categories'):
                return {
                    'description': desc[:2000],
                    'categories': info.get('categories') or [],
                    'googleRating': info.get('averageRating'),
                }
    return {}


def open_library(isbn13, title, author):
    """Subjects (and description fallback) from Open Library."""
    out = {'subjects': [], 'olDescription': ''}
    work_key = None
    if isbn13:
        data = get_json(f'https://openlibrary.org/isbn/{isbn13}.json')
        if data:
            works = data.get('works') or []
            if works:
                work_key = works[0].get('key')
    if not work_key:
        q = urllib.parse.quote(f'{title} {author}')
        data = get_json(f'https://openlibrary.org/search.json?q={q}&limit=1&fields=key,subject')
        docs = (data or {}).get('docs') or []
        if docs:
            work_key = docs[0].get('key')
            out['subjects'] = (docs[0].get('subject') or [])[:15]
    if work_key and not out['subjects']:
        work = get_json(f'https://openlibrary.org{work_key}.json')
        if work:
            out['subjects'] = [s for s in (work.get('subjects') or [])[:15] if isinstance(s, str)]
            d = work.get('description')
            if isinstance(d, dict):
                d = d.get('value', '')
            out['olDescription'] = clean_html(d)[:2000]
    return out


def load_books():
    with open(DATA_DIR / 'goodreadsData.json') as f:
        gd = json.load(f)
    books = gd['books']
    to_read = [b for b in books if b.get('shelf') == 'to-read']
    read    = [b for b in books if b.get('shelf') == 'read']
    candidates = []
    for path in sorted(DATA_DIR.glob('candidatePool*.json')):
        with open(path) as f:
            candidates += json.load(f).get('candidates', [])
    return to_read + read + candidates


def main():
    cache = json.load(open(CACHE_FILE)) if CACHE_FILE.exists() else {}
    if RETRY_EMPTIES:
        # re-attempt cached entries that came back without a description,
        # using looser title-only queries; skip ones already retried
        pending = [b for b in load_books()
                   if b.get('bookKey') and b['bookKey'] in cache
                   and not cache[b['bookKey']].get('description')
                   and not cache[b['bookKey']].get('retriedAt')]
    else:
        pending = [b for b in load_books()
                   if b.get('bookKey') and b['bookKey'] not in cache]
    batch = pending[:BATCH_SIZE]
    print(f'{len(pending)} books pending, processing {len(batch)}')

    for i, b in enumerate(batch, 1):
        title, author, isbn13 = b.get('title', ''), b.get('author', ''), b.get('isbn13')
        entry = {'title': title, 'author': author}
        entry.update(google_books(title, author, isbn13))
        ol = open_library(isbn13, title, author)
        if not entry.get('description') and ol.get('olDescription'):
            entry['description'] = ol['olDescription']
        entry['subjects'] = ol.get('subjects', [])
        entry['fetchedAt'] = time.strftime('%Y-%m-%d')
        if RETRY_EMPTIES:
            entry['retriedAt'] = entry['fetchedAt']
        cache[b['bookKey']] = entry
        got = 'desc' if entry.get('description') else '----'
        print(f'  [{i}/{len(batch)}] {got} | {title[:50]}')
        if i % 25 == 0:
            json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
        time.sleep(DELAY)

    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    with_desc = sum(1 for v in cache.values() if v.get('description'))
    print(f'done: {len(cache)} cached, {with_desc} with descriptions')


if __name__ == '__main__':
    main()
