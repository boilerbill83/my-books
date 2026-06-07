#!/usr/bin/env python3
"""
Daily scraper: StoryGraph ratings (primary) + Amazon ratings (fallback).
Runs BATCH_SIZE books per day — designed as a daily GitHub Action so it
spreads work over ~2 weeks and never looks like bulk scraping.

Results stored in data/scrapedRatings.json (separate from source files).
The app merges this at load time via app.js.

Run manually:   python3 scrape_ratings.py
GitHub Action:  .github/workflows/scrape-ratings.yml (scheduled daily)
"""

import json, time, random, re, sys
from pathlib import Path
from urllib.parse import quote

DATA_DIR   = Path('data')
CACHE_FILE = DATA_DIR / 'scrapedRatings.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 25
MIN_DELAY  = 10   # seconds between book requests
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

    # Candidates first — engine uses them for ranking
    all_books = candidates + to_read
    # Deduplicate by key (same book may appear in multiple pools)
    seen, unique = set(), []
    for b in all_books:
        k = book_key(b)
        if k not in seen:
            seen.add(k)
            unique.append(b)

    return [b for b in unique if book_key(b) not in cache]

# ── StoryGraph ─────────────────────────────────────────────────────────────

SG_MOODS = {
    'adventurous', 'dark', 'emotional', 'funny', 'hopeful', 'informative',
    'inspiring', 'lighthearted', 'mysterious', 'reflective', 'relaxing',
    'sad', 'tense',
}

def sg_search(page, title, author):
    """Search StoryGraph; return first matching book-detail URL or None."""
    from playwright.sync_api import TimeoutError as PWTimeout
    bare  = re.sub(r'\s*[:({\[].*', '', title).strip()[:50]
    query = f"{bare} {author.split(',')[0].strip()}"[:60]

    try:
        page.goto(
            f"https://app.thestorygraph.com/books?utf8=%E2%9C%93&search_term={quote(query)}",
            wait_until='networkidle', timeout=25_000
        )
        time.sleep(random.uniform(2, 4))
        # Book detail links look like /books/some-slug (not /books?...)
        for link in page.query_selector_all('a[href*="/books/"]'):
            href = (link.get_attribute('href') or '').strip()
            if re.match(r'^/books/[a-z0-9][a-z0-9\-]+$', href):
                return f"https://app.thestorygraph.com{href}"
    except PWTimeout:
        pass
    return None

def sg_extract(page, url):
    """Fetch StoryGraph book page; return dict with rating/count/moods/pace."""
    from playwright.sync_api import TimeoutError as PWTimeout
    try:
        page.goto(url, wait_until='networkidle', timeout=25_000)
        time.sleep(random.uniform(2, 4))
        html = page.content()
    except PWTimeout:
        return None

    # ── Rating ──
    # StoryGraph shows the average like "3.94" in several spots; try structured
    # data first (most reliable), then visible text patterns.
    rating = None
    for ld_raw in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            obj = json.loads(ld_raw)
            rv  = (obj.get('aggregateRating') or {}).get('ratingValue')
            if rv:
                r = float(rv)
                if 1.0 <= r <= 5.0:
                    rating = r; break
        except Exception:
            pass

    if not rating:
        for pat in [
            r'"ratingValue"\s*:\s*"?(\d\.\d{1,2})',
            r'(\d\.\d{1,2})\s+out of 5',
            r'average[^\d]*(\d\.\d{1,2})',
        ]:
            m = re.search(pat, html, re.I)
            if m:
                r = float(m.group(1))
                if 1.0 <= r <= 5.0:
                    rating = r; break

    if not rating:
        return None

    # ── Rating count ──
    count = None
    for pat in [r'"ratingCount"\s*:\s*(\d+)', r'([\d,]+)\s+ratings?']:
        m = re.search(pat, html, re.I)
        if m:
            count = int(m.group(1).replace(',', '')); break

    # ── Moods ──
    found_moods = [w for w in re.findall(r'\b[a-z]+\b', html.lower()) if w in SG_MOODS]
    moods = list(dict.fromkeys(found_moods))[:5]  # deduplicated, capped at 5

    # ── Pace ──
    pace = None
    m = re.search(r'\b(fast[\-\s]paced|slow[\-\s]paced|average[\-\s]paced)\b', html, re.I)
    if m:
        pace = re.sub(r'\s', '-', m.group(1).lower())

    return {'rating': rating, 'count': count, 'moods': moods, 'pace': pace}

def scrape_storygraph(page, book):
    url = sg_search(page, book.get('title',''), book.get('author',''))
    if not url:
        return None
    time.sleep(random.uniform(3, 5))
    return sg_extract(page, url)

# ── Amazon ─────────────────────────────────────────────────────────────────

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

    # ── JSON-LD (most reliable when present) ──
    for ld_raw in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            obj = json.loads(ld_raw)
            ar  = obj.get('aggregateRating') or {}
            rv  = ar.get('ratingValue')
            rc  = ar.get('reviewCount') or ar.get('ratingCount')
            if rv:
                return {'rating': float(rv), 'count': int(rc) if rc else None}
        except Exception:
            pass

    # ── Regex fallback ──
    m = re.search(r'(\d\.\d)\s+out of\s+5\s+stars', html, re.I)
    if m:
        rating = float(m.group(1))
        cm = re.search(r'([\d,]+)\s+(?:global\s+)?ratings', html, re.I)
        return {'rating': rating, 'count': int(cm.group(1).replace(',','')) if cm else None}

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
        # Block images/fonts to speed up page loads
        page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,svg}', lambda r: r.abort())

        for i, book in enumerate(batch):
            key    = book_key(book)
            title  = book.get('title', '')[:55]
            author = book.get('author', '')[:25]
            print(f"[{i+1:2}/{len(batch)}] {title}")

            # StoryGraph first
            sg = scrape_storygraph(page, book)
            if sg:
                cache[key] = {'storyGraph': sg, 'amazon': None, 'source': 'storyGraph'}
                mood_str = ', '.join(sg['moods']) or '—'
                print(f"         SG ✓  {sg['rating']}★  "
                      f"({sg['count']:,} ratings)  moods=[{mood_str}]  pace={sg['pace']}")
            else:
                print(f"         SG ✗  trying Amazon…")
                time.sleep(random.uniform(MIN_DELAY // 2, MAX_DELAY // 2))

                amz = scrape_amazon(page, book)
                if amz:
                    cache[key] = {'storyGraph': None, 'amazon': amz, 'source': 'amazon'}
                    cnt = f"{amz['count']:,}" if amz.get('count') else '?'
                    print(f"         AMZ ✓  {amz['rating']}★  ({cnt} ratings)")
                else:
                    cache[key] = {'storyGraph': None, 'amazon': None, 'source': 'not_found'}
                    print(f"         ✗  not found on either source")

            save_cache(cache)

            if i + 1 < len(batch):
                delay = random.uniform(MIN_DELAY, MAX_DELAY)
                print(f"         sleeping {delay:.0f}s…")
                time.sleep(delay)

        browser.close()

    found     = sum(1 for v in cache.values() if v['source'] != 'not_found')
    remaining = len(pending) - len(batch)
    print(f"\n✅  Batch done.  Cache total: {found}/{len(cache)} found  |  {remaining} books still in queue")

if __name__ == '__main__':
    main()
