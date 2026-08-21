// Bill's Trakt Dashboard — reads trakt/data/dashboard.json, a compact
// summary built from a full Trakt account-data-export zip by
// scripts/build_trakt_dashboard.js. This page has no write path of its
// own; refreshing the data means re-running that script against a fresh
// export and pushing the regenerated JSON. See CLAUDE.md's "Trakt
// Dashboard" section for the update workflow.

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

// ── Load + render ─────────────────────────────────────────────────────────

async function load() {
  const res = await fetch('./data/dashboard.json');
  if (!res.ok) throw new Error(res.statusText);
  const d = await res.json();

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
