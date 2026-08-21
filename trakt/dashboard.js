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

import { rankAll, getCreator, matchScore, hydrateTitle, popularityScore, audienceScore, awardsScore } from './engine.js';

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

// ── Predicted-score distribution (unwatched titles) ─────────────────────
// Movies and shows are kept as separate small multiples rather than one
// combined histogram — their real means differ enough (movies ~43,
// shows ~56, from a thinner loved-movie source pool per CLAUDE.md) that
// merging them would blur a real, worth-seeing difference, the same
// small-multiples-over-one-crowded-chart call the genre/year charts made.

function computeScoreDistribution(items) {
  const scores = items.map(c => c.bmtreScore);
  const n = scores.length;
  if (!n) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const BIN_WIDTH = 10, BIN_COUNT = 10; // scores are clipped 0-100
  const bins = Array.from({ length: BIN_COUNT }, (_, i) => ({ label: String(i * BIN_WIDTH), count: 0 }));
  for (const s of scores) bins[Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(s / BIN_WIDTH)))].count++;
  return { n, mean, median, sd, bins };
}

// A distribution whose mean and median sit close together (relative to
// its own spread) is symmetric, the property that actually matters for
// "does this look normal" — skewness in real units, not a formal
// normality test, but an honest, computed check rather than an assumed one.
function shapeNote(dist) {
  const skew = dist.sd ? (dist.mean - dist.median) / dist.sd : 0;
  if (Math.abs(skew) < 0.2) return 'Roughly bell-shaped — mean and median are close.';
  return skew > 0 ? 'Skewed toward lower scores (a long tail of weak matches).' : 'Skewed toward higher scores.';
}

function renderScoreHistogram(containerId, bins) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!bins.some(b => b.count > 0)) { container.innerHTML = '<div class="tk-empty">Not enough scored titles yet.</div>'; return; }

  const width = 340, height = 170;
  const marginLeft = 30, marginBottom = 22, marginTop = 8, marginRight = 8;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;
  const maxVal = Math.max(1, ...bins.map(b => b.count));

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, style: 'display:block' });

  [0, 0.5, 1].forEach(f => {
    const y = marginTop + plotH * (1 - f);
    svg.appendChild(svgEl('line', { x1: marginLeft, x2: width - marginRight, y1: y, y2: y, class: 'tk-gridline' }));
    const label = svgEl('text', { x: marginLeft - 6, y: y + 3, class: 'tk-axis-label', 'text-anchor': 'end' });
    label.textContent = fmtNum(Math.round(maxVal * f));
    svg.appendChild(label);
  });

  const tooltip = document.createElement('div');
  tooltip.className = 'tk-tooltip';
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.appendChild(svg);
  wrap.appendChild(tooltip);
  container.appendChild(wrap);

  const barSlot = plotW / bins.length;
  const barWidth = Math.min(28, barSlot - 4);

  bins.forEach((b, i) => {
    const x = marginLeft + i * barSlot + (barSlot - barWidth) / 2;
    const barH = plotH * (b.count / maxVal);
    const y = marginTop + plotH - barH;

    const rect = svgEl('rect', { x, y, width: barWidth, height: Math.max(barH, 0.5), rx: 3, ry: 3, class: 'tk-bar' });
    svg.appendChild(rect);

    const xlabel = svgEl('text', { x: x + barWidth / 2, y: height - marginBottom + 13, class: 'tk-axis-label', 'text-anchor': 'middle' });
    xlabel.textContent = b.label;
    svg.appendChild(xlabel);

    rect.addEventListener('pointerenter', () => {
      tooltip.textContent = `${b.label}-${Number(b.label) + 9}: ${fmtNum(b.count)} title${b.count === 1 ? '' : 's'}`;
      tooltip.classList.add('active');
      tooltip.style.left = `${((x + barWidth / 2) / width) * 100}%`;
      tooltip.style.top = `${(y / height) * 100}%`;
    });
    rect.addEventListener('pointerleave', () => tooltip.classList.remove('active'));
  });
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

