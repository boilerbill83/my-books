#!/usr/bin/env node
// Ingests a full Trakt account-data-export directory into this project's
// own durable data files: trakt/data/library.json (watched movies+shows,
// with ratings), trakt/data/watchlist.json (unwatched, explicitly queued),
// and trakt/data/currentlyWatching.json (shows mid-way through).
//
// Usage: unzip the export somewhere, then run:
//   node trakt/scripts/build_trakt_library.js <path-to-extracted-export-dir>
//
// Incremental upsert, not a full overwrite: re-running against a fresh
// export refreshes myRating/plays/lastWatchedAt/favorite on titles already
// in library.json and adds new ones, but never silently drops a title that
// vanished from a re-export (that could just mean it aged out of the
// export's history window, not that Bill un-watched it) — those are
// reported for manual review instead, the same defensive posture BBIP.md
// documents for the book project's own reconciliation passes.
//
// Run this alongside scripts/build_trakt_dashboard.js whenever Bill
// uploads a fresh export — see CLAUDE.md's "BMTRE" section for the full
// update workflow, including how the daily TMDB enrichment workflow picks
// up whatever this script adds.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTraktExport } from './lib/traktExport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'trakt', 'data');

const exportDir = process.argv[2];
if (!exportDir || !fs.existsSync(exportDir)) {
  console.error('Usage: node trakt/scripts/build_trakt_library.js <path-to-extracted-export-dir>');
  process.exit(1);
}

const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJSON = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

function titleKey(type, ids) {
  if (ids?.tmdb) return `${type}:${ids.tmdb}`;
  if (ids?.trakt) return `${type}:trakt:${ids.trakt}`;
  return null; // caller must handle — logged as unresolvable
}

const {
  watchedMovies, ratingsMovies, watchlist, favorites, watchedShows, ratingsShows,
} = loadTraktExport(exportDir);

// ── Favorites lookup (by titleKey) ──────────────────────────────────────

const favoriteKeys = new Set(
  favorites.map(f => {
    const entity = f.movie || f.show;
    return entity ? titleKey(f.type, entity.ids) : null;
  }).filter(Boolean)
);

// ── Ratings lookups (by titleKey) ───────────────────────────────────────

const movieRatingByKey = new Map(
  ratingsMovies.map(r => [titleKey('movie', r.movie.ids), { rating: r.rating, ratedAt: r.rated_at }])
);
const showRatingByKey = new Map(
  ratingsShows.map(r => [titleKey('show', r.show.ids), { rating: r.rating, ratedAt: r.rated_at }])
);

// ── Build watched-movie records ─────────────────────────────────────────

const movieRecords = watchedMovies.map(w => {
  const key = titleKey('movie', w.movie.ids);
  const ratingInfo = key ? movieRatingByKey.get(key) : null;
  return {
    type: 'movie',
    titleKey: key,
    ids: w.movie.ids,
    title: w.movie.title,
    year: w.movie.year,
    myRating: ratingInfo?.rating ?? null,
    ratedAt: ratingInfo?.ratedAt ?? null,
    plays: w.plays,
    lastWatchedAt: w.last_watched_at,
    favorite: key ? favoriteKeys.has(key) : false,
  };
});

// ── Build watched-show records (with derived completion status) ────────

function completionStatus(plays, airedEpisodes) {
  if (!airedEpisodes) return 'unknown';
  if (plays >= airedEpisodes) return 'caught-up';
  return 'in-progress';
}

