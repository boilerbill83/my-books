#!/usr/bin/env python3
"""
Mechanically enforces CLAUDE.md's standing "when two cards/sections sit
side by side in a row, check they render at the same height" rule across
every .tk-row2/.tk-top-row layout on every trakt/*.html page.

This exists because the rule itself was never the gap - CLAUDE.md has
documented it (with 3 named failure modes and worked examples) for a
long time. The gap was enforcement: a session would write a one-off
Playwright check for whichever failure mode seemed relevant to whatever
was just reported, see it pass, and conclude the row was fine - without
checking the other 2 modes. That's exactly how the Movies/Shows You'll
Love content-fill gap (fixed here, same push as this script) slipped
through an earlier "all 4 pairs match!" check that only measured mode 1
(box height) and never measured mode 2 (content fill).

Checks all 3 documented failure modes, for every paired row, every time:

  1. Card BOXES not matching height - something is overriding CSS Grid's
     default align-items:stretch (or the row isn't a real 2-column grid).
  2. Boxes match, but one side's CONTENT doesn't fill its box, leaving a
     visibly empty gap at the bottom while its sibling runs full height.
  3. A .tk-shelf (horizontally-scrolling poster strip) inside a paired
     row has real content hidden behind a horizontal scrollbar instead
     of showing it - the specific anti-pattern CLAUDE.md's own history
     flags twice (Shows You Watch Together, Family Watch List).

Run manually:
    python3 trakt/verify_paired_layouts.py

Run in CI: .github/workflows/trakt-verify-layouts.yml, triggered on every
push that touches trakt/*.html, trakt/*.css, trakt/*.js, or styles.css -
fails the run (non-zero exit) on any violation, so a layout regression
can't land without a visible red check, regardless of whether the
session that pushed it happened to check by hand.

Needs Playwright: pip install playwright && playwright install chromium
"""
import sys
import os
import glob
import threading
import http.server
import socketserver
import functools

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = sorted(glob.glob(os.path.join(ROOT, 'trakt', '*.html')))

# Thresholds - tuned against this project's real, already-fixed pairs
# (see the commit this script shipped in): the pre-fix You'll Love gap
# was 155px vs 31px (diff 124px, ratio 4.9x) and correctly trips both
# bars below; the post-fix 31px/31px and every other real pair checked
# clean at these settings, with no false positives found.
BOX_HEIGHT_TOLERANCE_PX = 4      # mode 1
CONTENT_GAP_ABS_PX = 40          # mode 2: minimum absolute gap difference to flag
CONTENT_GAP_RATIO = 2.5          # mode 2: AND the larger gap must be this many times the smaller
SHELF_OVERFLOW_PX = 20           # mode 3: real hidden horizontal content beyond this is a violation


def start_server():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


def card_label(card):
    heading = card.query_selector('.tk-card-heading, .tk-hero-title, h2, h3')
    if heading:
        text = heading.inner_text().strip()
        return text[:40] if text else card.get_attribute('id') or '(unlabeled)'
    return card.get_attribute('id') or '(unlabeled card)'


def content_bottom_gap(card, card_box):
    """Blank space between the card's deepest real content and its own
    bottom edge - the literal thing failure mode 2 describes."""
    max_bottom = card.evaluate('''(el) => {
        let maxB = el.getBoundingClientRect().top;
        const walk = (node) => {
            for (const child of node.children) {
                const r = child.getBoundingClientRect();
                if (r.height > 0 && r.width > 0) maxB = Math.max(maxB, r.bottom);
                walk(child);
            }
        };
        walk(el);
        return maxB;
    }''')
    if max_bottom is None:
        return None
    card_bottom = card_box['y'] + card_box['height']
    return max(0.0, card_bottom - max_bottom)


def wait_for_async_content(page, timeout_s=70, poll_s=1.0):
    """Some sections (e.g. quality.html's BMTRE Accuracy Score, a real
    leave-one-out eval pass) render a '.tk-empty' loading placeholder and
    fill in asynchronously, sometimes taking tens of real seconds. Measuring
    layout against that placeholder text instead of the final content is a
    guaranteed false positive for mode 2 (the placeholder is always short),
    so wait out any visible 'Computing'/'Loading' text before measuring
    anything - this is what actually caught the real 42.5s BMTRE Accuracy
    Score slowdown in the first place (the content gap was real, but the
    ROOT CAUSE was the performance regression, not the layout)."""
    waited = 0.0
    while waited < timeout_s:
        still_loading = page.evaluate('''() => {
            for (const el of document.querySelectorAll('.tk-empty')) {
                const t = (el.textContent || '').toLowerCase();
                if (el.offsetParent !== null && (t.includes('computing') || t.includes('loading'))) return true;
            }
            return false;
        }''')
        if not still_loading:
            return
        page.wait_for_timeout(int(poll_s * 1000))
        waited += poll_s
    print(f'  (warning: a loading placeholder was still visible after {timeout_s}s - measuring anyway)')


