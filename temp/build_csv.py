#!/usr/bin/env python3
"""
Builds to-read-review.csv from all sources:
  - goodreadsData.json  (shelf=to-read)
  - candidatePool*.json (all candidate pool books not already read)
Scores come from toread_scores.json (combined-pool BBRE run).
Existing "Why" text and Keep notes are preserved from the old CSV.
"""
import csv, json, re, glob
from pathlib import Path

BASE = Path(__file__).parent.parent
SCORES_FILE  = BASE / 'temp/toread_scores.json'
OLD_CSV      = BASE / 'temp/to-read-review.csv'
OUT_CSV      = BASE / 'temp/to-read-review.csv'

# ── helpers ───────────────────────────────────────────────────────────────────

def norm_key(title, author):
    t = re.sub(r'\s*[:({\[].*', '', str(title)).strip().lower()
    t = re.sub(r'\s*\(.*?\)\s*$', '', t).strip()
    a = re.sub(r'\s+', ' ', str(author).split(',')[0]).strip().lower()
    return f'{t}|||{a}'

def fmt_list(lst):
    return ', '.join(lst) if lst else ''

def similar_to(book):
    parts = []
    for t in (book.get('similarToTitles') or [])[:2]:
        parts.append(t)
    for a in (book.get('similarToAuthors') or [])[:1]:
        if a not in parts:
            parts.append(a)
    return ', '.join(parts)

def why_like(book):
    themes = [t.lower() for t in (book.get('themes') or [])]
    btype  = (book.get('type') or 'unknown').lower()
    sim_a  = (book.get('similarToAuthors') or [])
    anchor = sim_a[0] if sim_a else ''

    if btype == 'fiction':
        if any(x in themes for x in ['thriller', 'mystery', 'suspense', 'crime']):
            base = 'Fast-paced thriller'
        elif any(x in themes for x in ['horror', 'psychological']):
            base = 'Psychological/horror fiction'
        elif any(x in themes for x in ['historical', 'historical fiction']):
            base = 'Historical fiction with rich atmosphere'
        elif any(x in themes for x in ['speculative', 'sci-fi', 'science fiction', 'fantasy']):
            base = 'Inventive speculative premise'
        elif any(x in themes for x in ['literary', 'coming-of-age']):
            base = 'Character-driven literary fiction'
        else:
            base = 'Engaging fiction'
    else:  # nonfiction / unknown
        if any(x in themes for x in ['memoir', 'autobiography']):
            base = 'Personal, candid memoir'
        elif any(x in themes for x in ['biography']):
            base = 'In-depth biography'
        elif any(x in themes for x in ['true crime']):
            base = 'Gripping true crime narrative'
        elif any(x in themes for x in ['finance', 'wall street', 'business']):
            base = 'Narrative nonfiction — reads like a novel about finance'
        elif any(x in themes for x in ['tech', 'tech history', 'science']):
            base = 'Narrative nonfiction — reads like a novel about tech/science'
        elif any(x in themes for x in ['history', 'narrative nonfiction']):
            base = 'Narrative nonfiction with a propulsive story'
        elif any(x in themes for x in ['sports']):
            base = 'Sports narrative with broad appeal'
        elif any(x in themes for x in ['self-help', 'psychology', 'behavioral']):
            base = 'Accessible behavioral science'
        else:
            base = 'Well-regarded nonfiction'

    if anchor:
        return f'{base}. If you like {anchor}, this hits the same notes.'
    return f'{base}.'

def why_not(book):
    rating = book.get('avgRating') or 0
    btype  = (book.get('type') or 'unknown').lower()
    themes = [t.lower() for t in (book.get('themes') or [])]

    if rating and rating < 3.7:
        return f'Below-average community rating ({rating}/5) — may underdeliver.'
    if rating and rating < 3.9:
        desc = ''
        if btype == 'nonfiction':
            if any(x in themes for x in ['finance', 'business', 'economics']):
                desc = 'Nonfiction with dense material — requires focus.'
            elif any(x in themes for x in ['memoir', 'biography']):
                desc = 'Memoir/biography pacing can be slow.'
            else:
                desc = 'Nonfiction with dense material — requires focus.'
        elif btype == 'fiction':
            if any(x in themes for x in ['literary']):
                desc = 'Character-driven literary fiction — light on plot momentum.'
            else:
                desc = 'Mixed reader reactions.'
        return f'Modest rating ({rating}/5). {desc}'.strip()
    return 'No obvious red flags — depends on your mood.'

