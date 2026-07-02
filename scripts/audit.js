const fs = require('fs');
const data = JSON.parse(fs.readFileSync(require('path').join(__dirname, '../data/goodreadsData.json'), 'utf8'));
const books = Object.values(data.books);

console.log('='.repeat(80));
console.log('BOOK DATABASE AUDIT REPORT');
console.log('Total books:', books.length);
console.log('='.repeat(80));

// ─── 1. DUPLICATE DETECTION ───────────────────────────────────────────────────
console.log('\n\n### 1. DUPLICATE DETECTION ###\n');

// 1a. Duplicate titles on same shelf
const titleShelfMap = {};
books.forEach(b => {
  const key = b.title.trim().toLowerCase() + '|' + b.shelf;
  if (!titleShelfMap[key]) titleShelfMap[key] = [];
  titleShelfMap[key].push(b);
});
const dupTitles = Object.entries(titleShelfMap).filter(([k,v]) => v.length > 1);
if (dupTitles.length === 0) {
  console.log('[1a] No duplicate titles on same shelf found.');
} else {
  console.log(`[1a] DUPLICATE TITLES ON SAME SHELF (${dupTitles.length} groups):`);
  dupTitles.forEach(([k, bks]) => {
    console.log(`  "${bks[0].title}" on shelf "${bks[0].shelf}":`);
    bks.forEach(b => console.log(`    bookKey: ${b.bookKey}, bookId: ${b.bookId}`));
  });
}

// 1b. Duplicate titles across different shelves (not a bug per se, but notable)
const titleMap = {};
books.forEach(b => {
  const t = b.title.trim().toLowerCase();
  if (!titleMap[t]) titleMap[t] = [];
  titleMap[t].push(b);
});
const crossShelfDups = Object.entries(titleMap).filter(([k,v]) => v.length > 1);
if (crossShelfDups.length > 0) {
  console.log(`\n[1b] DUPLICATE TITLES ACROSS DIFFERENT SHELVES (${crossShelfDups.length} groups):`);
  crossShelfDups.forEach(([k, bks]) => {
    const shelves = bks.map(b => b.shelf).join(', ');
    console.log(`  "${bks[0].title}" appears on: ${shelves}`);
    bks.forEach(b => console.log(`    bookKey: ${b.bookKey}, bookId: ${b.bookId}, shelf: ${b.shelf}`));
  });
} else {
  console.log('[1b] No cross-shelf title duplicates found.');
}

// 1c. Duplicate bookKey values
const bookKeyMap = {};
books.forEach(b => {
  if (!bookKeyMap[b.bookKey]) bookKeyMap[b.bookKey] = [];
  bookKeyMap[b.bookKey].push(b);
});
const dupKeys = Object.entries(bookKeyMap).filter(([k,v]) => v.length > 1);
if (dupKeys.length === 0) {
  console.log('[1c] No duplicate bookKey values found.');
} else {
  console.log(`\n[1c] DUPLICATE BOOKKEY VALUES (${dupKeys.length} groups):`);
  dupKeys.forEach(([k, bks]) => {
    console.log(`  bookKey: "${k}":`);
    bks.forEach(b => console.log(`    "${b.title}" shelf: ${b.shelf}, bookId: ${b.bookId}`));
  });
}

// 1d. Near-duplicate titles (same shelf, edit distance ≤ 2 or one is prefix of other)
// Simple approach: check for titles that differ only in punctuation/article
const normalizeTitle = t => t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\bthe\b|\ba\b|\ban\b/g, '').replace(/\s+/g, ' ').trim();
const normTitleShelf = {};
books.forEach(b => {
  const key = normalizeTitle(b.title) + '|' + b.shelf;
  if (!normTitleShelf[key]) normTitleShelf[key] = [];
  normTitleShelf[key].push(b);
});
const nearDupTitles = Object.entries(normTitleShelf).filter(([k,v]) => v.length > 1 && !dupTitles.find(([dk]) => dk === v[0].title.trim().toLowerCase() + '|' + v[0].shelf));
if (nearDupTitles.length > 0) {
  console.log(`\n[1d] NEAR-DUPLICATE TITLES (normalized, same shelf, ${nearDupTitles.length} groups):`);
  nearDupTitles.forEach(([k, bks]) => {
    console.log(`  Normalized key: "${k}":`);
    bks.forEach(b => console.log(`    "${b.title}" (${b.shelf})`));
  });
} else {
  console.log('[1d] No near-duplicate titles found (after normalization).');
}

