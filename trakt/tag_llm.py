#!/usr/bin/env python3
"""
Uses Claude Haiku 4.5 to close the last real gap in BMTRE's subgenre/
tone coverage — titles where inferSubgenres()/inferTones() (engine.js)
already tried keyword matching AND (for tones) overview-text phrase
matching and came back empty. Only reaches titles that pass BOTH free
tiers first, mirroring the book side's tag_with_haiku.py pattern
(Claude Haiku 4.5, cheapest model, workflow_dispatch-only since every
run costs real API credits — Bill's explicit choice after being asked
whether to close this gap with an LLM pass vs. a free-but-lower-
quality genre-only fallback vs. accepting the keyword/overview ceiling
as-is).

Writes to trakt/data/llmTags.json (titleKey -> {subgenres, tones,
taggedAt}), a separate cache never merged into enrichedMetadata.json —
same discipline as omdbMetadata.json/scrapedShowRatings.json, so the
source of every subgenre/tone tag stays traceable. engine.js's
inferSubgenres()/inferTones() consult this as a third, lowest-priority
tier — only when both the keyword and (tones only) overview-text tiers
already returned nothing, never overriding a higher-confidence tag.

Every returned tag is filtered against the exact same canonical
SUBGENRE_KEYWORDS/TONE_KEYWORDS vocabulary keys engine.js already uses
— no invented tags, same guardrail tag_with_haiku.py itself already
uses for the book side's canonical theme/tone vocabulary.

Run manually:   ANTHROPIC_API_KEY=... python3 trakt/tag_llm.py [batch_size]
GitHub Action:  .github/workflows/trakt-tag-llm.yml (manual dispatch only)
"""

import json, os, sys, time, urllib.request
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
DATA_DIR   = ROOT / 'trakt' / 'data'
CACHE_FILE = DATA_DIR / 'llmTags.json'
BATCH_SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 150
API_KEY    = os.environ.get('ANTHROPIC_API_KEY', '')
MODEL      = 'claude-haiku-4-5'

# Exact canonical vocabulary keys from trakt/engine.js's SUBGENRE_KEYWORDS/
# TONE_KEYWORDS — kept in sync by hand (same discipline the book side's
# tag_with_haiku.py already uses for its own canonical vocabulary copy).
#
# Rewritten for the Genre/Subgenre taxonomy redesign (Phase 3): this list
# had already drifted stale before the redesign even started — missing 5
# real SUBGENRE_KEYWORDS buckets (organized-crime/drug-trade/assassin-hitman/
# murder-mystery/police-procedural, added when crime-drama/procedural were
# split in an earlier session) that this constant was never updated for -
# a real, concrete illustration of exactly the hand-sync-burden risk this
# comment already warned about. Now matches engine.js's SUBGENRE_KEYWORDS
# exactly: crime-drama/war/sci-fi-fantasy/sports/horror/biopic retired
# (genre-duplicative, see engine.js's own Phase 0-2 comments), biopic
# renamed to biography, ~41 new curated buckets added from the reviewed
# metadata workbook. Only the canonical (top-level, scored) 65 buckets are
# listed here, not GENRE_DETAIL_KEYWORDS' non-scored display refinements.
SUBGENRES = ['procedural', 'legal', 'heist', 'spy-espionage', 'psychological-thriller',
             'historical', 'political', 'family-drama', 'coming-of-age', 'romance',
             'romcom', 'workplace-comedy', 'dark-comedy', 'superhero', 'medical',
             'prison', 'musical', 'neo-western', 'organized-crime', 'drug-trade',
             'assassin-hitman', 'murder-mystery', 'police-procedural',
             'psychological-drama', 'ensemble', 'workplace-drama', 'neo-noir',
             'character-study', 'crime-thriller', 'biography', 'mystery-drama',
             'military-drama', 'dramedy', 'conspiracy-thriller', 'survival-drama',
             'sitcom', 'satire', 'true-crime', 'anthology', 'docudrama', 'buddy-comedy',
             'post-apocalyptic', 'psychological-horror', 'dystopian', 'supernatural-horror',
             'mockumentary', 'family-comedy', 'journalism-drama', 'time-travel',
             'friendship-comedy', 'crime-comedy', 'action-comedy', 'survival-horror',
             'financial-drama', 'techno-thriller', 'space-opera', 'absurdist-comedy',
             'social-drama', 'creature-feature', 'alien-invasion', 'comedy-mystery',
             'supernatural-mystery', 'chamber-drama', 'disaster-drama', 'horror-comedy']
# Single-valued canonical Genre vocabulary (Phase 1 of the same redesign) -
# the workbook's own 17-value list (drama through adventure). This is the
# LLM tier's real gap-filler for inferGenre()'s classifier (engine.js),
# which measured only ~60% leave-one-out accuracy against the workbook's
# 793 known-correct labels - see inferGenre()'s own comment for why the
# LLM tier is checked BEFORE the deterministic one for Genre specifically,
# unlike Subgenre/Tone's free-tier-first ordering.
GENRES = ['drama', 'comedy', 'thriller', 'crime', 'action', 'science-fiction',
          'fantasy', 'horror', 'mystery', 'war', 'western', 'romance',
          'documentary', 'animation', 'adventure', 'biography', 'sports']
