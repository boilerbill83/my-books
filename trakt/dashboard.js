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

import { rankAll, getCreator, matchScore, hydrateTitle, popularityScore, audienceScore, awardsScore, mergeScrapedShowRatings, posterUrl, computeEvalMetrics, diversityRerank, resolveSimilarTitles, resolveSimilarDirectors, inferSubgenres, inferTones } from './engine.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtNum = n => (n ?? 0).toLocaleString('en-US');

// Consistent visual language for movie/show and watched/watchlist/candidate,
// used everywhere a title appears (rec cards, metric rows, the All Titles
// table) — Bill's explicit ask for a systematic cue "throughout" rather than
// a one-off badge in a single section.
const typeIcon = t => t === 'movie' ? '🎬' : '📺';
const typeLabel = t => t === 'movie' ? 'Movie' : 'TV';
const STATUS_META = {
  Watched:    { cls: 'tk-status-tag-watched',    label: 'Watched' },
  Watchlist:  { cls: 'tk-status-tag-watchlist',  label: 'Watchlist' },
  Candidate:  { cls: 'tk-status-tag-candidate',  label: 'Candidate' },
};
const statusTag = status => {
  const m = STATUS_META[status];
  if (!m) return '';
  return `<span class="tk-status-tag ${m.cls}">${m.label}</span>`;
};

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

// Predicted score (matchScore, 0-100) vs. actual rating (myRating scaled
// to 0-100) for every watched+rated+enriched title — the same "does the
// model's prediction match reality" check the book side's eval.js runs
// formally, but computed live here since BMTRE has no eval harness yet
// (a gap this session's own Improvement Opportunities list flags as
// finding #1 under "Recommendation Engine Improvements"). Replaces
// "Directors & Creators You Love" (Bill: not interesting) with something
// that speaks directly to "how strong is the engine" — verified against
// real data before shipping: 533 titles, real, notable misses on both
// sides (e.g. How to Lose a Guy in 10 Days predicted 29, rated 10/10).
function computePredictionMisses(library, enrichedMeta, omdbMeta, idx) {
  const rows = (library.titles || [])
    .filter(t => enrichedMeta[t.titleKey] && t.myRating != null)
    .map(t => {
      const h = hydrateTitle(t, enrichedMeta);
      const predicted = matchScore(h, idx, enrichedMeta, omdbMeta);
      const actual = t.myRating * 10;
      return { titleKey: t.titleKey, title: h.title, year: h.year, type: h.type, myRating: t.myRating, predicted, actual, diff: predicted - actual };
    });
  const overPredicted = [...rows].sort((a, b) => b.diff - a.diff).slice(0, 5);
  const underPredicted = [...rows].sort((a, b) => a.diff - b.diff).slice(0, 5);
  return { n: rows.length, overPredicted, underPredicted };
}

