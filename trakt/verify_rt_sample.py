#!/usr/bin/env python3
"""
One-off, real-network verification harness for scrape_show_ratings.py's
RT/Metacritic extraction. Never wired into the scheduled scraper
pipeline, never writes to trakt/data/scrapedShowRatings.json (the
trusted, committed cache) — only to trakt/data/rtVerificationSample.json
(gitignored), so a wrong result here can't corrupt real data before a
human has actually cross-checked it against outside sources.

This sandbox can't fetch rottentomatoes.com/metacritic.com directly
(confirmed via a direct curl before this was first written — HTTP 000),
same as every other real scraper fix in this project's history — so
this can only be run for real inside GitHub Actions (see
.github/workflows/trakt-verify-rt.yml), and its job log output is the
actual test.

ROUND 1 (critic scores): verified RT's Tomatometer extraction after the
per-block name-matching fix — 12/12 matched real Tomatometer scores.
SCRAPE_RT was then enabled and a real 494-title backfill run confirmed
it in production (463/494 = 93.8% hit rate).

ROUND 2 (audience/user scores): that same production run found the
AUDIENCE side (RT Popcornmeter, Metacritic user score) genuinely never
populated — 0 of 494 titles. Diagnosed from the run's own job log:
every page had exactly one JSON-LD aggregateRating block (the critic
one), never a second audience-scale block. Two new, specific extraction
paths were added on that diagnosis: extract_score_board_scores() (RT's
real <score-board> custom element, hypothesized to render server-side
with tomatometerscore/audiencescore attributes, independent of the
schema.org JSON-LD block) and extract_next_data_user_score()
(Metacritic's hypothesized Next.js __NEXT_DATA__ props blob, tried when
the JSON-LD scan doesn't find a bestRating==10 user-score block).

REAL RESULT (run 2, this file's own 12-title batch): both hypotheses
disproven cleanly. No <score-board> tag was found on any of the 12 RT
pages (tomatometerscore/audiencescore both None every time, even though
the critic score extracted fine from JSON-LD on the same pages), and no
<script id="__NEXT_DATA__"> tag was found on any of the 12 Metacritic
pages (nextDataFound False every time). This is a real, informative
negative — not "still didn't find a value," but "the specific markup
looked for genuinely isn't present" in this fetch strategy. Neither
extraction path is trusted for a bulk backfill as a result (both stay
in the code as harmless no-ops — they only ever fill a value nothing
else found).

ROUND 3 (Bill's explicit go-ahead after round 2's negative result was
reported): tested the one remaining real hypothesis neither prior round
tried — that the audience widget genuinely isn't in the DOM yet at the
point this scraper reads it (`domcontentloaded` + a short 2-4s fixed
wait), independent of which markup it eventually uses.
scrape_rt()/scrape_metacritic() now call _wait_for_hydration() before
reading a detail page: a real `networkidle` wait followed by a much
longer fixed floor (6-9s vs. the previous 2-4s).

REAL RESULT (run 3, this file's own 12-title batch): also cleanly
negative, and more conclusive than round 2 — waiting substantially
longer did NOT reveal a <score-board> tag or a __NEXT_DATA__ script on
any of the 12 real pages either, the identical zero-signal result as
round 2. Critic score held at 12/12 throughout (the fetch itself works
fine). Three distinct, real technical hypotheses have now failed with
concrete diagnostic evidence each time — this is where the "no third
blind attempt" rule actually bites: a 4th guess from training-data
recollection about RT/MC's markup isn't warranted without new
information (e.g. someone providing real page source). Reported to Bill
as a final negative rather than attempted again autonomously.

ROUND 4 (Bill: "keep trying to figure it out"): not a 4th markup guess —
real research first. WebSearch on how other real scrapers extract RT's
audience score turned up a specific, credible alternative explanation
for why rounds 2-3 both came back completely empty rather than just
"wrong value": Rotten Tomatoes injects its Tomatometer/Popcornmeter
scores client-side and reportedly needs "a rendered page behind a
trusted IP" — and Cloudflare (which RT is understood to sit behind) is
well-documented to give datacenter/cloud IPs low trust scores and
selectively withhold or degrade content for them. A GitHub Actions
runner IS a datacenter IP. This would explain the exact pattern seen so
far far better than three unrelated wrong guesses would: the critic
score (likely served from a more cacheable/SEO-stable path even to
flagged traffic) reliably works, while the client-injected audience
widget specifically never appears, regardless of how long the page is
given to load — because the server may simply never send it to this
traffic, no matter how long the client waits.

Verified this sandbox has no way to check a real RT/MC page directly to
confirm or rule this out before shipping — WebFetch on both domains
returned EGRESS_BLOCKED (the environment's own proxy status log shows
this is a real allowlist policy, not a fluke: recent 403s on
www.google.com/redirector.gvt1.com too), and neither web.archive.org
nor a public read-proxy (r.jina.ai) were reachable either. So rather
than guess further at markup, this round adds real diagnostic
instrumentation instead: _page_diagnostics() (scrape_show_ratings.py)
captures the actual HTTP status code, the page's own <title> tag, and
a scan for known bot-challenge phrases (Rotten Tomatoes' own real
"Pardon Our Interruption" interstitial title, plus generic Cloudflare
challenge-page markers) on every detail-page fetch, logged regardless
of outcome. This run's job log is the actual test of the bot-detection
hypothesis — a real positive (a challenge title, a non-200 status) would
confirm it; a normal-looking 200/title with no challenge marker
wouldn't rule it out (a silent content-stripping response is possible
too) but would at least eliminate the most obvious form of it.

REAL RESULT (run 4, this file's own 12-title batch): bot detection
ruled out cleanly. Every single one of 24 page fetches (12 RT + 12 MC)
came back status 200 with the correct, real page title (e.g.
"WandaVision | Rotten Tomatoes", "WandaVision Reviews - Metacritic") and
zero bot-challenge markers. HTML sizes were substantial and real
(380-450KB on RT, ~1.05-1.12MB on Metacritic) — not the tiny stub a
challenge/block page would produce. Combined with the critic score
extracting correctly from that same content on every title, this is
strong evidence the pages ARE loading completely and correctly; they
just never contain the specific markup (a <score-board> tag, a
__NEXT_DATA__ script) rounds 2-3 looked for. The most likely remaining
explanation is that those two specific structural guesses about RT/MC's
markup are simply wrong, not blocked or slow — round 4b (same file,
next commit) checks one purely observational step before concluding
that: does the word "audience"/"Popcornmeter"/"user score" appear
ANYWHERE in the real page text at all, in any form, which would tell us
whether the feature is present-but-differently-shaped versus genuinely
absent from what this scraper receives.

SAMPLE: the same 12 titles Round 1 verified (already-known imdb ids),
now also checked against real RT Popcornmeter / Metacritic user score
ground truth gathered via WebSearch just before this version was
written. Not every title has ground truth for both values (some
searches didn't surface a clean number) — realRTAudience/realMCUser
are None where genuinely unknown, and those checks are skipped rather
than guessed. Scores drift a few points over time as more reviews
land, so treat these as an approximate real target, not an exact
literal match.
"""

