#!/usr/bin/env node
// Rank tracker for Bill's Jul 3 2026 curated review of ranks 1-20. Run from
// repo root: node scripts/validate_review.js
//
// Informational only (Session 34, Bill's explicit call) — NOT a pass/fail
// gate. It was one through Session 33, but Sessions 17-31's large-scale
// citation-accuracy work (thousands of previously broken/missing
// similarToTitles fixed, new well-researched candidates added) legitimately
// improved the pool's scoring enough that several of these curated keeps
// are now honestly out-competed by better matches — confirmed book-by-book
// in Session 33 (no bug: e.g. "The Tenant" sits at fiction-rank 62 of 239,
// behind 61 genuinely higher-scoring candidates). Forcing these ranks back
// up would mean working against the accuracy improvements, so a book
// drifting below top-25 here is not evidence of a regression by itself —
// just note it and move on, unless the rank distribution or reason looks
// actually wrong on inspection.
//
// Still run this after any engine change, alongside scripts/eval.js (whose
// p10/p25 ARE the protected metrics — never trade those away).

import fs from 'fs';
import { rankBBRE } from '../bbreEngine.js';

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const gd = read('data/goodreadsData.json');
const fb = read('data/feedbackData.json');
const hist = read('data/recommendationHistory.json');
const meta = read('data/enrichedMetadata.json');
const pool = read('data/candidateIndex.json')
  .flatMap(f => read('data/' + f).candidates || []);

const KEEPS = ['The Tenant', 'Local Woman Missing', 'Th1rt3en', 'Heartland',
  'The Wise Men', 'The Idaho Four', 'Everything Is Tuberculosis',
  'Empire of AI', 'Be Ready When the Luck Happens', "The Maid's Secret",
  'You Must Remember This', 'The Trolls of Wall Street', 'The Midnight Lawyer'];

const out = rankBBRE(gd, fb, [...gd.books.filter(b => b.shelf === 'to-read'), ...pool], hist, meta);
const rankOf = t => out.selected.findIndex(b => b.title.startsWith(t)) + 1;

let belowTop25 = 0;
console.log('KEEPS (current rank; drift below top 25 is informational, not a failure):');
for (const t of KEEPS) {
  const r = rankOf(t);
  const below = r === 0 || r > 25;
  if (below) belowTop25++;
  console.log(`  ${below ? 'below' : 'top25'} rank ${r || '—'}: ${t}`);
}

console.log('\nPenalized books (sanity check):');
out.selected
  .filter(b => (b._dismissAdj || 0) < 0 || (b._eraPen || 0) > 0)
  .slice(0, 15)
  .forEach(b => console.log(`  rank ${rankOf(b.title.slice(0, 30))}: ${b.title.slice(0, 50)} | dismiss=${(b._dismissAdj || 0).toFixed(2)} ${(b._dismissReasons || []).join(',')} era=${(b._eraPen || 0).toFixed(2)}`));

console.log(`\n${belowTop25} of ${KEEPS.length} keeps currently below top 25 (informational).`);
process.exit(0);
