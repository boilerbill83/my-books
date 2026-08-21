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

import { rankRecommendations } from './engine.js';

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

// ── Vertical bar chart (rating distribution, watched-by-year) ──────────────

function renderVBarChart(containerId, data, { labelKey, valueKey, height = 200 }) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!data.length) { container.innerHTML = '<div class="tk-empty">No data.</div>'; return; }

  const width = 600;
  const marginLeft = 34, marginBottom = 20, marginTop = 10, marginRight = 10;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const maxVal = Math.max(1, ...data.map(d => d[valueKey]));
  const niceMax = Math.pow(10, Math.floor(Math.log10(maxVal))) * Math.ceil(maxVal / Math.pow(10, Math.floor(Math.log10(maxVal))));
  const yScale = v => plotH - (v / niceMax) * plotH;

  const barSlot = plotW / data.length;
  const barWidth = Math.min(24, barSlot - 4);
  // Label every Nth bar so labels never collide — cap at ~12 visible labels,
  // always including the first and last.
  const labelStep = Math.max(1, Math.ceil(data.length / 12));

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, style: 'display:block' });

  // gridlines (0, mid, max)
  [0, 0.5, 1].forEach(f => {
    const y = marginTop + plotH * (1 - f);
    svg.appendChild(svgEl('line', {
      x1: marginLeft, x2: width - marginRight, y1: y, y2: y, class: 'tk-gridline',
    }));
    const label = svgEl('text', { x: marginLeft - 6, y: y + 3, class: 'tk-axis-label', 'text-anchor': 'end' });
    label.textContent = fmtNum(Math.round(niceMax * f));
    svg.appendChild(label);
  });

  const tooltip = document.createElement('div');
  tooltip.className = 'tk-tooltip';
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.appendChild(svg);
  wrap.appendChild(tooltip);
  container.appendChild(wrap);

  data.forEach((d, i) => {
    const x = marginLeft + i * barSlot + (barSlot - barWidth) / 2;
    const barH = plotH * (d[valueKey] / niceMax);
    const y = marginTop + plotH - barH;

    const rect = svgEl('rect', {
      x, y, width: barWidth, height: Math.max(barH, 0.5), rx: 4, ry: 4, class: 'tk-bar',
    });
    svg.appendChild(rect);

    const isLastBar = i === data.length - 1;
    if (i % labelStep === 0 || isLastBar) {
      const xlabel = svgEl('text', {
        x: x + barWidth / 2, y: height - marginBottom + 13, class: 'tk-axis-label', 'text-anchor': 'middle',
      });
      xlabel.textContent = d[labelKey];
      svg.appendChild(xlabel);
    }

    rect.addEventListener('pointerenter', () => {
      tooltip.textContent = `${d[labelKey]}: ${fmtNum(d[valueKey])}`;
      tooltip.classList.add('active');
      const pct = ((x + barWidth / 2) / width) * 100;
      tooltip.style.left = `${pct}%`;
      tooltip.style.top = `${((y) / height) * 100}%`;
    });
    rect.addEventListener('pointerleave', () => tooltip.classList.remove('active'));
  });
}

// ── Horizontal bar chart (top shows) ────────────────────────────────────

function renderHBarChart(containerId, data, { labelKey, valueKey, barHeight = 20 }) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!data.length) { container.innerHTML = '<div class="tk-empty">No data.</div>'; return; }

  const width = 700;
  const gap = 6;
  const rowH = barHeight + gap;
  const height = data.length * rowH + 10;
  const marginLeft = 170, marginRight = 50;
  const plotW = width - marginLeft - marginRight;
  const maxVal = Math.max(1, ...data.map(d => d[valueKey]));

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
    valueLabel.textContent = fmtNum(d[valueKey]);
    svg.appendChild(valueLabel);

    rect.addEventListener('pointerenter', () => {
      tooltip.textContent = `${d[labelKey]}: ${fmtNum(d[valueKey])} episodes`;
      tooltip.classList.add('active');
      tooltip.style.left = `${((marginLeft + barW / 2) / width) * 100}%`;
      tooltip.style.top = `${(y / height) * 100}%`;
    });
    rect.addEventListener('pointerleave', () => tooltip.classList.remove('active'));
  });
}

// ── Ranked lists (top rated, watchlist, favorites) ──────────────────────

