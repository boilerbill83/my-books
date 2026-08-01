#!/usr/bin/env node
// Data quality report focused on BBRE recommendation quality, not just
// extract completeness: which specific books, if fixed, would actually
// change what gets recommended. Field-level population/quality scoring
// (Field Name, Percent Populated, Quality Score, How Score is Determined,
// Suggestions for Improvement) via FIELD_REGISTRY is still here, but the
// report leads with BBRE-impact findings — foundational 5-star-read
// signal gaps, already-read books sitting in a candidate pool, high-
// leverage candidates flying under the radar due to missing data, and a
// per-book impact score. Writes a dated Markdown report to
// output/data-quality-report-YYYY-MM-DD.md, plus a machine-readable
// output/data-quality-report-YYYY-MM-DD.json snapshot (dashboard-ready:
// full structured findings, not just counts) used for trending over time.
// Runs daily via .github/workflows/data-quality-report.yml. Run manually
// from repo root: node scripts/data_quality_report.js

import fs from 'fs';
import path from 'path';
import { loadAllBooks, norm } from './lib/loadData.js';
import { computeEvalMetrics } from './eval.js';

// Keep in sync with CLAUDE.md's "Canonical theme vocabulary" section.
// "legal"/"courtroom" promoted to canonical (Session 14) — 142 combined uses,
// well past the ≥5 promotion threshold, and already load-bearing in app.js's
// THEME_MACROS "Legal" filter chip.
const CANONICAL_THEMES = new Set([
  'thriller', 'psychological', 'suspense', 'domestic suspense', 'mystery', 'crime',
  'noir', 'horror', 'high-concept', 'spy', 'adventure', 'historical', 'YA', 'romance',
  'contemporary', 'speculative', 'sci-fi', 'social commentary', 'legal',
  'courtroom',
  'memoir', 'biography', 'true crime', 'history', 'tech history',
  'finance', 'business', 'sports', 'food', 'music history', 'political', 'military',
  'psychology', 'humor', 'comedy',
]);

// Keep in sync with CLAUDE.md's "Canonical Tone Vocabulary" section and
// bbreEngine.js's THEME_TONES_MAP/TONE_PRIORITY (Session 16 redesign — 24
// tones, none used on more than 15% of the dataset, replacing the 39-tag
// free-for-all this same check would have caught earlier had it existed).
const CANONICAL_TONES = new Set([
  'propulsive', 'compulsive', 'slow-burn', 'twisty', 'procedural', 'nonlinear', 'ensemble',
  'dark', 'bleak', 'tense', 'heartwarming', 'poignant', 'inspiring',
  'funny', 'satirical', 'conversational',
  'atmospheric', 'lyrical', 'gritty', 'character-driven',
  'revelatory', 'dense', 'thoughtful', 'investigative',
]);

// Themes (genre/subject) and tones (how a book reads) must stay two clearly
// distinct vocabularies — fail loudly at load time if they ever collide,
// rather than silently letting the two signals blur together.
{
  const overlap = [...CANONICAL_THEMES].filter(t => CANONICAL_TONES.has(t));
  if (overlap.length) {
    throw new Error(`CANONICAL_THEMES and CANONICAL_TONES share value(s): ${overlap.join(', ')} — themes and tones must stay disjoint vocabularies.`);
  }
}

