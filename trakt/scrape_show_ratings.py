#!/usr/bin/env python3
"""
Closes the real gap found in Session 52: OMDb's API returns Rotten
Tomatoes/Metacritic scores for movies but essentially never for TV shows
(confirmed against OMDb's own GitHub issue tracker — a TV query with
tomatoes=true still comes back N/A for every RT field; not a bug in
enrich_omdb.py's extraction). Both RT and Metacritic genuinely do carry
show-level scores on their own sites, they're just not exposed through
OMDb's API — so this scrapes them directly via Playwright, the same
approach scrape_ratings.py already uses for Amazon on the book side.

Results are cached separately in trakt/data/scrapedShowRatings.json
(never blended into omdbMetadata.json itself, so the source of every
value stays traceable — same discipline that keeps TMDB/OMDb/scraped
data in three separate cache files throughout this project) and merged
at read time by dashboard.js/recommend.js/prune_candidate_pool.js: OMDb's
own rottenTomatoes/metacritic values win when present (movies), this
cache fills the gap only when OMDb has neither (mostly shows).

Keyed by titleKey (exact TMDB id) rather than a fuzzy title match — every
title in this project already carries one, sidestepping the whole
title-matching bug class the book side's scraper has to work around via
book_key(). Each site is searched independently via that site's own
search page (not a third-party search engine, since this sandbox's
network egress proxy blocks Google/DuckDuckGo/Bing too when tested, and
using the site's own intended search feature is also the more legitimate
approach) — a title can find a real RT match and no MC match, or vice
versa; both are recorded independently.

IMPORTANT — this has never been run for real. Direct network access to
rottentomatoes.com/metacritic.com is blocked from the interactive
sandbox this was written in (confirmed via a direct WebFetch test), so
none of the search/scrape logic below could be verified live before
being committed. The very first workflow_dispatch run IS the real test —
read its job log carefully; the search URL / JSON-LD parsing / CSS
fallback selectors below are a best-effort design based on documented
patterns, not something proven against a live response. Print verbose
per-title diagnostics for exactly this reason.

Run manually:   python3 trakt/scrape_show_ratings.py [batch_size]
GitHub Action:  .github/workflows/trakt-scrape-show-ratings.yml
"""

import json, re, sys, time, random
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
CACHE_FILE = DATA_DIR / 'scrapedShowRatings.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 40
MIN_DELAY = 6
MAX_DELAY = 12
RETRY_COOLDOWN_DAYS = 14   # same convention as scrape_ratings.py: a miss
                            # (not a permanent "no score exists") is retried
                            # after this long, a real score is cached forever


def load_cache():
    if CACHE_FILE.exists():
        return json.load(open(CACHE_FILE))
    return {}


def save_cache(cache):
    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    with open(CACHE_FILE, 'a') as f:
        f.write('\n')


def is_cached_done(entry):
    """A real score (rt or mc found) is permanent. A total miss is
    retried after RETRY_COOLDOWN_DAYS — the same one-off-failure-vs-
    real-no-data distinction scrape_ratings.py already makes for Amazon."""
    if entry is None:
        return False
    if entry.get('rottenTomatoes') is not None or entry.get('metacritic') is not None:
        return True
    checked_at = entry.get('checkedAt')
    if not checked_at:
        return False
    try:
        age = datetime.utcnow() - datetime.strptime(checked_at, '%Y-%m-%d')
    except ValueError:
        return False
    return age < timedelta(days=RETRY_COOLDOWN_DAYS)


