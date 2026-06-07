#!/usr/bin/env python3
"""
Fetch Google Books ratings for all books and candidates, store in JSON files.

Usage:
    python3 enrich_google_books.py

Run this locally (not in the cloud environment — the API is rate-limited there).
The script is resumable: books already enriched (googleRating field present,
even if null) are skipped. Run again after interruption to pick up where it left off.

After it finishes, commit and push:
    cd /path/to/my-books
    git add data/
    git commit -m "Enrich Google Books ratings"
    git push origin main
"""

import json, time, urllib.request, urllib.parse, re
from pathlib import Path

DATA_DIR = Path(__file__).parent / 'data'
DELAY    = 0.25   # seconds between API calls — stay well under rate limit
SAVE_EVERY = 20   # save progress every N books

def bare(title):
    t = re.sub(r'\s*\([^)]*\)\s*$', '', str(title or '')).strip()
    t = re.sub(r'\s*:.*$', '', t).strip()
    return t

def fetch_by_isbn(isbn):
    url = f'https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}'
    return _call(url)

def fetch_by_title(title, author):
    q = urllib.parse.quote(f'intitle:{bare(title)} inauthor:{author}')
    url = f'https://www.googleapis.com/books/v1/volumes?q={q}&maxResults=1&printType=books'
    return _call(url)

def _call(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible)'})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        vi = (data.get('items') or [{}])[0].get('volumeInfo', {})
        rating = vi.get('averageRating')
        count  = vi.get('ratingsCount')
        return (float(rating), int(count)) if rating else (None, None)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print('  ⚠ Rate limited — sleeping 30s')
            time.sleep(30)
        return (None, None)
    except Exception:
        return (None, None)

def enrich(book):
    """Return (rating, count) for the book; prefers ISBN lookup."""
    isbn = book.get('isbn13') or book.get('isbn')
    if isbn:
        r, c = fetch_by_isbn(isbn)
        if r: return r, c
    time.sleep(DELAY)
    return fetch_by_title(book.get('title', ''), book.get('author', ''))

def process_file(path, books_key):
    with open(path) as f:
        data = json.load(f)
    books = data[books_key]

    pending = [b for b in books if 'googleRating' not in b]
    done    = len(books) - len(pending)
    print(f'\n{path.name}: {done}/{len(books)} already enriched, {len(pending)} to fetch')
    if not pending:
        return

    for i, book in enumerate(pending, 1):
        title = book.get('title', '')[:45]
        isbn  = book.get('isbn13') or book.get('isbn') or ''
        rating, count = enrich(book)
        book['googleRating']       = rating
        book['googleRatingsCount'] = count
        status = f'{rating:.1f}★ ({count:,})' if rating else 'not found'
        print(f'  [{i:3}/{len(pending)}] {title:<45} {isbn:<14} → {status}')
        time.sleep(DELAY)

        if i % SAVE_EVERY == 0:
            with open(path, 'w') as f:
                json.dump(data, f, indent=2)
                f.write('\n')
            print(f'  💾 Saved ({done + i} done)')

    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    print(f'  ✅ Saved {path.name}')

# ── Run ────────────────────────────────────────────────────────────────────

print('Google Books enrichment — fetching ratings for all books and candidates')
print(f'Data dir: {DATA_DIR}')
print(f'Delay: {DELAY}s between requests, saving every {SAVE_EVERY} books\n')

# goodreadsData.json (958 books)
process_file(DATA_DIR / 'goodreadsData.json', 'books')

# All candidate pool files
cand_files = sorted(DATA_DIR.glob('candidatePool*.json'))
for path in cand_files:
    process_file(path, 'candidates')

print('\n✅ Done. Now commit and push:')
print('   git add data/ && git commit -m "Enrich Google Books ratings" && git push origin main')