// Mirrors engine.js's norm() (bbreEngine/rateEngine title matching all route
// through this format) — strips parenthetical series/edition notation
// before comparing, so "The Firm" vs "The Firm (The Firm, #1)" is treated
// as a match here exactly like it is in the actual scoring engine. Using
// loadData.js's plain trim+lowercase norm() instead would over-report
// broken references that the engine already resolves fine.
function engineNorm(v) {
  return String(v || '')
    .replace(/&amp;/gi, '&')
    .toLowerCase()
    .trim()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

const { rows } = loadAllBooks();

const SHELVES = ['to-read', 'read', 'currently-reading', 'candidate-pool'];
const isEmpty = v => v === '' || v == null || (Array.isArray(v) && v.length === 0);
const isFiveStarRead = r => r.shelf === 'read' && r.myRating === 5;
const isHighLeverageShelf = r => r.shelf === 'to-read' || r.shelf === 'candidate-pool';
const HIGH_LEVERAGE_AVG_RATING = 4.0;
const HIGH_LEVERAGE_RATINGS_COUNT = 10000;

// ── Field registry ───────────────────────────────────────────────────────────
// Quality Score is population % measured against the ELIGIBLE subset of rows
// for that field, not the full 1117 — a field that structurally only applies
// to read books (myRating) or is only targeted by one enrichment job for
// certain shelves (coverUrl, amazonRating) would otherwise look like a
// "gap" when it's actually complete for the rows it applies to. Percent
// Populated (raw, of all rows) is kept alongside so the difference is
// visible. `critical: true` marks fields that directly feed a BBRE/engine
// scoring signal (CLAUDE.md "Engine Summary" table) — these get a lower
// (stricter) warning threshold, surface first in Action Items, and are
// what the per-book Impact Score is computed from, since a gap here
// actually degrades recommendations rather than just leaving the extract
// incomplete. Eligibility scopes and suggestions below are the root causes
// diagnosed in CLAUDE.md Session 13b-13e — update this registry, not just
// the data, when a new enrichment job changes scope.
const inShelves = (...shelves) => r => shelves.includes(r.shelf);
const always = () => true;
const isAttempted = r => !isEmpty(r.metadataFetchedAt);
const isDismissed = r => r.dismissed === true;
const preISBN13Era = r => !r.year || r.year < 2007;

const FIELD_REGISTRY = {
  bookKey: {
    critical: true,
    eligible: always,
    how: 'Population % of all books with a real slug bookKey (not the "title|||author" derived-key fallback, which enrich_metadata.py cannot use).',
    suggest: n => n.missing ? `Backfill a real bookKey (same slug convention as existing keys) on the ${n.missing} book(s) still using the fallback — they're invisible to the daily metadata job until fixed.` : 'None needed.',
  },
  title: { eligible: always, how: 'Always required; % of rows with a non-empty title.', suggest: () => 'None needed.' },
  author: { critical: true, eligible: always, how: 'Always required; % of rows with a non-empty author — feeds the 5-star-author and similar-author bonuses.', suggest: () => 'None needed.' },
  source: { eligible: always, how: 'Set programmatically by the loader for every row.', suggest: () => 'None needed.' },
  shelf: { critical: true, eligible: always, how: 'Set from goodreadsData.json/candidate pools for every row — drives the fromToRead base score.', suggest: () => 'None needed.' },
  type: { eligible: always, how: '% of all books tagged fiction/nonfiction.', suggest: () => 'Spot-check any untagged rows via the publisher-category audit pattern used in Session 13.' },
  year: { eligible: always, how: '% of all books with a publication year.', suggest: () => 'Low-volume gap; backfill manually or via Google Books lookup if any recommendations are missing it.' },
  pages: {
    critical: true,
    eligible: always,
    how: '% of all books with a non-zero page count — zero/missing silently disables the pages-fit scoring bonus (CLAUDE.md quality rule).',
    suggest: n => n.missing ? `${n.missing} book(s) missing pages — the pages-fit bonus never fires for them. Backfill from Google Books/ISBN lookup.` : 'None needed.',
  },
  myRating: {
    critical: true,
    eligible: inShelves('read'),
    how: '% of READ-shelf books with a rating — to-read/candidate books are unrated by definition, so they are excluded from the denominator. Feeds the 5-star-author bonus and authorRatingWeight directly.',
    suggest: n => n.missing ? `${n.missing} read book(s) have no rating — check for import gaps or unrated DNFs.` : 'None needed; this is a read-only field.',
  },
  avgRating: { critical: true, eligible: always, how: '% of all books with a Goodreads community average — feeds the (avgRating-3.5)*10 community-rating score term.', suggest: () => 'None needed.' },
  ratingsCount: {
    critical: true,
    eligible: always,
    how: '% of all books with a positive ratingsCount — zero/missing silently disables the popularity bonus (CLAUDE.md quality rule).',
    suggest: n => n.missing ? `${n.missing} book(s) have zero/missing ratingsCount — backfill via Google Books/Goodreads lookup so the popularity bonus can fire.` : 'None needed.',
  },
  amazonRating: {
    eligible: inShelves('to-read', 'candidate-pool'),
    how: '% of to-read/candidate-pool books scraped by scrape_ratings.py that returned a real rating (source=="amazon") — already-read books are never scraped since the engine never recommends them, so they are excluded from the denominator.',
    suggest: n => n.missing ? `${n.missing} book(s) in the eligible pool have no Amazon rating. As of Session 13d these are retried automatically after a ${'`RETRY_COOLDOWN_DAYS`'} cooldown instead of being cached as permanent misses — re-check after a few scheduled runs before investigating further.` : 'None needed.',
  },
  amazonRatingsCount: {
    eligible: inShelves('to-read', 'candidate-pool'),
    how: 'Same eligibility and mechanism as amazonRating (written together by scrape_ratings.py).',
    suggest: n => n.missing ? 'Same as amazonRating — tracks it exactly.' : 'None needed.',
  },
  isbn: {
    eligible: preISBN13Era,
    how: '% of books published before 2007 (when ISBN-13 became the sole standard) with an ISBN-10. Post-2007 books are excluded from the denominator since most were never issued one.',
    suggest: n => n.missing ? `${n.missing} pre-2007 book(s) missing ISBN-10 — isbn13 (the modern identifier) is the field that actually matters; only chase this if isbn13 is also missing for the same book.` : 'None needed — isbn13 is the field to watch instead.',
  },
  isbn13: {
    eligible: always,
    how: '% of all books with an ISBN-13 — enrich_isbn.py only targets to-read/candidate shelves, so read-shelf gaps rely on the original Goodreads import.',
    suggest: n => n.missing ? `${n.missing} book(s) missing isbn13. If concentrated on the read shelf, extend enrich_isbn.py to also backfill read books (currently out of scope by design).` : 'None needed.',
  },
  publisher: { eligible: always, how: '% of all books with a publisher.', suggest: () => 'Backfill gaps via Google Books lookup if needed for the extract; not used by the scoring engine.' },
  dateRead: {
    eligible: inShelves('read'),
    how: '% of READ-shelf books with a read date — to-read/candidate books have none by definition.',
    suggest: n => n.missing ? `${n.missing} read book(s) missing a read date — check for legacy import gaps.` : 'None needed; this is a read-only field.',
  },
  dateAdded: { eligible: always, how: '% of all books with a dateAdded.', suggest: () => 'Low-volume gap; not used by scoring, cosmetic only.' },
  themes: {
    critical: true,
    eligible: always,
    how: '% of all books with at least one theme tag — feeds fiveStarThemes/themeBonus scoring directly.',
    suggest: n => n.missing ? `${n.missing} book(s) have zero themes — tag from canonical vocabulary (see CLAUDE.md) so themeBonus can fire.` : 'None needed.',
  },
  tones: { eligible: always, how: '% of all books with at least one tone tag.', suggest: n => n.missing ? `${n.missing} book(s) missing tones — mostly candidate-pool books never processed by tag_with_haiku.py.` : 'None needed.' },
  similarToTitles: {
    critical: true,
    eligible: always,
    how: '% of all books with at least one similarToTitles entry — feeds the forward/reverse title-match scoring signals.',
    suggest: n => n.missing ? `${n.missing} book(s) have none — see the Broken References section below for entries that exist but don't resolve.` : 'None needed; also check the broken-references count below.',
  },
  similarToAuthors: {
    critical: true,
    eligible: always,
    how: '% of all books with at least one similarToAuthors entry — feeds the similar-author bonus.',
    suggest: n => n.missing ? `${n.missing} book(s) missing — lower priority than similarToTitles (smaller scoring weight).` : 'None needed.',
  },
  categories: {
    eligible: isAttempted,
    how: '% of books ALREADY ATTEMPTED by enrich_metadata.py (has a metadataFetchedAt) that got a category back from Google Books — separates "not yet attempted" (backlog) from "attempted, no data."',
    suggest: n => n.missing ? `${n.missing} attempted book(s) got no category — Google Books coverage gap, not fixable by retrying with current logic.` : 'None needed.',
  },
  subjects: {
    eligible: isAttempted,
    how: '% of books ALREADY ATTEMPTED by enrich_metadata.py that got subject tags from Open Library — separates backlog from real Open Library coverage gaps.',
    suggest: n => n.missing ? `${n.missing} attempted book(s) got no subjects — real Open Library coverage gap (varies 60-95% by book type per Session 13e analysis); not worth chasing further without a different data source.` : 'None needed.',
  },
  description: {
    eligible: always,
    how: '% of all books with a description — the daily enrich_metadata.py job processes 150/run in to-read → read → candidates priority order, so this rises as the backlog clears.',
    suggest: n => n.missing ? `${n.missing} book(s) still pending or with no description found by Google Books/Open Library. Check the candidate-pool backlog specifically — it's processed last.` : 'None needed.',
  },
  metadataFetchedAt: { eligible: always, how: '% of all books already attempted by enrich_metadata.py — this IS the backlog-cleared indicator for categories/subjects/description above.', suggest: n => n.missing ? `${n.missing} book(s) not yet attempted — will clear at 150/day, prioritizing to-read then read then candidates.` : 'Backlog fully cleared.' },
  dismissed: { eligible: always, how: 'Always set true/false by the loader; not a sparsity signal itself.', suggest: () => 'None needed.' },
  dismissReason: {
    eligible: isDismissed,
    how: '% of ACTUALLY DISMISSED books (dismissed==true) that have a reasonLabel — scoring against all 1117 books would be misleading since only ~2% have any feedback at all by design.',
    suggest: n => n.missing ? `${n.missing} dismissed book(s) have a reasonCode but no reasonLabel in feedbackData.json — backfill the label or have the extract fall back to reasonCode.` : 'None needed.',
  },
  coverUrl: {
    eligible: inShelves('to-read', 'candidate-pool', 'currently-reading'),
    how: '% of books on shelves enrich_covers.py actually targets (to-read/candidates/currently-reading) with a cover — read-shelf books are excluded from the denominator since that job skips them by design.',
    suggest: n => n.missing ? `${n.missing} book(s) in the eligible pool still missing a cover — re-run enrich_covers.py. Read-shelf covers are a separate, larger gap outside this job's current scope (raised in Session 13e, not yet actioned).` : 'None needed within current scope.',
  },
  goodreadsUrl: { eligible: always, how: 'Constructed at export time from goodreadsUrl → bookId → search-URL fallback (Session 13b) — always resolvable.', suggest: () => 'None needed.' },
  top10: { eligible: always, how: 'A deliberately rare curated "featured" flag used by the UI\'s top-10 filter — not meant to be broadly populated.', suggest: () => 'None needed; low population is by design.' },
};

const fields = Object.keys(rows[0]);
const WARN_THRESHOLD = 80;
const CRITICAL_WARN_THRESHOLD = 90;
// The subset of critical fields that actually drive the per-book Impact
// Score below — bookKey/author/shelf are near-universal structural fields
// (population is basically 100% after Session 13b's backfill) so a gap on
// any *specific* book is either impossible or a data-entry emergency
// already covered elsewhere; the impact score focuses on the fields whose
// per-book presence genuinely varies and genuinely changes that book's score.
const IMPACT_FIELDS = ['themes', 'similarToTitles', 'similarToAuthors', 'pages', 'ratingsCount', 'avgRating', 'myRating'];

function scoreLabel(pct) {
  if (pct >= 95) return 'Excellent';
  if (pct >= 80) return 'Good';
  if (pct >= 60) return 'Fair';
  return 'Poor';
}

function populationStats() {
  const stats = fields.map(f => {
    const reg = FIELD_REGISTRY[f] || { eligible: always, how: 'No registry entry — scored against all rows.', suggest: () => 'Add this field to FIELD_REGISTRY in scripts/data_quality_report.js.' };
    const raw = rows.filter(r => !isEmpty(r[f]));
    const eligible = rows.filter(reg.eligible);
    const eligiblePopulated = eligible.filter(r => !isEmpty(r[f]));
    const scorePct = eligible.length ? 100 * eligiblePopulated.length / eligible.length : 100;
    const rawPct = 100 * raw.length / rows.length;
    const critical = Boolean(reg.critical);
    const threshold = critical ? CRITICAL_WARN_THRESHOLD : WARN_THRESHOLD;
    return {
      field: f,
      rawPct,
      scorePct,
      critical,
      belowThreshold: scorePct < threshold,
      eligibleTotal: eligible.length,
      eligiblePopulated: eligiblePopulated.length,
      how: reg.how,
      suggest: reg.suggest({ missing: eligible.length - eligiblePopulated.length }),
    };
  });
  return stats.sort((a, b) => a.scorePct - b.scorePct);
}

// ── BBRE-impact checks ───────────────────────────────────────────────────────

// fiveStarThemes/fiveStarAuthors/reverseSimilar are built ENTIRELY from
// 5-star reads — a gap here doesn't just under-describe one book, it
// silently withholds a bonus every candidate that actually deserves it
// should be getting. This is the highest-leverage data-quality issue in
// the whole dataset and gets its own top-priority section.
function findFiveStarSignalGaps() {
  return rows
    .filter(isFiveStarRead)
    .map(r => {
      const missing = [];
      if (isEmpty(r.themes)) missing.push('themes');
      if (isEmpty(r.similarToTitles)) missing.push('similarToTitles');
      if (isEmpty(r.similarToAuthors)) missing.push('similarToAuthors');
      return { title: r.title, author: r.author, missing };
    })
    .filter(x => x.missing.length > 0);
}

// Already-read books still sitting in a candidate pool are a direct
// correctness bug, not a completeness stat — Bill could be recommended a
// book he's already read (and rated).
function findAlreadyReadInPool() {
  const readByKey = new Map();
  for (const r of rows) {
    if (r.source === 'library' && r.shelf === 'read') {
      readByKey.set(`${norm(r.title)}|${norm(r.author)}`, r);
    }
  }
  const hits = new Map(); // dedupe — the same book can sit in >1 candidate pool file
  for (const r of rows) {
    if (r.source !== 'candidate_pool') continue;
    const key = `${norm(r.title)}|${norm(r.author)}`;
    const readMatch = readByKey.get(key);
    if (readMatch && !hits.has(key)) {
      hits.set(key, { title: r.title, author: r.author, myRating: readMatch.myRating });
    }
  }
  return [...hits.values()];
}

// Popular, well-reviewed to-read/candidate books that are missing the
// fields that would let BBRE actually score them well — these are
// specific, current under-scored recommendations, not an abstract
// percentage. avgRating/ratingsCount thresholds pick out books that are
// objectively likely to belong near the top of the list already.
function findHighLeverageGaps() {
  const seen = new Map(); // dedupe — the same book can be on both to-read and a candidate pool
  for (const r of rows) {
    if (!isHighLeverageShelf(r) || r.avgRating < HIGH_LEVERAGE_AVG_RATING || r.ratingsCount < HIGH_LEVERAGE_RATINGS_COUNT) continue;
    const missing = [];
    if (isEmpty(r.themes)) missing.push('themes');
    if (isEmpty(r.similarToTitles)) missing.push('similarToTitles');
    if (isEmpty(r.similarToAuthors)) missing.push('similarToAuthors');
    if (!missing.length) continue;
    const key = `${norm(r.title)}|${norm(r.author)}`;
    if (!seen.has(key)) {
      seen.set(key, { title: r.title, author: r.author, avgRating: r.avgRating, ratingsCount: r.ratingsCount, missing });
    }
  }
  return [...seen.values()].sort((a, b) => b.ratingsCount - a.ratingsCount);
}

// Structural sanity checks: a book citing itself, or an author citing
// themselves in similarToAuthors, is a data-entry bug (the whole point of
// the field is naming a *different* similar author) rather than a
// completeness gap.
function findSelfReferential() {
  // A normalized title can collide across two genuinely different books
  // (engineNorm strips series/edition notation — e.g. "Behind Closed Doors"
  // by B.A. Paris vs. "Behind Closed Doors (Behind Closed Doors, #1)" by
  // Lisa Renee Jones both normalize to the same string). In that case a
  // citation matching the normalized title may legitimately resolve to the
  // *other* book, not itself — only flag a title self-citation when the
  // normalized title is unambiguous (exactly one book in the dataset has it).
  const titleGroups = new Map();
  for (const r of rows) {
    const nt = engineNorm(r.title);
    if (!titleGroups.has(nt)) titleGroups.set(nt, new Set());
    titleGroups.get(nt).add(`${norm(r.title)}|${norm(r.author)}`);
  }

  const selfTitle = [];
  const selfAuthor = [];
  for (const r of rows) {
    const nt = engineNorm(r.title);
    const unambiguous = titleGroups.get(nt).size === 1;
    if (unambiguous && r.similarToTitles.some(t => engineNorm(t) === nt)) {
      selfTitle.push({ title: r.title, author: r.author });
    }
    const na = norm(r.author);
    if (r.similarToAuthors.some(a => norm(a) === na)) {
      selfAuthor.push({ title: r.title, author: r.author });
    }
  }
  return { selfTitle, selfAuthor };
}

// ── Data integrity checks ───────────────────────────────────────────────────

function findDuplicateBookKeys() {
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.bookKey)) byKey.set(r.bookKey, []);
    byKey.get(r.bookKey).push(r);
  }
  return [...byKey.entries()].filter(([, list]) => list.length > 1);
}

