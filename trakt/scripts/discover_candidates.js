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
const HISTORY_PATH = path.join(DATA_DIR, 'discoveredHistory.json');
const history = readJSON(HISTORY_PATH, { titleKeys: [] });

// known = anything already watched, watchlisted, currently a candidate, OR
// discovered by a past run and since evicted by prune_candidate_pool.js.
// That last part matters once this runs on a recurring schedule alongside
// pruning: without it, a title evicted last week for scoring low would
// look brand new again next week (prune_candidate_pool.js deletes it from
// candidatePool.json, the only place the old "known" check looked), get
// re-added, then likely get re-evicted again — a permanent weekly loop of
// the exact same losing candidates. discoveredHistory.json is append-only
// and never shrinks, so once a title's been evaluated once, it's not
// re-evaluated just because it fell out of the active pool.
const known = new Set(history.titleKeys);
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

// Ranked and capped PER TYPE, not as one combined global top-N. Bill has
// roughly twice as many loved shows as loved movies (99 vs 50 as of this
// build), so shows generate a denser citation network and would otherwise
// dominate a single combined ranking on citation count alone — the same
// structural pool-size imbalance trakt/engine.js's matchPointScale() was
// built to compensate for on the scoring side. Left uncorrected here, a
// movie could never even reach the candidate pool to be scored, let alone
// compete once matchPointScale evens out the scoring formula downstream.
const byType = new Map();
for (const [titleKey, citedBy] of citationCount.entries()) {
  const [type, tmdbId] = titleKey.split(':');
  const entry = { type, titleKey, ids: { tmdb: Number(tmdbId) }, title: null, year: null, citedBy };
  if (!byType.has(type)) byType.set(type, []);
  byType.get(type).push(entry);
}
const ranked = [...byType.values()]
  .flatMap(list => list.sort((a, b) => b.citedBy - a.citedBy).slice(0, MAX_NEW));

const merged = [...existingPool.titles, ...ranked];
writeJSON(path.join(DATA_DIR, 'candidatePool.json'), {
  meta: { generatedAt: new Date().toISOString(), count: merged.length },
  titles: merged,
});

const historyKeys = new Set(history.titleKeys);
for (const c of ranked) historyKeys.add(c.titleKey);
writeJSON(HISTORY_PATH, { titleKeys: [...historyKeys] });

console.log(`${lovedSources.length} loved+enriched sources scanned.`);
console.log(`${citationCount.size} unique new candidates found, added top ${ranked.length} (by citation count).`);
console.log(`trakt/data/candidatePool.json now has ${merged.length} total candidates.`);
console.log(`Movies: ${ranked.filter(c => c.type === 'movie').length}, Shows: ${ranked.filter(c => c.type === 'show').length}`);
