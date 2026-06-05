
import { rankRecommendations, scoreBooks } from './engine.js';

const state = {
  goodreads:    null,
  feedback:     null,
  history:      null,
  candidates:   null,
  ranking:      null,
  pending:      null,
  page:         0,
  activeThemes: new Set()
};

// DOM refs
const statusDot           = document.getElementById('statusDot');
const statusText          = document.getElementById('statusText');
const analyticsTiles      = document.getElementById('analyticsTiles');
const ratingDonut         = document.getElementById('ratingDonut');
const insightsList        = document.getElementById('insightsList');
const onThisDay           = document.getElementById('onThisDay');
const bookshelfBar        = document.getElementById('bookshelfBar');
const recommendationsGrid = document.getElementById('recommendationsGrid');
const refreshButton       = document.getElementById('refreshButton');
const dismissDialog            = document.getElementById('dismissDialog');
const dismissBookLabel         = document.getElementById('dismissBookLabel');
const dismissForm              = document.getElementById('dismissForm');
const currentlyReadingGrid     = document.getElementById('currentlyReadingGrid');
const filterToRead             = document.getElementById('filterToRead');
const filterOnlineFinds        = document.getElementById('filterOnlineFinds');
const filterFiction            = document.getElementById('filterFiction');
const filterNonfiction         = document.getElementById('filterNonfiction');
const poolCountEl              = document.getElementById('poolCount');
const themeFilterBar           = document.getElementById('themeFilterBar');

const THEME_MACROS = [
  { label: 'Legal',      keys: ['legal', 'courtroom', 'attorney', 'lawyer'] },
  { label: 'Thriller',   keys: ['thriller', 'suspense'] },
  { label: 'Mystery',    keys: ['mystery', 'detective', 'whodunit', 'cold case'] },
  { label: 'Sci-Fi',     keys: ['speculative', 'sci-fi', 'dystopia', 'time travel', 'time-slip'] },
  { label: 'Historical', keys: ['historical', 'wwii', 'history', 'multigenerational', 'antebellum'] },
  { label: 'True Crime', keys: ['true crime', 'serial killer', 'investigative journalism'] },
  { label: 'Finance',    keys: ['finance', 'wall street', 'crypto', 'hedge', 'investing', 'junk bond', 'lbo'] },
  { label: 'Literary',   keys: ['literary'] },
  { label: 'Survival',   keys: ['survival', 'expedition', 'adventure'] },
  { label: 'Funny',      keys: ['funny', 'humor', 'comedy'] },
];

function bookMatchesMacro(book, macro) {
  const themes = (book.themes || []).map(t => String(t).toLowerCase());
  return macro.keys.some(k => themes.some(t => t.includes(k)));
}

function renderThemeChips(books) {
  if (!themeFilterBar) return;
  const available = THEME_MACROS.filter(m => books.some(b => bookMatchesMacro(b, m)));
  if (!available.length) { themeFilterBar.innerHTML = ''; return; }

  const hasActive = state.activeThemes.size > 0;
  const clearBtn  = hasActive
    ? `<button class="theme-clear-btn" id="themeClearBtn">Clear</button>` : '';

  themeFilterBar.innerHTML =
    `<span class="theme-filter-label">Genre</span>` +
    available.map(m => {
      const active = state.activeThemes.has(m.label) ? ' active' : '';
      return `<button class="theme-filter-chip${active}" data-label="${esc(m.label)}">${esc(m.label)}</button>`;
    }).join('') +
    clearBtn;

  themeFilterBar.querySelectorAll('.theme-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.label;
      if (state.activeThemes.has(label)) state.activeThemes.delete(label);
      else                               state.activeThemes.add(label);
      state.page = 0;
      recompute();
    });
  });

  document.getElementById('themeClearBtn')?.addEventListener('click', () => {
    state.activeThemes.clear();
    state.page = 0;
    recompute();
  });
}

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
    '#1e3a5f','#3c2415','#3b2314','#1f3d3c',
    '#4a2040','#163d2f','#2a1f4f','#3d2f1a'
  ];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
  return palette[h % palette.length];
}