function findDuplicateTitleAuthor() {
  const byKey = new Map();
  for (const r of rows) {
    const k = `${norm(r.title)}|${norm(r.author)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  return [...byKey.entries()].filter(([, list]) => list.length > 1);
}

// Session 32: findDuplicateTitleAuthor() only catches exact title+author
// matches (modulo case/whitespace), which misses the shape candidatePool6.json
// (Open-Library-derived: full subtitled titles, /works/OL... bookKeys)
// produces against the slug-keyed pools — e.g. "Bad Blood" vs "Bad Blood:
// Secrets and Lies in a Silicon Valley Startup", or "The One" vs "The One
// (Dark Future #1)". A dedicated normalized-title+author scan (18 groups)
// found these were invisible to both findDuplicateBookKeys() and
// findDuplicateTitleAuthor() — same physical book, two unrelated identities.
// This strips subtitles (colon-onward) in addition to engineNorm's existing
// parenthetical/series stripping, and matches authors by word-set
// containment rather than exact string so "Adam Grant" vs "Adam M. Grant"
// still merges. Deliberately heuristic and report-only-by-default in spirit
// (see findNonCanonicalTones/findThemeToneCollisions) — a false-positive
// cluster here is just a suggestion to check by hand, never an auto-fix.
function normTitleNoSubtitle(v) {
  return engineNorm(String(v || '').replace(/:.*$/, ''));
}
function authorWordSet(v) {
  return new Set(
    String(v || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  );
}
function authorsFuzzyMatch(a, b) {
  const wa = authorWordSet(a), wb = authorWordSet(b);
  if (wa.size === 0 || wb.size === 0) return false;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  return [...small].every(w => big.has(w));
}
function findDuplicateBooksFuzzy() {
  const byTitle = new Map();
  for (const r of rows) {
    const nt = normTitleNoSubtitle(r.title);
    if (!nt) continue;
    if (!byTitle.has(nt)) byTitle.set(nt, []);
    byTitle.get(nt).push(r);
  }
  const groups = [];
  for (const [nt, list] of byTitle) {
    if (list.length < 2) continue;
    const used = new Array(list.length).fill(false);
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      const cluster = [list[i]];
      used[i] = true;
      for (let j = i + 1; j < list.length; j++) {
        if (!used[j] && authorsFuzzyMatch(list[i].author, list[j].author)) {
          cluster.push(list[j]);
          used[j] = true;
        }
      }
      if (cluster.length > 1) groups.push([nt, cluster]);
    }
  }
  return groups;
}

// Buckets broken similarToTitles refs into:
//  - nearMiss: a close match exists (substring/prefix or small edit
//    distance) — almost always a fixable typo, truncation, or an edition
//    difference engineNorm() didn't already catch. Sorted so refs that
//    touch a 5-star read (either the citing book is one, or the resolved
//    match is one) come first — those are the ones actually corrupting a
//    live scoring signal, not just an unused candidate-to-candidate note.
//  - orphaned: no close match anywhere — most likely a "flavor" reference
//    to a book that was never added to the dataset at all. Lower priority.
function findBrokenSimilarToTitles() {
  const titleList = [...new Set(rows.map(r => engineNorm(r.title)))].filter(Boolean);
  const titleSet = new Set(titleList);
  const fiveStarTitleSet = new Set(rows.filter(isFiveStarRead).map(r => engineNorm(r.title)));
  // Bucket candidate titles by length for cheap Levenshtein pre-filtering.
  const byLength = new Map();
  for (const t of titleList) {
    if (!byLength.has(t.length)) byLength.set(t.length, []);
    byLength.get(t.length).push(t);
  }

  // Session 14: both thresholds were tuned by hand-checking every match —
  // the originals (substring length >=5, flat Levenshtein <=3) produced
  // confident-looking but wrong matches on short titles ("Grant" is a
  // substring of "flagrant"; "It"/"We"/"Joe" are Levenshtein-2 from "Me").
  // Auditing all 28 pre-fix Levenshtein hits found exactly one real catch
  // (a "The"/"A" + comma variant on a 34-char title) and 27 false positives
  // on short, unrelated titles — so short strings no longer qualify at all.
  function findNearMatch(nt) {
    const substringMatch = titleList.find(candidate =>
      candidate.length >= 8 && nt.length >= 8 &&
      (candidate.includes(nt) || nt.includes(candidate))
    );
    if (substringMatch) return substringMatch;
    if (nt.length < 15) return null; // too short for edit-distance to mean anything
    const maxDist = Math.floor(nt.length * 0.10);
    for (let len = nt.length - 3; len <= nt.length + 3; len++) {
      const bucket = byLength.get(len);
      if (!bucket) continue;
      for (const candidate of bucket) {
        if (levenshtein(nt, candidate) <= maxDist) return candidate;
      }
    }
    return null;
  }

  const nearMiss = [];
  const orphaned = [];
  const classCache = new Map(); // ref (normalized) -> matched title or null

  for (const r of rows) {
    for (const t of r.similarToTitles) {
      const nt = engineNorm(t);
      if (!nt || titleSet.has(nt)) continue; // resolves fine under engine matching

      let matched = classCache.has(nt) ? classCache.get(nt) : undefined;
      if (matched === undefined) {
        matched = findNearMatch(nt);
        classCache.set(nt, matched);
      }

      const citingIsFiveStar = isFiveStarRead(r);
      const touchesFiveStar = citingIsFiveStar || (matched && fiveStarTitleSet.has(matched));
      const entry = { from: r.title, ref: t, touchesFiveStar };
      if (matched) nearMiss.push(entry);
      else orphaned.push(entry);
    }
  }
  nearMiss.sort((a, b) => Number(b.touchesFiveStar) - Number(a.touchesFiveStar));
  return { nearMiss, orphaned };
}

function findNonCanonicalThemes() {
  const offenders = [];
  const freq = new Map();
  for (const r of rows) {
    for (const t of r.themes) {
      if (!CANONICAL_THEMES.has(t)) {
        offenders.push({ title: r.title, theme: t });
        freq.set(t, (freq.get(t) || 0) + 1);
      }
    }
  }
  const PROMOTE_THRESHOLD = 5;
  const promoteCandidates = [...freq.entries()]
    .filter(([, count]) => count >= PROMOTE_THRESHOLD)
    .sort((a, b) => b[1] - a[1]);
  return { offenders, promoteCandidates };
}

// Mirrors findNonCanonicalThemes() — same drift this dataset already lived
// through once with themes (Session 14) and once with tones (39 free-form
// tags before the Session 16 24-tone redesign). Reported but deliberately
// NOT wired into computeQualityScore(): right after the redesign this reads
// as zero anyway, and folding it into the calibrated formula would silently
// change the tuned 65-baseline score without Bill asking for a
// recalibration, which is exactly the kind of drift Session 14b pushed back
// on. Future session can fold it in explicitly if that's ever wanted.
function findNonCanonicalTones() {
  const offenders = [];
  const freq = new Map();
  for (const r of rows) {
    for (const t of r.tones) {
      if (!CANONICAL_TONES.has(t)) {
        offenders.push({ title: r.title, tone: t });
        freq.set(t, (freq.get(t) || 0) + 1);
      }
    }
  }
  const PROMOTE_THRESHOLD = 5;
  const promoteCandidates = [...freq.entries()]
    .filter(([, count]) => count >= PROMOTE_THRESHOLD)
    .sort((a, b) => b[1] - a[1]);
  return { offenders, promoteCandidates };
}

// Catches per-book drift even if the two vocabularies stay disjoint overall
// (e.g. a future hand-edit copy-pastes a theme into the tones field, or vice
// versa) — a value appearing in both arrays on the same book blurs the two
// signals bbreEngine.js is careful to keep separate (themeBonus vs
// toneSignal).
function findThemeToneCollisions() {
  const offenders = [];
  for (const r of rows) {
    const themes = new Set(r.themes.map(t => t.toLowerCase()));
    for (const t of r.tones) {
      if (themes.has(t.toLowerCase())) offenders.push({ title: r.title, value: t });
    }
  }
  return offenders;
}

// Simple frequency counts across the whole dataset for the three tag-style
// fields Bill wants visible on the dashboard: themes and tones (canonical,
// controlled vocabularies) and subjects (free-form Open Library terms, no
// canonical list — see CLAUDE.md's subjects field notes). Not an integrity
// check by itself; just a count table so vocabulary distribution (e.g. "is
// any one tag doing too much work") is visible without re-deriving it by
// hand each time, the same need that drove the Session 16 tone-balance work.
function computeTagCounts() {
  const countField = field => {
    const freq = new Map();
    for (const r of rows) {
      for (const v of r[field]) {
        if (!v) continue;
        freq.set(v, (freq.get(v) || 0) + 1);
      }
    }
    return [...freq.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };
  return {
    themes: countField('themes'),
    tones: countField('tones'),
    subjects: countField('subjects'),
  };
}

function findOutOfRangeCounts() {
  // CLAUDE.md quality rules: themes 2-5, similarToTitles 3-5 (checked only
  // for library books — candidate pools follow a looser convention).
  const libraryRows = rows.filter(r => r.source === 'library');
  return {
    themesOutOfRange: libraryRows.filter(r => r.themes.length > 0 && (r.themes.length < 2 || r.themes.length > 5)),
    similarOutOfRange: libraryRows.filter(r => r.similarToTitles.length > 0 && (r.similarToTitles.length < 3 || r.similarToTitles.length > 5)),
    zeroPages: rows.filter(r => !r.pages),
    zeroRatingsCount: rows.filter(r => !r.ratingsCount),
    missingBookKey: rows.filter(r => !r.bookKey || r.bookKey.includes('|||')), // ||| = deriveKey fallback, not a real bookKey
  };
}

// ── Per-book BBRE impact score ───────────────────────────────────────────────
// Not "how many fields are missing" but "how much does this book's data
// quality actually matter to BBRE." A 5-star read missing similarToTitles
// degrades every candidate's reverse-match bonus; a to-read book with the
// same gap only affects its own score. Weighted accordingly so the
// worst-N list surfaces the highest-leverage fixes first.
function computeBookImpactScores(integrityFlags) {
  const perRow = rows.map(r => {
    const missingFields = IMPACT_FIELDS.filter(f => {
      const reg = FIELD_REGISTRY[f];
      if (reg?.eligible && !reg.eligible(r)) return false; // not applicable to this book
      return isEmpty(r[f]);
    });
    let score = missingFields.length * 10;
    const reasons = [];
    if (missingFields.length) reasons.push(`missing ${missingFields.join(', ')}`);

    if (isFiveStarRead(r)) {
      score += missingFields.length * 20; // foundational signal — triple the per-field weight
      if (missingFields.length) reasons.push('5★ read (foundational signal — affects every candidate)');
    }
    if (isHighLeverageShelf(r) && r.avgRating >= HIGH_LEVERAGE_AVG_RATING && r.ratingsCount >= HIGH_LEVERAGE_RATINGS_COUNT && missingFields.length) {
      score += 30;
      reasons.push('popular + well-rated candidate flying under the radar');
    }
    const key = `${norm(r.title)}|${norm(r.author)}`;
    if (integrityFlags.alreadyReadInPool.has(key)) {
      score += 100;
      reasons.push('already read but still sitting in a candidate pool — recommendable duplicate');
    }
    if (integrityFlags.selfReferential.has(key)) {
      score += 20;
      reasons.push('self-referential similarToTitles/similarToAuthors entry');
    }
    if (integrityFlags.brokenFiveStarTouch.has(key)) {
      score += 25;
      reasons.push('cites or is cited by a broken similarToTitles reference touching a 5★ read');
    }

    return { key, title: r.title, author: r.author, shelf: r.shelf, source: r.source, score, reasons };
  });

  // Dedupe by book (title+author) — a duplicate sitting in both the
  // library and a candidate pool (or in two candidate pools) is one
  // actionable book, not multiple separate list entries. Keep the highest
  // score seen for the book and the union of reasons/locations.
  const byKey = new Map();
  for (const s of perRow) {
    if (s.score <= 0) continue;
    const loc = `${s.source}/${s.shelf}`;
    const existing = byKey.get(s.key);
    if (!existing) {
      byKey.set(s.key, { title: s.title, author: s.author, score: s.score, reasons: new Set(s.reasons), locations: [loc] });
    } else {
      existing.score = Math.max(existing.score, s.score);
      s.reasons.forEach(r => existing.reasons.add(r));
      existing.locations.push(loc);
    }
  }
  return [...byKey.values()]
    .map(s => ({ ...s, reasons: [...s.reasons] }))
    .sort((a, b) => b.score - a.score);
}

// ── Overall Data Quality Score (0-100) ──────────────────────────────────────
// A single composite number for the dashboard's dial, built from weighted
// sub-scores rather than raw point deductions, so it stays meaningful
// regardless of dataset size. Each sub-score is itself a 0-100 rate against
// a sensible denominator — never a flat per-item penalty, which would
// either be meaningless at this scale (1000+ books) or wildly oversensitive
// to one bucket's count.
//
// Recalibrated Session 14, twice. First pass: the original rubric averaged
// 91-99/100 while a by-hand review of the same findings — 5 already-read
// books still recommendable, 19 self-referential entries, 61 broken refs
// corrupting the 5★ signal, 156 non-canonical theme uses, plus 418 orphaned
// refs and 12 duplicate-book groups the old formula didn't count at all —
// read as "Fair," not "Excellent." Fixed the four acute bugs, which
// mechanically pushed Foundational Signal Integrity and most of
// Recommendation Safety to a genuine, earned 100 — but the resulting 93/100
// still read as too generous: fixing the acute bugs is a necessary floor,
// not the bar for "excellent." Second pass: added a Field Completeness
// component (average Quality Score across *all* fields, not just the 10
// scoring-critical ones — isbn 65.9%, dateRead 72%, subjects 75%, tones 84%,
// publisher 87% were previously invisible to the composite entirely) and
// shifted weight away from the now-maxed Foundational/Critical-Health
// components toward Completeness and Hygiene, where the dataset's real
// remaining gaps live (463 orphaned refs — 10.8% of all similarToTitles
// citations don't resolve to a real book — plus 52 unfixed candidate-to-
// candidate near-misses and 5 duplicate-book groups). Multipliers raised
// again accordingly. Tuned against the Jul 30 2026 post-fix snapshot
// (0 already-read-in-pool, 0 self-referential, 0 broken-touching-5★, 0
// non-canonical, 463 orphaned, 52 near-miss, 5 duplicates, 93.7% average
// field completeness) to land at 65/100 — an explicit, second, higher bar:
// even a dataset with every acute bug fixed should not read as "Excellent"
// while a tenth of its similarToTitles references don't resolve and whole
// fields (isbn, dateRead, subjects) sit at 65-84% populated.
function computeQualityScore(stats, integ, rows) {
  const totalBooks = rows.length || 1;
  const totalFiveStarReads = rows.filter(isFiveStarRead).length || 1;
  const totalCandidatePool = rows.filter(r => r.shelf === 'candidate-pool').length || 1;
  const totalCitations = rows.reduce((s, r) => s + r.similarToTitles.length, 0) || 1;
  const totalThemeTags = rows.reduce((s, r) => s + r.themes.length, 0) || 1;
  const totalSimEntryBooks = rows.filter(r => r.similarToTitles.length || r.similarToAuthors.length).length || 1;
  const nearMissOther = integ.brokenNearMiss - integ.brokenNearMissTouchingFiveStar;
  const totalDuplicateGroups = integ.dupBookKeys + integ.dupTitleAuthor + integ.dupFuzzy;

  const rate = {
    alreadyReadInPool: integ.alreadyReadInPool / totalCandidatePool,
    fiveStarSignalGaps: integ.fiveStarSignalGaps / totalFiveStarReads,
    // Denominator is 5★-read count, not total citations — this measures
    // "what fraction of the books every recommendation is scored against
    // has a corrupted reference," not a rate diluted by candidate-to-
    // candidate citation volume that has nothing to do with the 5★ signal.
    brokenTouchFiveStar: integ.brokenNearMissTouchingFiveStar / totalFiveStarReads,
    highLeverageGaps: Math.min(1, integ.highLeverageGaps / 10),
    selfReferential: integ.selfReferential / totalSimEntryBooks,
    nearMissOther: nearMissOther / totalCitations,
    orphaned: integ.brokenOrphaned / totalCitations,
    nonCanonicalThemes: integ.nonCanonicalTotal / totalThemeTags,
    duplicates: totalDuplicateGroups / totalBooks,
  };

  const criticalFields = stats.filter(s => s.critical);
  const criticalHealth = criticalFields.length
    ? criticalFields.reduce((s, f) => s + f.scorePct, 0) / criticalFields.length
    : 100;
  // Every field, not just the scoring-critical ones — isbn/dateRead/
  // subjects/tones/publisher gaps are real incompleteness that an
  // "Excellent" dataset shouldn't have, even though BBRE doesn't score
  // against them directly. Shortfall multiplier makes each missing point
  // cost more than a flat average would.
  const allFieldsAvg = stats.length ? stats.reduce((s, f) => s + f.scorePct, 0) / stats.length : 100;
  const completenessScore = Math.max(0, 100 - (100 - allFieldsAvg) * 5.7);
  // fiveStarThemes/fiveStarAuthors/reverseSimilar are built entirely from
  // 5-star reads — gaps and broken refs touching them corrupt a signal
  // every candidate is scored against, not just the one book's own record.
  const foundationalScore = 100 * (1 - Math.min(1, rate.fiveStarSignalGaps * 6 + rate.brokenTouchFiveStar * 1.75));
  // Could a bad, duplicate, or unscoreable recommendation actually surface
  // to Bill. Duplicate book entries risk double-counting a signal (a
  // duplicated 5★ read's themes/citations get weighted twice).
  const safetyScore = 100 * (1 - Math.min(1, rate.alreadyReadInPool * 8 + rate.highLeverageGaps * 1 + rate.duplicates * 10));
  // Fixable data-entry mistakes. Orphaned refs are weighted lower than
  // near-miss (most are legitimate citations to books never added to the
  // dataset, not a defect) but still counted heavily — 463 of them (10.8%
  // of all citations) is a real completeness debt on the similarToTitles
  // signal, not nothing.
  const hygieneScore = 100 * (1 - Math.min(1, rate.selfReferential * 4 + rate.nearMissOther * 8.5 + rate.orphaned * 4.3 + rate.nonCanonicalThemes * 4));

  const components = [
    { key: 'criticalHealth', label: 'Critical Field Health', weight: 0.08, subscore: criticalHealth },
    { key: 'completeness', label: 'Field Completeness', weight: 0.33, subscore: completenessScore },
    { key: 'foundational', label: 'Foundational Signal Integrity', weight: 0.08, subscore: foundationalScore },
    { key: 'safety', label: 'Recommendation Safety', weight: 0.11, subscore: safetyScore },
    { key: 'hygiene', label: 'Data Hygiene', weight: 0.40, subscore: hygieneScore },
  ];
  const score = Math.max(0, Math.min(100, Math.round(components.reduce((s, c) => s + c.weight * c.subscore, 0))));

  // Impediment candidates: each one's OWN isolated point-loss contribution
  // (as if its siblings were zero), so the ranking reflects what's actually
  // dragging the score down rather than just raw counts.
  const impedimentDefs = [
    {
      count: integ.fiveStarSignalGaps,
      pointsLost: 100 * Math.min(1, rate.fiveStarSignalGaps * 6) * 0.08,
      name: '5★-read signal gaps',
      description: `${integ.fiveStarSignalGaps} 5★ read(s) missing themes/similarToTitles/similarToAuthors — these withhold a bonus every candidate that deserves it should be getting, since fiveStarThemes/fiveStarAuthors/reverseSimilar are built entirely from 5★ reads.`,
      fix: 'Tag the missing fields on these specific books — the single highest-leverage fix available.',
      anchor: '#impactSection',
    },
    {
      count: integ.brokenNearMissTouchingFiveStar,
      pointsLost: 100 * Math.min(1, rate.brokenTouchFiveStar * 1.75) * 0.08,
      name: 'Broken similarToTitles references touching a 5★ read',
      description: `${integ.brokenNearMissTouchingFiveStar} near-miss reference(s) where the citing book (or the book it's trying to cite) is a 5★ read — these corrupt a live scoring signal, not just an unused candidate-to-candidate note.`,
      fix: 'Correct each reference to the exact title string in the dataset (Broken References tab, sorted with these first).',
      anchor: '#tab-brokenrefs',
    },
    {
      count: integ.alreadyReadInPool,
      pointsLost: 100 * Math.min(1, rate.alreadyReadInPool * 8) * 0.11,
      name: 'Already-read books still in a candidate pool',
      description: `${integ.alreadyReadInPool} book(s) Bill has already read and rated are still sitting in a candidate pool — he could be recommended a book he's already finished. Treated as a severity-1 bug, not a completeness stat.`,
      fix: 'Remove these entries from their candidate pool file(s).',
      anchor: '#tab-alreadyread',
    },
    {
      count: totalDuplicateGroups,
      pointsLost: 100 * Math.min(1, rate.duplicates * 10) * 0.11,
      name: 'Duplicate book entries',
      description: `${totalDuplicateGroups} duplicate group(s) (same bookKey or same title+author appearing more than once) — a duplicated 5★ read double-counts its themes/citations toward every scoring signal built from it.`,
      fix: 'Merge or remove the duplicate entry, keeping the more complete record.',
      anchor: '#tab-duplicates',
    },
    {
      count: integ.highLeverageGaps,
      pointsLost: 100 * Math.min(1, rate.highLeverageGaps * 1) * 0.11,
      name: 'High-leverage candidate gaps',
      description: `${integ.highLeverageGaps} popular, well-rated candidate(s) missing data BBRE needs to score them properly — likely under-ranked right now.`,
      fix: 'Tag themes/similarToTitles/similarToAuthors on these specific books.',
      anchor: '#impactSection',
    },
    {
      count: nearMissOther,
      pointsLost: 100 * Math.min(1, rate.nearMissOther * 8.5) * 0.40,
      name: 'Broken similarToTitles references (candidate-to-candidate)',
      description: `${nearMissOther} near-miss reference(s) between books that aren't 5★ reads — lower live-scoring impact, but still fixable typos or subtitle truncations.`,
      fix: 'Correct each reference to the exact title string in the dataset.',
      anchor: '#tab-brokenrefs',
    },
    {
      count: integ.brokenOrphaned,
      pointsLost: 100 * Math.min(1, rate.orphaned * 4.3) * 0.40,
      name: 'Orphaned similarToTitles references',
      description: `${integ.brokenOrphaned} reference(s) with no close match anywhere in the dataset — mostly legitimate citations to books never added, but at this volume (${(rate.orphaned * 100).toFixed(1)}% of all citations) it's a real completeness gap on the similarToTitles signal, not nothing.`,
      fix: 'Add the missing books to the dataset where practical, or confirm the reference is intentionally external.',
      anchor: '#tab-brokenrefs',
    },
    {
      count: integ.nonCanonicalTotal,
      pointsLost: 100 * Math.min(1, rate.nonCanonicalThemes * 4) * 0.40,
      name: 'Non-canonical theme usage',
      description: `${integ.nonCanonicalTotal} uses of themes outside the canonical vocabulary — these still score identically to canonical themes (the engine has no vocabulary filter), but fragment what should be one consistent signal and one UI filter.`,
      fix: 'Remap to canonical themes, or promote frequently-used ones (see promotion candidates) to the canonical list in CLAUDE.md and the engine.',
      anchor: '#tab-themes',
    },
    {
      count: integ.selfReferential,
      pointsLost: 100 * Math.min(1, rate.selfReferential * 4) * 0.40,
      name: 'Self-referential entries',
      description: `${integ.selfReferential} book(s) cite themselves in similarToTitles or list their own author in similarToAuthors — a data-entry mistake, not a useful signal.`,
      fix: 'Replace with a genuinely different similar title or author.',
      anchor: '#tab-selfref',
    },
    {
      count: criticalFields.filter(f => f.scorePct < 90).length,
      pointsLost: (100 - criticalHealth) * 0.08,
      name: 'Scoring-critical field gaps',
      description: `Average critical-field Quality Score is ${criticalHealth.toFixed(1)}% — these fields feed a live scoring signal directly.`,
      fix: 'See the Field Population table, sorted by Quality Score, for the specific fields below threshold.',
      anchor: '#fieldPopulationSection',
    },
    {
      count: stats.filter(f => f.scorePct < 90).length,
      pointsLost: (100 - completenessScore) * 0.33,
      name: 'Field completeness gaps (all fields)',
      description: `Average Quality Score across all ${stats.length} tracked fields is ${allFieldsAvg.toFixed(1)}% — isbn, dateRead, subjects, tones, and publisher are the largest gaps, none of them scoring-critical but all real incompleteness for a genuinely excellent dataset.`,
      fix: 'See the Field Population table, sorted by Quality Score, for every field below 90%.',
      anchor: '#fieldPopulationSection',
    },
  ];

  const impediments = impedimentDefs
    .filter(i => i.pointsLost > 0.05 && i.count > 0)
    .sort((a, b) => b.pointsLost - a.pointsLost)
    .slice(0, 5)
    .map(i => ({ ...i, pointsLost: Math.round(i.pointsLost * 10) / 10 }));

  return { score, components, impediments };
}