function renderRankedList(containerId, items, { scoreKey, scoreSuffix = '' }) {
  const el = document.getElementById(containerId);
  if (!items.length) { el.innerHTML = '<div class="tk-empty">Nothing here yet.</div>'; return; }
  el.innerHTML = items.map((item, i) => `
    <div class="tk-list-row">
      <span class="tk-list-rank">${i + 1}</span>
      <span class="tk-list-title">${esc(item.title)}${item.year ? ` <span class="tk-year">(${esc(item.year)})</span>` : ''}</span>
      ${scoreKey ? `<span class="tk-list-score">${esc(item[scoreKey])}${scoreSuffix}</span>` : ''}
    </div>
  `).join('');
}

function renderSimpleList(containerId, items) {
  const el = document.getElementById(containerId);
  if (!items.length) { el.innerHTML = '<div class="tk-empty">Nothing here yet.</div>'; return; }
  el.innerHTML = items.map(item => `
    <div class="tk-list-row">
      <span class="tk-list-title">${esc(item.title)}${item.year ? ` <span class="tk-year">(${esc(item.year)})</span>` : ''}</span>
      <span class="tk-list-score">${item.type === 'movie' ? 'Movie' : 'Show'}</span>
    </div>
  `).join('');
}

// ── Recommendations preview ─────────────────────────────────────────────

function renderRecPreview(selected) {
  const el = document.getElementById('recPreviewList');
  if (!selected.length) {
    el.innerHTML = '<div class="tk-empty">Nothing on the watchlist yet.</div>';
    return;
  }
  const top5 = selected.slice(0, 5);
  el.innerHTML = top5.map((c, i) => `
    <div class="tk-rec-card">
      <div class="tk-rec-rank">${i + 1}</div>
      <div class="tk-rec-body">
        <div class="tk-rec-title">
          ${esc(c.title)}${c.year ? ` <span class="tk-year">(${esc(c.year)})</span>` : ''}
          <span class="tk-rec-badge">${c.type === 'movie' ? 'Movie' : 'Show'}</span>
        </div>
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

  const [d, library, watchlist, enrichedMeta, feedback] = await Promise.all([
    get('./data/dashboard.json'),
    get('./data/library.json').catch(() => ({ titles: [] })),
    get('./data/watchlist.json').catch(() => ({ titles: [] })),
    get('./data/enrichedMetadata.json').catch(() => ({})),
    get('./data/feedbackData.json').catch(() => ({ interactions: [] })),
  ]);

  const { selected } = rankRecommendations(library, watchlist, enrichedMeta, feedback);
  renderRecPreview(selected);

  const quality = computeMetadataQuality(library, watchlist, enrichedMeta, selected);
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

  const ratingData = Object.entries(d.ratingDistribution)
    .map(([rating, count]) => ({ rating, count }))
    .sort((a, b) => Number(a.rating) - Number(b.rating));
  renderVBarChart('ratingChart', ratingData, { labelKey: 'rating', valueKey: 'count' });

  renderVBarChart('moviesByYearChart', d.activityByYear, { labelKey: 'year', valueKey: 'movies' });
  renderVBarChart('episodesByYearChart', d.activityByYear, { labelKey: 'year', valueKey: 'episodes' });

  document.getElementById('undatedCaveat').textContent =
    `${d.dataCaveats.undatedEpisodeSharePct}% of all episode plays (${fmtNum(d.dataCaveats.undatedEpisodePlays)} of ` +
    `${fmtNum(d.dataCaveats.undatedEpisodePlays + d.dataCaveats.datedEpisodePlays)}) have no recorded watch date — ` +
    `a bulk import with no per-episode timestamp — and are excluded from this chart rather than shown as watched in 1970.`;

  renderHBarChart('topShowsChart', d.topShowsByPlays, { labelKey: 'title', valueKey: 'plays' });

  renderRankedList('topRatedMoviesList', d.topRatedMovies, { scoreKey: 'rating', scoreSuffix: '/10' });
  renderRankedList('topRatedShowsList', d.topRatedShows, { scoreKey: 'rating', scoreSuffix: '/10' });

  document.getElementById('watchlistCount').textContent = d.watchlist.count;
  document.getElementById('favoritesCount').textContent = d.favorites.count;
  renderSimpleList('watchlistList', d.watchlist.items);
  renderSimpleList('favoritesList', d.favorites.items);
}

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load dashboard data — see console.';
  document.getElementById('subtitleText').textContent = 'No export loaded yet.';
  console.error(err);
});
