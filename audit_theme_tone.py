#!/usr/bin/env python3
"""
Audits every book's themes/tones against real outside research (not the cached
enrichedMetadata.json description the tagging classifier already used — checking
against the same source it was built from would be circular). Uses Claude with
the web_search tool to research each book for real, then records a verdict.

Deliberately does NOT write corrections directly to the data files — this repo
has hit real JSON-corruption bugs from naive full-file rewrites (Python's
json.dump defaults to ensure_ascii=True, silently escaping every non-ASCII
character repo-wide; ensure_ascii=False is set below for this script's own,
low-risk state file, but themes/tones corrections themselves are written by
scripts/apply_audit_corrections.mjs via the same surgical text-splice technique
proven safe in the Session 16 tone migration). This script only researches and
logs; it never touches goodreadsData.json or candidatePool*.json.

Covers every shelf and every candidate pool — the read shelf and the pools are
just as real as to-read, and Session 15's enrich_isbn.py to-read-only scope bug
is exactly the mistake this script is careful not to repeat.

Requires: ANTHROPIC_API_KEY env var (repo secret in GitHub Actions).

Run manually:   ANTHROPIC_API_KEY=... python3 audit_theme_tone.py [batch_size]
GitHub Action:  .github/workflows/audit-theme-tone.yml (hourly + manual dispatch)
"""

import json, os, sys, time, urllib.request
from pathlib import Path

DATA_DIR    = Path('data')
GD_FILE     = DATA_DIR / 'goodreadsData.json'
STATE_FILE  = DATA_DIR / 'toneThemeAuditState.json'
LOG_FILE    = Path('output') / 'tone-theme-audit-log.jsonl'
BATCH_SIZE  = int(sys.argv[1]) if len(sys.argv) > 1 else 20
API_KEY     = os.environ['ANTHROPIC_API_KEY']
MODEL       = 'claude-sonnet-5'

# Keep in sync with CLAUDE.md's canonical vocabularies and
# scripts/data_quality_report.js's CANONICAL_THEMES / CANONICAL_TONES.
THEMES = ('thriller psychological suspense "domestic suspense" mystery crime noir '
          'horror high-concept spy adventure historical YA romance literary '
          'contemporary speculative sci-fi "social commentary" "narrative nonfiction" '
          'memoir biography "true crime" history "tech history" finance business '
          'sports food "music history" political military psychology humor comedy '
          'legal courtroom')

TONES = ('propulsive compulsive "slow-burn" twisty procedural nonlinear ensemble '
         'dark bleak tense heartwarming poignant inspiring '
         'funny satirical conversational '
         'atmospheric lyrical gritty "character-driven" '
         'revelatory dense thoughtful investigative')

CANON_THEMES = {t.strip('"') for t in THEMES.split()} | {
    'domestic suspense', 'social commentary', 'narrative nonfiction',
    'true crime', 'tech history', 'music history',
}
CANON_TONES = {t.strip('"') for t in TONES.split()} | {'slow-burn', 'character-driven'}

PROMPT_TEMPLATE = """You are auditing a personal book-recommendation dataset for accuracy. Research this book for real using web search (reviews, synopses, professional criticism) — do not rely on training knowledge alone, and do not just restate the current tags back at me.

Book: {title} by {author}

Current themes (genre/subject tags): {themes}
Current tones (how the book reads — pacing/mood/voice/craft, NOT genre): {tones}

Canonical theme vocabulary (only these are valid): {theme_vocab}
Canonical tone vocabulary (only these are valid): {tone_vocab}

Research this specific book, then judge whether the current themes and current tones are accurate. Respond with ONLY a JSON object, no markdown fences, no preamble, in exactly this shape:

{{
  "themes": {{
    "verdict": "accurate" | "inaccurate" | "insufficient_evidence",
    "confidence": "high" | "medium" | "low",
    "suggested": [...] or null,
    "reasoning": "one paragraph, cite what you found",
    "sources": ["url", ...]
  }},
  "tones": {{
    "verdict": "accurate" | "inaccurate" | "insufficient_evidence",
    "confidence": "high" | "medium" | "low",
    "suggested": [...] or null,
    "reasoning": "one paragraph, cite what you found",
    "sources": ["url", ...]
  }}
}}

Rules:
- Use "insufficient_evidence" honestly if the book is too obscure to find real reviews/synopses for — do not force a guess.
- "suggested" (only when verdict is "inaccurate"): 2-5 values from the theme vocabulary, or 2-4 values from the tone vocabulary, exact strings only.
- Themes describe genre/subject (what the book is about). Tones describe how it reads — pacing, mood, voice, craft — and apply across fiction and nonfiction alike; don't confuse the two.
- "high" confidence means you found clear, specific, corroborating evidence (e.g. multiple reviews agreeing, or the book's own official description contradicting the current tag). "medium"/"low" for anything you're inferring or only loosely supported."""