def load_pending(cache):
    """OMDb-enriched titles where OMDb itself has neither RT nor MC — the
    exact gap this script exists to close. No point scraping a title
    OMDb already answered (mostly movies), and no point scraping a title
    with no OMDb record at all yet (enrich_omdb.py needs to run first;
    title/year for the search query come from enrichedMetadata.json,
    which every title here already has by construction)."""
    omdb = json.load(open(DATA_DIR / 'omdbMetadata.json')) if (DATA_DIR / 'omdbMetadata.json').exists() else {}
    enriched = json.load(open(DATA_DIR / 'enrichedMetadata.json')) if (DATA_DIR / 'enrichedMetadata.json').exists() else {}

    titles = []
    seen = set()
    for name in ('watchlist.json', 'library.json', 'candidatePool.json'):
        p = DATA_DIR / name
        if not p.exists():
            continue
        for t in json.load(open(p)).get('titles', []):
            key = t.get('titleKey')
            if not key or key in seen:
                continue
            omdb_entry = omdb.get(key)
            if not omdb_entry:
                continue  # not OMDb-enriched yet, out of scope for this script
            if omdb_entry.get('rottenTomatoes') is not None or omdb_entry.get('metacritic') is not None:
                continue  # OMDb already answered this one (almost always a movie)
            meta = enriched.get(key, {})
            title = meta.get('title') or t.get('title')
            year = meta.get('year') or t.get('year')
            if not title:
                continue
            seen.add(key)
            titles.append({'titleKey': key, 'type': t.get('type'), 'title': title, 'year': year})

    return [t for t in titles if not is_cached_done(cache.get(t['titleKey']))]


# ── Rotten Tomatoes ──────────────────────────────────────────────────────

