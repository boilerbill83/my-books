#!/usr/bin/env python3
"""
Automates the one manual step BBIP has always needed a human for:
Goodreads's "Export Library" button (My Books -> Tools -> Import and
Export, or directly at goodreads.com/review/import), which generates a
CSV of Bill's full shelves. Mirrors trakt/fetch_trakt_export.py's design
exactly -- a real headless browser driven through the real site using a
saved login session, not an API call (Goodreads has no public API for
this kind of account-data export anyway, and even if it did, the
standing project discipline has always been "automate the real UI a
human would click through," same as the Trakt side).

WHY THIS IS NEEDED AT ALL (see CLAUDE.md's Session 81 for the full
investigation): Goodreads broke anonymous shelf access entirely on
2026-10-27 -- every RSS URL variant 404s, and even the plain anonymous
HTML shelf page now redirects to a sign-in wall. This session's own
sandbox confirmed goodreads.com is also network-blocked from an
interactive Claude Code session, so -- same as Trakt/TMDB/OMDb -- the
only place this can actually run is a GitHub Actions runner with real
network access, driven by a saved authenticated session.

AUTHENTICATION: loads a saved Playwright storageState JSON from the
GOODREADS_SESSION env var, captured once from Bill's own real logged-in
browser (DevTools -> Application -> Storage -> Cookies for
goodreads.com; Local Storage too if the first real run turns out to
need it, the same two-part lesson the Trakt side learned the hard way --
see CLAUDE.md's "Automated Goodreads Export" section for the current
capture instructions and whether localStorage ended up being needed
here or not).

GOODREADS' OWN REAL EXPORT MECHANICS (per Goodreads' own help page,
help.goodreads.com/s/article/000001596, and cross-referenced against
several independent guides -- never guessed): clicking "Export Library"
does NOT trigger an immediate browser download the way Trakt's "Export
Now" does. Instead the page shows a dated download LINK once the file
has finished generating server-side (seconds to a few minutes for a
library this size; guides differ on whether Goodreads also emails a
link, which this script doesn't rely on either way). This script
therefore polls the page for that link to appear rather than using a
single expect_download-on-click, and clicks the link itself once found
to trigger the actual download.

LOGIN-EXPIRY CHECK: grounded in this exact session's own real,
confirmed finding (not guessed) -- an unauthenticated request to any
Goodreads shelf/import page now returns a page titled "Sign in" with a
canonical link to goodreads.com/user/sign_in. Checking for that is a
precise, already-proven-real signal, the same discipline
fetch_trakt_export.py's own URL-based check used.

On any failure this saves a screenshot + the page's visible text to
/tmp/goodreads-export-debug.png / .txt before exiting non-zero, so a
failed run leaves something to diagnose from.

Usage:
    GOODREADS_SESSION='<storageState JSON>' python3 fetch_goodreads_export.py [output_path]

output_path defaults to /tmp/goodreads-export-raw.csv -- deliberately
outside the repo working directory; only the derived
data/goodreadsData.json changes a merge actually decides to apply ever
get committed, never the raw export itself (same convention as every
other external-export handling in this project).
"""

import json
import os
import re
import sys
from pathlib import Path

IMPORT_URL = 'https://www.goodreads.com/review/import'


def looks_logged_out(page):
    # Real, confirmed signal from this session's own RSS-breakage
    # investigation: an anonymous request gets a page titled "Sign in"
    # with <link rel="canonical" href="https://www.goodreads.com/user/sign_in">.
    title = (page.title() or '').strip().lower()
    if title == 'sign in':
        return True
    canonical = page.locator('link[rel="canonical"]')
    try:
        href = canonical.get_attribute('href', timeout=2000) or ''
    except Exception:
        href = ''
    return 'user/sign_in' in href