# ── load data ─────────────────────────────────────────────────────────────────

scores = json.load(open(SCORES_FILE))

goodreads = json.load(open(BASE / 'data/goodreadsData.json'))
read_keys    = {norm_key(b['title'], b['author']) for b in goodreads['books'] if b.get('shelf') == 'read'}
to_read_books = [b for b in goodreads['books'] if b.get('shelf') == 'to-read']

# Load existing CSV to preserve "Why" text and Keep notes
old_why_like = {}
old_why_not  = {}
old_keep     = {}
if OLD_CSV.exists():
    with open(OLD_CSV, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            nk = norm_key(row['Title'], row['Author'])
            old_why_like[nk] = row.get("Why Youd Like It", '')
            old_why_not[nk]  = row.get("Why You Might Not", '')
            old_keep[nk]     = row.get("Keep (Y/N/Maybe)", '')

# ── build rows ────────────────────────────────────────────────────────────────

FIELDNAMES = [
    'Source', 'Title', 'Author', 'Type', 'Themes', 'Tones',
    'Avg Rating', 'Pages', 'Year', 'Date Added', 'Similar To',
    'BBRE Score', 'Why Youd Like It', 'Why You Might Not', 'Keep (Y/N/Maybe)',
]

rows = []

# 1. To-read books
for b in to_read_books:
    nk = norm_key(b['title'], b['author'])
    exact = f"{b['title']}|||{b['author']}"
    score = scores.get(exact) or scores.get(nk) or 'N/A'
    rows.append({
        'Source':           'to-read',
        'Title':            b['title'],
        'Author':           b['author'],
        'Type':             b.get('type', 'unknown'),
        'Themes':           fmt_list(b.get('themes')),
        'Tones':            fmt_list(b.get('tones')),
        'Avg Rating':       b.get('avgRating', ''),
        'Pages':            b.get('pages', ''),
        'Year':             b.get('year', ''),
        'Date Added':       b.get('dateAdded', ''),
        'Similar To':       similar_to(b),
        'BBRE Score':       score,
        'Why Youd Like It': old_why_like.get(nk) or why_like(b),
        'Why You Might Not':old_why_not.get(nk)  or why_not(b),
        'Keep (Y/N/Maybe)': old_keep.get(nk, ''),
    })

# 2. Candidate pool books (skip already-read and already-in-to-read)
toread_nkeys = {norm_key(b['title'], b['author']) for b in to_read_books}
seen_cand_keys = set()

for fn in sorted(glob.glob(str(BASE / 'data/candidatePool*.json'))):
    d = json.load(open(fn))
    for b in d.get('candidates', []):
        nk = norm_key(b['title'], b['author'])
        if nk in read_keys or nk in toread_nkeys or nk in seen_cand_keys:
            continue
        seen_cand_keys.add(nk)
        exact = f"{b['title']}|||{b['author']}"
        score = scores.get(exact) or scores.get(nk) or 'N/A'
        rows.append({
            'Source':           'candidate pool',
            'Title':            b['title'],
            'Author':           b['author'],
            'Type':             b.get('type', 'unknown'),
            'Themes':           fmt_list(b.get('themes')),
            'Tones':            fmt_list(b.get('tones')),
            'Avg Rating':       b.get('avgRating', ''),
            'Pages':            b.get('pages', ''),
            'Year':             b.get('year', ''),
            'Date Added':       '',
            'Similar To':       similar_to(b),
            'BBRE Score':       score,
            'Why Youd Like It': why_like(b),
            'Why You Might Not':why_not(b),
            'Keep (Y/N/Maybe)': '',
        })

# Sort by BBRE score descending (N/A last)
def sort_key(r):
    s = r['BBRE Score']
    return -int(s) if str(s).lstrip('-').isdigit() else 1

rows.sort(key=sort_key)

with open(OUT_CSV, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
    writer.writeheader()
    writer.writerows(rows)

to_read_count = sum(1 for r in rows if r['Source'] == 'to-read')
cand_count    = sum(1 for r in rows if r['Source'] == 'candidate pool')
print(f'Written {len(rows)} rows: {to_read_count} to-read, {cand_count} candidate pool')
print(f'Output: {OUT_CSV}')
