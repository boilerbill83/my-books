/**
 * Runs the BBRE engine against all to-read books and outputs scores as JSON.
 * Usage: node temp/score_toread.mjs > temp/toread_scores.json
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rankBBRE } from '../bbreEngine.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');

const goodreads = JSON.parse(readFileSync(join(dir, 'data/goodreadsData.json')));
const feedback  = {};
const history   = { seen: [], dismissed: [] };

// Load all candidate pools too so the taste model is built on the full corpus
const candidatePools = [];
for (const n of ['candidatePool.json','candidatePool2.json','candidatePool3.json','candidatePool4.json','candidatePool5.json']) {
  try {
    const d = JSON.parse(readFileSync(join(dir, 'data', n)));
    candidatePools.push(...(d.candidates || []));
  } catch {}
}

const toRead = goodreads.books.filter(b => b.shelf === 'to-read');

// Combine candidate pools + to-read (mirrors the app's combined-pool behavior)
const allCands = [...candidatePools, ...toRead];
const result = rankBBRE(goodreads, feedback, allCands, history);

// Emit scores for all books in the combined pool
const scores = {};
for (const b of result.selected) {
  const key = `${b.title}|||${b.author}`;
  scores[key] = b.matchScore;
}

process.stdout.write(JSON.stringify(scores));