def main():
    # Real debugging pain from the 2026-11-06 incident this file's own
    # history documents: stdout is block-buffered when piped (as it is in
    # GitHub Actions), so print() calls sat unflushed until exit while the
    # one stderr ERROR line went out immediately -- making the real
    # chronological order of the job log actively misleading when
    # diagnosing a failure. Line-buffer stdout so prints interleave with
    # stderr in true time order.
    sys.stdout.reconfigure(line_buffering=True)

    output_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/goodreads-export-raw.csv')

    session_json = os.environ.get('GOODREADS_SESSION')
    if not session_json:
        print('ERROR: GOODREADS_SESSION is not set. This needs a saved Playwright storageState '
              '(captured once from a real logged-in Goodreads session) -- see CLAUDE.md\'s '
              '"Automated Goodreads Export" section.', file=sys.stderr)
        sys.exit(1)

    try:
        storage_state = json.loads(session_json)
    except json.JSONDecodeError as e:
        print(f'ERROR: GOODREADS_SESSION is not valid JSON: {e}', file=sys.stderr)
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
            page.goto(IMPORT_URL, wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_timeout(2000)

            current_url = page.url
            body_text = page.inner_text('body')[:1500]
            print(f'DIAGNOSTIC: landed on {current_url!r}, page title={page.title()!r}')
            print(f'DIAGNOSTIC: first 1500 chars of visible body text:\n{body_text}')

            if looks_logged_out(page):
                print('ERROR: this looks like an anonymous/logged-out page (title "Sign in" or '
                      'canonical link to /user/sign_in) -- the saved session has likely expired '
                      'or was captured incompletely. Bill needs to redo the capture (see '
                      'CLAUDE.md\'s "Capturing a session" under Automated Goodreads Export).',
                      file=sys.stderr)
                page.screenshot(path='/tmp/goodreads-export-debug.png')
                sys.exit(1)

            # Text-based locator, not a CSS class/id guess -- robust to
            # markup changes, matches Goodreads' own documented button
            # label.
            export_button = page.get_by_text('Export Library', exact=False).first
            export_button.wait_for(state='visible', timeout=15_000)
            print('Clicking "Export Library". Goodreads generates this server-side (seconds to a '
                  'few minutes for a library this size, per Goodreads\' own help docs) and shows '
                  'a dated download link on this same page once ready -- polling for it rather '
                  'than expecting an immediate download.')
            export_button.click()

            # Poll for the real, dated download link -- matched by its own
            # visible text ("Your export from <date> - <time>", confirmed
            # verbatim from this exact page in a real 2026-11-06 run), not
            # by href pattern. Two real bugs this fixes, found via two
            # separate real production runs rather than guessed up front:
            # (1) this same /review/import page also carries a *static*
            # sample/example CSV link (for the unrelated Import feature,
            # four generic placeholder titles like "Dune"/"Blink") that
            # matched a naive a[href*="export"]+".csv" selector immediately,
            # before "Export Library" was ever clicked -- downloaded instead
            # of Bill's real export (caught downstream by bbip_auto_import.mjs's
            # own safety tier: 0/4 real matches, nothing auto-applied, but the
            # run should never have gotten that far). (2) a follow-up fix that
            # required the href to be genuinely NEW relative to a pre-click
            # snapshot turned out to be the wrong invariant -- Goodreads can
            # legitimately keep serving the SAME already-ready export link
            # across multiple runs within the same session (confirmed live:
            # a second run minutes later found "Your export from 11/06/2026 -
            # 01:20" already on the page from the FIRST run's click), so
            # requiring novelty would wait forever for a new href that may
            # never come. Matching on this specific text sidesteps both: the
            # sample link never carries this phrase, and a real, already-
            # ready export (however it got there) is always correct to use.
            download_pattern = re.compile(r'your export from', re.IGNORECASE)
            download_trigger = None
            deadline_ms = 600_000  # 10 minutes -- one guide's own "if nothing shows after ten
                                    # minutes, click Export Library again" ceiling; this script
                                    # fails loud rather than silently re-clicking on a guess.
            poll_interval_ms = 10_000
            waited_ms = 0
            while waited_ms < deadline_ms:
                candidate = page.get_by_text(download_pattern).first
                if candidate.count() > 0:
                    download_trigger = candidate
                    break
                page.wait_for_timeout(poll_interval_ms)
                waited_ms += poll_interval_ms
                try:
                    # A generous explicit timeout, and a real reload timeout
                    # is treated as transient (retry next cycle) rather than
                    # fatal -- a real run hit exactly this (Page.reload:
                    # Timeout 30000ms exceeded on Goodreads' default 30s)
                    # and it killed the whole run on the very first poll.
                    page.reload(wait_until='domcontentloaded', timeout=60_000)
                except Exception as reload_err:
                    print(f'...reload hit a transient error ({reload_err}); will retry next cycle')
                print(f'...still waiting for a "Your export from..." link ({waited_ms // 1000}s elapsed)')

            if not download_trigger:
                print('ERROR: no "Your export from..." link appeared within 10 minutes. Goodreads '
                      'may be slower than usual, or the page markup/wording changed.', file=sys.stderr)
                page.screenshot(path='/tmp/goodreads-export-debug.png')
                Path('/tmp/goodreads-export-debug.txt').write_text(page.content())
                sys.exit(1)

            # The matched text node may be the <a> itself, or may sit inside
            # one (e.g. wrapped in a <span>) -- resolve to the nearest real
            # anchor so .click() reliably triggers the download rather than
            # just clicking inert text.
            download_link = download_trigger
            anchor = download_trigger.locator('xpath=ancestor-or-self::a[1]')
            if anchor.count() > 0:
                download_link = anchor.first

            with page.expect_download(timeout=60_000) as download_info:
                download_link.click()
            download = download_info.value
            download.save_as(str(output_path))

            size_kb = output_path.stat().st_size / 1024
            print(f'Downloaded {output_path} ({size_kb:.0f} KB)')

            first_line = output_path.read_text(encoding='utf-8', errors='replace').splitlines()[0] if size_kb > 0 else ''
            if 'Book Id' not in first_line:
                # Escalated from a soft WARNING to a hard failure after the
                # real 2026-11-06 incident this exact check caught: a wrong
                # file (Goodreads' own unrelated sample/example import CSV)
                # downloaded clean and would have looked like a successful
                # run if this had stayed a warning -- the bbip_auto_import.mjs
                # merge step downstream only found 0/4 real matches because
                # ITS OWN safety tier refused to guess, not because this
                # script ever flagged anything as having gone wrong.
                print(f'ERROR: downloaded file\'s header doesn\'t look like a real Goodreads '
                      f'export (expected a "Book Id" column). First line: {first_line[:200]!r} -- '
                      f'this is most likely the wrong file (e.g. Goodreads\' own unrelated sample/'
                      f'example import CSV also on this page), not a real but malformed export.',
                      file=sys.stderr)
                page.screenshot(path='/tmp/goodreads-export-debug.png')
                Path('/tmp/goodreads-export-debug.txt').write_text(page.content())
                sys.exit(1)

        except Exception as e:
            print(f'ERROR: {e}', file=sys.stderr)
            try:
                page.screenshot(path='/tmp/goodreads-export-debug.png')
                Path('/tmp/goodreads-export-debug.txt').write_text(page.content())
                print('Saved /tmp/goodreads-export-debug.png and .txt for diagnosis.', file=sys.stderr)
            except Exception:
                pass
            sys.exit(1)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
