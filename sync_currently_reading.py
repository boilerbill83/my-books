#!/usr/bin/env python3
"""
Fetches the currently-reading shelf from the public Goodreads RSS and writes
data/currentlyReading.json. Designed to run as a GitHub Action every few hours.
"""

import json, re, sys, urllib.request
from pathlib import Path
from xml.etree import ElementTree as ET

RSS_URL  = 'https://www.goodreads.com/review/list_rss/37243238?shelf=currently-reading'
OUT_FILE = Path('data/currentlyReading.json')

HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
}

def fetch_rss():
    req = urllib.request.Request(RSS_URL, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()

def text_of(el, tag):
    """First child element text, empty string if missing."""
    child = el.find(tag)
    return child.text.strip() if child is not None and child.text else ''

def parse_rss(xml_bytes):
    root    = ET.fromstring(xml_bytes)
    channel = root.find('channel')
    if channel is None:
        return []

    books = []
    for item in channel.findall('item'):
        raw_title = text_of(item, 'title')
        # Goodreads appends " by Author Name" to the title field
        title  = re.sub(r'\s+by .+$', '', raw_title).strip() or raw_title
        author = text_of(item, 'author_name')
        cover  = text_of(item, 'book_large_image_url') or text_of(item, 'book_medium_image_url')
        isbn   = text_of(item, 'isbn')
        avg    = text_of(item, 'average_rating')
        year   = text_of(item, 'book_published')

        # num_pages lives inside a nested <book> element
        book_el = item.find('book')
        pages   = text_of(book_el, 'num_pages') if book_el is not None else ''

        if not title:
            continue

        books.append({
            'title':     title,
            'author':    author or '',
            'coverUrl':  cover  or None,
            'isbn':      isbn   or None,
            'avgRating': float(avg)   if avg             else None,
            'year':      int(year)    if year.isdigit()  else None,
            'pages':     int(pages)   if pages.isdigit() else None,
            'shelf':     'currently-reading',
        })
    return books

def main():
    try:
        xml_bytes = fetch_rss()
    except Exception as e:
        print(f'ERROR fetching RSS: {e}')
        sys.exit(1)

    books = parse_rss(xml_bytes)
    if not books:
        print('RSS returned 0 books — skipping update to avoid overwriting good data.')
        return

    # Load existing to detect changes
    existing = []
    if OUT_FILE.exists():
        try:
            with open(OUT_FILE) as f:
                existing = json.load(f)
        except Exception:
            pass

    # Compare by title+author only (ignore cover URL churn)
    def key(b): return (b['title'], b['author'])
    if sorted(map(key, books)) == sorted(map(key, existing)):
        print(f'No change — still {len(books)} book(s): {", ".join(b["title"] for b in books)}')
        return

    OUT_FILE.parent.mkdir(exist_ok=True)
    with open(OUT_FILE, 'w') as f:
        json.dump(books, f, indent=2)
        f.write('\n')

    added   = [b['title'] for b in books   if key(b) not in {key(e) for e in existing}]
    removed = [b['title'] for b in existing if key(b) not in {key(n) for n in books}]
    print(f'Updated: {len(books)} book(s) currently reading')
    for b in books:
        print(f'  ✓ {b["title"]} — {b["author"]}')
    if added:   print(f'  + added:   {", ".join(added)}')
    if removed: print(f'  - removed: {", ".join(removed)}')

if __name__ == '__main__':
    main()
