#!/usr/bin/env python3
"""
One-off, real-network verification harness for the RT extraction fix in
scrape_show_ratings.py (extract_rt_scores()/name_field_matches_title()) —
Action 2 of the AudienceScore plan. Never wired into the scheduled
scraper pipeline, never writes to trakt/data/scrapedShowRatings.json
(the trusted, committed cache) — only to trakt/data/rtVerificationSample.json
(gitignored), so a wrong result here can't corrupt real data before a
human has actually cross-checked it against outside sources.

This sandbox can't fetch rottentomatoes.com directly (confirmed via a
direct curl before writing this — HTTP 000), same as every other real
scraper fix in this project's history — so this can only be run for
real inside GitHub Actions (see .github/workflows/trakt-verify-rt.yml),
and its job log output is the actual test. RT scraping has already
failed real accuracy verification 3 times in prior sessions (see
scrape_show_ratings.py's module docstring); this is one more bounded,
honestly-evaluated attempt with a different, more targeted fix
(per-block name matching, not just the wrong-page IMDb-id guard that
already fixed Metacritic) — go/no-go decided from THIS run's real
output, not asserted in advance.

SAMPLE: 12 well-known, mostly single-season/limited shows already in
Bill's real library, picked specifically to minimize season-page
ambiguity (a show with 5+ seasons may show a per-season score on RT's
default landing page, not a series aggregate, which would make a
"wrong" scraped number ambiguous rather than a clean pass/fail). Real
Tomatometer ground truth gathered via WebSearch just before this script
was written (scores drift a few points over time as more reviews land,
so treat these as an approximate real target, not an exact literal
match) — logged here for the person reading the job log, not consumed
programmatically:

  WandaVision (2021)              real RT ~92%
  Chernobyl (2019)                 real RT ~95%
  Band of Brothers (2001)          real RT ~94%
  She-Hulk: Attorney at Law (2022) real RT ~80-87% (fluctuated over time)
  Mare of Easttown (2021)          real RT ~95%
  Adolescence (2025)               real RT ~97-100% (fluctuated over time)
  Dexter: New Blood (2021)         real RT ~77%
  3 Body Problem (2024)            real RT ~78%
  The Last Dance (2020)            real RT ~97%
  Baby Reindeer (2024)             real RT ~99% (100% at launch)
  Sharp Objects (2018)             real RT ~92%
  Normal People (2020)             real RT ~91%

Run manually:   python3 trakt/verify_rt_sample.py
GitHub Action:  .github/workflows/trakt-verify-rt.yml (workflow_dispatch only)
"""

import json, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / 'trakt' / 'data' / 'rtVerificationSample.json'

SAMPLE = [
    {'title': 'WandaVision', 'year': 2021, 'imdbId': 'tt9140560', 'realRT': 92},
    {'title': 'Chernobyl', 'year': 2019, 'imdbId': 'tt7366338', 'realRT': 95},
    {'title': 'Band of Brothers', 'year': 2001, 'imdbId': 'tt0185906', 'realRT': 94},
    {'title': 'She-Hulk: Attorney at Law', 'year': 2022, 'imdbId': 'tt10857160', 'realRT': 84},
    {'title': 'Mare of Easttown', 'year': 2021, 'imdbId': 'tt10155688', 'realRT': 95},
    {'title': 'Adolescence', 'year': 2025, 'imdbId': 'tt31806037', 'realRT': 98},
    {'title': 'Dexter: New Blood', 'year': 2021, 'imdbId': 'tt14164730', 'realRT': 77},
    {'title': '3 Body Problem', 'year': 2024, 'imdbId': 'tt13016388', 'realRT': 78},
    {'title': 'The Last Dance', 'year': 2020, 'imdbId': 'tt8420184', 'realRT': 97},
    {'title': 'Baby Reindeer', 'year': 2024, 'imdbId': 'tt13649112', 'realRT': 99},
    {'title': 'Sharp Objects', 'year': 2018, 'imdbId': 'tt2649356', 'realRT': 92},
    {'title': 'Normal People', 'year': 2020, 'imdbId': 'tt9059760', 'realRT': 91},
]

TOLERANCE = 8  # RT scores drift a few points as more reviews land; treat a
                # scrape within this many points of the researched real
                # value as a match, not requiring bit-exactness.


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('ERROR: playwright not installed. Run: pip install playwright && playwright install chromium --with-deps')
        raise SystemExit(1)

    from scrape_show_ratings import scrape_rt

    results = []
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

        matched = 0
        for i, t in enumerate(SAMPLE, 1):
            print(f"\n[{i}/{len(SAMPLE)}] {t['title']} ({t['year']}) — real RT ~{t['realRT']}%")
            try:
                rt = scrape_rt(page, t['title'], t['year'], 'show', t['imdbId'])
            except Exception as e:
                print(f'  ERROR: {e}')
                rt = None
            scraped = rt.get('critic') if rt else None
            ok = scraped is not None and abs(scraped - t['realRT']) <= TOLERANCE
            if ok:
                matched += 1
            print(f"  scraped critic: {scraped!r}  |  {'MATCH' if ok else 'NO MATCH' if scraped is not None else 'NOTHING FOUND'}")
            if rt:
                print(f"  url: {rt.get('url')}")
                for d in (rt.get('debug') or []):
                    print(f"  debug: {d}")
            results.append({**t, 'scraped': scraped, 'match': ok, 'url': rt.get('url') if rt else None,
                             'debug': rt.get('debug') if rt else None, 'checkedAt': time.strftime('%Y-%m-%d')})
            time.sleep(3)

        browser.close()

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    json.dump({'results': results, 'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ')}, open(OUT_FILE, 'w'), indent=1)

    print(f'\n{"="*60}')
    print(f'RESULT: {matched}/{len(SAMPLE)} matched real RT scores within +/-{TOLERANCE} points.')
    print(f'Written to {OUT_FILE} (gitignored — for job-log inspection only, never committed).')
    if matched < len(SAMPLE) * 0.7:
        print('GO/NO-GO: below 70% match rate — do NOT enable SCRAPE_RT for a bulk run. '
              'Inspect the debug output above to see what actually got scraped.')
    else:
        print('GO/NO-GO: matched well enough to consider enabling SCRAPE_RT for a real bulk run, '
              'pending a human read of the per-title debug output above (not just the match count).')


if __name__ == '__main__':
    main()
