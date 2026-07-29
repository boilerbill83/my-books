#!/usr/bin/env node
// Full weekly data extract: every book Bill has read/to-read (goodreadsData.json)
// plus every external candidate-pool book, merged with all enrichment metadata
// (descriptions/categories from enrichedMetadata.json, third-party ratings from
// scrapedRatings.json, dismissal/feedback state from feedbackData.json).
// Writes output/all-books-YYYY-MM-DD.csv (dated so each run keeps its own
// snapshot). Run from repo root: node scripts/export_extract.js

import fs from 'fs';
import path from 'path';

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const norm = s => (s || '').toString().trim().toLowerCase();
const deriveKey = (title, author) => `${norm(title)}|||${norm(author)}`;

// Mirrors scrape_ratings.py's book_key(): bare title (no subtitle/series
// notation) + first-listed author only. scrapedRatings.json is keyed this
// way, not by the full title, so lookups must match it exactly.
const scrapedKey = (title, author) => {
  let t = (title || '').toString().replace(/\s*[:({\[].*/, '').trim().toLowerCase();
  t = t.replace(/\s*\(.*?\)\s*$/, '').trim();
  const a = (author || '').toString().split(',')[0].trim().toLowerCase();
  return `${t}|||${a}`;
};

const goodreads = read('data/goodreadsData.json');
const feedback = read('data/feedbackData.json');
let enrichedMeta = {};
try { enrichedMeta = read('data/enrichedMetadata.json'); } catch {}
let scrapedRatings = {};
try { scrapedRatings = read('data/scrapedRatings.json'); } catch {}
let currentlyReading = [];
try { currentlyReading = read('data/currentlyReading.json'); } catch {}

const candidateFiles = read('data/candidateIndex.json');
const candidates = candidateFiles.flatMap(f => read(path.join('data', f)).candidates);

const feedbackByKey = new Map(
  feedback.interactions.map(i => [i.bookKey || deriveKey(i.title, i.author), i])
);

const libraryKeys = new Set(
  goodreads.books.map(b => deriveKey(b.title, b.author))
);

const rows = [];

for (const b of goodreads.books) {
  rows.push({ ...b, source: 'library' });
}

for (const c of candidates) {
  rows.push({ ...c, shelf: 'candidate-pool', source: 'candidate_pool' });
}

for (const cr of currentlyReading) {
  if (libraryKeys.has(deriveKey(cr.title, cr.author))) continue;
  rows.push({ ...cr, source: 'currently_reading_feed' });
}

const extract = rows.map(b => {
  const key = b.bookKey || deriveKey(b.title, b.author);
  const meta = enrichedMeta[key] || {};
  const ratings = scrapedRatings[scrapedKey(b.title, b.author)] || {};
  const fb = feedbackByKey.get(key);
  const goodreadsUrl = b.goodreadsUrl
    || (b.bookId ? `https://www.goodreads.com/book/show/${b.bookId}` : '')
    || (b.title ? `https://www.goodreads.com/search?q=${encodeURIComponent(`${b.title} ${b.author || ''}`.trim())}` : '');

  return {
    bookKey: key,
    title: b.title || '',
    author: b.author || '',
    source: b.source,
    shelf: b.shelf || '',
    type: b.type || '',
    year: b.year ?? '',
    pages: b.pages ?? '',
    myRating: b.myRating ?? '',
    avgRating: b.avgRating ?? '',
    ratingsCount: b.ratingsCount ?? '',
    amazonRating: ratings.amazon?.rating ?? '',
    amazonRatingsCount: ratings.amazon?.count ?? '',
    isbn: b.isbn || '',
    isbn13: b.isbn13 || '',
    publisher: b.publisher || '',
    dateRead: b.dateRead || '',
    dateAdded: b.dateAdded || '',
    themes: (b.themes || []).join('; '),
    tones: (b.tones || []).join('; '),
    similarToTitles: (b.similarToTitles || []).join('; '),
    similarToAuthors: (b.similarToAuthors || []).join('; '),
    categories: (meta.categories || []).join('; '),
    subjects: (meta.subjects || []).join('; '),
    description: meta.description || '',
    metadataFetchedAt: meta.fetchedAt || '',
    dismissed: fb ? Boolean(fb.excludeFromRecommendations) : false,
    dismissReason: fb?.reasonLabel || '',
    coverUrl: b.coverUrl || '',
    goodreadsUrl,
    top10: Boolean(b.top10),
  };
});

const columns = Object.keys(extract[0]);

const csvEscape = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csv = [
  columns.join(','),
  ...extract.map(row => columns.map(c => csvEscape(row[c])).join(',')),
].join('\n');

const dateStamp = new Date().toISOString().slice(0, 10);
const outPath = `output/all-books-${dateStamp}.csv`;

fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(outPath, csv + '\n');

console.log(`Wrote ${outPath}: ${extract.length} books (${goodreads.books.length} library + ${candidates.length} candidate pool)`);
