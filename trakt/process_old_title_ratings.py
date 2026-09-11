#!/usr/bin/env python3
"""
Processes trakt/output/old-title-reconciled-ratings.json (Opportunity #1,
library-recency-selection-bias finding) into the real pipeline files.

Reconciliation already happened by hand this session (deduping the 12
cross-genre-duplicate titles via min-of-two-ratings per Bill's explicit
instruction, and reclassifying any rating of 1 - or the one 0, Dirty
Dancing - as "declined to watch" rather than real watched-and-disliked
data, per Bill's explicit "1 usually means I didnt want to see it").

This script does NOT call TMDB (no API key needed, runs locally) - it only
moves already-known titleKeys/tmdbIds into the real data files:

  - "not_interested" bucket (Bill never actually watched these; a low rating
    meant "I don't want to" not "I watched it and hated it") -> added as
    candidatePool.json stubs (for real TMDB enrichment/metadata) AND an
    immediate feedbackData.json dismiss entry with excludeFromRecommendations
    so they never surface as a recommendation while stub metadata is still
    filling in.

  - "rated" bucket (real ratings on Trakt's own 1-10 scale, Bill's honest
    reaction to titles he's actually seen) -> added as candidatePool.json
    stubs ONLY to get a real imdbId from enrich_tmdb.py's external_ids append
    (needed to build the Trakt-import CSV). These do NOT get a
    feedbackData.json exclusion - they are not dismissals, and once the CSV
    is uploaded through Trakt's own importer and a fresh export is pulled
    in, they'll land in library.json with real myRating data (the actual
    point of this whole exercise) and the standard "prune candidatePool of
    titles now in library" import step will clean up their stub naturally.

  - "blank" bucket (Bill gave no signal at all) -> skipped entirely, no data
    fabricated either way.

Both buckets are added to candidatePool.json/discoveredHistory.json so a
future discovery run can't re-surface them as "new" - the same
already-evaluated-once guarantee every other discovery source in this
pipeline relies on.

Run: python3 trakt/process_old_title_ratings.py
"""

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
OUTPUT_DIR = ROOT / 'trakt' / 'output'
SOURCE = 'old-title-review'


def read_json(p, fallback):
    try:
        return json.load(open(p))
    except Exception:
        return fallback


def write_json(p, data):
    p.parent.mkdir(parents=True, exist_ok=True)
    open(p, 'w').write(json.dumps(data, indent=2) + '\n')


def main():
    reconciled = read_json(OUTPUT_DIR / 'old-title-reconciled-ratings.json', None)
    if reconciled is None:
        raise SystemExit('trakt/output/old-title-reconciled-ratings.json not found.')

    pool = read_json(DATA_DIR / 'candidatePool.json', {'meta': {}, 'titles': []})
    history = read_json(DATA_DIR / 'discoveredHistory.json', {'titleKeys': []})
    feedback = read_json(DATA_DIR / 'feedbackData.json', {'interactions': []})

    pool_keys = {t['titleKey'] for t in pool['titles'] if t.get('titleKey')}
    history_keys = set(history.get('titleKeys', []))
    feedback_keys = {e['titleKey'] for e in feedback.get('interactions', []) if e.get('titleKey')}

    added_pool = 0
    added_history = 0
    added_dismiss = 0
    skipped_already_known = 0
    now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    for e in reconciled:
        if e['bucket'] == 'blank':
            continue
        title_key = e['titleKey']

        if title_key not in pool_keys:
            pool['titles'].append({
                'type': e['type'],
                'titleKey': title_key,
                'ids': {'tmdb': e['tmdbId']},
                'title': e['title'],
                'year': e['year'],
                'source': SOURCE,
            })
            pool_keys.add(title_key)
            added_pool += 1
        else:
            skipped_already_known += 1

        if title_key not in history_keys:
            history['titleKeys'].append(title_key)
            history_keys.add(title_key)
            added_history += 1

        if e['bucket'] == 'not_interested' and title_key not in feedback_keys:
            feedback['interactions'].append({
                'titleKey': title_key,
                'title': e['title'],
                'year': e['year'],
                'type': e['type'],
                'interactionType': 'dismiss',
                'reasonCode': 'declined_old_title_review',
                'reasonLabel': (
                    "Not real watched-and-disliked Trakt data - part of the Opportunity #1 "
                    "(library-recency-selection-bias) old-title review batch: Bill rated this "
                    f"exactly {e['rawRating']} on the review spreadsheet's 1-10 scale, which he "
                    "explicitly clarified means \"I didn't want to see it\" (a declined-interest "
                    "signal), not a real watch-and-dislike event. Excluded from recommendations "
                    "so it never resurfaces as a \"new pick\"; kept as an exact-title exclusion "
                    "only, not generalized into dismissAdjust()'s style-dislike profile without "
                    "a real eval.js-validated sweep first."
                ),
                'timestamp': now_iso,
                'excludeFromRecommendations': True,
            })
            feedback_keys.add(title_key)
            added_dismiss += 1

    pool['meta']['generatedAt'] = now_iso
    pool['meta']['count'] = len(pool['titles'])

    write_json(DATA_DIR / 'candidatePool.json', pool)
    write_json(DATA_DIR / 'discoveredHistory.json', history)
    write_json(DATA_DIR / 'feedbackData.json', feedback)

    rated_count = sum(1 for e in reconciled if e['bucket'] == 'rated')
    ni_count = sum(1 for e in reconciled if e['bucket'] == 'not_interested')
    print(f'{added_pool} new candidatePool.json stubs added ({rated_count} rated, {ni_count} not_interested).')
    print(f'{added_history} new discoveredHistory.json entries added.')
    print(f'{added_dismiss} new feedbackData.json dismiss entries added (not_interested only).')
    if skipped_already_known:
        print(f'{skipped_already_known} titleKeys were already in candidatePool.json, skipped re-adding.')
    print('\nNext step: trigger trakt-enrich-tmdb.yml to backfill genres/overview/imdbId for the new stubs,')
    print('then build the Trakt-import CSV for the "rated" bucket from the real, enriched imdbId values.')


if __name__ == '__main__':
    main()
