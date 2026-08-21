#!/usr/bin/env node
// Grows trakt/data/candidatePool.json from titles Bill has already loved.
// Pure local computation — no network calls — since it only reads TMDB's
// own similar/recommendations id lists that enrich_tmdb.py already cached
// on each loved title's enrichedMetadata.json entry. Candidates cited by
// more than one loved title are prioritized (a form of corroboration: two
// independent "similar to X" signals agreeing is a stronger prior than
// one), then enrich_tmdb.py (via trakt-enrich-tmdb.yml) fills in their
// real title/year/genres/etc — this script only produces bare-id stubs.
//
// Run manually: node trakt/scripts/discover_candidates.js [maxNew]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'trakt', 'data');
const MAX_NEW = parseInt(process.argv[2], 10) || 150;
const LOVED_THRESHOLD = 9;

const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJSON = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

const library = readJSON(path.join(DATA_DIR, 'library.json'), { titles: [] });
const watchlist = readJSON(path.join(DATA_DIR, 'watchlist.json'), { titles: [] });
const enrichedMeta = readJSON(path.join(DATA_DIR, 'enrichedMetadata.json'), {});
const existingPool = readJSON(path.join(DATA_DIR, 'candidatePool.json'), { titles: [] });

const known = new Set(); // titleKey of anything already watched, watchlisted, or already a candidate
for (const t of [...library.titles, ...watchlist.titles, ...existingPool.titles]) {
  if (t.titleKey) known.add(t.titleKey);
}

const lovedSources = library.titles.filter(t => t.myRating >= LOVED_THRESHOLD && enrichedMeta[t.titleKey]);

const citationCount = new Map(); // titleKey -> count
for (const t of lovedSources) {
  const meta = enrichedMeta[t.titleKey];
  const ids = new Set([...(meta.similarToIds || []), ...(meta.recommendedIds || [])]);
  for (const tmdbId of ids) {
    const key = `${t.type}:${tmdbId}`;
    if (known.has(key)) continue;
    citationCount.set(key, (citationCount.get(key) || 0) + 1);
  }
}

const ranked = [...citationCount.entries()]
  .map(([titleKey, citedBy]) => {
    const [type, tmdbId] = titleKey.split(':');
    return { type, titleKey, ids: { tmdb: Number(tmdbId) }, title: null, year: null, citedBy };
  })
  .sort((a, b) => b.citedBy - a.citedBy)
  .slice(0, MAX_NEW);

const merged = [...existingPool.titles, ...ranked];
writeJSON(path.join(DATA_DIR, 'candidatePool.json'), {
  meta: { generatedAt: new Date().toISOString(), count: merged.length },
  titles: merged,
});

console.log(`${lovedSources.length} loved+enriched sources scanned.`);
console.log(`${citationCount.size} unique new candidates found, added top ${ranked.length} (by citation count).`);
console.log(`trakt/data/candidatePool.json now has ${merged.length} total candidates.`);
console.log(`Movies: ${ranked.filter(c => c.type === 'movie').length}, Shows: ${ranked.filter(c => c.type === 'show').length}`);