TONES = ['gritty', 'dark', 'witty', 'satirical', 'hilarious', 'inspirational',
          'intense', 'suspenseful', 'twisty', 'slow-burn', 'character-driven',
          'nostalgic', 'melancholy', 'offbeat', 'thoughtful']
# Exact canonical vocabulary from trakt/engine.js's SUBJECT_KEYWORDS keys
# plus SUBJECT_CANONICAL_VOCABULARY's reviewed-only-reachable additions
# (kept in sync by hand, same discipline as SUBGENRES/TONES above). Added
# per the field-quality-subjects Improvement Opportunities finding:
# inferSubjects() (engine.js) already has the exact right 3-tier shape
# (reviewed -> keyword -> llmEntry?.subjects) and is a real, live scoring
# signal (subjectBonus()), but this script never asked for it — the third
# tier was permanently empty even though the consuming code was fully
# wired to use it. Zero extra API cost for any title already selected for
# subgenre/tone tagging; find_llm_tag_gaps.mjs also now selects a title
# purely for a subject gap even when its subgenre/tone are already covered.
SUBJECTS = ['addiction-recovery', 'drug-addiction', 'grief-loss', 'suicide', 'terminal-illness',
            'trauma-abuse', 'domestic-abuse', 'racism-civil-rights', 'historical-atrocities',
            'immigration-refugee', 'infidelity', 'journalism-media', 'cult-extremism',
            'mental-health', 'class-wealth-corporate', 'corporate-power', 'lgbtq', 'survival',
            'ambition-reinvention', 'artistic-creative', 'celebrity-fame', 'crime-consequences',
            'crime-investigation', 'criminal-life', 'crime-syndicate-life', 'deception-secrets',
            'economic-hardship', 'espionage-national-security', 'family-dynamics',
            'fate-and-destiny', 'found-family', 'friendship-community', 'frontier-westward',
            'healthcare-medicine', 'identity-belonging', 'isolation-connection',
            'justice-legal-system', 'law-enforcement', 'loyalty', 'marriage-relationships',
            'parenthood', 'politics-power', 'power-corruption', 'redemption', 'religion-faith',
            'resistance-rebellion', 'revenge', 'sacrifice-duty', 'self-discovery',
            'social-inequality', 'sports-competition', 'supernatural-paranormal',
            'technology-surveillance', 'vigilante-justice', 'war-conflict', 'workplace-culture',
            'wrongful-conviction', 'youth-and-adolescence', 'societal-collapse']


def get_json(url, body, headers, timeout=60):
    """Mirrors enrich_tmdb.py/enrich_omdb.py's get_json() — surfaces the
    real error body on a non-2xx response instead of a bare status code,
    the same fix both sibling enrichment scripts already got this
    session after a real dead-key incident on the TMDB side."""
    import urllib.error
    try:
        req = urllib.request.Request(url, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read()), resp.status, None
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode('utf-8', errors='replace')[:500]
        except Exception:
            err_body = None
        return None, e.code, err_body
    except Exception as e:
        return None, None, str(e)[:500]


