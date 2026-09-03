// Discover — "help me find something to watch." Bill: "split the dashboard
// into three focused pages... the main one should focus on helping me find
// new things to watch... make sure the main one is fun with new features."
// Split out of the original single-page trakt/dashboard.js; the data-quality
// half (score dials, field population, Improvement Opportunities) moved to
// trakt/quality.js — see that file's own header for why.
//
// Deliberately does NOT call computeEvalMetrics() — a multi-second
// leave-one-out pass only the accuracy dial (Quality) needs. Leaving it off
// this page is the single biggest user-visible speed win of the split.

import {
  rankAll, matchScore, hydrateTitle, popularityScore, criticScore, realAudienceScore,
  awardsScore, posterUrl, diversityRerank, inferSubgenres, inferSubjects, inferEra,
  isActivelyAiring, traktUrl,
} from './engine.js';
import {
  esc, fmtNum, fmtCompact, posterImgHtml, typeIcon, typeLabel, titleLink, statusTag,
  airingBadge, renderHBarChart, computeGenreStats, displaySubgenre, SUBJECT_LABEL,
  ERA_LABEL, downloadCSV, metaLine, scoreTier, initCollapsibleCards, loadAllData,
  predictedVsActualRows,
} from './dashboardShared.js';

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

// Row-building shared with Prediction Misses (Quality) via
// predictedVsActualRows() so the two pages can never disagree about a
// title's predicted score.
function computeBestMatches(library, enrichedMeta, omdbMeta, idx) {
  const rows = predictedVsActualRows(library, enrichedMeta, omdbMeta, idx);
  const matches = rows.filter(r => r.predicted >= 70 && r.actual >= 80).sort((a, b) => b.predicted - a.predicted);
  return { total: rows.length, matches };
}

// ── Predicted-score distribution (unwatched titles) ─────────────────────
// Movies and shows are kept as separate small multiples rather than one
// combined histogram — their real means differ enough (movies ~43,
// shows ~56, from a thinner loved-movie source pool per CLAUDE.md) that
// merging them would blur a real, worth-seeing difference, the same
// small-multiples-over-one-crowded-chart call the genre/year charts made.


function renderGenreChart(stats) {
  renderHBarChart('genreChart',
    stats.map(g => ({ genre: `${g.genre} (${g.count})`, avg: g.avg })),
    { labelKey: 'genre', valueKey: 'avg', maxScale: 10, fmtValue: v => v.toFixed(1), tooltipSuffix: '/10 avg' });
}

// Bill: "add a table to the dashboard so I can see the distribution and
// top subjects" — distribution (every watched/watchlisted/candidate
// title, not just rated ones, so it reflects the real dataset) alongside
// a rating-preference view (top titles + avg rating, scoped to what's
// actually been watched and rated — the same "top" framing
// computeGenreStats() above already uses for subgenres).

function renderBestMatches(stats, enrichedMeta) {
  const el = document.getElementById('bestMatchesList');
  if (!stats.matches.length) { el.innerHTML = '<div class="tk-empty">Not enough enriched, rated titles yet.</div>'; return; }
  el.innerHTML = stats.matches.slice(0, 12).map(r => {
    const poster = posterUrl(r.titleKey, enrichedMeta);
    return `
    <div class="tk-metric-row">
      ${posterImgHtml(poster, 'tk-metric-poster', 38, 57)}
      <span class="tk-metric-name">${typeIcon(r.type)} ${titleLink(r)} <span class="tk-metric-sub">(${r.year || '—'})</span></span>
      <span class="tk-metric-score">predicted ${Math.round(r.predicted)}, rated ${r.myRating}/10</span>
    </div>
  `;
  }).join('');
}

// Bill's explicit request, alongside excluding actively-airing shows from
// the You'll Love panel: "add a table to the dashboard with shows
// currently airing that I will love so I can stay up to date on those."
// Draws from both origins (watchlist + candidate pool) at their real,
// unfiltered bmtreScoreRaw — nothing here is display-only-excluded the
// way renderRecPanel() is, since the entire point of this list is to
// surface exactly what got pulled out of that panel and why it still
// matters (a genuinely strong prediction, just not watchable in full
// yet). Movies are never included (isActivelyAiring() is show-only).

function renderAiringSoonList(fromWatchlist, fromCandidates, enrichedMeta) {
  const el = document.getElementById('airingSoonList');
  const airing = [...fromWatchlist, ...fromCandidates]
    .filter(c => isActivelyAiring(c, enrichedMeta))
    .sort((a, b) => b.bmtreScoreRaw - a.bmtreScoreRaw);
  if (!airing.length) {
    el.innerHTML = '<div class="tk-empty">Nothing you\'d love is actively airing right now — check back later.</div>';
    return;
  }
  el.innerHTML = airing.slice(0, 12).map(c => {
    const poster = posterUrl(c.titleKey, enrichedMeta);
    const next = enrichedMeta[c.titleKey]?.nextEpisodeToAir;
    const epLabel = next?.seasonNumber != null && next?.episodeNumber != null
      ? ` (S${next.seasonNumber}E${next.episodeNumber})` : '';
    const nextLabel = next?.airDate ? `next episode ${next.airDate}${epLabel}` : 'airing now';
    return `
    <div class="tk-metric-row">
      ${posterImgHtml(poster, 'tk-metric-poster', 38, 57)}
      <span class="tk-metric-name">
        ${typeIcon(c.type)} ${titleLink(c)}
        <span class="tk-metric-sub">${c.year ? `(${c.year}) · ` : ''}${esc(nextLabel)}${c.origin === 'watchlist' ? ' · Watchlist' : ''}</span>
      </span>
      <span class="tk-metric-score">${Math.round(c.bmtreScore)}</span>
    </div>`;
  }).join('');
}

