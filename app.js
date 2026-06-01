
import { fetchLocalJson, isWriteConfigured, safeUpdateRepoJson } from './storage.js';
import { parseCsv, transformGoodreadsRows } from './importer.js';
import { rankRecommendations } from './engine.js';

const state = {
  goodreads: null,
  feedback: null,
  history: null,
  candidates: null,
  ranking: null,
  pending: null,
  imported: null
};

// DOM refs — IDs match index.html exactly
const statusDot   = document.getElementById('statusDot');
const statusText  = document.getElementById('statusText');
const analyticsTiles       = document.getElementById('analyticsTiles');
const insightsList         = document.getElementById('insightsList');
const recommendationsGrid  = document.getElementById('recommendationsGrid');
const dismissDialog        = document.getElementById('dismissDialog');
const dismissBookLabel     = document.getElementById('dismissBookLabel');
const dismissForm          = document.getElementById('dismissForm');
const refreshButton        = document.getElementById('refreshButton');
const importButton         = document.getElementById('importButton');
const importPanel          = document.getElementById('importPanel');
const csvFileInput         = document.getElementById('csvFileInput');
const processCsvButton     = document.getElementById('processCsvButton');
const saveImportedDataButton = document.getElementById('saveImportedDataButton');
const importStatus         = document.getElementById('importStatus');
const settingsButton       = document.getElementById('settingsButton');
const settingsDialog       = document.getElementById('settingsDialog');

function setStatus(msg, mode = 'offline') {
  statusText.textContent = msg;
  statusDot.className = `status-dot ${mode}`;
}

function tile(label, value) {
  return `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${label}</div></div>`;
}

function renderAnalytics() {
  const p = state.ranking.profile;
  analyticsTiles.innerHTML = [
    tile('Books read',     p.booksRead),
    tile('5-star books',   p.fiveStarBooks),
    tile('Avg rating',     p.avgRating),
    tile('Top author',     p.favoriteAuthors[0]?.[0] || 'n/a'),
    tile('Median length',  p.medianPages ? `${p.medianPages} pp` : 'n/a'),
    tile('Recent year',    p.mostRecentReadYear || 'n/a')
  ].join('');

  const topAuthors = p.favoriteAuthors.slice(0, 3).map(([name]) => name).join(', ');
  const insights = [
    `Strongest repeat-author signal: <strong>${topAuthors || 'not enough data yet'}</strong>.`,
    `Eligible pool after exclusions: <strong>${state.ranking.eligibleCount} candidates</strong> (${state.ranking.fictionPool} fiction / ${state.ranking.nonfictionPool} nonfiction).`,
    `Write mode is <strong>${isWriteConfigured() ? 'enabled' : 'disabled'}</strong>; ${isWriteConfigured() ? 'dismissals will persist back to GitHub.' : 'dismissals are local until you configure storage.js.'}`
  ];
  insightsList.innerHTML = insights.map(x => `<li>${x}</li>`).join('');
}

function renderRecommendations() {
  if (!state.ranking.selected.length) {
    recommendationsGrid.innerHTML = `
      <div class="card empty empty-state">
        <h3>No eligible recommendations</h3>
        <p class="note">Import Goodreads data or expand the candidate pool.</p>
      </div>`;
    return;
  }

  recommendationsGrid.innerHTML = state.ranking.selected.map(book => {
    const typeClass = book.type === 'nonfiction' ? ' nonfiction' : '';
    const similarItems = [...(book.similarToTitles || []), ...(book.similarToAuthors || [])].slice(0, 3);
    return `
      <article class="card">
        <div class="card-top">
          <span class="rank-badge">#${book.rank}</span>
          <span class="type-badge${typeClass}">${book.type}</span>
        </div>
        <div>
          <h3>${book.title}</h3>
          <div class="author">${book.author}</div>
        </div>
        <div class="score-row">
          <div class="score-pill" title="Likelihood you will enjoy this book."><strong>Match</strong>: ${book.matchScore}</div>
          <div class="score-pill" title="How certain the app is about the prediction."><strong>Confidence</strong>: ${book.confidenceScore}</div>
        </div>
        <div>
          <span class="small-label">Why this fits</span>
          <p>${book.reason}</p>
        </div>
        ${similarItems.length ? `
        <div>
          <span class="small-label">Similar to</span>
          <ul class="similar-list">${similarItems.map(x => `<li>${x}</li>`).join('')}</ul>
        </div>` : ''}
        <div class="card-actions">
          <a class="link-button primary" href="${book.goodreadsUrl}" target="_blank" rel="noreferrer">View on Goodreads</a>
          <a class="link-button ghost" href="${book.buyUrl}" target="_blank" rel="noreferrer">Buy Book</a>
          <button class="danger-button" data-key="${book.bookKey}">Dismiss</button>
        </div>
      </article>`;
  }).join('');

  recommendationsGrid.querySelectorAll('.danger-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const book = state.ranking.selected.find(x => x.bookKey === btn.dataset.key);
      if (!book) return;
      state.pending = book;
      dismissBookLabel.textContent = `"${book.title}" — ${book.author}`;
      dismissDialog.showModal();
    });
  });
}

function recompute() {
  state.ranking = rankRecommendations(state.goodreads, state.feedback, state.candidates, state.history);
  renderAnalytics();
  renderRecommendations();
}