def call_haiku(prompt):
    body = json.dumps({
        'model': MODEL,
        'max_tokens': 300,
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()
    headers = {'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
               'content-type': 'application/json'}
    data, status, error_body = get_json('https://api.anthropic.com/v1/messages', body, headers)
    if status == 401:
        print(f'ERROR: Anthropic rejected the API key (401). Response: {error_body!r}. '
              'Check ANTHROPIC_API_KEY and stop.', file=sys.stderr)
        sys.exit(1)
    if not data:
        raise RuntimeError(f'API call failed (status {status}): {error_body}')
    return ''.join(block.get('text', '') for block in data.get('content', [])), status


def tag_title(t):
    meta = t['meta']
    keywords = ', '.join((meta.get('keywords') or [])[:15]) or '(none)'
    overview = (meta.get('overview') or '')[:800] or '(no plot summary available)'
    prompt = f"""Tag this {t['type']} for a personal movie/TV recommendation engine. Respond with ONLY a JSON object, no markdown fences, no preamble.

Title: {t['title']} ({t['year'] or 'year unknown'})
TMDB genres: {', '.join(meta.get('genres') or [])}
TMDB keywords: {keywords}
Plot summary: {overview}

Return exactly this shape:
{{"genre": "...", "subgenres": [...], "tones": [...], "subjects": [...]}}

Rules:
- genre: exactly ONE value chosen ONLY from this list, the single best-fitting high-level genre: {', '.join(GENRES)}
- subgenres: 1-3 values chosen ONLY from this list, most fitting first: {', '.join(SUBGENRES)}
- tones: 1-4 values chosen ONLY from this list, most fitting first: {', '.join(TONES)}
- subjects: 0-3 values chosen ONLY from this list, most fitting first — the real human-condition subject matter underneath the genre/plot (grief, addiction, class, identity, etc.), NOT a restatement of genre or subgenre: {', '.join(SUBJECTS)}
- Base your answer on the actual genres/keywords/plot summary above, not the title alone.
- For genre specifically: TMDB's own genre tags are a starting point, not the final answer - TMDB over-applies "Drama" as a near-universal secondary tag, so don't default to it just because it's present. Pick whichever single value best captures what the story is actually ABOUT.
- For subjects specifically: only pick a value if the plot summary or keywords genuinely support it — an empty array is a normal, correct answer for a large share of plot-driven genre titles that have no deeper human-condition theme beyond their genre (e.g. a straightforward heist or procedural), don't force one.
- If genuinely nothing in a list fits (subgenres/tones/subjects only, genre always needs a pick), return an empty array for it rather than forcing a weak match."""
    raw, _ = call_haiku(prompt)
    raw = raw.strip().removeprefix('```json').removeprefix('```').removesuffix('```').strip()
    out = json.loads(raw)
    genre = out.get('genre') if out.get('genre') in GENRES else None
    subgenres = [s for s in out.get('subgenres', []) if s in SUBGENRES][:3]
    tones = [tn for tn in out.get('tones', []) if tn in TONES][:4]
    subjects = [s for s in out.get('subjects', []) if s in SUBJECTS][:3]
    return genre, subgenres, tones, subjects


def load_titles():
    """Same active-title-set + priority as enrich_tmdb.py/enrich_omdb.py:
    watchlist -> library -> candidatePool, deduped by titleKey. Only
    titles with real TMDB metadata (genres present) are eligible — an
    unenriched stub has nothing to tag from yet."""
    enriched = json.load(open(DATA_DIR / 'enrichedMetadata.json'))
    titles, seen = [], set()
    for name in ('watchlist.json', 'library.json', 'candidatePool.json'):
        p = DATA_DIR / name
        if not p.exists():
            continue
        for t in json.load(open(p)).get('titles', []):
            key = t.get('titleKey')
            if not key or key in seen:
                continue
            meta = enriched.get(key)
            if not meta or not meta.get('genres'):
                continue
            seen.add(key)
            titles.append({'titleKey': key, 'type': t.get('type'),
                            'title': meta.get('title') or t.get('title'),
                            'year': meta.get('year') or t.get('year'), 'meta': meta})
    return titles


def main():
    if not API_KEY:
        print('ERROR: ANTHROPIC_API_KEY is not set.', file=sys.stderr)
        sys.exit(1)

    cache = json.load(open(CACHE_FILE)) if CACHE_FILE.exists() else {}
    all_titles = load_titles()
    # The actual "does the free tier already cover this" filter runs in
    # trakt/find_llm_tag_gaps.mjs (real engine.js logic, not a Python
    # reimplementation) and writes the candidate list this script reads —
    # see that script's own comment for why.
    gaps_file = DATA_DIR / 'llmTagGaps.json'
    if not gaps_file.exists():
        print('ERROR: trakt/data/llmTagGaps.json not found — run '
              '`node trakt/find_llm_tag_gaps.mjs` first to compute which '
              'titles the free tiers actually miss.', file=sys.stderr)
        sys.exit(1)
    gap_keys = set(json.load(open(gaps_file)))
    by_key = {t['titleKey']: t for t in all_titles}
    pending = [by_key[k] for k in gap_keys if k in by_key and k not in cache]

    batch = pending[:BATCH_SIZE]
    print(f'{len(pending)} titles need LLM tagging (free tiers miss both fields), processing {len(batch)}')

    failures = 0
    for i, t in enumerate(batch, 1):
        try:
            genre, subgenres, tones, subjects = tag_title(t)
        except Exception as e:
            failures += 1
            print(f'  [{i}/{len(batch)}] FAIL {t["title"][:45]}: {e}')
            time.sleep(0.4)
            continue
        # genre/subjects are both a real bonus of this same batch, not the
        # reason a title was selected — this script's selection criterion
        # is "free tiers miss subgenres/tones/subjects" (see
        # find_llm_tag_gaps.mjs, extended to include subjects gaps too).
        # inferGenre() (engine.js) checks this llmEntry.genre tier before
        # its own weaker (~60% accuracy) deterministic classifier, and
        # inferSubjects() checks llmEntry.subjects as its own third tier —
        # any title that passes through here gets both, at no extra API
        # cost beyond the subgenre/tone call already being made.
        cache[t['titleKey']] = {'genre': genre, 'subgenres': subgenres, 'tones': tones,
                                 'subjects': subjects, 'taggedAt': time.strftime('%Y-%m-%d')}
        print(f'  [{i}/{len(batch)}] {genre or "no-genre"}/{len(subgenres)}sub/{len(tones)}tone/{len(subjects)}subj | {t["title"][:45]}')
        if i % 25 == 0:
            json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
        time.sleep(0.4)

    json.dump(cache, open(CACHE_FILE, 'w'), indent=1)
    if batch and failures == len(batch):
        print('ERROR: every title in this batch failed — treat as a real failure, not a quiet success.',
              file=sys.stderr)
        sys.exit(1)
    print(f'done: {len(cache)} cached total, {len(batch) - failures} tagged this run')


if __name__ == '__main__':
    main()
