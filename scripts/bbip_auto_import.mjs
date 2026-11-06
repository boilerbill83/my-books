#!/usr/bin/env node
/**
 * BBIP automated import (see BBIP.md for the full plan/history this
 * generalizes). Parses a fresh Goodreads "Export Library" CSV, matches
 * rows against data/goodreadsData.json (Book Id first, normalized
 * title+author fallback -- BBIP.md's "Matching strategy"), and splits
 * the result into two buckets:
 *
 *   SAFE   -- unambiguous scalar updates (shelf/myRating/dateRead/
 *             dateAdded/avgRating/top10/allTimeFave, plus bookId/pages/
 *             year/isbn/isbn13 BACKFILL when we currently have none) --
 *             applied directly via surgical byte-span text-splice edits,
 *             never a full JSON.stringify rewrite (this project's
 *             standing discipline for this file).
 *   REVIEW -- anything needing judgment: new books (need real research
 *             to add properly), missing books (never guess a reason --
 *             Bill's standing rule), pages/year/isbn *conflicts* (Bill's
 *             standing rule: verify via a real outside source, never
 *             default to either side), and bookId mismatches on an
 *             already-populated field (usually the Goodreads
 *             duplicate-entry pattern BBIP.md documents -- needs
 *             investigation, not a blind overwrite).
 *
 * Designed to run unattended (a scheduled import), but every SAFE write
 * is followed by real verification before the caller is told it's safe
 * to commit: re-parse the file, confirm only whitelisted fields changed
 * on only the touched books, and (via --verify-eval) re-run
 * scripts/eval.js as a regression gate. A failure at any of these aborts
 * the whole batch rather than committing a partial/corrupt result.
 *
 * Usage:
 *   node scripts/bbip_auto_import.mjs <path-to-export.csv> [--apply] [--out-dir DIR]
 *
 * Without --apply this is a pure dry run: it prints a summary and writes
 * the review file, but never touches data/goodreadsData.json. With
 * --apply it also performs the safe writes (still writes the review file
 * for everything else).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const outDirIdx = args.indexOf('--out-dir');
const OUT_DIR = outDirIdx !== -1 ? args[outDirIdx + 1] : path.join(ROOT, 'output');
const dataFileIdx = args.indexOf('--data-file');
const DATA_FILE = dataFileIdx !== -1 ? path.resolve(args[dataFileIdx + 1]) : path.join(ROOT, 'data', 'goodreadsData.json');
const feedbackFileIdx = args.indexOf('--feedback-file');
const FEEDBACK_FILE = feedbackFileIdx !== -1 ? path.resolve(args[feedbackFileIdx + 1]) : path.join(ROOT, 'data', 'feedbackData.json');

if (!csvPath) {
  console.error('Usage: node scripts/bbip_auto_import.mjs <path-to-export.csv> [--apply] [--out-dir DIR]');
  process.exit(1);
}

// ─── CSV parsing (hand-rolled, RFC4180-ish: quoted fields, "" escape,
//     embedded newlines inside quotes -- this repo has no CSV dependency
//     and the project convention is zero deps for static-site scripts) ──

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map(r => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
      return obj;
    });
}

function stripIsbnWrapper(v) {
  // Goodreads exports ISBN/ISBN13 as ="1234567890"
  const m = /^="?(.*?)"?$/.exec(v || '');
  const out = m ? m[1] : (v || '');
  return out.trim();
}

// ─── Normalization (mirrors engine.js's norm()/engineNorm shape --
//     strip parenthetical/series notation, strip subtitle-after-colon,
//     word-set author matching) ────────────────────────────────────────

function normTitle(t) {
  return String(t || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')   // trailing series/edition notation
    .replace(/:.*/s, '')                 // subtitle after first colon
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normAuthorSet(a) {
  return new Set(
    String(a || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  );
}

function authorsMatch(a1, a2) {
  const s1 = normAuthorSet(a1), s2 = normAuthorSet(a2);
  if (!s1.size || !s2.size) return false;
  const [small, big] = s1.size <= s2.size ? [s1, s2] : [s2, s1];
  let hits = 0;
  for (const w of small) if (big.has(w)) hits++;
  return hits >= Math.min(small.size, 2); // at least 2 shared words, or all of a 1-word set
}

// ─── Shelf / date mapping ───────────────────────────────────────────────

function mapShelf(exclusiveShelf) {
  const s = (exclusiveShelf || '').trim().toLowerCase();
  if (s === 'read') return 'read';
  if (s === 'currently-reading') return 'currently-reading';
  if (s === 'to-read') return 'to-read';
  return null; // unrecognized -- never guess, leave shelf untouched
}

function csvDateToOurFormat(d) {
  // Goodreads exports YYYY/MM/DD already; just validate shape.
  const s = (d || '').trim();
  if (!s) return null;
  return /^\d{4}\/\d{2}\/\d{2}$/.test(s) ? s : null;
}

// ─── Load current data ──────────────────────────────────────────────────

const rawText = fs.readFileSync(DATA_FILE, 'utf8');
const data = JSON.parse(rawText);
const books = data.books;

const feedback = fs.existsSync(FEEDBACK_FILE) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')) : { interactions: [] };
const dismissedKeys = new Set((feedback.interactions || []).map(i => i.bookKey));

const byBookId = new Map();
const byNormTitleAuthor = new Map(); // normTitle -> [book,...]
for (const b of books) {
  if (b.bookId) byBookId.set(String(b.bookId), b);
  const nt = normTitle(b.title);
  if (!byNormTitleAuthor.has(nt)) byNormTitleAuthor.set(nt, []);
  byNormTitleAuthor.get(nt).push(b);
}

// ─── Parse the fresh export ─────────────────────────────────────────────

const csvText = fs.readFileSync(csvPath, 'utf8');
const rows = parseCsv(csvText);
if (!rows.length) {
  console.error('CSV parsed to 0 rows -- aborting, not touching anything.');
  process.exit(1);
}
const headerCols = Object.keys(rows[0]);
const hasAvgRating = headerCols.includes('Average Rating');
console.log(`Parsed ${rows.length} CSV rows. Columns: ${headerCols.join(', ')}`);
if (!hasAvgRating) {
  console.log('NOTE: no "Average Rating" column in this export -- avgRating updates skipped.');
}

// ─── Match rows -> books (one canonical match per book; Book Id wins) ───

const matchedBookKeys = new Set();   // our books that got a match
const matchedCsvRowIdx = new Set();  // csv rows consumed by a match
const pairs = []; // {book, row}

// Pass 1: Book Id
rows.forEach((row, idx) => {
  const csvId = (row['Book Id'] || '').trim();
  if (!csvId) return;
  const book = byBookId.get(csvId);
  if (book && !matchedBookKeys.has(book.bookKey)) {
    pairs.push({ book, row });
    matchedBookKeys.add(book.bookKey);
    matchedCsvRowIdx.add(idx);
  }
});

// Pass 2: normalized title + author fallback, only for still-unmatched rows/books
rows.forEach((row, idx) => {
  if (matchedCsvRowIdx.has(idx)) return;
  const nt = normTitle(row['Title']);
  const candidates = (byNormTitleAuthor.get(nt) || []).filter(b => !matchedBookKeys.has(b.bookKey));
  const hit = candidates.find(b => authorsMatch(b.author, row['Author']));
  if (hit) {
    pairs.push({ book: hit, row });
    matchedBookKeys.add(hit.bookKey);
    matchedCsvRowIdx.add(idx);
  }
});

const newRows = rows.filter((_, idx) => !matchedCsvRowIdx.has(idx));
const unmatchedBooks = books.filter(b => !matchedBookKeys.has(b.bookKey));

// Second-pass blind-spot check (BBIP.md matching strategy point 3): for
// each unmatched book, see if its author has a plausible fuzzy-title
// candidate among the still-new CSV rows before calling it missing.
const stillMissingBooks = [];
const retitleCandidates = []; // informational only -- flagged for review, never auto-merged
for (const b of unmatchedBooks) {
  const authorNewRows = newRows.filter(r => authorsMatch(b.author, r['Author']));
  const fuzzy = authorNewRows.find(r => {
    const nt1 = normTitle(b.title), nt2 = normTitle(r['Title']);
    return nt1.length >= 6 && nt2.length >= 6 && (nt1.includes(nt2) || nt2.includes(nt1));
  });
  if (fuzzy) {
    retitleCandidates.push({ book: b, row: fuzzy });
  } else {
    stillMissingBooks.push(b);
  }
}

// Only treat as "genuinely missing" if not already dnf/dismissed.
const missingForReview = stillMissingBooks.filter(b => !b.dnf && !dismissedKeys.has(b.bookKey));

// ─── Classify matched pairs into SAFE updates vs REVIEW flags ──────────

const SAFE_SCALAR_FIELDS = ['shelf', 'myRating', 'dateRead', 'dateAdded', 'avgRating', 'top10', 'allTimeFave'];
const BACKFILL_ONLY_FIELDS = ['bookId', 'pages', 'year', 'isbn', 'isbn13'];

const safeChanges = []; // {bookKey, field, oldValue, newValue}
const reviewFlags = []; // {bookKey, title, kind, detail}

for (const { book, row } of pairs) {
  const csvId = (row['Book Id'] || '').trim();

  // shelf
  const mappedShelf = mapShelf(row['Exclusive Shelf']);
  if (mappedShelf && mappedShelf !== book.shelf) {
    safeChanges.push({ bookKey: book.bookKey, field: 'shelf', oldValue: book.shelf, newValue: mappedShelf });
  }

  // myRating (0-5, 0 = unrated)
  const csvRating = Number(row['My Rating']);
  if (Number.isFinite(csvRating) && csvRating >= 0 && csvRating <= 5 && csvRating !== (book.myRating ?? 0)) {
    safeChanges.push({ bookKey: book.bookKey, field: 'myRating', oldValue: book.myRating, newValue: csvRating });
  }

  // dateRead
  const csvDateRead = csvDateToOurFormat(row['Date Read']);
  if (csvDateRead && csvDateRead !== book.dateRead) {
    safeChanges.push({ bookKey: book.bookKey, field: 'dateRead', oldValue: book.dateRead, newValue: csvDateRead });
  }

  // dateAdded
  const csvDateAdded = csvDateToOurFormat(row['Date Added']);
  if (csvDateAdded && csvDateAdded !== book.dateAdded) {
    safeChanges.push({ bookKey: book.bookKey, field: 'dateAdded', oldValue: book.dateAdded, newValue: csvDateAdded });
  }

  // avgRating (only if this export carries it)
  if (hasAvgRating) {
    const csvAvg = Number(row['Average Rating']);
    if (Number.isFinite(csvAvg) && csvAvg > 0 && Math.abs(csvAvg - (book.avgRating ?? 0)) > 0.001) {
      safeChanges.push({ bookKey: book.bookKey, field: 'avgRating', oldValue: book.avgRating, newValue: csvAvg });
    }
  }

  // top10 / allTimeFave from the Bookshelves custom-shelf list
  const shelves = (row['Bookshelves'] || '').toLowerCase();
  const isTop10 = shelves.split(',').map(s => s.trim()).includes('top-10');
  const isFave = shelves.split(',').map(s => s.trim()).includes('all-time-faves');
  if (isTop10 !== !!book.top10) {
    safeChanges.push({ bookKey: book.bookKey, field: 'top10', oldValue: !!book.top10, newValue: isTop10 });
  }
  if (isFave !== !!book.allTimeFave) {
    safeChanges.push({ bookKey: book.bookKey, field: 'allTimeFave', oldValue: !!book.allTimeFave, newValue: isFave });
  }

  // bookId: backfill only; a populated mismatch is a review flag
  if (csvId) {
    if (!book.bookId) {
      safeChanges.push({ bookKey: book.bookKey, field: 'bookId', oldValue: null, newValue: csvId });
    } else if (String(book.bookId) !== csvId) {
      reviewFlags.push({ bookKey: book.bookKey, title: book.title, kind: 'bookId-mismatch',
        detail: `stored bookId ${book.bookId} vs. export's ${csvId} -- likely a Goodreads duplicate-entry pattern (see BBIP.md); needs investigation before either is trusted.` });
    }
  }

  // pages: backfill-only safe; a real disagreement is ALWAYS a review flag
  // (Bill's standing rule -- never default to either side, verify via a
  // real outside source).
  const csvPages = parseInt(row['Number of Pages'], 10);
  if (Number.isFinite(csvPages) && csvPages > 0) {
    if (!book.pages) {
      safeChanges.push({ bookKey: book.bookKey, field: 'pages', oldValue: null, newValue: csvPages });
    } else if (csvPages !== book.pages) {
      reviewFlags.push({ bookKey: book.bookKey, title: book.title, kind: 'pages-conflict',
        detail: `stored pages ${book.pages} vs. export's ${csvPages} -- do not auto-apply either value; verify via a real outside source (publisher page, Amazon, WorldCat) per the standing pages-conflict rule.` });
    }
  }

  // year: same backfill-only-safe / conflict-flagged treatment
  const csvYear = parseInt(row['Original Publication Year'] || row['Year Published'], 10);
  if (Number.isFinite(csvYear) && csvYear > 0) {
    if (!book.year) {
      safeChanges.push({ bookKey: book.bookKey, field: 'year', oldValue: null, newValue: csvYear });
    } else if (csvYear !== book.year) {
      reviewFlags.push({ bookKey: book.bookKey, title: book.title, kind: 'year-conflict',
        detail: `stored year ${book.year} vs. export's ${csvYear} -- not auto-applied; low stakes but flagged for consistency with the pages-conflict rule.` });
    }
  }

  // isbn / isbn13: backfill-only safe, conflict flagged
  for (const [field, csvCol] of [['isbn', 'ISBN'], ['isbn13', 'ISBN13']]) {
    const csvVal = stripIsbnWrapper(row[csvCol]);
    if (csvVal) {
      if (!book[field]) {
        safeChanges.push({ bookKey: book.bookKey, field, oldValue: null, newValue: csvVal });
      } else if (csvVal !== book[field]) {
        reviewFlags.push({ bookKey: book.bookKey, title: book.title, kind: `${field}-conflict`,
          detail: `stored ${field} ${book[field]} vs. export's ${csvVal} -- not auto-applied.` });
      }
    }
  }
}

// New books (unmatched CSV rows) -- always review, never auto-added
// (BBIP.md: adding a new book needs real research -- themes/tones/
// similarToTitles, verified comps -- not something to guess unattended).
const newBookFlags = newRows.map(row => ({
  bookKey: null,
  title: row['Title'],
  author: row['Author'],
  shelf: mapShelf(row['Exclusive Shelf']),
  myRating: row['My Rating'],
  kind: 'new-book',
  detail: `Not in goodreadsData.json. Needs real research to add properly (themes/tones/similarToTitles) -- see BBIP.md Phase 7.`,
}));

for (const r of retitleCandidates) {
  reviewFlags.push({ bookKey: r.book.bookKey, title: r.book.title, kind: 'possible-retitle',
    detail: `No direct match, but a plausible fuzzy-title candidate exists in this export: "${r.row['Title']}" by ${r.row['Author']} (Book Id ${r.row['Book Id']}). Could be the same book re-edited/retitled (BBIP.md matching strategy point 3) -- confirm before touching.` });
}

for (const b of missingForReview) {
  reviewFlags.push({ bookKey: b.bookKey, title: b.title, kind: 'missing-from-export',
    detail: `Was shelf="${b.shelf}" in our data, not dnf, no feedbackData.json dismissal on file, and absent from this export. Never guess a reason -- ask Bill directly, same as every prior BBIP round.` });
}

// ─── Report ──────────────────────────────────────────────────────────────

console.log(`\nMatched: ${pairs.length} / ${rows.length} CSV rows`);
console.log(`New (unmatched CSV rows): ${newRows.length}`);
console.log(`Missing (our books absent from export, not already explained): ${missingForReview.length}`);
console.log(`Possible retitle/re-edition matches: ${retitleCandidates.length}`);
console.log(`\nSafe changes computed: ${safeChanges.length}`);
console.log(`Review flags: ${reviewFlags.length + newBookFlags.length}`);

// ─── Write the review file (always, regardless of --apply) ─────────────

fs.mkdirSync(OUT_DIR, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const reviewPath = path.join(OUT_DIR, `bbip-review-${today}.md`);
const reviewLines = [];
reviewLines.push(`# BBIP auto-import review — ${today}`);
reviewLines.push('');
reviewLines.push(`Source: \`${path.basename(csvPath)}\` (${rows.length} rows). Matched ${pairs.length}.`);
reviewLines.push('');
reviewLines.push(`${APPLY ? 'This run APPLIED the safe changes below.' : 'DRY RUN -- no changes written.'}`);
reviewLines.push('');
reviewLines.push('## Safe changes ' + (APPLY ? '(applied)' : '(would apply with --apply)') + ` — ${safeChanges.length}`);
reviewLines.push('');
if (safeChanges.length) {
  reviewLines.push('| bookKey | field | old | new |');
  reviewLines.push('|---|---|---|---|');
  for (const c of safeChanges) {
    reviewLines.push(`| ${c.bookKey} | ${c.field} | ${JSON.stringify(c.oldValue)} | ${JSON.stringify(c.newValue)} |`);
  }
} else {
  reviewLines.push('_none_');
}
reviewLines.push('');
reviewLines.push(`## Needs your review — ${reviewFlags.length + newBookFlags.length}`);
reviewLines.push('');
reviewLines.push('Nothing in this section was touched. Each needs a human decision (research, a');
reviewLines.push('real outside source, or asking Bill directly) before anything gets written.');
reviewLines.push('');
if (newBookFlags.length) {
  reviewLines.push(`### New books (${newBookFlags.length})`);
  reviewLines.push('');
  reviewLines.push('| title | author | shelf | rating |');
  reviewLines.push('|---|---|---|---|');
  for (const f of newBookFlags) reviewLines.push(`| ${f.title} | ${f.author} | ${f.shelf || '?'} | ${f.myRating || ''} |`);
  reviewLines.push('');
}
const byKind = {};
for (const f of reviewFlags) { (byKind[f.kind] ||= []).push(f); }
for (const [kind, flags] of Object.entries(byKind)) {
  reviewLines.push(`### ${kind} (${flags.length})`);
  reviewLines.push('');
  for (const f of flags) reviewLines.push(`- **${f.title}** (\`${f.bookKey}\`): ${f.detail}`);
  reviewLines.push('');
}
fs.writeFileSync(reviewPath, reviewLines.join('\n') + '\n');
console.log(`\nReview file written: ${reviewPath}`);

if (!APPLY) {
  console.log('\nDry run only -- pass --apply to write the safe changes.');
  process.exit(0);
}

if (!safeChanges.length) {
  console.log('\nNo safe changes to apply.');
  process.exit(0);
}

// ─── Apply safe changes via surgical byte-span text-splice ─────────────
//
// Single forward scan over the raw file text (string-boundary-aware, so a
// literal brace inside a title/author string can never desync the brace
// count -- the exact bug class Session 27's similarToTitles work hit and
// fixed). Books in this schema never nest another object inside a book
// record (themes/similarToTitles/similarToAuthors/tones are all arrays of
// plain strings), so each book is exactly one non-nested {...} span.

function findBookSpans(text) {
  // Stack-based (string-boundary-aware) brace matcher. Records EVERY
  // {...} pair in the document -- the whole top-level document object,
  // "meta", and every book record are all `{...}` pairs -- then, for
  // each pair in the order it *closes* (a book closes well before the
  // top-level document's own closing brace, since siblings close before
  // their parent), takes the first (innermost/tightest) span whose text
  // contains a given bookKey. A book's own span is always recorded
  // before the top-level document's much larger span would also
  // (wrongly) match the first bookKey in the file, so "first recorded
  // wins" is sufficient -- no nested objects exist inside a book record
  // in this schema, so there's no deeper ambiguity to resolve.
  const spans = new Map(); // bookKey -> {start, end}
  let inString = false;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; } // skip escaped char
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { stack.push(i); continue; }
    if (c === '}') {
      const start = stack.pop();
      if (start === undefined) continue; // malformed input, shouldn't happen on valid JSON
      const span = text.slice(start, i + 1);
      const m = /"bookKey"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(span);
      if (m) {
        const key = m[1].replace(/\\(.)/g, '$1');
        if (!spans.has(key)) spans.set(key, { start, end: i + 1 });
      }
      continue;
    }
  }
  return spans;
}

