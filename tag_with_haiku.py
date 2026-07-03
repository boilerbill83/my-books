#!/usr/bin/env python3
"""
Uses Claude Haiku 4.5 (Anthropic's cheapest model) to re-tag books from
their real descriptions fetched by enrich_metadata.py.

For each to-read book with a description, Haiku returns:
  - themes: 2-5 tags from the canonical vocabulary only
  - tones:  up to 3 tone tags from the canonical tone list
  - similarToTitles: 3-5 picks FROM THE USER'S 5-STAR READ LIST ONLY,
    guaranteeing every entry matches a dataset title exactly
    (feeds engine.js's +8 forward-title signal directly)

Only writes fields that come back valid; existing data is never blanked.
Requires: ANTHROPIC_API_KEY env var (repo secret in GitHub Actions).

Run manually:   ANTHROPIC_API_KEY=... python3 tag_with_haiku.py [batch_size]
GitHub Action:  .github/workflows/tag-books.yml (manual dispatch)
"""

import json, os, sys, time, urllib.request
from pathlib import Path

DATA_DIR   = Path('data')
GD_FILE    = DATA_DIR / 'goodreadsData.json'
META_FILE  = DATA_DIR / 'enrichedMetadata.json'
STATE_FILE = DATA_DIR / 'haikuTagged.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 100
API_KEY    = os.environ['ANTHROPIC_API_KEY']
MODEL      = 'claude-haiku-4-5'

THEMES = ('thriller psychological suspense "domestic suspense" mystery crime noir '
          'horror high-concept spy adventure historical YA romance literary '
          'contemporary speculative sci-fi "social commentary" "narrative nonfiction" '
          'memoir biography "true crime" history "tech history" finance business '
          'sports food "music history" political military psychology humor comedy')

TONES = 'twisty compulsive tense dark funny warm bleak thoughtful revelatory conversational propulsive atmospheric'


def call_haiku(prompt):
    body = json.dumps({
        'model': MODEL,
        'max_tokens': 400,
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages', data=body,
        headers={'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
                 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    return ''.join(block.get('text', '') for block in data.get('content', []))


def tag_book(book, meta, five_star_titles):
    prompt = f"""Tag this book for a personal recommendation engine. Respond with ONLY a JSON object, no markdown fences, no preamble.

Book: {book['title']} by {book['author']}
Description: {meta.get('description', '')[:1200]}
Google categories: {', '.join(meta.get('categories', []))}
Open Library subjects: {', '.join(meta.get('subjects', [])[:8])}

Return exactly this shape:
{{"themes": [...], "tones": [...], "similarToTitles": [...]}}

Rules:
- themes: 2-5 values chosen ONLY from: {THEMES}
- tones: up to 3 values chosen ONLY from: {TONES}
- similarToTitles: the 3-5 books from the list below MOST similar to this book in genre, tone, and appeal. Copy titles character-for-character. If fewer than 3 are genuinely similar, return fewer.

Five-star list:
{chr(10).join(five_star_titles)}"""
    raw = call_haiku(prompt).strip()
    raw = raw.removeprefix('```json').removeprefix('```').removesuffix('```').strip()
    out = json.loads(raw)
    canon_themes = set(THEMES.replace('"', ' " ').split()) | {
        'domestic suspense', 'social commentary', 'narrative nonfiction',
        'true crime', 'tech history', 'music history'}
    themes = [t for t in out.get('themes', []) if t in canon_themes][:5]
    tones  = [t for t in out.get('tones', []) if t in TONES.split()][:3]
    titles = [t for t in out.get('similarToTitles', []) if t in five_star_titles][:5]
    return themes, tones, titles


def main():
    gd    = json.load(open(GD_FILE))
    meta  = json.load(open(META_FILE)) if META_FILE.exists() else {}
    state = json.load(open(STATE_FILE)) if STATE_FILE.exists() else {}

    five_star = sorted(b['title'] for b in gd['books']
                       if b.get('shelf') == 'read' and b.get('myRating') == 5)

    targets = [b for b in gd['books']
               if b.get('shelf') == 'to-read'
               and b.get('bookKey') not in state
               and meta.get(b.get('bookKey'), {}).get('description')]
    batch = targets[:BATCH_SIZE]
    print(f'{len(targets)} to-read books taggable, processing {len(batch)}')

    changed = 0
    for i, b in enumerate(batch, 1):
        try:
            themes, tones, titles = tag_book(b, meta[b['bookKey']], five_star)
        except Exception as e:
            print(f'  [{i}] FAIL {b["title"][:40]}: {e}')
            continue
        if len(themes) >= 2:
            b['themes'] = themes
        if tones:
            b['tones'] = tones
        if len(titles) > len(b.get('similarToTitles') or []):
            b['similarToTitles'] = titles
        state[b['bookKey']] = {'taggedAt': time.strftime('%Y-%m-%d'),
                               'titles': len(titles)}
        changed += 1
        print(f'  [{i}/{len(batch)}] {len(themes)}th/{len(tones)}to/{len(titles)}sim | {b["title"][:45]}')
        time.sleep(0.5)

    if changed:
        json.dump(gd, open(GD_FILE, 'w'), indent=1)
        json.dump(state, open(STATE_FILE, 'w'), indent=1)
    print(f'done: {changed} books updated')


if __name__ == '__main__':
    main()
