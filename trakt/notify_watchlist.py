#!/usr/bin/env python3
"""
Texts Bill via Twilio when a show on his real Trakt watchlist hits one
of 3 real, date-based events:

  1. Season premiere — the next episode is episode 1, airing today
  2. 2 days before a season finale
  3. The day after a season finale

Bill's own explicit request (2026-09-12): "create a text notification
when a show on my watchlist hits one of these conditions: season
premiere, two days before a season finale and day after a season
finale; I have a twilio account we can use." Originally logged as a
scoped dashboard finding (trakt/quality.js's 'twilio-sms-watchlist-
alerts') before being built for real.

All 3 conditions are already computable from data this pipeline
collects daily — no new TMDB calls needed. nextEpisodeToAir (episode
1 airing today = premiere) and currentSeasonFinale.finaleDate (simple
date-diff for the other two) both live in enrichedMetadata.json,
populated by trakt/enrich_tmdb.py's season-endpoint call. Reads
watchlist.json + enrichedMetadata.json only (already committed, no new
fetch) — mirrors enrich_omdb.py's read-only-existing-data style.

Dedup: trakt/data/notificationState.json (titleKey -> {lastPremiereSent,
lastFinaleWarnSent, lastFinaleFollowupSent}, each a YYYY-MM-DD string)
so a condition true on exactly one real calendar day can't double-send
if the daily job ever runs twice, and can't re-send every day it
happens to still read true from a stale date-math edge case — a
condition only ever fires once the stored date differs from today's.

Needs 4 Twilio repo secrets Bill creates himself (same pattern as
TMDB_API_KEY/OMDB_API_KEY): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
TWILIO_FROM_NUMBER, and TWILIO_TO_NUMBER (his own destination number —
kept as a secret rather than hardcoded, since this repo is public).
Both phone numbers in E.164 format (e.g. +15551234567).

A toll-free TWILIO_FROM_NUMBER needs Twilio's own one-time "Toll-Free
Verification" (a short form in the Twilio console, ~1-3 business days
to approve) before it can send SMS at all — until then every send
fails with Twilio error 30032, surfaced below with its own clear
message (send_sms() reads Twilio's real error JSON) rather than a bare
HTTP failure, so a pending-verification state reads as exactly that,
not a script bug.

Run manually:   python3 trakt/notify_watchlist.py [--dry-run]
GitHub Action:  .github/workflows/trakt-notify-watchlist.yml

TEST_SEND=1 (or --test-send) skips the real event-finding entirely and
sends one fixed test message instead — added specifically so the
Twilio credentials/toll-free-verification state can be confirmed for
real (a genuine send, not just a dry run) on a day with no actual
premiere/finale event to trigger one naturally. Never writes to
notificationState.json.
"""

import base64, json, os, sys, urllib.error, urllib.parse, urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
STATE_FILE = DATA_DIR / 'notificationState.json'

ACCOUNT_SID = os.environ.get('TWILIO_ACCOUNT_SID', '')
AUTH_TOKEN = os.environ.get('TWILIO_AUTH_TOKEN', '')
FROM_NUMBER = os.environ.get('TWILIO_FROM_NUMBER', '')
TO_NUMBER = os.environ.get('TWILIO_TO_NUMBER', '')
DRY_RUN = os.environ.get('DRY_RUN') == '1' or '--dry-run' in sys.argv
TEST_SEND = os.environ.get('TEST_SEND') == '1' or '--test-send' in sys.argv

TWILIO_URL = 'https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json'


def send_sms(body):
    """POSTs to Twilio's Messages API. Returns (ok, info) — info is the
    created message's sid on success, or a human-readable error: Twilio's
    own error code + message when it gives one (e.g. real error 30032
    'Toll-Free Number Not Verified/Registered'), not just a bare status
    code."""
    if DRY_RUN:
        print(f'  [DRY RUN] would send: {body!r}')
        return True, 'dry-run'
    url = TWILIO_URL.format(sid=ACCOUNT_SID)
    data = urllib.parse.urlencode({'To': TO_NUMBER, 'From': FROM_NUMBER, 'Body': body}).encode()
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


def load_watchlist_shows():
    enriched_path = DATA_DIR / 'enrichedMetadata.json'
    wl_path = DATA_DIR / 'watchlist.json'
    enriched = json.load(open(enriched_path)) if enriched_path.exists() else {}
    watchlist = json.load(open(wl_path)) if wl_path.exists() else {'titles': []}
    return [
        {**t, 'meta': enriched.get(t['titleKey'], {})}
        for t in watchlist.get('titles', [])
        if t.get('type') == 'show' and t.get('titleKey')
    ]


