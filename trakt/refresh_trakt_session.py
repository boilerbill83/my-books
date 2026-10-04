#!/usr/bin/env python3
"""
A narrow, Bill-approved exception to this project's standing "never call the
Trakt API" rule (CLAUDE.md), added Oct 2026. Scoped strictly to refreshing
the stored SESSION TOKEN this project already keeps in CLAUDE.md for
trakt-auto-refresh.yml - it does NOT fetch Bill's watch/rating/history data,
which still only ever comes from his own manually-uploaded export zip, per
the still-standing rule.

Why this exists: the "SELF-EXTENDING SESSION" mechanism in
fetch_trakt_export.py/update_session_in_claude_md.py is passive - it only
captures whatever trakt.tv's own frontend JS happened to silently refresh
during one short automated browser visit, which may or may not actually
trigger a real refresh (unverified as of that mechanism's own build).  Bill
was asked directly whether a real, deliberate API call for this one purpose
was acceptable given his stated constraint ("I just dont want to pay for
premium Trakt which is how I get API access"), and said: "I'm OK if you use
an API; I just dont want to pay for premium Trakt which is how I get API
access; if you can find another way, go for it." Real research (WebSearch,
not guessed) confirms this needs no Trakt VIP and no new paid app
registration:
  - Endpoint: POST https://auth.trakt.tv/oauth/token (Trakt's own docs:
    "use the https://auth.trakt.tv hostname for all OAuth requests ...
    not the API hostname").
  - Since Trakt's 2026-10-01 OAuth change, client_secret is optional/
    deprecated on every /oauth endpoint; a real trakt-android PR
    ("stop sending client_secret on token exchange and refresh",
    trakt/trakt-android#404) confirms omitting it entirely works even for
    an app that still technically has one on file.
  - This reuses Trakt's OWN public web-app client_id, already embedded (as
    the `aud` claim / the oidc.user:<authority>:<client_id> localStorage
    key's own suffix) in the session Bill already captured from his real,
    already-logged-in app.trakt.tv session - not a new app Claude registers.

KNOWN, ACCEPTED RESIDUAL RISK (documented here and in CLAUDE.md, not
hidden): a refresh_token is single-use - using it here invalidates whatever
copy Bill's own real browser tab may be holding, and vice versa. If Bill
has an actively open app.trakt.tv tab whose own JS (oidc-client-ts's
automaticSilentRenew) tries to silently refresh using ITS cached copy
around the same time this script runs, whichever side's copy is now stale
fails with an ordinary "please sign in again" - never data loss, never a
destructive action, just an occasional unexpected Trakt re-login for Bill
in his own browser. This mirrors the same category of risk he already
explicitly accepted for storing the session in CLAUDE.md at all ("I dont
care if someone tries to log in as me in Trakt; it's a free site").
Scheduled conservatively (every few days, not daily) specifically to keep
this collision window small, not to eliminate it (it can't be eliminated
without Bill never using trakt.tv in his own browser at all, which isn't
the goal here).

On any failure this logs the full response body (never just the bare HTTP
status) and exits non-zero, so a failed scheduled run surfaces via GitHub's
own UI rather than silently rotting - same "surface the real error, don't
guess" discipline enrich_tmdb.py/enrich_omdb.py already established for
this project. It never partially writes CLAUDE.md - either the whole
refresh succeeds and the whole block is rewritten with a verified-good
session, or nothing in CLAUDE.md changes at all.

Usage: python3 trakt/refresh_trakt_session.py
    (reads the current session straight out of CLAUDE.md, calls
    auth.trakt.tv directly, rewrites CLAUDE.md in place on success)

auth.trakt.tv is blocked from this project's interactive sandbox, same as
every other trakt.tv subdomain (CLAUDE.md's standing note) - this can only
really run via GitHub Actions. Unverified in production until the first
real scheduled/dispatched run actually completes - this docstring makes no
claim beyond "the research says this should work."
"""
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent.parent))
from trakt.update_session_in_claude_md import (  # noqa: E402
    CLAUDE_MD_PATH, oidc_user_entry, read_current_block, write_session_block,
)

TOKEN_URL = 'https://auth.trakt.tv/oauth/token'


def client_id_from_storage_state(storage_state):
    """The oidc.user localStorage KEY ITSELF is shaped
    oidc.user:<authority>:<client_id> - the client_id is the key's own last
    segment, so this needs no JWT decoding to recover."""
    for origin in storage_state.get('origins', []):
        if origin.get('origin') != 'https://app.trakt.tv':
            continue
        for item in origin.get('localStorage', []):
            name = item.get('name', '')
            if name.startswith('oidc.user:'):
                # "oidc.user:https://auth.trakt.tv:<client_id>" - split on
                # ':' would break the "https://" segment, so split only on
                # the LAST colon instead.
                return name.rsplit(':', 1)[-1]
    return None


def call_refresh(client_id, refresh_token):
    """POSTs the refresh_token grant to auth.trakt.tv. Returns the parsed
    JSON response dict on a 2xx, or raises urllib.error.HTTPError (with the
    real response body attached) on anything else - never silently
    swallows a non-2xx."""
    body = json.dumps({
        'client_id': client_id,
        'refresh_token': refresh_token,
        'grant_type': 'refresh_token',
        # client_secret deliberately omitted - confirmed optional/
        # deprecated per this file's own docstring research.
    }).encode('utf-8')
    req = urllib.request.Request(
        TOKEN_URL, data=body, method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode('utf-8'))


