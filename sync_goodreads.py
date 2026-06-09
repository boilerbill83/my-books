#!/usr/bin/env python3
"""
Keeps goodreadsData.json in sync with Goodreads shelves.

- Fetches the read shelf RSS (most recent 100): if a book is in our data as
  to-read and now appears on the read shelf with a rating, updates it in place
  (preserves all enrichment fields: themes, tones, type, dnf).
- Fetches the to-read shelf RSS (most recent 200): adds any books not already
  in our data with basic metadata (themes/tones will be empty until enriched).

Run manually:  python3 sync_goodreads.py
GitHub Action: .github/workflows/sync-goodreads.yml (runs 2x/day)
"""

import json, re, sys, urllib.request
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

GOODREADS_USER_ID = '37243238'
DATA_FILE = Path('data/goodreadsData.json')

HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
}

def fetch_rss(shelf, sort='date_updated', per_page=200):
    url = (f'https://www.goodreads.com/review/list_rss/{GOODREADS_USER_ID}'
           f'?shelf={shelf}&sort={sort}&per_page={per_page}')
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()

def text_of(el, tag):
    child = el.find(tag)
    return child.text.strip() if child is not None and child.text else ''

def parse_shelf(xml_bytes):
    root    = ET.fromstring(xml_bytes)
    channel = root.find('channel')
    if channel is None:
        return []
    books = []
    for item in channel.findall('item'):
        raw_title  = text_of(item, 'title')
        title      = re.sub(r'\s+by .+$', '', raw_title).strip() or raw_title
        author     = text_of(item, 'author_name')
        isbn       = text_of(item, 'isbn13') or text_of(item, 'isbn')
        avg        = text_of(item, 'average_rating')
        year       = text_of(item, 'book_published')
        cover      = text_of(item, 'book_large_image_url')
        user_rating = text_of(item, 'user_rating')
        date_read   = text_of(item, 'user_read_at')
        book_el     = item.find('book')
        num_pages   = text_of(book_el, 'num_pages') if book_el is not None else ''
        if not title:
            continue
        books.append({
            'title':     title,
            'author':    author or '',
            'isbn':      isbn   or None,
            'avgRating': float(avg)      if avg             else None,
            'year':      int(year)       if year.isdigit()  else None,
            'pages':     int(num_pages)  if num_pages.isdigit() else None,
            'coverUrl':  cover or None,
            'myRating':  int(user_rating) if user_rating.isdigit() else 0,
            'dateRead':  date_read        or None,
        })
    return books

def norm_key(title, author):
    """Loose match key: bare lowercase title + first-listed author."""
    t = re.sub(r'\s*[:({\[].*', '', str(title)).strip().lower()
    t = re.sub(r'\s*\(.*?\)\s*$', '', t).strip()
    a = str(author).split(',')[0].strip().lower()
    return f'{t}|||{a}'

def parse_date(date_str):
    """Convert Goodreads date string to YYYY/MM/DD, or return None."""
    if not date_str:
        return None
    # e.g. "Mon Jan 06 00:00:00 -0500 2025"
    m = re.search(r'(\w{3})\s+(\d{1,2}).*?(\d{4})$', date_str)
    if m:
        try:
            dt = datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", '%b %d %Y')
            return dt.strftime('%Y/%m/%d')
        except ValueError:
            pass
    return None

def main():
    with open(DATA_FILE) as f:
        data = json.load(f)
    books = data['books']

    # Build key → index lookup for existing books
    key_to_idx = {norm_key(b['title'], b['author']): i for i, b in enumerate(books)}

    moved_to_read = 0
    newly_added   = 0
    cover_updated = 0
    errors        = []

    # ── 1. Read shelf: detect books that moved from to-read → read ────────────
    print('Fetching read shelf RSS (recent 100)…')
    try:
        read_items = parse_shelf(fetch_rss('read', sort='date_read', per_page=100))
        print(f'  {len(read_items)} items returned')
    except Exception as e:
        errors.append(f'read shelf: {e}')
        print(f'  ERROR: {e}')
        read_items = []

    for item in read_items:
        k = norm_key(item['title'], item['author'])
        if k not in key_to_idx:
            continue
        book = books[key_to_idx[k]]
        if book.get('shelf') == 'to-read':
            book['shelf']    = 'read'
            book['myRating'] = item['myRating']
            date = parse_date(item['dateRead'])
            if date:
                book['dateRead'] = date
            print(f'  ✓ finished: "{book["title"]}" ({item["myRating"]}★)')
            moved_to_read += 1
        # Backfill coverUrl for read books missing one
        if not book.get('coverUrl') and item.get('coverUrl'):
            book['coverUrl'] = item['coverUrl']
            print(f'  ↑ cover backfilled (read): "{book["title"]}"')
            cover_updated += 1

    # ── 2. To-read shelf: add new books ───────────────────────────────────────
    print('Fetching to-read shelf RSS (recent 200)…')
    try:
        toread_items = parse_shelf(fetch_rss('to-read', sort='date_added', per_page=200))
        print(f'  {len(toread_items)} items returned')
    except Exception as e:
        errors.append(f'to-read shelf: {e}')
        print(f'  ERROR: {e}')
        toread_items = []

    for item in toread_items:
        k = norm_key(item['title'], item['author'])
        if k in key_to_idx:
            # Backfill coverUrl for existing books that are missing one
            book = books[key_to_idx[k]]
            if not book.get('coverUrl') and item.get('coverUrl'):
                book['coverUrl'] = item['coverUrl']
                print(f'  ↑ cover backfilled: "{book["title"]}"')
                cover_updated += 1
            continue   # already in data
        isbn13 = item['isbn'] if item.get('isbn') and len(str(item.get('isbn', ''))) == 13 else None
        isbn   = item['isbn'] if item.get('isbn') and len(str(item.get('isbn', ''))) == 10 else None
        new_book = {
            'title':        item['title'],
            'author':       item['author'],
            'isbn13':       isbn13,
            'isbn':         isbn,
            'avgRating':    item['avgRating'],
            'ratingsCount': 0,
            'year':         item['year'],
            'pages':        item['pages'],
            'coverUrl':     item['coverUrl'],
            'shelf':        'to-read',
            'myRating':     0,
            'type':         'unknown',
            'themes':       [],
            'tones':        [],
            'dnf':          False,
        }
        books.append(new_book)
        key_to_idx[k] = len(books) - 1
        print(f'  + added: "{item["title"]}" by {item["author"]}')
        newly_added += 1

    total_changes = moved_to_read + newly_added + cover_updated
    if total_changes == 0:
        print('No changes — goodreadsData.json is up to date.')
        if errors:
            print(f'Errors encountered: {"; ".join(errors)}')
            sys.exit(1)
        return

    # Update meta counts
    if 'meta' in data:
        data['meta']['toReadCount'] = sum(1 for b in books if b.get('shelf') == 'to-read')
        data['meta']['readCount']   = sum(1 for b in books if b.get('shelf') == 'read')

    data['books'] = books
    with open(DATA_FILE, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')

    print(f'\nDone. {moved_to_read} moved to read, {newly_added} new to-read books added, {cover_updated} covers backfilled.')
    if errors:
        print(f'Partial errors: {"; ".join(errors)}')

if __name__ == '__main__':
    main()
