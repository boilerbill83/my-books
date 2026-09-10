// Similar To… — pairwise title-similarity score. Bill's own request: "I
// tell you a movie you present a similarity score for every candidate."
// Deliberately separate from the real recommendation engine — every other
// page answers "how well does this match Bill's WHOLE loved profile";
// this one answers "how similar is this to THIS ONE specific title," via
// engine.js's similarityScore(), which is never called from matchScore()/
// buildIndexes()'s own internals or from scripts/eval.js. See that
// function's own header comment in engine.js for the full signal/weight
// table and rationale.

import {
  buildIndexes, hydrateTitle, similarityScore, posterUrl,
} from './engine.js';
import {
  esc, fmtNum, posterImgHtml, typeIcon, typeLabel, titleLink, statusTag,
  metaLine, downloadCSV, initCollapsibleCards, loadAllData,
} from './dashboardShared.js';

const TOP_N_DEFAULT = 50;

// Every enriched title across library/watchlist/candidatePool, deduped by
// titleKey (the same three-source union buildAllTitlesRows() in discover.js
// uses) — anything without real TMDB metadata can't be scored at all.
function buildTitleIndex(library, watchlist, candidatePool, enrichedMeta) {
  const byKey = new Map();
  const add = (t, status, myRating) => {
    if (!t.titleKey || !enrichedMeta[t.titleKey] || byKey.has(t.titleKey)) return;
    const h = hydrateTitle(t, enrichedMeta);
    byKey.set(t.titleKey, { titleKey: h.titleKey, title: h.title, year: h.year, type: h.type, status, myRating: myRating ?? null });
  };
  for (const t of library.titles || []) add(t, 'Watched', t.myRating);
  for (const t of watchlist.titles || []) add(t, 'Watchlist', null);
  for (const t of candidatePool.titles || []) add(t, 'Candidate', null);
  return [...byKey.values()];
}

function initPicker(titleIndex, onSelect) {
  const input = document.getElementById('refSearch');
  const box = document.getElementById('refSuggestions');

  function renderSuggestions(q) {
    const query = q.trim().toLowerCase();
    if (query.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
    const matches = titleIndex
      .filter(t => t.title && t.title.toLowerCase().includes(query))
      .sort((a, b) => (a.title.toLowerCase().indexOf(query)) - (b.title.toLowerCase().indexOf(query)) || a.title.localeCompare(b.title))
      .slice(0, 12);
    if (!matches.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = matches.map(t => `
      <div class="tk-picker-row" data-key="${esc(t.titleKey)}" role="option" tabindex="0">
        <span>${typeIcon(t.type)}</span>
        <span class="tk-picker-title">${esc(t.title)}</span>
        <span class="tk-picker-year">${t.year || ''}</span>
      </div>
    `).join('');
    box.hidden = false;
  }

  input.addEventListener('input', () => renderSuggestions(input.value));
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) renderSuggestions(input.value); });
  document.addEventListener('click', (e) => {
    if (!box.contains(e.target) && e.target !== input) box.hidden = true;
  });
  box.addEventListener('click', (e) => {
    const row = e.target.closest('.tk-picker-row');
    if (!row) return;
    const t = titleIndex.find(x => x.titleKey === row.dataset.key);
    if (!t) return;
    input.value = `${t.title}${t.year ? ` (${t.year})` : ''}`;
    box.hidden = true;
    onSelect(t.titleKey);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.tk-picker-row');
    if (!row) return;
    e.preventDefault();
    row.click();
  });
}

function renderReferenceHeader(refKey, enrichedMeta, omdbMeta, llmTags, reviewedTags) {
  const el = document.getElementById('refHeader');
  const meta = enrichedMeta[refKey];
  if (!meta) { el.innerHTML = ''; return; }
  const candidate = { titleKey: refKey, type: refKey.split(':')[0], title: meta.title, year: meta.year };
  el.innerHTML = `
    <div class="tk-ref-card">
      ${posterImgHtml(posterUrl(refKey, enrichedMeta), 'tk-ref-poster', 90, 135)}
      <div class="tk-ref-body">
        <div class="tk-ref-title">${typeIcon(candidate.type)} ${esc(meta.title || '(untitled)')} <span class="tk-ref-year">${meta.year || ''}</span></div>
        <div class="tk-ref-meta">${esc(metaLine(candidate, enrichedMeta, omdbMeta, llmTags, reviewedTags))}</div>
      </div>
    </div>
  `;
}

// Top 2 positive-scoring signals, joined into one readable sentence — same
// "explain the score" convention as engine.js's own reason(). breakdown is
// similarityScore()'s .rows (already {key,label,points,note} shaped).
function summarizeReasons(rows) {
  const top = rows.filter(r => r.points > 0).sort((a, b) => b.points - a.points).slice(0, 2);
  if (!top.length) return 'No real similarity signal found.';
  return top.map(r => r.note).join(' ');
}

function computeResultsRows(refKey, titleIndex, enrichedMeta, idx) {
  return titleIndex
    .filter(t => t.titleKey !== refKey)
    .map(t => {
      const result = similarityScore(refKey, t.titleKey, enrichedMeta, idx);
      return {
        titleKey: t.titleKey, title: t.title || '(untitled)', year: t.year, type: t.type, status: t.status,
        myRating: t.myRating, score: result.clamped, reason: summarizeReasons(result.rows),
      };
    });
}

