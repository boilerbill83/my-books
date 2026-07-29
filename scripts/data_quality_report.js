#!/usr/bin/env node
// Weekly data quality report: field-population analysis (Field Name,
// Percent Populated, Quality Score, How Score is Determined, Suggestions
// for Improvement) via FIELD_REGISTRY, plus data integrity checks
// (duplicates, broken similarToTitles refs, non-canonical themes,
// out-of-range field counts). Writes a dated Markdown report to
// output/data-quality-report-YYYY-MM-DD.md, plus a machine-readable
// output/data-quality-report-YYYY-MM-DD.json snapshot used to diff this
// run against the most recent prior one (week-over-week trend section).
// Run from repo root: node scripts/data_quality_report.js

import fs from 'fs';
import path from 'path';
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

// ── Field registry ───────────────────────────────────────────────────────────
// Quality Score is population % measured against the ELIGIBLE subset of rows
// for that field, not the full 1117 — a field that structurally only applies
// to read books (myRating) or is only targeted by one enrichment job for
// certain shelves (coverUrl, amazonRating) would otherwise look like a
// "gap" when it's actually complete for the rows it applies to. Percent
// Populated (raw, of all rows) is kept alongside so the difference is
// visible. `critical: true` marks fields that directly feed a BBRE/engine
// scoring signal (CLAUDE.md "Engine Summary" table) — these get a lower
// (stricter) warning threshold and surface first in Action Items, since a
// gap here actually degrades recommendations rather than just leaving the
// extract incomplete. Eligibility scopes and suggestions below are the
// root causes diagnosed in CLAUDE.md Session 13b-13e — update this
// registry, not just the data, when a new enrichment job changes scope.
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

