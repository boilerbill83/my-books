#!/usr/bin/env python3
"""
Fetch Google Books ratings for candidate and to-read books, store in JSON files.

Skips already-read books — the engine only recommends from the candidate pool
and the to-read shelf, so those are the only books that need community ratings.

Resumable: books that already have a googleRating field (even null) are skipped.
Re-run to pick up any that were missed.
"""

import json, time, urllib.request, urllib.parse, re, os
from pathlib import Path

DATA_DIR   = Path(__file__).parent / 'data'
DELAY      = 0.5    # seconds between requests
SAVE_EVERY = 25     # save to disk every N books
API_KEY    = os.environ.get('GOOGLE_BOOKS_API_KEY', '')  # optional — set as GitHub secret

def bare(title):
    t = re.sub(r'\s*\([^)]*\)\s*$', '', str(title or '')).strip()
    t = re.sub(r'\s*:.*$', '', t).strip()
    return t

def _call(url):
    if API_KEY:
        url += f'&key={API_KEY}'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible)'})
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read())
        vi = (data.get('items') or [{}])[0].get('volumeInfo', {})
        rating = vi.get('averageRating')
        count  = vi.get('ratingsCount')
        return (float(rating), int(count)) if rating else (None, None)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print('  ⚠ Rate limited — sleeping 60s then continuing')
            time.sleep(60)
        return (None, None)
    except Exception:
        return (None, None)

def fetch_by_isbn(isbn):
    return _call(f'https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}')

def fetch_by_title(title, author):
    q = urllib.parse.quote(f'intitle:{bare(title)} inauthor:{author}')
    return _call(f'https://www.googleapis.com/books/v1/volumes?q={q}&maxResults=1&printType=books')

def enrich(book):
    isbn = book.get('isbn13') or book.get('isbn')
    if isbn:
        r, c = fetch_by_isbn(isbn)
        if r:
            time.sleep(DELAY)
            return r, c
        time.sleep(DELAY)
    return fetch_by_title(book.get('title', ''), book.get('author', ''))

def process_books(path, books_key, skip_shelf=None):
    with open(path) as f:
        data = json.load(f)
    books = data[books_key]

    # Filter: skip already-enriched, and optionally skip by shelf
    pending = [
        b for b in books
        if 'googleRating' not in b and b.get('shelf') != skip_shelf
    ]
    done = len(books) - len(pending)
    print(f'\n{path.name}: {done}/{len(books)} already done, fetching {len(pending)}')
    if not pending:
        return

    changed = 0
    for i, book in enumerate(pending, 1):
        title  = book.get('title', '')[:48]
        rating, count = enrich(book)
        book['googleRating']       = rating
        book['googleRatingsCount'] = count
        status = f'{rating:.1f}★ ({count:,})' if rating else 'not found'
        print(f'  [{i:3}/{len(pending)}] {title:<48} → {status}')
        time.sleep(DELAY)
        changed += 1

        if changed % SAVE_EVERY == 0:
            with open(path, 'w') as f:
                json.dump(data, f, indent=2)
                f.write('\n')
            print(f'  💾 Saved progress ({done + i} total done)')

    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    print(f'  ✅ {path.name} saved')

# ── Run ────────────────────────────────────────────────────────────────────

print('Google Books enrichment')
print(f'API key: {"set ✓" if API_KEY else "not set (using anonymous quota)"}')
print(f'Delay: {DELAY}s between requests\n')

# goodreadsData.json — only fetch to-read books, skip already-read ones
# (read books are never recommended so community rating doesn't affect scoring)
process_books(DATA_DIR / 'goodreadsData.json', 'books', skip_shelf='read')

# All candidate pool files — fetch all
for path in sorted(DATA_DIR.glob('candidatePool*.json')):
    process_books(path, 'candidates')

print('\n✅ All done.')
