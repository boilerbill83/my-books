// Bill's Trakt Dashboard — reads trakt/data/dashboard.json, a compact
// summary built from a full Trakt account-data-export zip by
// scripts/build_trakt_dashboard.js. This page has no write path of its
// own; refreshing the data means re-running that script against a fresh
// export and pushing the regenerated JSON. See CLAUDE.md's "Trakt
// Dashboard" section for the update workflow.
//
// Also renders BMTRE's two headline outcomes (Session 45): a live top-5
// recommendations preview and a Metadata & Engine Quality score — both
// computed client-side from library/watchlist/enrichedMetadata.json via
// trakt/engine.js, the same way trakt/recommend.js does for the full list.

import { rankAll, getCreator, matchScore, hydrateTitle } from './engine.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtNum = n => (n ?? 0).toLocaleString('en-US');

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// ── Stat tiles ───────────────────────────────────────────────────────────

function renderStatTiles(summary) {
  const tiles = [
    ['Movies watched', fmtNum(summary.moviesWatched)],
    ['Shows watched', fmtNum(summary.showsWatched)],
    ['Episodes watched', fmtNum(summary.episodesWatched)],
    ['Hours watched', fmtNum(summary.totalHours)],
    ['Total ratings', fmtNum(summary.totalRatings)],
    ['Average rating', summary.avgRating != null ? `${summary.avgRating} / 10` : '—'],
  ];
  document.getElementById('statTiles').innerHTML = tiles.map(([label, value]) => `
    <div class="tk-tile">
      <div class="tk-tile-label">${esc(label)}</div>
      <div class="tk-tile-value">${esc(value)}</div>
    </div>
  `).join('');
}

// ── Horizontal bar chart (genres) ───────────────────────────────────────

function renderHBarChart(containerId, data, { labelKey, valueKey, barHeight = 20, maxScale, fmtValue = fmtNum, tooltipSuffix = '' }) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!data.length) { container.innerHTML = '<div class="tk-empty">No data.</div>'; return; }

  const width = 700;
  const gap = 6;
  const rowH = barHeight + gap;
  const height = data.length * rowH + 10;
  const marginLeft = 170, marginRight = 60;
  const plotW = width - marginLeft - marginRight;
  const maxVal = maxScale ?? Math.max(1, ...data.map(d => d[valueKey]));

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, style: 'display:block' });

  const tooltip = document.createElement('div');
  tooltip.className = 'tk-tooltip';
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.appendChild(svg);
  wrap.appendChild(tooltip);
  container.appendChild(wrap);

  data.forEach((d, i) => {
    const y = i * rowH + 5;
    const barW = Math.max((d[valueKey] / maxVal) * plotW, 2);

    const label = svgEl('text', {
      x: marginLeft - 8, y: y + barHeight / 2 + 4, class: 'tk-axis-label', 'text-anchor': 'end',
    });
    label.textContent = d[labelKey].length > 26 ? d[labelKey].slice(0, 25) + '…' : d[labelKey];
    svg.appendChild(label);

    const rect = svgEl('rect', {
      x: marginLeft, y, width: barW, height: barHeight, rx: 4, ry: 4, class: 'tk-bar',
    });
    svg.appendChild(rect);

    const valueLabel = svgEl('text', {
      x: marginLeft + barW + 6, y: y + barHeight / 2 + 4, class: 'tk-value-label',
    });
    valueLabel.textContent = fmtValue(d[valueKey]);
    svg.appendChild(valueLabel);

    rect.addEventListener('pointerenter', () => {
      tooltip.textContent = `${d[labelKey]}: ${fmtValue(d[valueKey])}${tooltipSuffix}`;
      tooltip.classList.add('active');
      tooltip.style.left = `${((marginLeft + barW / 2) / width) * 100}%`;
      tooltip.style.top = `${(y / height) * 100}%`;
    });
    rect.addEventListener('pointerleave', () => tooltip.classList.remove('active'));
  });
}

// ── Genre / creator / cast / crowd-comparison metrics ───────────────────
// All scoped to the enriched subset only (currently a fraction of the full
// library — see the scope note rendered above these sections) since TMDB
// enrichment runs incrementally, not all-at-once.