// ── BBRE Accuracy Score (Session 33) ────────────────────────────────────────
// A separate dial from the Data Quality Score above — that one measures
// whether the DATA is complete/correct; this one measures whether the
// ENGINE'S PREDICTIONS are actually good, via scripts/eval.js's honest
// leave-one-out metrics over Bill's completed rated reads (never re-derived
// here — same computeEvalMetrics() the CLI eval script calls, so the two
// can't silently drift apart, the same discipline as scripts/lib/loadData.js
// consolidating the extract/report join logic in Session 13e).
//
// Recalibrated (Session 34) after Bill pushed back on the first version
// reading 91/100 — "be more critical, I think it's closer to 80" — the same
// shape of pushback, and the same fix, as the Data Quality Score's own
// Session 14/14b recalibration: the original formula let an
// easily-inflated, low-sample metric dominate. The original weighted
// precision@10 at 35% — but 10 books is a tiny, high-variance sample, and
// the top of a ranked list is close to guaranteed to look good (the
// candidates BBRE is most confident about are, almost by construction, the
// obvious matches). precision@25 and @50 barely moved the needle at 30%/15%
// combined, and precision@100 — the largest, most robust sample, and
// therefore the most honest single number — wasn't scored at all.
//
// Fixes: (1) de-emphasized precision@10 to 10% and gave @25/@50/@100 equal
// 20% weight each, so the score reflects whether the WHOLE useful
// recommendation surface is well-calibrated, not just the handful of picks
// least likely to be wrong. (2) Tightened the MAE-to-percent ceiling from a
// lenient 2.0 stars (MAE 0 -> 100, MAE >= 2.0 -> 0) to 1.3 stars — a
// prediction off by more than ~1.3 stars on a 1-5 scale is a real miss, not
// noise; the old ceiling let the current 0.758 MAE read as a soft "62/100"
// when it should read as a harder "42/100." (3) Added a genuinely new
// component, Bottom-50 Catch Rate — the engine's ability to correctly flag
// BAD books as bad (rank them in the bottom 50 of the leave-one-out set) —
// previously tracked by eval.js but never scored at all, despite being a
// real, separate capability from top-of-list precision (a recommender that
// only ever says "yes" isn't actually discriminating). Tuned by hand
// against the exact pre-recalibration snapshot (p10 100, p25 96, p50 96,
// p100 91, MAE 0.758, bottom-50 catch 27/50) to land at ~80/100 — an
// explicit, higher bar, same as the Data Quality Score's own precedent.
function computeBBREAccuracy(evalMetrics) {
  const { precisionAtK, mae, n, bottomCatch } = evalMetrics;
  const MAE_CEILING = 1.3;
  const ratingAccuracy = 100 * Math.max(0, 1 - mae / MAE_CEILING);
  const bottomCatchRate = 100 * (bottomCatch / 50);

  const components = [
    { key: 'p10', label: 'Precision@10', weight: 0.10, subscore: precisionAtK[10] },
    { key: 'p25', label: 'Precision@25', weight: 0.20, subscore: precisionAtK[25] },
    { key: 'p50', label: 'Precision@50', weight: 0.20, subscore: precisionAtK[50] },
    { key: 'p100', label: 'Precision@100', weight: 0.20, subscore: precisionAtK[100] },
    { key: 'ratingAccuracy', label: `Rating Accuracy (MAE, ${MAE_CEILING}★ ceiling)`, weight: 0.20, subscore: ratingAccuracy },
    { key: 'bottomCatch', label: 'Bottom-50 Catch Rate', weight: 0.10, subscore: bottomCatchRate },
  ];
  const score = Math.round(components.reduce((s, c) => s + c.subscore * c.weight, 0));

  return {
    score,
    components,
    sampleSize: n,
    mae,
    precisionAtK,
    bottomCatch,
  };
}

