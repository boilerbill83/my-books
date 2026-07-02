const data = require('../data/goodreadsData.json');
const books = data.books;

// ============================================================
// SECTION 1: DUPLICATE DETECTION
// ============================================================
console.log("\n========================================");
console.log("SECTION 1: DUPLICATE DETECTION");
console.log("========================================\n");

// 1a. Exact title duplicates (same shelf)
const titleByShelf = {};
books.forEach(b => {
  const key = b.shelf + '|||' + b.title.trim().toLowerCase();
  if (!titleByShelf[key]) titleByShelf[key] = [];
  titleByShelf[key].push(b);
});
let sameshelfDupes = [];
Object.entries(titleByShelf).forEach(([key, group]) => {
  if (group.length > 1) sameshelfDupes.push(group);
});
console.log(`1a. Exact title duplicates (same shelf): ${sameshelfDupes.length} groups`);
sameshelfDupes.forEach(g => {
  console.log(`    DUPE: "${g[0].title}" on shelf "${g[0].shelf}" (${g.length}x) — bookKeys: ${g.map(b=>b.bookKey).join(', ')}`);
});

// 1b. Near-exact title duplicates (same shelf, ignoring punctuation/articles/case)
function normalize(s) {
  return s.toLowerCase()
    .replace(/^(the |a |an )/,'')
    .replace(/[^\w\s]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
const normTitleByShelf = {};
books.forEach(b => {
  const key = b.shelf + '|||' + normalize(b.title);
  if (!normTitleByShelf[key]) normTitleByShelf[key] = [];
  normTitleByShelf[key].push(b);
});
let nearDupes = [];
Object.entries(normTitleByShelf).forEach(([key, group]) => {
  if (group.length > 1) {
    // Only flag if exact-title match didn't already catch them
    const exactKey = group[0].shelf + '|||' + group[0].title.trim().toLowerCase();
    if (titleByShelf[exactKey] && titleByShelf[exactKey].length < 2) {
      nearDupes.push(group);
    }
  }
});
console.log(`\n1b. Near-exact title duplicates (same shelf): ${nearDupes.length} groups`);
nearDupes.forEach(g => {
  console.log(`    NEAR-DUPE: "${g[0].title}" vs "${g[1].title}" on shelf "${g[0].shelf}"`);
  g.forEach(b => console.log(`      bookKey: ${b.bookKey}`));
});

// 1c. Same title across DIFFERENT shelves (potential re-adds)
const titleAllShelves = {};
books.forEach(b => {
  const key = b.title.trim().toLowerCase();
  if (!titleAllShelves[key]) titleAllShelves[key] = [];
  titleAllShelves[key].push(b);
});
let crossShelfDupes = [];
Object.entries(titleAllShelves).forEach(([key, group]) => {
  if (group.length > 1) {
    const shelves = [...new Set(group.map(b=>b.shelf))];
    if (shelves.length > 1) crossShelfDupes.push(group);
  }
});
console.log(`\n1c. Same title on DIFFERENT shelves (${crossShelfDupes.length} cases):`);
crossShelfDupes.forEach(g => {
  console.log(`    "${g[0].title}" — shelves: ${g.map(b=>b.shelf).join(', ')} — bookKeys: ${g.map(b=>b.bookKey).join(', ')}`);
});

// 1d. Duplicate bookKey values
const bookKeyMap = {};
books.forEach(b => {
  if (!bookKeyMap[b.bookKey]) bookKeyMap[b.bookKey] = [];
  bookKeyMap[b.bookKey].push(b);
});
let keyDupes = Object.entries(bookKeyMap).filter(([k,v]) => v.length > 1);
console.log(`\n1d. Duplicate bookKey values: ${keyDupes.length} duplicates`);
keyDupes.forEach(([k, group]) => {
  console.log(`    bookKey "${k}" used by: ${group.map(b=>'"'+b.title+'"').join(', ')}`);
});


// ============================================================
// SECTION 2: similarToTitles CROSS-REFERENCE ACCURACY
// ============================================================
console.log("\n========================================");
console.log("SECTION 2: similarToTitles CROSS-REFERENCE ACCURACY");
console.log("========================================\n");

// Build a Set of all exact titles in the dataset
const allTitlesSet = new Set(books.map(b => b.title));

// Gather all referenced titles from similarToTitles, tracking which books reference them
const referencedTitles = {}; // referenced_title -> [{bookTitle, bookKey, shelf}]
books.forEach(b => {
  if (b.similarToTitles && b.similarToTitles.length > 0) {
    b.similarToTitles.forEach(ref => {
      if (!referencedTitles[ref]) referencedTitles[ref] = [];
      referencedTitles[ref].push({ bookTitle: b.title, bookKey: b.bookKey, shelf: b.shelf });
    });
  }
});

const totalUniqueRefs = Object.keys(referencedTitles).length;
const brokenRefs = Object.entries(referencedTitles).filter(([ref]) => !allTitlesSet.has(ref));
const workingRefs = Object.entries(referencedTitles).filter(([ref]) => allTitlesSet.has(ref));

console.log(`Total unique titles referenced in similarToTitles: ${totalUniqueRefs}`);
console.log(`References that MATCH a book in dataset: ${workingRefs.length}`);
console.log(`References with NO MATCH (broken): ${brokenRefs.length}`);

// Count total broken reference instances
let totalBrokenInstances = 0;
brokenRefs.forEach(([ref, sources]) => { totalBrokenInstances += sources.length; });
console.log(`Total broken reference instances (sum across all books): ${totalBrokenInstances}`);

console.log(`\n--- BROKEN similarToTitles references (sorted by how many books reference each) ---`);
brokenRefs.sort((a,b) => b[1].length - a[1].length).forEach(([ref, sources]) => {
  console.log(`\n  MISSING: "${ref}" (referenced by ${sources.length} book(s)):`);
  sources.forEach(s => console.log(`    <- "${s.bookTitle}" [${s.shelf}] (${s.bookKey})`));
});

// Stats: how many books have at least one broken reference?
const booksWithBrokenRefs = new Set();
brokenRefs.forEach(([ref, sources]) => sources.forEach(s => booksWithBrokenRefs.add(s.bookKey)));
console.log(`\nBooks with at least one broken similarToTitles reference: ${booksWithBrokenRefs.size}`);

// Books with zero similarToTitles
const booksWithNoSimilar = books.filter(b => !b.similarToTitles || b.similarToTitles.length === 0);
console.log(`Books with no similarToTitles at all: ${booksWithNoSimilar.length}`);
const noSimByShelf = {};
booksWithNoSimilar.forEach(b => { noSimByShelf[b.shelf] = (noSimByShelf[b.shelf]||0)+1; });
console.log(`  By shelf:`, noSimByShelf);

