#!/usr/bin/env python3
"""
Automates the one manual step Bill used to repeat by hand every time he
wanted to refresh BMTRE's data: Settings -> Data -> "Export Now" on
trakt.tv, then a 60-120 second wait for the zip to download (his own
exact description of the flow, confirmed 2026-10-01).

This does NOT call the Trakt API - that's still the standing rule this
whole project follows (see CLAUDE.md's "Trakt API is never called"
section). It drives a real browser through the real website, the same
as if Bill clicked through it himself, just automated.

AUTHENTICATION - deliberately does not store a password anywhere, since
Bill logs in via "Continue with Google" and there's no separate Trakt
password to store in the first place. Instead this loads a saved
Playwright storageState (cookies from an already-authenticated session)
from the TRAKT_SESSION secret. That session was captured once, manually,
from Bill's own real login - see CLAUDE.md's "Automated Trakt Export"
section for how it's captured and refreshed when it eventually expires.
A session is lower-stakes than a password: it only grants whatever
trakt.tv itself already allows a logged-in session to do, can't be used
to change the Google account password, and can be revoked independently
by logging out of that session on trakt.tv.

Usage:
    TRAKT_SESSION='<storageState JSON>' python3 trakt/fetch_trakt_export.py [output_path]

output_path defaults to /tmp/trakt-export-raw.zip - deliberately outside
the repo working directory, since the raw export itself is never
committed (CLAUDE.md: "the ~5.6MB/89-file export itself is never
committed" - only the derived, built files are).

On any failure (expired session, site changed, selector didn't match)
this saves a screenshot + the page's visible text to /tmp/trakt-export-
debug.png / .txt before exiting non-zero, so a failed run leaves
something to diagnose from rather than just "it didn't work" - same
discipline scrape_show_ratings.py's own debug output follows.
"""

import json
import os
import sys
from pathlib import Path


def main():
    output_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/trakt-export-raw.zip')

    session_json = os.environ.get('TRAKT_SESSION')
    if not session_json:
        print('ERROR: TRAKT_SESSION is not set. This needs a saved Playwright storageState '
              '(captured once from a real logged-in session) - see CLAUDE.md\'s "Automated '
              'Trakt Export" section.', file=sys.stderr)
        sys.exit(1)

    try:
        storage_state = json.loads(session_json)
    except json.JSONDecodeError as e:
        print(f'ERROR: TRAKT_SESSION is not valid JSON: {e}', file=sys.stderr)
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('ERROR: playwright not installed. Run: pip install playwright && '
              'playwright install chromium --with-deps', file=sys.stderr)
        sys.exit(1)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        )
        ctx = browser.new_context(
            storage_state=storage_state,
            user_agent=('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
            viewport={'width': 1280, 'height': 900},
            locale='en-US',
            accept_downloads=True,
        )
        page = ctx.new_page()

        try:
            # app.trakt.tv, not bare trakt.tv - confirmed via Bill's real
            # captured session cookies (2026-10-01): the actual auth
            # cookie (trakt-oidc-auth) is host-scoped to app.trakt.tv, not
            # .trakt.tv, matching the platform migration CLAUDE.md already
            # documents (trakt.tv -> app.trakt.tv, March-April 2026).
            page.goto('https://app.trakt.tv/settings/data', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_timeout(2000)

            # Real login-expiry check before trying to click anything - a
            # stale/expired session redirects to trakt.tv's login page
            # (URL contains /auth/signin or /login depending on Trakt's
            # own routing), and clicking blind at that point would just
            # fail confusingly on a page with no "Export Now" button at
            # all. Fail loud and specific instead.
            current_url = page.url
            if 'signin' in current_url or '/login' in current_url or 'auth' in current_url:
                print(f'ERROR: redirected to {current_url} - the saved session has likely '
                      'expired. Bill needs to redo the one-time login capture and update the '
                      'TRAKT_SESSION secret (see CLAUDE.md).', file=sys.stderr)
                page.screenshot(path='/tmp/trakt-export-debug.png')
                sys.exit(1)

            # Real diagnostic (added after the first real run timed out
            # waiting for "Export Now" with no login redirect - meaning
            # the session was likely accepted, but something else was on
            # the page instead). Printed straight to stdout (the job log),
            # not just the screenshot artifact - the screenshot lives on
            # Azure Blob Storage behind a signed URL this project's own
            # interactive sandbox can't reach (confirmed: egress proxy
            # rejects it), while the job log is always directly readable.
            body_text = page.inner_text('body')[:1500]
            print(f'DIAGNOSTIC: landed on {current_url!r}, page title={page.title()!r}')
            print(f'DIAGNOSTIC: first 1500 chars of visible body text:\n{body_text}')

            # Text-based locator, not a CSS class/id guess - robust to
            # markup changes, matches Bill's own exact description of the
            # button's label ("Export Now").
            export_button = page.get_by_text('Export Now', exact=False).first
            export_button.wait_for(state='visible', timeout=15_000)

            print('Clicking "Export Now" - Bill\'s own description says this takes 60-120 '
                  'seconds before the file downloads automatically. Waiting up to 3 minutes.')

            with page.expect_download(timeout=180_000) as download_info:
                export_button.click()
            download = download_info.value
            download.save_as(str(output_path))

            size_kb = output_path.stat().st_size / 1024
            print(f'Downloaded {output_path} ({size_kb:.0f} KB)')

            if size_kb < 10:
                # A real export zip is several MB (CLAUDE.md documents
                # ~5.6MB/89 files) - a few KB almost certainly means an
                # error page or empty file got saved instead of the real
                # export, not a genuinely tiny account.
                print('WARNING: downloaded file is suspiciously small for a real Trakt export - '
                      'check it before trusting it.', file=sys.stderr)

        except Exception as e:
            print(f'ERROR: {e}', file=sys.stderr)
            try:
                page.screenshot(path='/tmp/trakt-export-debug.png')
                Path('/tmp/trakt-export-debug.txt').write_text(page.content())
                print('Saved /tmp/trakt-export-debug.png and .txt for diagnosis.', file=sys.stderr)
            except Exception:
                pass
            sys.exit(1)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
