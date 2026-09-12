#!/usr/bin/env node
// Turns the "book-taste correlation" signal (bookTasteBonus(), engine.js)
// into a real, additional CANDIDATE DISCOVERY input, rather than only a
// scoring nudge. Bill asked, after seeing the raw BBRE theme counts next
// to BMTRE's real loved genre/subgenre/subject scores side by side: which
// book themes are proportionally BIGGER in his reading taste than his
// current screen taste/candidate pool reflects — and could that steer
// where discover_explore.py goes looking for new candidates, rather than
// discovery staying seeded only from his existing Trakt-loved genre mix?
//
// Deliberately NOT a matchScore()/baseSignals() change — this only ever
// decides WHICH new candidates get discovered, never how any candidate
// (old or new) is scored once it's in the pool. Every discovered stub
// still competes on its own real merits via the exact same scoring
// bookTasteBonus() and every other signal already apply to any candidate.
//
// Methodology: for each BBRE theme mapped in BOOK_THEME_TO_MOVIE_TAGS,
// compare its share of Bill's real 5-star-read theme tags against the
// share its mapped BMTRE genre/subgenre/subject tag(s) hold of his real
// loved-title rating-weighted score. A ratio > 1 means the theme is
// proportionally bigger in his book taste than what his current loved
// screen titles (and therefore the citation-graph-seeded candidate pool,
// which is built FROM those loved titles' own TMDB similar/recommended
// lists) already reflect — real, verified evidence a theme is
// underexplored on the screen side, not a hand-picked guess. An evidence
// floor (bookCount >= 15) excludes thin-sample themes (finance n=11,
// psychology n=8) from steering discovery on weak signal; a gap floor
// (ratio > 1.15) excludes themes screen taste already keeps pace with or
// exceeds (e.g. history/political/crime, all measurably UNDER-weighted in
// books relative to screen — the opposite direction, not a gap at all).
//
// Legal + courtroom both map to the identical subgenre:legal tag, so
// they're merged into one "legal" gap entry (summed book count) rather
// than double-counting the same movie-side score against each separately.
//
// Output classification: a gap theme whose mapped tag set includes a
// genre:X value with a real, literal TMDB genre equivalent (verified
// against TMDB's own published genre vocabulary, e.g. genre:thriller ->
// the real "Thriller" movie genre) gets mode:'genre' — discover_explore.py
// can reuse its EXISTING, already-live-verified genre-query machinery
// unchanged, just seeded with one more genre name. Everything else
// (business, biography, sports, tech history, psychological — none of
// which TMDB has a native genre for at all, confirmed against TMDB's
// real genre list, the exact reason BMTRE's own inferGenre() needed a
// keyword-override tier for biography/sports in the first place) gets
// mode:'keyword' with a hand-picked, real-world search PHRASE (never a
// guessed keyword id — discover_explore.py resolves the real id live via
// TMDB's own /search/keyword at request time, same "verify against a real
// source, never hand-type an id" discipline this project already applies
// to its genre-id fetch).
//
// Run from repo root: node trakt/scripts/compute_book_theme_gaps.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeBookThemeCounts, buildIndexes, BOOK_THEME_TO_MOVIE_TAGS, mergeManualRatings } from '../engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ROOT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

const read = (dir, name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
};

const goodreadsData = read(ROOT_DATA_DIR, 'goodreadsData.json', { books: [] });
const bookCounts = computeBookThemeCounts(goodreadsData);

// Real ratings Bill gave directly to this app instead of through a Trakt
// export — see mergeManualRatings()'s own comment in engine.js.
const manualRatings = read(DATA_DIR, 'manualRatings.json', { titles: [] });
const library = mergeManualRatings(read(DATA_DIR, 'library.json', { titles: [] }), manualRatings);
const enrichedMeta = read(DATA_DIR, 'enrichedMetadata.json', {});
const feedback = read(DATA_DIR, 'feedbackData.json', { interactions: [] });
const llmTags = read(DATA_DIR, 'llmTags.json', {});
const reviewedTags = read(DATA_DIR, 'reviewedTags.json', {});

const idx = buildIndexes(library, enrichedMeta, feedback, llmTags, reviewedTags);

const totalBookThemeUses = Object.values(bookCounts).reduce((a, b) => a + b, 0);
const totalMap = {
  genre: [...idx.lovedGenres.values()].reduce((a, b) => a + b, 0),
  subgenre: [...idx.lovedSubgenres.values()].reduce((a, b) => a + b, 0),
  subject: [...idx.lovedSubjects.values()].reduce((a, b) => a + b, 0),
};
const idxMap = { genre: idx.lovedGenres, subgenre: idx.lovedSubgenres, subject: idx.lovedSubjects };