def scrape_rt(page, title, year, kind):
    """kind: 'movie' or 'show'. Uses RT's own search page, takes the
    first result under the matching /m/ or /tv/ path, then reads the
    Tomatometer/audience score off that page — JSON-LD aggregateRating
    first (documented as the stable, redesign-resistant source), a
    regex fallback on visible "NN%" score text next. Returns
    {'critic': int|None, 'audience': int|None} or None if no matching
    page was found at all."""
    from playwright.sync_api import TimeoutError as PWTimeout
    try:
        page.goto(f'https://www.rottentomatoes.com/search?search={quote(title)}',
                   wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_timeout(random.randint(2500, 4000))
        html = page.content()
    except PWTimeout:
        return None

    path_prefix = '/tv/' if kind == 'show' else '/m/'
    # RT's search results render as <a> tags to /m/<slug> or /tv/<slug>;
    # take the first one under the right type path (not doing year-
    # disambiguation here — imprecise, but a wrong RT match just means a
    # wrong score gets cached, so this needs real-run verification before
    # being trusted at scale, noted in the module docstring above).
    m = re.search(r'href="(https://www\.rottentomatoes\.com' + re.escape(path_prefix) + r'[a-z0-9_-]+)"', html)
    if not m:
        return None
    url = m.group(1)

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_timeout(random.randint(2000, 3500))
        html = page.content()
    except PWTimeout:
        return None

    critic = audience = None
    for ld_raw in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            obj = json.loads(ld_raw)
            objs = obj if isinstance(obj, list) else [obj]
            for o in objs:
                ar = o.get('aggregateRating') if isinstance(o, dict) else None
                if ar and ar.get('ratingValue'):
                    val = float(ar['ratingValue'])
                    # RT's schema.org block is typically 0-100 already for
                    # the critic (Tomatometer) score
                    critic = round(val) if val > 5 else round(val * 20)
        except Exception:
            pass

    if critic is None:
        cm = re.search(r'"criticsScore"\s*:\s*\{[^}]*?"value"\s*:\s*"?(\d+)', html)
        if not cm:
            cm = re.search(r'tomatometer["\s:]+(\d{1,3})\s*%', html, re.I)
        if cm:
            critic = int(cm.group(1))

    am = re.search(r'"audienceScore"\s*:\s*\{[^}]*?"value"\s*:\s*"?(\d+)', html)
    if am:
        audience = int(am.group(1))

    if critic is None and audience is None:
        return None
    return {'critic': critic, 'audience': audience, 'url': url}


# ── Metacritic ────────────────────────────────────────────────────────────

def scrape_metacritic(page, title, year, kind):
    """kind: 'movie' or 'show'. Same search-then-scrape shape as RT."""
    from playwright.sync_api import TimeoutError as PWTimeout
    try:
        page.goto(f'https://www.metacritic.com/search/{quote(title)}/',
                   wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_timeout(random.randint(2500, 4000))
        html = page.content()
    except PWTimeout:
        return None

    path_prefix = '/tv/' if kind == 'show' else '/movie/'
    m = re.search(r'href="(https://www\.metacritic\.com' + re.escape(path_prefix) + r'[a-z0-9_-]+/?)"', html)
    if not m:
        return None
    url = m.group(1)

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_timeout(random.randint(2000, 3500))
        html = page.content()
    except PWTimeout:
        return None

    metascore = user_score = None
    for ld_raw in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            obj = json.loads(ld_raw)
            objs = obj if isinstance(obj, list) else [obj]
            for o in objs:
                ar = o.get('aggregateRating') if isinstance(o, dict) else None
                if ar and ar.get('ratingValue'):
                    metascore = round(float(ar['ratingValue']))
        except Exception:
            pass

    if metascore is None:
        mm = re.search(r'"metascore"\s*:\s*"?(\d{1,3})', html, re.I)
        if not mm:
            mm = re.search(r'Metascore["\s:]+(\d{1,3})\b', html)
        if mm:
            metascore = int(mm.group(1))

    um = re.search(r'"userscore"\s*:\s*"?(\d+(?:\.\d+)?)', html, re.I)
    if um:
        user_score = round(float(um.group(1)) * 10)

    if metascore is None and user_score is None:
        return None
    return {'metascore': metascore, 'userScore': user_score, 'url': url}


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    cache = load_cache()
    pending = load_pending(cache)

    if not pending:
        print('Nothing pending — every OMDb-gap title has already been scraped or is on cooldown.')
        return

    batch = pending[:BATCH_SIZE]
    print(f'Queue: {len(pending)} remaining (OMDb-enriched, no RT/MC from OMDb)  |  processing {len(batch)} this run\n')

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('ERROR: playwright not installed. Run: pip install playwright && playwright install chromium --with-deps')
        sys.exit(1)

    rt_found = mc_found = neither = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        )
        ctx = browser.new_context(
            user_agent=('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
            viewport={'width': 1280, 'height': 900},
            locale='en-US',
        )
        page = ctx.new_page()
        page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,svg}', lambda r: r.abort())

        for i, t in enumerate(batch, 1):
            label = f"{t['title']} ({t['year']})" if t['year'] else t['title']
            print(f"[{i:3}/{len(batch)}] {label[:60]} [{t['type']}]")

            rt = None
            try:
                rt = scrape_rt(page, t['title'], t['year'], t['type'])
            except Exception as e:
                print(f'         RT error: {e}')
            time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))

            mc = None
            try:
                mc = scrape_metacritic(page, t['title'], t['year'], t['type'])
            except Exception as e:
                print(f'         MC error: {e}')
            time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))

            entry = {
                'rottenTomatoes': rt.get('critic') if rt else None,
                'rtAudience': rt.get('audience') if rt else None,
                'rtUrl': rt.get('url') if rt else None,
                'metacritic': mc.get('metascore') if mc else None,
                'metacriticUser': mc.get('userScore') if mc else None,
                'mcUrl': mc.get('url') if mc else None,
                'checkedAt': time.strftime('%Y-%m-%d'),
            }
            cache[t['titleKey']] = entry

            if entry['rottenTomatoes'] is not None:
                rt_found += 1
            if entry['metacritic'] is not None:
                mc_found += 1
            if entry['rottenTomatoes'] is None and entry['metacritic'] is None:
                neither += 1

            rt_str = f"RT {entry['rottenTomatoes']}%" if entry['rottenTomatoes'] is not None else 'RT —'
            mc_str = f"MC {entry['metacritic']}" if entry['metacritic'] is not None else 'MC —'
            print(f'         {rt_str}  |  {mc_str}')

            if i % 10 == 0:
                save_cache(cache)

        browser.close()

    save_cache(cache)
    print(f'\nBatch done: {rt_found}/{len(batch)} found on RT, {mc_found}/{len(batch)} found on Metacritic, '
          f'{neither}/{len(batch)} found on neither.')
    if len(batch) >= 5 and rt_found == 0 and mc_found == 0:
        print('WARNING: zero titles matched on either site this batch — likely a real scraping failure '
              '(search page structure changed, bot detection, or a wrong URL pattern), not a genuine '
              'data gap for every single title. Check the per-title output above before trusting this cache.',
              file=sys.stderr)


if __name__ == '__main__':
    main()
