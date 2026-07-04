#!/usr/bin/env node
// Validation gate for BBRE changes, from Bill's Jul 3 2026 review of ranks
// 1-20. Run from repo root: node scripts/validate_review.js
//
// Pass criteria:
//   1. All review KEEPS still rank in the top 25
//   2. Books hitting new penalties are reported for eyeball sanity
// Run scripts/eval.js separately; p10 must stay 100.

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

let fail = false;
console.log('KEEPS (must be <= 25):');
for (const t of KEEPS) {
  const r = rankOf(t);
  const bad = r === 0 || r > 25;
  if (bad) fail = true;
  console.log(`  ${bad ? 'FAIL' : ' ok '} rank ${r || '—'}: ${t}`);
}

console.log('\nPenalized books (sanity check):');
out.selected
  .filter(b => (b._dismissAdj || 0) < 0 || (b._eraPen || 0) > 0)
  .slice(0, 15)
  .forEach(b => console.log(`  rank ${rankOf(b.title.slice(0, 30))}: ${b.title.slice(0, 50)} | dismiss=${(b._dismissAdj || 0).toFixed(2)} ${(b._dismissReasons || []).join(',')} era=${(b._eraPen || 0).toFixed(2)}`));

console.log(fail ? '\nGATE: FAIL' : '\nGATE: PASS');
process.exit(fail ? 1 : 0);