// ── Field Population & Quality ───────────────────────────────────────────
// Mirrors the book project's FIELD_REGISTRY-driven data-quality report in
// spirit (per-field Percent Populated + a stricter Quality check, critical
// fields held to a higher bar), but computed live client-side from the
// already-fetched JSON rather than a separate scripts/data_quality_report.js
// + dated snapshot pipeline — this dashboard has always computed everything
// (recommendations, genre stats, crowd comparison) on page load from the
// committed data files, so a static one-off report would be a second,
// divergent architecture for no real benefit at this dataset's size.
// "Populated" = the field carries a real value. "Quality" is a stricter,
// same-field check for whether that value is actually useful to BMTRE (e.g.
// a genres array existing vs. having 2+ entries to match against) - not a
// second independent metric.
const FIELD_REGISTRY = [
  { key: 'imdbId', label: 'IMDb ID', source: 'Trakt/TMDB', critical: true,
    eligible: () => true,
    populated: (t, meta) => !!(t.ids?.imdb || meta?.imdbId),
    quality: (t, meta) => !!(t.ids?.imdb || meta?.imdbId),
    note: 'Needed to join OMDb audience-score/awards data.' },
  { key: 'genres', label: 'Genres', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => (meta?.genres?.length || 0) > 0,
    quality: (t, meta) => (meta?.genres?.length || 0) >= 2,
    note: 'Quality = 2+ genres, so genreBonus() has more than one tag to match.' },
  { key: 'overview', label: 'Overview', source: 'TMDB', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => !!meta?.overview,
    quality: (t, meta) => (meta?.overview?.length || 0) >= 40,
    note: 'Quality = 40+ characters (not a one-line placeholder).' },
  { key: 'originalLanguage', label: 'Original Language', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => meta?.originalLanguage != null,
    quality: (t, meta) => meta?.originalLanguage != null,
    note: 'Drives the non-English candidate filter.' },
  { key: 'creator', label: 'Director/Creator', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => !!getCreator(t.type, meta || {}),
    quality: (t, meta) => !!getCreator(t.type, meta || {}),
    note: 'Feeds the director/creator-match scoring signal.' },
  { key: 'voteAverage', label: 'Community Rating', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => meta?.voteAverage != null,
    quality: (t, meta) => (meta?.voteCount || 0) >= 50,
    note: 'Quality = backed by 50+ TMDB votes, not a near-empty sample.' },
  { key: 'voteCount', label: 'Rating Count', source: 'TMDB', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => meta?.voteCount != null,
    quality: (t, meta) => (meta?.voteCount || 0) >= 50,
    note: 'Drives the Popularity metric.' },
  { key: 'similarToIds', label: 'Similar Titles', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => (meta?.similarToIds?.length || 0) > 0,
    quality: (t, meta) => (meta?.similarToIds?.length || 0) >= 5,
    note: 'Forward-match signal - quality = 5+ candidates to cross-reference.' },
  { key: 'recommendedIds', label: 'Recommended Titles', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => (meta?.recommendedIds?.length || 0) > 0,
    quality: (t, meta) => (meta?.recommendedIds?.length || 0) >= 5,
    note: 'Same role as Similar Titles, TMDB’s separate recommendations list.' },
  { key: 'topCast', label: 'Top Cast', source: 'TMDB', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => (meta?.topCast?.length || 0) > 0,
    quality: (t, meta) => (meta?.topCast?.length || 0) >= 3,
    note: 'Cached for a future cast-based signal - not yet scored.' },
  { key: 'keywords', label: 'Keywords', source: 'TMDB', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => (meta?.keywords?.length || 0) > 0,
    quality: (t, meta) => (meta?.keywords?.length || 0) > 0,
    note: 'Powers the re-edit/re-cut exclusion ("edited from film").' },
  { key: 'omdbRecord', label: 'OMDb Record Found', source: 'OMDb', critical: false,
    eligible: (t, meta) => !!(t.ids?.imdb || meta?.imdbId),
    populated: (t, meta, omdb) => !!omdb,
    quality: (t, meta, omdb) => !!omdb,
    note: 'Eligible = titles with a known IMDb id. Needs OMDB_API_KEY to run.' },
  { key: 'audienceScore', label: 'Audience Score (RT/Metacritic)', source: 'OMDb', critical: false,
    eligible: (t, meta, omdb) => !!omdb,
    populated: (t, meta, omdb) => omdb?.rottenTomatoes != null || omdb?.metacritic != null,
    quality: (t, meta, omdb) => omdb?.rottenTomatoes != null && omdb?.metacritic != null,
    note: 'Quality = both Rotten Tomatoes and Metacritic present, not just one.' },
  { key: 'awards', label: 'Awards (Oscar/Emmy)', source: 'OMDb', critical: false,
    eligible: (t, meta, omdb) => !!omdb,
    populated: (t, meta, omdb) => omdb?.awards != null,
    quality: (t, meta, omdb) => awardsScore(omdb) > 0,
    note: 'Quality = real recognition found (0 is a legitimate answer for most titles, not a data gap).' },
];