function renderResultsTable(allRows, enrichedMeta) {
  const card = document.getElementById('resultsCard');
  card.hidden = false;
  const table = document.getElementById('resultsTable');
  const searchInput = document.getElementById('resultsSearch');
  const typeFilter = document.getElementById('resultsTypeFilter');
  const statusFilter = document.getElementById('resultsStatusFilter');
  const includeWatchedCheck = document.getElementById('includeWatchedCheck');
  const showAllBtn = document.getElementById('resultsShowAllBtn');

  const columns = [
    { label: 'Cover', get: () => '', sortable: false,
      render: (td, r) => { td.innerHTML = posterImgHtml(posterUrl(r.titleKey, enrichedMeta), 'tk-table-poster', 40, 60); } },
    { label: 'Title', get: r => r.title,
      render: (td, r) => { td.innerHTML = titleLink(r); } },
    { label: 'Year', get: r => r.year ?? '', numeric: true },
    { label: 'Type', get: r => typeLabel(r.type),
      render: (td, r) => { td.textContent = `${typeIcon(r.type)} ${typeLabel(r.type)}`; } },
    { label: 'Status', get: r => r.status,
      render: (td, r) => { td.innerHTML = statusTag(r.status); } },
    { label: 'Similarity', get: r => r.score, numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.score; } },
    { label: 'Why', get: r => r.reason, render: (td, r) => { td.className = 'tk-genres'; td.textContent = r.reason; } },
  ];

  let sortCol = 5, sortAsc = false; // default: Similarity desc
  let showAll = false;

  function filtered() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const type = typeFilter.value;
    const status = statusFilter.value;
    return allRows.filter(r => {
      if (!includeWatchedCheck.checked && r.status === 'Watched') return false;
      if (type && r.type !== type) return false;
      if (status && r.status !== status) return false;
      if (q && !(r.title.toLowerCase().includes(q) || r.reason.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function render() {
    const rows = filtered();
    const sorted = [...rows].sort((a, b) => {
      const va = columns[sortCol].get(a), vb = columns[sortCol].get(b);
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortAsc ? cmp : -cmp;
    });
    document.getElementById('resultsCount').textContent = fmtNum(rows.length);
    showAllBtn.textContent = showAll ? `Show top ${TOP_N_DEFAULT}` : `Show all ${fmtNum(rows.length)}`;
    showAllBtn.classList.toggle('active', showAll);

    const display = showAll ? sorted : sorted.slice(0, TOP_N_DEFAULT);

    table.innerHTML = '';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    columns.forEach((c, i) => {
      const th = document.createElement('th');
      th.textContent = c.label;
      if (i === sortCol) th.className = 'sorted' + (sortAsc ? ' asc' : '');
      if (c.sortable !== false) {
        th.addEventListener('click', () => {
          if (sortCol === i) sortAsc = !sortAsc; else { sortCol = i; sortAsc = false; }
          render();
        });
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    if (!display.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length; td.className = 'tk-empty'; td.textContent = 'No matches.';
      tr.appendChild(td); tbody.appendChild(tr);
    }
    for (const row of display) {
      const tr = document.createElement('tr');
      columns.forEach(c => {
        const td = document.createElement('td');
        if (c.numeric) td.className = 'num';
        if (c.render) c.render(td, row); else td.textContent = c.get(row);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  render();
  searchInput.addEventListener('input', render);
  typeFilter.addEventListener('change', render);
  statusFilter.addEventListener('change', render);
  includeWatchedCheck.addEventListener('change', render);
  showAllBtn.addEventListener('click', () => { showAll = !showAll; render(); });
  document.getElementById('resultsCsvBtn').addEventListener('click', () => downloadCSV(table, 'trakt-similar-titles.csv'));
}

async function load() {
  const { library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, llmTags, reviewedTags } = await loadAllData();

  const idx = buildIndexes(library, enrichedMeta, feedback, llmTags, reviewedTags);
  const titleIndex = buildTitleIndex(library, watchlist, candidatePool, enrichedMeta);

  document.getElementById('statusText').textContent = `${fmtNum(titleIndex.length)} titles ready to compare`;

  function selectReference(refKey) {
    renderReferenceHeader(refKey, enrichedMeta, omdbMeta, llmTags, reviewedTags);
    const rows = computeResultsRows(refKey, titleIndex, enrichedMeta, idx);
    renderResultsTable(rows, enrichedMeta);
    const url = new URL(location.href);
    url.searchParams.set('key', refKey);
    history.replaceState(null, '', url);
  }

  initPicker(titleIndex, selectReference);

  const preselect = new URLSearchParams(location.search).get('key');
  if (preselect && enrichedMeta[preselect]) {
    const t = titleIndex.find(x => x.titleKey === preselect);
    if (t) document.getElementById('refSearch').value = `${t.title}${t.year ? ` (${t.year})` : ''}`;
    selectReference(preselect);
  }
}

initCollapsibleCards();

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load data — see console.';
  console.error(err);
});
