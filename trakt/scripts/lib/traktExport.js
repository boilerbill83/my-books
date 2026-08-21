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

  const globShows = () =>
    fs.readdirSync(exportDir)
      .filter(f => /^watched-shows(-\d+)?\.json$/.test(f))
      .sort();

  const globShowRatings = () =>
    fs.readdirSync(exportDir)
      .filter(f => /^ratings-shows(-\d+)?\.json$/.test(f))
      .sort();

  const stats = readJSON('user-stats.json', {});
  const profile = readJSON('user-profile.json', {});
  const watchedMovies = readJSON('watched-movies.json', []);
  const ratingsMovies = readJSON('ratings-movies.json', []);
  const watchlist = readJSON('lists-watchlist.json', []);
  const favorites = readJSON('lists-favorites.json', []);

  const watchedShows = globShows().flatMap(f => readJSON(f, []));
  const ratingsShows = globShowRatings().flatMap(f => readJSON(f, []));

  const historyFiles = globHistory();
  let history = [];
  for (const f of historyFiles) history = history.concat(readJSON(f, []));

  return {
    stats, profile, watchedMovies, ratingsMovies, watchlist, favorites,
    watchedShows, ratingsShows, history, historyFiles,
  };
}