// Bill: "add a new table to the dashboard with all shows currently airing;
// along with the season finale date; and a countdown to how many days
// until that happens." Broader than the "Currently Airing — You'll Love"
// list above (which only covers unwatched recommendation candidates,
// scored) — this covers every show Bill is actually tracking (library +
// watchlist) that isActivelyAiring() confirms is genuinely mid-season
// right now, regardless of predicted score. Reads currentSeasonFinale
// (enrich_tmdb.py's own comment explains why the finale needs a second,
// season-detail TMDB call — next_episode_to_air only ever names the
// single next episode, not the season's last one). finaleDate can be
// null (TMDB hasn't scheduled that far into the season yet) — shown
// honestly as "TBD" rather than guessed at.

function computeCurrentlyAiringShows(library, watchlist, enrichedMeta) {
  // A show can genuinely sit in BOTH library.json and watchlist.json at
  // once (same titleKey) - real Trakt behavior, not a data bug (the same
  // overlap rankAll() had to defensively handle for candidates back in
  // Session 48's "Tom Clancy's Jack Ryan" case): Bill is partway through
  // it (library, in-progress) AND has it flagged on his watchlist, e.g.
  // as a reminder to keep going. Deduped here by titleKey so it doesn't
  // render as two rows for the same show - Library wins the Status label
  // when both exist, since it's the more informative state (he's actively
  // watching, not just planning to).
  const byKey = new Map();
  for (const [list, origin] of [[watchlist.titles, 'Watchlist'], [library.titles, 'Library']]) {
    for (const t of list) {
      if (t.type !== 'show') continue;
      if (!isActivelyAiring(t, enrichedMeta)) continue;
      const meta = enrichedMeta[t.titleKey] || {};
      const next = meta.nextEpisodeToAir;
      const finale = meta.currentSeasonFinale;
      let daysUntilFinale = null;
      if (finale?.finaleDate) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const finaleD = new Date(finale.finaleDate + 'T00:00:00');
        daysUntilFinale = Math.round((finaleD - today) / 86400000);
      }
      byKey.set(t.titleKey, {
        type: 'show', titleKey: t.titleKey, title: t.title, year: t.year, ids: t.ids,
        origin,
        season: next?.seasonNumber ?? finale?.seasonNumber ?? null,
        nextEpisode: next?.episodeNumber ?? null,
        nextEpisodeDate: next?.airDate ?? null,
        finaleEpisode: finale?.finaleEpisodeNumber ?? null,
        finaleDate: finale?.finaleDate ?? null,
        daysUntilFinale,
      });
    }
  }
  return [...byKey.values()];
}