// ─── 2. SIMILARTOTITLES CROSS-REFERENCE ───────────────────────────────────────
console.log('\n\n### 2. SIMILARTOTITLES CROSS-REFERENCE ###\n');

const allTitlesSet = new Set(books.map(b => b.title));
const allSimRefs = {};
books.forEach(b => {
  (b.similarToTitles || []).forEach(ref => {
    if (!allSimRefs[ref]) allSimRefs[ref] = [];
    allSimRefs[ref].push(b.title);
  });
});

const missingRefs = Object.entries(allSimRefs).filter(([ref]) => !allTitlesSet.has(ref));
const presentRefs = Object.entries(allSimRefs).filter(([ref]) => allTitlesSet.has(ref));

console.log(`Total unique similarToTitles references: ${Object.keys(allSimRefs).length}`);
console.log(`References that MATCH a book title: ${presentRefs.length}`);
console.log(`References that DO NOT match any book title: ${missingRefs.length}`);

if (missingRefs.length > 0) {
  console.log(`\n[2] BROKEN similarToTitles REFERENCES (exact match fails in engine):`);
  missingRefs.sort((a,b) => b[1].length - a[1].length).forEach(([ref, usedBy]) => {
    console.log(`  "${ref}" — used by ${usedBy.length} book(s):`);
    usedBy.slice(0, 5).forEach(t => console.log(`    cited by: "${t}"`));
    if (usedBy.length > 5) console.log(`    ... and ${usedBy.length - 5} more`);
  });
}

// ─── 3. THEME VOCABULARY AUDIT ───────────────────────────────────────────────
console.log('\n\n### 3. THEME VOCABULARY AUDIT ###\n');

const themeCount = {};
books.forEach(b => {
  (b.themes || []).forEach(t => {
    themeCount[t] = (themeCount[t] || 0) + 1;
  });
});

const sortedThemes = Object.entries(themeCount).sort((a,b) => b[1] - a[1]);
console.log(`Total unique themes: ${sortedThemes.length}`);
console.log(`\nAll themes with counts:`);
sortedThemes.forEach(([t, c]) => console.log(`  ${c.toString().padStart(3)}  ${t}`));

const rareThemes = sortedThemes.filter(([t,c]) => c < 3);
console.log(`\n[3a] RARE THEMES (fewer than 3 uses, ${rareThemes.length} total):`);
rareThemes.forEach(([t, c]) => {
  const booksWith = books.filter(b => (b.themes || []).includes(t)).map(b => `"${b.title}" (${b.shelf})`);
  console.log(`  "${t}" (${c}x): ${booksWith.join(', ')}`);
});

// Near-duplicate theme check
console.log(`\n[3b] POTENTIAL NEAR-DUPLICATE THEMES:`);
const themeKeys = Object.keys(themeCount);
const normalize = s => s.toLowerCase().replace(/[-_\s]/g, '').replace(/fiction$/, '').replace(/nonfiction/, 'nonfiction');
const normThemeMap = {};
themeKeys.forEach(t => {
  const n = normalize(t);
  if (!normThemeMap[n]) normThemeMap[n] = [];
  normThemeMap[n].push(t);
});
const nearDupThemes = Object.entries(normThemeMap).filter(([n, ts]) => ts.length > 1);
if (nearDupThemes.length > 0) {
  nearDupThemes.forEach(([n, ts]) => {
    console.log(`  Possible duplicates: ${ts.map(t => `"${t}" (${themeCount[t]}x)`).join(' vs ')}`);
  });
} else {
  console.log('  None found.');
}

// ─── 4. FIELD COMPLETENESS FOR READ BOOKS ─────────────────────────────────────
console.log('\n\n### 4. FIELD COMPLETENESS FOR READ BOOKS ###\n');

const readBooks = books.filter(b => b.shelf === 'read');
console.log(`Total read books: ${readBooks.length}`);

