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
import { inferSubgenres, inferTones, inferSubjects } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const read = name => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));

const library = read('library.json');
const watchlist = read('watchlist.json');
const candidatePool = read('candidatePool.json');
const enrichedMeta = read('enrichedMetadata.json');
// inferSubjects()'s reviewed-override tier (checked first, same priority
// as inferSubgenres()/inferTones()) needs this to correctly skip a title
// that already has a real hand-reviewed subject — same file the reviewed-
// tag CUSTOM field-quality findings already read.
let reviewedTags = {};
try { reviewedTags = read('reviewedTags.json'); } catch {}

const seen = new Map();
for (const list of [watchlist.titles, library.titles, candidatePool.titles]) {
  for (const t of list || []) {
    if (t.titleKey && !seen.has(t.titleKey)) seen.set(t.titleKey, t);
  }
}

// Subjects added to this gap check (previously subgenre/tone-only): the
// LLM call already returns {genre, subgenres, tones} for every selected
// title at a fixed cost — asking it for subjects too is a real, live
// scoring signal (subjectBonus(), wired into baseSignals()) closed at
// zero extra API spend for any title already selected, PLUS this widens
// selection itself to catch titles whose subgenre/tone are already
// covered by the free keyword tier but whose subjects genuinely aren't —
// the real, previously-undiscovered gap trakt/quality.js's own
// field-quality-subjects finding flagged (inferSubjects() already reads
// llmEntry?.subjects correctly; tag_llm.py's prompt just never asked for it).
let subgenreGaps = 0, toneGaps = 0, subjectGaps = 0;
const gaps = [];
for (const [titleKey] of seen) {
  const meta = enrichedMeta[titleKey];
  if (!meta || !meta.genres) continue; // unenriched — nothing to tag from yet, not a gap this pass can fill
  // No llmEntry available yet (that's the whole point of finding the
  // gap) — pass undefined for tier 3, matching a real call site before
  // any LLM cache exists. Real bug fixed here: the subgenre/tone calls
  // never passed `reviewed` (4th arg) at all — a title whose subgenre/
  // tone only exists via the reviewed-workbook override tier (checked
  // FIRST by both functions) was wrongly counted as a gap, since without
  // it the free keyword tier alone came back empty. Confirmed live: this
  // was inflating the tone-gap count specifically (the Session 55-58
  // taxonomy consolidations moved a lot of real tone signal into the
  // reviewed tier) — 715 apparent tone gaps dropped sharply once fixed.
  const reviewed = reviewedTags[titleKey];
  const subs = inferSubgenres(meta, undefined, 3, reviewed);
  const tones = inferTones(meta, undefined, 4, reviewed);
  const subjects = inferSubjects(meta, undefined, 3, reviewed);
  const isGap = subs.length === 0 || tones.length === 0 || subjects.length === 0;
  if (isGap) gaps.push(titleKey);
  if (subs.length === 0) subgenreGaps++;
  if (tones.length === 0) toneGaps++;
  if (subjects.length === 0) subjectGaps++;
}

fs.writeFileSync(path.join(DATA_DIR, 'llmTagGaps.json'), JSON.stringify(gaps));
console.log(`${gaps.length} of ${seen.size} enriched titles have a real gap (empty subgenres and/or tones and/or subjects) — wrote trakt/data/llmTagGaps.json`);
console.log(`  breakdown: ${subgenreGaps} subgenre gaps, ${toneGaps} tone gaps, ${subjectGaps} subject gaps (titles can overlap across these)`);