// Buckets broken similarToTitles refs into:
//  - nearMiss: a close match exists (substring/prefix or small edit
//    distance) — almost always a fixable typo, truncation, or an edition
//    difference engineNorm() didn't already catch. Worth a human fix.
//  - orphaned: no close match anywhere — most likely a "flavor" reference
//    to a book that was never added to the dataset at all. Lower priority.
function findBrokenSimilarToTitles() {
  const titleList = [...new Set(rows.map(r => engineNorm(r.title)))].filter(Boolean);
  const titleSet = new Set(titleList);
  // Bucket candidate titles by length for cheap Levenshtein pre-filtering.
  const byLength = new Map();
  for (const t of titleList) {
    if (!byLength.has(t.length)) byLength.set(t.length, []);
    byLength.get(t.length).push(t);
  }

  const nearMiss = [];
  const orphaned = [];
  const seen = new Set(); // avoid re-checking the same broken ref string repeatedly

  for (const r of rows) {
    for (const t of r.similarToTitles) {
      const nt = engineNorm(t);
      if (!nt || titleSet.has(nt)) continue; // resolves fine under engine matching

      const dedupeKey = nt;
      let classification = seen.has(dedupeKey) ? null : undefined;
      if (classification === undefined) {
        const isNear = titleList.some(candidate =>
          candidate.length >= 5 && nt.length >= 5 &&
          (candidate.includes(nt) || nt.includes(candidate))
        ) || (() => {
          for (let len = nt.length - 3; len <= nt.length + 3; len++) {
            const bucket = byLength.get(len);
            if (!bucket) continue;
            for (const candidate of bucket) {
              if (levenshtein(nt, candidate) <= 3) return true;
            }
          }
          return false;
        })();
        classification = isNear ? 'near' : 'orphan';
        seen.add(dedupeKey);
      }

      const entry = { from: r.title, ref: t };
      if (classification === 'near') nearMiss.push(entry);
      else if (classification === 'orphan') orphaned.push(entry);
      // classification === null shouldn't occur since we always cache above
    }
  }
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

// ── Week-over-week trend ─────────────────────────────────────────────────────

function loadPreviousSnapshot(todayStamp) {
  const files = fs.existsSync('output')
    ? fs.readdirSync('output').filter(f => /^data-quality-report-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];
  const dates = files
    .map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1])
    .filter(d => d < todayStamp)
    .sort();
  if (!dates.length) return null;
  const prevDate = dates[dates.length - 1];
  try {
    return JSON.parse(fs.readFileSync(path.join('output', `data-quality-report-${prevDate}.json`), 'utf8'));
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

// ── Render report ────────────────────────────────────────────────────────────

function renderPopulationTable(stats) {
  const lines = [
    '| Field Name | Percent Populated | Quality Score | How Score is Determined | Suggestions for Improvement |',
    '|---|---|---|---|---|',
  ];
  for (const s of stats) {
    const label = scoreLabel(s.scorePct);
    const flag = s.belowThreshold ? (s.critical ? ' 🔴' : ' ⚠️') : '';
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

function renderActionItems(stats, integrity, trend) {
  const lines = [];
  const criticalLow = stats.filter(s => s.critical && s.belowThreshold);
  const otherLow = stats.filter(s => !s.critical && s.belowThreshold).slice(0, 5);

  if (criticalLow.length) {
    lines.push('**🔴 Scoring-critical fields below threshold** (these directly degrade recommendations, not just extract completeness):');
    lines.push(...criticalLow.map(s => `- \`${s.field}\`: ${s.scorePct.toFixed(1)}% — ${s.suggest}`));
  } else {
    lines.push('**🔴 Scoring-critical fields:** all above threshold. Nothing urgent.');
  }

  if (otherLow.length) {
    lines.push('', '**⚠️ Other low-scoring fields (top 5):**');
    lines.push(...otherLow.map(s => `- \`${s.field}\`: ${s.scorePct.toFixed(1)}%`));
  }

  lines.push('', '**Data integrity highlights:**');
  lines.push(`- ${integrity.dupBookKeys} duplicate bookKey group(s), ${integrity.dupTitleAuthor} book(s) duplicated across library/candidate pools`);
  lines.push(`- ${integrity.brokenNearMiss} likely-fixable broken similarToTitles reference(s) (near-miss), ${integrity.brokenOrphaned} orphaned (no close match)`);
  lines.push(`- ${integrity.promoteCandidateCount} non-canonical theme(s) used often enough to be canonical-vocabulary candidates`);

  if (trend) {
    lines.push('', `**Week-over-week (vs ${trend.previousDate}):**`);
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
    lines.push('', '**Week-over-week:** no prior snapshot found — this is the baseline run.');
  }

  return lines.join('\n');
}

const stats = populationStats();
const dupBookKeys = findDuplicateBookKeys();
const dupTitleAuthor = findDuplicateTitleAuthor();
const { nearMiss: brokenNearMiss, orphaned: brokenOrphaned } = findBrokenSimilarToTitles();
const { offenders: nonCanonical, promoteCandidates } = findNonCanonicalThemes();
const ranges = findOutOfRangeCounts();

const shelfCounts = SHELVES.map(sh => `${sh}: ${rows.filter(r => r.shelf === sh).length}`).join(', ');
const dateStamp = new Date().toISOString().slice(0, 10);

const integritySummary = {
  dupBookKeys: dupBookKeys.length,
  dupTitleAuthor: dupTitleAuthor.length,
  brokenNearMiss: brokenNearMiss.length,
  brokenOrphaned: brokenOrphaned.length,
  nonCanonicalTotal: nonCanonical.length,
  promoteCandidateCount: promoteCandidates.length,
  themesOutOfRange: ranges.themesOutOfRange.length,
  similarOutOfRange: ranges.similarOutOfRange.length,
  zeroPages: ranges.zeroPages.length,
  zeroRatingsCount: ranges.zeroRatingsCount.length,
  missingBookKey: ranges.missingBookKey.length,
};

const currentSnapshot = {
  date: dateStamp,
  totalBooks: rows.length,
  fields: stats.map(s => ({ field: s.field, scorePct: s.scorePct, rawPct: s.rawPct, critical: s.critical })),
  integrity: integritySummary,
};

const previousSnapshot = loadPreviousSnapshot(dateStamp);
const trend = computeTrend(currentSnapshot, previousSnapshot);

const report = `# Data Quality Report — ${dateStamp}

Generated by \`scripts/data_quality_report.js\`. Total books analyzed: **${rows.length}** (${shelfCounts}).

## Action Items

${renderActionItems(stats, integritySummary, trend)}

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

## Data Integrity

### Duplicate bookKeys (${dupBookKeys.length})
${dupBookKeys.length ? renderList(dupBookKeys.map(([k, list]) => `\`${k}\` — ${list.map(r => `"${r.title}" (${r.source}/${r.shelf})`).join(', ')}`)) : 'None found.'}

