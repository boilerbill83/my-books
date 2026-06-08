#!/usr/bin/env python3
"""
Backfills missing or broken cover URLs for all candidate pool books and
to-read shelf books.

Strategy per book:
  1. If book already has a non-OL coverUrl → skip (already reliable).
  2. Try OpenLibrary using isbn13: HEAD the URL, accept if Content-Length > 1 KB.
  3. Fall back to Google Books API (uses GOOGLE_BOOKS_API_KEY if set).
  4. If found, write coverUrl into the source JSON file.

Run manually:   GOOGLE_BOOKS_API_KEY=... python3 enrich_covers.py
GitHub Action:  .github/workflows/enrich-covers.yml (weekly + manual trigger)
"""

import json, os, re, sys, time, urllib.request, urllib.parse
from pathlib import Path

DATA_DIR = Path('data')
API_KEY  = os.environ.get('GOOGLE_BOOKS_API_KEY', '')
MIN_COVER_BYTES = 1024   # OL returns a ~42-byte 1×1 GIF for missing covers

# ── Helpers ────────────────────────────────────────────────────────────────

def ol_cover_url(isbn13):
    return f'https://covers.openlibrary.org/b/isbn/{isbn13}-M.jpg'

def ol_has_cover(isbn13):
    """Return True if OpenLibrary has a real cover (>1 KB) for this isbn13."""
    url = ol_cover_url(isbn13)
    try:
        req = urllib.request.Request(url, method='HEAD',
                                     headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            length = int(resp.headers.get('Content-Length', 0))
            return length > MIN_COVER_BYTES
    except Exception:
        return False

def google_books_cover(title, author):
    """Return a Google Books cover URL for title+author, or None."""
    bare = re.sub(r'\s*[:({\[].*', '', title).strip()[:50]
    bare = re.sub(r'\s*\(.*?\)\s*$', '', bare).strip()
    auth = author.split(',')[0].strip()

    q   = f'intitle:{bare} inauthor:{auth}'
    url = (f'https://www.googleapis.com/books/v1/volumes'
           f'?q={urllib.parse.quote(q)}&maxResults=1&printType=books'
           + (f'&key={API_KEY}' if API_KEY else ''))

    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
    except Exception as e:
        print(f'    GB error: {e}')
        return None

    items = data.get('items', [])
    if not items:
        return None

    info      = items[0].get('volumeInfo', {})
    links     = info.get('imageLinks', {})
    thumb_url = links.get('thumbnail') or links.get('smallThumbnail')
    if not thumb_url:
        return None

    # Prefer HTTPS and larger zoom
    thumb_url = thumb_url.replace('http://', 'https://').replace('zoom=1', 'zoom=2')

    # Sanity check: at least one significant word from our title appears in result
    ret_title = info.get('title', '').lower()
    sig_words = [w for w in re.split(r'\W+', bare.lower()) if len(w) > 3]
    if sig_words and not any(w in ret_title for w in sig_words):
        return None

    return thumb_url

def best_cover_url(book):
    """
    Return the best available cover URL for book, or None if not found.
    Checks OL first (free, no key), then Google Books.
    """
    isbn13 = book.get('isbn13', '')
    title  = book.get('title', '')
    author = book.get('author', '')

    if isbn13:
        if ol_has_cover(isbn13):
            return ol_cover_url(isbn13)
        print(f'    OL miss for {isbn13}, trying Google Books…')
        time.sleep(0.3)

    # Fall through to Google Books
    url = google_books_cover(title, author)
    time.sleep(0.6)
    return url

# ── File enrichment ────────────────────────────────────────────────────────

def enrich_file(path, books_key):
    with open(path) as f:
        data = json.load(f)

    books   = data.get(books_key, [])
    changed = False
    added   = 0

    for book in books:
        if books_key == 'books' and book.get('shelf') != 'to-read':
            continue

        # Skip if already has a reliable (non-OL) coverUrl
        existing = book.get('coverUrl', '') or ''
        if existing and 'openlibrary.org' not in existing:
            continue

        title  = book.get('title', '')
        author = book.get('author', '')
        isbn13 = book.get('isbn13', '')
        if not title or not author:
            continue

        print(f'  {path.name}: {title[:50]}…')
        url = best_cover_url(book)

        if url:
            book['coverUrl'] = url
            print(f'    → {url[:70]}')
            changed = True
            added  += 1
        else:
            print(f'    → not found')

    if changed:
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
        print(f'  Saved {path.name}')

    return added

# ── Main ───────────────────────────────────────────────────────────────────

def main():
    if not API_KEY:
        print('WARNING: GOOGLE_BOOKS_API_KEY not set — Google Books fallback will be rate-limited')

    total = 0

    print('=== Enriching candidate pools ===')
    for path in sorted(DATA_DIR.glob('candidatePool*.json')):
        total += enrich_file(path, 'candidates')

    print('\n=== Enriching goodreads to-read shelf ===')
    total += enrich_file(DATA_DIR / 'goodreadsData.json', 'books')

    print(f'\n✅  Done. {total} cover URLs added/updated.')

if __name__ == '__main__':
    main()
