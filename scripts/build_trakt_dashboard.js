#!/usr/bin/env node
// Builds trakt/data/dashboard.json from a full Trakt data export (the zip
// Bill downloads from Trakt's own account-data-export feature — this
// project never calls the Trakt API, per CLAUDE.md's standing rule).
//
// Usage: unzip the export somewhere, then run:
//   node scripts/build_trakt_dashboard.js <path-to-extracted-export-dir>
//
// Reads the export's per-type JSON files (watched-movies.json,
// watched-shows-*.json, watched-history-*.json, ratings-*.json,
// lists-watchlist.json, lists-favorites.json, user-stats.json,
// user-profile.json) and reduces ~5.6MB / 89 files down to one compact,
// dashboard-ready JSON. Re-run this any time Bill uploads a fresh export
// to refresh the dashboard — see CLAUDE.md's "Trakt Dashboard" section.

import fs from 'fs';
import path from 'path';
import { loadTraktExport } from '../trakt/scripts/lib/traktExport.js';

const exportDir = process.argv[2];
if (!exportDir || !fs.existsSync(exportDir)) {
  console.error('Usage: node scripts/build_trakt_dashboard.js <path-to-extracted-export-dir>');
  process.exit(1);
}

// ── Load raw export files ───────────────────────────────────────────────

const {
  stats, profile, watchedMovies, ratingsMovies, watchlist, favorites,
  watchedShows, ratingsShows, history, historyFiles,
} = loadTraktExport(exportDir);

console.log(`Loaded: ${watchedMovies.length} watched movies, ${watchedShows.length} watched shows, ` +
  `${history.length} history events (${historyFiles.length} files), ${ratingsMovies.length} movie ratings, ` +
  `${ratingsShows.length} show ratings, ${watchlist.length} watchlist items, ${favorites.length} favorites.`);

// ── Summary stats (trust Trakt's own precomputed totals, don't re-derive) ──

const summary = {
  moviesWatched: stats.movies?.watched ?? watchedMovies.length,
  moviesPlays: stats.movies?.plays ?? null,
  moviesRatings: stats.movies?.ratings ?? ratingsMovies.length,
  moviesMinutes: stats.movies?.minutes ?? null,
  showsWatched: stats.shows?.watched ?? watchedShows.length,
  showsRatings: stats.shows?.ratings ?? ratingsShows.length,
  episodesWatched: stats.episodes?.watched ?? null,
  episodesPlays: stats.episodes?.plays ?? null,
  episodesMinutes: stats.episodes?.minutes ?? null,
  totalRatings: stats.ratings?.total ?? (ratingsMovies.length + ratingsShows.length),
};
summary.totalMinutes = (summary.moviesMinutes || 0) + (summary.episodesMinutes || 0);
summary.totalHours = Math.round(summary.totalMinutes / 60);

const ratingDistribution = stats.ratings?.distribution ||
  Object.fromEntries([1,2,3,4,5,6,7,8,9,10].map(n => [n, 0]));
{
  const total = Object.values(ratingDistribution).reduce((a, b) => a + b, 0);
  const weighted = Object.entries(ratingDistribution).reduce((a, [k, v]) => a + Number(k) * v, 0);
  summary.avgRating = total ? Math.round((weighted / total) * 100) / 100 : null;
}

// ── Activity over time — split into dated vs undated (bulk-import placeholder) ──
// A large share of episode history carries a 1970-01-01 epoch placeholder
// (bulk Plex-sync import with no real per-episode watch date) rather than
// a genuine date. Counting those as "watched in 1970" would badly distort
// any time-series chart, so they're tallied separately and surfaced as a
// caveat rather than silently included or silently dropped.

const yearCounts = {}; // { year: { movies, episodes } }
let undatedEpisodes = 0;
let datedEpisodes = 0;

for (const e of history) {
  const isEpoch = e.watched_at && e.watched_at.slice(0, 10) === '1970-01-01';
  if (e.type === 'episode' && isEpoch) { undatedEpisodes++; continue; }
  if (e.type === 'episode') datedEpisodes++;
  const year = e.watched_at ? e.watched_at.slice(0, 4) : null;
  if (!year) continue;
  yearCounts[year] ??= { movies: 0, episodes: 0 };
  if (e.type === 'movie') yearCounts[year].movies++;
  else if (e.type === 'episode') yearCounts[year].episodes++;
}

const activityByYear = Object.entries(yearCounts)
  .map(([year, v]) => ({ year: Number(year), movies: v.movies, episodes: v.episodes }))
  .sort((a, b) => a.year - b.year);

const dataCaveats = {
  undatedEpisodePlays: undatedEpisodes,
  datedEpisodePlays: datedEpisodes,
  undatedEpisodeSharePct: (datedEpisodes + undatedEpisodes)
    ? Math.round((undatedEpisodes / (datedEpisodes + undatedEpisodes)) * 1000) / 10
    : 0,
};

// ── Top shows by plays ───────────────────────────────────────────────────

const topShowsByPlays = watchedShows
  .map(s => ({ title: s.show.title, year: s.show.year, plays: s.plays, airedEpisodes: s.show.aired_episodes }))
  .sort((a, b) => b.plays - a.plays)
  .slice(0, 15);

// ── Top rated movies / shows ─────────────────────────────────────────────

const topRatedMovies = ratingsMovies
  .map(r => ({ title: r.movie.title, year: r.movie.year, rating: r.rating, ratedAt: r.rated_at }))
  .sort((a, b) => b.rating - a.rating || (b.ratedAt || '').localeCompare(a.ratedAt || ''))
  .slice(0, 20);

const topRatedShows = ratingsShows
  .map(r => ({ title: r.show.title, year: r.show.year, rating: r.rating, ratedAt: r.rated_at }))
  .sort((a, b) => b.rating - a.rating || (b.ratedAt || '').localeCompare(a.ratedAt || ''))
  .slice(0, 20);

// ── Watchlist / favorites ────────────────────────────────────────────────

const summarizeListItem = item => {
  const entity = item.movie || item.show;
  return { type: item.type, title: entity?.title, year: entity?.year, listedAt: item.listed_at };
};

const watchlistOut = watchlist.map(summarizeListItem)
  .sort((a, b) => (a.listedAt || '').localeCompare(b.listedAt || ''));
const favoritesOut = favorites.map(summarizeListItem)
  .sort((a, b) => (a.listedAt || '').localeCompare(b.listedAt || ''));

// ── Write output ─────────────────────────────────────────────────────────

const out = {
  generatedAt: new Date().toISOString(),
  profile: { username: profile.username, joinedAt: profile.joined_at },
  summary,
  ratingDistribution,
  activityByYear,
  dataCaveats,
  topShowsByPlays,
  topRatedMovies,
  topRatedShows,
  watchlist: { count: watchlistOut.length, items: watchlistOut },
  favorites: { count: favoritesOut.length, items: favoritesOut },
};

const outPath = path.resolve('trakt/data/dashboard.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`\nWrote ${outPath}`);
console.log(`Summary: ${summary.moviesWatched} movies, ${summary.showsWatched} shows, ` +
  `${summary.episodesWatched} episodes, ${summary.totalHours} hours, ${summary.totalRatings} ratings ` +
  `(avg ${summary.avgRating}).`);
console.log(`${dataCaveats.undatedEpisodeSharePct}% of episode plays (${dataCaveats.undatedEpisodePlays}) ` +
  `have no recorded watch date (bulk import) and are excluded from the year-over-year chart.`);
