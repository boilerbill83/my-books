#!/usr/bin/env node
// Weekly data quality report: field-population analysis (overall + by
// shelf, since several fields are legitimately shelf-scoped rather than
// universally populated — see CLAUDE.md Session 13b/13d) plus data
// integrity checks (duplicates, broken similarToTitles refs, non-canonical
// themes, out-of-range field counts). Writes a dated Markdown report to
// output/data-quality-report-YYYY-MM-DD.md. Run from repo root:
// node scripts/data_quality_report.js

import fs from 'fs';
import { loadAllBooks, norm } from './lib/loadData.js';

// Keep in sync with CLAUDE.md's "Canonical theme vocabulary" section.
const CANONICAL_THEMES = new Set([
  'thriller', 'psychological', 'suspense', 'domestic suspense', 'mystery', 'crime',
  'noir', 'horror', 'high-concept', 'spy', 'adventure', 'historical', 'YA', 'romance',
  'literary', 'contemporary', 'speculative', 'sci-fi', 'social commentary',
  'narrative nonfiction', 'memoir', 'biography', 'true crime', 'history', 'tech history',
  'finance', 'business', 'sports', 'food', 'music history', 'political', 'military',
  'psychology', 'humor', 'comedy',
]);

const { rows } = loadAllBooks();

const SHELVES = ['to-read', 'read', 'currently-reading', 'candidate-pool'];
const isEmpty = v => v === '' || v == null || (Array.isArray(v) && v.length === 0);

// ── Field registry ───────────────────────────────────────────────────────────
// Quality Score is population % measured against the ELIGIBLE subset of rows
// for that field, not the full 1117 — a field that structurally only applies
// to read books (myRating) or is only targeted by one enrichment job for
// certain shelves (coverUrl, amazonRating) would otherwise look like a
// "gap" when it's actually complete for the rows it applies to. Percent
// Populated (raw, of all rows) is kept alongside so the difference is
// visible. Eligibility scopes and suggestions below are the root causes
// diagnosed in CLAUDE.md Session 13b-13e — update this registry, not just
// the data, when a new enrichment job changes a field's scope.
const inShelves = (...shelves) => r => shelves.includes(r.shelf);
const always = () => true;
const isAttempted = r => !isEmpty(r.metadataFetchedAt);
const isDismissed = r => r.dismissed === true;
const preISBN13Era = r => !r.year || r.year < 2007;

const FIELD_REGISTRY = {
  bookKey: {
    eligible: always,
    how: 'Population % of all books with a real slug bookKey (not the "title|||author" derived-key fallback, which enrich_metadata.py cannot use).',
    suggest: n => n.missing ? `Backfill a real bookKey (same slug convention as existing keys) on the ${n.missing} book(s) still using the fallback — they're invisible to the daily metadata job until fixed.` : 'None needed.',
  },
  title: { eligible: always, how: 'Always required; % of rows with a non-empty title.', suggest: () => 'None needed.' },
  author: { eligible: always, how: 'Always required; % of rows with a non-empty author.', suggest: () => 'None needed.' },
  source: { eligible: always, how: 'Set programmatically by the loader for every row.', suggest: () => 'None needed.' },
  shelf: { eligible: always, how: 'Set from goodreadsData.json/candidate pools for every row.', suggest: () => 'None needed.' },
  type: { eligible: always, how: '% of all books tagged fiction/nonfiction.', suggest: () => 'Spot-check any untagged rows via the publisher-category audit pattern used in Session 13.' },
  year: { eligible: always, how: '% of all books with a publication year.', suggest: () => 'Low-volume gap; backfill manually or via Google Books lookup if any recommendations are missing it.' },
  pages: { eligible: always, how: '% of all books with a non-zero page count — zero/missing silently disables the pages-fit scoring bonus (CLAUDE.md quality rule).', suggest: n => n.missing ? `${n.missing} book(s) missing pages — the pages-fit bonus never fires for them. Backfill from Google Books/ISBN lookup.` : 'None needed.' },
  myRating: {
    eligible: inShelves('read'),
    how: '% of READ-shelf books with a rating — to-read/candidate books are unrated by definition, so they are excluded from the denominator.',
    suggest: n => n.missing ? `${n.missing} read book(s) have no rating — check for import gaps or unrated DNFs.` : 'None needed; this is a read-only field.',
  },
  avgRating: { eligible: always, how: '% of all books with a Goodreads community average.', suggest: () => 'None needed.' },
  ratingsCount: { eligible: always, how: '% of all books with a positive ratingsCount — zero/missing silently disables the popularity bonus (CLAUDE.md quality rule).', suggest: n => n.missing ? `${n.missing} book(s) have zero/missing ratingsCount — backfill via Google Books/Goodreads lookup so the popularity bonus can fire.` : 'None needed.' },
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
  themes: { eligible: always, how: '% of all books with at least one theme tag — feeds fiveStarThemes/themeBonus scoring directly.', suggest: n => n.missing ? `${n.missing} book(s) have zero themes — tag from canonical vocabulary (see CLAUDE.md) so themeBonus can fire.` : 'None needed.' },
  tones: { eligible: always, how: '% of all books with at least one tone tag.', suggest: n => n.missing ? `${n.missing} book(s) missing tones — mostly candidate-pool books never processed by tag_with_haiku.py.` : 'None needed.' },
  similarToTitles: { eligible: always, how: '% of all books with at least one similarToTitles entry — feeds the forward/reverse title-match scoring signals.', suggest: n => n.missing ? `${n.missing} book(s) have none — see the Broken References section below for entries that exist but don't resolve.` : 'None needed; also check the broken-references count below.' },
  similarToAuthors: { eligible: always, how: '% of all books with at least one similarToAuthors entry.', suggest: n => n.missing ? `${n.missing} book(s) missing — lower priority than similarToTitles (smaller scoring weight).` : 'None needed.' },
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
    return {
      field: f,
      rawPct,
      scorePct,
      eligibleTotal: eligible.length,
      eligiblePopulated: eligiblePopulated.length,
      how: reg.how,
      suggest: reg.suggest({ missing: eligible.length - eligiblePopulated.length }),
    };
  });
  return stats.sort((a, b) => a.scorePct - b.scorePct);
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

