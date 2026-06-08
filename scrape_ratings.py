#!/usr/bin/env python3
"""
Daily scraper: Amazon ratings via Playwright.
Runs BATCH_SIZE books per day via GitHub Actions (5x/day) until all books
in the candidate pools and to-read shelf have been processed.

Results stored in data/scrapedRatings.json — app.js merges at load time.

Run manually:   python3 scrape_ratings.py [batch_size]
GitHub Action:  .github/workflows/scrape-ratings.yml
"""

import json, time, random, re, sys
from pathlib import Path
from urllib.parse import quote

DATA_DIR   = Path('data')
CACHE_FILE = DATA_DIR / 'scrapedRatings.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 25
MIN_DELAY  = 10   # seconds between requests
MAX_DELAY  = 20

# ── Cache helpers ──────────────────────────────────────────────────────────

def load_cache():
    if CACHE_FILE.exists():
        with open(CACHE_FILE) as f:
            return json.load(f)
    return {}

def save_cache(cache):
    with open(CACHE_FILE, 'w') as f:
        json.dump(cache, f, indent=2)
        f.write('\n')

def book_key(book):
    """Stable cache key: bare title (no subtitle/series) + first-listed author."""
    title  = re.sub(r'\s*[:({\[].*', '', str(book.get('title',  ''))).strip().lower()
    title  = re.sub(r'\s*\(.*?\)\s*$', '', title).strip()
    author = str(book.get('author', '')).split(',')[0].strip().lower()
    return f"{title}|||{author}"

# ── Book loading ───────────────────────────────────────────────────────────

def load_pending(cache):
    """Return all books not yet in cache, candidates first."""
    with open(DATA_DIR / 'goodreadsData.json') as f:
        gd = json.load(f)
    to_read = [b for b in gd['books'] if b.get('shelf') == 'to-read']

    candidates = []
    for path in sorted(DATA_DIR.glob('candidatePool*.json')):
        with open(path) as f:
            candidates += json.load(f).get('candidates', [])

    all_books = candidates + to_read
    seen, unique = set(), []
    for b in all_books:
        k = book_key(b)
        if k not in seen:
            seen.add(k)
            unique.append(b)

    return [b for b in unique if book_key(b) not in cache]

# ── Amazon ─────────────────────────────────────────────────────────────────

def extract_cover_url(html):
    """Extract the first Amazon CDN book cover URL from search result HTML."""
    # s-image class (search results) — grab src or data-src
    for attr in ('src', 'data-src'):
        m = re.search(
            r'<img[^>]+class="[^"]*s-image[^"]*"[^>]+' + attr + r'="(https://m\.media-amazon\.com/images/I/[^"]+)"',
            html, re.S
        )
        if m:
            url = m.group(1)
            # Normalise to a clean medium-size image (remove size suffixes, add clean one)
            url = re.sub(r'\._[A-Z0-9_,]+_\.', '._SX300_.', url)
            return url
    return None

def scrape_amazon(page, book):
    from playwright.sync_api import TimeoutError as PWTimeout
    isbn   = book.get('isbn13') or book.get('isbn') or ''
    bare   = re.sub(r'\s*[:({\[].*', '', str(book.get('title',''))).strip()[:40]
    author = str(book.get('author', '')).split(',')[0].strip()

    url = (f"https://www.amazon.com/s?k={isbn}&i=stripbooks" if isbn
           else f"https://www.amazon.com/s?k={quote(bare+' '+author)}&i=stripbooks")

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=20_000)
        time.sleep(random.uniform(4, 7))
        html = page.content()
    except PWTimeout:
        return None

    cover_url = extract_cover_url(html)

    # JSON-LD (most reliable when present)
    for ld_raw in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            obj = json.loads(ld_raw)
            ar  = obj.get('aggregateRating') or {}
            rv  = ar.get('ratingValue')
            rc  = ar.get('reviewCount') or ar.get('ratingCount')
            if rv:
                return {'rating': float(rv), 'count': int(rc) if rc else None,
                        'coverUrl': cover_url}
        except Exception:
            pass

    # Regex fallback
    m = re.search(r'(\d\.\d)\s+out of\s+5\s+stars', html, re.I)
    if m:
        rating = float(m.group(1))
        cm = re.search(r'([\d,]+)\s+(?:global\s+)?ratings', html, re.I)
        return {'rating': rating, 'count': int(cm.group(1).replace(',','')) if cm else None,
                'coverUrl': cover_url}

    # No rating found but we may still have a cover
    if cover_url:
        return {'rating': None, 'count': None, 'coverUrl': cover_url}

    return None

# ── Main ───────────────────────────────────────────────────────────────────

def main():
    cache   = load_cache()
    pending = load_pending(cache)

    if not pending:
        print("All books already scraped — nothing to do.")
        return

    batch = pending[:BATCH_SIZE]
    print(f"Queue: {len(pending)} remaining  |  Processing {len(batch)} this run\n")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed. Run: pip install playwright && playwright install chromium --with-deps")
        sys.exit(1)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        )
        ctx = browser.new_context(
            user_agent=(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/124.0.0.0 Safari/537.36'
            ),
            viewport={'width': 1280, 'height': 900},
            locale='en-US',
            timezone_id='America/Chicago',
        )
        page = ctx.new_page()
        page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,svg}', lambda r: r.abort())

        for i, book in enumerate(batch):
            key    = book_key(book)
            title  = book.get('title', '')[:55]
            print(f"[{i+1:2}/{len(batch)}] {title}")

            amz = scrape_amazon(page, book)
            if amz:
                cache[key] = {
                    'storyGraph': None,
                    'amazon':     {'rating': amz.get('rating'), 'count': amz.get('count')},
                    'coverUrl':   amz.get('coverUrl'),
                    'source':     'amazon' if amz.get('rating') else 'cover_only',
                }
                rating_str = f"{amz['rating']}★  ({amz['count']:,} ratings)" if amz.get('rating') else 'no rating'
                cover_str  = ' + cover' if amz.get('coverUrl') else ''
                print(f"         ✓  {rating_str}{cover_str}")
            else:
                cache[key] = {'storyGraph': None, 'amazon': None, 'coverUrl': None, 'source': 'not_found'}
                print(f"         ✗  not found")

            save_cache(cache)

            if i + 1 < len(batch):
                delay = random.uniform(MIN_DELAY, MAX_DELAY)
                print(f"         sleeping {delay:.0f}s…")
                time.sleep(delay)

        browser.close()

    found     = sum(1 for v in cache.values() if v['source'] != 'not_found')
    remaining = len(pending) - len(batch)
    print(f"\n✅  Batch done.  Cache: {found}/{len(cache)} found  |  {remaining} still in queue")

if __name__ == '__main__':
    main()