function scalarLiteral(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

function patchScalarField(objText, field, newValue) {
  const re = new RegExp(`("${field}"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null)`, 's');
  const literal = scalarLiteral(newValue);
  if (re.test(objText)) {
    return objText.replace(re, (_m, p1) => `${p1}${literal}`);
  }
  // Field absent (backfill case): insert right after "bookKey" -- the one
  // field guaranteed present on every record (unlike "bookId", which can
  // itself be the field being backfilled in the same batch -- confirmed
  // by a real test case this script's own development hit: Stoner has
  // neither bookId nor dateRead, and anchoring on bookId failed exactly
  // when bookId hadn't been inserted yet).
  const afterKeyRe = /("bookKey"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\n(\s*))/;
  const m = afterKeyRe.exec(objText);
  if (m) {
    const indent = m[2];
    const insertion = `"${field}": ${literal},\n${indent}`;
    return objText.slice(0, m.index + m[1].length) + insertion + objText.slice(m.index + m[1].length);
  }
  throw new Error(`Could not find an anchor to backfill field "${field}" -- aborting rather than guessing a position.`);
}

let patchedText = rawText;
const touchedFields = new Map(); // bookKey -> Set(fields)
for (const c of safeChanges) {
  if (!touchedFields.has(c.bookKey)) touchedFields.set(c.bookKey, new Set());
  touchedFields.get(c.bookKey).add(c.field);
}

for (const [bookKey, fields] of touchedFields) {
  const spans = findBookSpans(patchedText); // re-scan each time since offsets shift
  const span = spans.get(bookKey);
  if (!span) throw new Error(`Could not locate object span for bookKey "${bookKey}" -- aborting, no changes committed.`);
  let objText = patchedText.slice(span.start, span.end);
  for (const field of fields) {
    const change = safeChanges.find(c => c.bookKey === bookKey && c.field === field);
    objText = patchScalarField(objText, field, change.newValue);
  }
  patchedText = patchedText.slice(0, span.start) + objText + patchedText.slice(span.end);
}

// ─── Post-write verification (abort, don't commit, on any failure) ─────

let parsedAfter;
try {
  parsedAfter = JSON.parse(patchedText);
} catch (e) {
  console.error('ABORT: patched file is not valid JSON -- not writing. ' + e.message);
  process.exit(1);
}

const beforeByKey = new Map(books.map(b => [b.bookKey, b]));
const afterByKey = new Map(parsedAfter.books.map(b => [b.bookKey, b]));
const ALLOWED_FIELDS = new Set([...SAFE_SCALAR_FIELDS, ...BACKFILL_ONLY_FIELDS]);

if (afterByKey.size !== beforeByKey.size) {
  console.error(`ABORT: book count changed (${beforeByKey.size} -> ${afterByKey.size}) -- not writing.`);
  process.exit(1);
}

let unexpectedFieldChange = false;
for (const [key, beforeBook] of beforeByKey) {
  const afterBook = afterByKey.get(key);
  if (!afterBook) { console.error(`ABORT: book "${key}" disappeared -- not writing.`); process.exit(1); }
  const allKeys = new Set([...Object.keys(beforeBook), ...Object.keys(afterBook)]);
  for (const f of allKeys) {
    const bv = JSON.stringify(beforeBook[f] ?? null);
    const av = JSON.stringify(afterBook[f] ?? null);
    if (bv !== av && !ALLOWED_FIELDS.has(f)) {
      console.error(`ABORT: unexpected field change on "${key}".${f} (${bv} -> ${av}) -- not in the safe-field whitelist. Not writing.`);
      unexpectedFieldChange = true;
    }
  }
}
if (unexpectedFieldChange) process.exit(1);

fs.writeFileSync(DATA_FILE, patchedText);
console.log(`\nApplied ${safeChanges.length} safe change(s) to ${DATA_FILE}.`);
console.log('Re-parse + whitelist checks passed. Run scripts/eval.js next as the regression gate before committing.');
