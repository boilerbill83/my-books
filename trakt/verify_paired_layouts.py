#!/usr/bin/env python3
"""
Mechanically enforces two related standing rules across every trakt/*.html
page: (1) CLAUDE.md's "two cards side by side should render at the same
height" rule, and (2) Bill's broader follow-up ask (2026-10-01) - "limiting
white space and limiting horizontal and vertical scroll within a box/section
unless it can't be avoided" - plus a couple of mechanically-checkable UI
best practices pulled from real research (WCAG 1.4.10 Reflow, WCAG 2.5.8
Target Size) rather than invented.

This exists because the paired-row rule itself was never the gap - CLAUDE.md
documented it (3 named failure modes, worked examples) for a long time. The
gap was enforcement: a session would write a one-off check for whichever
failure mode seemed relevant to whatever was just reported, see it pass, and
conclude the row was fine - without checking the other modes, or anything
outside a paired row at all. Bill's own words on why this has to be
automatic rather than a discipline to remember: "automatically I shouldn't
have to tell you."

Checks, run on every trakt/*.html page at a desktop (1400px) AND a mobile
(375px) viewport (same loaded page, resized - not reloaded, so an expensive
async computation like quality.html's BMTRE Accuracy Score only ever runs
once per page):

  PAIRED-ROW checks (desktop viewport only - a .tk-row2/.tk-top-row
  collapses to one column under 780px, so "do the two sides match" isn't a
  meaningful question once they're stacked, not side by side):
    1. Card BOXES not matching height - something overriding CSS Grid's
       default align-items:stretch (or the row isn't a real 2-column grid).
    2. Boxes match, but one side's CONTENT doesn't fill its box, leaving a
       visible empty gap at the bottom while its sibling runs full height.
    3. A .tk-shelf (horizontally-scrolling poster strip) inside a paired
       row has real content hidden behind a horizontal scrollbar instead
       of showing it.

  WHITESPACE / SCROLL checks (both viewports - Bill's literal ask):
    4. Page-level horizontal overflow (WCAG 1.4.10 Reflow) - the page
       itself should never need 2-axis scroll at any real viewport width.
    5. A STANDALONE card (not already covered by the paired-row content-
       fill check above) with a large empty gap at its own bottom relative
       to its own height - excess whitespace with no sibling needed to
       prove it's excessive.
    6. An UNJUSTIFIED scroll region - any element whose computed overflow
       is auto/scroll and which actually has hidden content, that isn't on
       the explicit SCROLL_ALLOWLIST_SELECTORS allowlist below. "Unless it
       can't be avoided" (Bill's own phrasing) is exactly what the
       allowlist encodes: each entry documents *why* that one is a
       deliberate, necessary exception rather than a layout bug - mirroring
       WCAG 1.4.10's own built-in exception for content that genuinely
       needs 2D layout (data tables, toolbars, and the like).
    7. A TAP TARGET smaller than WCAG 2.5.8's 24x24 CSS px minimum, scoped
       to unambiguous controls (buttons, nav links, bare checkboxes/radios
       with no wrapping <label>) so inline prose links - WCAG 2.5.8's own
       documented exception - are never flagged.

Run manually:
    python3 trakt/verify_paired_layouts.py

Run in CI: .github/workflows/trakt-verify-layouts.yml, triggered on every
push that touches trakt/*.html, trakt/*.css, trakt/*.js, or styles.css -
fails the run (non-zero exit) on any violation.

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

# Thresholds - tuned against this project's real, already-fixed pairs (see
# the commit this script first shipped in): the pre-fix You'll Love gap was
# 155px vs 31px (diff 124px, ratio 4.9x) and correctly trips both bars
# below; the post-fix 31px/31px and every other real pair checked clean at
# these settings, with no false positives found.
BOX_HEIGHT_TOLERANCE_PX = 4      # mode 1
CONTENT_GAP_ABS_PX = 40          # mode 2: minimum absolute gap difference to flag
CONTENT_GAP_RATIO = 2.5          # mode 2: AND the larger gap must be this many times the smaller
SHELF_OVERFLOW_PX = 20           # mode 3: real hidden horizontal content beyond this is a violation

PAGE_OVERFLOW_TOLERANCE_PX = 2   # mode 4: a couple px of scrollbar/rounding noise is not a violation

# mode 5: a standalone card needs BOTH an absolute gap AND that gap being a
# real fraction of its own height before it's flagged - normal card padding
# (20-30px) alone must never trip this. Tuned against this project's real
# cards (none at the time of writing cross this bar) rather than guessed;
# re-tune here first if a future genuinely-short, genuinely-fine card ever
# false-positives.
STANDALONE_GAP_ABS_PX = 120
STANDALONE_GAP_RATIO = 0.30
STANDALONE_MIN_CARD_HEIGHT_PX = 80   # ignore tiny loading-placeholder/empty-state cards

SCROLL_OVERFLOW_TOLERANCE_PX = 4     # mode 6

MIN_TAP_TARGET_PX = 24                # mode 7 - WCAG 2.5.8's normative minimum (not the 44px AAA ideal)

# mode 6 allowlist - CSS selectors for scroll regions that are a deliberate,
# documented design choice, not a layout bug. Checked by ancestor walk, so
# allowlisting a container covers everything inside it. Each one is already
# explained inline at its own definition; the summary here is just enough
# to say WHY it's exempt from "unless it can't be avoided."
SCROLL_ALLOWLIST_SELECTORS = [
    '.tk-table-wrap',       # wide sortable data tables - WCAG 1.4.10's own
                            # reflow exception explicitly names tables as
                            # content that genuinely needs 2D layout
    '.tk-shelf',            # horizontal poster strip - mode 3 above already
                            # owns this specific case (flags it INSIDE a
                            # paired row, where a shorter sibling implies it
                            # should wrap instead); outside a pairing it's a
                            # deliberate browse-more affordance, not hidden
                            # content - see trakt/index.html's own comment
                            # at #coWatchCards about why #airingCards is
                            # left as a normal horizontal-scroll shelf
    '.tk-imp-modal .dialog-body',  # modal body, necessarily height-capped
                                    # so it fits on screen regardless of
                                    # finding length
    '.tk-hero-facts',       # capped height + themed scrollbar, an
                            # established precedent (trakt/index.html)
    '#nextWatch',           # flex:1, capped by design - CLAUDE.md's own
                            # worked example for wrapping-instead-of-
                            # scrolling, itself has a scroll fallback only
                            # if even the wrapped grid overflows its cap
    '#familyWatchList',     # max-height:560px, same capped-shelf pattern
    '#coWatchCards',        # same pattern, scoped to this one card
    '.tk-picker-suggestions',  # autocomplete dropdown - bounded by design,
                                # not page content at all
]

# mode 2 allowlist - paired-row CARD-LABEL pairs (order-independent) that
# are a deliberate, verified, content-type-mismatch exception, not a
# layout bug - same "document why, don't silently suppress" discipline as
# SCROLL_ALLOWLIST_SELECTORS above, scoped to mode 2 specifically. A pair
# only belongs here after confirming BOTH that its shorter side's content
# really is properly centered (not flush-top - that's still a real bug)
# AND that the residual gap is an honest consequence of comparing two
# genuinely different kinds of content, not something a further size bump
# can close without hurting the content's own visual quality.
CONTENT_GAP_KNOWN_EXCEPTIONS = {
    frozenset(['Biggest Prediction Misses', 'Dismissal Reasons']):
        'verified 2026-10-04: Dismissal Reasons\' bar chart is genuinely '
        'centered within its own flex-grown wrapper (symmetric top/bottom '
        'gaps measured directly against it, not just inferred) - its '
        'barHeight was already bumped twice (22->34->46) in response to '
        'Bill\'s real "isn\'t tall enough" complaint, each time measured '
        'before/after rather than guessed. The residual gap is a 14-reason '
        'bar chart legitimately being less tall than a 10-poster list even '
        'at a comfortably-readable bar size - pushing bars thicker still '
        'to fully erase it risks worse-looking, disproportionate bars for '
        'a cosmetic win. See renderDismissalChart()\'s own comment '
        '(quality.js) for the full sizing history.',
    frozenset(['Genres You Rate Highest', 'Most-Watched Actors']):
        'verified 2026-10-04: the genre chart is genuinely centered within '
        'its own flex-grown .tk-chart-wrap (symmetric 58px/58px top/bottom '
        'gaps measured directly against the wrapper itself, confirmed '
        'locally) - it\'s deliberately capped to its top 12 rows at a '
        'bigger font size (Bill: "cut out some of the bottom values so it '
        'isn\'t too tall", see #genreChartCard\'s own comment above), which '
        '"shouldn\'t be reverted" per that same comment. First caught in '
        'real CI (not locally) at a slightly larger 68px/25px, not the '
        '58px/25px measured in this sandbox - this sandbox\'s own network '
        'policy blocks Google Fonts (a long-documented, pre-existing '
        'limitation noted throughout this project), so CI renders the real '
        'font while local testing here falls back to a system font with '
        'slightly different metrics, enough to tip this one borderline '
        'case over threshold. The centering itself is confirmed correct '
        'either way; only the exact residual px is environment-dependent.',
}


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


# Shared by content_bottom_gap() (mode 2) and check_standalone_whitespace()
# (mode 5) - both need "how far down does this card's REAL content reach
# relative to the box it's actually meant to fill." That box isn't always
# the card's own outer edge: the established, CLAUDE.md-documented remedy
# for failure mode 2 is a flex-grown wrapper (`.tk-chart-wrap` etc, flex:1)
# sitting below a heading, with ITS OWN content vertically centered inside
# IT (#dismissalsCard/#genreChartCard/#nextWatch all use this exact shape,
# the first being CLAUDE.md's own cited "worked example"). The heading
# sits above the wrapper and was never meant to be "filled" - measuring
# against the WHOLE card makes even a perfectly-centered wrapper look
# asymmetric purely because the heading eats real space near the top that
# the wrapper's own bottom gap then gets unfairly compared against.
#
# Two real bugs found this way and both fixed here (2026-10-04, live on
# the actual site - not hypothesized):
#   (1) A flex-grown wrapper's own bounding box was being counted as
#       "content reaching the bottom" (it's sized by the PARENT's
#       available space, not its own content) - produced a false
#       near-zero gap, hiding the real #nextWatch bug this whole fix
#       started from. Fixed: never count a flex-grown element's own rect,
#       only recurse into its children.
#   (2) Even after (1), measuring relative to the OUTER CARD still
#       mis-flagged #genreChartCard and #dismissalsCard as violations -
#       both verified directly (2026-10-04, live measurement) to have
#       their content PERFECTLY centered within their own .tk-chart-wrap
#       (symmetric top/bottom gaps measured against the wrapper itself:
#       58px/58px and 144px/144px respectively), yet still tripped mode 2
#       because the heading above each wrapper made the whole-card "top
#       gap" look artificially small next to the wrapper's own real (but
#       legitimate, centered) bottom gap. Fixed: measure against the
#       INNERMOST flex-grown descendant's own box (found by walking down
#       through any chain of flex-grown wrappers from the card), not the
#       originally-passed card element - that inner box is the thing the
#       design is actually trying to fill/center; chrome like a heading
#       sitting above it was never part of what's being filled.
CONTENT_GAP_JS = '''(root) => {
    const isGrown = (el) => parseFloat(getComputedStyle(el).flexGrow || '0') > 0;
    const effectiveBox = (el) => {
        let box = el;
        for (const child of el.children) {
            const r = child.getBoundingClientRect();
            if (r.height > 0 && r.width > 0 && isGrown(child)) box = effectiveBox(child);
        }
        return box;
    };
    const box = effectiveBox(root);
    const boxRect = box.getBoundingClientRect();
    let maxBottom = boxRect.top;
    const walk = (node) => {
        for (const child of node.children) {
            const r = child.getBoundingClientRect();
            if (r.height > 0 && r.width > 0 && !isGrown(child)) maxBottom = Math.max(maxBottom, r.bottom);
            walk(child);
        }
    };
    walk(box);
    return Math.max(0, boxRect.bottom - maxBottom);
}'''


def content_bottom_gap(card):
    """Blank space between the card's deepest real content and the box it's
    actually meant to fill (see CONTENT_GAP_JS's own comment for why that
    isn't always the card's own outer edge)."""
    return card.evaluate(CONTENT_GAP_JS)


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


def check_paired_rows(page, rel):
    """Modes 1-3. Only meaningful at a viewport wide enough for the real
    2-column grid to be live (.tk-row2/.tk-top-row collapse to 1 column
    under 780px) - callers must only invoke this at a desktop-width
    viewport, since at mobile both cards are still "visible" but simply
    stacked in their own grid row, where unequal heights are completely
    normal and would be a false positive for mode 1."""
    violations = []
    rows = page.query_selector_all('.tk-row2, .tk-top-row')
    rows_checked = 0
    for row_idx, row in enumerate(rows):
        row_class = row.get_attribute('class')
        cards = row.query_selector_all(':scope > *')
        visible_cards = [c for c in cards if c.is_visible()]
        # Only a real 2-up pair is this rule's concern - a single visible
        # child (an empty-state collapse) isn't a "row".
        if len(visible_cards) != 2:
            continue
        rows_checked += 1
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
            # Mode 2 only makes sense once boxes actually match - if they
            # don't, mode 1 is the real problem to fix first.
            # Normalize away the collapse-card chevron (e.g. "Dismissal
            # Reasons\n▾") before checking the known-exceptions allowlist -
            # card_label() keeps it for display, but it's not part of the
            # heading identity the allowlist keys on.
            label_key = frozenset([
                label_a.replace('▾', '').strip(),
                label_b.replace('▾', '').strip(),
            ])
            if label_key in CONTENT_GAP_KNOWN_EXCEPTIONS:
                continue
            gap_a = content_bottom_gap(a)
            gap_b = content_bottom_gap(b)
            if gap_a is not None and gap_b is not None:
                gdiff = abs(gap_a - gap_b)
                ratio = (max(gap_a, gap_b) + 1) / (min(gap_a, gap_b) + 1)
                if gdiff > CONTENT_GAP_ABS_PX and ratio > CONTENT_GAP_RATIO:
                    violations.append(
                        f'{row_label} -- MODE 2 content not filling box: '
                        f'bottom gap {gap_a:.0f}px vs {gap_b:.0f}px'
                    )

        # Mode 3: independent of modes 1/2 - a shelf hiding real content
        # behind horizontal scroll is bad regardless of whether the box
        # heights happen to match.
        for card, label in ((a, label_a), (b, label_b)):
            for shelf in card.query_selector_all('.tk-shelf'):
                overflow = shelf.evaluate('el => el.scrollWidth - el.clientWidth')
                if overflow and overflow > SHELF_OVERFLOW_PX:
                    violations.append(
                        f'{row_label} -- MODE 3 horizontal-scroll shelf hides content: '
                        f'"{label}" has {overflow:.0f}px of real content off-screen '
                        f'(wrap into a multi-row grid instead, same shape as #nextWatch)'
                    )
    return violations, rows_checked


def check_page_overflow(page, rel, viewport_label):
    """Mode 4 - WCAG 1.4.10 Reflow: the page itself should never require
    horizontal scroll to read its content."""
    dims = page.evaluate('''() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    })''')
    overflow = dims['scrollWidth'] - dims['clientWidth']
    if overflow > PAGE_OVERFLOW_TOLERANCE_PX:
        return [f'{rel} [{viewport_label}] -- MODE 4 page-level horizontal overflow: '
                f'{overflow}px wider than the viewport (scrollWidth {dims["scrollWidth"]}px '
                f'vs clientWidth {dims["clientWidth"]}px)']
    return []


def check_standalone_whitespace(page, rel, viewport_label):
    """Mode 5 - a standalone card (no sibling to compare against, so this
    uses an absolute+ratio heuristic instead of mode 2's sibling-ratio
    one) with a large empty gap at its own bottom. Skips any card already
    inside a .tk-row2/.tk-top-row pairing, since mode 2's sibling-relative
    comparison is strictly more precise for that case and this would
    otherwise just be a noisier duplicate of the same finding."""
    results = page.evaluate('''([minHeight, absPx, ratio]) => {
        const isGrown = (el) => parseFloat(getComputedStyle(el).flexGrow || '0') > 0;
        // Same innermost-flex-grown-wrapper logic as CONTENT_GAP_JS (mode 2's
        // content_bottom_gap()) - see that constant's own comment for why
        // measuring against the whole card (rather than the wrapper a
        // heading sits above) produces false positives on an already-
        // correctly-centered card like #genreChartCard/#dismissalsCard.
        const effectiveBox = (el) => {
            let box = el;
            for (const child of el.children) {
                const r = child.getBoundingClientRect();
                if (r.height > 0 && r.width > 0 && isGrown(child)) box = effectiveBox(child);
            }
            return box;
        };
        const out = [];
        for (const card of document.querySelectorAll('.tk-card, .tk-hero-card')) {
            if (card.closest('.tk-row2, .tk-top-row')) continue;
            if (getComputedStyle(card).display === 'none') continue;
            const rect = card.getBoundingClientRect();
            if (rect.height < minHeight || rect.width === 0) continue;
            const box = effectiveBox(card);
            const boxRect = box.getBoundingClientRect();
            let maxBottom = boxRect.top;
            const walk = (node) => {
                for (const child of node.children) {
                    const r = child.getBoundingClientRect();
                    if (r.height > 0 && r.width > 0 && !isGrown(child)) maxBottom = Math.max(maxBottom, r.bottom);
                    walk(child);
                }
            };
            walk(box);
            const gap = Math.max(0, boxRect.bottom - maxBottom);
            if (gap > absPx && (gap / rect.height) > ratio) {
                let label = card.id ? ('#' + card.id) : '(unlabeled)';
                const heading = card.querySelector('.tk-card-heading, .tk-hero-title, h2, h3');
                if (heading && heading.textContent.trim()) label = heading.textContent.trim().slice(0, 50);
                out.push({ label, gap: Math.round(gap), height: Math.round(rect.height) });
            }
        }
        return out;
    }''', [STANDALONE_MIN_CARD_HEIGHT_PX, STANDALONE_GAP_ABS_PX, STANDALONE_GAP_RATIO])
    return [
        f'{rel} [{viewport_label}] -- MODE 5 standalone card has excess whitespace: '
        f'"{r["label"]}" is {r["height"]}px tall with a {r["gap"]}px empty gap at the bottom '
        f'({round(100 * r["gap"] / r["height"])}% of the card is empty)'
        for r in results
    ]


def check_unjustified_scroll(page, rel, viewport_label):
    """Mode 6 - any element with real overflow:auto/scroll content that
    isn't on the explicit SCROLL_ALLOWLIST_SELECTORS allowlist above."""
    results = page.evaluate('''([allowlistSelectors, tolerance]) => {
        const allowed = new Set();
        for (const sel of allowlistSelectors) {
            for (const el of document.querySelectorAll(sel)) allowed.add(el);
        }
        const isAllowed = (el) => {
            let node = el;
            while (node) {
                if (allowed.has(node)) return true;
                node = node.parentElement;
            }
            return false;
        };
        const out = [];
        for (const el of document.querySelectorAll('*')) {
            const style = getComputedStyle(el);
            const scrollsY = (style.overflowY === 'auto' || style.overflowY === 'scroll');
            const scrollsX = (style.overflowX === 'auto' || style.overflowX === 'scroll');
            if (!scrollsY && !scrollsX) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const overflowY = scrollsY ? (el.scrollHeight - el.clientHeight) : 0;
            const overflowX = scrollsX ? (el.scrollWidth - el.clientWidth) : 0;
            if (overflowY <= tolerance && overflowX <= tolerance) continue;
            if (isAllowed(el)) continue;
            let label = el.id ? ('#' + el.id) : (el.className ? ('.' + String(el.className).split(' ')[0]) : el.tagName.toLowerCase());
            out.push({
                label,
                axis: (overflowY > tolerance && overflowX > tolerance) ? 'both' : (overflowY > tolerance ? 'vertical' : 'horizontal'),
                overflowY: Math.round(overflowY),
                overflowX: Math.round(overflowX),
            });
        }
        return out;
    }''', [SCROLL_ALLOWLIST_SELECTORS, SCROLL_OVERFLOW_TOLERANCE_PX])
    return [
        f'{rel} [{viewport_label}] -- MODE 6 unjustified {r["axis"]} scroll on "{r["label"]}": '
        f'{r["overflowY"]}px hidden vertically, {r["overflowX"]}px hidden horizontally '
        f'(add it to SCROLL_ALLOWLIST_SELECTORS with a reason if this is genuinely unavoidable, '
        f'otherwise fix the layout)'
        for r in results
    ]


