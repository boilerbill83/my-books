// Bill's Movies — local-first tracker for watched-since-2015 + want-to-watch,
// meant to be periodically committed to data/moviesWatched.json /
// data/movieWatchlist.json. Trakt uploads are built by hand from this data
// (a CSV of id/type/watched_at/rating/rated_at) — no Trakt API calls, ever.
//
// Persistence pattern mirrors app.js's feedback handling: entries added in
// the browser live in localStorage until "Copy JSON" is used to paste the
// merged list into the committed data file, at which point they're pruned
// from localStorage on next load (matched by id).

const LOCAL_WATCHED_KEY   = 'mybooks_movies_watched_v1';
const LOCAL_WATCHLIST_KEY = 'mybooks_movies_watchlist_v1';

const state = {
  watched: [],
  watchlist: [],
  localWatched: { added: [], removedIds: [] },
  localWatchlist: { added: [], removedIds: [] },
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function loadLocal(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return { added: parsed?.added || [], removedIds: parsed?.removedIds || [] };
  } catch { return { added: [], removedIds: [] }; }
}

function saveLocal(key, local) {
  try { localStorage.setItem(key, JSON.stringify(local)); }
  catch { /* private browsing / storage full — additions last this session only */ }
}

function mergeCommittedAndLocal(committed, local) {
  const committedIds = new Set(committed.map(m => m.id));
  local.added = local.added.filter(m => !committedIds.has(m.id));
  local.removedIds = local.removedIds.filter(id => committed.some(m => m.id === id));
  return {
    merged: [
      ...committed.filter(m => !local.removedIds.includes(m.id)),
      ...local.added,
    ],
    local,
  };
}

async function load() {
  const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  const [watchedFile, watchlistFile] = await Promise.all([
    get('./data/moviesWatched.json').catch(() => ({ movies: [] })),
    get('./data/movieWatchlist.json').catch(() => ({ movies: [] })),
  ]);

  const localW  = loadLocal(LOCAL_WATCHED_KEY);
  const localWl = loadLocal(LOCAL_WATCHLIST_KEY);

  const w  = mergeCommittedAndLocal(watchedFile.movies || [], localW);
  const wl = mergeCommittedAndLocal(watchlistFile.movies || [], localWl);

  saveLocal(LOCAL_WATCHED_KEY, w.local);
  saveLocal(LOCAL_WATCHLIST_KEY, wl.local);

  state.watched   = w.merged;
  state.watchlist = wl.merged;
  state.localWatched   = w.local;
  state.localWatchlist = wl.local;
}

function addEntry(list, localKey, localState, entry) {
  localState.added.push(entry);
  saveLocal(localKey, localState);
  list.push(entry);
}

function removeEntry(list, localKey, localState, id) {
  const beforeLen = localState.added.length;
  localState.added = localState.added.filter(m => m.id !== id);
  if (localState.added.length === beforeLen && !localState.removedIds.includes(id)) {
    localState.removedIds.push(id);
  }
  saveLocal(localKey, localState);
  const idx = list.findIndex(m => m.id === id);
  if (idx !== -1) list.splice(idx, 1);
}

// ── Rendering ────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderWatched() {
  const q = (document.getElementById('watchedSearch').value || '').trim().toLowerCase();
  const rows = state.watched
    .filter(m => !q || m.title.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => (b.dateWatched || '').localeCompare(a.dateWatched || ''));

  document.getElementById('watchedCount').textContent = state.watched.length;
  document.getElementById('watchedTabCount').textContent = state.watched.length;

  const el = document.getElementById('watchedList');
  if (!rows.length) {
    el.innerHTML = `<div class="mv-empty">${state.watched.length ? 'No matches.' : "No movies logged yet — add one above."}</div>`;
    return;
  }

  el.innerHTML = rows.map(m => `
    <div class="mv-row" data-id="${esc(m.id)}">
      <div class="mv-row-info">
        <div class="mv-row-title">${esc(m.title)}${m.year ? ` <span class="mv-year">(${esc(m.year)})</span>` : ''}</div>
        <div class="mv-row-meta">
          ${m.dateWatched ? `Watched ${esc(fmtDate(m.dateWatched))}` : 'No date logged'}
          ${m.rating ? ` · <span class="mv-rating">${esc(m.rating)}/10</span>` : ''}
        </div>
      </div>
      ${m.traktSyncedAt
        ? '<span class="mv-badge synced">In Trakt export</span>'
        : '<span class="mv-badge">Not exported</span>'}
      <div class="mv-row-actions">
        <button class="mv-btn small danger" data-action="remove-watched" data-id="${esc(m.id)}">Remove</button>
      </div>
    </div>
  `).join('');
}

