#!/usr/bin/env python3
"""
Refreshes trakt/data/streamingTop10.json — The Streaming Top 10, a weekly,
editorial "what matters on TV right now" list (Bill's brief, 2026-09-25).

Two real research steps, same discipline as audit_theme_tone.py (this
project's only other Claude-API-with-web-search script): a single Claude
call does the actual editorial research (Nielsen, JustWatch, entertainment
press, awards coverage — never fabricated, every entry keeps its real
sources even though the page itself no longer displays them), scored on
the exact four-dimension methodology already committed in
streamingTop10.json's own "methodology" field. This script never lets the
model invent a TMDB id — every title is looked up for real against TMDB's
own search API afterward (the same is_confident_match() discipline
resolve_titles.py already established, to avoid Session 47's real
wrong-match incident), and any newly-discovered title gets a real
candidatePool.json stub + a category_exclude feedbackData.json entry (the
same "editorial pick, not a personal recommendation" precedent the Family
Watch List feature and this feature's own Doll/Mormon Wives titles
already use) so it can be fully enriched (poster/genre/score) without
ever leaking into Bill's personal You'll Love panels.

Requires: ANTHROPIC_API_KEY, TMDB_API_KEY (both already real repo secrets
used by audit_theme_tone.py / enrich_tmdb.py respectively).

Cost note (read before scheduling this daily — see the workflow file):
one run is one Claude call (~20-30 web searches, a few thousand output
tokens — researching 15 shows instead of 10 since 2026-09-26, see
POOL_SIZE below) plus up to 15 cheap TMDB search calls. That's a few
cents to perhaps $0.60/run, not the "tens of dollars per pass" scale that got the
theme/tone audit's own schedule turned off in Session 16f — but it is
real, recurring, billed cost, and Nielsen's own numbers only actually
change weekly, so a literal daily cadence will often re-research and land
on a near-identical list. Disclosed plainly so Bill can dial the schedule
down to weekly if he'd rather not pay for 6 redundant days.

Run manually:  ANTHROPIC_API_KEY=... TMDB_API_KEY=... python3 trakt/refresh_streaming_top10.py
GitHub Action: .github/workflows/trakt-refresh-streaming-top10.yml (daily + manual dispatch)
"""

import json, os, re, sys, time, urllib.request, urllib.parse
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
OUT_FILE = DATA_DIR / 'streamingTop10.json'
API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
TMDB_KEY = os.environ.get('TMDB_API_KEY', '')
MODEL = 'claude-sonnet-5'
MAX_TOKENS = 16000  # raised from 8000 alongside POOL_SIZE 10->15 — more shows means more output text
TMDB_HEADERS = {'User-Agent': 'my-books-trakt-streaming-top10 (personal watch-history app)'}
# Researched pool size (Bill, 2026-09-26: "make the filter a checkbox so I
# can choose what to include; it should always show 10 shows"). The page
# itself only ever displays 10 at once, but a checkbox filter needs real
# material to backfill from when it narrows below 10 — so this script
# researches 15 real, verified-current shows/week instead of exactly 10,
# and the frontend always slices its top 10 of whatever's checked.
POOL_SIZE = 15

METHODOLOGY = ("Scored on four weighted dimensions, per Bill's own detailed brief: Audience 30% "
               "(is anyone actually watching — Nielsen minutes, JustWatch rank), Current Momentum 25% "
               "(is interest rising right now, not just sustained), Cultural Buzz 25% (is it being talked "
               "about — reviews, awards, entertainment press, viral moments), Watchability/Editorial "
               "Relevance 20% (is it actually a good recommendation this week — accessible, "
               "well-reviewed, worth starting). The raw score is an internal ranking mechanism only, "
               "never shown. Every entry keeps real, cited sources in the underlying data even though "
               "the page itself doesn't display them.")

