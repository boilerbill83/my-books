#!/usr/bin/env python3
"""
Texts Bill a weekly summary of what changed on The Streaming Top 10 —
Bill's own request (2026-09-26): "what if we setup a text alert when the
page has been refreshed that summarizes the changes? Tuesdays at noon."

Reuses the exact Twilio setup already proven working for
trakt/notify_watchlist.py (same 4 repo secrets, same send_sms() shape,
same real-error-surfacing/credential-shape-diagnostic/TEST_SEND
discipline) — no new account or credentials needed.

Runs the day after the weekly refresh (trakt-refresh-streaming-top10.yml,
Mondays 1 PM UTC), same "give the pipeline a buffer to fully land and
enrich before texting about it" reasoning notify_watchlist.py's own
after-enrichment scheduling already established — Tuesday noon Eastern
gives the Monday refresh, its TMDB enrichment, and poster caching a full
day to settle first.

Diffs trakt/data/streamingTop10.json (this week) against
trakt/data/streamingTop10Previous.json (a snapshot refresh_streaming_
top10.py writes of the prior week's file right before overwriting it —
so this script never has to parse git history to know what changed) over
the FULL real researched pool (POOL_SIZE shows, not just the 10 the page
displays), matched by title: new entries, dropped entries, rank movement
among shows present both weeks, and tag-tier changes (e.g. RISING->HOT).

Dedup: trakt/data/streamingTop10NotifyState.json (lastNotifiedWeekOf) so
a manual re-dispatch in the same week — or the scheduled job somehow
firing twice — can't double-text; only a genuinely new weekOf value
sends. FORCE_SEND=1 (or --force) overrides this for testing.

Run manually:   python3 trakt/notify_streaming_top10.py [--dry-run] [--force]
GitHub Action:  .github/workflows/trakt-notify-streaming-top10.yml

TEST_SEND=1 (or --test-send) sends one fixed real test text via Twilio,
skipping the real diff entirely — same purpose as notify_watchlist.py's
identical flag: confirming credentials/toll-free-verification work on a
day with nothing real to report. Never writes to the notify state file.
"""

import base64, json, os, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
CURRENT_FILE = DATA_DIR / 'streamingTop10.json'
PREV_FILE = DATA_DIR / 'streamingTop10Previous.json'
ENRICHED_FILE = DATA_DIR / 'enrichedMetadata.json'
STATE_FILE = DATA_DIR / 'streamingTop10NotifyState.json'

ACCOUNT_SID = os.environ.get('TWILIO_ACCOUNT_SID', '')
AUTH_TOKEN = os.environ.get('TWILIO_AUTH_TOKEN', '')
FROM_NUMBER = os.environ.get('TWILIO_FROM_NUMBER', '')
TO_NUMBER = os.environ.get('TWILIO_TO_NUMBER', '')
DRY_RUN = os.environ.get('DRY_RUN') == '1' or '--dry-run' in sys.argv
TEST_SEND = os.environ.get('TEST_SEND') == '1' or '--test-send' in sys.argv
FORCE_SEND = os.environ.get('FORCE_SEND') == '1' or '--force' in sys.argv

TWILIO_URL = 'https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json'
TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500'

# How many items to list per category before summarizing the rest as
# "+N more" — keeps a busy week's text readable rather than a wall of
# titles; a quiet week just lists everything since it'll be short anyway.
MAX_LISTED = 5
# Only call out a rank move as noteworthy at this magnitude or more —
# a 1-slot shuffle inside a 15-show researched pool is noise, not signal.
MIN_RANK_MOVE = 2


