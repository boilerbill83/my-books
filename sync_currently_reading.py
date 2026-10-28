#!/usr/bin/env python3
"""
Fetches the currently-reading shelf from Bill's public Goodreads "custom
widget" endpoint and writes data/currentlyReading.json. Designed to run as
a GitHub Action every few hours.

History: originally used the shelf RSS feed (review/list_rss/...), which
Goodreads broke outright on 2026-10-27 -- every RSS URL variant (and even
the plain anonymous HTML shelf page) now 404s or redirects to a sign-in
wall. Confirmed via a real GitHub Actions diagnostic run, not guessed.

The one surviving public, no-login endpoint is Goodreads' own embeddable
"custom widget" (Tools -> Widgets on goodreads.com), which Bill already
has configured for his currently-reading shelf (widget_id baked server-
side; the shelf=/num_books= query params in the URL are vestigial --
confirmed by testing with different values and getting byte-identical
responses). That's fine here: currently-reading is always 0-5 books,
comfortably within however many the widget was configured to show.

This endpoint does not carry isbn / community avgRating / year / pages --
only title, author, cover image, and Bill's own star rating for the book.
app.js's renderCurrentlyReading() already renders those optional fields
only when present, so this is a real, not a degraded, replacement for
what the app actually needs.

NOTE: this endpoint is specific to the currently-reading shelf only. It
is NOT a viable replacement for the full read/to-read shelf sync
(sync_goodreads.py) -- the widget is locked to a fixed, small book count
set when it was created on Goodreads, not a bulk export mechanism.
"""

import html
import json
import re
import sys
import urllib.request
from pathlib import Path

WIDGET_URL = (
    "https://www.goodreads.com/review/custom_widget/"
    "37243238.Bill's%20bookshelf:%20currently-reading"
    "?cover_position=left&cover_size=small&num_books=5&order=a&shelf=currently-reading"
    "&show_author=1&show_cover=1&show_rating=1&show_review=1&show_tags=1&show_title=1"
    "&sort=date_added&widget_bg_color=FFFFFF&widget_bg_transparent=&widget_border_width=1"
    "&widget_id=1793147407&widget_text_color=000000&widget_title_size=medium&widget_width=medium"
)
OUT_FILE = Path('data/currentlyReading.json')

HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept-Language': 'en-US,en;q=0.9',
}

EACH_BOOK_RE = re.compile(
    r'<div class="gr_custom_each_container_\d+">(.*?)</div>\s*</div>',
    re.DOTALL,
)
BOOK_COVER_RE = re.compile(
    r'<div class="gr_custom_book_container_\d+">.*?<img[^>]*\bsrc="([^"]+)"',
    re.DOTALL,
)
TITLE_RE = re.compile(
    r'<div class="gr_custom_title_\d+">\s*<a[^>]*>(.*?)</a>',
    re.DOTALL,
)
AUTHOR_RE = re.compile(
    r'<div class="gr_custom_author_\d+">\s*by\s*<a[^>]*>(.*?)</a>',
    re.DOTALL,
)
RATING_BLOCK_RE = re.compile(
    r'<div class="gr_custom_rating_\d+">(.*?)</div>',
    re.DOTALL,
)


def fetch_widget():
    req = urllib.request.Request(WIDGET_URL, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode('utf-8', errors='replace')


def unescape_js_string(raw_js):
    """Pull the single-quoted `widget_code = '...'` JS string literal out
    and un-escape it back into real HTML (the server backslash-escapes
    double quotes, forward slashes in closing tags, and newlines)."""
    m = re.search(r"var widget_code = '(.*?)'\s*\n\s*var widget_div", raw_js, re.DOTALL)
    if not m:
        return None
    js_str = m.group(1)
    return (
        js_str
        .replace('\\"', '"')
        .replace('\\/', '/')
        .replace('\\n', '\n')
        .replace("\\'", "'")
    )


def parse_widget_html(body_html):
    books = []
    for block in EACH_BOOK_RE.findall(body_html):
        title_m = TITLE_RE.search(block)
        if not title_m:
            continue
        title = html.unescape(re.sub(r'<[^>]+>', '', title_m.group(1))).strip()
        if not title:
            continue

        author_m = AUTHOR_RE.search(block)
        author = html.unescape(re.sub(r'<[^>]+>', '', author_m.group(1))).strip() if author_m else ''

        cover_m = BOOK_COVER_RE.search(block)
        cover = cover_m.group(1) if cover_m else None

        rating_m = RATING_BLOCK_RE.search(block)
        my_rating = None
        if rating_m:
            star_imgs = re.findall(r'<img[^>]*src="([^"]+)"', rating_m.group(1))
            if star_imgs:
                my_rating = sum(1 for s in star_imgs if 'inactive' not in s)

        books.append({
            'title':     title,
            'author':    author or '',
            'coverUrl':  cover or None,
            'isbn':      None,
            'avgRating': None,
            'year':      None,
            'pages':     None,
            'myRating':  my_rating,
            'shelf':     'currently-reading',
        })
    return books


def main():
    try:
        raw_js = fetch_widget()
    except Exception as e:
        print(f'ERROR fetching widget: {e}')
        sys.exit(1)

    body_html = unescape_js_string(raw_js)
    if body_html is None:
        print('ERROR: widget response did not match the expected `var widget_code = \'...\'` shape '
              '-- Goodreads may have changed the widget format. Not updating the file.')
        sys.exit(1)

    books = parse_widget_html(body_html)

    # Load existing to detect changes
    existing = []
    if OUT_FILE.exists():
        try:
            with open(OUT_FILE) as f:
                existing = json.load(f)
        except Exception:
            pass

    # Compare by title+author only (ignore cover URL / rating churn)
    def key(b): return (b['title'], b['author'])
    if sorted(map(key, books)) == sorted(map(key, existing)):
        if books:
            print(f'No change — still {len(books)} book(s): {", ".join(b["title"] for b in books)}')
        else:
            print('No change — still 0 books currently reading.')
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
