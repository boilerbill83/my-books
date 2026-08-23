// Computes the real list of titleKeys where inferSubgenres()/inferTones()
// (engine.js) return empty for EITHER field, using the actual engine.js
// classifier — not a second, hand-maintained reimplementation of its
// keyword/overview-text logic in Python, which would be exactly the kind
// of drift-prone duplicate this project has avoided everywhere else
// (loadData.js/loadAllTitles.js's whole reason for existing). Writes
// trakt/data/llmTagGaps.json, a plain array of titleKeys, for
// trakt/tag_llm.py to read before spending any real API calls.
//
// Run before every trakt/tag_llm.py invocation: node trakt/find_llm_tag_gaps.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { inferSubgenres, inferTones } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const read = name => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));

const library = read('library.json');
const watchlist = read('watchlist.json');
const candidatePool = read('candidatePool.json');
const enrichedMeta = read('enrichedMetadata.json');

const seen = new Map();
for (const list of [watchlist.titles, library.titles, candidatePool.titles]) {
  for (const t of list || []) {
    if (t.titleKey && !seen.has(t.titleKey)) seen.set(t.titleKey, t);
  }
}

const gaps = [];
for (const [titleKey] of seen) {
  const meta = enrichedMeta[titleKey];
  if (!meta || !meta.genres) continue; // unenriched — nothing to tag from yet, not a gap this pass can fill
  // No llmEntry available yet (that's the whole point of finding the
  // gap) — pass undefined for tier 3, matching a real call site before
  // any LLM cache exists.
  const subs = inferSubgenres(meta, undefined);
  const tones = inferTones(meta, undefined);
  if (subs.length === 0 || tones.length === 0) gaps.push(titleKey);
}

fs.writeFileSync(path.join(DATA_DIR, 'llmTagGaps.json'), JSON.stringify(gaps));
console.log(`${gaps.length} of ${seen.size} enriched titles have a real gap (empty subgenres and/or tones) — wrote trakt/data/llmTagGaps.json`);
