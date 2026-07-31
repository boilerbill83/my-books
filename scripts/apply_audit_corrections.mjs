#!/usr/bin/env node
// Applies high-confidence, not-yet-applied corrections from
// output/tone-theme-audit-log.jsonl (written by audit_theme_tone.py) to the
// themes/tones fields of the specific books they name. Never JSON.parse +
// stringify a whole data file — this repo has hit real corruption bugs doing
// that (unicode escaping, number reformatting) — instead finds each named
// book's byte span by bookKey and replaces just the one field's array value
// in place, the same surgical technique proven in the Session 16 tone
// migration (data/goodreadsData.json + candidatePool*.json), generalized
// here to work for either "themes" or "tones" and to look books up by
// bookKey (sparse corrections scattered across files) rather than assuming
// every book in a file has a pending correction.
//
// Marks each applied correction by appending a follow-up JSONL line with
// applied:true for that field, rather than rewriting the log in place — the
// log stays append-only, and "latest entry per bookKey wins" when reading it
// back, same principle as the data files never being rewritten wholesale.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const DATA = f => path.join(ROOT, 'data', f);
const LOG_FILE = path.join(ROOT, 'output', 'tone-theme-audit-log.jsonl');
const FILES = ['goodreadsData.json', 'candidatePool.json', 'candidatePool2.json',
  'candidatePool3.json', 'candidatePool4.json', 'candidatePool5.json', 'candidatePool6.json'];

const CANON_THEMES = new Set([
  'thriller', 'psychological', 'suspense', 'domestic suspense', 'mystery', 'crime',
  'noir', 'horror', 'high-concept', 'spy', 'adventure', 'historical', 'YA', 'romance',
  'literary', 'contemporary', 'speculative', 'sci-fi', 'social commentary', 'legal',
  'courtroom', 'narrative nonfiction', 'memoir', 'biography', 'true crime', 'history',
  'tech history', 'finance', 'business', 'sports', 'food', 'music history', 'political',
  'military', 'psychology', 'humor', 'comedy',
]);
const CANON_TONES = new Set([
  'propulsive', 'compulsive', 'slow-burn', 'twisty', 'procedural', 'nonlinear', 'ensemble',
  'dark', 'bleak', 'tense', 'heartwarming', 'poignant', 'inspiring',
  'funny', 'satirical', 'conversational',
  'atmospheric', 'lyrical', 'gritty', 'character-driven',
  'revelatory', 'dense', 'thoughtful', 'investigative',
]);
const FIELD_RULES = {
  themes: { vocab: CANON_THEMES, min: 2, max: 5 },
  tones: { vocab: CANON_TONES, min: 2, max: 4 },
};

function validSuggestion(field, values) {
  const rule = FIELD_RULES[field];
  return Array.isArray(values) && values.length >= rule.min && values.length <= rule.max
    && values.every(v => rule.vocab.has(v));
}

if (!fs.existsSync(LOG_FILE)) {
  console.log('No audit log yet — nothing to apply.');
  process.exit(0);
}

// Read the log, keep only the LATEST line per bookKey (later lines — e.g. a
// prior apply run's "applied:true" follow-up — supersede earlier ones).
const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
const latestByKey = new Map();
for (const line of lines) {
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if (entry.bookKey) latestByKey.set(entry.bookKey, entry);
}

// Collect pending high-confidence corrections per field.
const pending = { themes: new Map(), tones: new Map() }; // bookKey -> new array
for (const [bookKey, entry] of latestByKey) {
  for (const field of ['themes', 'tones']) {
    const side = entry[field];
    const applied = entry.applied?.[field];
    if (!side || applied) continue;
    if (side.verdict === 'inaccurate' && side.confidence === 'high' && validSuggestion(field, side.suggested)) {
      pending[field].set(bookKey, side.suggested);
    }
  }
}

const totalPending = pending.themes.size + pending.tones.size;
if (!totalPending) {
  console.log('No pending high-confidence corrections to apply.');
  process.exit(0);
}
console.log(`Pending corrections: ${pending.themes.size} themes, ${pending.tones.size} tones`);

// Find every top-level array element's [start, end) byte span, and each
// span's bookKey, within `text` given the index of the array's opening '['.
function findBookSpans(text, arrOpenIdx) {
  const spans = [];
  let i = arrOpenIdx + 1;
  let depth = 0;
  let inStr = false, esc = false;
  let objStart = null;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth === 0) objStart = i; depth++; }
      else if (c === '}') { depth--; if (depth === 0) spans.push([objStart, i + 1]); }
      else if (c === ']' && depth === 0) break;
    }
    i++;
  }
  return spans.map(([s, e]) => {
    const segment = text.slice(s, e);
    const m = segment.match(/"bookKey":\s*"([^"]*)"/);
    return { start: s, end: e, bookKey: m ? m[1] : null };
  });
}

