// Shared reader for a full Trakt account-data-export directory (the zip
// Bill downloads from Trakt himself and uploads here — this project never
// calls the Trakt API, per CLAUDE.md's standing rule).
//
// Extracted so every script that needs the raw export (the dashboard
// builder, the library ingester, and any future consumer) reads it the
// same way instead of each re-implementing its own globbing/parsing and
// silently drifting apart — the same lesson scripts/lib/loadData.js's own
// header comment documents for the book project's join logic.

import fs from 'fs';
import path from 'path';

export function loadTraktExport(exportDir) {
  const readJSON = (name, fallback = []) => {
    const p = path.join(exportDir, name);
    if (!fs.existsSync(p)) return fallback;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
  };

  const globHistory = () =>
    fs.readdirSync(exportDir)
      .filter(f => /^watched-history-\d+\.json$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  // Generic glob for a `<prefix>.json` OR `<prefix>-N.json` (Trakt paginates
  // at 250 items/file once a list grows past one page — first hit for real
  // in the movies files, 2026-09-11 export: watched-movies-1.json +
  // watched-movies-2.json, no bare watched-movies.json at all). Sorted
  // numerically (not lexically — "-10" must sort after "-9", not before
  // "-2") so a future export with 10+ pages concatenates in the right order,
  // though order doesn't actually matter for any of these lists today.
  const globPaginated = prefix =>
    fs.readdirSync(exportDir)
      .filter(f => new RegExp(`^${prefix}(-\\d+)?\\.json$`).test(f))
      .sort((a, b) => (parseInt(a.match(/-(\d+)\.json$/)?.[1]) || 0) - (parseInt(b.match(/-(\d+)\.json$/)?.[1]) || 0));

  const stats = readJSON('user-stats.json', {});
  const profile = readJSON('user-profile.json', {});
  const watchedMovies = globPaginated('watched-movies').flatMap(f => readJSON(f, []));
  const ratingsMovies = globPaginated('ratings-movies').flatMap(f => readJSON(f, []));
  const watchlist = readJSON('lists-watchlist.json', []);
  const favorites = readJSON('lists-favorites.json', []);

  const watchedShows = globPaginated('watched-shows').flatMap(f => readJSON(f, []));
  const ratingsShows = globPaginated('ratings-shows').flatMap(f => readJSON(f, []));

  const historyFiles = globHistory();
  let history = [];
  for (const f of historyFiles) history = history.concat(readJSON(f, []));

  return {
    stats, profile, watchedMovies, ratingsMovies, watchlist, favorites,
    watchedShows, ratingsShows, history, historyFiles,
  };
}