import json, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / 'trakt' / 'data' / 'rtVerificationSample.json'

SAMPLE = [
    {'title': 'WandaVision', 'year': 2021, 'imdbId': 'tt9140560',
     'realRT': 92, 'realRTAudience': 88, 'realMCUser': 71},
    {'title': 'Chernobyl', 'year': 2019, 'imdbId': 'tt7366338',
     'realRT': 95, 'realRTAudience': 97, 'realMCUser': 91},
    {'title': 'Band of Brothers', 'year': 2001, 'imdbId': 'tt0185906',
     'realRT': 94, 'realRTAudience': 97, 'realMCUser': 93},
    {'title': 'She-Hulk: Attorney at Law', 'year': 2022, 'imdbId': 'tt10857160',
     'realRT': 84, 'realRTAudience': None, 'realMCUser': None},
    {'title': 'Mare of Easttown', 'year': 2021, 'imdbId': 'tt10155688',
     'realRT': 95, 'realRTAudience': 94, 'realMCUser': 84},
    {'title': 'Adolescence', 'year': 2025, 'imdbId': 'tt31806037',
     'realRT': 98, 'realRTAudience': None, 'realMCUser': None},
    {'title': 'Dexter: New Blood', 'year': 2021, 'imdbId': 'tt14164730',
     'realRT': 77, 'realRTAudience': None, 'realMCUser': None},
    {'title': '3 Body Problem', 'year': 2024, 'imdbId': 'tt13016388',
     'realRT': 78, 'realRTAudience': None, 'realMCUser': None},
    {'title': 'The Last Dance', 'year': 2020, 'imdbId': 'tt8420184',
     'realRT': 97, 'realRTAudience': 95, 'realMCUser': 86},
    {'title': 'Baby Reindeer', 'year': 2024, 'imdbId': 'tt13649112',
     'realRT': 99, 'realRTAudience': 81, 'realMCUser': 73},
    {'title': 'Sharp Objects', 'year': 2018, 'imdbId': 'tt2649356',
     'realRT': 92, 'realRTAudience': 83, 'realMCUser': 73},
    {'title': 'Normal People', 'year': 2020, 'imdbId': 'tt9059760',
     'realRT': 91, 'realRTAudience': 92, 'realMCUser': 83},
]

