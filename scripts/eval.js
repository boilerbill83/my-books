#!/usr/bin/env node
// Honest BBRE yardstick. Run from repo root: node scripts/eval.js
//
// Leave-one-out over COMPLETED rated reads only (DNFs excluded — their
// virtual ratings leak the answer and inflate metrics). Reports the
// numbers that match the product goal: does the top of the ranking
// contain books Bill loved?

import fs from 'fs';
import { buildTasteModel, predictRating } from '../rateEngine.js';

const gd = JSON.parse(fs.readFileSync('data/goodreadsData.json', 'utf8'));
const completed = gd.books.filter(b => b.shelf === 'read' && b.myRating >= 1 && !b.dnf);

const preds = [];
for (const b of completed) {
  const loo = { ...gd, books: gd.books.filter(x => x !== b) };
  const model = buildTasteModel(loo, []);
  const p = predictRating(b, model);
  const pr = typeof p === 'object' ? (p.rating ?? p.predicted ?? p.score) : p;
  if (Number.isFinite(pr)) preds.push({ pr, actual: b.myRating, title: b.title });
}
preds.sort((a, b) => b.pr - a.pr);

const n = preds.length;
const liked = x => x.actual >= 4;
const base = preds.filter(liked).length / n;
const mae = preds.reduce((s, x) => s + Math.abs(x.pr - x.actual), 0) / n;

console.log(`eval over ${n} completed rated reads (DNFs excluded)`);
console.log(`base rate (>=4 stars): ${(100 * base).toFixed(1)}%   MAE: ${mae.toFixed(3)}`);
for (const k of [10, 25, 50, 100]) {
  const hit = preds.slice(0, k).filter(liked).length;
  console.log(`precision@${k}: ${(100 * hit / k).toFixed(1)}%`);
}
const bottom = preds.slice(-50);
const caught = bottom.filter(x => x.actual <= 3).length;
console.log(`bottom-50 catches <=3 stars: ${caught}/50 (chance would catch ${(50 * (1 - base)).toFixed(0)})`);
console.log('\nworst misses (predicted high, rated low):');
preds.filter(x => x.actual <= 2).slice(0, 5)
  .forEach(x => console.log(`  pred ${x.pr.toFixed(2)} actual ${x.actual} — ${x.title.slice(0, 60)}`));
