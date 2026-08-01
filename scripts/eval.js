#!/usr/bin/env node
// Honest BBRE yardstick. Run from repo root: node scripts/eval.js
//
// Leave-one-out over COMPLETED rated reads only (DNFs excluded — their
// virtual ratings leak the answer and inflate metrics). Reports the
// numbers that match the product goal: does the top of the ranking
// contain books Bill loved?
//
// computeEvalMetrics() is exported so scripts/data_quality_report.js can
// embed the same numbers (not a re-derived copy) into the dashboard's BBRE
// Accuracy dial — same discipline as scripts/lib/loadData.js's single
// join-logic source of truth (Session 13e).

import fs from 'fs';
import { buildTasteModel, predictRating } from '../rateEngine.js';

export function computeEvalMetrics(gd, meta) {
  const completed = gd.books.filter(b => b.shelf === 'read' && b.myRating >= 1 && !b.dnf);

  const preds = [];
  for (const b of completed) {
    const loo = { ...gd, books: gd.books.filter(x => x !== b) };
    const model = buildTasteModel(loo, [], meta);
    const p = predictRating(b, model);
    const pr = typeof p === 'object' ? (p.rating ?? p.predicted ?? p.score) : p;
    if (Number.isFinite(pr)) preds.push({ pr, actual: b.myRating, title: b.title });
  }
  preds.sort((a, b) => b.pr - a.pr);

  const n = preds.length;
  const liked = x => x.actual >= 4;
  const baseRate = preds.filter(liked).length / n;
  const mae = preds.reduce((s, x) => s + Math.abs(x.pr - x.actual), 0) / n;

  const precisionAtK = {};
  for (const k of [10, 25, 50, 100]) {
    const hit = preds.slice(0, k).filter(liked).length;
    precisionAtK[k] = 100 * hit / k;
  }

  const bottom = preds.slice(-50);
  const bottomCatch = bottom.filter(x => x.actual <= 3).length;
  const bottomChance = 50 * (1 - baseRate);

  const worstMisses = preds.filter(x => x.actual <= 2).slice(0, 5)
    .map(x => ({ predicted: x.pr, actual: x.actual, title: x.title }));

  return { n, baseRate, mae, precisionAtK, bottomCatch, bottomChance, worstMisses };
}

// CLI entry point — only runs when this file is executed directly, not when
// imported by data_quality_report.js.
if (import.meta.url === `file://${process.argv[1]}`) {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync('data/enrichedMetadata.json', 'utf8')); } catch {}
  const gd = JSON.parse(fs.readFileSync('data/goodreadsData.json', 'utf8'));
  const m = computeEvalMetrics(gd, meta);

  console.log(`eval over ${m.n} completed rated reads (DNFs excluded)`);
  console.log(`base rate (>=4 stars): ${(100 * m.baseRate).toFixed(1)}%   MAE: ${m.mae.toFixed(3)}`);
  for (const k of [10, 25, 50, 100]) {
    console.log(`precision@${k}: ${m.precisionAtK[k].toFixed(1)}%`);
  }
  console.log(`bottom-50 catches <=3 stars: ${m.bottomCatch}/50 (chance would catch ${m.bottomChance.toFixed(0)})`);
  console.log('\nworst misses (predicted high, rated low):');
  m.worstMisses.forEach(x => console.log(`  pred ${x.predicted.toFixed(2)} actual ${x.actual} — ${x.title.slice(0, 60)}`));
}