def main():
    from playwright.sync_api import sync_playwright

    httpd, port = start_server()
    base = f'http://127.0.0.1:{port}'
    violations = []
    checked_rows = 0

    with sync_playwright() as pw:
        # Local dev sandboxes often pre-install Chromium at a fixed path
        # (PLAYWRIGHT_CHROMIUM_PATH) rather than letting Playwright manage
        # its own download; CI installs its own via `playwright install`
        # and doesn't set this, so the default (None) is used there.
        launch_kwargs = {}
        chromium_path = os.environ.get('PLAYWRIGHT_CHROMIUM_PATH')
        if chromium_path:
            launch_kwargs['executable_path'] = chromium_path
        browser = pw.chromium.launch(**launch_kwargs)
        # .tk-row2/.tk-top-row both collapse to 1 column under 780px -
        # need a desktop-width viewport for the 2-column grid to be live.
        page = browser.new_page(viewport={'width': 1400, 'height': 1200})

        for page_path in PAGES:
            rel = os.path.relpath(page_path, ROOT)
            url = f'{base}/{rel}'
            try:
                page.goto(url, wait_until='networkidle', timeout=30000)
            except Exception as e:
                violations.append(f'{rel}: FAILED TO LOAD ({e})')
                continue
            page.wait_for_timeout(1800)  # let client-side render() calls finish
            wait_for_async_content(page)

            rows = page.query_selector_all('.tk-row2, .tk-top-row')
            for row_idx, row in enumerate(rows):
                row_class = row.get_attribute('class')
                cards = row.query_selector_all(':scope > *')
                visible_cards = [c for c in cards if c.is_visible()]
                # Only a real 2-up pair is this rule's concern - a single
                # visible child (an empty-state collapse) isn't a "row".
                if len(visible_cards) != 2:
                    continue
                checked_rows += 1
                a, b = visible_cards
                box_a, box_b = a.bounding_box(), b.bounding_box()
                if not box_a or not box_b:
                    continue
                label_a, label_b = card_label(a), card_label(b)
                row_label = f'{rel} row #{row_idx + 1} ({row_class}): "{label_a}" vs "{label_b}"'

                # Mode 1: box heights should match (CSS Grid stretch default)
                diff = abs(box_a['height'] - box_b['height'])
                if diff > BOX_HEIGHT_TOLERANCE_PX:
                    violations.append(
                        f'{row_label} -- MODE 1 box height mismatch: '
                        f'{box_a["height"]:.0f}px vs {box_b["height"]:.0f}px (diff {diff:.0f}px)'
                    )
                else:
                    # Mode 2 only makes sense once boxes actually match -
                    # if they don't, mode 1 is the real problem to fix first.
                    gap_a = content_bottom_gap(a, box_a)
                    gap_b = content_bottom_gap(b, box_b)
                    if gap_a is not None and gap_b is not None:
                        gdiff = abs(gap_a - gap_b)
                        ratio = (max(gap_a, gap_b) + 1) / (min(gap_a, gap_b) + 1)
                        if gdiff > CONTENT_GAP_ABS_PX and ratio > CONTENT_GAP_RATIO:
                            violations.append(
                                f'{row_label} -- MODE 2 content not filling box: '
                                f'bottom gap {gap_a:.0f}px vs {gap_b:.0f}px'
                            )

                # Mode 3: independent of modes 1/2 - a shelf hiding real
                # content behind horizontal scroll is bad regardless of
                # whether the box heights happen to match.
                for card, label in ((a, label_a), (b, label_b)):
                    for shelf in card.query_selector_all('.tk-shelf'):
                        overflow = shelf.evaluate('el => el.scrollWidth - el.clientWidth')
                        if overflow and overflow > SHELF_OVERFLOW_PX:
                            violations.append(
                                f'{row_label} -- MODE 3 horizontal-scroll shelf hides content: '
                                f'"{label}" has {overflow:.0f}px of real content off-screen '
                                f'(wrap into a multi-row grid instead, same shape as #nextWatch)'
                            )

        browser.close()
    httpd.shutdown()

    print(f'Checked {checked_rows} paired rows across {len(PAGES)} pages.')
    if violations:
        print(f'\n{len(violations)} VIOLATION(S) FOUND:\n')
        for v in violations:
            print(f'  - {v}')
        sys.exit(1)
    print('All paired rows pass: box heights match, content fills, no content hidden behind scroll.')
    sys.exit(0)


if __name__ == '__main__':
    main()