const showRecords = watchedShows.map(w => {
  const key = titleKey('show', w.show.ids);
  const ratingInfo = key ? showRatingByKey.get(key) : null;
  return {
    type: 'show',
    titleKey: key,
    ids: w.show.ids,
    title: w.show.title,
    year: w.show.year,
    myRating: ratingInfo?.rating ?? null,
    ratedAt: ratingInfo?.ratedAt ?? null,
    plays: w.plays,
    airedEpisodes: w.show.aired_episodes,
    // Informational only in Phase 1 — not yet consumed by trakt/engine.js.
    // "in-progress" here just means plays < airedEpisodes; it does NOT
    // distinguish "actively watching" from "abandoned partway," since
    // Trakt's export carries no explicit "dropped" signal. See CLAUDE.md's
    // BMTRE section for why this stays a heuristic pending real feedback data.
    completionStatus: completionStatus(w.plays, w.show.aired_episodes),
    lastWatchedAt: w.last_watched_at,
    favorite: key ? favoriteKeys.has(key) : false,
  };
});

const unresolvable = [...movieRecords, ...showRecords].filter(r => !r.titleKey);
if (unresolvable.length) {
  console.warn(`\nWARNING: ${unresolvable.length} title(s) have neither a tmdb nor trakt id and were skipped:`);
  unresolvable.forEach(r => console.warn(`  - ${r.title} (${r.year})`));
}

const newLibraryTitles = [...movieRecords, ...showRecords].filter(r => r.titleKey);

// ── Upsert into library.json (never silently drop a vanished title) ────

const libraryPath = path.join(DATA_DIR, 'library.json');
const existingLibrary = readJSON(libraryPath, { titles: [] });
const existingByKey = new Map(existingLibrary.titles.map(t => [t.titleKey, t]));
const newByKey = new Map(newLibraryTitles.map(t => [t.titleKey, t]));

const mergedTitles = [];
for (const [key, incoming] of newByKey) {
  mergedTitles.push({ ...existingByKey.get(key), ...incoming });
}
const missingFromExport = [];
for (const [key, existing] of existingByKey) {
  if (!newByKey.has(key)) {
    mergedTitles.push(existing); // keep it — don't silently delete
    missingFromExport.push(existing);
  }
}
if (missingFromExport.length) {
  console.warn(`\nNOTE: ${missingFromExport.length} previously-ingested title(s) are not in this export ` +
    `(kept as-is, not deleted — flag for manual review if this looks wrong):`);
  missingFromExport.forEach(t => console.warn(`  - ${t.title} (${t.year})`));
}

mergedTitles.sort((a, b) => a.title.localeCompare(b.title));
writeJSON(libraryPath, {
  meta: {
    generatedAt: new Date().toISOString(),
    movieCount: mergedTitles.filter(t => t.type === 'movie').length,
    showCount: mergedTitles.filter(t => t.type === 'show').length,
  },
  titles: mergedTitles,
});

// ── Watchlist (movies + shows, unwatched) ───────────────────────────────

const watchlistRecords = watchlist.map(w => {
  const entity = w.movie || w.show;
  if (!entity) return null;
  const key = titleKey(w.type, entity.ids);
  if (!key) return null;
  return {
    type: w.type,
    titleKey: key,
    ids: entity.ids,
    title: entity.title,
    year: entity.year,
    watchlisted: true,
    watchlistedAt: w.listed_at,
  };
}).filter(Boolean);

writeJSON(path.join(DATA_DIR, 'watchlist.json'), {
  meta: { generatedAt: new Date().toISOString(), count: watchlistRecords.length },
  titles: watchlistRecords,
});

// ── Currently watching (in-progress shows, derived view of library.json) ─

const currentlyWatching = mergedTitles.filter(t => t.type === 'show' && t.completionStatus === 'in-progress');
writeJSON(path.join(DATA_DIR, 'currentlyWatching.json'), currentlyWatching);

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\nWrote trakt/data/library.json: ${mergedTitles.length} titles ` +
  `(${mergedTitles.filter(t => t.type === 'movie').length} movies, ${mergedTitles.filter(t => t.type === 'show').length} shows)`);
console.log(`Wrote trakt/data/watchlist.json: ${watchlistRecords.length} titles`);
console.log(`Wrote trakt/data/currentlyWatching.json: ${currentlyWatching.length} in-progress shows`);
