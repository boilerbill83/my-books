#!/usr/bin/env python3
"""
Converts hand-written lines in trakt/data/pendingDismissals.md into real
trakt/data/feedbackData.json dismiss interactions — Bill's answer
(2026-09-26) to "is there a way to do this that doesn't require my
intervention?": a static site genuinely can't commit to a public repo on
its own without exposing a write credential in the browser (a real
security risk, not hypothetical), so instead of a proxy/new
infrastructure, Bill edits trakt/data/pendingDismissals.md himself (real
write access he already has, no new token, no new service) and this
script does the rest automatically once that commit lands.

Expects lines of the form `- Title | reasonCode` below the file's `---`
marker (see the file's own header for the full format and the real
reason-code list, the same 14 codes trakt/streaming-top10.js's dismiss
dialog offers). A line that doesn't match the format, or whose
reasonCode isn't recognized, is still recorded — this project's standing
"never silently lose real data" discipline — rather than dropped, with a
printed warning so it's visible in the job log.

Resolves each title against library.json/watchlist.json/candidatePool.json
(exact match; the same 3-file precedence trakt/streaming-top10.js's own
findOwnRecord() already uses) to backfill a real titleKey/year/type —
left null when genuinely unresolved rather than guessed.

Run manually:   python3 trakt/process_pending_dismissals.py [--dry-run]
GitHub Action:  .github/workflows/trakt-process-pending-dismissals.yml
"""

import json, re, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'trakt' / 'data'
PENDING_FILE = DATA_DIR / 'pendingDismissals.md'
FEEDBACK_FILE = DATA_DIR / 'feedbackData.json'
DRY_RUN = '--dry-run' in sys.argv

# Same 14 real, general codes trakt/streaming-top10.js's REASON_LABELS
# defines — kept in sync by hand, same as that file's own comment
# promises. Only used to fill in a human-readable label and to flag an
# unrecognized code in the job log; never used to reject a line.
REASON_LABELS = {
    'not_interested': 'General pass, no specific reason',
    'doesnt_look_good': "Doesn't look good from the trailer/premise",
    'too_boring': 'Looks boring/slow-paced',
    'too_hokey': 'Too hokey/campy',
    'too_comicbooky': 'Too comic-booky/superhero',
    'too_low_brow': 'Feels lower-brow/network procedural',
    'too_urban': 'Urban crime-drama fatigue',
    'too_kiddish': 'Too young-skewing/juvenile',
    'aimed_at_older_demographic': 'Skews toward an older demographic',
    'too_old': 'Feels dated',
    'looks_low_budget': 'Looks low-budget',
    'not_english_language': 'Feels too foreign-language/subtitled',
    'already_watched': 'Already watched (missing from your Trakt data)',
    'already_have_version_rated': 'Already have a different version rated',
}

LINE_RE = re.compile(r'^-\s*(.+?)\s*\|\s*(\S+)\s*$')


def load_titles():
    """One flat list of every real title record across the 3 Trakt-
    derived files, library-beats-watchlist-beats-candidatePool — same
    precedence findOwnRecord() in streaming-top10.js already uses, so a
    title known in more than one place resolves consistently."""
    titles = {}
    for fname in ('candidatePool.json', 'watchlist.json', 'library.json'):
        path = DATA_DIR / fname
        if not path.exists():
            continue
        data = json.load(open(path))
        for t in data.get('titles', []):
            if t.get('title'):
                titles[t['title']] = t
    return titles


def resolve_title(raw_title, known_titles):
    t = known_titles.get(raw_title)
    if not t:
        return None, None, None
    return t.get('titleKey'), t.get('year'), t.get('type')


def parse_pending(text):
    """Splits the file into (header_including_marker, entry_lines,
    unmatched_lines) — header is preserved verbatim on rewrite, entry_lines
    are real `- Title | code` matches (processed and cleared),
    unmatched_lines are anything below the marker that doesn't match the
    expected format (left in place so Bill can see/fix them)."""
    marker = '---\n'
    idx = text.rfind(marker)
    if idx == -1:
        return text, [], []
    header = text[:idx + len(marker)]
    body = text[idx + len(marker):]
    entries, leftover = [], []
    for line in body.splitlines():
        if not line.strip():
            continue
        m = LINE_RE.match(line.strip())
        if m:
            entries.append((m.group(1).strip(), m.group(2).strip()))
        else:
            leftover.append(line)
    return header, entries, leftover


def build_interaction(raw_title, reason_code, known_titles):
    title_key, year, t_type = resolve_title(raw_title, known_titles)
    if reason_code not in REASON_LABELS:
        print(f'  WARNING: unrecognized reasonCode {reason_code!r} for {raw_title!r} — recording as-is, not dropped.')
    return {
        'titleKey': title_key,
        'title': raw_title,
        'year': year,
        'type': t_type,
        'interactionType': 'dismiss',
        'reasonCode': reason_code,
        'reasonLabel': REASON_LABELS.get(reason_code, f'(unrecognized code {reason_code!r}, recorded as-is)'),
        'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'excludeFromRecommendations': True,
    }


def main():
    if not PENDING_FILE.exists():
        print(f'No {PENDING_FILE} — nothing to do.')
        return

    text = PENDING_FILE.read_text()
    header, entries, leftover = parse_pending(text)

    if not entries:
        print('No new pending dismissal lines to process.')
        return

    known_titles = load_titles()
    feedback = json.load(open(FEEDBACK_FILE)) if FEEDBACK_FILE.exists() else {'interactions': []}
    existing = feedback.setdefault('interactions', [])
    existing_pairs = {(e.get('title'), e.get('reasonCode')) for e in existing if e.get('interactionType') == 'dismiss'}

    added, skipped_dupes = 0, 0
    for raw_title, reason_code in entries:
        if (raw_title, reason_code) in existing_pairs:
            print(f'  Skipping duplicate: {raw_title!r} already dismissed with reason {reason_code!r}.')
            skipped_dupes += 1
            continue
        interaction = build_interaction(raw_title, reason_code, known_titles)
        existing.append(interaction)
        existing_pairs.add((raw_title, reason_code))
        resolved = 'resolved' if interaction['titleKey'] else 'UNRESOLVED (no titleKey match)'
        print(f'  Added: {raw_title!r} -> {reason_code!r} ({resolved})')
        added += 1

    print(f'\n{added} interaction(s) added, {skipped_dupes} duplicate(s) skipped.')

    if DRY_RUN:
        print('[DRY RUN] Not writing files.')
        return

    if added:
        json.dump(feedback, open(FEEDBACK_FILE, 'w'), indent=2)

    new_body = '\n' + '\n'.join(leftover) + ('\n' if leftover else '')
    PENDING_FILE.write_text(header + new_body)
    print(f'Cleared {len(entries)} processed line(s) from {PENDING_FILE}' +
          (f'; {len(leftover)} unmatched line(s) left in place.' if leftover else '.'))


if __name__ == '__main__':
    main()
