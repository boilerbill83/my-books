#!/usr/bin/env python3
"""
Builds the real Trakt-import CSV for the "rated" bucket of the Opportunity #1
old-title review (library-recency-selection-bias finding) - the actual
deliverable this whole exercise exists to produce: real old-title ratings,
on Bill's real 1-10 Trakt scale, to hand back through Trakt's own importer so
a future export brings them into library.json with genuine myRating data.

Requires trakt/data/enrichedMetadata.json to already carry a real imdbId for
every "rated" titleKey - i.e. trakt-enrich-tmdb.yml must have already run
against the candidatePool.json stubs process_old_title_ratings.py added
(source: old-title-review). Run that workflow first if this reports gaps.

Uses the exact Trakt-import CSV schema verified working against Trakt's real
importer (see CLAUDE.md's Movie Tracking section, Session 42-43):
  imdb_id,type,watched_at,watchlisted_at,rating,rated_at
  - imdb_id: bare IMDb id, NO prefix (e.g. tt1160419) - the column NAME
    identifies the service, the value itself carries no prefix.
  - watched_at / rated_at: full ISO 8601 datetimes (a bare date is rejected).
  - watchlisted_at: column present, left empty (these aren't watchlist adds).

Per Bill's explicit standing ruling: "No rated at timestamps mean nothing.
I just started using Trakt this year. For the purposes of this app, assume
I watched everything on the release date" - watched_at is set to each
title's real release year (from the reconciled data), Jan 1 as the day/month
placeholder since only the year is known for these older catalog titles.
rated_at is today (the real date Bill actually gave the rating).

Run: python3 trakt/build_old_title_trakt_import.py
"""

import csv
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
OUTPUT_DIR = ROOT / 'trakt' / 'output'


def read_json(p):
    return json.load(open(p))


def main():
    reconciled = read_json(OUTPUT_DIR / 'old-title-reconciled-ratings.json')
    cache = read_json(DATA_DIR / 'enrichedMetadata.json')

    rated = [e for e in reconciled if e['bucket'] == 'rated']
    today = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    rows = []
    missing = []
    for e in rated:
        meta = cache.get(e['titleKey'])
        imdb_id = meta.get('imdbId') if meta else None
        if not imdb_id:
            missing.append(f"{e['title']} ({e['year']}) - {e['titleKey']}")
            continue
        year = e['year'] or 2000
        rows.append({
            'imdb_id': imdb_id,
            'type': 'movie' if e['type'] == 'movie' else 'show',
            'watched_at': f'{year}-01-01T00:00:00Z',
            'watchlisted_at': '',
            'rating': e['rawRating'],
            'rated_at': today,
        })

    out_path = OUTPUT_DIR / 'old-title-trakt-import.csv'
    with open(out_path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['imdb_id', 'type', 'watched_at', 'watchlisted_at', 'rating', 'rated_at'])
        w.writeheader()
        for r in rows:
            w.writerow(r)

    print(f'{len(rows)} of {len(rated)} rated titles resolved a real imdbId and were written to {out_path}.')
    if missing:
        print(f'\n{len(missing)} titles still missing an imdbId (enrichment not yet run, or a real TMDB external_ids gap):')
        for m in missing:
            print(f'  - {m}')
        print('\nRe-run trakt-enrich-tmdb.yml (or a REFRESH_ALL pass) and re-run this script once they resolve.')


if __name__ == '__main__':
    main()
