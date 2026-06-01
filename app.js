
import { rankRecommendations } from './engine.js';

const state = {
  goodreads:  null,
  feedback:   null,
  history:    null,
  candidates: null,
  ranking:    null,
  pending:    null,
  page:       0
};

// DOM refs
const statusDot           = document.getElementById('statusDot');
const statusText          = document.getElementById('statusText');
const analyticsTiles      = document.getElementById('analyticsTiles');
const insightsList        = document.getElementById('insightsList');
const recommendationsGrid = document.getElementById('recommendationsGrid');
const refreshButton       = document.getElementById('refreshButton');
const dismissDialog       = document.getElementById('dismissDialog');
const dismissBookLabel    = document.getElementById('dismissBookLabel');
const dismissForm         = document.getElementById('dismissForm');

// ── Utilities ──────────────────────────────────────────────────────────────

function setStatus(msg, mode = 'offline') {
  statusText.textContent = msg;
  statusDot.className    = `status-dot ${mode}`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hashColor(str) {
  const palette = [
    '#5c3317','#1a3a5c','#2c5f2e','#4a1c40',
    '#1c4a3e','#3d1a1a','#2d3561','#4a3728',
    '#1e3a5f','#3c2415','#3b2314','#1f3d3c'
  ];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
  return palette[h % palette.length];
}

function makePlaceholder(title, author, color) {
  return `<div class="cover-placeholder" style="background:${color}">
    <span class="cover-icon">📖</span>
    <span class="cover-title">${esc(title)}</span>
    <span class="cover-author">${esc(author)}</span>
  </div>`;
}

function coverHtml(book) {
  const color = hashColor(book.bookKey || book.title);
  const isbn  = book.isbn13 || book.isbn;
  if (isbn) {
    const url = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`;
    return `<div class="book-cover">
      <img src="${esc(url)}" alt="${esc(book.title)} cover"
           data-title="${esc(book.title)}" data-author="${esc(book.author)}"
           data-color="${color}" class="cover-img" loading="lazy" />
    </div>`;
  }
  return `<div class="book-cover">${makePlaceholder(book.title, book.author, color)}</div>`;
}

function attachCoverFallbacks() {
  document.querySelectorAll('img.cover-img').forEach(img => {
    img.addEventListener('load', () => {
      if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
        img.parentElement.innerHTML = makePlaceholder(
          img.dataset.title, img.dataset.author, img.dataset.color
        );
      }
    });
    img.addEventListener('error', () => {
      img.parentElement.innerHTML = makePlaceholder(
        img.dataset.title, img.dataset.author, img.dataset.color
      );
    });
  });
}

// ── Analytics ──────────────────────────────────────────────────────────────

function tile(label, value) {
  return `<div class="tile">
    <div class="tile-value">${value}</div>
    <div class="tile-label">${label}</div>
  </div>`;
}

function renderAnalytics() {
  const p = state.ranking.profile;
  analyticsTiles.innerHTML = [
    tile('Books read',    p.booksRead),
    tile('5-star books',  p.fiveStarBooks),
    tile('Avg rating',    p.avgRating),
    tile('Top author',    p.favoriteAuthors[0]?.[0] || 'n/a'),
    tile('Median length', p.medianPages ? `${p.medianPages} pp` : 'n/a'),
    tile('To read',       state.goodreads.meta?.toReadCount || 0)
  ].join('');
}

// ── Insights (randomised on every render) ─────────────────────────────────

function buildInsightPool() {
  const p    = state.ranking.profile;
  const g    = state.goodreads;
  const pool = [];

  pool.push(`You've read <strong>${p.booksRead}</strong> books total — impressive!`);
  pool.push(`Your to-read pile has <strong>${g.meta.toReadCount}</strong> books. You'll never be bored.`);
  pool.push(`You've given out <strong>${p.fiveStarBooks}</strong> five-star ratings.`);
  pool.push(`Your average Goodreads rating is <strong>${p.avgRating}</strong> out of 5.`);

  if (p.favoriteAuthors[0])
    pool.push(`Your most-read author: <strong>${esc(p.favoriteAuthors[0][0])}</strong> with ${p.favoriteAuthors[0][1]} books.`);
  if (p.favoriteAuthors[1])
    pool.push(`You've also read <strong>${p.favoriteAuthors[1][1]} books</strong> by ${esc(p.favoriteAuthors[1][0])}.`);
  if (p.favoriteAuthors[2])
    pool.push(`<strong>${esc(p.favoriteAuthors[2][0])}</strong> rounds out your top three most-read authors.`);
  if (p.medianPages)
    pool.push(`Your median book length is <strong>${p.medianPages} pages</strong>.`);
  if (p.mostRecentReadYear && p.mostRecentReadYear !== 'n/a')
    pool.push(`You were actively reading in <strong>${p.mostRecentReadYear}</strong>.`);
  if (p.booksRead > 0) {
    const pct = Math.round(p.fiveStarBooks / p.booksRead * 100);
    pool.push(`<strong>${pct}%</strong> of the books you've read earned a five-star rating from you.`);
  }

  // Random 5-star spotlights
  const fiveStars = (g.books || []).filter(b => b.myRating === 5 && b.shelf === 'read');
  if (fiveStars.length) {
    const pick = fiveStars[Math.floor(Math.random() * fiveStars.length)];
    pool.push(`A standout from your shelf: <em>${esc(pick.title)}</em> by ${esc(pick.author)} ⭐⭐⭐⭐⭐`);
  }
  if (fiveStars.length > 1) {
    const pick = fiveStars[Math.floor(Math.random() * fiveStars.length)];
    pool.push(`Also loved: <em>${esc(pick.title)}</em> by ${esc(pick.author)}.`);
  }

  return pool;
}

function renderInsights() {
  const pool = buildInsightPool();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  insightsList.innerHTML = pool.slice(0, 4).map(x => `<li>${x}</li>`).join('');
}

// ── Recommendations ────────────────────────────────────────────────────────

function renderRecommendations() {
  const all = state.ranking.selected;
  if (!all.length) {
    recommendationsGrid.innerHTML = `<div class="empty-state">No recommendations available yet.</div>`;
    return;
  }

  const pageSize = 4;
  const pages    = Math.ceil(all.length / pageSize);
  const start    = (state.page % pages) * pageSize;
  const slice    = all.slice(start, start + pageSize);

  recommendationsGrid.innerHTML = slice.map(book => {
    const shelfBadge = book.fromToRead
      ? `<span class="shelf-tag to-read">on your list</span>`
      : `<span class="shelf-tag">curated pick</span>`;
    const goodreadsUrl = book.goodreadsUrl
      || `https://www.goodreads.com/search?q=${encodeURIComponent(book.title + ' ' + book.author)}`;
    return `
      <article class="book-card">
        ${coverHtml(book)}
        <div class="card-body">
          <div class="card-meta">
            <span class="rank-badge">#${book.rank}</span>
            ${shelfBadge}
          </div>
          <div class="card-title">${esc(book.title)}</div>
          <div class="card-author">${esc(book.author)}</div>
          <div class="score-row">
            <span class="score-pill" title="Likelihood you'll enjoy this">Match ${book.matchScore}</span>
            <span class="score-pill" title="Prediction confidence">Conf ${book.confidenceScore}</span>
          </div>
          <p class="card-reason">${book.reason}</p>
          <div class="card-actions">
            <a class="link-button primary" href="${esc(goodreadsUrl)}" target="_blank" rel="noreferrer">View on Goodreads</a>
            <button class="danger-button" data-key="${esc(book.bookKey)}">Dismiss</button>
          </div>
        </div>
      </article>`;
  }).join('');

  attachCoverFallbacks();

  recommendationsGrid.querySelectorAll('.danger-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const book = all.find(x => x.bookKey === btn.dataset.key);
      if (!book) return;
      state.pending = book;
      dismissBookLabel.textContent = `"${book.title}" — ${book.author}`;
      dismissDialog.showModal();
    });
  });
}