function renderAiringFinaleTable(rows) {
  const table = document.getElementById('airingFinaleTable');
  if (!rows.length) {
    table.parentElement.innerHTML = '<div class="tk-empty">Nothing you\'re tracking is actively airing right now.</div>';
    return;
  }
  const columns = [
    { label: 'Show', get: r => r.title,
      render: (td, r) => { td.innerHTML = `${typeIcon('show')} ${titleLink(r)}${r.year ? ` <span class="tk-metric-sub">(${esc(r.year)})</span>` : ''}`; } },
    { label: 'Status', get: r => r.origin },
    { label: 'Now Airing', get: r => (r.season ?? 0) * 1000 + (r.nextEpisode ?? 0), numeric: true,
      render: (td, r) => { td.textContent = r.season != null && r.nextEpisode != null ? `S${r.season}E${r.nextEpisode}` : '—'; } },
    { label: 'Next Episode', get: r => r.nextEpisodeDate || '',
      render: (td, r) => { td.textContent = r.nextEpisodeDate || 'TBD'; } },
    { label: 'Season Finale', get: r => r.finaleDate || (r.finaleEpisode ? '9999-99-99' : ''),
      render: (td, r) => {
        if (r.finaleDate) td.textContent = `${r.finaleDate} (S${r.season}E${r.finaleEpisode})`;
        else if (r.finaleEpisode) td.textContent = `TBD (S${r.season}E${r.finaleEpisode})`;
        else td.textContent = 'Unknown';
      } },
    { label: 'Days Until Finale', get: r => r.daysUntilFinale ?? Infinity, numeric: true,
      render: (td, r) => {
        td.className = 'num';
        td.textContent = r.daysUntilFinale == null ? '—' : (r.daysUntilFinale <= 0 ? 'Airs today' : `${r.daysUntilFinale}d`);
      } },
  ];

  let sortCol = 5, sortAsc = true; // default: Days Until Finale ascending — soonest first

  function render() {
    const sorted = [...rows].sort((a, b) => {
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
        if (c.render) c.render(td, row); else td.textContent = esc(c.get(row));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  render();
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

function buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, llmTags = {}) {
  const rows = [];
  const addRow = (t, status, myRating) => {
    const h = hydrateTitle(t, enrichedMeta);
    const meta = enrichedMeta[h.titleKey];
    const omdb = omdbMeta[h.titleKey];
    // A dismissed title (feedbackData.json's excludeFromRecommendations) is
    // no longer a real candidate — idx.excluded already keeps it out of
    // every recommendation surface, so the table's own status label should
    // say so too rather than still calling it "Candidate."
    if (idx.excluded.has(h.titleKey)) status = 'Dismissed';
    rows.push({
      titleKey: h.titleKey, posterUrl: posterUrl(h.titleKey, enrichedMeta), ids: h.ids,
      title: h.title || '(untitled — not yet enriched)', year: h.year, type: h.type, status,
      airing: isActivelyAiring(h, enrichedMeta),
      myRating: myRating ?? null, tmdbRating: meta?.voteAverage ?? null,
      predictedScore: Math.round(matchScore(h, idx, enrichedMeta, omdbMeta)),
      popularity: popularityScore(meta?.voteCount),
      voteCount: meta?.voteCount ?? null,
      imdbVotes: omdb?.imdbVotes ?? null,
      criticScore: criticScore(omdb),
      audienceScore: realAudienceScore(omdb),
      awardsScore: awardsScore(omdb),
      awardsRaw: omdb?.awards?.raw || '',
      // Narrower subgenres, not TMDB's own broad genre list — see
      // computeGenreStats()'s comment for why. Falls back to the raw
      // genres for the rare title with no subgenre match at all.
      genres: (meta ? inferSubgenres(meta, llmTags[h.titleKey], undefined, idx.reviewedTags?.[h.titleKey]).map(s => displaySubgenre(s, meta)) : []).join(', ')
        || meta?.genres?.join(', ') || '',
      subjects: (meta ? inferSubjects(meta, llmTags[h.titleKey], undefined, idx.reviewedTags?.[h.titleKey]).map(s => SUBJECT_LABEL[s] || s) : []).join(', '),
      era: meta ? (ERA_LABEL[inferEra(meta, undefined, idx.reviewedTags?.[h.titleKey])[0]] || '') : '',
      creator: (h.type === 'movie' ? meta?.director : meta?.createdBy?.[0]) || '',
    });
  };
  for (const t of library.titles || []) addRow(t, 'Watched', t.myRating);
  for (const t of watchlist.titles || []) addRow(t, 'Watchlist', null);
  for (const t of candidatePool.titles || []) addRow(t, 'Candidate', null);
  return rows;
}


const TOP_N_DEFAULT = 20;


function renderAllTitlesTable(allRows) {
  const table = document.getElementById('allTitlesTable');
  const searchInput = document.getElementById('titleSearch');
  const typeFilter = document.getElementById('titleTypeFilter');
  const statusFilter = document.getElementById('titleStatusFilter');
  const yearFilter = document.getElementById('titleYearFilter');
  const airingFilter = document.getElementById('titleAiringFilter');
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
          img.onerror = () => { img.remove(); };
          td.appendChild(img);
        }
      } },
    { label: 'Title', get: r => r.title,
      render: (td, r) => { td.innerHTML = titleLink(r); } },
    { label: 'Year', get: r => r.year ?? '', numeric: true },
    { label: 'Type', get: r => typeLabel(r.type),
      render: (td, r) => { td.textContent = `${typeIcon(r.type)} ${typeLabel(r.type)}`; } },
    { label: 'Status', get: r => r.status,
      render: (td, r) => { td.innerHTML = statusTag(r.status); } },
    { label: 'Airing', get: r => r.airing ? 'Airing' : '',
      render: (td, r) => { if (r.airing) td.innerHTML = airingBadge(); } },
    { label: 'My Rating', get: r => r.myRating ?? '', numeric: true },
    { label: 'Predicted Score', get: r => r.predictedScore ?? '', numeric: true },
    { label: 'TMDB Rating', get: r => r.tmdbRating != null ? Math.round(r.tmdbRating * 10) / 10 : '', numeric: true },
    { label: 'Popularity', get: r => r.popularity ?? '', numeric: true },
    { label: 'Ratings', get: r => r.voteCount ?? '', numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.voteCount != null ? fmtNum(r.voteCount) : ''; } },
    { label: 'IMDb Votes', get: r => r.imdbVotes ?? '', numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.imdbVotes != null ? fmtNum(r.imdbVotes) : ''; } },
    { label: 'Critic Score', get: r => r.criticScore ?? '', numeric: true },
    { label: 'Audience Score', get: r => r.audienceScore ?? '', numeric: true },
    { label: 'Awards', get: r => r.awardsScore ?? '', numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.awardsScore ?? ''; if (r.awardsRaw) td.title = r.awardsRaw; } },
    { label: 'Genres', get: r => r.genres, render: (td, r) => { td.className = 'tk-genres'; td.textContent = r.genres || '—'; } },
    { label: 'Subjects', get: r => r.subjects, render: (td, r) => { td.className = 'tk-genres'; td.textContent = r.subjects || '—'; } },
    { label: 'Era', get: r => r.era || '', render: (td, r) => { td.textContent = r.era || '—'; } },
    { label: 'Director/Creator', get: r => r.creator || '—' },
  ];

  let sortCol = 5, sortAsc = false; // default: My Rating desc (index 5 now that Cover is column 0)
  let showAll = false;

  function filtered() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const type = typeFilter.value;
    const status = statusFilter.value;
    const year = yearFilter.value;
    const airing = airingFilter.value;
    return allRows.filter(r => {
      if (type && r.type !== type) return false;
      if (status && r.status !== status) return false;
      if (year && String(r.year) !== year) return false;
      if (airing === 'airing' && !r.airing) return false;
      if (airing === 'not-airing' && r.airing) return false;
      if (q && !(r.title.toLowerCase().includes(q) || r.genres.toLowerCase().includes(q) || r.subjects.toLowerCase().includes(q) || r.creator.toLowerCase().includes(q))) return false;
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
  airingFilter.addEventListener('change', render);
  showAllBtn.addEventListener('click', () => { showAll = !showAll; render(); });
  document.getElementById('titleCsvBtn').addEventListener('click', () => downloadCSV(table, 'trakt-all-titles.csv'));
}

// ── Recommendations preview ─────────────────────────────────────────────

// One line of real metadata under the title: genres, director/creator,
// TMDB community rating — whatever's actually present, since candidate
// stubs may still be mid-enrichment.

function renderRecPanel(sectionId, watchlistItems, candidateItems, enrichedMeta, omdbMeta, llmTags = {}, reviewedTags = {}) {
  const el = document.getElementById(sectionId);
  // Bill: "exclude it from the You'll Love panel but don't adjust the
  // actual predicted score." Pulled out here, at the display layer only -
  // same precedent as diversityRerank() below, which also never touches
  // bmtreScore/bmtreScoreRaw. A title dropped here still scores and ranks
  // normally everywhere else (the All Titles table, computeEvalMetrics(),
  // the new "Currently Airing" list) - only this specific ranked panel
  // hides it, since watching it isn't actually possible in full yet.
  watchlistItems = watchlistItems.filter(c => !isActivelyAiring(c, enrichedMeta));
  candidateItems = candidateItems.filter(c => !isActivelyAiring(c, enrichedMeta));
  // Ranks by bmtreScoreRaw (the real, unclamped score), not the displayed
  // bmtreScore — score-clamp-saturation fix, see engine.js's
  // computeScorePair() comment. rankAll() already sorts fromWatchlist/
  // fromCandidates this way; this re-sort (for the 4+4 origin split
  // below) has to match or it would silently re-introduce the same
  // clamped-tie-order problem at the display layer.
  const sortFn = (a, b) => (b.bmtreScoreRaw - a.bmtreScoreRaw) || (b.confidenceScore - a.confidenceScore);
  const HALF = 4;
  const wlRanked = diversityRerank([...watchlistItems].sort(sortFn), enrichedMeta, { windowSize: HALF, maxPerGenre: 2 });
  const candRanked = diversityRerank([...candidateItems].sort(sortFn), enrichedMeta, { windowSize: HALF, maxPerGenre: 2 });
  let wlPicks = wlRanked.slice(0, HALF);
  let candPicks = candRanked.slice(0, HALF);
  // Backfill from the other origin if one side is short (fewer than 4
  // real titles available), so the panel still shows up to 8 rather than
  // silently rendering fewer cards than it could.
  const shortfallFromWl = HALF - wlPicks.length;
  if (shortfallFromWl > 0) candPicks = candRanked.slice(0, HALF + shortfallFromWl);
  const shortfallFromCand = HALF - candPicks.length;
  if (shortfallFromCand > 0) wlPicks = wlRanked.slice(0, HALF + shortfallFromCand);
  const picks = [...wlPicks, ...candPicks].sort(sortFn);
  if (!picks.length) {
    el.innerHTML = '<div class="tk-empty">Not enough enriched data yet.</div>';
    return;
  }
  el.innerHTML = picks.map((c, i) => {
    const poster = posterUrl(c.titleKey, enrichedMeta);
    return `
    <div class="tk-rec-card">
      <div class="tk-rec-rank">${i + 1}</div>
      ${posterImgHtml(poster, 'tk-rec-poster', 60, 90)}
      <div class="tk-rec-body">
        <div class="tk-rec-title">
          ${typeIcon(c.type)} ${titleLink(c)}${c.year ? ` <span class="tk-year">(${esc(c.year)})</span>` : ''}
          <span class="tk-rec-badge">${c.origin === 'watchlist' ? 'Watchlist' : 'New pick'}</span>
        </div>
        <div class="tk-rec-meta">${esc(metaLine(c, enrichedMeta, omdbMeta, llmTags, reviewedTags))}</div>
        <div class="tk-rec-reason">${esc(c.reason)}</div>
        <a class="tk-deepdive-btn" href="./deepdive.html?key=${encodeURIComponent(c.titleKey)}">Deep Dive →</a>
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


// ── New Discover features (Bill: "make sure the main one is fun with new
// features") ─────────────────────────────────────────────────────────────
// All built from data already computed for the rec panels — no new TMDB
// fetches, no new pipeline. One pool feeds every discovery surface below
// (hero, Surprise Me, shelves, Because You Loved) so nothing can surface
// here that the You'll Love panels would refuse: the exact same
// enriched-and-not-actively-airing filter renderRecPanel() already applies.

const byScore = (a, b) => (b.bmtreScoreRaw - a.bmtreScoreRaw) || (b.confidenceScore - a.confidenceScore);

function discoverPool(fromWatchlist, fromCandidates, enrichedMeta) {
  return [...fromWatchlist, ...fromCandidates]
    .filter(c => enrichedMeta[c.titleKey] && !isActivelyAiring(c, enrichedMeta))
    .sort(byScore);
}

// "1h 52m" for a movie, "2 seasons, 16 episodes" (+ "× ~45m" when TMDB has
// a per-episode runtime, which it usually doesn't) for a show.
function runtimeLabel(c, enrichedMeta) {
  const meta = enrichedMeta[c.titleKey];
  if (!meta) return '';
  if (c.type === 'movie') {
    if (!meta.runtime) return '';
    const h = Math.floor(meta.runtime / 60), m = meta.runtime % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  if (!meta.numberOfEpisodes) return '';
  const seasonPart = meta.numberOfSeasons ? `${meta.numberOfSeasons} season${meta.numberOfSeasons === 1 ? '' : 's'}, ` : '';
  const perEp = meta.episodeRunTime ? ` × ~${meta.episodeRunTime}m` : '';
  return `${seasonPart}${meta.numberOfEpisodes} episode${meta.numberOfEpisodes === 1 ? '' : 's'}${perEp}`;
}

// 1. Tonight's Top Pick — pool[0], full-width hero above the panels.
// Returns the picked candidate so load() can assert it equals the #1 card
// of the matching You'll Love panel (same pool, same sort — provably true,
// not just usually true).
function renderHero(pool, enrichedMeta, omdbMeta, llmTags, reviewedTags) {
  const el = document.getElementById('heroPick');
  if (!pool.length) { el.innerHTML = '<div class="tk-empty">Not enough enriched titles yet.</div>'; return null; }
  const top = pool[0];
  const otherType = pool.find(c => c.type !== top.type);
  const poster = posterUrl(top.titleKey, enrichedMeta, 'w342');
  const tier = scoreTier(top.bmtreScore);
  el.innerHTML = `
    <div class="tk-hero-poster">${posterImgHtml(poster, 'tk-hero-img', 150, 225)}</div>
    <div class="tk-hero-body">
      <div class="tk-hero-kicker">🎯 Start here tonight</div>
      <div class="tk-hero-title">
        ${typeIcon(top.type)} ${titleLink(top)}${top.year ? ` <span class="tk-hero-year">(${esc(top.year)})</span>` : ''}
        <span class="tk-hero-badge">${top.origin === 'watchlist' ? 'Watchlist' : 'New pick'}</span>
      </div>
      <div class="tk-hero-meta">${esc([runtimeLabel(top, enrichedMeta), metaLine(top, enrichedMeta, omdbMeta, llmTags, reviewedTags)].filter(Boolean).join(' · '))}</div>
      <div class="tk-hero-reason">${esc(top.reason)}</div>
      <div class="tk-hero-actions">
        <a class="tk-btn" href="./deepdive.html?key=${encodeURIComponent(top.titleKey)}">🔎 Deep Dive</a>
        <a class="tk-btn" href="${esc(traktUrl(top))}" target="_blank" rel="noopener">Open on Trakt ↗</a>
      </div>
      ${otherType ? `<div class="tk-hero-alt">Not in the mood for a ${top.type === 'movie' ? 'movie' : 'show'}? The top ${otherType.type === 'movie' ? 'movie' : 'show'} is ${esc(otherType.title)} at ${Math.round(otherType.bmtreScore)}.</div>` : ''}
    </div>
    <div class="tk-hero-score" style="color:${tier.color}">
      <div class="tk-hero-score-num">${Math.round(top.bmtreScore)}</div>
      <div class="tk-hero-score-label">predicted score</div>
    </div>
  `;
  return top;
}

// 2. Surprise Me — a decision-fatigue solver. Draws from the top 40 of the
// pool (optionally filtered by type), weighted so #1 is roughly 4x likelier
// than #40 (rank-based linear weight, not uniform) — still leans toward
// quality picks, not a flat random draw. One re-roll if it repeats the
// previous pick.
let lastSurprisePick = null;
function drawSurprise(pool, typeFilter) {
  const candidates = (typeFilter ? pool.filter(c => c.type === typeFilter) : pool).slice(0, 40);
  if (!candidates.length) return null;
  const weights = candidates.map((c, i) => candidates.length - i + 10);
  const total = weights.reduce((s, w) => s + w, 0);
  const drawOne = () => {
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  };
  let pick = drawOne();
  if (pick.titleKey === lastSurprisePick && candidates.length > 1) pick = drawOne();
  lastSurprisePick = pick.titleKey;
  return { pick, rank: candidates.indexOf(pick) + 1, poolSize: candidates.length };
}

function renderSurprise(pool, enrichedMeta, omdbMeta, llmTags, reviewedTags, typeFilter) {
  const result = drawSurprise(pool, typeFilter);
  const resultEl = document.getElementById('surpriseResult');
  const btn = document.getElementById('surpriseBtn');
  if (!result) { resultEl.hidden = true; return; }
  const { pick, rank, poolSize } = result;
  const poster = posterUrl(pick.titleKey, enrichedMeta, 'w342');
  const poolLabel = typeFilter === 'movie' ? 'movies' : typeFilter === 'show' ? 'shows' : 'picks';
  resultEl.hidden = false;
  resultEl.classList.remove('tk-reveal');
  void resultEl.offsetWidth; // restart the CSS animation on every spin
  resultEl.classList.add('tk-reveal');
  resultEl.innerHTML = `
    <div class="tk-rec-card">
      ${posterImgHtml(poster, 'tk-rec-poster', 60, 90)}
      <div class="tk-rec-body">
        <div class="tk-rec-title">${typeIcon(pick.type)} ${titleLink(pick)}${pick.year ? ` <span class="tk-rec-year">(${esc(pick.year)})</span>` : ''}</div>
        <div class="tk-rec-meta">${esc([runtimeLabel(pick, enrichedMeta), metaLine(pick, enrichedMeta, omdbMeta, llmTags, reviewedTags)].filter(Boolean).join(' · '))}</div>
        <div class="tk-rec-reason">${esc(pick.reason)}</div>
        <div class="tk-rec-sub">Drawn from your top ${poolSize} ${poolLabel} — this one ranks #${rank}.</div>
        <a class="tk-btn" href="./deepdive.html?key=${encodeURIComponent(pick.titleKey)}">🔎 Deep Dive</a>
      </div>
      <div class="tk-rec-score">${Math.round(pick.bmtreScore)}</div>
    </div>
  `;
  btn.textContent = '🎲 Spin again';
}

function initSurprise(pool, enrichedMeta, omdbMeta, llmTags, reviewedTags) {
  const btn = document.getElementById('surpriseBtn');
  const chips = document.querySelectorAll('[data-surprise-type]');
  let activeType = '';
  let hasSpun = false;
  const spin = () => { renderSurprise(pool, enrichedMeta, omdbMeta, llmTags, reviewedTags, activeType); hasSpun = true; };
  btn.addEventListener('click', spin);
  chips.forEach(chip => chip.addEventListener('click', () => {
    chips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeType = chip.dataset.surpriseType;
    if (hasSpun) spin();
  }));
}

// 3. Got Two Hours? / Weekend Binge — quick-pick shelves for a real
// time budget. Movies <=120min, shows <=10 episodes, top 6 each from the
// pool (already score-sorted).
function renderShelf(containerId, items, enrichedMeta) {
  const el = document.getElementById(containerId);
  if (!items.length) { el.innerHTML = '<div class="tk-empty">Nothing qualifies yet.</div>'; return; }
  el.innerHTML = items.map(c => {
    const poster = posterUrl(c.titleKey, enrichedMeta, 'w154');
    return `
    <a class="tk-shelf-card" href="./deepdive.html?key=${encodeURIComponent(c.titleKey)}">
      ${posterImgHtml(poster, 'tk-shelf-poster', 92, 138)}
      <div class="tk-shelf-score">${Math.round(c.bmtreScore)}</div>
      <div class="tk-shelf-title">${esc(c.title)}</div>
      <div class="tk-shelf-runtime">${esc(runtimeLabel(c, enrichedMeta))}</div>
    </a>`;
  }).join('');
}

// 4. Because You Loved… — a Netflix-style presentation of a signal that
// already drives real scoring (forward/reverse similarToIds/recommendedIds
// matches), not a new one. Anchors = real 10/10-rated titles with >=2 pool
// titles citing them (either direction — TMDB ids are per-type namespaces,
// so same-type only). Ranked by the mean score of each anchor's own top 5
// connections, rotated daily so the page doesn't look identical every
// visit, picked greedily preferring the other type each row and never
// repeating a title already shown in an earlier row.
function computeBecauseYouLoved(library, pool, enrichedMeta) {
  const anchors = (library.titles || []).filter(t => t.myRating === 10 && enrichedMeta[t.titleKey] && t.ids?.tmdb != null);
  const rows = [];
  for (const anchor of anchors) {
    const anchorMeta = enrichedMeta[anchor.titleKey];
    const anchorTmdb = anchor.ids.tmdb;
    const connected = pool.filter(c => {
      if (c.type !== anchor.type || c.titleKey === anchor.titleKey) return false;
      const cMeta = enrichedMeta[c.titleKey];
      const cTmdb = c.ids?.tmdb;
      const forward = (cMeta.similarToIds || []).includes(anchorTmdb) || (cMeta.recommendedIds || []).includes(anchorTmdb);
      const reverse = cTmdb != null && ((anchorMeta.similarToIds || []).includes(cTmdb) || (anchorMeta.recommendedIds || []).includes(cTmdb));
      return forward || reverse;
    }).sort(byScore);
    if (connected.length < 2) continue;
    const top5 = connected.slice(0, 5);
    const meanScore = top5.reduce((s, c) => s + c.bmtreScoreRaw, 0) / top5.length;
    rows.push({ anchor, connected, meanScore });
  }
  rows.sort((a, b) => b.meanScore - a.meanScore);
  const top9 = rows.slice(0, 9);
  if (!top9.length) return [];
  const startIdx = Math.floor(Date.now() / 86400000) % top9.length;
  const rotated = [...top9.slice(startIdx), ...top9.slice(0, startIdx)];

  const shown = new Set();
  const picked = [];
  let preferType = null;
  const remaining = [...rotated];
  while (remaining.length && picked.length < 3) {
    let idx = preferType ? remaining.findIndex(r => r.anchor.type === preferType) : -1;
    if (idx === -1) idx = 0;
    const row = remaining.splice(idx, 1)[0];
    const items = row.connected.filter(c => !shown.has(c.titleKey)).slice(0, 5);
    if (!items.length) continue;
    items.forEach(c => shown.add(c.titleKey));
    picked.push({ anchor: row.anchor, items });
    preferType = row.anchor.type === 'movie' ? 'show' : 'movie';
  }
  return picked;
}

function renderBecauseYouLoved(rows, enrichedMeta) {
  const el = document.getElementById('becauseYouLoved');
  if (!rows.length) { el.innerHTML = '<div class="tk-empty">Not enough connected picks yet — check back as more of your loved titles get enriched.</div>'; return; }
  el.innerHTML = rows.map(({ anchor, items }) => `
    <div class="tk-byl-row">
      <div class="tk-byl-heading">Because you loved ${typeIcon(anchor.type)} ${esc(anchor.title)} 10/10</div>
      <div class="tk-shelf">${items.map(c => {
        const poster = posterUrl(c.titleKey, enrichedMeta, 'w154');
        return `
        <a class="tk-shelf-card" href="./deepdive.html?key=${encodeURIComponent(c.titleKey)}">
          ${posterImgHtml(poster, 'tk-shelf-poster', 92, 138)}
          <div class="tk-shelf-score">${Math.round(c.bmtreScore)}</div>
          <div class="tk-shelf-title">${esc(c.title)}</div>
          <div class="tk-shelf-runtime">${c.origin === 'watchlist' ? 'On your watchlist' : 'New pick'}</div>
        </a>`;
      }).join('')}</div>
    </div>
  `).join('');
}

// 5. Pick Up Where You Left Off — currentlyWatching.json is a bare array
// (unlike library/watchlist/candidatePool's {titles:[...]} shape).
// lastWatchedAt carries a real 1970-01-01 placeholder on roughly half of
// these (a bulk-import artifact documented elsewhere in this project) —
// never displayed here for that reason.
function renderContinueWatching(currentlyWatching, enrichedMeta) {
  const el = document.getElementById('continueWatching');
  const rows = (currentlyWatching || [])
    .filter(t => t.plays < t.airedEpisodes)
    .map(t => ({ ...t, left: t.airedEpisodes - t.plays }))
    .sort((a, b) => a.left - b.left);
  if (!rows.length) { el.innerHTML = '<div class="tk-empty">Nothing in progress right now.</div>'; return; }
  el.innerHTML = rows.map(t => {
    const poster = posterUrl(t.titleKey, enrichedMeta, 'w154');
    const pct = Math.max(2, Math.round((t.plays / t.airedEpisodes) * 100));
    return `
    <div class="tk-metric-row">
      ${posterImgHtml(poster, 'tk-metric-poster', 38, 57)}
      <span class="tk-metric-name">
        ${typeIcon(t.type)} ${titleLink(t)}
        <span class="tk-metric-sub">${t.myRating != null ? `you rate it ${esc(t.myRating)}/10 · ` : ''}${t.left} episode${t.left === 1 ? '' : 's'} left${isActivelyAiring(t, enrichedMeta) ? ' ' + airingBadge() : ''}</span>
        <div class="tk-progress-track"><div class="tk-progress-fill" style="width:${pct}%"></div></div>
      </span>
      <span class="tk-metric-score">${t.plays} / ${t.airedEpisodes}</span>
    </div>`;
  }).join('');
}

// 6. Your taste, in one line — a small, low-risk personality blurb built
// entirely from stats the page already computes for other sections.
function renderTasteLine(genreStats, crowdCompare, castStats, tenRatedCount) {
  const el = document.getElementById('tasteLine');
  if (!el) return;
  const parts = [];
  if (genreStats.length) parts.push(`you rate ${genreStats.slice(0, 2).map(g => g.genre).join(' and ')} highest`);
  if (castStats.length) parts.push(`you've watched ${esc(castStats[0].actor)} in ${castStats[0].count} title${castStats[0].count === 1 ? '' : 's'}`);
  if (tenRatedCount) parts.push(`${fmtNum(tenRatedCount)} title${tenRatedCount === 1 ? ' has' : 's have'} earned your perfect 10`);
  if (crowdCompare) {
    const dir = crowdCompare.diff > 0 ? 'more generous than' : crowdCompare.diff < 0 ? 'harsher than' : 'right in line with';
    parts.push(`you're ${Math.abs(crowdCompare.diff).toFixed(1)} points ${dir} the TMDB crowd`);
  }
  if (!parts.length) { el.textContent = ''; return; }
  const sentence = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1];
  el.textContent = sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

async function load() {
  const { dashboard: d, library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback,
          llmTags, reviewedTags, currentlyWatching } = await loadAllData();

  const { idx, fromWatchlist, fromCandidates } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags);
  const enrichedOnly = c => !!enrichedMeta[c.titleKey];
  const byType = (list, type) => list.filter(c => c.type === type && enrichedOnly(c));

  const generated = new Date(d.generatedAt);
  document.getElementById('subtitleText').textContent =
    `Last refreshed ${generated.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} ` +
    `at ${generated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  document.getElementById('statusText').textContent = 'Loaded from export';

  // Picks first, per Bill's "make sure the main one is fun" ask — the one
  // shared pool (discoverPool) feeds the hero, Surprise Me, and both
  // shelves below, so nothing here can surface that the You'll Love panels
  // themselves would refuse.
  const pool = discoverPool(fromWatchlist, fromCandidates, enrichedMeta);
  renderHero(pool, enrichedMeta, omdbMeta, llmTags, reviewedTags);
  initSurprise(pool, enrichedMeta, omdbMeta, llmTags, reviewedTags);

  renderRecPanel('movieRecList', byType(fromWatchlist, 'movie'), byType(fromCandidates, 'movie'), enrichedMeta, omdbMeta, llmTags, reviewedTags);
  renderRecPanel('showRecList', byType(fromWatchlist, 'show'), byType(fromCandidates, 'show'), enrichedMeta, omdbMeta, llmTags, reviewedTags);

  renderShelf('quickWatchShelf', pool.filter(c => c.type === 'movie' && (enrichedMeta[c.titleKey].runtime ?? 999) <= 120).slice(0, 6), enrichedMeta);
  renderShelf('bingeShelf', pool.filter(c => c.type === 'show' && (enrichedMeta[c.titleKey].numberOfEpisodes ?? 999) <= 10).slice(0, 6), enrichedMeta);

  renderBecauseYouLoved(computeBecauseYouLoved(library, pool, enrichedMeta), enrichedMeta);
  renderContinueWatching(currentlyWatching, enrichedMeta);

  renderAiringSoonList(fromWatchlist, fromCandidates, enrichedMeta);
  renderAiringFinaleTable(computeCurrentlyAiringShows(library, watchlist, enrichedMeta));

  const enrichedCount = Object.keys(enrichedMeta).length;
  document.getElementById('genreSectionScopeNote').textContent =
    `Based on the ${fmtNum(enrichedCount)} titles enriched with TMDB data so far (of ${fmtNum((library.titles?.length || 0) + (watchlist.titles?.length || 0))} total) — ` +
    `these sections fill in automatically as the daily enrichment job covers more of your library.`;

  const genreStats = computeGenreStats(library, enrichedMeta, llmTags, reviewedTags);
  const castStats = computeCastStats(library, enrichedMeta);
  const crowdCompare = computeCrowdCompare(library, enrichedMeta);
  const tenRatedCount = (library.titles || []).filter(t => t.myRating === 10).length;
  renderGenreChart(genreStats);
  renderCastList(castStats);
  renderCrowdCompare(crowdCompare);
  renderTasteLine(genreStats, crowdCompare, castStats, tenRatedCount);

  renderBestMatches(computeBestMatches(library, enrichedMeta, omdbMeta, idx), enrichedMeta);

  renderStatTiles(d.summary);

  renderAllTitlesTable(buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, llmTags));
}

initCollapsibleCards();

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load dashboard data — see console.';
  document.getElementById('subtitleText').textContent = 'No export loaded yet.';
  console.error(err);
});
