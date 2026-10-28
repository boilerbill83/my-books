#!/usr/bin/env python3
"""
One-off diagnostic: Bill pasted the Goodreads "user update widget" embed
code (an iframe at /widgets/user_update_widget?...&user=37243238...),
asking whether it can replace/supplement the already-working shelf
custom_widget fix for currently-reading. This is a recent-activity feed
(started/finished/rated/shelved updates), not a direct shelf query, so
checking for real whether it's reachable anonymously and what it
actually contains before deciding anything. Writes no data.
"""
import urllib.request
import urllib.error

URL = 'https://www.goodreads.com/widgets/user_update_widget?height=400&num_updates=10&user=37243238&width=250'
HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; bbip-diagnostic/1.0)'}

req = urllib.request.Request(URL, headers=HEADERS)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode('utf-8', errors='replace')
        print(f'STATUS: {resp.status}')
        print(f'CONTENT-TYPE: {resp.headers.get("Content-Type")}')
        print(f'LENGTH: {len(body)}')
        print('--- FULL BODY ---')
        print(body)
        print('--- END BODY ---')
except urllib.error.HTTPError as e:
    body = e.read(1000).decode('utf-8', errors='replace')
    print(f'HTTP ERROR: {e.code} {e.reason}')
    print(f'BODY: {body!r}')
except Exception as e:
    print(f'ERROR: {e!r}')