function computeFieldQuality(library, watchlist, candidatePool, enrichedMeta, omdbMeta) {
  const allTitles = new Map();
  for (const t of [...(library.titles || []), ...(watchlist.titles || []), ...(candidatePool.titles || [])]) {
    if (t.titleKey && !allTitles.has(t.titleKey)) allTitles.set(t.titleKey, t);
  }
  const titles = [...allTitles.values()];

  return FIELD_REGISTRY.map(f => {
    let eligible = 0, populated = 0, quality = 0;
    for (const t of titles) {
      const meta = enrichedMeta[t.titleKey];
      const omdb = omdbMeta[t.titleKey];
      if (!f.eligible(t, meta, omdb)) continue;
      eligible++;
      if (f.populated(t, meta, omdb)) populated++;
      if (f.quality(t, meta, omdb)) quality++;
    }
    return {
      ...f, eligible, populated, quality,
      populatedPct: eligible ? (populated / eligible) * 100 : null,
      qualityPct: eligible ? (quality / eligible) * 100 : null,
    };
  });
}

function fieldStatus(pct, critical) {
  if (pct == null) return { cls: 'tk-status-warning', icon: '—', label: 'N/A' };
  const goodMin = critical ? 90 : 80;
  const warnMin = critical ? 70 : 50;
  if (pct >= goodMin) return { cls: 'tk-status-good', icon: '✓', label: 'Good' };
  if (pct >= warnMin) return { cls: 'tk-status-warning', icon: '⚠', label: 'Fair' };
  return { cls: 'tk-status-critical', icon: '✗', label: 'Low' };
}