def find_events(shows, today, state):
    """Returns a list of (titleKey, stateKey, message) for every real,
    not-yet-sent event true today. Pure function of its inputs (no I/O,
    no sending) so it can be unit-tested directly against synthetic
    dates without a real Twilio account."""
    events = []
    for t in shows:
        title_key, title = t['titleKey'], t.get('title') or title_key
        meta = t.get('meta', {})
        s = state.get(title_key, {})

        next_ep = meta.get('nextEpisodeToAir')
        if next_ep and next_ep.get('episodeNumber') == 1 and next_ep.get('airDate') == today.isoformat():
            if s.get('lastPremiereSent') != today.isoformat():
                events.append((title_key, 'lastPremiereSent',
                                f'\U0001F4FA {title} premieres tonight! Season {next_ep.get("seasonNumber")} is here.'))

        finale = meta.get('currentSeasonFinale')
        finale_date_str = finale.get('finaleDate') if finale else None
        if finale_date_str:
            try:
                finale_date = date.fromisoformat(finale_date_str)
            except ValueError:
                finale_date = None
            if finale_date == today + timedelta(days=2):
                if s.get('lastFinaleWarnSent') != today.isoformat():
                    events.append((title_key, 'lastFinaleWarnSent',
                                    f'⏳ {title}\'s season {finale.get("seasonNumber")} finale airs in 2 days '
                                    f'({finale_date_str}).'))
            if finale_date == today - timedelta(days=1):
                if s.get('lastFinaleFollowupSent') != today.isoformat():
                    events.append((title_key, 'lastFinaleFollowupSent',
                                    f'✅ {title}\'s season {finale.get("seasonNumber")} finale aired yesterday '
                                    f'— it\'s all out now.'))
    return events


def main():
    missing = [name for name, val in [
        ('TWILIO_ACCOUNT_SID', ACCOUNT_SID), ('TWILIO_AUTH_TOKEN', AUTH_TOKEN),
        ('TWILIO_FROM_NUMBER', FROM_NUMBER), ('TWILIO_TO_NUMBER', TO_NUMBER),
    ] if not val]
    if missing and not DRY_RUN:
        print(f'ERROR: missing {", ".join(missing)}. Set as repo secrets (or env vars for a local '
              'run) — see trakt/notify_watchlist.py\'s docstring.', file=sys.stderr)
        sys.exit(1)

    # Safe shape diagnostics — never print the actual secret values, only
    # their length/prefix, so a wrong-format credential (a stray trailing
    # newline from a copy-paste, an API Key SID instead of an Account SID,
    # etc.) is visible in the job log without ever exposing anything
    # sensitive. Added after 3 consecutive real TEST_SEND runs all failed
    # with the identical "Twilio error 20003: Authenticate" despite Bill
    # re-verifying/re-saving all 4 secrets fresh each time.
    if not DRY_RUN:
        print(f'Credential shape check (values never printed): '
              f'ACCOUNT_SID len={len(ACCOUNT_SID)} prefix={ACCOUNT_SID[:2]!r} '
              f'(want len=34, prefix=\'AC\'); '
              f'AUTH_TOKEN len={len(AUTH_TOKEN)} (want len=32); '
              f'FROM_NUMBER len={len(FROM_NUMBER)} starts_plus={FROM_NUMBER.startswith("+")}; '
              f'TO_NUMBER len={len(TO_NUMBER)} starts_plus={TO_NUMBER.startswith("+")}')

    if TEST_SEND:
        ok, info = send_sms('✅ Test text from trakt/notify_watchlist.py — Twilio setup is working.')
        if not ok:
            print(f'ERROR: test send failed: {info}', file=sys.stderr)
            sys.exit(1)
        print(f'Test text sent OK ({info}).')
        return

    today = date.today()
    state = json.load(open(STATE_FILE)) if STATE_FILE.exists() else {}
    shows = load_watchlist_shows()
    print(f'{len(shows)} shows on the watchlist')

    events = find_events(shows, today, state)
    print(f'{len(events)} real event(s) to send today')

    sent, failed = 0, 0
    for title_key, state_key, message in events:
        ok, info = send_sms(message)
        if ok:
            sent += 1
            state.setdefault(title_key, {})[state_key] = today.isoformat()
            print(f'  sent ({info}): {message}')
        else:
            failed += 1
            print(f'  FAILED ({info}): {message}', file=sys.stderr)

    json.dump(state, open(STATE_FILE, 'w'), indent=1)

    if events and failed == len(events):
        print('ERROR: every text failed to send — treat as a real failure, not a quiet success.',
              file=sys.stderr)
        sys.exit(1)

    print(f'done: {sent} sent, {failed} failed')


if __name__ == '__main__':
    main()
