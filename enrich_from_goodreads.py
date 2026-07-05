#!/usr/bin/env python3
"""
Last-resort description fill: scrape each missing book's own Goodreads page.
Every book in goodreadsData.json originated on Goodreads, so a page exists
even when Google Books and Open Library have nothing.

Reads bookId, fetches goodreads.com/book/show/{id}, and extracts the
description from the embedded __NEXT_DATA__ JSON (falls back to the
og:description meta tag). Writes into data/enrichedMetadata.json with
source='goodreads'.

Run: python3 enrich_from_goodreads.py
Workflow: .github/workflows/enrich-goodreads.yml (manual dispatch)
"""

import html, json, re, time, urllib.request
from pathlib import Path

DATA_DIR   = Path('data')
CACHE_FILE = DATA_DIR / 'enrichedMetadata.json'
DELAY      = 3.0   # be polite — this is a tiny batch anyway
HEADERS    = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                            'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'}


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode('utf-8', 'ignore')


def clean(text):
    text = html.unescape(str(text or ''))
    text = re.sub(r'<[^>]+>', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def extract_description(page):
    # 1. __NEXT_DATA__ blob: "description":"..." on the Book object
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
    if m:
        try:
            data = json.loads(m.group(1))
            state = data['props']['pageProps']['apolloState']
            for v in state.values():
                if isinstance(v, dict) and v.get('__typename') == 'Book' and v.get('description'):
                    return clean(v['description'])
        except Exception:
            pass
    # 2. og:description meta (truncated but better than nothing)
    m = re.search(r'<meta property="og:description" content="([^"]+)"', page)
    return clean(m.group(1)) if m else ''


def load_targets(cache):
    with open(DATA_DIR / 'goodreadsData.json') as f:
        books = json.load(f)['books']
    for path in sorted(DATA_DIR.glob('candidatePool*.json')):
        with open(path) as f:
            books += json.load(f).get('candidates', [])
    return [b for b in books
            if b.get('bookKey') and b.get('bookId')
            and not cache.get(b['bookKey'], {}).get('description')]


def main():
    cache = json.load(open(CACHE_FILE)) if CACHE_FILE.exists() else {}
    targets = load_targets(cache)
    print(f'{len(targets)} books to attempt via Goodreads')

    got = 0
    for i, b in enumerate(targets, 1):
        url = f"https://www.goodreads.com/book/show/{b['bookId']}"
        try:
            desc = extract_description(fetch(url))
        except Exception as e:
            print(f'  [{i}] ERR {b["title"][:40]}: {e}')
            time.sleep(DELAY)
            continue
        entry = cache.setdefault(b['bookKey'], {'title': b['title'], 'author': b.get('author', '')})
        if len(desc) >= 80:
            entry['description'] = desc[:2000]
            entry['source'] = 'goodreads'
            got += 1
            print(f'  [{i}/{len(targets)}] ok   {b["title"][:45]}')
        else:
            print(f'  [{i}/{len(targets)}] thin {b["title"][:45]}')
        entry['goodreadsTriedAt'] = time.strftime('%Y-%m-%d')
        time.sleep(DELAY)

    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    print(f'done: {got} descriptions recovered from Goodreads')


if __name__ == '__main__':
    main()