const LOVED_THRESHOLD = 9;

function computeGenreStats(library, enrichedMeta) {
  const stats = new Map();
  for (const t of library.titles || []) {
    if (t.myRating == null) continue;
    const meta = enrichedMeta[t.titleKey];
    if (!meta?.genres) continue;
    for (const g of meta.genres) {
      if (!stats.has(g)) stats.set(g, { sum: 0, count: 0 });
      const e = stats.get(g);
      e.sum += t.myRating; e.count++;
    }
  }
  return [...stats.entries()]
    .map(([genre, e]) => ({ genre, avg: e.sum / e.count, count: e.count }))
    .filter(g => g.count >= 3)
    .sort((a, b) => b.avg - a.avg);
}

function computeCreatorStats(library, enrichedMeta) {
  const stats = new Map();
  for (const t of library.titles || []) {
    if (t.myRating == null) continue;
    const meta = enrichedMeta[t.titleKey];
    if (!meta) continue;
    const creator = t.type === 'movie' ? meta.director : (meta.createdBy && meta.createdBy[0]);
    if (!creator) continue;
    if (!stats.has(creator)) stats.set(creator, { sum: 0, count: 0 });
    const e = stats.get(creator);
    e.sum += t.myRating; e.count++;
  }
  return [...stats.entries()]
    .map(([creator, e]) => ({ creator, avg: e.sum / e.count, count: e.count }))
    .filter(c => c.count >= 2)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 12);
}