function starsHtml(rating, max = 5) {
  const n = Math.round(Number(rating) || 0);
  if (!n) return '';
  return `<span class="stars-gold">${'★'.repeat(Math.min(n, max))}${'☆'.repeat(Math.max(0, max - n))}</span>`;
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
  // Prefer explicit coverUrl, then ISBN-based OL lookup, then async Google Books
  const staticUrl = book.coverUrl
    || (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : null);

  if (staticUrl) {
    return `<div class="book-cover" style="background:${color}">
      <img src="${esc(staticUrl)}" alt="${esc(book.title)} cover"
           data-title="${esc(book.title)}" data-author="${esc(book.author)}"
           data-color="${color}" class="cover-img" loading="lazy" />
    </div>`;
  }
  // No static cover — render placeholder and tag for async lookup
  return `<div class="book-cover" data-lookup="1"
       data-bookkey="${esc(book.bookKey || book.title)}"
       data-title="${esc(book.title)}" data-author="${esc(book.author)}"
       data-color="${esc(color)}">
    ${makePlaceholder(book.title, book.author, color)}
  </div>`;
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

// ── Open Library cover lookup ──────────────────────────────────────────────

const coverCache = new Map();

async function fetchOLCover(bookKey, title, author) {
  if (coverCache.has(bookKey)) return coverCache.get(bookKey);
  try {
    const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&printType=books`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    let url = data.items?.[0]?.volumeInfo?.imageLinks?.thumbnail ?? null;
    if (url) url = url.replace('http://', 'https://').replace('zoom=1', 'zoom=2');
    coverCache.set(bookKey, url);
    return url;
  } catch {
    coverCache.set(bookKey, null);
    return null;
  }
}

async function enhanceCovers() {
  const wraps = Array.from(document.querySelectorAll('.book-cover[data-lookup]'));
  await Promise.all(wraps.map(async wrap => {
    const { bookkey, title, author, color } = wrap.dataset;
    const url = await fetchOLCover(bookkey, title, author);
    if (!url || !wrap.isConnected) return;
    wrap.innerHTML = `<img src="${esc(url)}" alt="${esc(title)} cover"
      data-title="${esc(title)}" data-author="${esc(author)}"
      data-color="${esc(color)}" class="cover-img" loading="lazy" />`;
    const img = wrap.querySelector('img');
    if (img) {
      img.addEventListener('load', () => {
        if (img.naturalWidth <= 1) wrap.innerHTML = makePlaceholder(title, author, color);
      });
      img.addEventListener('error', () => {
        wrap.innerHTML = makePlaceholder(title, author, color);
      });
    }
  }));
}

// ── Currently Reading ──────────────────────────────────────────────────────

const GOODREADS_RSS = 'https://www.goodreads.com/review/list_rss/37243238?shelf=currently-reading';

function parseGoodreadsRSS(xmlText) {
  const doc   = new DOMParser().parseFromString(xmlText, 'application/xml');
  const items = Array.from(doc.getElementsByTagName('item'));
  return items.map(item => {
    const text    = tag => item.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
    const rawTitle = text('title');
    const author   = text('author_name');
    const title    = rawTitle.replace(/ by .+$/, '').trim() || rawTitle;
    const coverUrl = text('book_large_image_url');
    const isbn     = text('isbn');
    const avgRating = text('average_rating');
    const yearRaw  = text('book_published');
    const bookEl   = item.getElementsByTagName('book')[0];
    const pagesRaw = bookEl ? bookEl.getElementsByTagName('num_pages')[0]?.textContent?.trim() : '';
    return {
      title,
      author,
      coverUrl:   coverUrl || null,
      isbn:       isbn || null,
      avgRating:  avgRating ? Number(avgRating) : null,
      year:       yearRaw ? parseInt(yearRaw) : null,
      pages:      pagesRaw ? parseInt(pagesRaw) : null,
      shelf:      'currently-reading'
    };
  }).filter(b => b.title && b.author);
}

async function fetchCurrentlyReading() {
  // rss2json parses Goodreads RSS server-side and returns JSON — no domain registration needed
  try {
    const url  = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(GOODREADS_RSS)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(resp.statusText);
    const data = await resp.json();
    if (data.status !== 'ok' || !data.items?.length) throw new Error('empty');
    const books = data.items.map(item => {
      const rawTitle = item.title || '';
      const title    = rawTitle.replace(/ by .+$/, '').trim() || rawTitle;
      return {
        title,
        author:    item.author || '',
        coverUrl:  item.thumbnail || null,
        isbn:      null,
        avgRating: null,
        year:      null,
        pages:     null,
        shelf:     'currently-reading'
      };
    }).filter(b => b.title && b.author);
    if (books.length) return books;
  } catch (_) { /* fall through */ }
  // Fallback: allorigins (worked previously, may require domain registration now)
  try {
    const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(GOODREADS_RSS)}`;
    const resp  = await fetch(proxy, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(resp.statusText);
    const data  = await resp.json();
    const books = parseGoodreadsRSS(data.contents || '');
    if (books.length) return books;
  } catch (_) { /* fall through */ }
  return (state.goodreads.books || []).filter(b => b.shelf === 'currently-reading');
}

function renderCurrentlyReading(books) {
  if (!currentlyReadingGrid) return;
  if (!books.length) { currentlyReadingGrid.innerHTML = ''; return; }
  const scored = scoreBooks(books, state.goodreads, state.feedback, state.history);

  currentlyReadingGrid.innerHTML = scored.map(book => {
    const color    = hashColor(book.bookKey || book.title);
    const coverSrc = book.coverUrl
      || ((book.isbn13 || book.isbn) ? `https://covers.openlibrary.org/b/isbn/${book.isbn13 || book.isbn}-M.jpg` : '');
    const coverEl  = coverSrc
      ? `<img src="${esc(coverSrc)}" alt="${esc(book.title)} cover" class="cr-cover-img" loading="lazy"
             onerror="this.style.display='none';this.parentElement.querySelector('.cr-cover-fallback').style.display=''" />`
      : '';

    const meta = [];
    if (book.year)  meta.push(`📅 ${book.year}`);
    if (book.pages) meta.push(`📄 ${book.pages} pp`);
    if (Number(book.avgRating) > 0) meta.push(`⭐ ${Number(book.avgRating).toFixed(1)}`);

    return `
      <div class="cr-card card">
        <div class="cr-cover-wrap" style="background:${color}">${coverEl}<span class="cr-cover-fallback" style="font-size:1.8rem${coverEl ? ';display:none' : ''}">📖</span></div>
        <div class="cr-info">
          <div class="cr-eyebrow">Currently Reading</div>
          <div class="cr-title">${esc(book.title)}</div>
          <div class="cr-author">by ${esc(book.author)}</div>
          ${meta.length ? `<div class="cr-meta">${meta.join(' &nbsp;·&nbsp; ')}</div>` : ''}
          <div class="cr-scores">
            <span class="score-pill" title="Likelihood you'll enjoy this">Match ${book.matchScore}</span>
            <span class="score-pill" title="Prediction confidence">Conf ${book.confidenceScore}</span>
          </div>
          <p class="cr-reason">${book.reason}</p>
          ${breakdownHtml(book.breakdown)}
        </div>
      </div>`;
  }).join('');
}

// ── Analytics tiles ────────────────────────────────────────────────────────

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

// ── Rating donut chart (visual appeal #5) ─────────────────────────────────

function renderDonut() {
  if (!ratingDonut) return;
  const readBooks = (state.goodreads.books || [])
    .filter(b => b.shelf === 'read' && b.myRating > 0);
  const counts = [0, 0, 0, 0, 0];
  for (const b of readBooks) {
    const r = b.myRating;
    if (r >= 1 && r <= 5) counts[r - 1]++;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) { ratingDonut.hidden = true; return; }

  const colors  = ['#94a3b8', '#60a5fa', '#34d399', '#fbbf24', '#c9911e'];
  const R = 36, cx = 50, cy = 50, C = 2 * Math.PI * R;

  let cum = 0;
  const segs = counts.map((count, i) => {
    if (!count) { cum += count / total; return ''; }
    const pct = count / total;
    const d   = pct * C;
    const off = C * (0.25 - cum);
    cum += pct;
    return `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none"
      stroke="${colors[i]}" stroke-width="13"
      stroke-dasharray="${d.toFixed(2)} ${(C - d).toFixed(2)}"
      stroke-dashoffset="${off.toFixed(2)}" />`;
  }).join('');

  const fivePct = Math.round(counts[4] / total * 100);

  const legendRows = counts.map((c, i) => c ? `
    <div class="legend-row">
      <span class="legend-dot" style="background:${colors[i]}"></span>
      <span class="legend-stars">${'★'.repeat(i + 1)}</span>
      <span class="legend-count">${c}</span>
      <span class="legend-pct">${Math.round(c / total * 100)}%</span>
    </div>` : '').filter(Boolean).join('');

  ratingDonut.innerHTML = `
    <div class="donut-label">Your rating breakdown</div>
    <div class="donut-inner">
      <svg viewBox="0 0 100 100" width="90" height="90">
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#f4ede0" stroke-width="13" />
        ${segs}
        <text x="${cx}" y="46" text-anchor="middle" font-family="'Playfair Display',serif"
              font-size="13" font-weight="bold" fill="#2c1a0e">${fivePct}%</text>
        <text x="${cx}" y="57" text-anchor="middle" font-size="7" fill="#8b6f5a">5-star</text>
      </svg>
      <div class="donut-legend">${legendRows}</div>
    </div>`;
}

// ── Insights (randomised) ──────────────────────────────────────────────────

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

// ── On This Day spotlight (usefulness #2) ─────────────────────────────────

function renderOnThisDay() {
  if (!onThisDay) return;
  const today = new Date();
  const mm    = String(today.getMonth() + 1).padStart(2, '0');
  const dd    = String(today.getDate()).padStart(2, '0');
  const suffix      = `/${mm}/${dd}`;
  const thisYear    = String(today.getFullYear());
  const monthLabel  = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const matches = (state.goodreads.books || []).filter(b =>
    b.shelf === 'read' && b.dateRead &&
    b.dateRead.endsWith(suffix) &&
    !b.dateRead.startsWith(thisYear)
  );

  if (!matches.length) { onThisDay.hidden = true; return; }

  const book     = matches[Math.floor(Math.random() * matches.length)];
  const year     = parseInt(book.dateRead.slice(0, 4));
  const yearsAgo = today.getFullYear() - year;
  const color    = hashColor(book.bookKey || book.title);
  const isbn     = book.isbn13 || book.isbn;
  const coverUrl = isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : '';

  onThisDay.hidden   = false;
  onThisDay.innerHTML = `
    <div class="otd-card card">
      <div class="otd-header">
        <span class="otd-icon">📅</span>
        <div>
          <div class="otd-eyebrow">On This Day — ${monthLabel}</div>
          <div class="otd-sub">${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago you finished:</div>
        </div>
      </div>
      <div class="otd-body">
        <div class="otd-cover" style="background:${color}">
          ${coverUrl ? `<img src="${esc(coverUrl)}" alt="" onerror="this.style.display='none'" />` : ''}
          <span class="otd-book-icon">📖</span>
        </div>
        <div class="otd-info">
          <div class="otd-title">${esc(book.title)}</div>
          <div class="otd-author">by ${esc(book.author)}</div>
          ${book.myRating ? `<div class="otd-stars">${starsHtml(book.myRating)}</div>` : ''}
          <div class="otd-meta">
            ${book.year ? `${book.year}` : ''}${book.year && book.pages ? ' · ' : ''}${book.pages ? `${book.pages} pages` : ''}
          </div>
          ${matches.length > 1 ? `<div class="otd-more">+${matches.length - 1} more book${matches.length > 2 ? 's' : ''} finished on this date</div>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Bookshelf bar (visual appeal #2) ──────────────────────────────────────

function renderBookshelf() {
  if (!bookshelfBar) return;
  const books = (state.goodreads.books || [])
    .filter(b => b.shelf === 'read')
    .slice(0, 100);

  bookshelfBar.innerHTML = books.map((b, i) => {
    const color = hashColor(b.bookKey || b.title);
    const h     = 26 + (b.title.length * 3 + i * 7) % 26; // 26–52 px tall
    const w     = 11 + (b.author.length + i * 4) % 12;    // 11–23 px wide
    return `<div class="book-spine"
      style="height:${h}px;width:${w}px;background:${color}"
      title="${esc(b.title)} — ${esc(b.author)}"></div>`;
  }).join('');
}

function breakdownHtml(breakdown) {
  if (!breakdown || breakdown.length === 0) return '';
  const rows = breakdown.map(s => {
    const sign  = s.pts >= 0 ? '+' : '';
    const cls   = s.pts >= 0 ? 'bd-pos' : 'bd-neg';
    return `<li><span class="bd-pts ${cls}">${sign}${s.pts}</span><span class="bd-label">${esc(s.label)}</span></li>`;
  }).join('');
  return `<details class="score-breakdown">
    <summary class="bd-toggle">Why this score?</summary>
    <ul class="bd-list">${rows}</ul>
  </details>`;
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
    const typeBadge = book.type
      ? `<span class="type-tag ${book.type}">${book.type}</span>` : '';
    const goodreadsUrl = book.goodreadsUrl
      || `https://www.goodreads.com/search?q=${encodeURIComponent(book.title + ' ' + book.author)}`;

    // metadata chips
    const meta = [];
    if (book.year) meta.push(`<span class="meta-chip">📅 ${book.year}</span>`);
    if (book.pages) meta.push(`<span class="meta-chip">📄 ${book.pages} pp</span>`);
    if (Number(book.avgRating) > 0) {
      const n    = Number(book.avgRating);
      const full = Math.round(n);
      const stars = '★'.repeat(Math.min(full, 5)) + '☆'.repeat(Math.max(0, 5 - full));
      meta.push(`<span class="meta-chip"><span class="chip-stars">${stars}</span> ${n.toFixed(1)}</span>`);
    }
    if (book.publisher) meta.push(`<span class="meta-chip pub">${esc(book.publisher)}</span>`);
    const metaRow = meta.length ? `<div class="meta-row">${meta.join('')}</div>` : '';

    // themes
    const themes   = (book.themes || []).slice(0, 3);
    const themeRow = themes.length
      ? `<div class="theme-row">${themes.map(t => `<span class="theme-chip">${t}</span>`).join('')}</div>`
      : '';

    // similar-to
    const simAuthors = (book.similarToAuthors || []).slice(0, 2);
    const simRow     = simAuthors.length
      ? `<div class="sim-row"><span class="sim-label">Fans of:</span> ${simAuthors.map(a => `<span class="sim-name">${esc(a)}</span>`).join(', ')}</div>`
      : '';

    return `
      <article class="book-card">
        ${coverHtml(book)}
        <div class="card-body">
          <div class="card-meta">
            <span class="rank-badge">#${book.rank}</span>
            ${shelfBadge}
            ${typeBadge}
          </div>
          <div class="card-title">${esc(book.title)}</div>
          <div class="card-author">${esc(book.author)}</div>
          ${metaRow}
          ${themeRow}
          ${simRow}
          <div class="score-row">
            <span class="score-pill" title="Likelihood you'll enjoy this">Match ${book.matchScore}</span>
            <span class="score-pill" title="Prediction confidence">Conf ${book.confidenceScore}</span>
          </div>
          <p class="card-reason">${book.reason}</p>
          ${breakdownHtml(book.breakdown)}
          <div class="card-actions">
            <a class="link-button primary" href="${esc(goodreadsUrl)}" target="_blank" rel="noreferrer">Goodreads</a>
            <button class="danger-button" data-key="${esc(book.bookKey)}">Dismiss</button>
          </div>
        </div>
      </article>`;
  }).join('');

  attachCoverFallbacks();
  enhanceCovers();

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
  const external    = filterOnlineFinds?.checked !== false ? (state.candidates || []) : [];
  const toReadCands = filterToRead?.checked !== false
    ? (state.goodreads.books || [])
        .filter(b => b.shelf === 'to-read')
        .map(b => ({ ...b, fromToRead: true }))
    : [];

  const showFiction    = filterFiction?.checked !== false;
  const showNonfiction = filterNonfiction?.checked !== false;

  let allCands = [...external, ...toReadCands];
  if (!showFiction || !showNonfiction) {
    allCands = allCands.filter(b => {
      const t = String(b.type || '').toLowerCase();
      if ((t === 'nonfiction' || t === 'non-fiction') && !showNonfiction) return false;
      if (t === 'fiction' && !showFiction) return false;
      return true;
    });
  }

  // Build genre chips from the source/type-filtered pool, then apply theme filter
  renderThemeChips(allCands);
  if (state.activeThemes.size > 0) {
    const active = THEME_MACROS.filter(m => state.activeThemes.has(m.label));
    allCands = allCands.filter(b => active.some(m => bookMatchesMacro(b, m)));
  }

  if (poolCountEl) poolCountEl.textContent = `${allCands.length.toLocaleString()} in pool`;

  state.ranking = rankRecommendations(
    state.goodreads,
    state.feedback,
    allCands,
    state.history
  );

  renderAnalytics();
  renderDonut();
  renderInsights();
  renderOnThisDay();
  renderBookshelf();
  renderRecommendations();
}

async function load() {
  const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  const [goodreads, feedback, history, candIndex] = await Promise.all([
    get('./data/goodreadsData.json'),
    get('./data/feedbackData.json'),
    get('./data/recommendationHistory.json'),
    get('./data/candidateIndex.json').catch(() => ['candidatePool.json'])
  ]);
  state.goodreads = goodreads;
  state.feedback  = feedback;
  state.history   = history;

  const files  = Array.isArray(candIndex) ? candIndex : ['candidatePool.json'];
  const arrays = await Promise.all(
    files.map(f => get(`./data/${f}`).then(d => d.candidates || []).catch(() => []))
  );
  state.candidates = arrays.flat();
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
      bookKey: book.bookKey,
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

// Filter checkboxes reset page and theme selection, then recompute
[filterToRead, filterOnlineFinds, filterFiction, filterNonfiction].forEach(el => {
  el?.addEventListener('change', () => { state.activeThemes.clear(); state.page = 0; recompute(); });
});

// Animated refresh (visual appeal #1)
refreshButton.addEventListener('click', () => {
  recommendationsGrid.classList.add('fade-out');
  setTimeout(() => {
    state.page++;
    renderRecommendations();
    // force reflow so removing the class triggers the transition back in
    void recommendationsGrid.offsetHeight;
    recommendationsGrid.classList.remove('fade-out');
  }, 220);
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
  const crBooks = await fetchCurrentlyReading();
  recompute();
  renderCurrentlyReading(crBooks);
  const readCount = state.goodreads.meta?.readCount || 0;
  setStatus(
    `${readCount} books read · ${state.ranking.selected.length} recommendations available`,
    readCount > 0 ? 'online' : 'offline'
  );
}

initialize().catch(err => setStatus(`Failed to load: ${err.message}`));
