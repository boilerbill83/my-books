
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

// Collapse internal whitespace before normalizing — fixes "Michael   Lewis" style keys
function normAuthor(name) {
  return norm(String(name || '').replace(/\s+/g, ' ').trim());
}

export function bookKey(title, author) {
  return `${norm(title)}|${norm(author)}`;
}

export function buildIndexes(goodreads, feedback) {
  const read             = new Map();
  const toRead           = new Map();
  const currentlyReading = new Map();
  const fiveStarTitles      = new Set();
  const fiveStarAuthors     = new Map();
  const fiveStarThemes      = new Map();
  const allReadAuthors      = new Map();
  const authorRatingWeight  = new Map();
  const reverseSimilar      = new Map();
  const excluded            = new Map();

  for (const book of goodreads.books || []) {
    const shelf     = String(book.shelf || '').toLowerCase();
    const key       = book.bookKey || bookKey(book.title, book.author);
    const authorKey = normAuthor(book.author);

    if (shelf === 'read') {
      read.set(key, book);
      allReadAuthors.set(authorKey, (allReadAuthors.get(authorKey) || 0) + 1);
      const r = book.myRating;
      if (r >= 1) {
        const w = r >= 5 ? 1.0 : r === 4 ? 0.8 : r === 3 ? 0.3 : r === 2 ? -0.5 : -1.0;
        authorRatingWeight.set(authorKey, (authorRatingWeight.get(authorKey) || 0) + w);
      }
      if (book.myRating === 5) {
        fiveStarTitles.add(book.title);
        fiveStarAuthors.set(authorKey, (fiveStarAuthors.get(authorKey) || 0) + 1);
        for (const theme of book.themes || []) {
          const t = String(theme).toLowerCase();
          fiveStarThemes.set(t, (fiveStarThemes.get(t) || 0) + 1);
        }
        for (const t of book.similarToTitles || []) {
          reverseSimilar.set(t, (reverseSimilar.get(t) || 0) + 1);
        }
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

  return { read, toRead, currentlyReading, fiveStarTitles, fiveStarAuthors, fiveStarThemes, allReadAuthors, authorRatingWeight, reverseSimilar, excluded };
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
  if (candidate.fromToRead) return false;
  return idx.read.has(k) || idx.currentlyReading.has(k);
}

const AUTHOR_CONTRIB_CAP = 15;

// BBE file has corrupted themes (all ["mystery","thriller"]) and empty similarToAuthors.
// Detect BBE books by their signature: empty similarToAuthors array AND no similarToTitles.
// For these we do a direct author lookup to inject author signal.
function isBBEBook(candidate) {
  return (candidate.similarToAuthors || []).length === 0
    && (candidate.similarToTitles || []).length === 0
    && !candidate.fromToRead;
}

function ratingsCountBonus(count) {
  const n = Number(count) || 0;
  if (n > 100000) return 4;
  if (n > 50000)  return 3;
  if (n > 20000)  return 2;
  if (n > 5000)   return 1;
  return 0;
}

function recencyBonus(year, isFiction) {
  const y = Number(year) || 0;
  if (!y) return 0;
  if (isFiction) {
    if (y >= 2023) return 3;
    if (y >= 2020) return 2;
    if (y >= 2015) return 1;
    return 0;
  } else {
    if (y >= 2023) return 6;
    if (y >= 2020) return 4;
    if (y >= 2017) return 3;
    if (y >= 2012) return 2;
    if (y < 2000)  return -2;
    return 0;
  }
}

function themeBonus(themes, fiveStarThemes) {
  const t = (themes || []).map(s => String(s).toLowerCase());
  if (t.length === 0) return 0;
  if (!fiveStarThemes || fiveStarThemes.size === 0) {
    let bonus = 0;
    if (t.includes('thriller') || t.includes('psychological'))                       bonus += 3;
    if (t.includes('speculative') || t.includes('sci-fi'))                           bonus += 3;
    if (t.includes('literary') || t.includes('historical'))                          bonus += 2;
    if (t.includes('mystery'))                                                        bonus += 2;
    if (t.includes('true crime'))                                                     bonus += 5;
    if (t.includes('tech history') || t.includes('narrative nonfiction'))            bonus += 4;
    if (t.includes('finance'))                                                        bonus += 4;
    if (t.includes('biography') || t.includes('military') || t.includes('psychology')) bonus += 3;
    if (t.includes('business'))                                                       bonus += 2;
    if (t.includes('sports'))                                                         bonus += 2;
    return Math.min(bonus, 8);
  }
  let bonus = 0;
  for (const theme of t) {
    const count = fiveStarThemes.get(theme) || 0;
    if      (count >= 40) bonus += 5;
    else if (count >= 25) bonus += 4;
    else if (count >= 12) bonus += 3;
    else if (count >= 4)  bonus += 2;
    else if (count >= 1)  bonus += 1;
  }
  return Math.min(bonus, 8);
}

function matchScoreFiction(candidate, idx, profile, timesShown) {
  let score = 55;

  if (candidate.fromToRead) {
    score += 10;
    const authorKey = normAuthor(candidate.author);
    score += Math.min(AUTHOR_CONTRIB_CAP,     (idx.fiveStarAuthors.get(authorKey) || 0) * 6);
    score += Math.min(AUTHOR_CONTRIB_CAP / 2, (idx.authorRatingWeight.get(authorKey)  || 0) * 1.5);
    for (const a of candidate.similarToAuthors || []) {
      const simKey = normAuthor(a);
      const contrib = (idx.fiveStarAuthors.get(simKey) || 0) * 4
                    + (idx.authorRatingWeight.get(simKey) || 0) * 0.5;
      score += Math.min(AUTHOR_CONTRIB_CAP, contrib);
    }
    for (const t of candidate.similarToTitles || []) {
      if (idx.fiveStarTitles.has(t)) score += 8;
    }
    score += Math.min(12, (idx.reverseSimilar.get(candidate.title) || 0) * 6);
    score += themeBonus(candidate.themes, idx.fiveStarThemes);
    score += ratingsCountBonus(candidate.ratingsCount);
    const avg = Number(candidate.avgRating) || 0;
    if (avg > 0) score += (avg - 3.5) * 10;
    if (profile.medianPages && candidate.pages) {
      const delta = Math.abs(candidate.pages - profile.medianPages);
      if (delta <= 50)       score += 6;
      else if (delta <= 100) score += 3;
      else if (delta >= 220) score -= 4;
    }
  } else {
    const bbe = isBBEBook(candidate);
    if (bbe) {
      // Direct author lookup for BBE — inject signal that similarToAuthors normally provides
      const authorKey = normAuthor(candidate.author);
      const contrib = (idx.fiveStarAuthors.get(authorKey) || 0) * 4
                    + (idx.authorRatingWeight.get(authorKey)   || 0) * 0.5;
      score += Math.min(AUTHOR_CONTRIB_CAP, contrib);
      // Option A: community rating as signal (fiction weight: ×4)
      const avg = Number(candidate.avgRating) || 0;
      if (avg > 0) score += (avg - 3.5) * 4;
      // ratingsCount bonus
      score += ratingsCountBonus(candidate.ratingsCount);
      // BBE themes are corrupted — skip theme matching
    } else {
      for (const a of candidate.similarToAuthors || []) {
        const authorKey = normAuthor(a);
        const contrib = (idx.fiveStarAuthors.get(authorKey) || 0) * 4
                      + (idx.authorRatingWeight.get(authorKey)   || 0) * 0.5;
        score += Math.min(AUTHOR_CONTRIB_CAP, contrib);
      }
      for (const t of candidate.similarToTitles || []) {
        if (idx.fiveStarTitles.has(t)) score += 8;
      }
      // Option A: community rating (fiction weight: ×4)
      const avg = Number(candidate.avgRating) || 0;
      if (avg > 0) score += (avg - 3.5) * 4;
      score += themeBonus(candidate.themes, idx.fiveStarThemes);
      score += ratingsCountBonus(candidate.ratingsCount);
    }

    if (profile.medianPages && candidate.pages) {
      const delta = Math.abs(candidate.pages - profile.medianPages);
      if (delta <= 50)       score += 6;
      else if (delta <= 100) score += 3;
      else if (delta >= 220) score -= 4;
    }

    // Option C: recency bonus for fiction
    score += recencyBonus(candidate.year, true);
  }

  if (timesShown === 1)      score -= 10;
  else if (timesShown === 2) score -= 25;
  else if (timesShown >= 3)  score -= 50;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function matchScoreNonfiction(candidate, idx, profile, timesShown) {
  let score = 55;

  if (candidate.fromToRead) {
    score += 10;
    const authorKey = normAuthor(candidate.author);
    score += Math.min(AUTHOR_CONTRIB_CAP,     (idx.fiveStarAuthors.get(authorKey) || 0) * 6);
    score += Math.min(AUTHOR_CONTRIB_CAP / 2, (idx.authorRatingWeight.get(authorKey)  || 0) * 1.5);
    for (const a of candidate.similarToAuthors || []) {
      const simKey = normAuthor(a);
      const contrib = (idx.fiveStarAuthors.get(simKey) || 0) * 4
                    + (idx.authorRatingWeight.get(simKey) || 0) * 0.5;
      score += Math.min(AUTHOR_CONTRIB_CAP, contrib);
    }
    for (const t of candidate.similarToTitles || []) {
      if (idx.fiveStarTitles.has(t)) score += 8;
    }
    score += Math.min(12, (idx.reverseSimilar.get(candidate.title) || 0) * 6);
    score += themeBonus(candidate.themes, idx.fiveStarThemes);
    score += ratingsCountBonus(candidate.ratingsCount);
    const avg = Number(candidate.avgRating) || 0;
    if (avg > 0) score += (avg - 3.5) * 10;
    if (profile.medianPages && candidate.pages) {
      const delta = Math.abs(candidate.pages - profile.medianPages);
      if (delta <= 50)       score += 6;
      else if (delta <= 100) score += 3;
      else if (delta >= 220) score -= 4;
    }
  } else {
    const bbe = isBBEBook(candidate);
    if (bbe) {
      // Direct author lookup for BBE
      const authorKey = normAuthor(candidate.author);
      const contrib = (idx.fiveStarAuthors.get(authorKey) || 0) * 4
                    + (idx.authorRatingWeight.get(authorKey)   || 0) * 0.5;
      score += Math.min(AUTHOR_CONTRIB_CAP, contrib);
      // Option A: community rating (nonfiction weight: ×8 — rating matters more here)
      const avg = Number(candidate.avgRating) || 0;
      if (avg > 0) score += (avg - 3.5) * 8;
      // ratingsCount is the strongest non-author signal for nonfiction BBE
      score += ratingsCountBonus(candidate.ratingsCount);
      // BBE themes are corrupted — skip theme matching
    } else {
      for (const a of candidate.similarToAuthors || []) {
        const authorKey = normAuthor(a);
        const contrib = (idx.fiveStarAuthors.get(authorKey) || 0) * 4
                      + (idx.authorRatingWeight.get(authorKey)   || 0) * 0.5;
        score += Math.min(AUTHOR_CONTRIB_CAP, contrib);
      }
      for (const t of candidate.similarToTitles || []) {
        if (idx.fiveStarTitles.has(t)) score += 8;
      }
      // Option A: community rating (nonfiction weight: ×8)
      const avg = Number(candidate.avgRating) || 0;
      if (avg > 0) score += (avg - 3.5) * 8;
      score += themeBonus(candidate.themes, idx.fiveStarThemes);
      score += ratingsCountBonus(candidate.ratingsCount);
    }

    // Option C: recency bonus for nonfiction (stronger)
    score += recencyBonus(candidate.year, false);
  }

  if (timesShown === 1)      score -= 10;
  else if (timesShown === 2) score -= 25;
  else if (timesShown >= 3)  score -= 50;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function matchScore(candidate, idx, profile, timesShown) {
  const type = String(candidate.type || '').toLowerCase();
  if (type === 'nonfiction' || type === 'non-fiction') {
    return matchScoreNonfiction(candidate, idx, profile, timesShown);
  }
  return matchScoreFiction(candidate, idx, profile, timesShown);
}

function confidenceScore(candidate, idx) {
  const authorKey = normAuthor(candidate.author);
  if (candidate.fromToRead) {
    let score = 55;
    if (idx.fiveStarAuthors.has(authorKey))    score += 20;
    else if ((idx.authorRatingWeight.get(authorKey) || 0) > 0) score += 10;
    if (candidate.pages) score += 4;
    if ((candidate.similarToTitles || []).length >= 2)  score += 8;
    if ((candidate.themes || []).length >= 2)            score += 4;
    return Math.max(0, Math.min(100, Math.round(score)));
  }
  if (isBBEBook(candidate)) {
    // BBE: confidence based on ratingsCount and direct author match
    let score = 50;
    if (idx.fiveStarAuthors.has(authorKey))    score += 20;
    else if ((idx.authorRatingWeight.get(authorKey) || 0) > 0) score += 10;
    const n = Number(candidate.ratingsCount) || 0;
    if (n > 100000)     score += 10;
    else if (n > 50000) score += 7;
    else if (n > 20000) score += 4;
    else if (n > 5000)  score += 2;
    if (candidate.pages) score += 3;
    return Math.max(0, Math.min(100, Math.round(score)));
  }
  let score = 58;
  if ((candidate.similarToAuthors || []).length >= 2) score += 8;
  if ((candidate.similarToTitles  || []).length >= 2) score += 8;
  if (candidate.pages)                                score += 4;
  if ((candidate.themes || []).length >= 2)           score += 4;
  const overlap = (candidate.similarToAuthors || []).reduce(
    (sum, a) => sum + (idx.fiveStarAuthors.get(normAuthor(a)) || 0), 0
  );
  score += Math.min(15, overlap * 2);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function reason(candidate, idx) {
  const authorKey = normAuthor(candidate.author);
  if (candidate.fromToRead) {
    const fiveCount = idx.fiveStarAuthors.get(authorKey) || 0;
    const readCount = idx.allReadAuthors.get(authorKey)   || 0;
    if (fiveCount > 0)
      return `On your to-read list — you've given ${candidate.author} five stars before (${fiveCount} time${fiveCount > 1 ? 's' : ''}).`;
    if (readCount > 0)
      return `On your to-read list — you've read ${readCount} other book${readCount > 1 ? 's' : ''} by ${candidate.author}.`;
    return `On your to-read list — sounds like it could be your next great read.`;
  }
  if (isBBEBook(candidate)) {
    const fiveCount = idx.fiveStarAuthors.get(authorKey) || 0;
    const readCount = idx.allReadAuthors.get(authorKey)   || 0;
    const parts = [];
    if (fiveCount > 0) parts.push(`you've given ${candidate.author} five stars before`);
    else if (readCount > 0) parts.push(`you've read ${candidate.author} before`);
    const n = Number(candidate.ratingsCount) || 0;
    if (n > 100000) parts.push(`highly rated by ${(n / 1000).toFixed(0)}k readers`);
    else if (n > 20000) parts.push(`well-regarded with ${(n / 1000).toFixed(0)}k ratings`);
    return parts.length
      ? `Best Books Ever pick — ${parts.join('; ')}.`
      : `Best Books Ever pick with a strong community rating.`;
  }
  const authorMatches = (candidate.similarToAuthors || []).filter(a => idx.fiveStarAuthors.has(normAuthor(a)));
  const titleMatches  = (candidate.similarToTitles  || []).filter(t => idx.fiveStarTitles.has(t));
  const parts = [];
  if (authorMatches.length) parts.push(`matches your strong results with ${authorMatches.slice(0, 2).join(' and ')}`);
  if (titleMatches.length)  parts.push(`lines up with ${titleMatches.slice(0, 2).join(' and ')}`);
  if ((candidate.themes || []).length) parts.push(`fits your ${(candidate.themes || []).slice(0, 2).join(' / ')} preferences`);
  return parts.length
    ? `Recommended because it ${parts.join('; ')}.`
    : 'Recommended because it aligns with your overall reading profile.';
}

// Score a list of books without exclusion filtering (used for currently-reading)
export function scoreBooks(candidates, goodreads, feedback, history) {
  const idx     = buildIndexes(goodreads, feedback);
  const profile = summarize(goodreads);
  const showMap = new Map((history.history || []).map(h => [h.bookKey, h.timesShown || 0]));
  return candidates.map(c => {
    const k      = c.bookKey || bookKey(c.title, c.author);
    const asCand = { ...c, fromToRead: true, similarToAuthors: [], similarToTitles: [], themes: [] };
    return {
      ...c,
      bookKey:         k,
      matchScore:      matchScore(asCand, idx, profile, showMap.get(k) || 0),
      confidenceScore: confidenceScore(asCand, idx),
      reason:          reason(asCand, idx)
    };
  });
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