function computeCastStats(library, enrichedMeta) {
  const counts = new Map();
  for (const t of library.titles || []) {
    const meta = enrichedMeta[t.titleKey];
    if (!meta?.topCast) continue;
    for (const actor of meta.topCast) counts.set(actor, (counts.get(actor) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([actor, count]) => ({ actor, count }))
    .filter(a => a.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

function computeCrowdCompare(library, enrichedMeta) {
  let sumMine = 0, sumTmdb = 0, n = 0;
  for (const t of library.titles || []) {
    if (t.myRating == null) continue;
    const meta = enrichedMeta[t.titleKey];
    if (meta?.voteAverage == null) continue;
    sumMine += t.myRating; sumTmdb += meta.voteAverage; n++;
  }
  if (!n) return null;
  return { n, mineAvg: sumMine / n, tmdbAvg: sumTmdb / n, diff: (sumMine - sumTmdb) / n };
}

function computeFranchiseStats(library, enrichedMeta) {
  const stats = new Map();
  for (const t of library.titles || []) {
    const meta = enrichedMeta[t.titleKey];
    if (!meta?.belongsToCollection) continue;
    const name = meta.belongsToCollection.name;
    if (!stats.has(name)) stats.set(name, { count: 0, sum: 0, ratedCount: 0 });
    const e = stats.get(name);
    e.count++;
    if (t.myRating != null) { e.sum += t.myRating; e.ratedCount++; }
  }
  return [...stats.entries()]
    .map(([name, e]) => ({ name, count: e.count, avg: e.ratedCount ? e.sum / e.ratedCount : null }))
    .filter(f => f.count >= 2)
    .sort((a, b) => b.count - a.count);
}

function renderGenreChart(stats) {
  renderHBarChart('genreChart',
    stats.map(g => ({ genre: `${g.genre} (${g.count})`, avg: g.avg })),
    { labelKey: 'genre', valueKey: 'avg', maxScale: 10, fmtValue: v => v.toFixed(1), tooltipSuffix: '/10 avg' });
}

function renderCreatorList(stats) {
  const el = document.getElementById('creatorList');
  if (!stats.length) { el.innerHTML = '<div class="tk-empty">Not enough enriched, rated titles yet.</div>'; return; }
  el.innerHTML = stats.map(c => `
    <div class="tk-metric-row">
      <span class="tk-metric-name">${esc(c.creator)} <span class="tk-metric-sub">(${c.count} title${c.count > 1 ? 's' : ''})</span></span>
      <span class="tk-metric-score">${c.avg.toFixed(1)}/10</span>
    </div>
  `).join('');
}

function renderCastList(stats) {
  const el = document.getElementById('castList');
  if (!stats.length) { el.innerHTML = '<div class="tk-empty">Not enough enriched titles yet.</div>'; return; }
  el.innerHTML = stats.map(a => `
    <div class="tk-metric-row">
      <span class="tk-metric-name">${esc(a.actor)}</span>
      <span class="tk-metric-score">${a.count} title${a.count > 1 ? 's' : ''}</span>
    </div>
  `).join('');
}

function renderCrowdCompare(compare) {
  const el = document.getElementById('crowdCompare');
  if (!compare) { el.innerHTML = '<div class="tk-empty">Not enough enriched, rated titles yet.</div>'; return; }
  const dir = compare.diff > 0 ? 'higher than' : compare.diff < 0 ? 'lower than' : 'the same as';
  el.innerHTML = `
    <div class="tk-crowd-stat">
      <div class="tk-crowd-number">${compare.diff > 0 ? '+' : ''}${compare.diff.toFixed(2)}</div>
      <div class="tk-crowd-label">You rate ${Math.abs(compare.diff).toFixed(2)} points ${dir} TMDB on average</div>
      <div class="tk-crowd-detail">Your avg ${compare.mineAvg.toFixed(2)}/10 vs. TMDB's ${compare.tmdbAvg.toFixed(2)}/10, across ${compare.n} rated titles.</div>
    </div>`;
}

function renderFranchiseList(stats) {
  const card = document.getElementById('franchiseCard');
  if (!stats.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  document.getElementById('franchiseList').innerHTML = stats.map(f => `
    <div class="tk-metric-row">
      <span class="tk-metric-name">${esc(f.name)} <span class="tk-metric-sub">(${f.count} watched)</span></span>
      <span class="tk-metric-score">${f.avg != null ? f.avg.toFixed(1) + '/10' : '—'}</span>
    </div>
  `).join('');
}

// ── All-titles filterable/sortable table ────────────────────────────────

// Predicted Score reuses the same matchScore() the recommendation panels
// score against (0-100, "how much BMTRE thinks this fits your taste") —
// computed here for every row, including already-watched titles, so it
// doubles as an honesty check against My Rating, the same role You vs.
// The Crowd plays for TMDB's rating.
function buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, idx) {
  const rows = [];
  const addRow = (t, status, myRating) => {
    const h = hydrateTitle(t, enrichedMeta);
    const meta = enrichedMeta[h.titleKey];
    rows.push({
      title: h.title || '(untitled — not yet enriched)', year: h.year, type: h.type, status,
      myRating: myRating ?? null, tmdbRating: meta?.voteAverage ?? null,
      predictedScore: Math.round(matchScore(h, idx, enrichedMeta)),
      genres: meta?.genres?.join(', ') || '', creator: (h.type === 'movie' ? meta?.director : meta?.createdBy?.[0]) || '',
    });
  };
  for (const t of library.titles || []) addRow(t, 'Watched', t.myRating);
  for (const t of watchlist.titles || []) addRow(t, 'Watchlist', null);
  for (const t of candidatePool.titles || []) addRow(t, 'Candidate', null);
  return rows;
}

function tableToCSV(table) {
  const csvCell = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const headerCells = [...table.querySelectorAll('thead th')].map(th => csvCell(th.textContent.replace(/[▾▴]/g, '').trim()));
  const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
    [...tr.children].map(td => csvCell(td.textContent.trim())).join(','));
  return [headerCells.join(','), ...rows].join('\r\n');
}

function downloadCSV(table, filename) {
  const csv = tableToCSV(table);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const TOP_N_DEFAULT = 20;

function renderAllTitlesTable(allRows) {
  const table = document.getElementById('allTitlesTable');
  const searchInput = document.getElementById('titleSearch');
  const typeFilter = document.getElementById('titleTypeFilter');
  const yearFilter = document.getElementById('titleYearFilter');
  const showAllBtn = document.getElementById('titleShowAllBtn');

  const years = [...new Set(allRows.map(r => r.year).filter(Boolean))].sort((a, b) => b - a);
  yearFilter.innerHTML = '<option value="">All Years</option>' +
    years.map(y => `<option value="${y}">${y}</option>`).join('');

  const columns = [
    { label: 'Title', get: r => r.title },
    { label: 'Year', get: r => r.year ?? '', numeric: true },
    { label: 'Type', get: r => r.type === 'movie' ? 'Movie' : 'Show' },
    { label: 'Status', get: r => r.status },
    { label: 'My Rating', get: r => r.myRating ?? '', numeric: true },
    { label: 'Predicted Score', get: r => r.predictedScore ?? '', numeric: true },
    { label: 'TMDB Rating', get: r => r.tmdbRating != null ? Math.round(r.tmdbRating * 10) / 10 : '', numeric: true },
    { label: 'Genres', get: r => r.genres, render: (td, r) => { td.className = 'tk-genres'; td.textContent = r.genres || '—'; } },
    { label: 'Director/Creator', get: r => r.creator || '—' },
  ];

  let sortCol = 4, sortAsc = false; // default: My Rating desc
  let showAll = false;

  function filtered() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const type = typeFilter.value;
    const year = yearFilter.value;
    return allRows.filter(r => {
      if (type && r.type !== type) return false;
      if (year && String(r.year) !== year) return false;
      if (q && !(r.title.toLowerCase().includes(q) || r.genres.toLowerCase().includes(q) || r.creator.toLowerCase().includes(q))) return false;
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
    document.getElementById('allTitlesCount').textContent = fmtNum(rows.length);
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
      th.addEventListener('click', () => {
        if (sortCol === i) sortAsc = !sortAsc; else { sortCol = i; sortAsc = false; }
        render();
      });
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
        // textContent already escapes safely on assignment — esc() is for
        // building innerHTML strings (the rec-card templates above), and
        // wrapping it around a textContent assignment double-processes
        // entities instead of escaping anything: a title like "Chappelle's
        // Show" rendered as the literal text "Chappelle&#39;s Show".
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
  yearFilter.addEventListener('change', render);
  showAllBtn.addEventListener('click', () => { showAll = !showAll; render(); });
  document.getElementById('titleCsvBtn').addEventListener('click', () => downloadCSV(table, 'trakt-all-titles.csv'));
}

// ── Recommendations preview ─────────────────────────────────────────────

// One line of real metadata under the title: genres, director/creator,
// TMDB community rating — whatever's actually present, since candidate
// stubs may still be mid-enrichment.
function metaLine(candidate, enrichedMeta) {
  const meta = enrichedMeta[candidate.titleKey];
  if (!meta) return 'Not enriched yet.';
  const parts = [];
  if (meta.genres?.length) parts.push(meta.genres.slice(0, 2).join(', '));
  const creator = getCreator(candidate.type, meta);
  if (creator) parts.push(candidate.type === 'movie' ? `dir. ${creator}` : `by ${creator}`);
  if (meta.voteAverage != null) parts.push(`${meta.voteAverage.toFixed(1)}/10 on TMDB`);
  return parts.join(' · ') || 'No genre/creator data yet.';
}

// 4 top-ranked watchlist titles + 4 top-ranked candidate-pool titles for
// one type (movie or show) — each card shows real metadata, the engine's
// predicted score, and its plain-English reason, per Bill's request.
function renderRecPanel(sectionId, watchlistItems, candidateItems, enrichedMeta) {
  const el = document.getElementById(sectionId);
  const picks = [...watchlistItems.slice(0, 4), ...candidateItems.slice(0, 4)]
    .sort((a, b) => (b.bmtreScore - a.bmtreScore) || (b.confidenceScore - a.confidenceScore));
  if (!picks.length) {
    el.innerHTML = '<div class="tk-empty">Not enough enriched data yet.</div>';
    return;
  }
  el.innerHTML = picks.map((c, i) => `
    <div class="tk-rec-card">
      <div class="tk-rec-rank">${i + 1}</div>
      <div class="tk-rec-body">
        <div class="tk-rec-title">
          ${esc(c.title)}${c.year ? ` <span class="tk-year">(${esc(c.year)})</span>` : ''}
          <span class="tk-rec-badge">${c.origin === 'watchlist' ? 'Watchlist' : 'New pick'}</span>
        </div>
        <div class="tk-rec-meta">${esc(metaLine(c, enrichedMeta))}</div>
        <div class="tk-rec-reason">${esc(c.reason)}</div>
      </div>
      <div class="tk-rec-score">${Math.round(c.bmtreScore)}</div>
    </div>
  `).join('');
}

// ── Metadata & Engine Quality score ─────────────────────────────────────
// Not a general data-completeness score — specifically "does BMTRE have
// what it needs to make a good prediction." Two components track whether
// the engine's actual signal sources (the watchlist it recommends from,
// and the loved titles its indexes are built from) have real content
// data; the other two track whether that data is any good once present.

function scoreTier(score) {
  if (score >= 90) return { color: 'var(--status-good)', label: 'Excellent' };
  if (score >= 75) return { color: '#b8860b', label: 'Good' }; // darker gold — warning color fails text contrast
  if (score >= 60) return { color: 'var(--status-serious)', label: 'Fair' };
  return { color: 'var(--status-critical)', label: 'Poor' };
}

function computeMetadataQuality(library, watchlist, enrichedMeta, selected) {
  const watchlistTitles = watchlist.titles || [];
  const watchlistEnriched = watchlistTitles.filter(t => enrichedMeta[t.titleKey]);
  const watchlistPct = watchlistTitles.length ? (watchlistEnriched.length / watchlistTitles.length) * 100 : 0;

  const lovedTitles = (library.titles || []).filter(t => t.myRating >= 9);
  const lovedEnriched = lovedTitles.filter(t => enrichedMeta[t.titleKey]);
  const lovedPct = lovedTitles.length ? (lovedEnriched.length / lovedTitles.length) * 100 : 0;

  const enrichedEntries = Object.values(enrichedMeta);
  const completeEntries = enrichedEntries.filter(m =>
    m.genres?.length && m.overview && (m.director || (m.createdBy && m.createdBy.length)));
  const fieldPct = enrichedEntries.length ? (completeEntries.length / enrichedEntries.length) * 100 : 0;

  const avgConfidence = selected.length
    ? selected.reduce((sum, c) => sum + c.confidenceScore, 0) / selected.length
    : 0;

  const components = [
    { key: 'watchlist', label: 'Watchlist enrichment coverage', weight: 0.35, subscore: watchlistPct },
    { key: 'loved', label: 'Loved-title signal coverage', weight: 0.35, subscore: lovedPct },
    { key: 'fields', label: 'Field completeness (of enriched titles)', weight: 0.15, subscore: fieldPct },
    { key: 'confidence', label: 'Average recommendation confidence', weight: 0.15, subscore: avgConfidence },
  ];
  const score = Math.round(components.reduce((s, c) => s + c.weight * c.subscore, 0));
  return { score, components, watchlistEnrichedCount: watchlistEnriched.length, watchlistTotal: watchlistTitles.length,
    lovedEnrichedCount: lovedEnriched.length, lovedTotal: lovedTitles.length };
}

function renderQualityDial(sectionId, { score, components }) {
  const section = document.getElementById(sectionId);
  section.innerHTML = '';
  const tier = scoreTier(score);
  const size = 180, stroke = 16, r = (size - stroke) / 2, cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const filled = (score / 100) * circumference;

  const dialWrap = document.createElement('div');
  dialWrap.className = 'tk-dial-wrap';

  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: '100%', height: '100%' });
  svg.style.transform = 'rotate(-90deg)';

  const track = svgEl('circle', { cx, cy, r, fill: 'none', stroke: 'var(--bg-subtle)', 'stroke-width': stroke });
  svg.appendChild(track);
  const fill = svgEl('circle', {
    cx, cy, r, fill: 'none', stroke: tier.color, 'stroke-width': stroke, 'stroke-linecap': 'round',
    'stroke-dasharray': `${filled} ${circumference}`,
  });
  svg.appendChild(fill);

  const center = document.createElement('div');
  center.className = 'tk-dial-center';
  center.innerHTML = `<div class="tk-dial-number" style="color:${tier.color}">${score}</div>` +
    `<div class="tk-dial-label">${esc(tier.label)} · out of 100</div>`;

  dialWrap.appendChild(svg);
  dialWrap.appendChild(center);

  const componentsWrap = document.createElement('div');
  componentsWrap.className = 'tk-components';
  componentsWrap.innerHTML = components.map(c => {
    const cTier = scoreTier(c.subscore);
    return `
      <div>
        <div class="tk-component-head">
          <span>${esc(c.label)} <span style="color:var(--text-muted)">(${(c.weight * 100).toFixed(0)}% weight)</span></span>
          <strong>${c.subscore.toFixed(1)}/100</strong>
        </div>
        <div class="tk-meter-track">
          <div class="tk-meter-fill" style="width:${Math.max(0, Math.min(100, c.subscore))}%; background:${cTier.color}"></div>
        </div>
      </div>`;
  }).join('');

  section.appendChild(dialWrap);
  section.appendChild(componentsWrap);
}

// ── Load + render ─────────────────────────────────────────────────────────

async function load() {
  const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });

  const [d, library, watchlist, candidatePool, enrichedMeta, feedback] = await Promise.all([
    get('./data/dashboard.json'),
    get('./data/library.json').catch(() => ({ titles: [] })),
    get('./data/watchlist.json').catch(() => ({ titles: [] })),
    get('./data/candidatePool.json').catch(() => ({ titles: [] })),
    get('./data/enrichedMetadata.json').catch(() => ({})),
    get('./data/feedbackData.json').catch(() => ({ interactions: [] })),
  ]);

  const { idx, fromWatchlist, fromCandidates } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback);
  const enrichedOnly = c => !!enrichedMeta[c.titleKey];
  const byType = (list, type) => list.filter(c => c.type === type && enrichedOnly(c));

  renderRecPanel('movieRecList', byType(fromWatchlist, 'movie'), byType(fromCandidates, 'movie'), enrichedMeta);
  renderRecPanel('showRecList', byType(fromWatchlist, 'show'), byType(fromCandidates, 'show'), enrichedMeta);

  const quality = computeMetadataQuality(library, watchlist, enrichedMeta, fromWatchlist);
  renderQualityDial('qualitySection', quality);
  document.getElementById('qualityFootnote').textContent =
    `${quality.watchlistEnrichedCount}/${quality.watchlistTotal} watchlist titles enriched, ` +
    `${quality.lovedEnrichedCount}/${quality.lovedTotal} loved titles (9-10 rated) enriched. ` +
    (quality.watchlistEnrichedCount === 0
      ? 'No TMDB data yet — the daily enrichment workflow hasn\'t populated enrichedMetadata.json.'
      : 'Scores rise automatically as more titles get enriched — no manual recalibration needed.');

  const generated = new Date(d.generatedAt);
  document.getElementById('subtitleText').textContent =
    `Last refreshed ${generated.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} ` +
    `· from a Trakt data export · @${d.profile?.username || 'unknown'}`;
  document.getElementById('statusText').textContent = 'Loaded from export';

  renderStatTiles(d.summary);

  const enrichedCount = Object.keys(enrichedMeta).length;
  document.getElementById('genreSectionScopeNote').textContent =
    `Based on the ${fmtNum(enrichedCount)} titles enriched with TMDB data so far (of ${fmtNum((library.titles?.length || 0) + (watchlist.titles?.length || 0))} total) — ` +
    `these sections fill in automatically as the daily enrichment job covers more of your library.`;

  renderGenreChart(computeGenreStats(library, enrichedMeta));
  renderCreatorList(computeCreatorStats(library, enrichedMeta));
  renderCastList(computeCastStats(library, enrichedMeta));
  renderCrowdCompare(computeCrowdCompare(library, enrichedMeta));
  renderFranchiseList(computeFranchiseStats(library, enrichedMeta));

  renderAllTitlesTable(buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, idx));
}

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load dashboard data — see console.';
  document.getElementById('subtitleText').textContent = 'No export loaded yet.';
  console.error(err);
});
