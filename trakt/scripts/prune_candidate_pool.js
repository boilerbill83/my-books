#!/usr/bin/env node
// Caps trakt/data/candidatePool.json at a fixed size per type (default 100
// movies + 100 shows), keeping the highest-scoring candidates and evicting
// the lowest. Scores use the exact same matchScore()/buildIndexes() engine
// trakt/engine.js's rankAll() uses to render "New pick" cards, so a
// candidate's eviction risk always matches what it would actually show on
// the dashboard - no separate ranking logic to drift out of sync.
//
// Run AFTER discover_candidates.js + a TMDB enrichment pass, never before:
// a freshly-discovered stub has no genres/director/similar data yet and
// would score near-zero (just the base + recency terms), so pruning too
// early would evict brand-new candidates before they ever got a fair
// score - the opposite of "kick out the ones that score low" once new
// ones that score *high* have actually been given the chance to prove it.
//
// Also drops stale entries the pool shouldn't be carrying regardless of
// the cap - anything Bill has since watched or added to his real
// watchlist directly (same hygiene rankAll() already applies defensively
// at render time; here it's a real deletion, not just a runtime filter).
//
// A dismissed/excluded candidate is deliberately NOT treated the same way
// (a real bug found and fixed: this used to fold idx.excluded into the
// same delete-outright "stale" bucket as already-watched/watchlisted,
// which meant every dismissal got permanently erased from
// candidatePool.json on the very next prune run - discoverable only via
// feedbackData.json's own record after the fact, and completely invisible
// to trakt/scripts/export_extract.js's full data extract, which only ever
// reads library/watchlist/candidatePool.json and has no other way to know
// a dismissed title ever existed). A dismissal is Bill's own real
// feedback data, not staleness - it should never be lost. Excluded
// candidates are now kept unconditionally (never deleted, same as an
// unenriched stub), but never compete for a cap slot or get scored,
// since idx.excluded already keeps them out of every real recommendation
// surface at render time regardless of whether they sit in this file.
//
// Run manually: node trakt/scripts/prune_candidate_pool.js [capPerType]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildIndexes, matchScorePair, hydrateTitle, isPreMillenniumMovie, isAnimation, isTooObscure, mergeScrapedShowRatings } from '../engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'trakt', 'data');
const CAP_PER_TYPE = parseInt(process.argv[2], 10) || 100;

const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJSON = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

const library = readJSON(path.join(DATA_DIR, 'library.json'), { titles: [] });
const watchlist = readJSON(path.join(DATA_DIR, 'watchlist.json'), { titles: [] });
const candidatePool = readJSON(path.join(DATA_DIR, 'candidatePool.json'), { titles: [] });
const enrichedMeta = readJSON(path.join(DATA_DIR, 'enrichedMetadata.json'), {});
const omdbMetaRaw = readJSON(path.join(DATA_DIR, 'omdbMetadata.json'), {});
const scrapedShowRatings = readJSON(path.join(DATA_DIR, 'scrapedShowRatings.json'), {});
const omdbMeta = mergeScrapedShowRatings(omdbMetaRaw, scrapedShowRatings);
const feedback = readJSON(path.join(DATA_DIR, 'feedbackData.json'), { interactions: [] });
const llmTags = readJSON(path.join(DATA_DIR, 'llmTags.json'), {});
const reviewedTags = readJSON(path.join(DATA_DIR, 'reviewedTags.json'), {});

const idx = buildIndexes(library, enrichedMeta, feedback, llmTags, reviewedTags);
const watchlistKeys = new Set((watchlist.titles || []).map(c => c.titleKey));

// Same re-edit / non-English / pre-2000-movie / animation / too-obscure
// exclusions rankAll() applies to candidates (never to the watchlist -
// that's Bill's own real data) - a candidate that would never surface
// anyway shouldn't occupy a cap slot.
const isReEdit = c => (enrichedMeta[c.titleKey]?.keywords || []).includes('edited from film');
const isNonEnglish = c => {
  const lang = enrichedMeta[c.titleKey]?.originalLanguage;
  return lang != null && lang !== 'en';
};

