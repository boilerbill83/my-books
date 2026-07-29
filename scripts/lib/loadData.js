// Shared data loading + join logic for scripts/export_extract.js and
// scripts/data_quality_report.js. Kept in one place so the two scripts
// can't drift into using different (and silently mismatched) join keys —
// exactly the bug class that caused the Amazon-rating join to only match
// ~22% of books instead of ~90% (Session 13b).

import fs from 'fs';
import path from 'path';

export const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
export const norm = s => (s || '').toString().trim().toLowerCase();
export const deriveKey = (title, author) => `${norm(title)}|||${norm(author)}`;

// Mirrors scrape_ratings.py's book_key(): bare title (no subtitle/series
// notation) + first-listed author only. scrapedRatings.json is keyed this
// way, not by the full title, so lookups must match it exactly.
export const scrapedKey = (title, author) => {
  let t = (title || '').toString().replace(/\s*[:({\[].*/, '').trim().toLowerCase();
  t = t.replace(/\s*\(.*?\)\s*$/, '').trim();
  const a = (author || '').toString().split(',')[0].trim().toLowerCase();
  return `${t}|||${a}`;
};

// Returns every book (library + candidate pools + any currently-reading
// entries not already in the library) with its enrichment data merged in.
// Array fields (themes, tones, similarToTitles, similarToAuthors,
// categories, subjects) are left as raw arrays — callers format as needed.
export function loadAllBooks() {
  const goodreads = read('data/goodreadsData.json');
  const feedback = read('data/feedbackData.json');
  let enrichedMeta = {};
  try { enrichedMeta = read('data/enrichedMetadata.json'); } catch {}
  let scrapedRatings = {};
  try { scrapedRatings = read('data/scrapedRatings.json'); } catch {}
  let currentlyReading = [];
  try { currentlyReading = read('data/currentlyReading.json'); } catch {}

  const candidateFiles = read('data/candidateIndex.json');
  const candidates = candidateFiles.flatMap(f => read(path.join('data', f)).candidates);

  const feedbackByKey = new Map(
    feedback.interactions.map(i => [i.bookKey || deriveKey(i.title, i.author), i])
  );

  const libraryKeys = new Set(
    goodreads.books.map(b => deriveKey(b.title, b.author))
  );

  const rawRows = [];
  for (const b of goodreads.books) rawRows.push({ ...b, source: 'library' });
  for (const c of candidates) rawRows.push({ ...c, shelf: 'candidate-pool', source: 'candidate_pool' });
  for (const cr of currentlyReading) {
    if (libraryKeys.has(deriveKey(cr.title, cr.author))) continue;
    rawRows.push({ ...cr, source: 'currently_reading_feed' });
  }

  const rows = rawRows.map(b => {
    const key = b.bookKey || deriveKey(b.title, b.author);
    const meta = enrichedMeta[key] || {};
    const ratings = scrapedRatings[scrapedKey(b.title, b.author)] || {};
    const fb = feedbackByKey.get(key);
    const goodreadsUrl = b.goodreadsUrl
      || (b.bookId ? `https://www.goodreads.com/book/show/${b.bookId}` : '')
      || (b.title ? `https://www.goodreads.com/search?q=${encodeURIComponent(`${b.title} ${b.author || ''}`.trim())}` : '');

    return {
      bookKey: key,
      title: b.title || '',
      author: b.author || '',
      source: b.source,
      shelf: b.shelf || '',
      type: b.type || '',
      year: b.year ?? '',
      pages: b.pages ?? '',
      myRating: b.myRating ?? '',
      avgRating: b.avgRating ?? '',
      ratingsCount: b.ratingsCount ?? '',
      amazonRating: ratings.amazon?.rating ?? '',
      amazonRatingsCount: ratings.amazon?.count ?? '',
      isbn: b.isbn || '',
      isbn13: b.isbn13 || '',
      publisher: b.publisher || '',
      dateRead: b.dateRead || '',
      dateAdded: b.dateAdded || '',
      themes: b.themes || [],
      tones: b.tones || [],
      similarToTitles: b.similarToTitles || [],
      similarToAuthors: b.similarToAuthors || [],
      categories: meta.categories || [],
      subjects: meta.subjects || [],
      description: meta.description || '',
      metadataFetchedAt: meta.fetchedAt || '',
      dismissed: fb ? Boolean(fb.excludeFromRecommendations) : false,
      dismissReason: fb?.reasonLabel || '',
      coverUrl: b.coverUrl || '',
      goodreadsUrl,
      top10: Boolean(b.top10),
    };
  });

  return { rows, goodreads, candidates };
}
