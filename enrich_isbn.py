#!/usr/bin/env python3
"""
Backfills missing ISBN13 values for candidate pool books and to-read shelf
books using the Google Books API. Updates the source JSON files directly.

Requires: GOOGLE_BOOKS_API_KEY environment variable (or set in GitHub secrets).

Run manually:   GOOGLE_BOOKS_API_KEY=... python3 enrich_isbn.py
GitHub Action:  .github/workflows/enrich-isbn.yml (weekly + manual trigger)
"""

import json, os, re, sys, time, urllib.request, urllib.parse
from pathlib import Path

DATA_DIR = Path('data')
API_KEY  = os.environ.get('GOOGLE_BOOKS_API_KEY', '')

# ── Google Books ISBN lookup ───────────────────────────────────────────────

def lookup_isbn(title, author):
    """Query Google Books by title+author; return ISBN13 string or None."""
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
        print(f'    API error: {e}')
        return None

    items = data.get('items', [])
    if not items:
        return None

    info      = items[0].get('volumeInfo', {})
    ret_title = info.get('title', '').lower()

    # Validate: at least one significant word from our title must appear in
    # the returned title (filters out wrong-book mismatches)
    sig_words = [w for w in re.split(r'\W+', bare.lower()) if len(w) > 3]
    if sig_words and not any(w in ret_title for w in sig_words):
        return None

    for ident in info.get('industryIdentifiers', []):
        if ident.get('type') == 'ISBN_13':
            return ident['identifier']
    return None

# ── File update helpers ────────────────────────────────────────────────────

def enrich_candidates():
    """Backfill ISBN13 in all candidatePool*.json files."""
    total_added = 0
    for path in sorted(DATA_DIR.glob('candidatePool*.json')):
        with open(path) as f:
            data = json.load(f)
        candidates = data.get('candidates', [])
        changed    = False

        for book in candidates:
            if book.get('isbn13') or book.get('isbn'):
                continue
            title  = book.get('title', '')
            author = book.get('author', '')
            if not title or not author:
                continue

            print(f'  {path.name}: {title[:50]}…')
            isbn = lookup_isbn(title, author)
            time.sleep(0.6)   # stay well under API rate limit

            if isbn:
                book['isbn13'] = isbn
                print(f'    → {isbn}')
                changed     = True
                total_added += 1
            else:
                print(f'    → not found')

        if changed:
            with open(path, 'w') as f:
                json.dump(data, f, indent=2)
                f.write('\n')
            print(f'  Saved {path.name}')

    return total_added

def enrich_goodreads():
    """Backfill ISBN13 for to-read books in goodreadsData.json."""
    with open(DATA_DIR / 'goodreadsData.json') as f:
        data = json.load(f)

    changed     = False
    total_added = 0
    for book in data['books']:
        if book.get('shelf') != 'to-read':
            continue
        if book.get('isbn13') or book.get('isbn'):
            continue

        title  = book.get('title', '')
        author = book.get('author', '')
        if not title or not author:
            continue

        print(f'  goodreads: {title[:50]}…')
        isbn = lookup_isbn(title, author)
        time.sleep(0.6)

        if isbn:
            book['isbn13'] = isbn
            print(f'    → {isbn}')
            changed     = True
            total_added += 1
        else:
            print(f'    → not found')

    if changed:
        with open(DATA_DIR / 'goodreadsData.json', 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
        print('  Saved goodreadsData.json')

    return total_added

# ── Main ───────────────────────────────────────────────────────────────────

def main():
    if not API_KEY:
        print('WARNING: GOOGLE_BOOKS_API_KEY not set — requests will be rate-limited to ~10/day')

    print('=== Enriching candidate pools ===')
    cand_added = enrich_candidates()

    print('\n=== Enriching goodreads to-read shelf ===')
    gr_added = enrich_goodreads()

    total = cand_added + gr_added
    print(f'\n✅  Done. {total} ISBN13 values added ({cand_added} candidates, {gr_added} to-read).')
    if total == 0:
        print('   All books already have ISBNs or none found via Google Books.')

if __name__ == '__main__':
    main()
