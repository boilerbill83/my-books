#!/usr/bin/env node
// Honest BMTRE yardstick, mirroring the book side's scripts/eval.js in
// spirit and metrics (leave-one-out, precision@k, MAE) — the #1
// Improvement Opportunities finding this dashboard has flagged since
// Session 51: every BMTRE scoring constant (matchPointScale,
// AUDIENCE_NEUTRAL, AWARDS_MAX, genre tiers, the movie recency curve...)
// was calibrated against a real input *distribution*, never validated
// against actual held-out prediction accuracy — a structurally weaker
// guarantee than the book side's own discipline requires before trusting
// a new signal.
//
// The actual metric (computeEvalMetrics) lives in ../engine.js, not here
// — engine.js has no Node-specific imports (fs/path/url), so
// dashboard.js can import it directly into the browser for the new
// "BMTRE Accuracy Score" dial, the same single-source-of-truth
// discipline the book side's own scripts/eval.js already uses (Session
// 33: data_quality_report.js imports computeEvalMetrics rather than
// re-deriving it). This file is the CLI wrapper only — reads the real
// committed data files and prints a report.
//
// Run from repo root: node trakt/scripts/eval.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeEvalMetrics, mergeScrapedShowRatings } from '../engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const read = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; }
};
const library = read('library.json', { titles: [] });
const enrichedMeta = read('enrichedMetadata.json', {});
const feedback = read('feedbackData.json', { interactions: [] });
const omdbMetaRaw = read('omdbMetadata.json', {});
const scrapedShowRatings = read('scrapedShowRatings.json', {});
const omdbMeta = mergeScrapedShowRatings(omdbMetaRaw, scrapedShowRatings);
const llmTags = read('llmTags.json', {});
const reviewedTags = read('reviewedTags.json', {});

const m = await computeEvalMetrics(library, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags);

console.log(`BMTRE eval over ${m.n} watched+rated+enriched titles (leave-one-out)`);
console.log(`"liked" = myRating >= ${m.likedThreshold}/10; base rate: ${(100 * m.baseRate).toFixed(1)}%   MAE (0-100 scale): ${m.mae.toFixed(2)}`);
for (const k of [10, 25, 50, 100]) {
  if (m.precisionAtK[k] != null) console.log(`precision@${k}: ${m.precisionAtK[k].toFixed(1)}%`);
}
console.log(`bottom-50 catches <=5/10: ${m.bottomCatch}/${m.bottomPossible} of the achievable ceiling ` +
  `(${m.bottomCatch}/50 of the raw slice; chance would catch ${m.bottomChance.toFixed(1)})`);
console.log(`naive always-predict-mean baseline MAE: ${m.meanBaselineMae.toFixed(2)} — ` +
  (m.mae > m.meanBaselineMae
    ? 'the model is currently WORSE than this trivial baseline on raw magnitude error (real, not a bug — Bill\'s ratings skew high, so guessing the mean scores well on MAE alone; this is exactly why precision@k, not MAE, is the metric that matters, same principle CLAUDE.md already states for the book side).'
    : 'the model beats this trivial baseline.'));

console.log('\nBy type:');
for (const [type, s] of Object.entries(m.byType)) {
  console.log(`  ${type}: n=${s.n} MAE=${s.mae.toFixed(2)} precision@10=${s.precisionAt10.toFixed(1)}%`);
}

console.log('\nWorst misses (predicted high, rated <=4/10):');
m.worstMisses.forEach(x => console.log(`  pred ${x.predicted.toFixed(1)} actual ${x.myRating}/10 [${x.type}] — ${x.title.slice(0, 55)}`));
console.log('\nWorst underrated (loved by Bill, predicted low):');
m.worstUnderrated.forEach(x => console.log(`  pred ${x.predicted.toFixed(1)} actual ${x.myRating}/10 [${x.type}] — ${x.title.slice(0, 55)}`));