def call_claude(prompt):
    body = json.dumps({
        'model': MODEL,
        'max_tokens': 1500,
        'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 4}],
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages', data=body,
        headers={'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
                 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    # Server-side web_search runs inside this one call; the final answer is the
    # LAST text block (earlier blocks may be server_tool_use/web_search_tool_result).
    text_blocks = [b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text']
    if not text_blocks:
        raise ValueError(f'no text block in response: {data}')
    return text_blocks[-1].strip()


def sanitize_side(side, count_range):
    """Downgrade to needs-review if the model's own suggestion breaks the rules
    it was given — never let a bad suggestion slip through on confidence alone."""
    if side.get('verdict') != 'inaccurate':
        return side
    suggested = side.get('suggested')
    vocab = CANON_THEMES if count_range == (2, 5) else CANON_TONES
    lo, hi = count_range
    valid = (isinstance(suggested, list) and lo <= len(suggested) <= hi
             and all(isinstance(s, str) and s in vocab for s in suggested))
    if not valid:
        side['confidence'] = 'low'
        side['reasoning'] = (side.get('reasoning', '') +
                              ' [downgraded: suggested value failed vocabulary/count validation]')
    return side


def audit_book(book):
    prompt = PROMPT_TEMPLATE.format(
        title=book.get('title', ''), author=book.get('author', ''),
        themes=json.dumps(book.get('themes') or []),
        tones=json.dumps(book.get('tones') or []),
        theme_vocab=THEMES, tone_vocab=TONES,
    )
    raw = call_claude(prompt)
    raw = raw.removeprefix('```json').removeprefix('```').removesuffix('```').strip()
    verdict = json.loads(raw)
    verdict['themes'] = sanitize_side(verdict['themes'], (2, 5))
    verdict['tones'] = sanitize_side(verdict['tones'], (2, 4))
    return verdict


def load_books():
    with open(GD_FILE) as f:
        gd = json.load(f)
    books = list(gd['books'])
    for path in sorted(DATA_DIR.glob('candidatePool*.json')):
        with open(path) as f:
            books += json.load(f).get('candidates', [])
    return books


def main():
    state = json.load(open(STATE_FILE)) if STATE_FILE.exists() else {}
    all_books = load_books()
    pending = [b for b in all_books if b.get('bookKey') and b['bookKey'] not in state]
    batch = pending[:BATCH_SIZE]
    print(f'{len(pending)} of {len(all_books)} books not yet audited, processing {len(batch)}')

    if not batch:
        print('backlog clear — nothing to do (consider disabling the scheduled workflow)')
        return

    Path('output').mkdir(exist_ok=True)
    log_lines = []
    failures = 0
    for i, b in enumerate(batch, 1):
        try:
            verdict = audit_book(b)
        except Exception as e:
            print(f'  [{i}/{len(batch)}] FAIL {b["title"][:45]}: {e}')
            failures += 1
            time.sleep(1)
            continue
        entry = {
            'bookKey': b['bookKey'], 'title': b.get('title'), 'author': b.get('author'),
            'auditedAt': time.strftime('%Y-%m-%d'),
            'currentThemes': b.get('themes') or [], 'currentTones': b.get('tones') or [],
            'themes': verdict['themes'], 'tones': verdict['tones'],
            'applied': {'themes': False, 'tones': False},
            # Whether scripts/apply_audit_corrections.mjs has flipped this
            # book's themeToneReviewed flag to true yet (it does this for
            # every audited book, not just ones with a data correction —
            # the flag tracks audit coverage, not correction status).
            'reviewFlagSet': False,
        }
        log_lines.append(json.dumps(entry, ensure_ascii=False))
        state[b['bookKey']] = {'auditedAt': entry['auditedAt']}
        tv, nv = verdict['themes']['verdict'], verdict['tones']['verdict']
        print(f'  [{i}/{len(batch)}] themes={tv} tones={nv} | {b["title"][:45]}')
        time.sleep(0.5)

    if log_lines:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write('\n'.join(log_lines) + '\n')
        json.dump(state, open(STATE_FILE, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print(f'done: {len(log_lines)} books audited this run, {len(state)} total audited')

    # A batch where every single book failed almost certainly means something
    # systemic (bad/missing ANTHROPIC_API_KEY, API outage) rather than 20
    # unrelated per-book flukes. Fail the job loudly instead of reporting a
    # quiet "success" that did zero real work -- this exact silent-failure
    # shape is what happened on this workflow's first real runs.
    if failures and failures == len(batch):
        sys.exit(f'All {failures} book(s) in this batch failed — likely a systemic '
                  f'problem (check ANTHROPIC_API_KEY), not per-book flukes.')


if __name__ == '__main__':
    main()