const stale = [];
const excluded = [];
const live = [];
for (const c of candidatePool.titles || []) {
  if (idx.excluded.has(c.titleKey)) {
    excluded.push(c);
    continue;
  }
  if (watchlistKeys.has(c.titleKey) || idx.watched.has(c.titleKey)
      || isReEdit(c) || isNonEnglish(c) || isPreMillenniumMovie(c, enrichedMeta) || isAnimation(c, enrichedMeta)
      || isTooObscure(c, enrichedMeta)) {
    stale.push(c);
    continue;
  }
  live.push(c);
}

const scored = live.map(c => {
  const h = hydrateTitle(c, enrichedMeta);
  const enriched = !!enrichedMeta[c.titleKey];
  // One matchScorePair() call gets both values from a single baseSignals()
  // pass, instead of matchScore()+matchScoreRaw() independently recomputing
  // it twice. Eviction ranks by scoreRaw (score-clamp-saturation fix) — a
  // large share of strong candidates display as an identical 100, and
  // ranking eviction by that clamped number left ties decided by array
  // order rather than which title is actually the better match. `score`
  // still drives the printed log/display value.
  const pair = enriched ? matchScorePair(h, idx, enrichedMeta, omdbMeta) : null;
  return {
    raw: c, hydrated: h, enriched,
    score: pair ? pair.clamped : null,
    scoreRaw: pair ? pair.raw : null,
  };
});

const notYetEnriched = scored.filter(s => !s.enriched);
if (notYetEnriched.length) {
  console.log(`WARNING: ${notYetEnriched.length} candidates have no enrichedMetadata.json entry yet ` +
    `(not yet TMDB-enriched) - these are being kept regardless of the cap rather than evicted unscored. ` +
    `Run a TMDB enrichment pass first, then re-run this script, to have them compete fairly.`);
}

const byType = { movie: [], show: [] };
for (const s of scored) {
  if (s.enriched) (byType[s.raw.type] ||= []).push(s);
}

const kept = new Set();
const evicted = [];
for (const type of Object.keys(byType)) {
  const ranked = byType[type].sort((a, b) => (b.scoreRaw ?? -1) - (a.scoreRaw ?? -1));
  ranked.slice(0, CAP_PER_TYPE).forEach(s => kept.add(s.raw.titleKey));
  ranked.slice(CAP_PER_TYPE).forEach(s => evicted.push(s));
}
// Not-yet-enriched candidates are never evicted by this pass (see warning above).
for (const s of notYetEnriched) kept.add(s.raw.titleKey);

const finalTitles = (candidatePool.titles || []).filter(c =>
  kept.has(c.titleKey) || notYetEnriched.some(s => s.raw.titleKey === c.titleKey) || excluded.some(s => s.titleKey === c.titleKey)
);

console.log(`Stale (already watched/watchlisted/re-edit/non-English/pre-2000/animation) removed: ${stale.length}`);
for (const s of stale) console.log(`  removed (stale): ${enrichedMeta[s.titleKey]?.title || s.title || s.titleKey}`);

console.log(`\nExcluded via feedback, kept regardless of cap (never scored, never shown): ${excluded.length}`);
for (const s of excluded) console.log(`  kept (excluded): ${enrichedMeta[s.titleKey]?.title || s.title || s.titleKey}`);

console.log(`\nEvicted (below top ${CAP_PER_TYPE} for its type): ${evicted.length}`);
for (const s of evicted.sort((a, b) => a.raw.type.localeCompare(b.raw.type) || (a.scoreRaw - b.scoreRaw))) {
  console.log(`  evicted: ${(s.score ?? 0).toFixed(1)} | ${s.raw.type} | ${s.hydrated.title} (${s.hydrated.year})`);
}

const finalMovies = finalTitles.filter(c => c.type === 'movie').length;
const finalShows = finalTitles.filter(c => c.type === 'show').length;
console.log(`\nFinal pool: ${finalMovies} movies, ${finalShows} shows — of which live/scored candidates are capped at ` +
  `${CAP_PER_TYPE} per type; ${notYetEnriched.length} unscored/pending and ${excluded.length} excluded/dismissed ` +
  `are kept on top of that, uncapped, since neither competes for a cap slot.`);

writeJSON(path.join(DATA_DIR, 'candidatePool.json'), {
  meta: { generatedAt: new Date().toISOString(), count: finalTitles.length, capPerType: CAP_PER_TYPE },
  titles: finalTitles,
});