PROMPT = """You are building "The Streaming Top 10" — a weekly, editorial, general-audience ranking of what matters on TV right now (a modern replacement for The Ringer's old Weekly Top 10). This is NOT personalized to any one viewer and NOT a raw popularity chart — it's an opinionated, researched take on what's actually worth paying attention to across every major streaming service this week.

Research using web search — real current sources only (Nielsen's weekly streaming rankings via Hollywood Reporter/Nielsen's own site, JustWatch's streaming charts, Variety, industry trade press, recent awards coverage). Do not invent a number, a quote, or a source. Today's date is {today}.

Score candidates on these four weighted dimensions: {methodology}

CURRENCY CHECK — apply this before including anything, this is the most common mistake to avoid: this list is titled "right now," so only include a show that has genuine, verifiable current activity — a new episode released within roughly the last 3-4 weeks, a season actively airing/streaming right now, a premiere within the next ~2 weeks, or a real, dated news event THIS WEEK (an award win, a major renewal/cancellation announcement, a viral moment). Before including any title, explicitly check: has its current season already fully concluded with nothing new happening? If so, LEAVE IT OUT even if it was a big hit a few months ago — being a good show is not the same as being current. Never assign HOT, RISING, or BUZZY to a show whose season already wrapped with no fresh news this week; if a still-relevant show is between seasons, either leave it out or use ESTABLISHED with an honest "why here" that says so plainly (e.g. "between seasons, but still the most-discussed drama of the year") rather than implying new episodes are dropping. Cite the specific recent date/event in "whyHere" so the currency is verifiable, not asserted.

Return exactly {pool_size} shows or limited series meeting the currency check above (a mix of platforms and genres is good — don't let one platform or genre dominate unless that's genuinely what the data shows). For each, assign exactly one tag: HOT (breakout, dominating conversation right now), RISING (real upward momentum right now), BUZZY (talked about this week, may not be #1 in raw viewership), ESTABLISHED (a proven, still-currently-relevant performer), or UNDER-THE-RADAR (genuinely good and currently active, deserves more attention than it's getting).

Respond with ONLY a JSON object, no markdown fences, no preamble, in exactly this shape:

{{
  "shows": [
    {{
      "rank": 1,
      "title": "exact real title",
      "platform": "e.g. Netflix, Prime Video, HBO Max",
      "tag": "HOT" | "RISING" | "BUZZY" | "ESTABLISHED" | "UNDER-THE-RADAR",
      "whyHere": "1-2 sentences, the real data/momentum reason it's ranked here this week — cite the specific recent date/event",
      "whyWatch": "1 sentence, what makes it worth watching",
      "vibe": "1 short sentence, an evocative one-line description",
      "commitment": "e.g. '1 season (8 episodes) | ~45 min episodes'",
      "sources": [{{"label": "Publication — short description", "url": "real URL"}}]
    }}
  ]
}}

Rules:
- All {pool_size} "rank" values 1-{pool_size}, no gaps or repeats, ordered by your real composite score (highest first).
- Every show needs at least 1 real, working source URL. Never fabricate a source.
- Use each show's official, exact title (matching how it's listed on its streaming platform) — a later step looks this up against TMDB by exact string, so precision matters more than style."""