// ── Data & Recompute ───────────────────────────────────────────────────────

function recompute() {
  const external    = state.candidates || [];
  const toReadCands = (state.goodreads.books || [])
    .filter(b => b.shelf === 'to-read')
    .map(b => ({ ...b, fromToRead: true, similarToAuthors: [], similarToTitles: [], themes: [] }));

  state.ranking = rankRecommendations(
    state.goodreads,
    state.feedback,
    [...external, ...toReadCands],
    state.history
  );
  renderAnalytics();
  renderInsights();
  renderRecommendations();
}

async function load() {
  const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  const [goodreads, feedback, history, candidates] = await Promise.all([
    get('./data/goodreadsData.json'),
    get('./data/feedbackData.json'),
    get('./data/recommendationHistory.json'),
    get('./data/candidatePool.json')
  ]);
  state.goodreads  = goodreads;
  state.feedback   = feedback;
  state.history    = history;
  state.candidates = candidates.candidates || [];
}

// ── Dismiss (local-only) ───────────────────────────────────────────────────

function dismiss(reasonCode) {
  if (!state.pending) return;
  const book = state.pending;

  state.feedback.interactions.push({
    bookKey:  book.bookKey,
    title:    book.title,
    author:   book.author,
    interactionType: 'dismiss',
    reasonCode,
    timestamp: new Date().toISOString(),
    excludeFromRecommendations: true
  });

  let row = state.history.history.find(x => x.bookKey === book.bookKey);
  if (!row) {
    state.history.history.push({
      bookKey:        book.bookKey,
      firstShownDate: new Date().toISOString(),
      lastShownDate:  new Date().toISOString(),
      timesShown: 1, timesDismissed: 1, timesSaved: 0, timesClicked: 0
    });
  } else {
    row.timesDismissed = (row.timesDismissed || 0) + 1;
    row.lastShownDate  = new Date().toISOString();
  }

  state.pending = null;
  recompute();
  setStatus(`Dismissed "${book.title}".`, 'online');
}

// ── Event wiring ───────────────────────────────────────────────────────────

refreshButton.addEventListener('click', () => {
  state.page++;
  renderRecommendations();
});

dismissForm.addEventListener('submit', e => {
  e.preventDefault();
  dismissDialog.close();
  dismiss(new FormData(dismissForm).get('dismissReason'));
});

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function initialize() {
  setStatus('Loading…', 'loading');
  await load();
  recompute();
  const readCount = state.goodreads.meta?.readCount || 0;
  setStatus(
    `${readCount} books read · ${state.ranking.selected.length} recommendations available`,
    readCount > 0 ? 'online' : 'offline'
  );
}

initialize().catch(err => setStatus(`Failed to load: ${err.message}`));
