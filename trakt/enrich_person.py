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

Only processes the LEAD (billing position 0) of each title's
topCastDetail — the question is specifically about a show/movie's
lead, not its whole ensemble, and it keeps the person-lookup volume to
roughly one call per unique lead actor rather than 5x that.

Run manually:   python3 trakt/enrich_person.py [batch_size]
GitHub Action:  .github/workflows/trakt-enrich-person.yml

Needs the same TMDB_API_KEY repo secret trakt/enrich_tmdb.py already
uses (same account, same key — no new secret needed).
"""

import json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
DATA_DIR   = ROOT / 'trakt' / 'data'
CACHE_FILE = DATA_DIR / 'personMetadata.json'
ENRICHED_FILE = DATA_DIR / 'enrichedMetadata.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 300
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
    """The lead (billing position 0) of every title's topCastDetail,
    across watchlist/library/candidatePool — enrich_tmdb.py's own
    priority order isn't relevant here since this reads already-cached
    enrichedMetadata.json rather than fetching titles itself."""
    if not ENRICHED_FILE.exists():
        return {}
    enriched = json.load(open(ENRICHED_FILE))
    leads = {}  # person id -> name (for logging only; cache is id-keyed)
    for entry in enriched.values():
        detail = entry.get('topCastDetail')
        if not detail:
            continue
        lead = detail[0]
        pid = lead.get('id')
        if pid is not None:
            leads[pid] = lead.get('name')
    return leads


def main():
    if not API_KEY:
        print('ERROR: TMDB_API_KEY is not set. Same key trakt/enrich_tmdb.py uses.', file=sys.stderr)
        sys.exit(1)

    cache = json.load(open(CACHE_FILE)) if CACHE_FILE.exists() else {}
    leads = load_lead_person_ids()
    pending = [(pid, name) for pid, name in leads.items() if str(pid) not in cache]

    batch = pending[:BATCH_SIZE]
    print(f'{len(leads)} unique lead actors found across all enriched titles, '
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
            'fetchedAt': time.strftime('%Y-%m-%d'),
        }
        bday = cache[str(pid)]['birthday'] or '—'
        print(f'  [{i}/{len(batch)}] ok (born {bday}) | {name}')
        if i % 25 == 0:
            json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
        time.sleep(DELAY)

    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    if batch and failures == len(batch):
        print('ERROR: every person in this batch failed — treat as a real failure, not a quiet success.',
              file=sys.stderr)
        sys.exit(1)

    with_bday = sum(1 for v in cache.values() if v.get('birthday'))
    print(f'done: {len(cache)} people cached, {with_bday} with a real birthday')


if __name__ == '__main__':
    main()