def build_refreshed_storage_state(old_state, client_id, token_response, now):
    """Returns a new storageState dict: same cookies/localStorage as
    `old_state` except the oidc.user entry (new access_token/refresh_token/
    id_token/expires_at) and the trakt-oidc-auth cookie's own embedded
    {token, expiresAt} value (note: that one is MILLISECONDS, confirmed
    against the real captured cookie value - a different unit than the
    oidc.user entry's `expires_at`, which is seconds)."""
    import copy
    new_state = copy.deepcopy(old_state)

    access_token = token_response['access_token']
    new_refresh_token = token_response.get('refresh_token')
    if not new_refresh_token:
        raise ValueError(
            'auth.trakt.tv did not return a new refresh_token - refusing to '
            'proceed, since using the old (now-invalidated, single-use) one '
            'again next time would fail. Response: ' + json.dumps(token_response)
        )
    expires_in = token_response.get('expires_in')
    if expires_in is not None:
        new_expires_at = int(now.timestamp()) + int(expires_in)
    elif token_response.get('created_at') and token_response.get('expires_in') is None:
        # Shouldn't normally happen - fall back to the id_token's own exp if
        # the response gives us a fresh id_token to read it from.
        new_expires_at = None
    else:
        new_expires_at = None

    new_id_token = token_response.get('id_token')

    for origin in new_state['origins']:
        if origin['origin'] != 'https://app.trakt.tv':
            continue
        for item in origin['localStorage']:
            if item['name'].startswith('oidc.user:'):
                oidc = json.loads(item['value'])
                oidc['access_token'] = access_token
                oidc['refresh_token'] = new_refresh_token
                if new_id_token:
                    oidc['id_token'] = new_id_token
                if new_expires_at is None:
                    # No expires_in from the response - derive from the new
                    # id_token's own exp claim if we got one, otherwise keep
                    # whatever was there (better than crashing; the
                    # strictly-later-expiry check elsewhere will just no-op
                    # if this doesn't actually move forward).
                    if new_id_token:
                        import base64
                        payload_b64 = new_id_token.split('.')[1]
                        padded = payload_b64 + '=' * (-len(payload_b64) % 4)
                        claims = json.loads(base64.urlsafe_b64decode(padded))
                        new_expires_at = claims.get('exp', oidc.get('expires_at'))
                    else:
                        new_expires_at = oidc.get('expires_at')
                oidc['expires_at'] = new_expires_at
                item['value'] = json.dumps(oidc)

    for cookie in new_state['cookies']:
        if cookie['name'] == 'trakt-oidc-auth':
            cookie['value'] = json.dumps({
                'token': access_token,
                'expiresAt': new_expires_at * 1000,
            })

    return new_state


def main():
    claude_md, m, current_state = read_current_block()
    if m is None or current_state is None:
        print('ERROR: could not read a valid "Current stored session" block '
              'from CLAUDE.md - nothing to refresh.', file=sys.stderr)
        return 1

    client_id = client_id_from_storage_state(current_state)
    oidc = oidc_user_entry(current_state)
    if not client_id or not oidc or 'refresh_token' not in oidc:
        print('ERROR: current stored session has no readable client_id/refresh_token '
              '- nothing to refresh.', file=sys.stderr)
        return 1

    print(f'Calling {TOKEN_URL} with client_id={client_id} to refresh the stored session...')
    try:
        token_response = call_refresh(client_id, oidc['refresh_token'])
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        print(f'ERROR: refresh call failed with HTTP {e.code}: {body}', file=sys.stderr)
        print('This usually means the stored refresh_token is already stale '
              '(e.g. Bill\'s own browser silently rotated it first) - a fresh '
              'DevTools capture from Bill is needed.', file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f'ERROR: could not reach {TOKEN_URL}: {e}', file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)
    try:
        new_state = build_refreshed_storage_state(current_state, client_id, token_response, now)
    except ValueError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 1

    new_oidc = oidc_user_entry(new_state)
    new_exp = new_oidc['expires_at']
    old_exp = oidc['expires_at']
    if new_exp <= old_exp:
        print(f'WARNING: refreshed session expires_at={new_exp} is not later than the '
              f'current one ({old_exp}) - unexpected, but not touching CLAUDE.md since '
              'this would move the stored session backward.', file=sys.stderr)
        return 1

    new_text = write_session_block(
        claude_md, m, new_state,
        'refreshed via a direct call to `trakt/refresh_trakt_session.py` against '
        'auth.trakt.tv\'s own `/oauth/token` refresh_token grant (Bill\'s explicit, '
        'informed go-ahead to use an API for this one purpose - see that script\'s '
        'own docstring for the full research and the accepted residual risk).',
    )
    CLAUDE_MD_PATH.write_text(new_text)
    print(f'CLAUDE.md session block refreshed via real API call: old expires_at={old_exp}, '
          f'new expires_at={new_exp} ({datetime.fromtimestamp(new_exp, tz=timezone.utc).isoformat()}).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