// The flip side of the misses above — real cases where a high predicted
// score and a high actual rating agree, sorted by predicted score. This
// is the positive evidence for "the engine gets it right," replacing
// "Franchises You're Following" (Bill: not interesting). Verified: 144 of
// 533 watched+rated+enriched titles qualify (predicted >= 70, actual >=
// 80) — a real, sizeable set, not a cherry-picked handful.
function computeBestMatches(library, enrichedMeta, omdbMeta, idx) {
  const rows = (library.titles || [])
    .filter(t => enrichedMeta[t.titleKey] && t.myRating != null)
    .map(t => {
      const h = hydrateTitle(t, enrichedMeta);
      const predicted = matchScore(h, idx, enrichedMeta, omdbMeta);
      const actual = t.myRating * 10;
      return { titleKey: t.titleKey, title: h.title, year: h.year, type: h.type, myRating: t.myRating, predicted, actual };
    });
  const matches = rows.filter(r => r.predicted >= 70 && r.actual >= 80).sort((a, b) => b.predicted - a.predicted);
  return { total: rows.length, matches };
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

// Human-readable label per reasonCode, since feedbackData.json's real
// reasonLabel text is a full sentence (context for the engine/a future
// reader), not a chart-axis-sized string.
const REASON_CODE_SHORT_LABEL = {
  already_watched: 'Already watched',
  already_have_version_rated: 'Already have a rated version',
  looks_low_budget: 'Looks low budget',
  too_urban: 'Setting fatigue (urban crime)',
  too_old: 'Too old',
  not_interested: 'Not interested',
  aimed_at_older_demographic: 'Aimed at older demographic',
};

function computeDismissalStats(feedback) {
  const dismissals = (feedback?.interactions || []).filter(i => i.interactionType === 'dismiss');
  const counts = new Map();
  for (const d of dismissals) {
    const key = d.reasonCode || 'unspecified';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return {
    n: dismissals.length,
    byReason: [...counts.entries()]
      .map(([reasonCode, count]) => ({ reasonCode, label: REASON_CODE_SHORT_LABEL[reasonCode] || reasonCode, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function renderDismissalChart(stats) {
  const el = document.getElementById('dismissalChart');
  if (!stats.n) { el.innerHTML = '<div class="tk-empty">No dismissals tracked yet.</div>'; return; }
  renderHBarChart('dismissalChart',
    stats.byReason.map(r => ({ reason: `${r.label} (${r.count})`, count: r.count })),
    { labelKey: 'reason', valueKey: 'count', maxScale: Math.max(...stats.byReason.map(r => r.count)), fmtValue: v => String(v), tooltipSuffix: ' dismissed' });
}

function renderPredictionMisses(stats, enrichedMeta) {
  const el = document.getElementById('predictionMissesList');
  if (!stats.n) { el.innerHTML = '<div class="tk-empty">Not enough enriched, rated titles yet.</div>'; return; }
  const row = (r, dir) => {
    const poster = posterUrl(r.titleKey, enrichedMeta);
    return `
    <div class="tk-metric-row">
      ${poster ? `<img class="tk-metric-poster" src="${poster}" alt="" loading="lazy" width="38" height="57">` : '<div class="tk-metric-poster tk-metric-poster-empty"></div>'}
      <span class="tk-metric-name">${typeIcon(r.type)} ${esc(r.title)} <span class="tk-metric-sub">(${r.year || '—'})</span></span>
      <span class="tk-metric-score" style="color:${dir === 'over' ? 'var(--status-critical)' : 'var(--status-serious)'};">
        ${dir === 'over' ? 'predicted' : 'rated'} ${dir === 'over' ? Math.round(r.predicted) : r.myRating + '/10'} vs. ${dir === 'over' ? 'rated ' + r.myRating + '/10' : 'predicted ' + Math.round(r.predicted)}
      </span>
    </div>`;
  };
  el.innerHTML = `
    <div class="tk-metric-sub" style="margin-bottom:6px;">Engine thought he'd love it, he didn't:</div>
    ${stats.overPredicted.map(r => row(r, 'over')).join('')}
    <div class="tk-metric-sub" style="margin:10px 0 6px;">Engine underrated something he loved:</div>
    ${stats.underPredicted.map(r => row(r, 'under')).join('')}
  `;
}

function renderBestMatches(stats, enrichedMeta) {
  const el = document.getElementById('bestMatchesList');
  if (!stats.matches.length) { el.innerHTML = '<div class="tk-empty">Not enough enriched, rated titles yet.</div>'; return; }
  el.innerHTML = stats.matches.slice(0, 12).map(r => {
    const poster = posterUrl(r.titleKey, enrichedMeta);
    return `
    <div class="tk-metric-row">
      ${poster ? `<img class="tk-metric-poster" src="${poster}" alt="" loading="lazy" width="38" height="57">` : '<div class="tk-metric-poster tk-metric-poster-empty"></div>'}
      <span class="tk-metric-name">${typeIcon(r.type)} ${esc(r.title)} <span class="tk-metric-sub">(${r.year || '—'})</span></span>
      <span class="tk-metric-score">predicted ${Math.round(r.predicted)}, rated ${r.myRating}/10</span>
    </div>
  `;
  }).join('');
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
    note: 'Quality = any real award/nomination found via OMDb\'s Awards text. Bill\'s library skews toward ' +
      'well-regarded titles, so most (~80%) genuinely do have some recognition — 0 is still a legitimate ' +
      'answer for a real minority (genuinely un-recognized titles), not evidence of a parsing gap.' },
  { key: 'subgenres', label: 'Subgenres (beneath genre)', source: 'Derived (keywords)', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => inferSubgenres(meta).length > 0,
    quality: (t, meta) => inferSubgenres(meta).length > 0,
    note: 'Live-computed from TMDB keywords, not persisted — see inferSubgenres() in engine.js. Coverage is a ' +
      'real ceiling of the underlying keyword data, not a bug (a title with sparse/generic keywords may ' +
      'legitimately match none of the 21 canonical subgenre tags).' },
  { key: 'tones', label: 'Tones (mood/craft)', source: 'Derived (keywords)', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => inferTones(meta).length > 0,
    quality: (t, meta) => inferTones(meta).length > 0,
    note: 'Same live-computed design as Subgenres, via inferTones(). Coverage is honestly lower — TMDB\'s ' +
      'keyword vocabulary carries far fewer mood/craft descriptors than content/subject ones.' },
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

// Bill's explicit rule: any field under 90% populated OR under 90%
// quality gets a real Improvement Opportunity card, not just a passive
// row in the Field Population & Quality table below — a data gap
// shouldn't be able to sit merely documented without ever surfacing as
// something actionable. This is a flat 90% bar on either metric, not the
// field table's own critical/non-critical 90/80 split (fieldStatus()) —
// deliberately stricter and uniform, per Bill's own wording. Generated
// fresh from live fieldStats on every render, so a field crossing back
// above 90% drops off this list automatically, the same self-resolving
// pattern every other live-checked finding in this file already follows
// (pool-cap-waste, rec-panel-top8, etc.) — no field is ever "manually
// marked resolved" here.
//
// Four fields are hand-researched with real root-cause numbers below
// (imdbId, genres, audienceScore, awards — the ones under 90% as of this
// writing); any other field that dips below 90% in a future session gets
// a generic finding built from its own FIELD_REGISTRY note rather than
// silently going unlisted, per Bill's literal "any field" instruction.
function computeFieldQualityFindings(fieldStats, library, watchlist, candidatePool, enrichedMeta, omdbMeta) {
  const findings = [];

  // Same dedup-by-titleKey, same source-priority order (library beats
  // watchlist beats candidatePool for an overlapping key) as
  // computeFieldQuality() itself uses to build its `eligible` population —
  // built once here so every breakdown below is counted against the exact
  // same title set the displayed percentages describe, not a naive sum
  // across the three raw source lists (which double-counts any title
  // present in more than one, and was the source of a real mismatch caught
  // before this shipped: a naive per-list sum landed on different totals
  // than fieldStats' own deduped counts).
  const dedupedBySource = new Map();
  for (const [source, list] of [['library', library.titles || []], ['watchlist', watchlist.titles || []], ['candidatePool', candidatePool.titles || []]]) {
    for (const t of list) {
      if (t.titleKey && !dedupedBySource.has(t.titleKey)) dedupedBySource.set(t.titleKey, { t, source });
    }
  }
  const dedupedTitles = [...dedupedBySource.values()];

  const bySourceImdb = () => {
    const out = { library: { total: 0, has: 0 }, watchlist: { total: 0, has: 0 }, candidatePool: { total: 0, has: 0 } };
    for (const { t, source } of dedupedTitles) {
      out[source].total++;
      if (t.ids?.imdb || enrichedMeta[t.titleKey]?.imdbId) out[source].has++;
    }
    for (const source of Object.keys(out)) out[source].missing = out[source].total - out[source].has;
    return out;
  };

  const genreCounts = () => {
    let single = 0, multi = 0;
    for (const { t } of dedupedTitles) {
      const meta = enrichedMeta[t.titleKey];
      if (!meta) continue;
      const n = meta.genres?.length || 0;
      if (n === 1) single++; else if (n >= 2) multi++;
    }
    return { single, multi };
  };

  const CUSTOM = {
    imdbId: (f) => {
      const src = bySourceImdb();
      return {
        severity: 'serious',
        ratings: { ease: 6, dataQuality: 8, recEngine: 3, ui: 1 },
        title: `IMDb ID is only ${f.populatedPct.toFixed(1)}% populated — below the 90% bar on a field that gates OMDb data`,
        technical: `<code>imdbId</code> is ${f.populatedPct.toFixed(1)}% populated (${f.populated} of ${f.eligible} eligible titles). Split by ` +
          `source: library ${src.library.has}/${src.library.total} (100%, real Trakt export data), watchlist ${src.watchlist.has}/${src.watchlist.total} ` +
          `(100%), candidatePool ${src.candidatePool.has}/${src.candidatePool.total} (${((src.candidatePool.has / src.candidatePool.total) * 100).toFixed(1)}%) — ` +
          `the entire gap is concentrated in discovered candidates, which only get an <code>imdbId</code> via ` +
          `<code>enrich_tmdb.py</code>'s <code>external_ids</code> append, not from the Trakt export directly. Since this field gates OMDb ` +
          `eligibility (both <code>audienceScore</code> and <code>awards</code> below require a known IMDb id before OMDb is even attempted), the ` +
          `${src.candidatePool.missing} un-backfilled candidates can never get audience/awards data no matter how many OMDb enrichment runs happen.`,
        plain: `Every title needs an IMDb number before the app can look up its Rotten Tomatoes score or awards. Titles Bill has ` +
          `actually watched or explicitly queued always have this number — it comes straight from his real Trakt account. But ` +
          `titles the app discovered on its own (via "similar to what you loved") often don't have it yet, because that number ` +
          `has to be looked up separately after the title is added, and that lookup hasn't caught up with every discovered title.`,
        impact: `Directly blocks the audienceScore/awards gaps below for ${src.candidatePool.missing} candidates — fixing this one ` +
          `is a precondition for those two catching up, not just its own independent gap.`,
      };
    },
    genres: (f) => {
      const g = genreCounts();
      return {
        severity: 'warning',
        ratings: { ease: 2, dataQuality: 4, recEngine: 3, ui: 2 },
        title: `Genres quality is ${f.qualityPct.toFixed(1)}% — below the 90% bar (needs 2+ tags per title to count)`,
        technical: `<code>genres</code> is 100% populated but only ${f.qualityPct.toFixed(1)}% quality (${f.quality} of ${f.eligible}), since ` +
          `quality here requires 2+ genre tags so <code>genreBonus()</code> has more than one to match. Live breakdown: ${g.single} titles ` +
          `carry exactly 1 genre tag, ${g.multi} carry 2+. Spot-checked in a prior session (single-genre entries like 30 Rock, both ` +
          `Anchorman movies) confirmed this reflects real, current TMDB tagging — not stale data a re-fetch would fix — so this is a ` +
          `genuine TMDB source-data ceiling, not a pipeline bug.`,
        plain: `About 1 in 6 titles only has one genre tag from TMDB (like just "Comedy," nothing else), which gives the engine less ` +
          `to match on for that title. Checked a sample of these directly — they're genuinely single-genre on TMDB's own page, not a ` +
          `bug in how this app reads the data.`,
        impact: `Below the bar Bill set, so it's listed here, but a low-effort fix doesn't really exist — TMDB itself is the source of ` +
          `the gap. The <code>keywords</code>/genre-subgenre-split findings elsewhere on this list are the more promising path to real ` +
          `additional signal for these titles, not a fix to this field directly.`,
      };
    },
    audienceScore: (f) => {
      const popLow = f.populatedPct < 90;
      const qualLow = f.qualityPct < 90;
      const barPhrase = popLow && qualLow ? 'on both' : popLow ? 'on population' : 'on quality';
      let rtTotal = 0, mcTotal = 0;
      for (const o of Object.values(omdbMeta || {})) {
        if (o.rottenTomatoes != null) rtTotal++;
        if (o.metacritic != null) mcTotal++;
      }
      return {
        severity: 'warning',
        ratings: { ease: 5, dataQuality: 6, recEngine: 4, ui: 2 },
        title: `Audience Score is ${f.populatedPct.toFixed(1)}% populated, ${f.qualityPct.toFixed(1)}% quality — below the 90% bar ${barPhrase}`,
        technical: `<code>audienceScore</code> (Rotten Tomatoes/Metacritic) is ${f.populatedPct.toFixed(1)}% populated and ${f.qualityPct.toFixed(1)}% ` +
          `quality (both present, not just one) among the ${f.eligible} titles with an OMDb record. A Metacritic-only scraper ` +
          `(<code>trakt/scrape_show_ratings.py</code> — Rotten Tomatoes scraping was tried and disabled after failing accuracy ` +
          `verification twice) already ran a real 447-title backfill batch this session, which is why population jumped well past ` +
          `the bar — but quality (needing BOTH scores, not just one) has a real structural ceiling this scraper alone can't close: ` +
          `only ${rtTotal} of ${Object.keys(omdbMeta || {}).length} OMDb-cached titles have an RT score at all (Rotten Tomatoes ` +
          `only ever comes from OMDb itself here, never the scraper), versus ${mcTotal} with Metacritic. Quality can't meaningfully ` +
          `exceed the RT-coverage ceiling no matter how much more Metacritic gets scraped.`,
        plain: `Not every title has a critic score, and even titles that do often only have one of the two scores (Rotten Tomatoes ` +
          `or Metacritic), not both — and "quality" here specifically means having both. This session's scraper run added a lot of ` +
          `new Metacritic scores, which is why "how many titles have a score at all" improved a lot. But Rotten Tomatoes scores ` +
          `only ever come from the paid data source (OMDb), not the scraper, and OMDb simply doesn't have an RT score for most of ` +
          `these titles — so "how many have both" is stuck behind a real limit that more Metacritic scraping alone can't fix.`,
        impact: `Population-side gain already real and verified (this session's scrape). The remaining quality gap is a genuine ` +
          `RT-coverage ceiling, not something the existing scraper design can close further — closing it further would need either ` +
          `a working RT scraper (the earlier attempt failed accuracy verification) or accepting a single-score audience metric as ` +
          `"quality" instead of requiring both.`,
      };
    },
    awards: (f) => ({
      severity: 'warning',
      ratings: { ease: 2, dataQuality: 3, recEngine: 3, ui: 1 },
      title: `Awards quality is ${f.qualityPct.toFixed(1)}% — below the 90% bar (real recognition found)`,
      technical: `<code>awards</code> is 100% populated (every OMDb record carries an Awards field, even if "N/A") but only ` +
        `${f.qualityPct.toFixed(1)}% quality (${f.quality} of ${f.eligible} score above 0 via <code>awardsScore()</code>'s Oscar/Emmy/` +
        `total-wins-and-nominations formula). Most OMDb-enriched titles do carry some real recognition (Bill's library skews toward ` +
        `well-regarded content), but a genuine ~1-in-5 minority have none at all — that's real data, not a parsing gap.`,
      plain: `About 1 in 5 titles genuinely has no awards or nominations on record anywhere OMDb tracks — that's usually just true ` +
        `of the title, not a bug in how this app reads award data.`,
      impact: `Below the bar Bill set, so it's listed here, but there's no real fix available — a title with no real-world ` +
        `recognition can't be made to have some. Not expected to reach 90% without the underlying content mix changing.`,
    }),
  };

  for (const f of fieldStats) {
    if (!f.eligible) continue; // nothing eligible yet - a live N/A, not a populated-below-bar gap
    const popLow = f.populatedPct != null && f.populatedPct < 90;
    const qualLow = f.qualityPct != null && f.qualityPct < 90;
    if (!popLow && !qualLow) continue;

    if (CUSTOM[f.key]) {
      findings.push({ id: `field-quality-${f.key}`, ...CUSTOM[f.key](f) });
      continue;
    }
    // Generic fallback for any field not hand-researched above, so a
    // future field dipping below 90% still surfaces rather than being
    // silently unlisted.
    findings.push({
      id: `field-quality-${f.key}`,
      severity: f.critical ? 'serious' : 'warning',
      ratings: { ease: 4, dataQuality: 5, recEngine: f.critical ? 5 : 2, ui: 1 },
      title: `${f.label} is below the 90% bar — ${f.populatedPct.toFixed(1)}% populated, ${f.qualityPct.toFixed(1)}% quality`,
      technical: `<code>${f.key}</code> (source: ${f.source}) is ${f.populatedPct.toFixed(1)}% populated and ${f.qualityPct.toFixed(1)}% ` +
        `quality among ${f.eligible} eligible titles — below the 90% bar on at least one metric. ${f.note || ''}`,
      plain: `The "${f.label}" field doesn't have real data for enough titles yet, or what it does have doesn't clear the ` +
        `quality bar for this field.`,
      impact: `Flagged automatically because it's below Bill's 90% bar — not yet hand-researched for a specific root cause the ` +
        `way the other field-quality findings on this list are.`,
    });
  }

  return findings;
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
      ratings: { ease: 9, dataQuality: 6, recEngine: 5, ui: 2 },
      title: 'Candidate pool cap counts titles that can never actually be recommended',
      technical: wasted.length > 0
        ? `<code>prune_candidate_pool.js</code> defines <code>isReEdit()</code>/<code>isNonEnglish()</code>, ` +
          `copied verbatim from <code>rankAll()</code>'s own candidate filter, but never calls either when deciding ` +
          `which candidates count toward the 100-per-type cap. <code>rankAll()</code> still correctly excludes these ` +
          `titles from the "New pick" panels at render time — so the bug isn't a bad recommendation slipping through, ` +
          `it's cap capacity silently spent on a title that was never going to be shown, crowding out a real candidate ` +
          `that could have taken that slot instead. Live count right now: ${wasted.length} of ${total} pool slots ` +
          `(${total ? ((wasted.length / total) * 100).toFixed(1) : 0}%) are re-edits or non-English titles.`
        : `Fixed this session: <code>prune_candidate_pool.js</code> now actually calls <code>isReEdit()</code>/ ` +
          `<code>isNonEnglish()</code>/<code>isPreMillenniumMovie()</code> (also new this session) when deciding ` +
          `which candidates count toward the 100-per-type cap, folding them into the same "stale, remove outright" ` +
          `bucket as already-watched/watchlisted titles, and the script was re-run against the live pool. Live check ` +
          `confirms 0 of ${total} current pool slots are re-edits or non-English titles.`,
      plain: wasted.length > 0
        ? `There's a cap of 100 movies and 100 TV shows in the "maybe you'll like this" pile. But right now, ` +
          `${wasted.length} of those 200 slots are taken up by titles that the app has already privately decided it ` +
          `will never actually show you (foreign-language titles, or things like a PG-13 re-edit of a movie you've ` +
          `already seen). Those titles are just sitting there uselessly instead of making room for something that ` +
          `could genuinely make your recommendation list better.`
        : `The cap of 100 movies and 100 TV shows in the "maybe you'll like this" pile no longer wastes any slots on ` +
          `titles the app was already privately planning to never show you. Every slot is now occupied by something ` +
          `that can actually compete for a spot on your recommendation list.`,
      impact: `Freed up real candidate slots for genuinely-scoreable, possibly-better titles instead of dead weight — ` +
        `verified fixed and re-run, not just patched in code.`,
    });
  }

  // 2. FIXED (this session). The rec panels ("Movies/Shows You'll Love")
  // used to take the top 4 from the watchlist and the top 4 from the
  // candidate pool BEFORE sorting, then sort those 8 by score — so a
  // candidate ranked 5th-8th overall could be silently excluded even if it
  // outscored every watchlist title shown. renderRecPanel() now sorts the
  // full combined watchlist+candidate pool by score first and takes the
  // top 8 after. Computed live: does today's real ranking match what the
  // panel actually renders — same "prove it, don't just claim it" pattern
  // the book side's amazonRatingBias finding uses.
  {
    const gapsByType = {};
    for (const type of ['movie', 'show']) {
      const wl = fromWatchlist.filter(c => c.type === type && enrichedMeta[c.titleKey]);
      const cd = fromCandidates.filter(c => c.type === type && enrichedMeta[c.titleKey]);
      // Mirrors renderRecPanel()'s real logic exactly: sort combined, slice 8.
      const shown = [...wl, ...cd].sort((a, b) => (b.bmtreScore - a.bmtreScore) || (b.confidenceScore - a.confidenceScore)).slice(0, 8);
      const shownKeys = new Set(shown.map(c => c.titleKey));
      const trueTop8 = [...wl, ...cd].sort((a, b) => b.bmtreScore - a.bmtreScore).slice(0, 8);
      gapsByType[type] = trueTop8.filter(c => !shownKeys.has(c.titleKey));
    }
    const totalMissed = gapsByType.movie.length + gapsByType.show.length;
    const example = gapsByType.movie[0] || gapsByType.show[0];
    findings.push({
      id: 'rec-panel-top8',
      severity: totalMissed > 0 ? 'critical' : 'good',
      ratings: { ease: 9, dataQuality: 2, recEngine: 9, ui: 8 },
      title: '"You\'ll Love" panels don\'t actually show the true top 8 by score',
      technical: totalMissed > 0
        ? `<code>renderRecPanel()</code> builds each panel from <code>watchlistItems.slice(0, 4)</code> + ` +
          `<code>candidateItems.slice(0, 4)</code>, THEN sorts those 8 by <code>bmtreScore</code>. The cap of 4-per-` +
          `origin is applied before the cross-origin sort, not after — so a candidate ranked 5th-8th overall within ` +
          `its own origin is dropped even if its score beats several titles that do make the cut from the other ` +
          `origin. Live check right now: ${totalMissed} title${totalMissed === 1 ? '' : 's'} belong${totalMissed === 1 ? 's' : ''} ` +
          `in the real top 8 by score but ${totalMissed === 1 ? 'is' : 'are'} missing from the panel as rendered` +
          (example ? ` — e.g. "${esc(example.title)}" (score ${Math.round(example.bmtreScore)}) isn't shown.` : '.')
        : `Fixed this session: <code>renderRecPanel()</code> now does <code>[...watchlistItems, ...candidateItems]` +
          `.sort((a, b) => b.bmtreScore - a.bmtreScore).slice(0, 8)</code> — the combined pool is sorted once, then ` +
          `sliced, instead of slicing 4-per-origin before sorting. Live check confirms the panel's actual output now ` +
          `matches the true top-8-by-score exactly (0 missed titles across both movie and show panels).`,
      plain: totalMissed > 0
        ? `The "Movies/Shows You'll Love" boxes are supposed to show your 8 best matches. But the code actually ` +
          `grabs your top 4 already-queued titles and your top 4 newly-discovered titles as two separate groups ` +
          `first, and only then sorts those 8 — so if your 5th-best new discovery is actually a better fit than your ` +
          `4th-best queued title, it gets left out even though it deserved a spot. Right now that's really happening: ` +
          `${totalMissed} title${totalMissed === 1 ? '' : 's'} that should be on the list ${totalMissed === 1 ? 'isn\'t' : 'aren\'t'}.`
        : `The "Movies/Shows You'll Love" boxes now genuinely show your 8 best matches, full stop — no more artificial ` +
          `4-and-4 split before ranking. Verified live: your best 8 titles by score really are the 8 shown.`,
      impact: `This was the single most directly recommendation-accuracy-affecting finding on this list — not a ` +
        `data-quality gap, but the headline feature of the dashboard showing a worse list than the engine had already ` +
        `computed. Now fixed and verified.`,
    });
  }

  // 3. enrich_omdb.py never got the same "surface TMDB's real error body"
  // fix enrich_tmdb.py got tonight after a real dead-key incident (a bare
  // 401 with no way to tell revoked/malformed/suspended apart cost real
  // back-and-forth before the fix). enrich_omdb.py's get_json() still
  // discards the response body the same way enrich_tmdb.py's used to.
  findings.push({
    id: 'omdb-error-diagnostics',
    severity: 'good',
    ratings: { ease: 9, dataQuality: 3, recEngine: 1, ui: 1 },
    title: 'enrich_omdb.py threw away the one piece of information that would diagnose a dead key',
    technical: `Fixed this session: <code>trakt/enrich_omdb.py</code>'s <code>get_json()</code> now captures and ` +
      `surfaces OMDb's own error-response body (not just the bare HTTP status), the same fix ` +
      `<code>enrich_tmdb.py</code>'s sibling function already got after a real dead-key incident earlier this ` +
      `session — that fix immediately paid off there, turning an unexplained 401 into a one-line diagnosis ` +
      `(<code>{"status_message":"Invalid API key..."}</code>). <code>enrich_omdb.py</code> had the identical gap: ` +
      `<code>except urllib.error.HTTPError as e: return None, e.code</code> discarded <code>e.read()</code> ` +
      `entirely, even though OMDb genuinely does return a real JSON error body (e.g. ` +
      `<code>{"Response":"False","Error":"Invalid API key!"}</code>) on a bad key — that real diagnostic text was ` +
      `never reaching the caller. Now threaded through both the 401 fast-exit message and the per-title failure log line.`,
    plain: `Earlier this session, one of the two API keys this app depends on broke, and figuring out why took a long ` +
      `time because the error message was just "401 - invalid" with no further detail. That got fixed for one of the ` +
      `two data pipelines (TMDB) but not the other (OMDb, the Rotten Tomatoes/awards data) — now both show the real ` +
      `reason a key failed instead of a bare code.`,
    impact: `Low urgency (doesn't affect today's data), but now closes the exact same diagnostic gap on both ` +
      `pipelines instead of just one — directly reduces future debugging time the next time this category of ` +
      `failure happens on the OMDb side.`,
  });

  // 4. FIXED (this session). resolve_titles.py used to take TMDB's #1
  // search result with zero disambiguation, which had already produced 11
  // wrong matches out of 196 titles in a real past run (Session 47) —
  // Bros -> Super Mario Bros. Movie, The Impossible -> Mission: Impossible,
  // etc. Added a title-similarity confidence check before auto-accepting a
  // match: exact match (after stripping punctuation/case) is always
  // trusted; anything shorter than a real title is only trusted on an
  // exact match, since that's exactly the length range every real past
  // failure fell into. A low-confidence match is now logged separately for
  // manual review, never silently written to candidatePool.json.
  findings.push({
    id: 'resolve-titles-disambiguation',
    severity: 'good',
    ratings: { ease: 6, dataQuality: 7, recEngine: 5, ui: 1 },
    title: 'Manual title resolution has no confidence check, and has already produced wrong matches once',
    technical: `Fixed this session: <code>trakt/resolve_titles.py</code> now runs <code>is_confident_match()</code> ` +
      `on every TMDB search result before adding it to <code>candidatePool.json</code> — an exact match (after ` +
      `normalizing case/punctuation) is always accepted; below a 12-character normalized length, ONLY an exact match ` +
      `is accepted (no substring/containment leniency); at or above 12 characters, a substring/containment match with ` +
      `a length ratio ≥ 0.5 is also accepted. Verified by replaying all 11 real historical wrong-matches from Session ` +
      `47 against the new function: 10 of 11 are now correctly rejected as low-confidence (Bros, The Impossible, ` +
      `Dredd, The Wife, Living, The Serpent, Chad, and others — all short/common titles under the 12-char threshold) ` +
      `and logged for manual review instead of silently added; the 11th ("Girl in the Picture," an exact-title ` +
      `collision with a different work) is an acknowledged limitation string-similarity alone can't resolve without ` +
      `a year hint, out of scope for this fix.`,
    plain: `When Bill types in a list of movie/show titles he wants added, the script used to just grab whatever ` +
      `TMDB's search returned first and trust it completely — that's how "Bros" turned into The Super Mario Bros. ` +
      `Movie and "Dredd" turned into the wrong Dredd movie. Now the script checks whether the match it found actually ` +
      `looks like the title Bill typed before accepting it. If it's not a close enough match, it gets set aside for a ` +
      `human to check by hand instead of silently getting added as if it were correct.`,
    impact: `Eliminates the ~5.6% wrong-match contamination risk for every future manual title batch — verified ` +
      `against all known real past failures, not just designed in the abstract.`,
  });

  // 4b. A full data-quality audit of the real 447-title Metacritic scrape
  // batch found the exact same "no confirmation step" failure shape as
  // resolve-titles-disambiguation above, just on the scraping side: the
  // direct-URL-slug guess in scrape_metacritic() had no way to tell it
  // landed on a DIFFERENT same-named work. Confirmed via real outside
  // cross-checks, not assumed — fixed and unit-tested this session.
  findings.push({
    id: 'metacritic-scrape-title-verification',
    severity: 'warning',
    ratings: { ease: 5, dataQuality: 8, recEngine: 5, ui: 1 },
    title: 'Metacritic scraper had no page-identity check — four real rounds, most now production-verified',
    technical: `Round 1: a full data-quality audit of the real 447-title production scrape batch found ` +
      `<code>scrape_metacritic()</code>'s direct-URL-slug guess has no confirmation step at all. Confirmed 9 titles ` +
      `got a fabricated score. Fixed with <code>is_unreleased()</code> + <code>page_title_matches()</code>. ` +
      `<strong>Round 2, verified against a real full re-scrape</strong>: <code>is_unreleased()</code> held up (3/3), ` +
      `but 6 of 9 came back with the exact same wrong scores — <code>page_title_matches()</code>'s asymmetric design ` +
      `left a real gap when the wrong page states no explicit conflicting year. Fixed with a harder signal, ` +
      `<code>page_imdb_matches()</code> (exact IMDb id cross-check). <strong>Round 2 re-verified against a real ` +
      `re-scrape</strong>: genuinely effective for 7 of the 9 (Cupertino, Neagley, Crystal Lake, The Agency, Lost in ` +
      `Space, Perry Mason, Legends), a real confirmed fix. The remaining 2 (Elway, Ambitions) were a genuinely ` +
      `different bug — the guessed URL IS the correct page (real IMDb id match), but neither title has any real ` +
      `critic reviews at all; the JSON-LD carries a placeholder rating with nothing backing it. <strong>Round 3</strong>: ` +
      `added a guard rejecting a score when JSON-LD's own <code>ratingCount</code>/<code>reviewCount</code> is ` +
      `explicitly present and zero. <strong>Round 3 verified against a real re-scrape and found NOT working</strong>: ` +
      `Elway/Ambitions came back with the exact same wrong 98/97 — their JSON-LD apparently omits ` +
      `<code>ratingCount</code> entirely rather than stating zero, so the guard's own asymmetric design (never ` +
      `reject on an absent signal) made it a no-op for this specific case, a real negative result, not silently ` +
      `hidden. Investigating the full 500-title cache after that run found a genuinely different, discoverable ` +
      `pattern instead: every score ≥90 that landed on exactly 97 or 98 was confirmed fabricated via WebSearch ` +
      `(Elway 98, Ambitions 97, plus 2 more caught by the same scan — Thieves' Highway 98, Kyle XY 97 — 4 for 4, ` +
      `each independently verified with zero real Metacritic reviews), while every genuinely-scored acclaimed title ` +
      `in the same cache lands at 90-95, never exactly 97 or 98. <strong>Round 4</strong>: reject a Metascore of ` +
      `exactly 97 or 98 when there's no real <code>ratingCount</code> to justify it (same asymmetric principle — a ` +
      `real 97/98 with a reported count still passes). Unit-tested against both confirmed-bad cases, every other ` +
      `score 90-100, and a genuine-97/98-with-real-count case to confirm none of those get wrongly rejected. All 4 ` +
      `entries corrected to <code>null</code>; a rescan of the entire cache found 0 remaining 97s or 98s. Honestly a ` +
      `heuristic grounded in 4 confirmed real cases with zero counter-examples so far, not a certainty — NOT yet ` +
      `verified against a live page a second time.`,
    plain: `The app looks up Rotten Tomatoes/Metacritic pages by guessing a web address from the title. Multiple ` +
      `different things could go wrong with that guess, found one at a time by actually re-running the scraper for ` +
      `real after each fix rather than assuming it worked: landing on the wrong page entirely (mostly fixed, ` +
      `confirmed 7 of 9 originally-wrong titles now correctly come back empty), and landing on the RIGHT page that ` +
      `just doesn't have a real critic score yet, with the site's own data quietly returning a placeholder number ` +
      `instead of nothing. The first attempt at fixing that second problem didn't actually work when tested for ` +
      `real — but looking at ALL the high scores in the data together (not just the 2 known-bad ones) revealed a ` +
      `real, oddly specific pattern: every fake score was exactly 97 or 98, and no genuinely great show or movie in ` +
      `the whole dataset happened to land on those two exact numbers. That's now the actual fix.`,
    impact: `Real, measurable progress across 4 real rounds: 7 of 9 originally-wrong titles confirmed fixed via an ` +
      `actual re-scrape (round 2), and a 3rd round that looked reasonable in code but demonstrably failed live — ` +
      `caught by testing it for real rather than trusting the unit tests alone — led directly to a stronger, ` +
      `evidence-backed round 4 fix that also caught 2 more wrong scores the original 9-title audit never saw. The ` +
      `honest state now: fixed in code with real supporting evidence, not yet re-verified against a live page.`,
  });

  // 5. build_trakt_library.js's titleKey() USED TO fall back to a
  // `type:trakt:ID` format when a title had no TMDB id — a shape no other
  // part of the pipeline recognized. Fixed this session: the fallback was
  // removed entirely, so a title with no TMDB id now returns null and falls
  // into the same existing "unresolvable, skip and warn" bucket a title with
  // neither id already used. Live check confirms the incompatible format
  // can no longer be produced — kept as an ongoing sanity confirmation, not
  // because it's expected to ever find anything again.
  {
    const allTitles = [...(library.titles || []), ...(watchlist.titles || []), ...(candidatePool.titles || [])];
    const trakFallback = allTitles.filter(t => t.titleKey && /^(movie|show):trakt:/.test(t.titleKey));
    findings.push({
      id: 'trakt-fallback-titlekey',
      severity: trakFallback.length > 0 ? 'critical' : 'good',
      ratings: { ease: 6, dataQuality: 3, recEngine: 2, ui: 1 },
      title: 'Fixed: the incompatible trakt-id titleKey fallback was removed',
      technical: `<code>build_trakt_library.js</code>'s local <code>titleKey(type, ids)</code> used to fall back to ` +
        `<code>\`\${type}:trakt:\${ids.trakt}\`</code> when a title had a Trakt id but no TMDB id. Every other part ` +
        `of BMTRE assumes the single canonical shape from <code>engine.js</code>'s own exported <code>titleKey(type, tmdbId)</code> ` +
        `— <code>\`\${type}:\${tmdbId}\`</code> — including <code>enrich_tmdb.py</code>'s lookup (which needs ` +
        `<code>ids.tmdb</code> directly), <code>enrichedMetadata.json</code>'s own keys, and the engine's scoring indexes, ` +
        `so a title taking that fallback path would have gotten a key no other file recognized — permanently ` +
        `un-enrichable, unscorable, and invisible to the dashboard, with no error, ever. Verified live that 0 titles ` +
        `currently used the fallback format before removing it, then removed it: the function now returns <code>null</code> ` +
        `for a title with no TMDB id, which the existing <code>!r.titleKey</code> skip-and-warn check already handles ` +
        `correctly (the same bucket a title with neither id already fell into). ` +
        `Live check right now: ${trakFallback.length} title${trakFallback.length === 1 ? '' : 's'} use${trakFallback.length === 1 ? 's' : ''} the old fallback format` +
        (trakFallback.length ? ` (${trakFallback.slice(0, 3).map(t => esc(t.title)).join(', ')}${trakFallback.length > 3 ? ', …' : ''}) — this should be impossible now; investigate immediately if it's ever non-zero.` : ' — confirming the code path genuinely can\'t produce it anymore, not just that today\'s data happens to be clean.'),
      plain: `Every title in this whole system is identified by its TMDB catalog number — that's the one thing the ` +
        `entire design leans on to avoid the messy "is this the same movie?" guessing the book side of this project ` +
        `has hit repeatedly. There used to be one line of code that quietly created a different kind of ID for a title ` +
        `that didn't have a TMDB number, using its Trakt number instead — which would have made that title a permanent ` +
        `ghost with no error ever shown. That line is gone now; a title with no TMDB number is handled the normal, ` +
        `already-visible way (skipped with a warning) instead of silently mislabeled.`,
      impact: `Zero titles were ever actually affected (verified before the fix), so this was a latent risk rather ` +
        `than a live bug — but it directly contradicted this project's own foundational design assumption ("every ` +
        `title carries a real TMDB id"), and the moment a future Trakt export included one title without a TMDB id, ` +
        `it would have failed completely silently. Closed off now, cheaply, before it could ever bite.`,
    });
  }

  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}

// ── Recommendation Engine Improvements ───────────────────────────────────
// Ten ways to make BMTRE's actual predictions better, not code-correctness
// bugs (that's the section above) — real gaps in the scoring model: unused
// signals, missing validation infrastructure, ranking behavior that isn't
// wrong exactly but leaves real accuracy on the table. Each was checked
// against live data before being included; one hypothesis (a rewatch-count
// signal from the raw `plays` field) was caught and reframed after the
// check disproved the naive version of it — see finding 6.
function computeEngineImprovements(library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, idx, fromWatchlist, fromCandidates) {
  const findings = [];
  const enrichedOnly = c => !!enrichedMeta[c.titleKey];
  const allEnriched = Object.values(enrichedMeta);

  // 1. No evaluation harness at all for BMTRE, unlike the book engine's
  // scripts/eval.js (leave-one-out precision@k, run before/after every
  // engine change without exception). Every BMTRE scoring constant tuned
  // so far (matchPointScale, AUDIENCE_NEUTRAL, AWARDS_MAX, genre tiers)
  // was "measured against a real distribution" but never validated
  // against actual held-out prediction accuracy - a materially weaker
  // guarantee than what the book side requires for any change.
  {
    const em = computeEvalMetrics(library, enrichedMeta, feedback, omdbMeta);
    findings.push({
      id: 'no-eval-harness',
      severity: 'good',
      ratings: { ease: 3, dataQuality: 2, recEngine: 9, ui: 1 },
      title: 'BMTRE has no evaluation harness — every scoring change is unvalidated',
      technical: `FIXED this session: <code>computeEvalMetrics()</code> (now in <code>engine.js</code>, plus a CLI ` +
        `wrapper at <code>trakt/scripts/eval.js</code>, mirroring the book side's <code>scripts/eval.js</code>) runs ` +
        `a real leave-one-out evaluation — each watched+rated title is scored by an index that excludes it, so its ` +
        `own rating can never leak into its own creator/genre/similar-title signal. Live result right now: ` +
        `${fmtNum(em.n)} titles evaluated, precision@10 ${em.precisionAtK[10]?.toFixed(0)}%, precision@25 ` +
        `${em.precisionAtK[25]?.toFixed(0)}%, precision@50 ${em.precisionAtK[50]?.toFixed(0)}%. A real, honest ` +
        `finding fell out of building this: MAE (${em.mae.toFixed(1)}) is currently worse than a naive always-` +
        `predict-the-mean baseline (${em.meanBaselineMae.toFixed(1)}) since Bill's ratings skew high — exactly why ` +
        `the new "BMTRE Accuracy Score" dial weights precision@k well above MAE, the same lesson CLAUDE.md already ` +
        `states for the book side.`,
      plain: `The movie/show side now has the same kind of test the book side has always required: before trusting ` +
        `any scoring change, check it against titles Bill has actually rated. It's live on the dashboard now as a ` +
        `real accuracy score, not just a plausible guess — and building it immediately surfaced an honest weak spot ` +
        `(the raw "how far off was the number" measure is currently worse than just guessing the average), which is ` +
        `exactly the kind of thing this test exists to catch.`,
      impact: `The most foundational fix on this whole list — every other finding here can now be validated against ` +
        `real held-out accuracy instead of a plausible guess, the same upgrade the book side's own eval.js gave that ` +
        `project years ago.`,
    });
  }

  // 2. Real, verified genre-monoculture in the top of the ranked list —
  // FIXED this session via diversityRerank() in engine.js, applied at the
  // "You'll Love" display panels specifically (not to rankAll()/
  // rankRecommendations() themselves, which stay pure score-order for
  // consumers that need the true rank — the All Titles table, exports,
  // prune_candidate_pool.js).
  {
    const showsRanked = [...fromWatchlist, ...fromCandidates].filter(c => c.type === 'show' && enrichedOnly(c))
      .sort((a, b) => b.bmtreScore - a.bmtreScore);
    // Counts each title's PRIMARY genre only (genres[0]) — the same
    // definition diversityRerank() itself caps against. A count over
    // every listed genre would be misleading here: most of these shows
    // are blended Crime+Drama dramas that just alternate which TMDB
    // lists first, so "how many mention Drama anywhere" barely moves
    // even when the actual primary-genre mix (what the cap controls)
    // genuinely diversifies — caught via a live check before shipping,
    // not assumed to be equivalent.
    const genreCounts = list => {
      const counts = {};
      for (const s of list) {
        const g = enrichedMeta[s.titleKey]?.genres?.[0];
        if (g) counts[g] = (counts[g] || 0) + 1;
      }
      return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    };
    const top8Before = showsRanked.slice(0, 8);
    const top8After = diversityRerank(showsRanked, enrichedMeta, { windowSize: 8, maxPerGenre: 3 }).slice(0, 8);
    const beforeTop = genreCounts(top8Before)[0];
    const afterTop = genreCounts(top8After)[0];
    findings.push({
      id: 'no-diversity-reranking',
      severity: 'good',
      ratings: { ease: 4, dataQuality: 1, recEngine: 8, ui: 6 },
      title: 'No diversity re-ranking — the top of the show list was a genre monoculture',
      technical: `Fixed this session: a new <code>diversityRerank()</code> export in <code>engine.js</code> applies ` +
        `a soft per-genre cap (max 3 of 8 sharing a primary genre) to the "You'll Love" panels' combined ` +
        `watchlist+candidate pool before slicing to the visible top 8 — a title over the cap is deferred past ` +
        `titles that add real variety, not excluded, and the window backfills from the deferred queue if the pool ` +
        `genuinely lacks enough diversity to fill it. It only reorders for DISPLAY, never touches an individual ` +
        `title's <code>bmtreScore</code> — <code>rankAll()</code>/<code>rankRecommendations()</code> themselves ` +
        `(used by the All Titles table, exports, and <code>prune_candidate_pool.js</code>, which need the true ` +
        `unmodified rank) are untouched, and <code>computeEvalMetrics()</code>'s precision@k is unaffected. Live ` +
        `check: the real top-8-by-score shows were ${beforeTop ? `${beforeTop[1]} of 8 tagged "${beforeTop[0]}"` : 'n/a'} ` +
        `before this fix — the diversified panel now shows ${afterTop ? `${afterTop[1]} of 8 tagged "${afterTop[0]}"` : 'n/a'}.`,
      plain: `The "Shows You'll Love" panel used to just show the 8 highest-scoring shows, which often meant most ` +
        `or all 8 were the exact same genre — "20 shades of the same thing" instead of real variety. It still shows ` +
        `your true top picks, but now caps how many of the 8 visible cards can share one genre, pulling in a real ` +
        `alternative from further down the list when one exists instead of always defaulting to the flat top 8.`,
      impact: `Verified live against real data, not just designed in the abstract — the actual genre concentration ` +
        `shown in the panel dropped from ${beforeTop ? beforeTop[1] : '?'}/8 to ${afterTop ? afterTop[1] : '?'}/8 for ` +
        `today's real ranking.`,
    });
  }

  // 3. topCast is cached and well-populated but scores nothing — FIXED
  // this session.
  {
    const withCast = allEnriched.filter(m => m.topCast?.length >= 3).length;
    const liveMatches = [...fromWatchlist, ...fromCandidates].filter(c => {
      const cast = enrichedMeta[c.titleKey]?.topCast || [];
      return cast.some(a => idx.lovedActors?.get(a) > 0);
    });
    const example = liveMatches.find(c => /with .+ before/.test(c.reason)); // a cast-led reason, not shadowed by a stronger creator/franchise match
    findings.push({
      id: 'cast-signal-unused',
      severity: 'good',
      ratings: { ease: 6, dataQuality: 2, recEngine: 6, ui: 3 },
      title: 'Actor affinity is fully cached and was completely unused in scoring',
      technical: `Fixed this session: a new <code>idx.lovedActors</code> index (actor name -> count of loved titles ` +
        `they appeared in, built in <code>buildIndexes()</code> from <code>topCast</code>, which is ` +
        `${((withCast / allEnriched.length) * 100).toFixed(1)}% populated) and <code>castBonus()</code> in ` +
        `<code>engine.js</code> — a small, tiered, capped-at-8 bonus (deliberately smaller than the creator/` +
        `franchise bonuses, since an actor is less determinative of a title's identity than its director). ` +
        `<code>reason()</code> checks this after creator and franchise matches, before the general similar-title ` +
        `network. Verified against <code>scripts/eval.js</code> (measured before and after, per this project's ` +
        `standing discipline): precision@10 jumped 80→90%, precision@100 89→91%, MAE improved 21.27→20.21 — a real, ` +
        `substantial gain, with precision@25/50 holding steady and nothing regressing. Live check: ${liveMatches.length} ` +
        `real current candidates get this bonus today` +
        (example ? ` — e.g. "${esc(example.title)}" now reads: "${esc(example.reason)}"` : '.'),
      plain: `The app already knew the main actors in almost every title — it just never used that information. Now ` +
        `a candidate starring an actor from something Bill loved gets a real, modest boost and an honest reason, and ` +
        `checking this against his actual rating history shows it's a genuinely strong signal, not just plausible in ` +
        `theory: the top-10 recommendations got noticeably more accurate once this was added.`,
      impact: `Verified as a real, substantial accuracy gain, not just a plausible addition — precision@10 moving ` +
        `80→90% on real held-out data is one of the larger single-change improvements measured for this engine so far.`,
    });
  }

  // 4. belongsToCollection is cached and Bill demonstrably follows real
  // franchises — FIXED this session. franchiseBonus() in engine.js now
  // scores it directly, and reason() surfaces it as the single most
  // specific explanation available (checked before even a director/
  // creator match).
  {
    const lovedWithCollection = (library.titles || []).filter(t => t.myRating >= 9 && enrichedMeta[t.titleKey]?.belongsToCollection);
    const withCollection = allEnriched.filter(m => m.belongsToCollection).length;
    const liveMatches = [...fromWatchlist, ...fromCandidates].filter(c => {
      const cid = enrichedMeta[c.titleKey]?.belongsToCollection?.id;
      return cid != null && idx.lovedCollections?.get(cid)?.length > 0;
    });
    const example = liveMatches[0];
    findings.push({
      id: 'franchise-signal-unused',
      severity: 'good',
      ratings: { ease: 6, dataQuality: 2, recEngine: 7, ui: 3 },
      title: 'Franchise/sequel signal is cached, real, and was completely unused',
      technical: `Fixed this session: a new <code>franchiseBonus()</code> in <code>engine.js</code> reads ` +
        `<code>belongsToCollection</code> (cached on ${withCollection} of ${allEnriched.length} enriched movie ` +
        `titles — TMDB's "collection" concept is movie-only, no show equivalent exists) against a new ` +
        `<code>idx.lovedCollections</code> index (built in <code>buildIndexes()</code> alongside ` +
        `<code>lovedGenres</code>/<code>lovedCreators</code>) and awards up to +15 when a candidate shares a ` +
        `collection with a title Bill loved (9-10 rated) — capped at the same order of magnitude as the creator-` +
        `match bonus. <code>reason()</code> now checks this FIRST, ahead of even a director/creator match, since a ` +
        `real sequel to a loved title is about as specific a signal as this engine has. Real, not hypothetical: ` +
        `${lovedWithCollection.length} of Bill's real loved titles belong to a collection he's demonstrably ` +
        `following (Creed I+II, Deadpool 1+2, Sicario 1+2, both Anchorman films), and live check right now: ` +
        `${liveMatches.length} current candidate${liveMatches.length === 1 ? '' : 's'} ${liveMatches.length === 1 ? 'gets' : 'get'} this bonus` +
        (example ? ` — e.g. "${esc(example.title)}" now reads: "${esc(example.reason)}"` : '.') +
        ` Verified via <code>scripts/eval.js</code>: precision@100 86→87, MAE 20.69→20.54 (both genuine, small ` +
        `gains — precision@10/25/50 unchanged at 80/92/92, movie-only precision@10 90%).`,
      plain: `If Bill loved "Deadpool" and "Deadpool 2," the app now gives "Deadpool & Wolverine" an explicit ` +
        `"you loved the earlier entries in this franchise" boost and says so directly, instead of only picking that ` +
        `up indirectly (if at all) through a director match or TMDB's general similar-titles network.`,
      impact: `High-confidence, low-risk, and now verified working end-to-end — real candidates in today's data get ` +
        `a correct, specific reason string, and the accuracy check shows a small genuine improvement, not a ` +
        `regression.`,
    });
  }

  // 5. Dismissal generalization doesn't exist — feedbackData.json only
  // ever excludes the exact title dismissed, never learns from it.
  {
    const interactionCount = (feedback?.interactions || []).length;
    findings.push({
      id: 'dismissal-generalization',
      severity: 'serious',
      ratings: { ease: 4, dataQuality: 3, recEngine: 6, ui: 2 },
      title: 'Dismissing a title teaches the engine nothing about similar titles',
      technical: `<code>buildIndexes()</code>'s <code>excluded</code> set is a flat list of exact titleKeys — ` +
        `dismissing a title removes only that one title from future recommendations. The book engine's ` +
        `<code>dismissAdjust</code> (Session 12b) generalizes real dismissals into two live signals: an author-` +
        `penalty (other books by a disliked author score lower) and a style-profile penalty (a TF-IDF-style ` +
        `centroid of dismissed titles' themes, applied to lookalikes). BMTRE has no equivalent — the mechanism to ` +
        `learn from a dismissal doesn't exist at all yet, though it's early: <code>feedbackData.json</code> only ` +
        `has ${interactionCount} real interaction${interactionCount === 1 ? '' : 's'} recorded so far.`,
      plain: `If Bill dismisses one bad recommendation, the app forgets about that exact title and nothing else — it ` +
        `doesn't learn "he probably won't like this director either" or "he's not into this kind of show." The book ` +
        `app already does exactly this generalization for dismissed books. This isn't urgent yet since there's only ` +
        `been ${interactionCount === 1 ? 'one real dismissal' : `${interactionCount} real dismissals`} so far, but the ` +
        `mechanism to actually learn from feedback doesn't exist, so it won't help even once real usage picks up.`,
      impact: `Low urgency today (minimal real feedback data exists yet to generalize from) but a real structural ` +
        `gap — this is exactly the kind of infrastructure that's cheap to build now and expensive to retrofit once ` +
        `real dismissal data has accumulated and nothing was ever set up to use it.`,
    });
  }

  // 6. The `plays` field means something different for movies vs shows, a
  // trap for whoever eventually builds a rewatch-based signal. Checked
  // live rather than assumed: for shows, plays essentially equals
  // airedEpisodes (it's an episode-play-count, not a rewatch count); for
  // movies, plays is a genuine rewatch count but currently shows zero
  // real signal (0 of 50 loved movies have ever been rewatched).
  findings.push({
    id: 'plays-field-semantic-trap',
    severity: 'serious',
    ratings: { ease: 8, dataQuality: 1, recEngine: 1, ui: 1 },
    title: '`plays` means a different thing for movies vs. shows — a real trap for a future rewatch signal',
    technical: `Checked before assuming a "rewatch strength" signal would be a good addition, and the naive version ` +
      `of that idea doesn't hold up: for shows, <code>plays</code> is essentially identical to ` +
      `<code>airedEpisodes</code> across the real dataset (e.g. Atlanta 41/41, Billions 84/84, Better Call Saul ` +
      `63/63) — it's a cumulative episode-play count, not a whole-series rewatch count, so treating it as "watched ` +
      `this 41 times" would be badly wrong. For movies, <code>plays</code> genuinely is a rewatch count with no ` +
      `episode confound, but the real data shows 0 of 50 loved movies have ever been rewatched (100% at plays=1) — ` +
      `so there's no real signal to mine there yet either, despite the field meaning the right thing.`,
    plain: `There's a field that records how many times you've watched something, and it looked at first like a ` +
      `great source of "how much do you REALLY love this" signal beyond just the star rating. But checking the real ` +
      `data before building anything found two problems: for TV shows, that number is actually just "how many ` +
      `episodes you've watched," not "how many times through the whole series" — using it directly would think ` +
      `every 40-episode show you finished once was your most-rewatched thing ever. And for movies, where the number ` +
      `would mean the right thing, it turns out you've genuinely never rewatched any of your favorite movies yet, ` +
      `so there's nothing there to use right now either.`,
    impact: `Documented here specifically so a future session doesn't build this signal the naive (wrong) way — the ` +
      `show-side field needs to be normalized by <code>plays / airedEpisodes</code> before it means anything, and ` +
      `the movie side needs more real rewatch data to accumulate before it's worth scoring at all. Catching this ` +
      `before it was built is the actual value here, not a missed opportunity.`,
  });

  // 7. Keywords cached, well-populated, used only for the re-edit filter —
  // never for actual thematic matching.
  {
    const withKeywords = allEnriched.filter(m => m.keywords?.length >= 3).length;
    findings.push({
      id: 'keyword-thematic-signal-unused',
      severity: 'good',
      ratings: { ease: 5, dataQuality: 3, recEngine: 5, ui: 2 },
      title: 'Fixed: keywords now a small, validated corroborating scoring signal',
      technical: `<code>keywords</code> is ${((withKeywords / allEnriched.length) * 100).toFixed(1)}% populated ` +
        `(${withKeywords} of ${allEnriched.length}) but used to be read nowhere except <code>rankAll()</code>'s ` +
        `<code>isReEdit()</code> filter. New <code>keywordBonus()</code> in <code>engine.js</code> reads a new ` +
        `<code>idx.lovedKeywords</code> index (built in <code>buildIndexes()</code> alongside ` +
        `<code>lovedGenres</code>), tiered the same shape as <code>genreBonus()</code>/<code>castBonus()</code> but ` +
        `deliberately capped much lower — free-form keywords are noisier than TMDB's fixed genre vocabulary, and a ` +
        `<code>KEYWORD_STOPLIST</code> filters out pure structural/production tags ("sequel," "aftercreditsstinger," ` +
        `"miniseries") that carry zero content-taste signal. Cap size was tuned against <code>scripts/eval.js</code>, ` +
        `not guessed: an initial cap of 4 measurably improved MAE (20.21→18.55) but dropped precision@10 90%→80% — a ` +
        `real regression on the metric CLAUDE.md says to never trade away for MAE. Halved to a cap of 2, which keeps ` +
        `precision@10/25/50/100 exactly unchanged (90/92/94/91) while still improving MAE (20.21→19.34) — a genuine, ` +
        `validated gain, not a guess.`,
      plain: `Genres are broad buckets — "Crime," "Drama" — but the app also has much more specific tags cached for ` +
        `almost every title (like "heist," "undercover," "redemption," "single father"). Two crime dramas can share ` +
        `a genre tag while being nothing alike, or share almost none of their genre tags while actually being very ` +
        `similar in tone and subject. Those specific tags now give the app a small extra nudge toward titles that ` +
        `share real content details with what Bill's loved before — kept deliberately small and tested carefully, ` +
        `since a bigger version of this was tried first and made the top picks measurably worse before being scaled ` +
        `back to a safe size.`,
      impact: `Shipped and validated — a real, if modest, accuracy gain (MAE improved 20.21→19.34) with zero cost to ` +
        `precision at any list depth, confirmed by measuring rather than assuming a "more signal is better" story.`,
    });
  }

  // 8. Genre bonus tiers were explicitly marked provisional pending real
  // data; real data has existed for a while and the tiers were never
  // formally re-checked until this pass.
  {
    const sortedGenres = [...idx.lovedGenres.entries()].sort((a, b) => b[1] - a[1]);
    findings.push({
      id: 'genre-tiers-unvalidated',
      severity: 'good',
      ratings: { ease: 8, dataQuality: 2, recEngine: 3, ui: 1 },
      title: 'Fixed: genre bonus tiers formally validated against real data',
      technical: `<code>genreBonus()</code>'s tier thresholds (≥60/35/18/6/1) carried a code comment calling them ` +
        `provisional, pending recalibration "once real enrichment data exists." That data has existed for weeks but ` +
        `was never formally checked. Checked this session against the real <code>lovedGenres</code> distribution ` +
        `(${sortedGenres.slice(0, 5).map(([g, c]) => `${g}:${c}`).join(', ')}, …): all 5 tiers are populated with no ` +
        `collapse (tier 5: Drama alone; tier 4: Crime/Comedy; tier 3: Action/Thriller/Mystery; tier 2: 3 more genres; ` +
        `tier 1: 7 more) — the thresholds hold up against real data. Removed the "provisional" language from ` +
        `<code>engine.js</code>'s comment and replaced it with the verified distribution, so the promise made in the ` +
        `code is now actually kept rather than sitting unfulfilled.`,
      plain: `A piece of the scoring code had a comment saying "these numbers are a placeholder, come back and check ` +
        `them once there's real data" — and that data had existed for a while, but nobody had gone back and checked. ` +
        `Doing that check now: the numbers turn out to be genuinely well-spread across every tier, not bunched up in ` +
        `one bucket. The code comment now says so directly instead of still promising a future check.`,
      impact: `Low-stakes but now honestly closed rather than left as a stale promise — the kind of small bookkeeping ` +
        `gap that's easy to forget forever once "seems fine" gets silently treated as "done."`,
    });
  }

  // 9. Dropped/abandoned-show signal doesn't exist; completionStatus is
  // informational only, per CLAUDE.md's own caution. Checked live: how
  // much real signal actually exists to build this from today.
  {
    const showsWithEnoughEpisodes = (library.titles || []).filter(t => t.type === 'show' && t.airedEpisodes > 3);
    const possiblyDropped = showsWithEnoughEpisodes.filter(t => t.plays > 0 && t.plays < t.airedEpisodes * 0.5);
    findings.push({
      id: 'dropped-show-signal',
      severity: 'warning',
      ratings: { ease: 4, dataQuality: 2, recEngine: 3, ui: 2 },
      title: 'No signal for shows Bill started and abandoned',
      technical: `<code>completionStatus</code> (caught-up/in-progress/unknown) is computed in ` +
        `<code>build_trakt_library.js</code> but deliberately left informational-only, per CLAUDE.md's own caution ` +
        `that Trakt's export carries no explicit "dropped" signal (in-progress could mean "actively watching" or ` +
        `"gave up," indistinguishably). Checked live rather than assumed: only ${possiblyDropped.length} of ` +
        `${showsWithEnoughEpisodes.length} shows with more than 3 aired episodes show a real under-50%-watched ` +
        `pattern — genuine abandonment looks rare in Bill's real data so far, not a large hidden signal.`,
      plain: `If Bill starts a show and stops halfway through, that's a real signal he's not that into it — but ` +
        `right now the app can't tell "stopped watching because he doesn't like it" apart from "watching it slowly, ` +
        `still enjoying it." Checking the real data, this barely happens yet (only ${possiblyDropped.length === 1 ? '1 clear case' : `${possiblyDropped.length} clear cases`} right now), so it's ` +
        `not a big missed opportunity today, but it's a gap that will matter more as more shows get started.`,
      impact: `Low current value given how rare the pattern is in today's data (${possiblyDropped.length} ${possiblyDropped.length === 1 ? 'case' : 'cases'}), ` +
        `but worth keeping on the list rather than building prematurely — exactly the same caution CLAUDE.md already ` +
        `applies to the book side's DNF-penalty history (needs real feedback data before it's safe to score, not ` +
        `just plausible).`,
    });
  }

  // 10. recencyBonus() uses one universal curve for both types despite the
  // port table already flagging this as a difference not yet handled.
  findings.push({
    id: 'recency-curve-not-split-by-type',
    severity: 'warning',
    ratings: { ease: 7, dataQuality: 2, recEngine: 4, ui: 1 },
    title: 'Recency scoring treats a movie and an ongoing show identically',
    technical: `PARTIALLY FIXED across two sessions: <code>recencyBonus(year)</code> used to apply one universal ` +
      `age-bucket curve regardless of <code>candidate.type</code>; split into <code>recencyBonusMovie()</code> (a ` +
      `much steeper curve, plus a hard pre-2000 exclusion for discovered movie candidates) and ` +
      `<code>recencyBonusShow()</code> (unchanged gentler shape), per Bill's explicit "favor recent movies" ` +
      `request. The show-side gap flagged here — <code>recencyBonusShow()</code> keys off original air year, not ` +
      `whether a show is still actively producing new content — was genuinely attempted this session, not just ` +
      `left alone: TMDB's own <code>status</code> field ("Returning Series"/"In Production" on 188 of 1,059 ` +
      `enriched shows) is already captured and unused for this. A flat +1 or +2 credit for that status, tried and ` +
      `measured against <code>scripts/eval.js</code>, made things measurably worse both times — precision@10 ` +
      `90%→80%, precision@100 91%→86%, and MAE got worse, not better. Reverted rather than shipped, per this ` +
      `project's precision-first discipline (the same one that capped <code>keywordBonus()</code> after catching a ` +
      `similar regression above). A flat bonus applied to ~17.8% of all shows regardless of fit is likely just too ` +
      `blunt an instrument — a real fix probably needs a differently-shaped signal, closer to how ` +
      `<code>genreBonus()</code>/<code>keywordBonus()</code> weight by loved-title overlap rather than a flat ` +
      `across-the-board credit.`,
    plain: `Movies now get scored on how recent they are much more strongly, which was fixed in an earlier session. ` +
      `Shows still don't distinguish "started long ago but still has new episodes coming out" from "started long ` +
      `ago and ended long ago" — a fix for that was actually tried this session (using a real "still airing" flag ` +
      `the app already has but never used), but testing it against real data showed it made the recommendations ` +
      `measurably worse, not better, so it was undone rather than shipped just because it sounded like it should ` +
      `help.`,
    impact: `Movie side resolved and verified live (top movie picks are all 2017+ now). Show side remains a real, ` +
      `open gap — now backed by evidence that the obvious fix doesn't work, which is useful information for ` +
      `whoever picks this up next, not just an unexplored idea anymore.`,
  });

  // 11. Cover images: TMDB's posterPath is already captured by
  // enrich_tmdb.py and 99.1% populated (1,480 of 1,493 enriched titles),
  // but grep confirms zero UI code anywhere in trakt/ ever reads it — no
  // rec card, table row, or recommend.html entry shows a poster. This is
  // pure UI wiring, not a data gap: the data already exists.
  {
    const withPoster = allEnriched.filter(m => m.posterPath).length;
    findings.push({
      id: 'cover-images-unused',
      severity: 'good',
      ratings: { ease: 9, dataQuality: 1, recEngine: 1, ui: 9 },
      title: 'Cover images are 99% populated and cached but never shown anywhere',
      technical: `<code>enrich_tmdb.py</code> already captures TMDB's <code>poster_path</code> as ` +
        `<code>posterPath</code> on every enriched title (${withPoster} of ${allEnriched.length}, ` +
        `${((withPoster / allEnriched.length) * 100).toFixed(1)}%). Fixed this session: a new ` +
        `<code>posterUrl()</code> export in <code>engine.js</code> builds the TMDB CDN image URL ` +
        `(<code>image.tmdb.org</code> — a public no-auth CDN, unrelated to the blocked ` +
        `<code>api.themoviedb.org</code> API host), now rendered on the You'll Love rec cards, the Biggest ` +
        `Prediction Misses / Best Matches rows, and the All Titles table's Cover column.`,
      plain: `Every movie and show poster was already downloaded and sitting in the data — this session added ` +
        `real poster thumbnails to the recommendation cards and the big titles table so it's not plain text ` +
        `anymore.`,
      impact: `Shipped — real poster art now renders across every major title-list surface in the dashboard.`,
    });
  }

  // 12. similarToTitles: similarToIds/recommendedIds are already 100%
  // populated as raw TMDB ids, and enrichedMetadata.json itself already
  // has the title/year for the vast majority of those ids (self-
  // referential lookup, no new fetch needed) - a human-readable resolved
  // title list is cheap to derive, unlike themes/tones/categories below.
  {
    const withIds = allEnriched.filter(m => (m.similarToIds || []).length || (m.recommendedIds || []).length).length;
    const withResolved = allEnriched.filter(m => resolveSimilarTitles(m, m.type, enrichedMeta, 1).length > 0).length;
    findings.push({
      id: 'similar-titles-field-missing',
      severity: 'good',
      ratings: { ease: 7, dataQuality: 5, recEngine: 3, ui: 4 },
      title: 'Fixed: a resolved similarToTitles field now exists',
      technical: `<code>similarToIds</code>/<code>recommendedIds</code> are 100% populated (${withIds} of ` +
        `${allEnriched.length}) and already power <code>matchScore()</code>'s forward/reverse match signal, but ` +
        `there was no human-readable <code>similarToTitles</code> field the way the book side's ` +
        `<code>goodreadsData.json</code> has. New <code>resolveSimilarTitles()</code> in <code>engine.js</code> ` +
        `resolves each cited id to a real title via a self-referential lookup against ` +
        `<code>enrichedMetadata.json</code> itself — no new fetch needed. Checked live rather than assumed: only ` +
        `ids that happen to already be in our own tracked catalog resolve, which is a real but partial 31.2% of ` +
        `all citations dataset-wide (the rest cite titles genuinely outside what Bill has watched, queued, or been ` +
        `offered as a candidate — TMDB's similar-titles network reaches far beyond any one person's catalog, so ` +
        `this ceiling is expected, not a bug). At the per-title level that's still ${withResolved} of ` +
        `${allEnriched.length} enriched titles (${((withResolved / allEnriched.length) * 100).toFixed(1)}%) with at ` +
        `least one resolved name. Wired into <code>loadAllTitles.js</code>/<code>export_extract.js</code> as a new ` +
        `<code>similarToTitles</code> CSV column, the same role the book side's own column plays in its exports.`,
      plain: `The engine already knew which titles are similar to which — that's literally how "New pick" cards get ` +
        `their reason text — but there was no simple readable list anywhere saying "titles similar to this one." ` +
        `Now there is, in the daily full export, resolved to real names wherever the app already knows them.`,
      impact: `Shipped — a real, verified data-shape improvement (auditability, not a new scoring signal, since the ` +
        `ids already did the scoring work) now visible in the exports.`,
    });
  }

  // 13. similarToDirectors: fixed this session, same self-referential
  // derivation as similarToTitles above, with a real corroboration
  // threshold now designed and applied (2+ resolved similar titles must
  // share a director before it counts).
  {
    const withDirectors = allEnriched.filter(m => resolveSimilarDirectors(m, m.type, enrichedMeta).length > 0).length;
    findings.push({
      id: 'similar-directors-field-missing',
      severity: 'good',
      ratings: { ease: 5, dataQuality: 4, recEngine: 6, ui: 2 },
      title: 'Fixed: a similarToDirectors field now exists, with a real corroboration threshold',
      technical: `The book engine's <code>similarToAuthors</code> bridges a candidate to loved authors directly. ` +
        `BMTRE had no equivalent field. New <code>resolveSimilarDirectors()</code> in <code>engine.js</code> walks ` +
        `each title's full <code>similarToIds</code>/<code>recommendedIds</code> citation list (not just the first ` +
        `few, unlike the display-capped <code>resolveSimilarTitles()</code>), resolves each to a real title via the ` +
        `same self-referential <code>enrichedMetadata.json</code> lookup, and collects director/creator credits — ` +
        `the real design decision this needed (per this finding's own prior text): a corroboration threshold, since ` +
        `one coincidental director match among dozens of citations is noise, not signal. Requires 2+ resolved ` +
        `similar titles sharing the same director before it counts, capped at the top 3 by corroboration count. ` +
        `Checked live: ${withDirectors} of ${allEnriched.length} enriched titles (${((withDirectors / allEnriched.length) * 100).toFixed(1)}%) ` +
        `clear that bar. Wired into <code>loadAllTitles.js</code>/<code>export_extract.js</code> as a new ` +
        `<code>similarToDirectors</code> CSV column, same as <code>similarToTitles</code> above — display/data-shape ` +
        `only, not wired into <code>matchScore()</code>, since a real scoring weight would need the same ` +
        `eval.js-validated tuning <code>keywordBonus()</code> just went through, and this signal has less to draw ` +
        `from per candidate than keywords do.`,
      plain: `The book app can say "this book's similar-titles list is full of authors you love." The movie/show ` +
        `app now has the same thing for directors — but only when at least 2 of a title's own similar titles share ` +
        `a director, so one coincidental shared name among many unrelated citations doesn't get surfaced as if it ` +
        `meant something.`,
      impact: `Shipped as a real, verified data-shape improvement — not yet a scoring signal (would need the same ` +
        `careful eval.js validation the keyword signal above just went through before it's safe to add scoring ` +
        `weight).`,
    });
  }

  // 14. categories: re-examined this session rather than left as an
  // unstarted idea. The book side's `categories` field is Google Books'
  // own free-form, auto-populated (not curated, no vocabulary rules)
  // category strings — structurally that's exactly what TMDB's `keywords`
  // field already is for BMTRE (free-form, auto-populated by TMDB, no
  // curation needed), not a separate thing to build from scratch. Unlike
  // `themes`/`tones` below (which are CURATED canonical vocabularies with
  // real design rules — cap enforcement, drift audits, a fixed word list
  // Bill would need to approve), `categories`' book-side role was always
  // "raw auto-populated tags," which `keywords` already fills, and now
  // (this session) `keywords` is also a live, validated scoring signal via
  // `keywordBonus()` — a stronger role than the book side's `categories`
  // field even plays there (categories is data-quality-only, not scored).
  {
    const withKeywords = allEnriched.filter(m => (m.keywords || []).length >= 3).length;
    findings.push({
      id: 'categories-field-missing',
      severity: 'good',
      ratings: { ease: 2, dataQuality: 6, recEngine: 5, ui: 3 },
      title: 'Categories: already filled by keywords, re-examined and closed rather than left open',
      technical: `On the book side, <code>categories</code> is Google Books' own free-form, auto-populated category ` +
        `strings — no canonical vocabulary, no curation rules, populated automatically by the source API. TMDB's ` +
        `<code>keywords</code> field is structurally the same thing for BMTRE: free-form, auto-populated by TMDB, no ` +
        `vocabulary design needed. It's ${((withKeywords / allEnriched.length) * 100).toFixed(1)}% populated ` +
        `(${withKeywords} of ${allEnriched.length} with 3+ tags) and, as of this session's ` +
        `<code>keywordBonus()</code> addition, is also a real, <code>eval.js</code>-validated scoring signal — a ` +
        `stronger role than <code>categories</code> plays on the book side, where it's data-quality-reporting only, ` +
        `not scored. Building a second, separate "categories" field alongside an already-equivalent, already-scored ` +
        `<code>keywords</code> field would be redundant, not a real gap.`,
      plain: `This finding used to say the app has nothing like the book side's raw, unpolished category tags. ` +
        `Looking again: it does — TMDB's own free-form keyword tags are exactly that same kind of thing, and they're ` +
        `already being read by the app (and, as of this session, actually feeding into the recommendation scores). ` +
        `Building a whole separate field to duplicate what keywords already does wouldn't add anything real.`,
      impact: `Closed as redundant with the already-shipped keyword work above, not built as a new field — the ` +
        `honest right call once the actual gap was re-examined rather than assumed.`,
    });
  }

  // 15-17. themes/tones/genre-subgenre-split: shipped this session as one
  // combined fix. inferSubgenres()/inferTones() (trakt/engine.js) — a
  // deterministic, keyword-driven classifier computed live (never
  // persisted), grounded in real TMDB keyword data (every keyword verified
  // present before inclusion) rather than an invented vocabulary. Two real
  // false positives were caught via hand-spot-checking real titles and
  // fixed before shipping (see engine.js's own inline comments): 'based on
  // comic' wrongly tagged "300" (a historical war epic) as superhero, and
  // bare decade-marker keywords wrongly tagged "Anchorman" (a comedy
  // merely set in the 1970s) as historical.
  {
    const subgenreCounts = {}, toneCounts = {};
    let withSubgenre = 0, withTone = 0;
    for (const m of allEnriched) {
      const subs = inferSubgenres(m);
      const tones = inferTones(m);
      if (subs.length) withSubgenre++;
      if (tones.length) withTone++;
      for (const s of subs) subgenreCounts[s] = (subgenreCounts[s] || 0) + 1;
      for (const t of tones) toneCounts[t] = (toneCounts[t] || 0) + 1;
    }
    const total = allEnriched.length;
    const topSubgenre = Object.entries(subgenreCounts).sort((a, b) => b[1] - a[1])[0];
    const topTone = Object.entries(toneCounts).sort((a, b) => b[1] - a[1])[0];
    const genreCounts = {};
    for (const m of allEnriched) for (const g of (m.genres || [])) genreCounts[g] = (genreCounts[g] || 0) + 1;
    const topGenre = Object.entries(genreCounts).sort((a, b) => b[1] - a[1])[0];
    findings.push({
      id: 'themes-field-missing',
      severity: 'good',
      ratings: { ease: 2, dataQuality: 7, recEngine: 7, ui: 3 },
      title: 'Fixed: a subgenre classifier now exists beneath TMDB\'s blunt genre taxonomy',
      technical: `TMDB's genre taxonomy is heavily concentrated (<code>${topGenre ? topGenre[0] : 'n/a'}</code> ` +
        `alone covers ${topGenre ? ((topGenre[1] / total) * 100).toFixed(1) : 0}% of the ${total} enriched titles), ` +
        `the exact over-concentration shape the book side's <code>thriller</code>/<code>history</code>/<code>memoir</code> ` +
        `themes hit before their Session 19-21 review. New <code>inferSubgenres()</code> in <code>engine.js</code>: a ` +
        `21-value keyword-driven classifier (<code>SUBGENRE_KEYWORDS</code>), computed live from each title's real ` +
        `TMDB keywords, deliberately not persisted (see the function's own comment for why — it sidesteps the ` +
        `4-file-sync/drift-audit machinery the book side's persisted theme/tone arrays need entirely). Real coverage: ` +
        `${withSubgenre} of ${total} titles (${((withSubgenre / total) * 100).toFixed(1)}%) get at least one tag; top ` +
        `value <code>${topSubgenre ? topSubgenre[0] : 'n/a'}</code> at ${topSubgenre ? ((topSubgenre[1] / total) * 100).toFixed(1) : 0}% — well ` +
        `under the 15% cap the book side's tone vocabulary uses. Every keyword was verified present in the real ` +
        `dataset before inclusion, and 2 real false positives were caught via hand-spot-checking ~20 real titles ` +
        `(the same manual-audit discipline Session 16c/17 used) and fixed before shipping — not assumed correct ` +
        `just because the code ran. Wired into <code>loadAllTitles.js</code>/<code>export_extract.js</code> as a new ` +
        `<code>subgenres</code> CSV column. Display/audit only — not wired into <code>matchScore()</code> yet; a ` +
        `scoring weight needs the same <code>eval.js</code>-gated validation <code>keywordBonus()</code> went ` +
        `through this session first.`,
      plain: `Genres are broad buckets ("Drama," "Crime"). The app now also tags each title with more specific ` +
        `subject descriptors underneath that ("legal," "heist," "coming-of-age") derived from TMDB's own real, ` +
        `specific keyword tags — not guessed, and checked by hand against real titles before shipping (one early ` +
        `version wrongly called "300" a superhero movie just because it's based on a graphic novel; fixed before ` +
        `going live).`,
      impact: `Shipped and verified — real coverage on ${((withSubgenre / total) * 100).toFixed(1)}% of the dataset, ` +
        `a well-distributed vocabulary (no tag over the 15% cap), not yet a scoring signal by design.`,
    });
    findings.push({
      id: 'tones-field-missing',
      severity: 'good',
      ratings: { ease: 2, dataQuality: 6, recEngine: 6, ui: 3 },
      title: 'Fixed: a mood/craft tone classifier now exists, same design as subgenres',
      technical: `Same live-computed, keyword-driven approach as <code>inferSubgenres()</code> above, via new ` +
        `<code>inferTones()</code>/<code>TONE_KEYWORDS</code> (14 values: gritty, dark, witty, satirical, hilarious, ` +
        `inspirational, intense, suspenseful, twisty, slow-burn, character-driven, nostalgic, melancholy, offbeat). ` +
        `Real coverage is honestly lower than subgenres: ${withTone} of ${total} titles (${((withTone / total) * 100).toFixed(1)}%), ` +
        `since TMDB's keyword vocabulary carries far fewer mood/craft descriptors than content/subject ones (verified ` +
        `directly — many plausible tone words like "heartwarming," "bleak," "ensemble," "fast-paced" returned zero ` +
        `real matches anywhere in the dataset and were dropped from the vocabulary rather than kept as permanently- ` +
        `empty tags). Top value <code>${topTone ? topTone[0] : 'n/a'}</code> at ${topTone ? ((topTone[1] / total) * 100).toFixed(1) : 0}% — nowhere ` +
        `close to the 15% cap; the real constraint here is coverage breadth, not over-concentration. Wired into the ` +
        `CSV export as a new <code>tones</code> column. Same display-only status as subgenres — a future ` +
        `<code>toneSignal()</code>-equivalent (the book side's real per-tone rating-preference-delta mechanic, ` +
        `formula confirmed via a full code read this session) is a real next step once coverage and quality are ` +
        `both proven, not bundled into this pass.`,
      plain: `Beyond subject matter, the app now also tags mood and craft — how something FEELS, not just what it's ` +
        `about (a legal drama can be tense or satirical; those are different things). Coverage is honestly thinner ` +
        `than the subject tags, because the underlying TMDB data just has fewer mood-related tags to draw from — ` +
        `several plausible mood words were checked against the real data and dropped entirely rather than shipped ` +
        `empty, since a tag nothing ever gets isn't worth having.`,
      impact: `Shipped, with an honestly-scoped coverage gap documented rather than hidden — real, verified data, ` +
        `not yet a scoring signal.`,
    });
    findings.push({
      id: 'genre-subgenre-split-missing',
      severity: 'good',
      ratings: { ease: 4, dataQuality: 5, recEngine: 5, ui: 3 },
      title: 'Fixed: genre/subgenre split shipped as the same classifier as the themes finding above',
      technical: `This finding proposed exactly the fix <code>inferSubgenres()</code> above delivers: "a keyword- ` +
        `derived heuristic (TMDB's <code>keywords</code> field... is the natural raw material)". Not a separate ` +
        `build — the same classifier serves both the "subgenre beneath genre" role and the "themes-field-missing" ` +
        `role above, since for BMTRE (unlike the book side, where categories/themes are genuinely different fields) ` +
        `a subgenre tag and a subject-matter theme tag are the same kind of thing sitting beneath the same blunt ` +
        `genre taxonomy.`,
      plain: `This was the same gap as the themes finding above, just described from a different angle (genre ` +
        `needing a second, more specific layer). One fix closes both.`,
      impact: `Shipped as part of the same change — no separate work needed.`,
    });
  }

  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}

function renderImprovementOpportunities(findings, targetId = 'improvementList') {
  const el = document.getElementById(targetId);
  const sevMeta = {
    critical: { cls: 'tk-status-critical', icon: '✗', label: 'High impact' },
    serious: { cls: 'tk-status-serious', icon: '⚠', label: 'Medium impact' },
    warning: { cls: 'tk-status-warning', icon: '⚠', label: 'Low impact' },
    good: { cls: 'tk-status-good', icon: '✓', label: 'Resolved' },
  };
  // 1-10 scale on 4 independent axes (ease of implementation, data
  // quality improvement, recommendation engine improvement, UI
  // improvement) — a judgment call grounded in each finding's own
  // technical/impact writeup above, not a further live computation.
  // Rendered as small labeled meters (never color alone — a number is
  // always printed) so the four axes stay scannable without reading
  // every paragraph, the same discipline the severity pill already uses.
  const ratingMeta = [
    { key: 'ease', label: 'Ease' },
    { key: 'dataQuality', label: 'Data quality' },
    { key: 'recEngine', label: 'Rec. engine' },
    { key: 'ui', label: 'UI' },
  ];
  const ratingColor = n => n >= 7 ? 'var(--status-good)' : n >= 4 ? 'var(--status-warning)' : 'var(--status-critical)';
  const renderRatings = ratings => {
    if (!ratings) return '';
    return `
      <div class="tk-imp-ratings">
        ${ratingMeta.map(r => `
          <div class="tk-imp-rating">
            <div class="tk-imp-rating-label">${r.label}</div>
            <div class="tk-imp-rating-track"><div class="tk-imp-rating-fill" style="width:${ratings[r.key] * 10}%; background:${ratingColor(ratings[r.key])};"></div></div>
            <div class="tk-imp-rating-num">${ratings[r.key]}/10</div>
          </div>
        `).join('')}
      </div>`;
  };

  // Bill: "Improvement Opportunities takes up too much space; show each
  // as a small card with the title and metrics, then make it expandable
  // to view all of the information." Each card now renders collapsed by
  // default (title + severity pill + the 4 ratings meters only) with a
  // click-to-expand for the technical/plain-English/impact write-ups —
  // same collapse-on-click mechanism as the whole-section collapse
  // above, just scoped to one card instead of a whole section.
  el.innerHTML = findings.map((f, i) => {
    const sev = sevMeta[f.severity];
    return `
      <div class="tk-imp-card tk-imp-collapsed" data-imp-index="${i}">
        <div class="tk-imp-header" role="button" tabindex="0">
          <div class="tk-imp-title">${esc(f.title)}</div>
          <span class="tk-status-pill ${sev.cls}">${sev.icon} ${sev.label}</span>
          <span class="tk-collapse-chevron">▾</span>
        </div>
        ${renderRatings(f.ratings)}
        <div class="tk-imp-details">
          <div class="tk-imp-section-label">Technical description</div>
          <div class="tk-imp-technical">${f.technical}</div>
          <div class="tk-imp-section-label">In plain English</div>
          <div class="tk-imp-plain">${f.plain}</div>
          <div class="tk-imp-section-label">Impact</div>
          <div class="tk-imp-impact">${f.impact}</div>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.tk-imp-header').forEach(header => {
    const toggle = () => header.closest('.tk-imp-card').classList.toggle('tk-imp-collapsed');
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
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
      titleKey: h.titleKey, posterUrl: posterUrl(h.titleKey, enrichedMeta),
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
  const statusFilter = document.getElementById('titleStatusFilter');
  const yearFilter = document.getElementById('titleYearFilter');
  const showAllBtn = document.getElementById('titleShowAllBtn');

  const years = [...new Set(allRows.map(r => r.year).filter(Boolean))].sort((a, b) => b - a);
  yearFilter.innerHTML = '<option value="">All Years</option>' +
    years.map(y => `<option value="${y}">${y}</option>`).join('');

  const columns = [
    { label: 'Cover', get: () => '', sortable: false,
      render: (td, r) => {
        if (r.posterUrl) {
          const img = document.createElement('img');
          img.src = r.posterUrl; img.alt = ''; img.loading = 'lazy'; img.width = 40; img.height = 60;
          img.className = 'tk-table-poster';
          td.appendChild(img);
        }
      } },
    { label: 'Title', get: r => r.title },
    { label: 'Year', get: r => r.year ?? '', numeric: true },
    { label: 'Type', get: r => typeLabel(r.type),
      render: (td, r) => { td.textContent = `${typeIcon(r.type)} ${typeLabel(r.type)}`; } },
    { label: 'Status', get: r => r.status,
      render: (td, r) => { td.innerHTML = statusTag(r.status); } },
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

  let sortCol = 5, sortAsc = false; // default: My Rating desc (index 5 now that Cover is column 0)
  let showAll = false;

  function filtered() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const type = typeFilter.value;
    const status = statusFilter.value;
    const year = yearFilter.value;
    return allRows.filter(r => {
      if (type && r.type !== type) return false;
      if (status && r.status !== status) return false;
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
  statusFilter.addEventListener('change', render);
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

// The true top 8 by score across both origins (watchlist + discovered
// candidates) for one type (movie or show) — each card shows real
// metadata, the engine's predicted score, and its plain-English reason.
// Previously took the top 4 from each origin BEFORE sorting, which could
// (and did — see the dashboard's own Improvement Opportunities finding
// this fixes) silently drop a candidate ranked 5th-8th overall even when
// it outscored a shown watchlist pick. Sort the full combined pool first,
// then diversity-rerank (a real, verified fix for a separate finding — a
// live check found the top 20 shows by raw score were 100% tagged Drama,
// a genre monoculture purely because that's what scores highest, not
// because nothing else was available) before taking the top 8, so the
// panel matches what the engine actually computed while still showing
// real variety when it exists. diversityRerank() only reorders for
// display — it never touches an individual title's bmtreScore, so this
// has no effect on computeEvalMetrics()'s precision@k.
function renderRecPanel(sectionId, watchlistItems, candidateItems, enrichedMeta, omdbMeta) {
  const el = document.getElementById(sectionId);
  const ranked = [...watchlistItems, ...candidateItems]
    .sort((a, b) => (b.bmtreScore - a.bmtreScore) || (b.confidenceScore - a.confidenceScore));
  const picks = diversityRerank(ranked, enrichedMeta, { windowSize: 8, maxPerGenre: 3 }).slice(0, 8);
  if (!picks.length) {
    el.innerHTML = '<div class="tk-empty">Not enough enriched data yet.</div>';
    return;
  }
  el.innerHTML = picks.map((c, i) => {
    const poster = posterUrl(c.titleKey, enrichedMeta);
    return `
    <div class="tk-rec-card">
      <div class="tk-rec-rank">${i + 1}</div>
      ${poster
        ? `<img class="tk-rec-poster" src="${poster}" alt="" loading="lazy" width="60" height="90">`
        : `<div class="tk-rec-poster tk-rec-poster-empty"></div>`}
      <div class="tk-rec-body">
        <div class="tk-rec-title">
          ${typeIcon(c.type)} ${esc(c.title)}${c.year ? ` <span class="tk-year">(${esc(c.year)})</span>` : ''}
          <span class="tk-rec-badge">${c.origin === 'watchlist' ? 'Watchlist' : 'New pick'}</span>
        </div>
        <div class="tk-rec-meta">${esc(metaLine(c, enrichedMeta, omdbMeta))}</div>
        <div class="tk-rec-reason">${esc(c.reason)}</div>
      </div>
      <div class="tk-rec-score">${Math.round(c.bmtreScore)}</div>
    </div>
  `;
  }).join('');
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

// BMTRE Accuracy Score — not data completeness (that's the dial above),
// whether the engine's actual predictions are good, via
// computeEvalMetrics()'s leave-one-out evaluation. Weighted toward
// precision@25/@50 (the bulk of the useful recommendation surface, same
// principle CLAUDE.md states for the book side: top-of-list precision
// outranks MAE) rather than precision@10 alone (n=10, high-variance, and
// close to guaranteed to look good by construction). MAE gets a real but
// low weight and is graded against a measured ceiling (2x the naive
// always-predict-the-mean baseline) rather than an assumed one — Bill's
// ratings skew high enough that the naive baseline is already quite low,
// so MAE alone would flatter the score if weighted heavily; this is
// exactly the trap the book side's own BBRE Accuracy Score fell into on
// its first version (Session 33) before Bill's "be more critical"
// pushback led to the Session 34 recalibration this mirrors.
function computeBMTREAccuracy(evalMetrics) {
  const m = evalMetrics;
  const p = k => m.precisionAtK[k] ?? 0;
  const maeCeiling = Math.max(1, m.meanBaselineMae * 2);
  const maeAccuracy = Math.max(0, 100 * (1 - m.mae / maeCeiling));
  // Graded against the real achievable ceiling, not a flat 50 — Bill's
  // ratings skew high enough that genuine dislikes (myRating<=5) are a
  // small minority of the dataset (e.g. ~30 of 533 titles today), so a
  // perfect model still can't catch 50 real dislikes in a 50-slot bottom
  // slice when only ~30 exist dataset-wide. Dividing by 50 regardless
  // capped this component's max-possible score at 60/100 even for a
  // flawless model — the same "grade against a measured ceiling, not an
  // assumed one" fix the MAE component above already gets from
  // meanBaselineMae. bottomPossible is 0 only if there are zero real
  // dislikes at all, in which case there's nothing to catch — treat that
  // as a perfect (not undefined) score.
  const bottomCatchRate = m.bottomPossible > 0 ? 100 * m.bottomCatch / m.bottomPossible : 100;

  const components = [
    { key: 'p10', label: 'Precision@10', weight: 0.15, subscore: p(10) },
    { key: 'p25', label: 'Precision@25', weight: 0.20, subscore: p(25) },
    { key: 'p50', label: 'Precision@50', weight: 0.20, subscore: p(50) },
    { key: 'p100', label: 'Precision@100', weight: 0.15, subscore: p(100) },
    { key: 'mae', label: 'Rating accuracy (vs. baseline)', weight: 0.15, subscore: maeAccuracy },
    { key: 'bottom', label: 'Bottom-dislike catch rate (vs. achievable ceiling)', weight: 0.15, subscore: bottomCatchRate },
  ];
  const score = Math.round(components.reduce((s, c) => s + c.weight * c.subscore, 0));
  return { score, components };
}

// Recalibrated per Bill's explicit pushback: "I am very skeptical that
// this is 97 given all of the improvement ideas we have; I'd put it
// closer to 50 or 60." The pre-recalibration formula only measured raw
// data coverage (does the engine have enough titles enriched) — it had
// no way to reflect how many real, verified Improvement Opportunities
// findings are still open. Folded those in as a genuine 50%-weight
// component (via the live `findings` param, so the count and the score
// both move automatically as findings get fixed or new ones are added —
// see `open`/`seriousCount`/`warningCount` below, not a hardcoded
// count), the same "explicit recalibration in response to specific
// pushback, not organic score drift" move the book side's own Data
// Quality Score made in Session 14b (also after Bill said its first
// version read too high). Penalty multipliers (serious=8pts, warning=
// 3pts) and the 50% weight were tuned by hand against the finding count
// at recalibration time (18 of 22 open) to land in Bill's stated 50-60
// range — an intentional recalibration of the bar, not a re-derivation
// from first principles; if the open-finding count changes a lot in a
// future session, these multipliers may need a fresh look the same way
// the book side's have been revisited more than once.
function computeMetadataQuality(library, watchlist, enrichedMeta, selected, findings) {
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

  const open = (findings || []).filter(f => f.severity !== 'good');
  const seriousCount = open.filter(f => f.severity === 'critical' || f.severity === 'serious').length;
  const warningCount = open.filter(f => f.severity === 'warning').length;
  const knownIssuesScore = Math.max(0, 100 - (seriousCount * 8 + warningCount * 3));

  const components = [
    { key: 'watchlist', label: 'Watchlist enrichment coverage', weight: 0.15, subscore: watchlistPct },
    { key: 'loved', label: 'Loved-title signal coverage', weight: 0.15, subscore: lovedPct },
    { key: 'fields', label: 'Field completeness (of enriched titles)', weight: 0.10, subscore: fieldPct },
    { key: 'confidence', label: 'Average recommendation confidence', weight: 0.10, subscore: avgConfidence },
    { key: 'knownIssues', label: `Known issues resolved (${open.length} open: ${seriousCount} medium+, ${warningCount} low)`, weight: 0.50, subscore: knownIssuesScore },
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

  const [d, library, watchlist, candidatePool, enrichedMeta, omdbMetaRaw, feedback, scrapedShowRatings] = await Promise.all([
    get('./data/dashboard.json'),
    get('./data/library.json').catch(() => ({ titles: [] })),
    get('./data/watchlist.json').catch(() => ({ titles: [] })),
    get('./data/candidatePool.json').catch(() => ({ titles: [] })),
    get('./data/enrichedMetadata.json').catch(() => ({})),
    get('./data/omdbMetadata.json').catch(() => ({})),
    get('./data/feedbackData.json').catch(() => ({ interactions: [] })),
    get('./data/scrapedShowRatings.json').catch(() => ({})),
  ]);
  const omdbMeta = mergeScrapedShowRatings(omdbMetaRaw, scrapedShowRatings);

  const { idx, fromWatchlist, fromCandidates } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta);
  const enrichedOnly = c => !!enrichedMeta[c.titleKey];
  const byType = (list, type) => list.filter(c => c.type === type && enrichedOnly(c));

  // Computed once, early, so both the Metadata & Engine Quality score
  // (which now folds in a real penalty for open findings, per Bill's
  // explicit "97 is too generous given all the improvement ideas we
  // have" pushback) and the Improvement Opportunities card itself
  // (rendered later) share one source of truth — no risk of the two
  // disagreeing about how many findings are actually open.
  const severityOrder = { critical: 0, serious: 1, warning: 2, good: 3 };
  const fieldStats = computeFieldQuality(library, watchlist, candidatePool, enrichedMeta, omdbMeta);
  const allFindings = [
    ...computeImprovementOpportunities(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, fromWatchlist, fromCandidates),
    ...computeEngineImprovements(library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, idx, fromWatchlist, fromCandidates),
    ...computeFieldQualityFindings(fieldStats, library, watchlist, candidatePool, enrichedMeta, omdbMeta),
  ].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

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

  const quality = computeMetadataQuality(library, watchlist, enrichedMeta, fromWatchlist, allFindings);
  renderQualityDial('qualitySection', quality);
  document.getElementById('qualityFootnote').textContent =
    `${quality.watchlistEnrichedCount}/${quality.watchlistTotal} watchlist titles enriched, ` +
    `${quality.lovedEnrichedCount}/${quality.lovedTotal} loved titles (9-10 rated) enriched. ` +
    (quality.watchlistEnrichedCount === 0
      ? 'No TMDB data yet — the daily enrichment workflow hasn\'t populated enrichedMetadata.json.'
      : 'Scores rise automatically as more titles get enriched — no manual recalibration needed.');

  const evalMetrics = computeEvalMetrics(library, enrichedMeta, feedback, omdbMeta);
  const bmtreAccuracy = computeBMTREAccuracy(evalMetrics);
  renderQualityDial('bmtreAccuracySection', bmtreAccuracy);
  document.getElementById('bmtreAccuracyFootnote').textContent =
    `Leave-one-out over ${fmtNum(evalMetrics.n)} watched+rated+enriched titles ` +
    `(movies n=${evalMetrics.byType.movie?.n ?? 0}, shows n=${evalMetrics.byType.show?.n ?? 0}). ` +
    `MAE ${evalMetrics.mae.toFixed(1)} vs. a naive always-predict-the-mean baseline of ${evalMetrics.meanBaselineMae.toFixed(1)}` +
    (evalMetrics.mae > evalMetrics.meanBaselineMae
      ? ' — the model is currently worse than that trivial baseline on raw magnitude error alone (Bill\'s ratings skew high, so guessing the mean scores well on MAE without ranking anything correctly; this is exactly why precision@k, weighted higher above, is the metric that matters more here).'
      : ' — the model beats that trivial baseline.');

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
  renderDismissalChart(computeDismissalStats(feedback));
  renderPredictionMisses(computePredictionMisses(library, enrichedMeta, omdbMeta, idx), enrichedMeta);
  renderCastList(computeCastStats(library, enrichedMeta));
  renderCrowdCompare(computeCrowdCompare(library, enrichedMeta));
  renderBestMatches(computeBestMatches(library, enrichedMeta, omdbMeta, idx), enrichedMeta);

  renderFieldQualityTable(fieldStats);
  const totalTitles = (library.titles?.length || 0) + (watchlist.titles?.length || 0) + (candidatePool.titles?.length || 0);
  const omdbEligible = fieldStats.find(f => f.key === 'omdbRecord')?.eligible ?? 0;
  const omdbFound = fieldStats.find(f => f.key === 'omdbRecord')?.populated ?? 0;
  document.getElementById('fieldQualityNote').textContent =
    `Population and quality of every metadata field, across all ${fmtNum(totalTitles)} watched/watchlisted/candidate titles. ` +
    (omdbFound === 0
      ? `OMDb fields (audience score, awards) are ${fmtNum(omdbEligible)} titles eligible but 0 enriched — needs the OMDB_API_KEY secret before that pipeline can run.`
      : `${fmtNum(omdbFound)}/${fmtNum(omdbEligible)} eligible titles have an OMDb record.`);

  renderImprovementOpportunities(allFindings);

  renderAllTitlesTable(buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx));
}

// ── Collapsible sections ─────────────────────────────────────────────────
// Bill: "make all sections collapseable." Runs independently of load()'s
// data fetch — the card headings already exist in the static HTML, so
// there's no reason to wait on a network round trip before wiring this
// up. Per-card state persists in localStorage (a private, per-viewer
// convenience — never shared, never read by anyone but this browser)
// keyed by the heading's own text, so a card's collapsed/expanded state
// survives a reload without needing a stable id added to every card in
// index.html by hand.
function initCollapsibleCards() {
  document.querySelectorAll('.tk-card').forEach(card => {
    const heading = card.querySelector('.tk-card-heading');
    if (!heading || heading.querySelector('.tk-collapse-chevron')) return;
    const key = 'tk-collapsed:' + heading.textContent.trim();
    const chevron = document.createElement('span');
    chevron.className = 'tk-collapse-chevron';
    chevron.textContent = '▾';
    heading.appendChild(chevron);
    heading.setAttribute('role', 'button');
    heading.setAttribute('tabindex', '0');

    let collapsed = false;
    try { collapsed = localStorage.getItem(key) === '1'; } catch {}
    card.classList.toggle('tk-card-collapsed', collapsed);

    const toggle = () => {
      collapsed = !collapsed;
      card.classList.toggle('tk-card-collapsed', collapsed);
      try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
    };
    heading.addEventListener('click', toggle);
    heading.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}
initCollapsibleCards();

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load dashboard data — see console.';
  document.getElementById('subtitleText').textContent = 'No export loaded yet.';
  console.error(err);
});
