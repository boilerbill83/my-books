
function norm(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .toLowerCase()
    .trim()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function bookKey(title, author) {
  return `${norm(title)}|${norm(author)}`;
}

export function buildIndexes(goodreads, feedback) {
  const read             = new Map();
  const toRead           = new Map();
  const currentlyReading = new Map();
  const fiveStarTitles   = new Set();
  const fiveStarAuthors  = new Map();
  const allReadAuthors   = new Map();
  const excluded         = new Map();

  for (const book of goodreads.books || []) {
    const shelf = String(book.shelf || '').toLowerCase();
    const key   = book.bookKey || bookKey(book.title, book.author);
    if (shelf === 'read') {
      read.set(key, book);
      allReadAuthors.set(book.author, (allReadAuthors.get(book.author) || 0) + 1);
      if (book.myRating === 5) {
        fiveStarTitles.add(book.title);
        fiveStarAuthors.set(book.author, (fiveStarAuthors.get(book.author) || 0) + 1);
      }
    } else if (shelf === 'to-read') {
      toRead.set(key, book);
    } else if (shelf === 'currently-reading') {
      currentlyReading.set(key, book);
    }
  }

  for (const interaction of feedback.interactions || []) {
    if (interaction?.bookKey) excluded.set(interaction.bookKey, interaction);
  }

  return { read, toRead, currentlyReading, fiveStarTitles, fiveStarAuthors, allReadAuthors, excluded };
}

function summarize(goodreads) {
  const readBooks = (goodreads.books || []).filter(b => String(b.shelf || '').toLowerCase() === 'read');
  const fiveStar  = readBooks.filter(b => b.myRating === 5);
  const byAuthor  = new Map();
  const years     = new Map();
  const pages     = [];

  for (const b of readBooks) {
    byAuthor.set(b.author, (byAuthor.get(b.author) || 0) + 1);
    if (b.dateRead) years.set(b.dateRead.slice(0, 4), (years.get(b.dateRead.slice(0, 4)) || 0) + 1);
    if (Number.isFinite(b.pages)) pages.push(b.pages);
  }

  const sortedPages = [...pages].sort((a, b) => a - b);
  return {
    booksRead:          readBooks.length,
    fiveStarBooks:      fiveStar.length,
    avgRating:          readBooks.length
      ? (readBooks.reduce((s, b) => s + (Number(b.myRating) || 0), 0) / readBooks.length).toFixed(2)
      : '0.00',
    favoriteAuthors:    [...byAuthor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
    medianPages:        sortedPages.length ? sortedPages[Math.floor(sortedPages.length / 2)] : null,
    mostRecentReadYear: [...years.keys()].sort().slice(-1)[0] || 'n/a'
  };
}

function isExcluded(candidate, idx) {
  const k        = candidate.bookKey || bookKey(candidate.title, candidate.author);
  const feedback = idx.excluded.get(k);
  if (feedback?.explicitHide || feedback?.excludeFromRecommendations) return true;
  // to-read shelf books are never auto-excluded — user already wants to read them
  if (candidate.fromToRead) return false;
  return idx.read.has(k) || idx.currentlyReading.has(k);
}

function matchScore(candidate, idx, profile, timesShown) {
  let score = 55;

  if (candidate.fromToRead) {
    score += 10; // base boost — user already expressed interest
    score += (idx.fiveStarAuthors.get(candidate.author) || 0) * 6;
    score += (idx.allReadAuthors.get(candidate.author)   || 0) * 1.5;
    const avg = Number(candidate.avgRating) || 0;
    if (avg > 0) score += (avg - 3.5) * 6;
  } else {
    for (const a of candidate.similarToAuthors || []) {
      score += (idx.fiveStarAuthors.get(a) || 0) * 4;
      score += (idx.allReadAuthors.get(a)   || 0) * 0.5;
    }
    for (const t of candidate.similarToTitles || []) {
      if (idx.fiveStarTitles.has(t)) score += 8;
    }
    if (profile.medianPages && candidate.pages) {
      const delta = Math.abs(candidate.pages - profile.medianPages);
      if (delta <= 50)       score += 6;
      else if (delta <= 100) score += 3;
      else if (delta >= 220) score -= 4;
    }
    if ((candidate.themes || []).includes('speculative')) score += 2;
    if ((candidate.themes || []).includes('thriller'))    score += 2;
    if ((candidate.themes || []).includes('technology'))  score += 2;
    if ((candidate.themes || []).includes('business'))    score += 1;
  }

  if (timesShown === 1)      score -= 10;
  else if (timesShown === 2) score -= 25;
  else if (timesShown >= 3)  score -= 50;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function confidenceScore(candidate, idx) {
  if (candidate.fromToRead) {
    let score = 55;
    if (idx.fiveStarAuthors.has(candidate.author))    score += 20;
    else if (idx.allReadAuthors.has(candidate.author)) score += 10;
    if (candidate.pages) score += 4;
    return Math.max(0, Math.min(100, Math.round(score)));
  }
  let score = 58;
  if ((candidate.similarToAuthors || []).length >= 2) score += 8;
  if ((candidate.similarToTitles  || []).length >= 2) score += 8;
  if (candidate.pages)                                score += 4;
  if ((candidate.themes || []).length >= 2)           score += 4;
  const overlap = (candidate.similarToAuthors || []).reduce(
    (sum, a) => sum + (idx.fiveStarAuthors.get(a) || 0), 0
  );
  score += Math.min(15, overlap * 2);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function reason(candidate, idx) {
  if (candidate.fromToRead) {
    const fiveCount = idx.fiveStarAuthors.get(candidate.author) || 0;
    const readCount = idx.allReadAuthors.get(candidate.author)   || 0;
    if (fiveCount > 0)
      return `On your to-read list — you've given ${candidate.author} five stars before (${fiveCount} time${fiveCount > 1 ? 's' : ''}).`;
    if (readCount > 0)
      return `On your to-read list — you've read ${readCount} other book${readCount > 1 ? 's' : ''} by ${candidate.author}.`;
    return `On your to-read list — sounds like it could be your next great read.`;
  }
  const authorMatches = (candidate.similarToAuthors || []).filter(a => idx.fiveStarAuthors.has(a));
  const titleMatches  = (candidate.similarToTitles  || []).filter(t => idx.fiveStarTitles.has(t));
  const parts = [];
  if (authorMatches.length) parts.push(`matches your strong results with ${authorMatches.slice(0, 2).join(' and ')}`);
  if (titleMatches.length)  parts.push(`lines up with ${titleMatches.slice(0, 2).join(' and ')}`);
  if ((candidate.themes || []).length) parts.push(`fits your ${(candidate.themes || []).slice(0, 2).join(' / ')} preferences`);
  return parts.length
    ? `Recommended because it ${parts.join('; ')}.`
    : 'Recommended because it aligns with your overall reading profile.';
}

export function rankRecommendations(goodreads, feedback, candidatePool, history) {
  const idx     = buildIndexes(goodreads, feedback);
  const profile = summarize(goodreads);
  const showMap = new Map((history.history || []).map(h => [h.bookKey, h.timesShown || 0]));
  const viable  = (candidatePool || []).filter(c => !isExcluded(c, idx));

  const scored = viable.map(c => {
    const k = c.fromToRead
      ? (c.bookKey || bookKey(c.title, c.author))
      : bookKey(c.title, c.author);
    return {
      ...c,
      bookKey:         k,
      matchScore:      matchScore(c, idx, profile, showMap.get(k) || 0),
      confidenceScore: confidenceScore(c, idx),
      reason:          reason(c, idx)
    };
  }).sort((a, b) => (b.matchScore - a.matchScore) || (b.confidenceScore - a.confidenceScore));

  return {
    selected:      scored.map((x, i) => ({ ...x, rank: i + 1 })),
    profile,
    eligibleCount: viable.length
  };
}