TOLERANCE = 8       # RT/MC critic scores drift a few points as more reviews
                     # land; treat a scrape within this many points as a match.
AUD_TOLERANCE = 12  # Audience/user scores are lower-volume and drift more
                     # (a single Baby Reindeer search already showed an
                     # 81/88/100 range across different snapshots) — a wider
                     # but still real tolerance, not a rubber stamp.


def check(label, scraped, real, tol, matched_counter):
    if real is None:
        print(f'  {label}: scraped={scraped!r}  (no ground truth gathered — not checked)')
        return None
    ok = scraped is not None and abs(scraped - real) <= tol
    matched_counter[0] += 1 if ok else 0
    matched_counter[1] += 1
    status = 'MATCH' if ok else ('NO MATCH' if scraped is not None else 'NOTHING FOUND')
    print(f'  {label}: scraped={scraped!r} real~{real} -> {status}')
    return ok


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('ERROR: playwright not installed. Run: pip install playwright && playwright install chromium --with-deps')
        raise SystemExit(1)

    from scrape_show_ratings import scrape_rt, scrape_metacritic

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

        # [matched, checked] — shared counters across critic + all audience checks
        rt_counter = [0, 0]
        aud_counter = [0, 0]

        for i, t in enumerate(SAMPLE, 1):
            print(f"\n[{i}/{len(SAMPLE)}] {t['title']} ({t['year']})")
            try:
                rt = scrape_rt(page, t['title'], t['year'], 'show', t['imdbId'])
            except Exception as e:
                print(f'  RT ERROR: {e}')
                rt = None
            time.sleep(2)
            try:
                mc = scrape_metacritic(page, t['title'], t['year'], 'show', t['imdbId'])
            except Exception as e:
                print(f'  MC ERROR: {e}')
                mc = None

            rt_critic = rt.get('critic') if rt else None
            rt_audience = rt.get('audience') if rt else None
            mc_user = mc.get('userScore') if mc else None

            check('RT critic  ', rt_critic, t['realRT'], TOLERANCE, rt_counter)
            check('RT audience', rt_audience, t['realRTAudience'], AUD_TOLERANCE, aud_counter)
            check('MC user    ', mc_user, t['realMCUser'], AUD_TOLERANCE, aud_counter)

            if rt:
                print(f"  RT url: {rt.get('url')}")
                for d in (rt.get('debug') or []):
                    if 'pageDiagnostics' in d:
                        print(f"  >>> RT page diagnostics: {d['pageDiagnostics']}")
                    else:
                        print(f'  RT debug: {d}')
            if mc:
                print(f"  MC url: {mc.get('url')}")
                if mc.get('nextData'):
                    nd = dict(mc['nextData'])
                    pd = nd.pop('pageDiagnostics', None)
                    print(f"  MC __NEXT_DATA__ scan: {nd}")
                    if pd:
                        print(f'  >>> MC page diagnostics: {pd}')

            results.append({
                **t, 'scrapedRTCritic': rt_critic, 'scrapedRTAudience': rt_audience,
                'scrapedMCUser': mc_user, 'rtUrl': rt.get('url') if rt else None,
                'mcUrl': mc.get('url') if mc else None, 'rtDebug': rt.get('debug') if rt else None,
                'mcNextData': mc.get('nextData') if mc else None,
                'checkedAt': time.strftime('%Y-%m-%d'),
            })
            time.sleep(3)

        browser.close()

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    json.dump({'results': results, 'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ')}, open(OUT_FILE, 'w'), indent=1)

    print(f'\n{"="*60}')
    print(f'RT critic:   {rt_counter[0]}/{rt_counter[1]} matched within +/-{TOLERANCE} points.')
    print(f'Audience/user (RT Popcornmeter + MC user, combined): {aud_counter[0]}/{aud_counter[1]} matched '
          f'within +/-{AUD_TOLERANCE} points (only titles with real ground truth gathered are counted).')
    print(f'Written to {OUT_FILE} (gitignored — for job-log inspection only, never committed).')
    if aud_counter[1] == 0:
        print('GO/NO-GO (audience): no audience data was even found to check — the new extraction paths '
              '(score-board / __NEXT_DATA__) are producing nothing. Inspect the RT debug / MC __NEXT_DATA__ '
              'scan lines above to see what was actually on each page.')
    elif aud_counter[0] < aud_counter[1] * 0.6:
        print('GO/NO-GO (audience): below a 60% match rate — do NOT trust this for a bulk backfill yet. '
              'Inspect the debug output above to see what actually got scraped vs. the real numbers.')
    else:
        print('GO/NO-GO (audience): matched well enough to consider a real bulk backfill, pending a human '
              'read of the per-title debug output above (not just the match count).')


if __name__ == '__main__':
    main()
