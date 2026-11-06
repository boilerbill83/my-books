#!/usr/bin/env python3
"""
Texts Bill (Twilio MMS) when he finishes a show: "Congrats on finishing a
show", the show's cover image, and three interesting facts about the season
he just finished.

Queue: trakt/data/finishedShowAlerts.json, filled by
trakt/scripts/detect_finished_shows.js. An alert is sent only once it holds
exactly three facts, a non-empty `nextSeason` line (when the next season is expected, speculation allowed and labelled as such) and has no sentAt. The facts are written by a Claude
Code session with WebSearch (CLAUDE.md's no-API-credits policy rules out a
billed API call here), so a finish detected by the export refresh is texted
after the next session fills its facts in.

Reuses send_sms()/poster_url() and the four Twilio secrets from
notify_watchlist.py. Run: python3 trakt/notify_finished_shows.py [--dry-run]
"""
import json, os, sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import notify_watchlist as nw

ALERTS = nw.DATA_DIR / 'finishedShowAlerts.json'


def main():
    missing = [n for n, v in [('TWILIO_ACCOUNT_SID', nw.ACCOUNT_SID), ('TWILIO_AUTH_TOKEN', nw.AUTH_TOKEN),
               ('TWILIO_FROM_NUMBER', nw.FROM_NUMBER), ('TWILIO_TO_NUMBER', nw.TO_NUMBER)] if not v]
    if missing and not nw.DRY_RUN:
        print(f'ERROR: missing {", ".join(missing)}', file=sys.stderr)
        sys.exit(1)
    if not ALERTS.exists():
        print('No finishedShowAlerts.json yet.')
        return
    data = json.loads(ALERTS.read_text())
    meta = json.loads((nw.DATA_DIR / 'enrichedMetadata.json').read_text())
    sent = waiting = 0
    for a in data.get('alerts', []):
        if a.get('sentAt'):
            continue
        facts = a.get('facts') or []
        nxt = (a.get('nextSeason') or '').strip()
        if len(facts) != 3 or not nxt:
            waiting += 1
            print(f"  waiting on facts/nextSeason: {a['title']} (season {a.get('season')})")
            continue
        season = f" season {a['season']}" if a.get('season') else ''
        body = f"Congrats on finishing {a['title']}{season}!\n\n" + '\n'.join(f'{i}. {f}' for i, f in enumerate(facts, 1))
        body += f"\n\nNext season: {nxt}"
        ok, info = nw.send_sms(body, nw.poster_url(meta.get(a['titleKey'])))
        print(f"  {'sent' if ok else 'FAILED'}: {a['title']} -> {info}")
        if ok and not nw.DRY_RUN:
            a['sentAt'] = date.today().isoformat()
            sent += 1
    if sent:
        ALERTS.write_text(json.dumps(data, indent=1) + '\n')
    print(f'Finished-show alerts: {sent} sent, {waiting} waiting on facts.')


if __name__ == '__main__':
    main()