def send_sms(body, media_url=None):
    """POSTs to Twilio's Messages API. Returns (ok, info) — identical
    shape/behavior to notify_watchlist.py's send_sms()."""
    if DRY_RUN:
        print(f'  [DRY RUN] would send: {body!r}' + (f' (with image: {media_url})' if media_url else ''))
        return True, 'dry-run'
    url = TWILIO_URL.format(sid=ACCOUNT_SID)
    fields = {'To': TO_NUMBER, 'From': FROM_NUMBER, 'Body': body}
    if media_url:
        fields['MediaUrl'] = media_url
    data = urllib.parse.urlencode(fields).encode()
    creds = base64.b64encode(f'{ACCOUNT_SID}:{AUTH_TOKEN}'.encode()).decode()
    req = urllib.request.Request(url, data=data, headers={'Authorization': f'Basic {creds}'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            return True, result.get('sid')
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode('utf-8', errors='replace'))
            msg = f"Twilio error {err.get('code')}: {err.get('message')}"
        except Exception:
            msg = f'HTTP {e.code}'
        return False, msg
    except Exception as e:
        return False, str(e)


def poster_url_for(title_key, enriched):
    path = (enriched.get(title_key) or {}).get('posterPath') if title_key else None
    return f'{TMDB_IMAGE_BASE}{path}' if path else None


def summarize_list(titles):
    if len(titles) <= MAX_LISTED:
        return ', '.join(titles)
    return ', '.join(titles[:MAX_LISTED]) + f', +{len(titles) - MAX_LISTED} more'


def build_diff(current_shows, prev_shows):
    """Pure function of two shows lists (each a list of dicts with
    title/rank/tag) -> a diff summary. No I/O, so it's directly
    unit-testable against synthetic weeks."""
    cur_by_title = {s['title']: s for s in current_shows}
    prev_by_title = {s['title']: s for s in prev_shows}

    new_titles = [s['title'] for s in current_shows if s['title'] not in prev_by_title]
    dropped_titles = [s['title'] for s in prev_shows if s['title'] not in cur_by_title]

    movers = []
    tag_changes = []
    for title, cur in cur_by_title.items():
        prev = prev_by_title.get(title)
        if not prev:
            continue
        delta = prev['rank'] - cur['rank']  # positive = moved up (toward #1)
        if abs(delta) >= MIN_RANK_MOVE:
            movers.append((title, prev['rank'], cur['rank'], delta))
        if prev.get('tag') != cur.get('tag'):
            tag_changes.append((title, prev.get('tag'), cur.get('tag')))
    movers.sort(key=lambda m: -abs(m[3]))

    return {
        'new': new_titles,
        'dropped': dropped_titles,
        'movers': movers,
        'tagChanges': tag_changes,
    }


def compose_message(week_of, diff, first_run):
    if first_run:
        return f'\U0001F4FA Streaming Top 10 change alerts are now live — tracking starts with this week ({week_of}).'

    has_changes = diff['new'] or diff['dropped'] or diff['movers'] or diff['tagChanges']
    if not has_changes:
        return f'\U0001F4FA Streaming Top 10 (week of {week_of}): no real changes from last week.'

    lines = [f'\U0001F4FA Streaming Top 10 updates (week of {week_of}):']
    if diff['new']:
        lines.append(f"NEW: {summarize_list(diff['new'])}")
    if diff['dropped']:
        lines.append(f"OUT: {summarize_list(diff['dropped'])}")
    if diff['movers']:
        mover_bits = [
            f"{title} #{prev_rank}→#{cur_rank}"
            for title, prev_rank, cur_rank, _delta in diff['movers'][:3]
        ]
        lines.append('MOVED: ' + ', '.join(mover_bits))
    if diff['tagChanges']:
        tag_bits = [f'{title} {old}→{new}' for title, old, new in diff['tagChanges'][:3]]
        lines.append('TAG: ' + ', '.join(tag_bits))
    return '\n'.join(lines)


def main():
    missing = [name for name, val in [
        ('TWILIO_ACCOUNT_SID', ACCOUNT_SID), ('TWILIO_AUTH_TOKEN', AUTH_TOKEN),
        ('TWILIO_FROM_NUMBER', FROM_NUMBER), ('TWILIO_TO_NUMBER', TO_NUMBER),
    ] if not val]
    if missing and not DRY_RUN:
        print(f'ERROR: missing {", ".join(missing)}. Set as repo secrets (or env vars for a local '
              'run) — see trakt/notify_streaming_top10.py\'s docstring.', file=sys.stderr)
        sys.exit(1)

    if TEST_SEND:
        body = '✅ Test text from trakt/notify_streaming_top10.py — Twilio setup is working.'
        ok, info = send_sms(body)
        if not ok:
            print(f'ERROR: test send failed: {info}', file=sys.stderr)
            sys.exit(1)
        print(f'Test text sent OK ({info}).')
        return

    if not CURRENT_FILE.exists():
        sys.exit(f'ERROR: {CURRENT_FILE} does not exist — has refresh_streaming_top10.py ever run?')

    current = json.load(open(CURRENT_FILE))
    week_of = current.get('weekOf', 'unknown')
    current_shows = current.get('shows', [])

    state = json.load(open(STATE_FILE)) if STATE_FILE.exists() else {}
    if not FORCE_SEND and state.get('lastNotifiedWeekOf') == week_of:
        print(f'Already notified for week of {week_of} — nothing to send. (Use --force to resend.)')
        return

    first_run = not PREV_FILE.exists()
    prev_shows = json.load(open(PREV_FILE)).get('shows', []) if not first_run else []
    diff = build_diff(current_shows, prev_shows)
    message = compose_message(week_of, diff, first_run)

    enriched = json.load(open(ENRICHED_FILE)) if ENRICHED_FILE.exists() else {}
    top_show = current_shows[0] if current_shows else None
    poster = poster_url_for(top_show.get('titleKey'), enriched) if top_show else None

    ok, info = send_sms(message, media_url=poster)
    if ok:
        print(f'Sent ({info}): {message!r}')
        if not DRY_RUN:
            state['lastNotifiedWeekOf'] = week_of
            json.dump(state, open(STATE_FILE, 'w'), indent=1)
    else:
        print(f'ERROR: send failed: {info}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
