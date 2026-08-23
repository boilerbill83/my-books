#!/usr/bin/env node
// Full daily data extract: every watched title, every watchlisted title,
// and every discovered candidate (library.json + watchlist.json +
// candidatePool.json), merged with all TMDB metadata, OMDb metadata,
// feedback/exclusion state, and the engine's own live-computed scores.
// Writes trakt/output/all-titles-YYYY-MM-DD.csv (dated so each run keeps
// its own snapshot, mirroring the book side's scripts/export_extract.js).
//
// Run from repo root: node trakt/scripts/export_extract.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAllTitles } from './lib/loadAllTitles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const { rows } = loadAllTitles();

const arrayFields = new Set(['genres', 'keywords', 'similarToIds', 'recommendedIds', 'topCast', 'similarToTitles', 'similarToDirectors']);
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
const outDir = path.join(ROOT, 'trakt', 'output');
const outPath = path.join(outDir, `all-titles-${dateStamp}.csv`);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, csv + '\n');

const byStatus = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
console.log(`Wrote ${outPath}: ${rows.length} titles (${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