async function load() {
  const [goodreads, feedback, history, candidates] = await Promise.all([
    fetchLocalJson('./data/goodreadsData.json'),
    fetchLocalJson('./data/feedbackData.json'),
    fetchLocalJson('./data/recommendationHistory.json'),
    fetchLocalJson('./data/candidatePool.json')
  ]);
  state.goodreads  = goodreads;
  state.feedback   = feedback;
  state.history    = history;
  state.candidates = candidates.candidates || [];
}

async function dismiss(reasonCode) {
  if (!state.pending) return;
  const book = state.pending;
  const reasonLabelMap = {
    already_aware_not_interested: 'Already aware / not interested',
    wrong_genre_or_vibe:          'Wrong genre or vibe',
    too_similar:                  'Too similar to something I already read',
    not_in_the_mood:              'Not in the mood right now',
    author_or_topic_not_appealing:'Author or topic not appealing'
  };
  const interaction = {
    bookKey:   book.bookKey,
    title:     book.title,
    author:    book.author,
    interactionType: 'dismiss',
    reasonCode,
    reasonLabel: reasonLabelMap[reasonCode] || reasonCode,
    timestamp: new Date().toISOString(),
    timesShown:    1,
    timesDismissed:1,
    timesClicked:  0,
    timesSaved:    0,
    explicitHide:  false,
    excludeFromRecommendations: true,
    source: 'app_runtime'
  };

  state.feedback.interactions.push(interaction);

  let row = state.history.history.find(x => x.bookKey === book.bookKey);
  if (!row) {
    row = {
      bookKey: book.bookKey,
      firstShownDate: new Date().toISOString(),
      lastShownDate:  new Date().toISOString(),
      timesShown: 1, timesDismissed: 1, timesSaved: 0, timesClicked: 0
    };
    state.history.history.push(row);
  } else {
    row.timesDismissed = (row.timesDismissed || 0) + 1;
    row.lastShownDate  = new Date().toISOString();
  }

  if (isWriteConfigured()) {
    try {
      await safeUpdateRepoJson('data/feedbackData.json', content => {
        content.interactions = content.interactions || [];
        content.interactions.push(interaction);
        content.meta = content.meta || {};
        content.meta.lastUpdated = new Date().toISOString();
        return content;
      }, `Dismiss ${book.title}`);

      await safeUpdateRepoJson('data/recommendationHistory.json', content => {
        content.history = content.history || [];
        const existing = content.history.find(x => x.bookKey === book.bookKey);
        if (existing) {
          existing.timesDismissed = (existing.timesDismissed || 0) + 1;
          existing.lastShownDate  = new Date().toISOString();
        } else {
          content.history.push({
            bookKey: book.bookKey,
            firstShownDate: new Date().toISOString(),
            lastShownDate:  new Date().toISOString(),
            timesShown: 1, timesDismissed: 1, timesSaved: 0, timesClicked: 0
          });
        }
        content.meta = content.meta || {};
        content.meta.lastUpdated = new Date().toISOString();
        return content;
      }, `History ${book.title}`);

      setStatus(`Dismissed "${book.title}" and saved to GitHub.`, 'online');
    } catch (e) {
      setStatus(`Dismissed locally, but GitHub write failed: ${e.message}`);
    }
  } else {
    setStatus(`Dismissed "${book.title}" locally. Configure storage.js to persist to GitHub.`);
  }

  state.pending = null;
  recompute();
}

// ===== Event wiring =====

processCsvButton.addEventListener('click', async () => {
  const file = csvFileInput.files?.[0];
  if (!file) { importStatus.textContent = 'Choose a Goodreads CSV file first.'; return; }
  const rows = parseCsv(await file.text());
  state.goodreads = transformGoodreadsRows(rows);
  importStatus.textContent = `Processed ${state.goodreads.meta.bookCount} books from ${file.name}.`;
  recompute();
  setStatus(`Imported Goodreads CSV in-browser. ${isWriteConfigured() ? 'You can now save it back to the repo.' : 'Enable write mode in storage.js to save it back to GitHub.'}`);
});

saveImportedDataButton.addEventListener('click', async () => {
  if (!state.goodreads) return;
  if (!isWriteConfigured()) { setStatus('Write mode is disabled in storage.js.'); return; }
  try {
    await safeUpdateRepoJson('data/goodreadsData.json', () => state.goodreads, 'Import Goodreads JSON');
    setStatus('Saved Goodreads JSON back to the repo.', 'online');
  } catch (e) {
    setStatus(`Save failed: ${e.message}`);
  }
});

importButton.addEventListener('click', () => importPanel.classList.toggle('hidden'));

refreshButton.addEventListener('click', async () => { await initialize(true); });

dismissForm.addEventListener('submit', async e => {
  e.preventDefault();
  const data = new FormData(dismissForm);
  dismissDialog.close();
  await dismiss(data.get('dismissReason'));
});

settingsButton.addEventListener('click', () => settingsDialog.showModal());

// ===== Bootstrap =====

async function initialize(force = false) {
  setStatus('Loading…', 'loading');
  if (!state.goodreads || force) await load();
  recompute();
  const readCount = state.goodreads.meta?.readCount || 0;
  const feedbackCount = state.feedback.interactions?.length || 0;
  const candidateCount = state.candidates?.length || 0;
  setStatus(
    `Loaded ${readCount} read books · ${feedbackCount} feedback records · ${candidateCount} candidates`,
    readCount > 0 ? 'online' : 'offline'
  );
}

initialize().catch(error => setStatus(`Failed to load: ${error.message}`));