def call_claude():
    body = json.dumps({
        'model': MODEL,
        'max_tokens': MAX_TOKENS,
        'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 30}],
        'messages': [{'role': 'user', 'content': PROMPT.format(
            today=datetime.now(timezone.utc).strftime('%B %d, %Y'), methodology=METHODOLOGY, pool_size=POOL_SIZE)}],
    }).encode()
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages', data=body,
        headers={'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
                 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read())
    if data.get('stop_reason') == 'max_tokens':
        raise ValueError(f'response hit max_tokens ({MAX_TOKENS}) before finishing — raise the budget')
    text_blocks = [b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text']
    if not text_blocks:
        raise ValueError(f'no text block in response: {data}')
    return text_blocks[-1].strip()


def extract_json_object(text):
    """
    Pulls the {...} object out of a response that may carry markdown fences
    AND/OR leading prose before the JSON (a real failure hit on the first
    production run: the prompt says "no preamble," but the model's final
    text block still opened with a short sentence before the fenced block,
    which plain removeprefix('```json') doesn't strip since the fence
    itself isn't at position 0 — producing the exact "Expecting value:
    line 1 column 1" error json.loads gives on a string that doesn't start
    with valid JSON, even though the *tail* of the string looks fine).
    Finds the first '{' and the matching last '}' and parses just that
    span, so any prose before or after is simply ignored rather than
    tripping the parser.
    """
    start = text.find('{')
    end = text.rfind('}')
    if start == -1 or end == -1 or end < start:
        raise ValueError(f'no JSON object found in response — tail: ...{text[-300:]!r}')
    return text[start:end + 1]


def parse_shows():
    raw = call_claude()
    candidate = extract_json_object(raw)
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as e:
        raise ValueError(f'{e} — raw response tail: ...{raw[-300:]!r}') from e
    shows = parsed.get('shows')
    if not isinstance(shows, list) or len(shows) != POOL_SIZE:
        raise ValueError(f'expected exactly {POOL_SIZE} shows, got {len(shows) if isinstance(shows, list) else "non-list"}')
    ranks = sorted(s.get('rank') for s in shows)
    if ranks != list(range(1, POOL_SIZE + 1)):
        raise ValueError(f'ranks are not a clean 1-{POOL_SIZE} sequence: {ranks}')
    return shows


# --- TMDB resolution, same discipline as resolve_titles.py: never guess an
# id, only trust an exact or clearly-confident search match. ---

def tmdb_get(url):
    try:
        req = urllib.request.Request(url, headers=TMDB_HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


def tmdb_search_show(title):
    q = urllib.parse.quote(title)
    data = tmdb_get(f'https://api.themoviedb.org/3/search/tv?api_key={TMDB_KEY}&query={q}')
    results = (data or {}).get('results') or []
    return results[0] if results else None


def normalize(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def is_confident_match(query_title, matched_title):
    q, m = normalize(query_title), normalize(matched_title)
    if not q or not m:
        return False
    if q == m:
        return True
    if len(q) < 12:
        return False
    if q in m or m in q:
        return min(len(q), len(m)) / max(len(q), len(m)) >= 0.5
    return False


def resolve_show_titlekey(title, known, pool_titles, history_keys):
    result = tmdb_search_show(title)
    time.sleep(0.35)
    if not result:
        print(f'    no TMDB match | {title}')
        return None
    matched_title = result.get('name') or title
    if not is_confident_match(title, matched_title):
        print(f'    low-confidence, skipping id | {title} -> {matched_title}')
        return None
    tmdb_id = result['id']
    key = f'show:{tmdb_id}'
    if key in known:
        return key
    if key not in history_keys:
        pool_titles.append({
            'type': 'show', 'titleKey': key, 'ids': {'tmdb': tmdb_id},
            'title': None, 'year': None, 'source': 'streaming-top10',
        })
        known.add(key)
        history_keys.add(key)
        print(f'    new candidate stub added | {title} -> {matched_title} ({key})')
    return key


def add_feedback_exclusion(feedback, title_key, title):
    if any(e.get('titleKey') == title_key and e.get('reasonCode') == 'streaming_top10_editorial'
           for e in feedback.get('interactions', [])):
        return
    feedback.setdefault('interactions', []).append({
        'titleKey': title_key, 'title': title, 'year': None, 'type': 'show',
        'interactionType': 'category_exclude', 'reasonCode': 'streaming_top10_editorial',
        'reasonLabel': ("Not a taste dismissal — an editorial pick on The Streaming Top 10 "
                        "(trakt/streaming-top10.html), a general-audience \"what's happening on TV "
                        "this week\" list, not a personal recommendation. Excluded so it never "
                        "surfaces as a solo \"You'll Love\" pick now that it also has a "
                        "candidatePool.json stub for real TMDB enrichment (poster/genre/score "
                        "display on the Top 10 page)."),
        'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'excludeFromRecommendations': True,
    })


def main():
    if not API_KEY:
        sys.exit('ERROR: ANTHROPIC_API_KEY is not set.')
    if not TMDB_KEY:
        sys.exit('ERROR: TMDB_API_KEY is not set.')

    print('Researching this week\'s Streaming Top 10 via Claude + web search...')
    shows = parse_shows()
    print(f'Got {len(shows)} shows from Claude. Resolving TMDB ids...')

    library = json.load(open(DATA_DIR / 'library.json'))
    watchlist = json.load(open(DATA_DIR / 'watchlist.json'))
    pool_path = DATA_DIR / 'candidatePool.json'
    pool = json.load(open(pool_path)) if pool_path.exists() else {'titles': []}
    history_path = DATA_DIR / 'discoveredHistory.json'
    history = json.load(open(history_path)) if history_path.exists() else {'titleKeys': []}
    history_keys = set(history.get('titleKeys', []))
    feedback_path = DATA_DIR / 'feedbackData.json'
    feedback = json.load(open(feedback_path)) if feedback_path.exists() else {'interactions': []}

    lib_wl_keys = {t['titleKey'] for t in library['titles'] + watchlist['titles'] if t.get('titleKey')}
    known = set(lib_wl_keys)
    for t in pool['titles']:
        if t.get('titleKey'):
            known.add(t['titleKey'])

    for s in shows:
        key = resolve_show_titlekey(s['title'], known, pool['titles'], history_keys)
        s['titleKey'] = key
        s.setdefault('sources', [])
        # Only exclude a title from Bill's personal You'll Love flow when
        # it's genuinely NOT his own real Trakt data — a pure
        # candidatePool-only discovery added just so this editorial page
        # can enrich/display it. A real bug hit on the first production
        # run: excluding EVERY resolved title unconditionally also pulled
        # genuine watchlist picks (e.g. Lanterns, Monster: The Lizzie
        # Borden Story) out of rankAll()'s fromWatchlist entirely, since
        # that filter checks idx.excluded — Bill's own real data must
        # never be excluded from his own recommendations just because it
        # also happens to be trending this week.
        if key and key not in lib_wl_keys:
            add_feedback_exclusion(feedback, key, s['title'])

    pool['meta'] = {'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'count': len(pool['titles'])}
    history['titleKeys'] = sorted(history_keys)
    json.dump(pool, open(pool_path, 'w'), indent=2)
    json.dump(history, open(history_path, 'w'), indent=2)
    json.dump(feedback, open(feedback_path, 'w'), indent=2)

    now = datetime.now(timezone.utc)
    output = {
        'note': ("Real, weekly editorial Top 10 (Bill, 2026-09-25: build a modern replacement for "
                 "The Ringer's old Weekly Top 10). General-audience — NOT derived from Bill's own "
                 "Trakt data or BMTRE's scoring engine, and not personalized to him (it happens to "
                 "overlap with shows he watches since those are genuinely the biggest shows on TV "
                 "right now too). Auto-refreshed daily via trakt/refresh_streaming_top10.py "
                 "(.github/workflows/trakt-refresh-streaming-top10.yml) — a real Claude + web-search "
                 "call does the research fresh each run (Nielsen/JustWatch/entertainment "
                 "press/awards coverage), never fabricated. Each show's own status/predicted "
                 "score/genre tags on the page are separately computed live from Bill's real Trakt "
                 "data and BMTRE — display only, they never affect this list's editorial ranking. "
                 f"Researches {POOL_SIZE} real, currency-verified shows/week (not just 10, since "
                 "2026-09-26) — the page itself always displays exactly 10, backfilling from the "
                 "rest of this list whenever Bill's own checkbox status filter narrows the visible "
                 "set below that. Every entry requires genuine current-week evidence (a recent "
                 "episode/premiere/news event, cited in whyHere) before qualifying — a show whose "
                 "season already wrapped with nothing new happening is excluded outright rather "
                 "than kept around on reputation alone."),
        'methodology': METHODOLOGY,
        'weekOf': now.strftime('%Y-%m-%d'),
        'generatedAt': now.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
        'shows': shows,
    }
    json.dump(output, open(OUT_FILE, 'w'), indent=1, ensure_ascii=False)
    print(f'Wrote {OUT_FILE} — {sum(1 for s in shows if s["titleKey"])}/{len(shows)} shows resolved to a real TMDB id.')


if __name__ == '__main__':
    main()
