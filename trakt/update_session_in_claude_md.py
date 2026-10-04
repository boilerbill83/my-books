#!/usr/bin/env python3
"""
Part of the "SELF-EXTENDING SESSION" mechanism documented in
fetch_trakt_export.py's own docstring (added Oct 2026). Compares the
session `trakt/fetch_trakt_export.py` captured AFTER a successful,
authenticated page visit (/tmp/trakt-session-refreshed.json) against
the one already embedded in CLAUDE.md, and only overwrites CLAUDE.md's
copy when the refreshed one's embedded token genuinely expires later -
never on a bare "it ran," since whether trakt.tv's frontend actually
rotates the token within one short automated visit was unverified when
this was built (the real production runs are the actual test).

Adds zero new API calls - this only reads back a file
fetch_trakt_export.py already wrote from the SAME already-approved
browser visit's own final cookies/localStorage, same mechanism that
already feeds the session in.

Exits 0 either way (missing refreshed-session file, or a refreshed
session that isn't actually later) - this step is a bonus on top of a
successful run, never something that should fail the workflow.

Usage: python3 trakt/update_session_in_claude_md.py
    (reads /tmp/trakt-session-refreshed.json, rewrites CLAUDE.md in place)
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REFRESHED_PATH = Path('/tmp/trakt-session-refreshed.json')
CLAUDE_MD_PATH = Path(__file__).resolve().parent.parent / 'CLAUDE.md'

# Matches the whole "Current stored session (...)...Captured <date>; ...
# expires ... **<ts>**. ... replace the block below in the same commit:"
# paragraph plus the fenced ```json ... ``` block that follows it.
BLOCK_RE = re.compile(
    r'(\*\*Current stored session\*\*.*?replace the block below in the same commit:\n\n)'
    r'```json\n\{"cookies".*?\}\n```',
    re.DOTALL,
)


def oidc_user_entry(storage_state):
    for origin in storage_state.get('origins', []):
        if origin.get('origin') != 'https://app.trakt.tv':
            continue
        for item in origin.get('localStorage', []):
            if item.get('name', '').startswith('oidc.user:'):
                return json.loads(item['value'])
    return None


def main():
    if not REFRESHED_PATH.exists():
        print('No refreshed session captured this run (fetch_trakt_export.py '
              "didn't write one, likely because the run failed before "
              'reaching the capture point) - nothing to compare, leaving '
              'CLAUDE.md as-is.')
        return 0

    try:
        refreshed = json.loads(REFRESHED_PATH.read_text())
    except json.JSONDecodeError as e:
        print(f'WARNING: {REFRESHED_PATH} is not valid JSON ({e}) - skipping, '
              'leaving CLAUDE.md as-is.', file=sys.stderr)
        return 0

    refreshed_oidc = oidc_user_entry(refreshed)
    if not refreshed_oidc or 'expires_at' not in refreshed_oidc:
        print('WARNING: refreshed session has no readable oidc.user expires_at - '
              'skipping, leaving CLAUDE.md as-is.', file=sys.stderr)
        return 0
    refreshed_exp = refreshed_oidc['expires_at']

    claude_md = CLAUDE_MD_PATH.read_text()
    m = BLOCK_RE.search(claude_md)
    if not m:
        print('WARNING: could not find the "Current stored session" block in '
              'CLAUDE.md to compare against - skipping (has the surrounding '
              'text changed? the regex may need updating).', file=sys.stderr)
        return 0

    current_block_text = m.group(0)
    current_json_match = re.search(r'```json\n(\{"cookies".*?\})\n```', current_block_text, re.DOTALL)
    current_exp = None
    if current_json_match:
        try:
            current_state = json.loads(current_json_match.group(1))
            current_oidc = oidc_user_entry(current_state)
            if current_oidc:
                current_exp = current_oidc.get('expires_at')
        except json.JSONDecodeError:
            pass

    if current_exp is not None and refreshed_exp <= current_exp:
        print(f'Refreshed session expires_at={refreshed_exp} is not later than the '
              f'currently-stored one (expires_at={current_exp}) - trakt.tv did not '
              'silently rotate the token during this run, or rotated it to an '
              'earlier/equal value. Leaving CLAUDE.md as-is (expected outcome if '
              "a single short automated visit isn't enough to trigger a real "
              'refresh - not an error).')
        return 0

    expiry_dt = datetime.fromtimestamp(refreshed_exp, tz=timezone.utc)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    new_json_line = json.dumps(refreshed, separators=(', ', ': '))
    new_block = (
        m.group(1) +
        f'```json\n{new_json_line}\n```'
    ).replace(
        # Swap in the fresh capture date + expiry inside group(1) itself -
        # group(1) is the prose paragraph, which embeds the old date/exp.
        '', ''
    )
    # group(1) contains the old "Captured <date>...expires...**<ts>**" text -
    # rebuild it fresh rather than trying to regex-patch the old dates out.
    new_prose = (
        '**Current stored session** (Trakt-only — the Google/YouTube cookies from the same DevTools '
        'copy are never included here, per the Authentication note above). Captured ' + today +
        ' — self-extended by `trakt/fetch_trakt_export.py`/`update_session_in_claude_md.py` from a '
        'real authenticated page visit, not a fresh manual DevTools paste (see the '
        '"SELF-EXTENDING SESSION" note in `fetch_trakt_export.py`\'s own docstring). The embedded '
        'token `exp`/`expires_at` is `' + str(refreshed_exp) + '` (Unix seconds) — **' +
        expiry_dt.isoformat().replace('+00:00', 'Z') + '**. When this has expired, ask Bill for a '
        'fresh cookie + `oidc.user:...` localStorage paste (same two-part capture as always) and '
        'replace the block below in the same commit:\n\n'
    )
    new_block = new_prose + f'```json\n{new_json_line}\n```'

    CLAUDE_MD_PATH.write_text(claude_md[:m.start()] + new_block + claude_md[m.end():])
    print(f'CLAUDE.md session block self-extended: old expires_at={current_exp}, '
          f'new expires_at={refreshed_exp} ({expiry_dt.isoformat()}). trakt.tv really did '
          'rotate the token during this run - confirmed, not assumed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