### Duplicate title+author across sources (${dupTitleAuthor.length})
${dupTitleAuthor.length ? renderList(dupTitleAuthor.map(([, list]) => `"${list[0].title}" by ${list[0].author} — appears in ${list.map(r => `${r.source}/${r.shelf}`).join(', ')}`)) : 'None found.'}

### Broken similarToTitles references
Checked against the engine's actual title-matching normalization (parenthetical/series notation stripped, same as \`norm()\` in engine.js) — so this excludes refs the engine already resolves fine, unlike a naive string comparison.

**Near-miss (${brokenNearMiss.length})** — a close match exists in the dataset (substring/prefix overlap or a small edit distance); almost always a fixable typo, truncation, or formatting difference.
${brokenNearMiss.length ? renderList(brokenNearMiss.map(b => `"${b.from}" cites "${b.ref}"`)) : 'None found.'}

**Orphaned (${brokenOrphaned.length})** — no close match anywhere in the dataset; likely a reference to a book that was never added at all. Lower priority than near-miss.
${brokenOrphaned.length ? renderList(brokenOrphaned.map(b => `"${b.from}" cites "${b.ref}"`)) : 'None found.'}

### Non-canonical themes (${nonCanonical.length} uses)
Themes not in CLAUDE.md's canonical vocabulary — these don't contribute to \`fiveStarThemes\`/\`themeBonus\` scoring.

**Canonical-vocabulary candidates** — used ${promoteCandidates.length ? `≥5 times each` : 'nowhere near the promotion threshold'}, which suggests a real vocabulary gap rather than a one-off typo:
${promoteCandidates.length ? renderList(promoteCandidates.map(([theme, count]) => `"${theme}" — ${count} uses`)) : 'None — no non-canonical theme is used often enough to suggest a real gap.'}

All non-canonical uses (including one-offs):
${nonCanonical.length ? renderList(nonCanonical.map(o => `"${o.title}": "${o.theme}"`)) : 'None found.'}

### Out-of-range field counts (library books only)
- Themes outside 2–5 range: **${ranges.themesOutOfRange.length}** ${ranges.themesOutOfRange.length ? '(' + ranges.themesOutOfRange.slice(0, 5).map(r => `"${r.title}"`).join(', ') + (ranges.themesOutOfRange.length > 5 ? ', …' : '') + ')' : ''}
- similarToTitles outside 3–5 range: **${ranges.similarOutOfRange.length}** ${ranges.similarOutOfRange.length ? '(' + ranges.similarOutOfRange.slice(0, 5).map(r => `"${r.title}"`).join(', ') + (ranges.similarOutOfRange.length > 5 ? ', …' : '') + ')' : ''}
- Zero/missing pages (kills pages-fit bonus): **${ranges.zeroPages.length}**
- Zero/missing ratingsCount (kills popularity bonus): **${ranges.zeroRatingsCount.length}**
- Missing a real bookKey (derived-key fallback, skipped by daily enrichment): **${ranges.missingBookKey.length}**
`;

fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(`output/data-quality-report-${dateStamp}.md`, report);
fs.writeFileSync(`output/data-quality-report-${dateStamp}.json`, JSON.stringify(currentSnapshot, null, 2) + '\n');
console.log(`Wrote output/data-quality-report-${dateStamp}.md and .json`);
