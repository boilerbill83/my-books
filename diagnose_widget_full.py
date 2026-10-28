#!/usr/bin/env python3
"""
One-off: print the FULL body of the confirmed-working currently-reading
widget URL so the real parser can be built against real structure, not a
truncated guess. Writes no data.
"""
import urllib.request

URL = (
    "https://www.goodreads.com/review/custom_widget/"
    "37243238.Bill's%20bookshelf:%20currently-reading"
    "?cover_position=left&cover_size=small&num_books=5&order=a&shelf=currently-reading"
    "&show_author=1&show_cover=1&show_rating=1&show_review=1&show_tags=1&show_title=1"
    "&sort=date_added&widget_bg_color=FFFFFF&widget_bg_transparent=&widget_border_width=1"
    "&widget_id=1793147407&widget_text_color=000000&widget_title_size=medium&widget_width=medium"
)
HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; bbip-diagnostic/1.0)'}

req = urllib.request.Request(URL, headers=HEADERS)
with urllib.request.urlopen(req, timeout=20) as resp:
    body = resp.read().decode('utf-8', errors='replace')
    print(f'STATUS: {resp.status}')
    print(f'LENGTH: {len(body)}')
    print('--- FULL BODY ---')
    print(body)
    print('--- END BODY ---')