const missingThemes = readBooks.filter(b => !b.themes || b.themes.length === 0);
const missingPages = readBooks.filter(b => !b.pages || b.pages === 0);
const missingRating = readBooks.filter(b => b.myRating === undefined || b.myRating === null);
const zeroRating = readBooks.filter(b => b.myRating === 0);
const missingAuthor = readBooks.filter(b => !b.author || b.author.trim() === '');

console.log(`[4a] Missing themes: ${missingThemes.length}`);
if (missingThemes.length > 0) {
  missingThemes.slice(0, 20).forEach(b => console.log(`  "${b.title}" by ${b.author} (${b.shelf})`));
  if (missingThemes.length > 20) console.log(`  ... and ${missingThemes.length - 20} more`);
}

console.log(`\n[4b] Missing/zero pages: ${missingPages.length}`);
if (missingPages.length > 0) {
  missingPages.slice(0, 20).forEach(b => console.log(`  "${b.title}" by ${b.author}`));
  if (missingPages.length > 20) console.log(`  ... and ${missingPages.length - 20} more`);
}

console.log(`\n[4c] Missing myRating (null/undefined): ${missingRating.length}`);
console.log(`[4d] myRating = 0 (no explicit rating given): ${zeroRating.length}`);
if (zeroRating.length > 0 && zeroRating.length <= 30) {
  zeroRating.forEach(b => console.log(`  "${b.title}" by ${b.author}`));
} else if (zeroRating.length > 30) {
  console.log(`  (first 30 shown)`);
  zeroRating.slice(0, 30).forEach(b => console.log(`  "${b.title}" by ${b.author}`));
}

console.log(`\n[4e] Missing author: ${missingAuthor.length}`);
if (missingAuthor.length > 0) {
  missingAuthor.forEach(b => console.log(`  "${b.title}"`));
}

// Rating out of range
const outOfRange = books.filter(b => b.myRating > 5 || b.myRating < 0);
console.log(`\n[4f] myRating out of range (>5 or <0): ${outOfRange.length}`);
if (outOfRange.length > 0) {
  outOfRange.forEach(b => console.log(`  "${b.title}" myRating=${b.myRating}`));
}

// ─── 5. SEMANTIC SPOT CHECKS ───────────────────────────────────────────────────
console.log('\n\n### 5. SEMANTIC SPOT CHECKS (10 per shelf) ###\n');

const shelves = ['read', 'to-read', 'currently-reading'];
// Use deterministic "random" — pick evenly spaced indices
shelves.forEach(shelf => {
  const shelfBooks = books.filter(b => b.shelf === shelf);
  const step = Math.max(1, Math.floor(shelfBooks.length / 10));
  const sample = [];
  for (let i = 0; i < shelfBooks.length && sample.length < 10; i += step) {
    sample.push(shelfBooks[i]);
  }
  console.log(`\n--- Shelf: "${shelf}" (${shelfBooks.length} books) ---`);
  sample.forEach(b => {
    console.log(`  "${b.title}" by ${b.author}`);
    console.log(`    themes: [${(b.themes||[]).join(', ')}]`);
    console.log(`    similarToTitles: [${(b.similarToTitles||[]).join(', ')}]`);
  });
});

// ─── 6. SELF-REFERENCES IN SIMILARTOTITLES ─────────────────────────────────────
console.log('\n\n### 6. SELF-REFERENCES IN SIMILARTOTITLES ###\n');

const selfRefs = books.filter(b => (b.similarToTitles || []).includes(b.title));
if (selfRefs.length === 0) {
  console.log('No self-references found.');
} else {
  console.log(`SELF-REFERENCES FOUND (${selfRefs.length}):`);
  selfRefs.forEach(b => console.log(`  "${b.title}" lists itself in similarToTitles`));
}

// ─── 7. SHELF ASSIGNMENT SANITY ───────────────────────────────────────────────
console.log('\n\n### 7. SHELF ASSIGNMENT SANITY ###\n');

const validShelves = new Set(['read', 'to-read', 'currently-reading']);
const invalidShelf = books.filter(b => !validShelves.has(b.shelf));
const missingShelf = books.filter(b => !b.shelf);