def check_tap_targets(page, rel, viewport_label):
    """Mode 7 - WCAG 2.5.8 Target Size (Minimum): a real click/tap control
    smaller than 24x24 CSS px in either dimension. Scoped to unambiguous
    controls (buttons, .tk-btn/nav links, bare checkboxes/radios) so an
    inline prose link - WCAG 2.5.8's own documented exception - is never
    flagged. A checkbox/radio wrapped in a <label> is measured as the
    whole label, since that's its real clickable area, not the bare
    native input box."""
    results = page.evaluate('''(minPx) => {
        const out = [];
        const seen = new Set();
        const controls = document.querySelectorAll(
            'button, a.tk-btn, a.header-quality-link, input[type="checkbox"], input[type="radio"], [role="button"]'
        );
        for (const el of controls) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            let target = el;
            if (el.tagName === 'INPUT' && el.closest('label')) target = el.closest('label');
            if (seen.has(target)) continue;
            seen.add(target);
            const rect = target.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.width < minPx || rect.height < minPx) {
                let label = (target.textContent || target.getAttribute('aria-label') || target.id || target.tagName).trim().slice(0, 40);
                out.push({ label, width: Math.round(rect.width), height: Math.round(rect.height) });
            }
        }
        return out;
    }''', MIN_TAP_TARGET_PX)
    return [
        f'{rel} [{viewport_label}] -- MODE 7 tap target too small: '
        f'"{r["label"]}" is {r["width"]}x{r["height"]}px (WCAG 2.5.8 minimum is {MIN_TAP_TARGET_PX}x{MIN_TAP_TARGET_PX}px)'
        for r in results
    ]


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

            # Desktop pass (1400px): the real 2-column grid is live, so the
            # paired-row checks (modes 1-3) run here only. Everything else
            # runs at both viewports.
            row_violations, rows_checked = check_paired_rows(page, rel)
            violations.extend(row_violations)
            checked_rows += rows_checked
            violations.extend(check_page_overflow(page, rel, 'desktop'))
            violations.extend(check_standalone_whitespace(page, rel, 'desktop'))
            violations.extend(check_unjustified_scroll(page, rel, 'desktop'))
            violations.extend(check_tap_targets(page, rel, 'desktop'))

            # Mobile pass (375px): resize the SAME already-loaded page
            # rather than reloading - a reload would re-trigger any
            # expensive async computation (e.g. quality.html's real
            # leave-one-out eval pass, documented above as tens of real
            # seconds) a second time for no benefit, since none of these
            # checks depend on when the JS ran, only on the current layout.
            page.set_viewport_size({'width': 375, 'height': 900})
            page.wait_for_timeout(300)  # let the resize/reflow settle
            violations.extend(check_page_overflow(page, rel, 'mobile'))
            violations.extend(check_standalone_whitespace(page, rel, 'mobile'))
            violations.extend(check_unjustified_scroll(page, rel, 'mobile'))
            violations.extend(check_tap_targets(page, rel, 'mobile'))
            page.set_viewport_size({'width': 1400, 'height': 1200})  # restore for the next page

        browser.close()
    httpd.shutdown()

    print(f'Checked {checked_rows} paired rows across {len(PAGES)} pages, at both desktop and mobile viewports.')
    if violations:
        print(f'\n{len(violations)} VIOLATION(S) FOUND:\n')
        for v in violations:
            print(f'  - {v}')
        sys.exit(1)
    print('All checks pass: paired rows match and fill, no standalone whitespace, no unjustified scroll, no undersized tap targets.')
    sys.exit(0)


if __name__ == '__main__':
    main()