function renderFieldQualityTable(stats) {
  const table = document.getElementById('fieldQualityTable');
  const columns = [
    { label: 'Field', get: r => r.label },
    { label: 'Source', get: r => r.source },
    { label: 'Eligible', get: r => r.eligible, numeric: true },
    { label: '% Populated', get: r => r.populatedPct ?? -1, numeric: true,
      render: (td, r) => { td.className = 'num'; td.appendChild(renderFieldBar(r.populatedPct, r.critical)); } },
    { label: '% Quality', get: r => r.qualityPct ?? -1, numeric: true,
      render: (td, r) => { td.className = 'num'; td.appendChild(renderFieldBar(r.qualityPct, r.critical)); } },
    { label: 'What "Quality" Means', get: r => r.note,
      render: (td, r) => { td.className = 'tk-genres'; td.textContent = r.note; } },
  ];

  let sortCol = 3, sortAsc = true; // default: % Populated ascending, worst first

  function render() {
    const sorted = [...stats].sort((a, b) => {
      const va = columns[sortCol].get(a), vb = columns[sortCol].get(b);
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortAsc ? cmp : -cmp;
    });

    table.innerHTML = '';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    columns.forEach((c, i) => {
      const th = document.createElement('th');
      th.textContent = c.label;
      if (i === sortCol) th.className = 'sorted' + (sortAsc ? ' asc' : '');
      th.addEventListener('click', () => {
        if (sortCol === i) sortAsc = !sortAsc; else { sortCol = i; sortAsc = true; }
        render();
      });
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of sorted) {
      const tr = document.createElement('tr');
      columns.forEach(c => {
        const td = document.createElement('td');
        if (c.render) c.render(td, row); else { if (c.numeric) td.className = 'num'; td.textContent = esc(c.get(row)); }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  render();
}

function renderFieldBar(pct, critical) {
  const wrap = document.createElement('span');
  if (pct == null) {
    wrap.textContent = '—';
    return wrap;
  }
  const status = fieldStatus(pct, critical);
  const track = document.createElement('span');
  track.className = 'tk-field-bar-track';
  const fill = document.createElement('span');
  fill.className = 'tk-field-bar-fill';
  const color = status.cls === 'tk-status-good' ? 'var(--status-good)'
    : status.cls === 'tk-status-warning' ? 'var(--status-warning)' : 'var(--status-critical)';
  fill.style.cssText = `width:${Math.max(0, Math.min(100, pct))}%; background:${color};`;
  track.appendChild(fill);
  wrap.appendChild(track);
  const pill = document.createElement('span');
  pill.className = `tk-status-pill ${status.cls}`;
  pill.textContent = `${status.icon} ${pct.toFixed(0)}%`;
  wrap.appendChild(pill);
  return wrap;
}

// ── Improvement Opportunities ────────────────────────────────────────────
// Findings from a full read-through of every file under trakt/ (engine.js,
// dashboard.js, recommend.js, enrich_tmdb.py, enrich_omdb.py,
// resolve_titles.py, discover_candidates.js, prune_candidate_pool.js,
// build_trakt_library.js, loadAllTitles.js, export_extract.js, both HTML
// shells) — the 5 with the most real impact on data quality and
// recommendation accuracy, each verified against live data rather than
// asserted. Two of the five compute their own evidence live on every page
// load (so the numbers can't go stale or become placeholder claims); the
// other three describe a real code-level gap whose severity doesn't change
// run to run, but still carry the concrete numbers that established it.
function computeImprovementOpportunities(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, fromWatchlist, fromCandidates) {
  const findings = [];

  // 1. prune_candidate_pool.js defines isReEdit/isNonEnglish (copied from
  // rankAll's own filter) but never actually calls either when deciding
  // what counts toward the 100-per-type cap — so a re-edit or foreign-
  // language title can occupy a cap slot even though rankAll() would
  // filter it back out at render time and it could never actually surface
  // as a "New pick." Computed live: how many of the current pool's 200
  // slots are spent on titles like this right now.
  {
    const isReEdit = c => (enrichedMeta[c.titleKey]?.keywords || []).includes('edited from film');
    const isNonEnglish = c => {
      const lang = enrichedMeta[c.titleKey]?.originalLanguage;
      return lang != null && lang !== 'en';
    };
    const wasted = (candidatePool.titles || []).filter(c => isReEdit(c) || isNonEnglish(c));
    const total = (candidatePool.titles || []).length;
    findings.push({
      id: 'pool-cap-waste',
      severity: wasted.length > 0 ? 'serious' : 'good',
      title: 'Candidate pool cap counts titles that can never actually be recommended',
      technical: `<code>prune_candidate_pool.js</code> defines <code>isReEdit()</code>/<code>isNonEnglish()</code>, ` +
        `copied verbatim from <code>rankAll()</code>'s own candidate filter, but never calls either when deciding ` +
        `which candidates count toward the 100-per-type cap. <code>rankAll()</code> still correctly excludes these ` +
        `titles from the "New pick" panels at render time — so the bug isn't a bad recommendation slipping through, ` +
        `it's cap capacity silently spent on a title that was never going to be shown, crowding out a real candidate ` +
        `that could have taken that slot instead. Live count right now: ${wasted.length} of ${total} pool slots ` +
        `(${total ? ((wasted.length / total) * 100).toFixed(1) : 0}%) are re-edits or non-English titles.`,
      plain: `There's a cap of 100 movies and 100 TV shows in the "maybe you'll like this" pile. But right now, ` +
        `${wasted.length} of those 200 slots are taken up by titles that the app has already privately decided it ` +
        `will never actually show you (foreign-language titles, or things like a PG-13 re-edit of a movie you've ` +
        `already seen). Those titles are just sitting there uselessly instead of making room for something that ` +
        `could genuinely make your recommendation list better.`,
      impact: `Fixing this frees up real candidate slots — every wasted slot is a slot a genuinely-scoreable, ` +
        `possibly-better title could have occupied instead. At the current ${wasted.length}/${total} rate this is a ` +
        `real, ongoing tax on pool diversity, not a one-time cleanup.`,
    });
  }

  // 2. The rec panels ("Movies/Shows You'll Love") take the top 4 from the
  // watchlist and the top 4 from the candidate pool BEFORE sorting, then
  // sort those 8 by score — so a candidate ranked 5th-8th overall can be
  // silently excluded even if it outscores every watchlist title shown.
  // Computed live: does today's real ranking actually produce a different
  // (correct) top-8 than what the panel currently shows.
  {
    const gapsByType = {};
    for (const type of ['movie', 'show']) {
      const wl = fromWatchlist.filter(c => c.type === type && enrichedMeta[c.titleKey]);
      const cd = fromCandidates.filter(c => c.type === type && enrichedMeta[c.titleKey]);
      const current = new Set([...wl.slice(0, 4), ...cd.slice(0, 4)].map(c => c.titleKey));
      const trueTop8 = [...wl, ...cd].sort((a, b) => b.bmtreScore - a.bmtreScore).slice(0, 8);
      gapsByType[type] = trueTop8.filter(c => !current.has(c.titleKey));
    }
    const totalMissed = gapsByType.movie.length + gapsByType.show.length;
    const example = gapsByType.movie[0] || gapsByType.show[0];
    findings.push({
      id: 'rec-panel-top8',
      severity: totalMissed > 0 ? 'critical' : 'good',
      title: '"You\'ll Love" panels don\'t actually show the true top 8 by score',
      technical: `<code>renderRecPanel()</code> builds each panel from <code>watchlistItems.slice(0, 4)</code> + ` +
        `<code>candidateItems.slice(0, 4)</code>, THEN sorts those 8 by <code>bmtreScore</code>. The cap of 4-per-` +
        `origin is applied before the cross-origin sort, not after — so a candidate ranked 5th-8th overall within ` +
        `its own origin is dropped even if its score beats several titles that do make the cut from the other ` +
        `origin. Live check right now: ${totalMissed} title${totalMissed === 1 ? '' : 's'} belong${totalMissed === 1 ? 's' : ''} ` +
        `in the real top 8 by score but ${totalMissed === 1 ? 'is' : 'are'} missing from the panel as rendered` +
        (example ? ` — e.g. "${esc(example.title)}" (score ${Math.round(example.bmtreScore)}) isn't shown.` : '.'),
      plain: `The "Movies/Shows You'll Love" boxes are supposed to show your 8 best matches. But the code actually ` +
        `grabs your top 4 already-queued titles and your top 4 newly-discovered titles as two separate groups ` +
        `first, and only then sorts those 8 — so if your 5th-best new discovery is actually a better fit than your ` +
        `4th-best queued title, it gets left out even though it deserved a spot. Right now that's really happening: ` +
        `${totalMissed} title${totalMissed === 1 ? '' : 's'} that should be on the list ${totalMissed === 1 ? 'isn\'t' : 'aren\'t'}.`,
      impact: `This is the single most directly recommendation-accuracy-affecting finding of the five — it's not a ` +
        `data-quality gap, it's the headline feature of the dashboard showing a worse list than the engine already ` +
        `computed. Fixing it is a small code change (sort the combined pool first, take the top 8 after) with an ` +
        `immediate, visible improvement.`,
    });
  }

  // 3. enrich_omdb.py never got the same "surface TMDB's real error body"
  // fix enrich_tmdb.py got tonight after a real dead-key incident (a bare
  // 401 with no way to tell revoked/malformed/suspended apart cost real
  // back-and-forth before the fix). enrich_omdb.py's get_json() still
  // discards the response body the same way enrich_tmdb.py's used to.
  findings.push({
    id: 'omdb-error-diagnostics',
    severity: 'warning',
    title: 'enrich_omdb.py still throws away the one piece of information that would diagnose a dead key',
    technical: `<code>trakt/enrich_tmdb.py</code>'s <code>get_json()</code> was fixed this session to capture and ` +
      `surface TMDB's own error-response body (not just the bare HTTP status) after a real incident where a bare ` +
      `401 gave no way to distinguish a revoked key from a malformed one from a temporarily-suspended one — the ` +
      `fix immediately paid off, turning an unexplained failure into a one-line diagnosis. ` +
      `<code>trakt/enrich_omdb.py</code>'s <code>get_json()</code> is structurally identical but was never given the ` +
      `same fix: <code>except urllib.error.HTTPError as e: return None, e.code</code> still discards <code>e.read()</code> entirely.`,
    plain: `Earlier tonight, one of the two API keys this app depends on broke, and figuring out why took a long time ` +
      `because the error message was just "401 - invalid" with no further detail. That got fixed for one of the two ` +
      `data pipelines (TMDB) but not the other (OMDb, the Rotten Tomatoes/awards data) — so if the OMDb key ever ` +
      `has the same kind of problem, we're back to square one on that side, guessing instead of reading the real answer.`,
    impact: `Low urgency (this doesn't affect today's data), but cheap to fix and directly reduces future debugging ` +
      `time the next time this exact category of failure happens — which it already has once tonight, on the sibling pipeline.`,
  });

  // 4. resolve_titles.py takes TMDB's #1 search result with zero
  // disambiguation. This already produced 11 wrong matches out of 196
  // titles in a real past run (Session 47) — Bros -> Super Mario Bros.
  // Movie, The Impossible -> Mission: Impossible, etc. — each requiring
  // manual after-the-fact correction. No guardrail exists to catch this
  // automatically on a future run.
  findings.push({
    id: 'resolve-titles-disambiguation',
    severity: 'serious',
    title: 'Manual title resolution has no confidence check, and has already produced wrong matches once',
    technical: `<code>trakt/resolve_titles.py</code>'s <code>search()</code> takes <code>results[0]</code> from ` +
      `TMDB's search endpoint unconditionally — no check that the returned title actually resembles the query, no ` +
      `year hint, no popularity/relevance threshold. This already produced 11 wrong matches out of 196 titles in a ` +
      `real past run (5.6% error rate): short/common titles like "Bros", "The Impossible", "Dredd", and "Chad" all ` +
      `matched an unrelated same-named title instead of what was actually meant, each silently written into ` +
      `<code>candidatePool.json</code> until caught by hand and corrected via manual web research. Nothing in the ` +
      `script itself changed since then — the same failure mode is live for every future manual batch.`,
    plain: `When Bill types in a list of movie/show titles he wants added, the script just grabs whatever TMDB's ` +
      `search returns first and trusts it completely. For a title like "Bros" or "Dredd," that's ambiguous — TMDB's ` +
      `top result was the wrong movie 11 times out of 196 the last time this ran, and every one of those wrong ` +
      `matches quietly poisoned the recommendation data until someone noticed and fixed it by hand.`,
    impact: `A ~5.6% wrong-match rate compounds every time Bill hand-adds a new batch of titles — each wrong match ` +
      `contaminates the loved-title citation network (a bad match on a real title's identity feeds wrong signal into ` +
      `every score that touches it). A simple title-similarity or year-match guardrail before auto-accepting would ` +
      `catch most of these before they ever reach the data.`,
  });

  // 5. build_trakt_library.js's titleKey() falls back to a `type:trakt:ID`
  // format when a title has no TMDB id — a completely different shape than
  // every other part of the pipeline assumes (engine.js's titleKey(),
  // enrich_tmdb.py's lookup, enrichedMetadata.json's own keys). Checked
  // live: does any current title actually use this fallback keyspace.
  {
    const allTitles = [...(library.titles || []), ...(watchlist.titles || []), ...(candidatePool.titles || [])];
    const trakFallback = allTitles.filter(t => t.titleKey && /^(movie|show):trakt:/.test(t.titleKey));
    findings.push({
      id: 'trakt-fallback-titlekey',
      severity: trakFallback.length > 0 ? 'critical' : 'warning',
      title: 'A title with no TMDB id gets a titleKey format the rest of the pipeline can\'t recognize',
      technical: `<code>build_trakt_library.js</code>'s local <code>titleKey(type, ids)</code> falls back to ` +
        `<code>\`\${type}:trakt:\${ids.trakt}\`</code> when a title has a Trakt id but no TMDB id. Every other part ` +
        `of BMTRE assumes the single canonical shape from <code>engine.js</code>'s own exported <code>titleKey(type, tmdbId)</code> ` +
        `— <code>\`\${type}:\${tmdbId}\`</code> — including <code>enrich_tmdb.py</code>'s lookup (which needs ` +
        `<code>ids.tmdb</code> directly and silently skips a title with none), <code>enrichedMetadata.json</code>'s own ` +
        `keys, and the engine's scoring indexes. A title that ever takes this fallback path would get a key no other ` +
        `file recognizes — permanently un-enrichable, unscorable, and invisible to the dashboard, with no error, ever. ` +
        `Live check right now: ${trakFallback.length} title${trakFallback.length === 1 ? '' : 's'} currently use${trakFallback.length === 1 ? 's' : ''} this fallback format` +
        (trakFallback.length ? ` (${trakFallback.slice(0, 3).map(t => esc(t.title)).join(', ')}${trakFallback.length > 3 ? ', …' : ''}).` : ' — none yet, but the code path exists and would fire silently the moment one does.'),
      plain: `Every title in this whole system is identified by its TMDB catalog number — that's the one thing the ` +
        `entire design leans on to avoid the messy "is this the same movie?" guessing the book side of this project ` +
        `has hit repeatedly. But there's one line of code that quietly creates a different kind of ID for a title ` +
        `that (for whatever reason) doesn't have a TMDB number, using its Trakt number instead. If that ever happens ` +
        `for real, that title becomes a ghost — it'll never get real data, never get scored, and nothing will tell ` +
        `anyone it's broken.`,
      impact: trakFallback.length
        ? `Actively affecting ${trakFallback.length} title${trakFallback.length === 1 ? '' : 's'} right now — these are silently dead weight in the data.`
        : `Zero titles affected today, so this is a latent risk rather than a current problem — but it directly ` +
          `contradicts this project's own foundational design assumption ("every title carries a real TMDB id"), and ` +
          `the moment a future Trakt export includes one title without a TMDB id, it fails completely silently. Cheap ` +
          `to close off now (skip and warn, same as the existing "neither id" case already does) rather than debug later.`,
    });
  }

  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}

function renderImprovementOpportunities(findings) {
  const el = document.getElementById('improvementList');
  const sevMeta = {
    critical: { cls: 'tk-status-critical', icon: '✗', label: 'High impact' },
    serious: { cls: 'tk-status-serious', icon: '⚠', label: 'Medium impact' },
    warning: { cls: 'tk-status-warning', icon: '⚠', label: 'Low impact' },
    good: { cls: 'tk-status-good', icon: '✓', label: 'Resolved' },
  };
  el.innerHTML = findings.map(f => {
    const sev = sevMeta[f.severity];
    return `
      <div class="tk-imp-card">
        <div class="tk-imp-header">
          <div class="tk-imp-title">${esc(f.title)}</div>
          <span class="tk-status-pill ${sev.cls}">${sev.icon} ${sev.label}</span>
        </div>
        <div class="tk-imp-section-label">Technical description</div>
        <div class="tk-imp-technical">${f.technical}</div>
        <div class="tk-imp-section-label">In plain English</div>
        <div class="tk-imp-plain">${f.plain}</div>
        <div class="tk-imp-section-label">Impact</div>
        <div class="tk-imp-impact">${f.impact}</div>
      </div>
    `;
  }).join('');
}

// Predicted Score reuses the same matchScore() the recommendation panels
// score against (0-100, "how much BMTRE thinks this fits your taste") —
// computed here for every row, including already-watched titles, so it
// doubles as an honesty check against My Rating, the same role You vs.
// The Crowd plays for TMDB's rating.
function buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx) {
  const rows = [];
  const addRow = (t, status, myRating) => {
    const h = hydrateTitle(t, enrichedMeta);
    const meta = enrichedMeta[h.titleKey];
    const omdb = omdbMeta[h.titleKey];
    rows.push({
      title: h.title || '(untitled — not yet enriched)', year: h.year, type: h.type, status,
      myRating: myRating ?? null, tmdbRating: meta?.voteAverage ?? null,
      predictedScore: Math.round(matchScore(h, idx, enrichedMeta, omdbMeta)),
      popularity: popularityScore(meta?.voteCount),
      voteCount: meta?.voteCount ?? null,
      audienceScore: audienceScore(omdb),
      awardsScore: awardsScore(omdb),
      awardsRaw: omdb?.awards?.raw || '',
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
    { label: 'Popularity', get: r => r.popularity ?? '', numeric: true },
    { label: 'Ratings', get: r => r.voteCount ?? '', numeric: true },
    { label: 'Audience Score', get: r => r.audienceScore ?? '', numeric: true },
    { label: 'Awards', get: r => r.awardsScore ?? '', numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.awardsScore ?? ''; if (r.awardsRaw) td.title = r.awardsRaw; } },
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
const fmtCompact = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

function metaLine(candidate, enrichedMeta, omdbMeta) {
  const meta = enrichedMeta[candidate.titleKey];
  if (!meta) return 'Not enriched yet.';
  const parts = [];
  if (meta.genres?.length) parts.push(meta.genres.slice(0, 2).join(', '));
  const creator = getCreator(candidate.type, meta);
  if (creator) parts.push(candidate.type === 'movie' ? `dir. ${creator}` : `by ${creator}`);
  if (meta.voteAverage != null) {
    const ratings = meta.voteCount != null ? ` (${fmtCompact(meta.voteCount)} ratings)` : '';
    parts.push(`${meta.voteAverage.toFixed(1)}/10 on TMDB${ratings}`);
  }
  const omdbEntry = omdbMeta?.[candidate.titleKey];
  const audience = audienceScore(omdbEntry);
  if (audience != null) parts.push(`${audience}/100 audience`);
  const awardsText = omdbEntry?.awards?.raw;
  if (awardsText && awardsText !== 'N/A') {
    parts.push(awardsText.length > 40 ? awardsText.slice(0, 40) + '…' : awardsText);
  }
  return parts.join(' · ') || 'No genre/creator data yet.';
}

// 4 top-ranked watchlist titles + 4 top-ranked candidate-pool titles for
// one type (movie or show) — each card shows real metadata, the engine's
// predicted score, and its plain-English reason, per Bill's request.
function renderRecPanel(sectionId, watchlistItems, candidateItems, enrichedMeta, omdbMeta) {
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
        <div class="tk-rec-meta">${esc(metaLine(c, enrichedMeta, omdbMeta))}</div>
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

  const [d, library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback] = await Promise.all([
    get('./data/dashboard.json'),
    get('./data/library.json').catch(() => ({ titles: [] })),
    get('./data/watchlist.json').catch(() => ({ titles: [] })),
    get('./data/candidatePool.json').catch(() => ({ titles: [] })),
    get('./data/enrichedMetadata.json').catch(() => ({})),
    get('./data/omdbMetadata.json').catch(() => ({})),
    get('./data/feedbackData.json').catch(() => ({ interactions: [] })),
  ]);

  const { idx, fromWatchlist, fromCandidates } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta);
  const enrichedOnly = c => !!enrichedMeta[c.titleKey];
  const byType = (list, type) => list.filter(c => c.type === type && enrichedOnly(c));

  renderRecPanel('movieRecList', byType(fromWatchlist, 'movie'), byType(fromCandidates, 'movie'), enrichedMeta, omdbMeta);
  renderRecPanel('showRecList', byType(fromWatchlist, 'show'), byType(fromCandidates, 'show'), enrichedMeta, omdbMeta);

  for (const [type, chartId, noteId, label] of [
    ['movie', 'scoreDistMovieChart', 'scoreDistMovieNote', 'unwatched movies'],
    ['show', 'scoreDistShowChart', 'scoreDistShowNote', 'unwatched shows'],
  ]) {
    const dist = computeScoreDistribution([...byType(fromWatchlist, type), ...byType(fromCandidates, type)]);
    if (!dist) {
      document.getElementById(chartId).innerHTML = '<div class="tk-empty">Not enough enriched titles yet.</div>';
      document.getElementById(noteId).textContent = '';
      continue;
    }
    renderScoreHistogram(chartId, dist.bins);
    document.getElementById(noteId).textContent =
      `${fmtNum(dist.n)} ${label} — mean ${dist.mean.toFixed(0)}, median ${dist.median.toFixed(0)}, σ ${dist.sd.toFixed(0)}. ${shapeNote(dist)}`;
  }

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

  const fieldStats = computeFieldQuality(library, watchlist, candidatePool, enrichedMeta, omdbMeta);
  renderFieldQualityTable(fieldStats);
  const totalTitles = (library.titles?.length || 0) + (watchlist.titles?.length || 0) + (candidatePool.titles?.length || 0);
  const omdbEligible = fieldStats.find(f => f.key === 'omdbRecord')?.eligible ?? 0;
  const omdbFound = fieldStats.find(f => f.key === 'omdbRecord')?.populated ?? 0;
  document.getElementById('fieldQualityNote').textContent =
    `Population and quality of every metadata field, across all ${fmtNum(totalTitles)} watched/watchlisted/candidate titles. ` +
    (omdbFound === 0
      ? `OMDb fields (audience score, awards) are ${fmtNum(omdbEligible)} titles eligible but 0 enriched — needs the OMDB_API_KEY secret before that pipeline can run.`
      : `${fmtNum(omdbFound)}/${fmtNum(omdbEligible)} eligible titles have an OMDb record.`);

  renderImprovementOpportunities(
    computeImprovementOpportunities(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, fromWatchlist, fromCandidates)
  );

  renderAllTitlesTable(buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx));
}

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load dashboard data — see console.';
  document.getElementById('subtitleText').textContent = 'No export loaded yet.';
  console.error(err);
});