const shelfCounts = {};
books.forEach(b => { shelfCounts[b.shelf] = (shelfCounts[b.shelf] || 0) + 1; });
console.log('Shelf distribution:');
Object.entries(shelfCounts).sort((a,b) => b[1]-a[1]).forEach(([s,c]) => console.log(`  "${s}": ${c}`));

if (invalidShelf.length > 0) {
  console.log(`\n[7a] INVALID SHELF VALUES (${invalidShelf.length}):`);
  invalidShelf.forEach(b => console.log(`  "${b.title}" shelf="${b.shelf}"`));
} else {
  console.log('\n[7a] All shelf values are valid.');
}

if (missingShelf.length > 0) {
  console.log(`\n[7b] MISSING SHELF VALUES (${missingShelf.length}):`);
  missingShelf.forEach(b => console.log(`  "${b.title}"`));
} else {
  console.log('[7b] No missing shelf values.');
}

// ─── BONUS: Additional checks ─────────────────────────────────────────────────
console.log('\n\n### BONUS: ADDITIONAL CHECKS ###\n');

// Books with empty similarToTitles on read shelf (affects engine quality)
const readNoSimilar = readBooks.filter(b => !b.similarToTitles || b.similarToTitles.length === 0);
console.log(`[B1] Read books with no similarToTitles: ${readNoSimilar.length}`);
if (readNoSimilar.length > 0 && readNoSimilar.length <= 30) {
  readNoSimilar.forEach(b => console.log(`  "${b.title}" by ${b.author} (rating: ${b.myRating})`));
} else if (readNoSimilar.length > 30) {
  console.log(`  (first 30 shown)`);
  readNoSimilar.slice(0, 30).forEach(b => console.log(`  "${b.title}" by ${b.author} (rating: ${b.myRating})`));
}

// Books on to-read with 5-star rating (weird — haven't read it but rated it?)
const toReadRated = books.filter(b => b.shelf === 'to-read' && b.myRating > 0);
console.log(`\n[B2] To-read books with myRating > 0: ${toReadRated.length}`);
if (toReadRated.length > 0) {
  toReadRated.forEach(b => console.log(`  "${b.title}" myRating=${b.myRating}`));
}

// avgRating out of typical range (should be 1-5)
const badAvgRating = books.filter(b => b.avgRating > 5 || b.avgRating < 1);
console.log(`\n[B3] avgRating out of range (not 1-5): ${badAvgRating.length}`);
if (badAvgRating.length > 0) {
  badAvgRating.forEach(b => console.log(`  "${b.title}" avgRating=${b.avgRating}`));
}

// ratingsCount = 0 or very low for non-new books
const lowRatings = books.filter(b => !b.ratingsCount || b.ratingsCount < 10);
console.log(`\n[B4] Books with ratingsCount < 10 or missing: ${lowRatings.length}`);
if (lowRatings.length > 0) {
  lowRatings.forEach(b => console.log(`  "${b.title}" ratingsCount=${b.ratingsCount}`));
}

// Pages extremely low or high
const weirdPages = books.filter(b => b.pages && (b.pages < 10 || b.pages > 5000));
console.log(`\n[B5] Books with unusual page counts (<10 or >5000): ${weirdPages.length}`);
if (weirdPages.length > 0) {
  weirdPages.forEach(b => console.log(`  "${b.title}" pages=${b.pages}`));
}

// Missing themes on to-read shelf
const toReadNoThemes = books.filter(b => b.shelf === 'to-read' && (!b.themes || b.themes.length === 0));
console.log(`\n[B6] To-read books with no themes: ${toReadNoThemes.length}`);
if (toReadNoThemes.length > 0 && toReadNoThemes.length <= 30) {
  toReadNoThemes.forEach(b => console.log(`  "${b.title}" by ${b.author}`));
} else if (toReadNoThemes.length > 30) {
  console.log(`  (first 30 shown)`);
  toReadNoThemes.slice(0, 30).forEach(b => console.log(`  "${b.title}" by ${b.author}`));
}

console.log('\n' + '='.repeat(80));
console.log('END OF AUDIT REPORT');
console.log('='.repeat(80));