function replaceFieldInSpan(segment, field, newValues) {
  const re = new RegExp(`"${field}":\\s*\\[[^\\]]*\\]`, 'g');
  const matches = [...segment.matchAll(re)];
  if (!matches.length) throw new Error(`no "${field}" field found in span`);

  const last = matches[matches.length - 1];
  const isMultiline = last[0].includes('\n');
  let replacement;
  if (isMultiline) {
    const lines2 = last[0].split('\n');
    const elemIndent = (lines2[1]?.match(/^(\s*)/) || [, '        '])[1];
    const closeIndent = (lines2[lines2.length - 1]?.match(/^(\s*)/) || [, '      '])[1];
    const body = newValues.map(v => `${elemIndent}"${v}"`).join(',\n');
    replacement = `"${field}": [\n${body}\n${closeIndent}]`;
  } else {
    replacement = `"${field}": [${newValues.map(v => `"${v}"`).join(', ')}]`;
  }

  let out = '';
  let cursor = 0;
  matches.forEach((m, idx) => {
    if (idx === matches.length - 1) {
      out += segment.slice(cursor, m.index) + replacement;
      cursor = m.index + m[0].length;
    } else {
      // Defensive: drop any earlier duplicate occurrence entirely (same
      // shape of bug the Session 16 tone migration found and fixed).
      let end = m.index + m[0].length;
      while (segment[end] === ' ') end++;
      if (segment[end] === ',') end++;
      if (segment[end] === '\n') end++;
      let startTrim = m.index;
      let back = startTrim - 1;
      while (back >= 0 && (segment[back] === ' ' || segment[back] === '\t')) back--;
      if (segment[back] === '\n') startTrim = back + 1;
      out += segment.slice(cursor, startTrim);
      cursor = end;
    }
  });
  out += segment.slice(cursor);
  return out;
}

const appliedNow = []; // { bookKey, field }

for (const file of FILES) {
  const filePath = DATA(file);
  if (!fs.existsSync(filePath)) continue;
  let text = fs.readFileSync(filePath, 'utf8');
  const arrKey = file === 'goodreadsData.json' ? '"books"' : '"candidates"';
  const keyIdx = text.indexOf(arrKey);
  if (keyIdx === -1) continue;
  const arrOpenIdx = text.indexOf('[', keyIdx);
  const spans = findBookSpans(text, arrOpenIdx);

  // Which spans in THIS file have a pending correction, in reverse order so
  // earlier byte offsets stay valid as each edit is applied.
  const toEdit = spans
    .map((sp, i) => ({ ...sp, i }))
    .filter(sp => sp.bookKey && (pending.themes.has(sp.bookKey) || pending.tones.has(sp.bookKey)))
    .sort((a, b) => b.start - a.start);

  if (!toEdit.length) continue;

  for (const sp of toEdit) {
    let segment = text.slice(sp.start, sp.end);
    for (const field of ['themes', 'tones']) {
      if (pending[field].has(sp.bookKey)) {
        segment = replaceFieldInSpan(segment, field, pending[field].get(sp.bookKey));
        appliedNow.push({ bookKey: sp.bookKey, field });
      }
    }
    text = text.slice(0, sp.start) + segment + text.slice(sp.end);
  }

  fs.writeFileSync(filePath, text);
  console.log(`${file}: ${toEdit.length} book(s) corrected`);
}

// Append follow-up log lines marking these corrections applied, so a future
// run's "latest entry per bookKey" read sees applied:true and skips them.
const now = new Date().toISOString().slice(0, 10);
const byBookKey = new Map();
for (const { bookKey, field } of appliedNow) {
  if (!byBookKey.has(bookKey)) byBookKey.set(bookKey, new Set());
  byBookKey.get(bookKey).add(field);
}
const followUps = [];
for (const [bookKey, fields] of byBookKey) {
  const entry = latestByKey.get(bookKey);
  const updated = {
    ...entry,
    appliedAt: now,
    applied: {
      themes: entry.applied?.themes || fields.has('themes'),
      tones: entry.applied?.tones || fields.has('tones'),
    },
  };
  followUps.push(JSON.stringify(updated));
}
if (followUps.length) {
  fs.appendFileSync(LOG_FILE, followUps.join('\n') + '\n');
}

console.log(`Applied ${appliedNow.length} correction(s) across ${byBookKey.size} book(s).`);