// ── Roadmap to a perfect score ──────────────────────────────────────────────
// Phases are cumulative and computed by re-running the SAME
// computeQualityScore on a hypothetical stats/integ state (not hand-typed
// point estimates that could silently drift from the real formula). Phase
// targets were derived from Session 14c's investigation of the actual
// remaining findings — e.g. the 463 orphaned refs turned out to have a very
// long tail (377 unique titles, but the top 30 alone account for ~21% of
// all citations, led by "Blood, Bones, and Butter" cited by 20 different
// food-memoir books) rather than being uniformly hard to fix.
function buildRoadmap(stats, integ, rows) {
  function withFieldScores(baseStats, overrides) {
    return baseStats.map(f => (f.field in overrides ? { ...f, scorePct: overrides[f.field] } : f));
  }

  // Phase 1 — Quick data-entry fixes: no new content, just correcting and
  // deduping what's already there.
  const phase1Integ = { ...integ, brokenNearMiss: 0, dupBookKeys: 0, dupTitleAuthor: 0, dupFuzzy: 0 };
  const phase1Stats = withFieldScores(stats, {
    similarToAuthors: 100, themes: 100, similarToTitles: 100, ratingsCount: 100, dismissReason: 100,
  });
  const phase1Actions = [
    'Correct the ~35 genuine candidate-to-candidate subtitle-truncation near-misses (same fix pattern as the 35 already corrected for 5★-touching refs) — e.g. "Just Mercy" → "Just Mercy: A Story of Justice and Redemption" (4 citing books), "Moneyball" → full title (5 citing books).',
    'Fix 2 abbreviated self-citations found during this analysis: "The Origins of the Cornbread Mafia" and "Twilight of the Gods" each cite their own short-form title in similarToTitles — same bug class as Session 14\'s self-referential fixes, just missed because the abbreviation doesn\'t normalize to an exact title match.',
    'Tighten findNearMatch() further: several of the 52 remaining near-misses are still false positives from coincidental word-prefix collisions ("The Road to Somewhere"→"The Road", "Superintelligence"→an unrelated book with "Superintelligence" in its subtitle) — reclassifying these to orphaned is more accurate, not a score loss, since they were never real matches.',
    'Backfill dismissReason labels for the handful of dismissed books that have a reasonCode but no label — a small, finite, fully in-house fix.',
    'Close the last-mile gaps on similarToAuthors/themes/similarToTitles/ratingsCount — a small number of books account for the remaining ~1% below 100%.',
  ];

  // Phase 2 — Add the highest-leverage missing books. Resolves the most
  // citations per book added, and each addition is a genuinely good
  // recommendation Bill is currently missing entirely, not just a score fix.
  const TOP30_CITATIONS_RESOLVED = 99; // top 30 unique orphaned titles by citation count
  const phase2Integ = { ...phase1Integ, brokenOrphaned: Math.max(0, integ.brokenOrphaned - TOP30_CITATIONS_RESOLVED) };
  const phase2Stats = phase1Stats;
  const phase2Actions = [
    'Add the 30 most-frequently-cited missing books as real candidate-pool entries with full "Perfect Book Entry" data (pages, avgRating, ratingsCount, themes, similarToTitles, similarToAuthors per CLAUDE.md\'s quality standard) — resolves 99 of 463 orphaned citations (21%) from just 30 additions.',
    'Top of the list: "Blood, Bones, and Butter" (cited by 20 different food-memoir books — by far the single highest-leverage addition), "Kitchen Confidential" (7), "The Midrange Theory" (5), "Dreamland" and "The New Jim Crow" (4 each).',
    'Each addition directly serves the BBRE-quality goal too — these are books the existing library already implicitly vouches for by citing them repeatedly as "similar," so they\'re likely to be good recommendations once added, not just data-quality filler.',
  ];

  // Phase 3 — Next tier of missing books. Steep diminishing returns: going
  // from top-30 to top-100 (70 more books) only adds another ~19 points of
  // citation coverage (21%→40%), and 330 of the 377 unique orphaned titles
  // are cited exactly once each — a long tail where each addition resolves
  // only its own single citation.
  const TOP100_CITATIONS_RESOLVED = 186; // cumulative, top 100 unique orphaned titles
  const phase3Integ = { ...phase2Integ, brokenOrphaned: Math.max(0, integ.brokenOrphaned - TOP100_CITATIONS_RESOLVED) };
  const phase3Stats = phase2Stats;
  const phase3Actions = [
    'Extend Phase 2 to the next ~70 most-cited missing titles (cumulative top 100), reaching 186 of 463 citations resolved (40%).',
    'Beyond this point, each further addition resolves only 1 citation (330 of the 377 unique orphaned titles are cited exactly once) — genuinely diminishing returns, not a reason to stop, but a reason to expect this phase to taper off rather than reach zero.',
  ];

  // Phase 4 — Let existing automation finish its job, plus targeted
  // backfills for fields scoring is currently ignoring the ceiling on.
  // Targets below are realistic-improvement estimates, not 100%, because
  // several of these fields have a documented external-data ceiling (see
  // Phase 5) rather than being a pure backlog.
  const phase4Integ = phase3Integ;
  const phase4Stats = withFieldScores(phase3Stats, {
    isbn: 85, dateRead: 90, subjects: 80, isbn13: 95, dateAdded: 92, tones: 97,
    publisher: 96, amazonRating: 98, amazonRatingsCount: 98, categories: 97,
    year: 100, metadataFetchedAt: 100, description: 100, type: 100,
  });
  const phase4Actions = [
    'amazonRating/amazonRatingsCount (currently 92.4%) will keep rising via the existing 5x/day scrape-ratings.yml with its Session 13d retry cooldown — no new work, just time.',
    'description/metadataFetchedAt backlog (currently 99.7-99.8%) clears at 150/day via enrich-metadata.yml — already nearly done.',
    'Run tag-books.yml (built in an earlier session but never used — needs the ANTHROPIC_API_KEY repo secret) to tag tones on the candidate-pool books it was built for — tones is 84% populated almost entirely because that job has never run.',
    'Extend enrich_isbn.py\'s scope to also backfill read-shelf isbn13 (currently to-read/candidate-only by design) and backfill publisher gaps via the Google Books lookup already used elsewhere.',
    'dateRead and isbn gaps are partially legacy-import artifacts — worth a manual pass, but likely can\'t fully close (some original Goodreads exports may genuinely lack the field).',
  ];

  // Phase 5 — The honest ceiling. subjects (Open Library) and categories
  // (Google Books) depend on external catalog coverage that retrying with
  // current logic does not improve (FIELD_REGISTRY says so explicitly for
  // both). Shown so "100" reads as a reference point, not a promise.
  const ceilingIntegri = { ...phase4Integ, brokenOrphaned: 0 };
  const ceilingStats = withFieldScores(phase4Stats, {
    isbn: 100, dateRead: 100, subjects: 100, isbn13: 100, dateAdded: 100, tones: 100,
    publisher: 100, amazonRating: 100, amazonRatingsCount: 100, categories: 100,
  });
  const ceilingActions = [
    'Literal 100/100 requires subjects and categories to reach 100% — but both depend on Open Library and Google Books actually having that data for every book. Per the Field Population table\'s own notes, retrying with current logic does not close these; they need either a different data source or accepting a lower ceiling.',
    'It also requires resolving all 463 orphaned refs, including the ~300 singly-cited long tail — likely only practical by editorially replacing unresolvable "flavor" citations with a real similar book, not by adding hundreds of marginal entries to the dataset.',
    'Realistic assessment: Phase 4 is probably the practical ceiling for this dataset without a new data source, not Phase 5.',
  ];

  const scenarios = [
    { key: 'current', label: 'Current', actions: [], stats, integ },
    { key: 'phase1', label: 'Phase 1 — Quick data-entry fixes', actions: phase1Actions, stats: phase1Stats, integ: phase1Integ },
    { key: 'phase2', label: 'Phase 2 — Add the top 30 missing books', actions: phase2Actions, stats: phase2Stats, integ: phase2Integ },
    { key: 'phase3', label: 'Phase 3 — Add the next-tier missing books (top 100)', actions: phase3Actions, stats: phase3Stats, integ: phase3Integ },
    { key: 'phase4', label: 'Phase 4 — Automation catch-up + targeted backfills', actions: phase4Actions, stats: phase4Stats, integ: phase4Integ },
    { key: 'ceiling', label: 'Theoretical ceiling (literal 100)', actions: ceilingActions, stats: ceilingStats, integ: ceilingIntegri },
  ];

  return scenarios.map(sc => {
    const result = computeQualityScore(sc.stats, sc.integ, rows);
    return { key: sc.key, label: sc.label, actions: sc.actions, score: result.score, components: result.components };
  });
}

