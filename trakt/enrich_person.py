#!/usr/bin/env python3
"""
Enriches real people (cast members) with birthday/gender from TMDB's
/person/{id} endpoint — Bill's follow-up to the modernNetworkTvPenalty
finding: "maybe if the lead female is over 70, I rarely like those."

TMDB's /movie/{id} and /tv/{id} detail responses (what enrich_tmdb.py
calls) carry cast id/name/gender in credits.cast, but NOT birthdate —
that requires this separate, second endpoint. Cached independently in
trakt/data/personMetadata.json, keyed by TMDB person id (not titleKey —
the same person can be the lead of several titles, and this cache is
shared/amortized across all of them, not per-title).

Processes all 5 of each title's topCastDetail entries (Bill: "the age
of the top five stars by their listed order; this will help us see
what I like") — not just the lead, so the full billing-order age
profile of a title's cast is available for exploration, not only a
single lead/no-lead signal.

Run manually:   python3 trakt/enrich_person.py [batch_size]
GitHub Action:  .github/workflows/trakt-enrich-person.yml

Needs the same TMDB_API_KEY repo secret trakt/enrich_tmdb.py already
uses (same account, same key — no new secret needed).

Also captures TMDB's own person-level `popularity` field (Bill: "is
there a way to identify a TV show as prestige... maybe those with a big
star like JK Simmons") — a real, TMDB-computed "how well-known is this
person right now" score, already present in the same /person/{id}
response this script fetches for birthday/gender, just never captured
before. The 2,500 already-cached people predate this field entirely
(only name/birthday/deathday/gender were ever stored), so REFRESH_ALL=1
(or --refresh-all) re-fetches every cached person, not just new ones —
same one-off-backfill idiom enrich_tmdb.py's own REFRESH_ALL already
established for exactly this "cache predates a new field" situation.
"""

import json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
DATA_DIR   = ROOT / 'trakt' / 'data'
CACHE_FILE = DATA_DIR / 'personMetadata.json'
ENRICHED_FILE = DATA_DIR / 'enrichedMetadata.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 300
REFRESH_ALL = os.environ.get('REFRESH_ALL') == '1' or '--refresh-all' in sys.argv
API_KEY    = os.environ.get('TMDB_API_KEY', '')
DELAY      = 0.3
API_BASE   = 'https://api.themoviedb.org/3'
HEADERS    = {'User-Agent': 'my-books-trakt-person-enrichment (personal watch-history app)'}


def get_json(url, timeout=10):
    """Same (data, status, error_body) contract as enrich_tmdb.py's own
    get_json() — surfaces TMDB's real error body on a non-2xx response
    rather than just the bare status code, the same lesson from that
    script's real dead-key incident."""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8')), resp.status, None
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode('utf-8', errors='replace')[:500]
        except Exception:
            body = None
        return None, e.code, body
    except Exception as e:
        return None, None, str(e)[:500]


def person_detail(person_id):
    url = f'{API_BASE}/person/{person_id}?api_key={API_KEY}'
    return get_json(url)


def load_lead_person_ids():
    """Bill: "let's add this as metadata; the age of the top five [cast]
    by their listed order; this will help us see what I like" — broadened
    from lead-only to every one of topCastDetail's top-5 billing slots,
    across watchlist/library/candidatePool. Real volume tradeoff (~5x
    more unique people than lead-only), but still amortized: the same
    actor appearing across many titles is only ever fetched once, and
    TMDB's rate limit has headroom for it (same DELAY as enrich_tmdb.py).
    engine.js's age()/castAges() consumes this by billing order, not
    just "the lead," per Bill's own framing."""
    if not ENRICHED_FILE.exists():
        return {}
    enriched = json.load(open(ENRICHED_FILE))
    people = {}  # person id -> name (for logging only; cache is id-keyed)
    for entry in enriched.values():
        detail = entry.get('topCastDetail')
        if not detail:
            continue
        for member in detail:
            pid = member.get('id')
            if pid is not None:
                people[pid] = member.get('name')
    return people


def main():
    if not API_KEY:
        print('ERROR: TMDB_API_KEY is not set. Same key trakt/enrich_tmdb.py uses.', file=sys.stderr)
        sys.exit(1)

    cache = json.load(open(CACHE_FILE)) if CACHE_FILE.exists() else {}
    people = load_lead_person_ids()
    if REFRESH_ALL:
        pending = list(people.items())
    else:
        pending = [(pid, name) for pid, name in people.items() if str(pid) not in cache]

    batch = pending[:BATCH_SIZE]
    print(f'{len(people)} unique top-5-billed cast members found across all enriched titles, '
          f'{len(pending)} not yet person-enriched, processing {len(batch)}')

    failures = 0
    for i, (pid, name) in enumerate(batch, 1):
        data, status, error_body = person_detail(pid)
        if status == 401:
            print(f'ERROR: TMDB rejected the API key (401). TMDB\'s own response: {error_body!r}. '
                  'Stop — no point burning through the rest of the batch on a bad key.', file=sys.stderr)
            sys.exit(1)
        if not data:
            failures += 1
            print(f'  [{i}/{len(batch)}] FAIL (status {status}, {error_body!r}) | {name}')
            time.sleep(DELAY)
            continue

        cache[str(pid)] = {
            'name': data.get('name'),
            'birthday': data.get('birthday'),  # 'YYYY-MM-DD' or None (TMDB doesn't have it for everyone)
            'deathday': data.get('deathday'),
            'gender': data.get('gender'),  # 0 unspecified, 1 female, 2 male, 3 non-binary
            'popularity': data.get('popularity'),  # TMDB's own real-time "how known is this person" score
            'fetchedAt': time.strftime('%Y-%m-%d'),
        }
        bday = cache[str(pid)]['birthday'] or '—'
        pop = cache[str(pid)]['popularity']
        print(f'  [{i}/{len(batch)}] ok (born {bday}, popularity {pop}) | {name}')
        if i % 25 == 0:
            json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
        time.sleep(DELAY)

    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    if batch and failures == len(batch):
        print('ERROR: every person in this batch failed — treat as a real failure, not a quiet success.',
              file=sys.stderr)
        sys.exit(1)

    with_bday = sum(1 for v in cache.values() if v.get('birthday'))
    with_pop = sum(1 for v in cache.values() if v.get('popularity') is not None)
    print(f'done: {len(cache)} people cached, {with_bday} with a real birthday, {with_pop} with a popularity score')


if __name__ == '__main__':
    main()
