// Shared full-row loader for the Trakt/BMTRE side, mirroring the role
// scripts/lib/loadData.js plays for the book project (one join so multiple
// consumers can't silently drift into mismatched logic — the exact bug
// class Session 13b hit on the book side's Amazon-rating join). Every
// watched title, every watchlisted title, and every discovered candidate,
// merged with everything known about it: TMDB metadata, OMDb metadata,
// feedback/exclusion state, and the engine's own live-computed scores.
//
// Array fields (genres, keywords, similarToIds, recommendedIds, topCast)
// are left as raw arrays — callers format as needed (export_extract.js
// joins them with "; ", matching the book side's export convention).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildIndexes, hydrateTitle, getCreator, matchScore, confidenceScore,
  reason, popularityScore, audienceScore, awardsScore, mergeScrapedShowRatings,
} from '../../engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

const read = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
};

export function loadAllTitles() {
  const library = read('library.json', { titles: [] });
  const watchlist = read('watchlist.json', { titles: [] });
  const candidatePool = read('candidatePool.json', { titles: [] });
  const enrichedMeta = read('enrichedMetadata.json', {});
  const omdbMetaRaw = read('omdbMetadata.json', {});
  const scrapedShowRatings = read('scrapedShowRatings.json', {});
  const omdbMeta = mergeScrapedShowRatings(omdbMetaRaw, scrapedShowRatings);
  const feedback = read('feedbackData.json', { interactions: [] });

  const idx = buildIndexes(library, enrichedMeta, feedback);
  const feedbackByKey = new Map((feedback.interactions || []).map(i => [i.titleKey, i]));

  const rows = [];
  const addRow = (t, status) => {
    const h = hydrateTitle(t, enrichedMeta);
    const meta = enrichedMeta[h.titleKey] || {};
    const omdb = omdbMeta[h.titleKey];
    const fb = feedbackByKey.get(h.titleKey);
    const creator = getCreator(h.type, meta);

    rows.push({
      titleKey: h.titleKey,
      title: h.title || '',
      year: h.year ?? '',
      type: h.type || '',
      status,
      // Trakt-native fields (present on watched/watchlisted rows only)
      traktId: t.ids?.trakt ?? '',
      imdbId: t.ids?.imdb || meta.imdbId || '',
      tmdbId: t.ids?.tmdb ?? '',
      myRating: t.myRating ?? '',
      ratedAt: t.ratedAt || '',
      plays: t.plays ?? '',
      lastWatchedAt: t.lastWatchedAt || '',
      airedEpisodes: t.airedEpisodes ?? '',
      completionStatus: t.completionStatus || '',
      favorite: Boolean(t.favorite),
      watchlistedAt: t.watchlistedAt || '',
      citedBy: t.citedBy ?? '',
      // TMDB-enriched fields
      genres: meta.genres || [],
      overview: meta.overview || '',
      keywords: meta.keywords || [],
      originalLanguage: meta.originalLanguage || '',
      tmdbVoteAverage: meta.voteAverage ?? '',
      tmdbVoteCount: meta.voteCount ?? '',
      tmdbPopularity: meta.popularity ?? '',
      similarToIds: meta.similarToIds || [],
      recommendedIds: meta.recommendedIds || [],
      topCast: meta.topCast || [],
      releaseDate: meta.releaseDate || meta.firstAirDate || '',
      runtime: meta.runtime ?? meta.episodeRunTime ?? '',
      creator: creator || '',
      belongsToCollection: meta.belongsToCollection?.name || '',
      tmdbStatus: meta.status || '',
      numberOfSeasons: meta.numberOfSeasons ?? '',
      numberOfEpisodes: meta.numberOfEpisodes ?? '',
      tmdbFetchedAt: meta.fetchedAt || '',
      // OMDb-enriched fields
      rottenTomatoes: omdb?.rottenTomatoes ?? '',
      metacritic: omdb?.metacritic ?? '',
      omdbImdbRating: omdb?.imdbRating ?? '',
      omdbImdbVotes: omdb?.imdbVotes ?? '',
      oscarWins: omdb?.awards?.oscarWins ?? '',
      oscarNominations: omdb?.awards?.oscarNominations ?? '',
      emmyWins: omdb?.awards?.emmyWins ?? '',
      emmyNominations: omdb?.awards?.emmyNominations ?? '',
      totalAwardWins: omdb?.awards?.totalWins ?? '',
      totalAwardNominations: omdb?.awards?.totalNominations ?? '',
      awardsRaw: omdb?.awards?.raw || '',
      omdbFetchedAt: omdb?.fetchedAt || '',
      // Feedback/exclusion state
      excludedFromRecommendations: Boolean(fb?.excludeFromRecommendations),
      exclusionReasonCode: fb?.reasonCode || '',
      exclusionReasonLabel: fb?.reasonLabel || '',
      // Live-computed BMTRE engine outputs (same functions the dashboard uses)
      predictedScore: meta.genres ? Math.round(matchScore(h, idx, enrichedMeta, omdbMeta)) : '',
      confidenceScore: meta.genres ? confidenceScore(h, enrichedMeta) : '',
      popularityScore: popularityScore(meta.voteCount),
      audienceScoreComputed: audienceScore(omdb) ?? '',
      awardsScoreComputed: awardsScore(omdb) ?? '',
      reason: meta.genres ? reason(h, idx, enrichedMeta, omdbMeta) : 'Not enough data yet.',
    });
  };

  for (const t of library.titles || []) addRow(t, 'Watched');
  for (const t of watchlist.titles || []) addRow(t, 'Watchlist');
  for (const t of candidatePool.titles || []) addRow(t, 'Candidate');

  return { rows, library, watchlist, candidatePool, enrichedMeta, omdbMeta };
}
