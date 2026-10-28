#!/usr/bin/env python3
"""
One-off diagnostic (not part of the regular pipeline): sync_goodreads.py and
sync_currently_reading.py both started hitting a real HTTP 404 ("Sorry you
got bad directions") from Goodreads on 2026-10-27, on every shelf RSS fetch.
This sandbox's own network policy blocks goodreads.com entirely, so this
script exists purely so a GitHub Actions runner (which does have real network
access) can test several plausible real Goodreads feed-URL variants and
report back actual HTTP status codes + response snippets -- never guessing
a fix blind. Writes no data files. Delete this script (and its one-off
workflow) once the real answer is known.
"""
import urllib.request
import urllib.error

HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; bbip-diagnostic/1.0)'}

CANDIDATES = [
    ('current (list_rss, bare id)', 'https://www.goodreads.com/review/list_rss/37243238?shelf=read'),
    ('list_rss with slug', 'https://www.goodreads.com/review/list_rss/37243238-bill-stoltenberg?shelf=read'),
    ('list_rss with sort/per_page (full current params)', 'https://www.goodreads.com/review/list_rss/37243238?shelf=read&sort=date_updated&per_page=5'),
    ('review_rss singular, bare id', 'https://www.goodreads.com/review_rss/37243238?shelf=read'),
    ('review_rss singular, with slug', 'https://www.goodreads.com/review_rss/37243238-bill-stoltenberg?shelf=read'),
    ('home updates rss (not shelf-specific)', 'https://www.goodreads.com/home/index_rss/37243238'),
    ('user updates rss (not shelf-specific)', 'https://www.goodreads.com/user/updates_rss/37243238'),
    ('shelf page itself (HTML, not RSS, control check)', 'https://www.goodreads.com/review/list/37243238?shelf=read'),
    ('shelf page with slug (HTML, control check)', 'https://www.goodreads.com/review/list/37243238-bill-stoltenberg?shelf=read'),
]

for label, url in CANDIDATES:
    print(f'\n=== {label} ===')
    print(f'URL: {url}')
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read(400).decode('utf-8', errors='replace')
            print(f'STATUS: {resp.status}')
            print(f'CONTENT-TYPE: {resp.headers.get("Content-Type")}')
            print(f'BODY SNIPPET: {body!r}')
    except urllib.error.HTTPError as e:
        body = e.read(400).decode('utf-8', errors='replace')
        print(f'HTTP ERROR: {e.code} {e.reason}')
        print(f'BODY SNIPPET: {body!r}')
    except Exception as e:
        print(f'ERROR: {e!r}')

print('\n=== done ===')