const MERGE = { courtroom: 'legal' };

const merged = {};
for (const [theme, count] of Object.entries(bookCounts)) {
  if (!BOOK_THEME_TO_MOVIE_TAGS[theme]) continue;
  const key = MERGE[theme] || theme;
  merged[key] ||= { themes: [], bookCount: 0, tags: new Set() };
  merged[key].themes.push(theme);
  merged[key].bookCount += count;
  for (const t of BOOK_THEME_TO_MOVIE_TAGS[theme]) merged[key].tags.add(t);
}

const MIN_BOOK_COUNT = 15;
const GAP_RATIO_FLOOR = 1.15;

const rows = [];
for (const [key, info] of Object.entries(merged)) {
  if (info.bookCount < MIN_BOOK_COUNT) continue;
  const bookShare = info.bookCount / totalBookThemeUses;
  const tags = [...info.tags];
  const layers = [...new Set(tags.map(t => t.split(':')[0]))];
  let movieScore = 0;
  for (const tag of tags) {
    const [layer, tagKey] = tag.split(':');
    movieScore += idxMap[layer].get(tagKey) || 0;
  }
  const avgTotal = layers.reduce((s, l) => s + totalMap[l], 0) / layers.length;
  const movieShare = movieScore / (avgTotal * tags.length / layers.length || 1);
  const ratio = movieShare > 0 ? bookShare / movieShare : 99;
  if (ratio <= GAP_RATIO_FLOOR) continue;
  rows.push({ key, bookThemes: info.themes, bookCount: info.bookCount, tags, ratio: Number(ratio.toFixed(2)), movieScore: Number(movieScore.toFixed(1)) });
}
rows.sort((a, b) => b.ratio - a.ratio);

const GENRE_TMDB_NAMES = {
  'genre:thriller':        { movie: 'Thriller', show: null },
  'genre:crime':           { movie: 'Crime', show: 'Crime' },
  'genre:mystery':         { movie: 'Mystery', show: 'Mystery' },
  'genre:horror':          { movie: 'Horror', show: null },
  'genre:romance':         { movie: 'Romance', show: null },
  'genre:science-fiction': { movie: 'Science Fiction', show: 'Sci-Fi & Fantasy' },
  'genre:war':             { movie: 'War', show: 'War & Politics' },
  'genre:adventure':       { movie: 'Adventure', show: null },
  'genre:comedy':          { movie: 'Comedy', show: 'Comedy' },
};

const KEYWORD_QUERIES = {
  legal: 'lawyer',
  business: 'business',
  biography: 'biography',
  sports: 'sports',
  'tech history': 'silicon valley',
  psychological: 'psychological thriller',
};

const gaps = rows.map(r => {
  const genreTag = r.tags.find(t => t.startsWith('genre:') && GENRE_TMDB_NAMES[t]);
  if (genreTag) {
    return {
      key: r.key, bookThemes: r.bookThemes, bookCount: r.bookCount, ratio: r.ratio, tags: r.tags,
      mode: 'genre', tmdbGenreNames: GENRE_TMDB_NAMES[genreTag],
    };
  }
  return {
    key: r.key, bookThemes: r.bookThemes, bookCount: r.bookCount, ratio: r.ratio, tags: r.tags,
    mode: 'keyword', searchQuery: KEYWORD_QUERIES[r.key] || r.key,
  };
});

const out = {
  generatedAt: new Date().toISOString(),
  methodology: "ratio = (theme's share of Bill's real 5-star-read theme tags) / (its mapped BMTRE genre/subgenre/subject " +
    "tag's share of his real loved-title rating-weighted score). ratio > 1 means the theme is proportionally bigger in his " +
    'book taste than his current screen taste (and therefore the citation-graph-seeded candidate pool) already reflects. ' +
    `Evidence floor: bookCount >= ${MIN_BOOK_COUNT}. Gap floor: ratio > ${GAP_RATIO_FLOOR}.`,
  gaps,
};
fs.writeFileSync(path.join(DATA_DIR, 'bookThemeGaps.json'), JSON.stringify(out, null, 2) + '\n');

console.log(`Wrote ${gaps.length} book-theme gap(s) to trakt/data/bookThemeGaps.json:`);
gaps.forEach(g => console.log(
  `  ${g.key} (n=${g.bookCount}, ratio=${g.ratio}x) -> mode=${g.mode} ` +
  (g.mode === 'genre' ? JSON.stringify(g.tmdbGenreNames) : `query="${g.searchQuery}"`)
));