// ── Snapshot history / trend ─────────────────────────────────────────────────

function listSnapshotDates(beforeStamp) {
  const files = fs.existsSync('output')
    ? fs.readdirSync('output').filter(f => /^data-quality-report-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];
  return files
    .map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1])
    .filter(d => !beforeStamp || d < beforeStamp)
    .sort();
}

function loadSnapshot(dateStr) {
  try {
    return JSON.parse(fs.readFileSync(path.join('output', `data-quality-report-${dateStr}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function computeTrend(current, previous) {
  if (!previous) return null;
  const prevByField = new Map((previous.fields || []).map(f => [f.field, f]));
  const TREND_THRESHOLD = 3; // points
  const fieldChanges = [];
  for (const s of current.fields) {
    const prev = prevByField.get(s.field);
    if (!prev) continue;
    const delta = s.scorePct - prev.scorePct;
    if (Math.abs(delta) >= TREND_THRESHOLD) {
      fieldChanges.push({ field: s.field, delta, from: prev.scorePct, to: s.scorePct });
    }
  }
  fieldChanges.sort((a, b) => a.delta - b.delta); // regressions first
  const integrityDelta = {};
  for (const k of Object.keys(current.integrity)) {
    const prevVal = previous.integrity?.[k];
    if (typeof prevVal === 'number' && typeof current.integrity[k] === 'number') {
      integrityDelta[k] = current.integrity[k] - prevVal;
    }
  }
  return { previousDate: previous.date, fieldChanges, integrityDelta };
}

// History for the metrics that actually matter to BBRE quality: critical
// field scores, plus the impact-focused integrity counts. 14 snapshots
// covers 2 weeks at the current daily cadence — enough to see a trend
// without the table growing unreadable.
const HISTORY_SNAPSHOTS = 14;
const HISTORY_METRICS = [
  { key: 'fiveStarSignalGapCount', label: '5★-read signal gaps' },
  { key: 'alreadyReadInPoolCount', label: 'Already-read books in a candidate pool' },
  { key: 'highLeverageGapCount', label: 'High-leverage candidate gaps' },
  { key: 'brokenNearMissTouchingFiveStar', label: 'Broken refs touching a 5★ read' },
];

function buildHistoryTable(currentSnapshot, todayStamp) {
  const dates = listSnapshotDates(todayStamp);
  const recentDates = dates.slice(-(HISTORY_SNAPSHOTS - 1));
  const snapshots = [...recentDates.map(loadSnapshot).filter(Boolean), currentSnapshot];
  if (snapshots.length < 2) return null; // nothing to trend yet

  const header = `| Metric | ${snapshots.map(s => s.date).join(' | ')} |`;
  const sep = `|---|${snapshots.map(() => '---').join('|')}|`;
  const criticalFieldRows = currentSnapshot.fields
    .filter(f => f.critical)
    .map(f => {
      const cells = snapshots.map(s => {
        const match = (s.fields || []).find(x => x.field === f.field);
        return match ? `${match.scorePct.toFixed(1)}%` : '—';
      });
      return `| \`${f.field}\` (critical) | ${cells.join(' | ')} |`;
    });
  const metricRows = HISTORY_METRICS.map(m => {
    const cells = snapshots.map(s => (s.integrity?.[m.key] ?? '—'));
    return `| ${m.label} | ${cells.join(' | ')} |`;
  });
  return [header, sep, ...metricRows, ...criticalFieldRows].join('\n');
}

// ── Render report ────────────────────────────────────────────────────────────

// A field whose eligible pool is a genuine subset of all books (e.g.
// dateRead only applies to the 649 read-shelf books, never the full 1112)
// can never reach 100% "Percent Populated" measured against everyone —
// that's not a gap, it's the field's real ceiling. Show the eligible count
// alongside the raw percentage so the denominator/target is never
// ambiguous, instead of implying every field should climb toward the full
// dataset.
function renderPopulationTable(stats) {
  const lines = [
    '| Field Name | Percent Populated | Quality Score | How Score is Determined | Suggestions for Improvement |',
    '|---|---|---|---|---|',
  ];
  for (const s of stats) {
    const label = scoreLabel(s.scorePct);
    const flag = s.belowThreshold ? (s.critical ? ' 🔴' : ' ⚠️') : '';
    const isRestricted = s.eligibleTotal < rows.length;
    const rawCell = isRestricted
      ? `${s.rawPct.toFixed(1)}% (target: ${s.eligibleTotal.toLocaleString()} eligible, not all ${rows.length.toLocaleString()})`
      : `${s.rawPct.toFixed(1)}%`;
    lines.push(`| ${s.field}${flag} | ${rawCell} | ${s.scorePct.toFixed(1)}% (${label}) | ${s.how} | ${s.suggest} |`);
  }
  return lines.join('\n');
}

function renderList(items, limit = 20) {
  const shown = items.slice(0, limit);
  const lines = shown.map(i => `- ${i}`);
  if (items.length > limit) lines.push(`- …and ${items.length - limit} more`);
  return lines.join('\n');
}

function renderActionItems(stats, integrity, trend, impactScores) {
  const lines = [];

  lines.push('**Top BBRE-impact issues (fix these first):**');
  if (integrity.alreadyReadInPool > 0) {
    lines.push(`- 🚨 **${integrity.alreadyReadInPool} already-read book(s) still sitting in a candidate pool** — Bill could be recommended a book he's already read. See Data Integrity below.`);
  }
  if (integrity.fiveStarSignalGaps > 0) {
    lines.push(`- 🎯 **${integrity.fiveStarSignalGaps} 5★ read(s) missing themes/similarToTitles/similarToAuthors** — these are the foundational signal every candidate is scored against. See "5★-Read Signal Gaps" below.`);
  }
  if (integrity.highLeverageGaps > 0) {
    lines.push(`- 📊 **${integrity.highLeverageGaps} popular, well-rated candidate(s)** missing data that would let BBRE score them properly. See "High-Leverage Candidate Gaps" below.`);
  }
  if (integrity.selfReferential > 0) {
    lines.push(`- 🔁 **${integrity.selfReferential} self-referential ${integrity.selfReferential === 1 ? 'entry' : 'entries'}** (a book citing itself or its own author).`);
  }
  if (!integrity.alreadyReadInPool && !integrity.fiveStarSignalGaps && !integrity.highLeverageGaps && !integrity.selfReferential) {
    lines.push('- None found. The highest-leverage BBRE-quality issues are all clear.');
  }

  const criticalLow = stats.filter(s => s.critical && s.belowThreshold);
  lines.push('', criticalLow.length
    ? '**🔴 Scoring-critical fields below threshold:**'
    : '**🔴 Scoring-critical fields:** all above threshold.');
  lines.push(...criticalLow.map(s => `- \`${s.field}\`: ${s.scorePct.toFixed(1)}% — ${s.suggest}`));

  if (impactScores.length) {
    lines.push('', `**Worst ${Math.min(5, impactScores.length)} books by BBRE impact score** (full top 20 in the table below):`);
    lines.push(...impactScores.slice(0, 5).map(s => `- "${s.title}" by ${s.author} (score ${s.score}) — ${s.reasons.join('; ')}`));
  }

  if (trend) {
    lines.push('', `**Since last report (vs ${trend.previousDate}):**`);
    if (trend.fieldChanges.length) {
      for (const c of trend.fieldChanges) {
        const arrow = c.delta > 0 ? '📈 improved' : '📉 regressed';
        lines.push(`- \`${c.field}\`: ${arrow} ${c.from.toFixed(1)}% → ${c.to.toFixed(1)}% (${c.delta > 0 ? '+' : ''}${c.delta.toFixed(1)} pts)`);
      }
    } else {
      lines.push('- No field Quality Score moved more than 3 points.');
    }
    const nonZeroIntegrity = Object.entries(trend.integrityDelta).filter(([, d]) => d !== 0);
    if (nonZeroIntegrity.length) {
      lines.push('- Integrity count changes: ' + nonZeroIntegrity.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${d}`).join(', '));
    }
  } else {
    lines.push('', '**Since last report:** no prior snapshot found — this is the baseline run.');
  }

  return lines.join('\n');
}

const stats = populationStats();
const dupBookKeys = findDuplicateBookKeys();
const dupTitleAuthor = findDuplicateTitleAuthor();
const dupFuzzy = findDuplicateBooksFuzzy();
const { nearMiss: brokenNearMiss, orphaned: brokenOrphaned } = findBrokenSimilarToTitles();
const { offenders: nonCanonical, promoteCandidates } = findNonCanonicalThemes();
const { offenders: nonCanonicalTones, promoteCandidates: toneReviewCandidates } = findNonCanonicalTones();
const themeToneCollisions = findThemeToneCollisions();
const ranges = findOutOfRangeCounts();
const fiveStarGaps = findFiveStarSignalGaps();
const alreadyReadInPool = findAlreadyReadInPool();
const highLeverageGaps = findHighLeverageGaps();
const { selfTitle, selfAuthor } = findSelfReferential();
const tagCounts = computeTagCounts();

let bbreAccuracy = null;
try {
  const gdRaw = JSON.parse(fs.readFileSync('data/goodreadsData.json', 'utf8'));
  let metaRaw = null;
  try { metaRaw = JSON.parse(fs.readFileSync('data/enrichedMetadata.json', 'utf8')); } catch {}
  bbreAccuracy = computeBBREAccuracy(computeEvalMetrics(gdRaw, metaRaw));
} catch (e) {
  console.error('BBRE accuracy computation failed, omitting from report:', e.message);
}

const alreadyReadInPoolKeys = new Set(alreadyReadInPool.map(x => `${norm(x.title)}|${norm(x.author)}`));
const selfReferentialKeys = new Set([...selfTitle, ...selfAuthor].map(x => `${norm(x.title)}|${norm(x.author)}`));
const brokenFiveStarTouchKeys = new Set(
  brokenNearMiss.filter(b => b.touchesFiveStar).map(b => `${norm(b.from)}`) // keyed by title-only since author isn't tracked on broken-ref entries
);
const impactScores = computeBookImpactScores({
  alreadyReadInPool: alreadyReadInPoolKeys,
  selfReferential: selfReferentialKeys,
  brokenFiveStarTouch: new Set(rows.filter(r => brokenFiveStarTouchKeys.has(norm(r.title))).map(r => `${norm(r.title)}|${norm(r.author)}`)),
});

const shelfCounts = SHELVES.map(sh => `${sh}: ${rows.filter(r => r.shelf === sh).length}`).join(', ');
const dateStamp = new Date().toISOString().slice(0, 10);

const integritySummary = {
  dupBookKeys: dupBookKeys.length,
  dupTitleAuthor: dupTitleAuthor.length,
  dupFuzzy: dupFuzzy.length,
  alreadyReadInPool: alreadyReadInPool.length,
  fiveStarSignalGaps: fiveStarGaps.length,
  highLeverageGaps: highLeverageGaps.length,
  selfReferential: selfTitle.length + selfAuthor.length,
  brokenNearMiss: brokenNearMiss.length,
  brokenNearMissTouchingFiveStar: brokenNearMiss.filter(b => b.touchesFiveStar).length,
  brokenOrphaned: brokenOrphaned.length,
  nonCanonicalTotal: nonCanonical.length,
  promoteCandidateCount: promoteCandidates.length,
  nonCanonicalTonesTotal: nonCanonicalTones.length,
  toneReviewCandidateCount: toneReviewCandidates.length,
  themeToneCollisions: themeToneCollisions.length,
  themesOutOfRange: ranges.themesOutOfRange.length,
  similarOutOfRange: ranges.similarOutOfRange.length,
  zeroPages: ranges.zeroPages.length,
  zeroRatingsCount: ranges.zeroRatingsCount.length,
  missingBookKey: ranges.missingBookKey.length,
};

const qualityScore = computeQualityScore(stats, integritySummary, rows);
const roadmap = buildRoadmap(stats, integritySummary, rows);

const currentSnapshot = {
  date: dateStamp,
  generatedAt: new Date().toISOString(),
  totalBooks: rows.length,
  qualityScore,
  bbreAccuracy,
  roadmap,
  fields: stats.map(s => ({ field: s.field, scorePct: s.scorePct, rawPct: s.rawPct, critical: s.critical, eligibleTotal: s.eligibleTotal })),
  integrity: integritySummary,
  // Full structured findings (not just counts) — dashboard-ready.
  findings: {
    fiveStarSignalGaps: fiveStarGaps,
    alreadyReadInPool,
    highLeverageGaps,
    selfReferentialTitle: selfTitle,
    selfReferentialAuthor: selfAuthor,
    brokenNearMiss,
    brokenOrphaned,
    promoteCandidates: promoteCandidates.map(([theme, count]) => ({ theme, count })),
    nonCanonicalThemes: nonCanonical,
    toneReviewCandidates: toneReviewCandidates.map(([tone, count]) => ({ tone, count })),
    nonCanonicalTones,
    themeToneCollisions,
    duplicateBookKeys: dupBookKeys.map(([key, list]) => ({ key, books: list.map(r => ({ title: r.title, source: r.source, shelf: r.shelf })) })),
    duplicateTitleAuthor: dupTitleAuthor.map(([, list]) => ({ title: list[0].title, author: list[0].author, occurrences: list.map(r => ({ source: r.source, shelf: r.shelf })) })),
    duplicateBooksFuzzy: dupFuzzy.map(([, list]) => ({ title: list[0].title, occurrences: list.map(r => ({ title: r.title, author: r.author, source: r.source, shelf: r.shelf })) })),
    impactScores: impactScores.slice(0, 50),
    tagCounts,
  },
};

const previousSnapshot = loadSnapshot(listSnapshotDates(dateStamp).slice(-1)[0] || '');
const trend = computeTrend(currentSnapshot, previousSnapshot);
const historyTable = buildHistoryTable(currentSnapshot, dateStamp);

const report = `# Data Quality Report — ${dateStamp}

Generated by \`scripts/data_quality_report.js\`. Total books analyzed: **${rows.length}** (${shelfCounts}).

## Data Quality Score: ${qualityScore.score}/100

${qualityScore.components.map(c => `- ${c.label} (${(c.weight * 100).toFixed(0)}%): ${c.subscore.toFixed(1)}/100`).join('\n')}

## BBRE Accuracy Score: ${bbreAccuracy ? `${bbreAccuracy.score}/100` : 'unavailable'}

A separate measure from the Data Quality Score above — this one is not about whether the data is complete/correct, but whether the engine's actual predictions are good, via \`scripts/eval.js\`'s leave-one-out evaluation over ${bbreAccuracy ? bbreAccuracy.sampleSize : '?'} completed rated reads.

${bbreAccuracy ? bbreAccuracy.components.map(c => `- ${c.label} (${(c.weight * 100).toFixed(0)}%): ${c.subscore.toFixed(1)}/100`).join('\n') : 'Could not be computed for this snapshot.'}
${bbreAccuracy ? `- Mean absolute error: ${bbreAccuracy.mae.toFixed(3)} stars` : ''}

Interactive dial + full breakdown: [quality-dashboard.html](../quality-dashboard.html). See "Top 5 Impediments to a Perfect Score" at the end of this report.

## Action Items

${renderActionItems(stats, integritySummary, trend, impactScores)}

## 5★-Read Signal Gaps (${fiveStarGaps.length})

fiveStarThemes, fiveStarAuthors, and reverseSimilar are built entirely from 5★ reads — a gap here silently withholds a bonus every candidate that deserves it should be getting, not just an incomplete record for this one book.
${fiveStarGaps.length ? renderList(fiveStarGaps.map(g => `"${g.title}" by ${g.author} — missing ${g.missing.join(', ')}`)) : 'None found — every 5★ read has themes, similarToTitles, and similarToAuthors populated.'}

## High-Leverage Candidate Gaps (${highLeverageGaps.length})

To-read/candidate-pool books with avgRating ≥ ${HIGH_LEVERAGE_AVG_RATING} and ratingsCount ≥ ${HIGH_LEVERAGE_RATINGS_COUNT.toLocaleString()} — objectively likely to belong near the top of the list already — that are missing data BBRE needs to score them properly.
${highLeverageGaps.length ? renderList(highLeverageGaps.map(g => `"${g.title}" by ${g.author} (${g.avgRating}★, ${g.ratingsCount.toLocaleString()} ratings) — missing ${g.missing.join(', ')}`)) : 'None found.'}

## Worst 20 Books by BBRE Impact Score

Not a raw missing-field count — weighted by whether the book is a 5★ read (foundational signal), a high-leverage candidate, or involved in an integrity issue like an already-read duplicate.
${impactScores.length ? renderList(impactScores.slice(0, 20).map(s => `"${s.title}" by ${s.author} (${s.locations.join(', ')}) — score ${s.score}: ${s.reasons.join('; ')}`), 20) : 'None — no book has a nonzero impact score.'}

## Recent Trend (BBRE-relevant metrics)

${historyTable || 'Not enough history yet — need at least one prior snapshot. This will populate starting next week.'}

## Field Population

**Percent Populated** is raw — % of all ${rows.length} books with a non-empty value.
**Quality Score** is Percent Populated measured against only the *eligible*
rows for that field (see "How Score is Determined") — e.g. \`myRating\` is
scored against read-shelf books only, since to-read/candidate books are
unrated by definition. A field can show a low raw percentage and a high
Quality Score at the same time; that gap itself is informative (it means
the field is working as scoped, not broken). 🔴 marks a scoring-critical
field below ${CRITICAL_WARN_THRESHOLD}%; ⚠️ marks any other field below ${WARN_THRESHOLD}%.

${renderPopulationTable(stats)}

## Tag Counts (Themes, Tones, Subjects)

How many books carry each value, across every book (library + all candidate pools). Themes and tones are controlled vocabularies (see CLAUDE.md); subjects is free-form (Open Library, no canonical list — this table is the fastest way to see what's actually in use). Full lists (not just top 15) are in the JSON snapshot's \`findings.tagCounts\` and the interactive [dashboard](../quality-dashboard.html#tagCountsSection).

**Themes** (top 15 of ${tagCounts.themes.length}):
${tagCounts.themes.slice(0, 15).map(t => `- ${t.value} — ${t.count}`).join('\n')}

**Tones** (top 15 of ${tagCounts.tones.length}):
${tagCounts.tones.slice(0, 15).map(t => `- ${t.value} — ${t.count}`).join('\n')}

**Subjects** (top 15 of ${tagCounts.subjects.length}):
${tagCounts.subjects.length ? tagCounts.subjects.slice(0, 15).map(t => `- ${t.value} — ${t.count}`).join('\n') : 'None found (subjects field not populated on any book yet).'}

## Data Integrity

### Already-read books still in a candidate pool (${alreadyReadInPool.length})
${alreadyReadInPool.length ? renderList(alreadyReadInPool.map(x => `"${x.title}" by ${x.author} — rated ${x.myRating}★ but still listed as a candidate`)) : 'None found.'}

### Self-referential entries (${selfTitle.length + selfAuthor.length})
${(selfTitle.length + selfAuthor.length) ? renderList([
    ...selfTitle.map(x => `"${x.title}" by ${x.author} lists itself in similarToTitles`),
    ...selfAuthor.map(x => `"${x.title}" by ${x.author} lists its own author in similarToAuthors`),
  ]) : 'None found.'}

### Duplicate bookKeys (${dupBookKeys.length})
${dupBookKeys.length ? renderList(dupBookKeys.map(([k, list]) => `\`${k}\` — ${list.map(r => `"${r.title}" (${r.source}/${r.shelf})`).join(', ')}`)) : 'None found.'}

### Duplicate title+author across sources (${dupTitleAuthor.length})
${dupTitleAuthor.length ? renderList(dupTitleAuthor.map(([, list]) => `"${list[0].title}" by ${list[0].author} — appears in ${list.map(r => `${r.source}/${r.shelf}`).join(', ')}`)) : 'None found.'}

### Duplicate books, normalized (${dupFuzzy.length})
Catches subtitle/edition-variant duplicates the two exact-match checks above miss (e.g. "Bad Blood" vs "Bad Blood: Secrets and Lies in a Silicon Valley Startup", "The One" vs "The One (Dark Future #1)") — same physical book under two unrelated identities, mostly candidatePool6.json's Open-Library-derived entries duplicating an earlier pool file or goodreadsData.json. Heuristic (normalized title + fuzzy author word-match) — verify by hand before merging.
${dupFuzzy.length ? renderList(dupFuzzy.map(([, list]) => `${list.map(r => `"${r.title}" by ${r.author} (${r.source}/${r.shelf})`).join(' == ')}`)) : 'None found.'}

### Broken similarToTitles references
Checked against the engine's actual title-matching normalization (parenthetical/series notation stripped, same as \`norm()\` in engine.js) — so this excludes refs the engine already resolves fine, unlike a naive string comparison.

**Near-miss (${brokenNearMiss.length}, ${brokenNearMiss.filter(b => b.touchesFiveStar).length} touching a 5★ read)** — a close match exists in the dataset (substring/prefix overlap or a small edit distance); almost always a fixable typo, truncation, or formatting difference. Sorted so refs touching a 5★ read (corrupting a live scoring signal) come first.
${brokenNearMiss.length ? renderList(brokenNearMiss.map(b => `"${b.from}" cites "${b.ref}"${b.touchesFiveStar ? ' 🎯 touches a 5★ read' : ''}`)) : 'None found.'}

**Orphaned (${brokenOrphaned.length})** — no close match anywhere in the dataset; likely a reference to a book that was never added at all. Lower priority than near-miss.
${brokenOrphaned.length ? renderList(brokenOrphaned.map(b => `"${b.from}" cites "${b.ref}"`)) : 'None found.'}

### Non-canonical themes (${nonCanonical.length} uses)
Themes not in CLAUDE.md's canonical vocabulary. Note: the engine has no canonical-vocabulary filter — a non-canonical theme still contributes to \`fiveStarThemes\`/\`themeBonus\` scoring identically to a canonical one. The real cost is vocabulary drift: near-duplicate/inconsistent tags fragment what should be one signal (e.g. "historical fiction" vs "historical" never co-count toward the same theme bonus), and app.js's THEME_MACROS genre filter only recognizes specific known strings.

**Canonical-vocabulary candidates** — used ${promoteCandidates.length ? `≥5 times each` : 'nowhere near the promotion threshold'}, which suggests a real vocabulary gap rather than a one-off typo:
${promoteCandidates.length ? renderList(promoteCandidates.map(([theme, count]) => `"${theme}" — ${count} uses`)) : 'None — no non-canonical theme is used often enough to suggest a real gap.'}

All non-canonical uses (including one-offs):
${nonCanonical.length ? renderList(nonCanonical.map(o => `"${o.title}": "${o.theme}"`)) : 'None found.'}

### Non-canonical tones (${nonCanonicalTones.length} uses)
Tones not in CLAUDE.md's canonical 24-tone vocabulary (bbreEngine.js's THEME_TONES_MAP/TONE_PRIORITY). Introduced Session 16 to replace a 39-tag free-for-all where the most common tag alone covered 38% of the dataset, diluting the one tone-based preference signal \`buildToneProfile()\`/\`toneSignal()\` computes from Bill's ratings. Not currently folded into the Data Quality Score (see code comment on \`findNonCanonicalTones()\`).

**Vocabulary-gap candidates** — used ${toneReviewCandidates.length ? `≥5 times each` : 'nowhere near the review threshold'}, which would suggest reconsidering the 24-tone list rather than a one-off tagging mistake:
${toneReviewCandidates.length ? renderList(toneReviewCandidates.map(([tone, count]) => `"${tone}" — ${count} uses`)) : 'None — no non-canonical tone is used often enough to suggest a real gap.'}

All non-canonical uses (including one-offs):
${nonCanonicalTones.length ? renderList(nonCanonicalTones.map(o => `"${o.title}": "${o.tone}"`)) : 'None found.'}

### Theme/tone collisions (${themeToneCollisions.length})
A book carrying the same value in both \`themes\` and \`tones\` would blur two signals bbreEngine.js is careful to keep separate (\`themeBonus\` vs \`toneSignal\`). The two vocabularies are also asserted disjoint at load time (see \`CANONICAL_THEMES\`/\`CANONICAL_TONES\` in this script).
${themeToneCollisions.length ? renderList(themeToneCollisions.map(o => `"${o.title}": "${o.value}" appears in both themes and tones`)) : 'None found.'}

### Out-of-range field counts (library books only)
- Themes outside 2–5 range: **${ranges.themesOutOfRange.length}** ${ranges.themesOutOfRange.length ? '(' + ranges.themesOutOfRange.slice(0, 5).map(r => `"${r.title}"`).join(', ') + (ranges.themesOutOfRange.length > 5 ? ', …' : '') + ')' : ''}
- similarToTitles outside 3–5 range: **${ranges.similarOutOfRange.length}** ${ranges.similarOutOfRange.length ? '(' + ranges.similarOutOfRange.slice(0, 5).map(r => `"${r.title}"`).join(', ') + (ranges.similarOutOfRange.length > 5 ? ', …' : '') + ')' : ''}
- Zero/missing pages (kills pages-fit bonus): **${ranges.zeroPages.length}**
- Zero/missing ratingsCount (kills popularity bonus): **${ranges.zeroRatingsCount.length}**
- Missing a real bookKey (derived-key fallback, skipped by daily enrichment): **${ranges.missingBookKey.length}**

## Top ${qualityScore.impediments.length} Impediments to a Perfect Data Quality Score

Ranked by estimated points lost from the 100-point score above — not raw counts. A large orphaned-reference or one-off count can matter less than a small count in a higher-weighted category (see Data Quality Score components).

${qualityScore.impediments.length ? qualityScore.impediments.map((imp, i) => `${i + 1}. **${imp.name}** (−${imp.pointsLost} pts)\n   ${imp.description}\n   **Fix:** ${imp.fix}`).join('\n\n') : 'None — the score is already at or near 100.'}

## Roadmap to 100

A phased, cumulative plan from the current score to a perfect one. Each phase's projected score is *simulated* by re-running the actual scoring formula on a hypothetical fixed-state, not hand-estimated — see \`buildRoadmap()\` in this script. Full breakdown and phase-by-phase visual in [quality-dashboard.html](../quality-dashboard.html#roadmapSection).

${roadmap.map(r => `**${r.label}** — projected score: ${r.score}/100${r.key !== 'current' ? ` (+${r.score - roadmap[0].score} from current)` : ''}\n${r.actions.length ? r.actions.map(a => `- ${a}`).join('\n') : ''}`).join('\n\n')}

**Bottom line:** Phase 4 is the realistic practical ceiling for this dataset without a new external data source — subjects (Open Library) and categories (Google Books) genuinely cap below 100% no matter how much this project retries them with current logic, and the ~300 singly-cited orphaned references are a long tail with steeply diminishing returns past Phase 3.
`;

fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(`output/data-quality-report-${dateStamp}.md`, report);
fs.writeFileSync(`output/data-quality-report-${dateStamp}.json`, JSON.stringify(currentSnapshot, null, 2) + '\n');

// Manifest of every snapshot date — the dashboard (quality-dashboard.html)
// is a static page and can't list a directory on GitHub Pages, so it reads
// this file to know which dated JSON snapshots exist.
const allDates = [...listSnapshotDates(null).filter(d => d !== dateStamp), dateStamp].sort();
fs.writeFileSync('output/data-quality-index.json', JSON.stringify({ dates: allDates }, null, 2) + '\n');

console.log(`Wrote output/data-quality-report-${dateStamp}.md, .json, and updated data-quality-index.json`);