function findBrokenSimilarToTitles() {
  const allTitles = new Set(rows.map(r => norm(r.title)));
  const broken = [];
  for (const r of rows) {
    for (const t of r.similarToTitles) {
      if (!allTitles.has(norm(t))) broken.push({ from: r.title, ref: t });
    }
  }
  return broken;
}

function findNonCanonicalThemes() {
  const offenders = [];
  for (const r of rows) {
    for (const t of r.themes) {
      if (!CANONICAL_THEMES.has(t)) offenders.push({ title: r.title, theme: t });
    }
  }
  return offenders;
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

// ── Render report ────────────────────────────────────────────────────────────

function pct(n, d) { return d ? `${(100 * n / d).toFixed(1)}%` : 'n/a'; }

function renderPopulationTable(stats) {
  const lines = [
    '| Field Name | Percent Populated | Quality Score | How Score is Determined | Suggestions for Improvement |',
    '|---|---|---|---|---|',
  ];
  for (const s of stats) {
    const label = scoreLabel(s.scorePct);
    const flag = s.scorePct < 80 ? ' ⚠️' : '';
    lines.push(`| ${s.field}${flag} | ${s.rawPct.toFixed(1)}% | ${s.scorePct.toFixed(1)}% (${label}) | ${s.how} | ${s.suggest} |`);
  }
  return lines.join('\n');
}

function renderList(items, limit = 20) {
  const shown = items.slice(0, limit);
  const lines = shown.map(i => `- ${i}`);
  if (items.length > limit) lines.push(`- …and ${items.length - limit} more`);
  return lines.join('\n');
}

const stats = populationStats();
const dupBookKeys = findDuplicateBookKeys();
const dupTitleAuthor = findDuplicateTitleAuthor();
const brokenSimilar = findBrokenSimilarToTitles();
const nonCanonical = findNonCanonicalThemes();
const ranges = findOutOfRangeCounts();

const shelfCounts = SHELVES.map(sh => `${sh}: ${rows.filter(r => r.shelf === sh).length}`).join(', ');

const report = `# Data Quality Report — ${new Date().toISOString().slice(0, 10)}

Generated by \`scripts/data_quality_report.js\`. Total books analyzed: **${rows.length}** (${shelfCounts}).

## Field Population

**Percent Populated** is raw — % of all ${rows.length} books with a non-empty value.
**Quality Score** is Percent Populated measured against only the *eligible*
rows for that field (see "How Score is Determined") — e.g. \`myRating\` is
scored against read-shelf books only, since to-read/candidate books are
unrated by definition. A field can show a low raw percentage and a high
Quality Score at the same time; that gap itself is informative (it means
the field is working as scoped, not broken). ⚠️ marks a Quality Score under 80%.

${renderPopulationTable(stats)}

## Data Integrity

### Duplicate bookKeys (${dupBookKeys.length})
${dupBookKeys.length ? renderList(dupBookKeys.map(([k, list]) => `\`${k}\` — ${list.map(r => `"${r.title}" (${r.source}/${r.shelf})`).join(', ')}`)) : 'None found.'}

### Duplicate title+author across sources (${dupTitleAuthor.length})
${dupTitleAuthor.length ? renderList(dupTitleAuthor.map(([, list]) => `"${list[0].title}" by ${list[0].author} — appears in ${list.map(r => `${r.source}/${r.shelf}`).join(', ')}`)) : 'None found.'}

### Broken similarToTitles references (${brokenSimilar.length})
Titles cited that don't exact-match any book's \`title\` field — the engine's forward/reverse title-match signals silently no-op on these.
${brokenSimilar.length ? renderList(brokenSimilar.map(b => `"${b.from}" cites "${b.ref}"`)) : 'None found.'}

### Non-canonical themes (${nonCanonical.length})
Themes not in CLAUDE.md's canonical vocabulary — these don't contribute to \`fiveStarThemes\`/\`themeBonus\` scoring.
${nonCanonical.length ? renderList(nonCanonical.map(o => `"${o.title}": "${o.theme}"`)) : 'None found.'}

### Out-of-range field counts (library books only)
- Themes outside 2–5 range: **${ranges.themesOutOfRange.length}** ${ranges.themesOutOfRange.length ? '(' + ranges.themesOutOfRange.slice(0, 5).map(r => `"${r.title}"`).join(', ') + (ranges.themesOutOfRange.length > 5 ? ', …' : '') + ')' : ''}
- similarToTitles outside 3–5 range: **${ranges.similarOutOfRange.length}** ${ranges.similarOutOfRange.length ? '(' + ranges.similarOutOfRange.slice(0, 5).map(r => `"${r.title}"`).join(', ') + (ranges.similarOutOfRange.length > 5 ? ', …' : '') + ')' : ''}
- Zero/missing pages (kills pages-fit bonus): **${ranges.zeroPages.length}**
- Zero/missing ratingsCount (kills popularity bonus): **${ranges.zeroRatingsCount.length}**
- Missing a real bookKey (derived-key fallback, skipped by daily enrichment): **${ranges.missingBookKey.length}**
`;

const dateStamp = new Date().toISOString().slice(0, 10);
const outPath = `output/data-quality-report-${dateStamp}.md`;
fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(outPath, report);
console.log(`Wrote ${outPath}`);
