#!/usr/bin/env python3
"""
One-off diagnostic (not part of the regular pipeline): testing whether
Goodreads' public custom_widget endpoint -- which is designed to be
embedded on external blogs with no login -- can be used as a replacement
data source now that both shelf RSS and the anonymous HTML shelf page are
locked down behind a sign-in wall (see diagnose_rss.py's findings,
2026-10-28). The confirmed-working widget URL Bill pasted from Goodreads'
own Widgets page is:

https://www.goodreads.com/review/custom_widget/37243238.Bill's%20bookshelf:%20currently-reading?cover_position=left&cover_size=small&num_books=5&order=a&shelf=currently-reading&show_author=1&show_cover=1&show_rating=1&show_review=1&show_tags=1&show_title=1&sort=date_added&widget_bg_color=FFFFFF&widget_bg_transparent=&widget_border_width=1&widget_id=1793147407&widget_text_color=000000&widget_title_size=medium&widget_width=medium

This script checks, with real requests (never guessed):
  1. Does the exact confirmed-working URL still return real data?
  2. Does changing shelf= (while keeping the "currently-reading" slug
     text in the path) actually change which shelf's books come back,
     or does Goodreads key off the path slug instead of the query param?
  3. Does raising num_books above the configured 5 return more books,
     or is it capped?
  4. Does a made-up/generic slug text in the path (not Bill's exact
     widget name) still work, or must Bill create a named widget per
     shelf on Goodreads' own Widgets page first?

Writes no data files. Delete this script (and its one-off workflow)
once the real answer is known.
"""
import urllib.request
import urllib.error

HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; bbip-diagnostic/1.0)'}

BASE_CONFIRMED_SLUG = "37243238.Bill's%20bookshelf:%20currently-reading"
BASE_GENERIC_SLUG = "37243238.shelf-test"

COMMON_PARAMS = (
    'cover_position=left&cover_size=small&order=a'
    '&show_author=1&show_cover=1&show_rating=1&show_review=1&show_tags=1&show_title=1'
    '&sort=date_added&widget_bg_color=FFFFFF&widget_bg_transparent=&widget_border_width=1'
    '&widget_id=1793147407&widget_text_color=000000&widget_title_size=medium&widget_width=medium'
)

CANDIDATES = [
    ('1. exact confirmed URL (currently-reading, num_books=5)',
     f'https://www.goodreads.com/review/custom_widget/{BASE_CONFIRMED_SLUG}?{COMMON_PARAMS}&num_books=5&shelf=currently-reading'),

    ('2. same slug text, but shelf=to-read in query (does query override slug?)',
     f'https://www.goodreads.com/review/custom_widget/{BASE_CONFIRMED_SLUG}?{COMMON_PARAMS}&num_books=10&shelf=to-read'),

    ('3. same slug text, shelf=read, num_books=10',
     f'https://www.goodreads.com/review/custom_widget/{BASE_CONFIRMED_SLUG}?{COMMON_PARAMS}&num_books=10&shelf=read'),

    ('4. generic made-up slug text, shelf=to-read (does the path text matter at all?)',
     f'https://www.goodreads.com/review/custom_widget/{BASE_GENERIC_SLUG}?{COMMON_PARAMS}&num_books=10&shelf=to-read'),

    ('5. same confirmed slug, shelf=to-read, num_books=500 (test the cap)',
     f'https://www.goodreads.com/review/custom_widget/{BASE_CONFIRMED_SLUG}?{COMMON_PARAMS}&num_books=500&shelf=to-read'),

    ('6. same confirmed slug, shelf=read, num_books=1000 (test the cap)',
     f'https://www.goodreads.com/review/custom_widget/{BASE_CONFIRMED_SLUG}?{COMMON_PARAMS}&num_books=1000&shelf=read'),
]

for label, url in CANDIDATES:
    print(f'\n=== {label} ===')
    print(f'URL: {url}')
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode('utf-8', errors='replace')
            print(f'STATUS: {resp.status}')
            print(f'CONTENT-TYPE: {resp.headers.get("Content-Type")}')
            print(f'BODY LENGTH: {len(body)} chars')
            # Count how many book entries actually came back (each book gets
            # its own gr_custom_each_container div in the real widget markup).
            book_count = body.count('gr_custom_each_container')
            print(f'BOOK ENTRY COUNT (gr_custom_each_container occurrences): {book_count}')
            print(f'BODY SNIPPET (first 500): {body[:500]!r}')
            if 'Sign in' in body or 'sign_in' in body:
                print('*** CONTAINS SIGN-IN INDICATOR ***')
    except urllib.error.HTTPError as e:
        body = e.read(400).decode('utf-8', errors='replace')
        print(f'HTTP ERROR: {e.code} {e.reason}')
        print(f'BODY SNIPPET: {body!r}')
    except Exception as e:
        print(f'ERROR: {e!r}')

print('\n=== done ===')