function renderWatchlist() {
  const q = (document.getElementById('watchlistSearch').value || '').trim().toLowerCase();
  const rows = state.watchlist
    .filter(m => !q || m.title.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));

  document.getElementById('watchlistCount').textContent = state.watchlist.length;
  document.getElementById('watchlistTabCount').textContent = state.watchlist.length;

  const el = document.getElementById('watchlistList');
  if (!rows.length) {
    el.innerHTML = `<div class="mv-empty">${state.watchlist.length ? 'No matches.' : 'Nothing on the list yet — add one above.'}</div>`;
    return;
  }

  el.innerHTML = rows.map(m => `
    <div class="mv-row" data-id="${esc(m.id)}">
      <div class="mv-row-info">
        <div class="mv-row-title">${esc(m.title)}${m.year ? ` <span class="mv-year">(${esc(m.year)})</span>` : ''}</div>
        ${m.notes ? `<div class="mv-row-meta">${esc(m.notes)}</div>` : ''}
      </div>
      ${m.traktSyncedAt
        ? '<span class="mv-badge synced">In Trakt export</span>'
        : '<span class="mv-badge">Not exported</span>'}
      <div class="mv-row-actions">
        <button class="mv-btn small primary" data-action="mark-watched" data-id="${esc(m.id)}">Mark watched</button>
        <button class="mv-btn small danger" data-action="remove-watchlist" data-id="${esc(m.id)}">Remove</button>
      </div>
    </div>
  `).join('');
}

// ── Events ───────────────────────────────────────────────────────────────

document.querySelectorAll('.mv-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mv-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mv-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`${btn.dataset.tab}Panel`).classList.add('active');
  });
});

document.getElementById('watchedForm').addEventListener('submit', e => {
  e.preventDefault();
  const title = document.getElementById('wTitle').value.trim();
  if (!title) return;
  const year = parseInt(document.getElementById('wYear').value, 10) || null;
  const dateWatched = document.getElementById('wDate').value || null;
  const rating = parseInt(document.getElementById('wRating').value, 10) || null;

  addEntry(state.watched, LOCAL_WATCHED_KEY, state.localWatched, {
    id: uid(), title, year, dateWatched, rating, notes: '',
    addedAt: new Date().toISOString(), traktIds: null, traktSyncedAt: null,
  });

  e.target.reset();
  renderWatched();
});

document.getElementById('watchlistForm').addEventListener('submit', e => {
  e.preventDefault();
  const title = document.getElementById('wlTitle').value.trim();
  if (!title) return;
  const year = parseInt(document.getElementById('wlYear').value, 10) || null;
  const notes = document.getElementById('wlNotes').value.trim();

  addEntry(state.watchlist, LOCAL_WATCHLIST_KEY, state.localWatchlist, {
    id: uid(), title, year, notes,
    addedAt: new Date().toISOString(), traktIds: null, traktSyncedAt: null,
  });

  e.target.reset();
  renderWatchlist();
});

document.getElementById('watchedList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action="remove-watched"]');
  if (!btn) return;
  removeEntry(state.watched, LOCAL_WATCHED_KEY, state.localWatched, btn.dataset.id);
  renderWatched();
});

document.getElementById('watchlistList').addEventListener('click', e => {
  const id = e.target.closest('button')?.dataset.id;
  if (!id) return;
  if (e.target.closest('button[data-action="remove-watchlist"]')) {
    removeEntry(state.watchlist, LOCAL_WATCHLIST_KEY, state.localWatchlist, id);
    renderWatchlist();
  } else if (e.target.closest('button[data-action="mark-watched"]')) {
    const item = state.watchlist.find(m => m.id === id);
    if (!item) return;
    removeEntry(state.watchlist, LOCAL_WATCHLIST_KEY, state.localWatchlist, id);
    addEntry(state.watched, LOCAL_WATCHED_KEY, state.localWatched, {
      id: uid(), title: item.title, year: item.year, dateWatched: new Date().toISOString().slice(0, 10),
      rating: null, notes: item.notes || '', addedAt: new Date().toISOString(),
      traktIds: null, traktSyncedAt: null,
    });
    renderWatchlist();
    renderWatched();
  }
});

document.getElementById('watchedSearch').addEventListener('input', renderWatched);
document.getElementById('watchlistSearch').addEventListener('input', renderWatchlist);

async function copyListJSON(list, btnId, fileName) {
  const sorted = list.slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const json = JSON.stringify({ movies: sorted }, null, 2);
  const btn = document.getElementById(btnId);
  try {
    await navigator.clipboard.writeText(json);
    btn.textContent = 'Copied!';
  } catch {
    // Clipboard API unavailable — fall back to a selectable prompt.
    window.prompt(`Copy the JSON below and paste into data/${fileName}:`, json);
  }
  setTimeout(() => { btn.textContent = 'Copy JSON'; }, 1800);
}

document.getElementById('copyWatchedBtn').addEventListener('click', () =>
  copyListJSON(state.watched, 'copyWatchedBtn', 'moviesWatched.json'));
document.getElementById('copyWatchlistBtn').addEventListener('click', () =>
  copyListJSON(state.watchlist, 'copyWatchlistBtn', 'movieWatchlist.json'));

// CSV export to Trakt's own item schema (id/type/watched_at/rating/rated_at)
// needs an IMDb id + release date per movie, which requires an external
// lookup — done server-side by scripts/export_trakt_csv.js, not here, so a
// Trakt API credential is never embedded in this public page's JS.

// Default the "date watched" field to today for convenience.
document.getElementById('wDate').value = new Date().toISOString().slice(0, 10);

load().then(() => {
  renderWatched();
  renderWatchlist();
}).catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load movie data — see console.';
  console.error(err);
});
