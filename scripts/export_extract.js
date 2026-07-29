#!/usr/bin/env node
// Full weekly data extract: every book Bill has read/to-read (goodreadsData.json)
// plus every external candidate-pool book, merged with all enrichment metadata
// (descriptions/categories from enrichedMetadata.json, third-party ratings from
// scrapedRatings.json, dismissal/feedback state from feedbackData.json).
// Writes output/all-books-YYYY-MM-DD.csv (dated so each run keeps its own
// snapshot). Run from repo root: node scripts/export_extract.js

import fs from 'fs';
import { loadAllBooks } from './lib/loadData.js';

const { rows } = loadAllBooks();

const arrayFields = new Set([
  'themes', 'tones', 'similarToTitles', 'similarToAuthors', 'categories', 'subjects',
]);

const columns = Object.keys(rows[0]);

const csvEscape = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csv = [
  columns.join(','),
  ...rows.map(row => columns.map(c => {
    const v = arrayFields.has(c) ? row[c].join('; ') : row[c];
    return csvEscape(v);
  }).join(',')),
].join('\n');

const dateStamp = new Date().toISOString().slice(0, 10);
const outPath = `output/all-books-${dateStamp}.csv`;

fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(outPath, csv + '\n');

console.log(`Wrote ${outPath}: ${rows.length} books`);
