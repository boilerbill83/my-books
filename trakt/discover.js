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
  isActivelyAiring, traktUrl, prestigeScore, PRESTIGE_BADGE_THRESHOLD,
} from './engine.js';
import {
  esc, fmtNum, fmtCompact, posterImgHtml, typeIcon, typeLabel, titleLink, statusTag,
  airingBadge, renderHBarChart, computeGenreStats, displaySubgenre, SUBJECT_LABEL,
  ERA_LABEL, downloadCSV, metaLine, scoreTier, initCollapsibleCards, loadAllData,
  predictedVsActualRows, computeWatchStatusRows, computeCoWatchRows, buildWatchRow,
  renderWatchCards, renderCoWatchCards, renderAiringCards, initCoWatchViewToggle, initAiringViewToggle,
  renderWatchStatusTable, fmtDate, renderFamilyWatchList,
  computeFavoriteStars,
} from './dashboardShared.js';

// crowdCompare (computeCrowdCompare()'s output) folds in here as one more
// tile — see the comment where its old dedicated card used to be, above
// buildAllTitlesRows(), for why.
function renderStatTiles(summary, crowdCompare) {
  const tiles = [
    ['Movies watched', fmtNum(summary.moviesWatched)],
    ['Shows watched', fmtNum(summary.showsWatched)],
    ['Episodes watched', fmtNum(summary.episodesWatched)],
    ['Hours watched', fmtNum(summary.totalHours)],
    ['Total ratings', fmtNum(summary.totalRatings)],
    ['Average rating', summary.avgRating != null ? `${summary.avgRating} / 10` : '—'],
  ];
  if (crowdCompare) {
    const dir = crowdCompare.diff > 0 ? 'higher' : crowdCompare.diff < 0 ? 'lower' : 'even with';
    tiles.push(['vs. TMDB crowd', `${crowdCompare.diff > 0 ? '+' : ''}${crowdCompare.diff.toFixed(2)} ${dir}`]);
  }
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
//
// actual >= 60 (myRating >= 6), corrected 2026-09-10 per Bill's own
// direct correction — this section's original actual >= 80 threshold
// was the exact assumption engine.js's LIKED_THRESHOLD was modeled on
// (see that constant's own comment), and both were wrong: "If a movie
// is 7/10, that doesn't mean I didn't like it. Anything under 6 means I
// didn't like it."
function computeBestMatches(library, enrichedMeta, omdbMeta, idx) {
  const rows = predictedVsActualRows(library, enrichedMeta, omdbMeta, idx);
  const matches = rows.filter(r => r.predicted >= 70 && r.actual >= 60).sort((a, b) => b.predicted - a.predicted);
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
    // 'w92' (real TMDB size), not the default 'w154' — this renders as a
    // 38x57 thumbnail, and every default-size posterUrl() call across
    // this dashboard was fetching a needlessly large image relative to
    // its real display size (real, measured contributor to "images are
    // slow to load" — fixed at every call site, not just this one).
    const poster = posterUrl(r.titleKey, enrichedMeta, 'w92');
    return `
    <div class="tk-metric-row">
      ${posterImgHtml(poster, 'tk-metric-poster', 38, 57)}
      <span class="tk-metric-name">${typeIcon(r.type)} ${titleLink(r)} <span class="tk-metric-sub">(${r.year || '—'})</span></span>
      <span class="tk-metric-score">predicted ${Math.round(r.predicted)}, rated ${r.myRating}/10</span>
    </div>
  `;
  }).join('');
}

// buildWatchRow()/computeWatchStatusRows()/computeCoWatchRows() and the
// rest of the "what's airing" table-building logic moved to
// dashboardShared.js (see that file's own comment) so a dedicated
// standalone page (trakt/watch-together.html) can share it without
// importing this whole page module.

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


// Bill: "You vs. The Crowd - this takes up a lot of space; maybe squeeze
// it in somewhere else." Folded into the stat-tiles row (renderStatTiles)
// as one more compact tile instead of its own full card — the taste-line
// sentence already gives the one-line version of this same stat, so the
// tile just needs to carry the precise number, not a full explanation.

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

function buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, llmTags = {}, personMeta = {}) {
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
      titleKey: h.titleKey, posterUrl: posterUrl(h.titleKey, enrichedMeta, 'w92'), ids: h.ids,
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
      era: meta ? (ERA_LABEL[inferEra(meta, llmTags[h.titleKey], undefined, idx.reviewedTags?.[h.titleKey])[0]] || '') : '',
      creator: (h.type === 'movie' ? meta?.director : meta?.createdBy?.[0]) || '',
      prestige: meta ? prestigeScore(h, meta, omdb, personMeta) : null,
    });
  };
  // Bill, 2026-09-17: "I marked all seasons as watched in Trakt but you
  // had it on the to watch list" (Tires) — a real bug, not staleness. A
  // title can genuinely sit in BOTH library.json and watchlist.json at
  // once (Trakt's watched-history and watchlist are independent lists;
  // finishing a show doesn't remove it from your watchlist — the exact
  // real overlap rankAll() already had to defend against for The Lowdown
  // back in Session 59, confirmed still in this same data: 11 titles
  // including Tires and The Lowdown itself are in both files right now).
  // This function added an unconditional row per source list with no
  // dedup at all, so any such title got a real "Watched" row AND a ghost
  // "Watchlist" row for the exact same title. seenKeys makes library the
  // single source of truth over watchlist over candidate — same
  // precedence buildWatchRow() already uses for status derivation.
  const seenKeys = new Set();
  for (const t of library.titles || []) {
    // "New Episodes," not "In Progress" — see STATUS_META's own comment
    // in dashboardShared.js for why (Bill doesn't log partial progress).
    addRow(t, t.completionStatus === 'in-progress' ? 'New Episodes' : 'Watched', t.myRating);
    seenKeys.add(t.titleKey);
  }
  for (const t of watchlist.titles || []) { if (!seenKeys.has(t.titleKey)) { addRow(t, 'Watchlist', null); seenKeys.add(t.titleKey); } }
  for (const t of candidatePool.titles || []) { if (!seenKeys.has(t.titleKey)) { addRow(t, 'Candidate', null); seenKeys.add(t.titleKey); } }
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
    // Bill: "is there a way to identify a TV show as prestige... maybe
    // those that have a big star like JK Simmons and are 10 episodes or
    // less." Appended at the end (not inserted earlier) so it can never
    // shift any other column's numeric index/sortCol default — see
    // engine.js's prestigeScore()/isPrestigeFormat() for the real,
    // verified-against-known-examples definition. null (not 0) for
    // movies/not-yet-enriched titles/shows that don't clear the format
    // bar at all — "not applicable," never "scored zero."
    { label: 'Prestige', get: r => r.prestige ?? '', numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.prestige != null ? r.prestige : '—'; } },
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

function renderRecPanel(sectionId, watchlistItems, candidateItems, enrichedMeta, omdbMeta, llmTags = {}, reviewedTags = {}, personMeta = {}) {
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
  // REMOVED 2026-09-10 (Bill: "unhide those movies from the AI. I want to
  // see the actual recommendations") — this used to blanket-filter every
  // superhero-subgenre candidate from this panel (Session 66, in response
  // to The Dark Knight showing up as a top pick). The score itself was
  // never touched by this filter either way — only what rendered here.
  //
  // A second, title-level display-only mask (ANOMALY_INFLATED_CANDIDATES:
  // Blink Twice, Hypnotic, Stonehearst Asylum, Black Dynamite, 21 & Over —
  // all inflated by a thin, near-single-citation match to one anomalous
  // loved title, per-title diagnosis run for real against buildIndexes()
  // with each outlier's rating zeroed out) also lived here until the same
  // date, retired for the same reason once a REAL fix shipped instead:
  // engine.js's citationCreditMultiplier() now discounts exactly this
  // pattern at the score level. Re-verified live (2026-09-11, "thoroughly
  // investigate all outliers"): all 5 now score 46.3-69.7 raw, every one
  // comfortably below the real current top-15 movie candidate cutoff
  // (76.1) — a first check of this claimed otherwise (a broken sort
  // comparator produced a garbage "top 10," wrongly suggesting 2 titles
  // were still competitive) and was caught and fixed before trusting the
  // result. See quality.js's "deadpool-citation-inflation" and
  // "loved-title-category-anomaly-signal" Improvement Opportunities
  // findings for the full investigation and real before/after numbers.
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
    // 'w92' (real TMDB size) — this renders as a 60x90 tk-rec-poster, not
    // the much larger default 'w154' (see renderBestMatches()'s own
    // comment on this same fix).
    const poster = posterUrl(c.titleKey, enrichedMeta, 'w92');
    // Bill: "is there a way to identify a TV show as prestige... maybe
    // those that have a big star and are 10 episodes or less." The badge
    // threshold is a deliberately generous "worth flagging" bar, not
    // "definitely great" — isPrestigeFormat() itself is the real gate
    // (format alone is worth 40 of the 100 possible points), this just
    // skips the low end of the graded range so the badge stays meaningful
    // rather than showing on every single format-qualifying title
    // regardless of any other signal. See PRESTIGE_BADGE_THRESHOLD's own
    // comment in engine.js for why it's 45, not 50.
    const prestige = c.type === 'show' ? prestigeScore(c, enrichedMeta[c.titleKey], omdbMeta[c.titleKey], personMeta) : null;
    return `
    <div class="tk-rec-card">
      <div class="tk-rec-rank">${i + 1}</div>
      ${posterImgHtml(poster, 'tk-rec-poster', 60, 90)}
      <div class="tk-rec-body">
        <div class="tk-rec-title">
          ${typeIcon(c.type)} ${titleLink(c)}${c.year ? ` <span class="tk-year">(${esc(c.year)})</span>` : ''}
          <span class="tk-rec-badge${c.origin === 'watchlist' ? '' : ' tk-rec-badge-new'}">${c.origin === 'watchlist' ? 'Watchlist' : 'New pick'}</span>
          ${prestige != null && prestige >= PRESTIGE_BADGE_THRESHOLD ? `<span class="tk-rec-badge tk-prestige-badge" title="Limited/anthology format (10 or fewer episodes per season) with real critic acclaim and/or a well-known cast — see Deep Dive for the full breakdown">🏆 Prestige</span>` : ''}
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
// (hero, shelves, Because You Loved) so nothing can surface here that the
// You'll Love panels would refuse: the exact same enriched-and-not-
// actively-airing filter renderRecPanel() already applies.

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

// Cast line for the currently-watching hero — reuses the same
// topCast/topCastDetail data metaLine() has access to but metaLine() itself
// never surfaces names, only counts/ratings, so this is a small dedicated
// helper rather than overloading that function's own scope.
function castLine(meta) {
  if (!meta?.topCast?.length) return '';
  return meta.topCast.slice(0, 5).join(', ');
}

// Bill: "instead of 'start here tonight', let's showcase what I am
// currently watching." Prefers, in order: (1) Bill's own manually-stated
// current watch (currentlyWatchingFeature.json — see that file's own
// "note" field for why this exists rather than deriving everything from
// Trakt: a title he just started tonight may not be in a Trakt
// export/sync yet, and this project never fabricates Trakt history to
// paper over that gap), (2) the most recently-watched real in-progress
// show from currentlyWatching.json (excludes the documented 1970-01-01
// bulk-import placeholder), (3) falls back to the original "top
// recommendation" hero when neither exists, so the section is never empty.
function pickCurrentlyWatching(feature, currentlyWatching, enrichedMeta) {
  if (feature?.titleKey && enrichedMeta[feature.titleKey]) {
    return { titleKey: feature.titleKey, type: feature.titleKey.split(':')[0], facts: feature.facts, progress: currentlyWatching.find(t => t.titleKey === feature.titleKey) };
  }
  const real = currentlyWatching
    .filter(t => t.type === 'show' && t.plays < t.airedEpisodes && t.lastWatchedAt && t.lastWatchedAt !== '1970-01-01T00:00:00.000Z' && enrichedMeta[t.titleKey])
    .sort((a, b) => new Date(b.lastWatchedAt) - new Date(a.lastWatchedAt));
  if (real.length) return { titleKey: real[0].titleKey, type: 'show', facts: null, progress: real[0] };
  return null;
}

// Bill: "make the left smaller" — capping the sourced-facts list is the
// single biggest lever on the hero card's own height (each fact runs
// 2-3 lines) without cutting anything load-bearing (poster/title/meta/
// cast/overview/actions all stay). 3 was picked, not a lower number,
// because "The Real Story" is Bill's own named feature from when this
// hero card was first built — trimming it to nothing would undercut the
// point of the section, just its length.
const HERO_FACTS_CAP = 3;

function renderCurrentlyWatchingHero(pick, enrichedMeta, omdbMeta, llmTags, reviewedTags) {
  const el = document.getElementById('heroPick');
  const meta = enrichedMeta[pick.titleKey];
  const candidate = { titleKey: pick.titleKey, type: pick.type, title: meta.title, year: meta.year };
  const poster = posterUrl(pick.titleKey, enrichedMeta, 'w342');
  const omdbEntry = omdbMeta?.[pick.titleKey];
  const critic = criticScore(omdbEntry);
  const audience = realAudienceScore(omdbEntry);
  const cast = castLine(meta);
  const scoreVal = meta.voteAverage != null ? meta.voteAverage.toFixed(1) : null;
  el.innerHTML = `
    <div class="tk-hero-poster">${posterImgHtml(poster, 'tk-hero-img', 150, 225, true)}</div>
    <div class="tk-hero-body">
      <div class="tk-hero-kicker">📺 Currently Watching</div>
      <div class="tk-hero-title">
        ${typeIcon(pick.type)} ${titleLink(candidate)}${meta.year ? ` <span class="tk-hero-year">(${esc(meta.year)})</span>` : ''}
        ${meta.networks?.length ? `<span class="tk-hero-badge">${esc(meta.networks[0])}</span>` : ''}
      </div>
      <div class="tk-hero-meta">${esc([runtimeLabel(candidate, enrichedMeta), metaLine(candidate, enrichedMeta, omdbMeta, llmTags, reviewedTags)].filter(Boolean).join(' · '))}</div>
      ${cast ? `<div class="tk-hero-cast">Starring ${esc(cast)}</div>` : ''}
      ${meta.overview ? `<div class="tk-hero-reason">${esc(meta.overview)}</div>` : ''}
      <div class="tk-hero-actions">
        <a class="tk-btn tk-btn-primary" href="./deepdive.html?key=${encodeURIComponent(pick.titleKey)}">🔎 Deep Dive</a>
        <a class="tk-btn" href="${esc(traktUrl(candidate))}" target="_blank" rel="noopener">Open on Trakt ↗</a>
      </div>
      ${pick.facts?.length ? `
        <div class="tk-hero-facts">
          <div class="tk-hero-facts-title">The Real Story</div>
          ${pick.facts.slice(0, HERO_FACTS_CAP).map(f => `<div class="tk-hero-fact">${esc(f.text)}${f.source ? ` <a href="${esc(f.source)}" target="_blank" rel="noopener" class="tk-hero-fact-source">${esc(f.sourceLabel || 'source')}</a>` : ''}</div>`).join('')}
        </div>
      ` : ''}
    </div>
    ${scoreVal ? `
    <div class="tk-hero-score">
      <div class="tk-hero-score-num">${scoreVal}</div>
      <div class="tk-hero-score-label">TMDB rating</div>
      ${critic != null ? `<div class="tk-hero-score-sub">${critic}/100 critics</div>` : ''}
      ${audience != null ? `<div class="tk-hero-score-sub">${audience}/100 audience</div>` : ''}
    </div>` : ''}
  `;
}

// Bill (2026-09-15): "split the top of the dashboard. Put currently
// watching on the left and my next watch on the right." Originally scoped
// to shows that recently wrapped a season; broadened (2026-09-19, Bill:
// "these will be things on the watch list and highly rated") to every
// watchlist show that's ready to watch right now, not just freshly-wrapped
// ones. "Ready right now" reuses isActivelyAiring() (the same episode-1-
// has-actually-aired definition the You'll Love panels already gate on,
// engine.js) rather than a bespoke recency window: a show either IS
// currently mid-season (stays in the "What's Airing" table instead, see
// dashboardShared.js's computeWatchStatusRows()) or it isn't, in which
// case there's nothing left to wait for — whether it never started, is
// between seasons, or its season just wrapped, all read the same way
// here: ready. This also implements Bill's explicit follow-up ("once a
// show is finished, it should move to 'watch next' section") for free —
// the moment isActivelyAiring() flips false, a show is simultaneously
// excluded from What's Airing (its own row-inclusion window) and eligible
// here, with no separate hand-off logic needed.
//
// Second recency filter added same day (Bill: "only include shows that
// have aired at least one episode in the last six months") — a show that
// finished its run years ago and just happens to still sit on the
// watchlist isn't a real "what's next" candidate the way a recently-active
// one is. hasAiredRecently() below reads the same two real per-show date
// fields dashboardShared.js's computeWatchStatusRows() already relies on
// for recency: lastEpisodeToAir (always backward-looking) first, then a
// genuinely-past currentSeasonFinale as a fallback for shows enriched
// before that field existed. A show with no air-date signal at all is excluded, not
// defaulted to included — same "don't guess" discipline as everywhere
// else in this file. Checked live before shipping: 34 of 36 enriched
// watchlist shows carry lastEpisodeToAir, 23 pass the 6-month bar — a
// real, non-degenerate filter, not one that empties the list.
//
// Ranked by the engine's real predicted fit (fromWatchlist's bmtreScore) —
// Bill's own "guess my top four" — but the score itself is never shown,
// per his explicit ask; it's purely the ranking mechanism. No longer
// capped to four (Bill: "I want to be able to see everything, not just
// the top four") — every qualifying show is returned, ranked.
//
// coWatchSet is explicitly re-checked HERE, not just relied on via the
// caller already passing a pre-filtered soloWatchlist — Bill's explicit
// ask ("exclude anything on the shows we watch together list") gets its
// own guaranteed enforcement at the point of selection, the same
// belt-and-suspenders precedent isExcluded()'s own watched/watchlist
// double-check already established elsewhere in this file, rather than
// depending on every future caller remembering to pre-filter correctly.
// watchlistKeys is the SAME kind of belt-and-suspenders check (Bill:
// "or one not on my watch list") — every current pick already verified as
// a real watchlist.json member before this was added, but re-checking
// membership here directly (rather than trusting fromWatchlist's own
// provenance) closes the gap for good, the same reasoning coWatchSet
// already got.
// pinnedKeys (nextWatchPins.json — see that file's own "note") go first,
// guaranteed shown regardless of airing/recency status, then genuinely
// in-progress watchlist shows, then the remaining never-started picks
// fill from the normal live ranking.
const RECENT_AIR_WINDOW_DAYS = 182; // ~6 months, Bill's explicit bar
function hasAiredRecently(meta, today) {
  const withinWindow = dateStr => {
    if (!dateStr) return false;
    const d = new Date(dateStr + 'T00:00:00Z');
    if (d > today) return false; // scheduled but hasn't aired yet doesn't count as "has aired"
    return Math.round((today - d) / 86400000) <= RECENT_AIR_WINDOW_DAYS;
  };
  return withinWindow(meta.lastEpisodeToAir?.airDate) || withinWindow(meta.currentSeasonFinale?.finaleDate);
}

// In-progress watchlist shows — folded directly into My Next Watch per
// Bill's explicit ask (2026-09-25: "I don't want a catching up card. I
// want them all in the my next watch card"), reversing the earlier
// "⏩ Catching Up" section this same session had shipped as a separate
// card. Same real criteria as that section had (on the watchlist,
// genuinely in-progress — plays < airedEpisodes — not already covered by
// What's Airing, not co-watched, not the Currently Watching hero), just
// merged into one list instead of rendered separately. Reuses
// buildWatchRow() (already exported from dashboardShared.js) for the row
// shape rather than hand-building one, so title/poster/traktUrl all
// resolve correctly the same way every other buildWatchRow() consumer
// already gets for free.
//
// Sorted AHEAD of never-started picks (own internal order: rating desc,
// then how much is stacked up) — a show Bill's demonstrably already
// invested in (a real rating, real watch progress) is a more concrete
// "watch this next" signal than a predicted-fit score on something he's
// never started. No attempt to guess which are "dropped" — Trakt has no
// such signal, and this project's own prior investigation
// (quality.js's dropped-show-signal finding) found a genuinely-abandoned
// show is rare in Bill's real data (1 of 366 shows with 3+ episodes) —
// every card just shows the real rating and backlog size so Bill can
// judge for himself.
function pickInProgressWatchlist(library, watchlist, fromWatchlist, fromCandidates, currentlyWatching, enrichedMeta, upcomingSeasons, coWatchProgress, excludeKey, coWatchSet, pinnedSet, onWatchlist, airingKeys) {
  const libByKey = new Map((library.titles || []).map(t => [t.titleKey, t]));
  const wlByKey = new Map((watchlist.titles || []).map(t => [t.titleKey, t]));
  const progressByKey = new Map((currentlyWatching || []).map(t => [t.titleKey, t]));
  const scoredByKey = new Map([...fromWatchlist, ...fromCandidates].map(c => [c.titleKey, c]));
  const keys = (library.titles || [])
    .filter(t => t.type === 'show' && t.titleKey !== excludeKey && !coWatchSet.has(t.titleKey)
      && !pinnedSet.has(t.titleKey) && onWatchlist(t.titleKey) && !airingKeys.has(t.titleKey)
      && t.plays != null && t.airedEpisodes != null && t.plays < t.airedEpisodes && enrichedMeta[t.titleKey])
    .map(t => t.titleKey);
  return keys
    .map(titleKey => ({ ...buildWatchRow(titleKey, {
        inLib: libByKey.get(titleKey), inWl: wlByKey.get(titleKey), inCandidate: null,
        progress: progressByKey.get(titleKey), scored: scoredByKey.get(titleKey),
      }, enrichedMeta, upcomingSeasons, coWatchProgress), inProgress: true }))
    .sort((a, b) => {
      const ra = a.myRating ?? -1, rb = b.myRating ?? -1;
      if (ra !== rb) return rb - ra;
      return (b.episodesReady ?? 0) - (a.episodesReady ?? 0);
    });
}

function pickNextWatch(fromWatchlist, fromCandidates, library, watchlist, currentlyWatching, enrichedMeta, upcomingSeasons, coWatchProgress, excludeKey, coWatchSet = new Set(), pinnedKeys = [], watchlistKeys = null, airingKeys = new Set(), today = new Date()) {
  const byKey = new Map(fromWatchlist.map(c => [c.titleKey, c]));
  const onWatchlist = k => !watchlistKeys || watchlistKeys.has(k);
  // A pin isn't guaranteed to be in fromWatchlist — rankAll() correctly
  // excludes a title from there once it's already in the watched library
  // too (the real Reacher case: Bill is mid-Season-4, so it's an
  // in-progress watch, not a fresh watchlist pick, and never gets scored
  // into fromWatchlist at all). renderNextWatch() only ever needs
  // titleKey/type to look everything else up via enrichedMeta, so a
  // minimal stand-in object is a complete, correct fallback here.
  const pinned = pinnedKeys
    .map(k => byKey.get(k) || (enrichedMeta[k] ? { titleKey: k, type: k.split(':')[0] } : null))
    .filter(c => c && c.type === 'show' && c.titleKey !== excludeKey && !coWatchSet.has(c.titleKey) && onWatchlist(c.titleKey) && enrichedMeta[c.titleKey]);
  const pinnedSet = new Set(pinned.map(c => c.titleKey));
  const inProgress = pickInProgressWatchlist(library, watchlist, fromWatchlist, fromCandidates, currentlyWatching, enrichedMeta, upcomingSeasons, coWatchProgress, excludeKey, coWatchSet, pinnedSet, onWatchlist, airingKeys);
  const live = fromWatchlist
    .filter(c => c.type === 'show' && c.titleKey !== excludeKey && !coWatchSet.has(c.titleKey) && !pinnedSet.has(c.titleKey) && onWatchlist(c.titleKey)
      && enrichedMeta[c.titleKey] && !isActivelyAiring(c, enrichedMeta) && hasAiredRecently(enrichedMeta[c.titleKey], today))
    .sort((a, b) => b.bmtreScoreRaw - a.bmtreScoreRaw);
  return [...pinned, ...inProgress, ...live];
}

// Redesigned from a vertical list of rich rows (poster/network/facts/most-
// recent-episode line) to a poster-card grid (Bill, 2026-09-19: "make it
// visual... I want to be able to see everything, not just the top four")
// — the same tk-shelf-card markup renderWatchCards() already established
// for Shows You Watch Together / What's Airing, wrapped instead of
// horizontally scrolled (.tk-nw-grid, index.html) since this list can now
// run well past what a single scrollable row could show at once. The
// score is still deliberately never shown, per Bill's original explicit
// ask when this panel was first built — subtitleFn reports genre + TMDB
// rating alongside the same "when did this last air" fact the old rich
// rows led with, per his live follow-up feedback ("add in metadata to the
// shows on the right") — real metadata, still no predicted score.
// fromWatchlist candidates already carry real title/year/ids (hydrateTitle
// spreads the source watchlist.json fields), so no per-card metadata
// lookup or adapter is needed beyond what renderWatchCards() itself does.
// subtitleFn/reasonFn both branch on c.inProgress (set by
// pickInProgressWatchlist() above) — a show Bill's already partway
// through gets its real backlog/rating shown (the same subtitle the
// short-lived standalone "Catching Up" card used), a never-started pick
// keeps its original genre/rating/last-aired subtitle plus the engine's
// real explanation. The two read differently enough at a glance (an
// episode count + "so far" vs. a genre/rating line) that mixing them in
// one list doesn't need a visual divider to stay legible.
// ⭐ Gold star (Bill, 2026-09-25: "This is my one stop shop to decide
// what to watch next... let's find a way to gold star the ones I can't
// wait to watch next" → "No I don't need a toggle... for now it is
// everything I marked as a favorite in Trakt"). A starred card sorts to
// the very front of the list, ahead of even in-progress/pinned rows — a
// real Trakt favorite is a stronger, more deliberate "watch this next"
// signal than anything the live ranking or a manual nextWatchPins.json
// entry can infer on its own. Relative order is preserved within each of
// the two resulting groups (stars keep pickNextWatch()'s own order among
// themselves, so several favorites don't scramble how they compare to
// each other).
function sortWithStarsFirst(picks, starredSet) {
  if (!starredSet?.size) return picks;
  const starred = picks.filter(c => starredSet.has(c.titleKey));
  const rest = picks.filter(c => !starredSet.has(c.titleKey));
  return [...starred, ...rest];
}

function renderNextWatch(picks, enrichedMeta, starredSet) {
  const subtitleFn = c => {
    if (c.inProgress) {
      const parts = [];
      if (c.episodesReady) parts.push(`${c.episodesReady} episode${c.episodesReady === 1 ? '' : 's'} ready`);
      if (c.myRating != null) parts.push(`rated ${c.myRating}/10 so far`);
      return parts.join(' · ') || 'Ready to continue';
    }
    const meta = enrichedMeta[c.titleKey] || {};
    const parts = [];
    if (meta.genres?.[0]) parts.push(meta.genres[0]);
    if (meta.voteAverage != null) parts.push(`${meta.voteAverage.toFixed(1)} TMDB`);
    const last = meta.lastEpisodeToAir?.airDate;
    if (last) parts.push(`Last aired ${fmtDate(last)}`);
    else {
      const finale = meta.currentSeasonFinale?.finaleDate;
      parts.push(finale ? `Season finale ${fmtDate(finale)}` : 'Ready to watch');
    }
    return parts.join(' · ');
  };
  renderWatchCards('nextWatch', sortWithStarsFirst(picks, starredSet), enrichedMeta, subtitleFn,
    'Nothing ready on your watchlist right now — everything\'s either mid-season, already watched, or hasn\'t aired an episode in the last six months.',
    c => c.inProgress ? 'You\'re already partway through this one.' : c.reason,
    starredSet);
}

// fmtDate()/renderFamilyWatchList() moved to dashboardShared.js (Bill:
// "build a new URL for this too" — trakt/family.html now needs the exact
// same want-to-watch rendering this card already had, so it became a
// second real caller rather than a discover.js-only helper) — see that
// file's own comment for the full history.

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
    <div class="tk-hero-poster">${posterImgHtml(poster, 'tk-hero-img', 150, 225, true)}</div>
    <div class="tk-hero-body">
      <div class="tk-hero-kicker">🎯 Start here tonight</div>
      <div class="tk-hero-title">
        ${typeIcon(top.type)} ${titleLink(top)}${top.year ? ` <span class="tk-hero-year">(${esc(top.year)})</span>` : ''}
        <span class="tk-hero-badge${top.origin === 'watchlist' ? '' : ' tk-hero-badge-new'}">${top.origin === 'watchlist' ? 'Watchlist' : 'New pick'}</span>
      </div>
      <div class="tk-hero-meta">${esc([runtimeLabel(top, enrichedMeta), metaLine(top, enrichedMeta, omdbMeta, llmTags, reviewedTags)].filter(Boolean).join(' · '))}</div>
      <div class="tk-hero-reason">${esc(top.reason)}</div>
      <div class="tk-hero-actions">
        <a class="tk-btn tk-btn-primary" href="./deepdive.html?key=${encodeURIComponent(top.titleKey)}">🔎 Deep Dive</a>
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

// 4. Pick Up Where You Left Off — currentlyWatching.json is a bare array
// (unlike library/watchlist/candidatePool's {titles:[...]} shape).
// lastWatchedAt carries a real 1970-01-01 placeholder on roughly half of
// these (a bulk-import artifact documented elsewhere in this project) —
// never displayed here for that reason.

// 5. Your taste, in one line — a small, low-risk personality blurb built
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
          llmTags, reviewedTags, currentlyWatching, coWatchTags, upcomingSeasons, personMeta,
          currentlyWatchingFeature, familyWatchlist, bookThemeCounts, nextWatchPins, coWatchProgress
        } = await loadAllData();

  const { idx, fromWatchlist, fromCandidates } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags, bookThemeCounts);
  const enrichedOnly = c => !!enrichedMeta[c.titleKey];
  const byType = (list, type) => list.filter(c => c.type === type && enrichedOnly(c));

  // Manually tagged co-viewing shows (Bill: "I want to manually tag these
  // so they only show up here") — pulled out of every solo-oriented
  // surface below (hero, both You'll Love panels, the time-budget
  // shelves, Because You Loved, and the main airing table) and shown
  // only in their own "Shows You Watch Together" section instead.
  const coWatchKeys = [...new Set(Object.values(coWatchTags || {}).flat())];
  const coWatchSet = new Set(coWatchKeys);
  const soloWatchlist = fromWatchlist.filter(c => !coWatchSet.has(c.titleKey));
  const soloCandidates = fromCandidates.filter(c => !coWatchSet.has(c.titleKey));
  const soloLibrary = { titles: (library.titles || []).filter(t => !coWatchSet.has(t.titleKey)) };
  const soloWatchlistData = { titles: (watchlist.titles || []).filter(t => !coWatchSet.has(t.titleKey)) };
  const soloCurrentlyWatching = (currentlyWatching || []).filter(t => !coWatchSet.has(t.titleKey));

  const generated = new Date(d.generatedAt);
  document.getElementById('subtitleText').textContent =
    `Last refreshed ${generated.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} ` +
    `at ${generated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  document.getElementById('statusText').textContent = 'Loaded from export';

  // Picks first, per Bill's "make sure the main one is fun" ask — the one
  // shared pool (discoverPool) feeds the hero and both shelves below, so
  // nothing here can surface that the You'll Love panels themselves would
  // refuse.
  const pool = discoverPool(soloWatchlist, soloCandidates, enrichedMeta);
  const watchingNow = pickCurrentlyWatching(currentlyWatchingFeature, soloCurrentlyWatching, enrichedMeta);
  if (watchingNow) renderCurrentlyWatchingHero(watchingNow, enrichedMeta, omdbMeta, llmTags, reviewedTags);
  else renderHero(pool, enrichedMeta, omdbMeta, llmTags, reviewedTags);

  // Bill: "put currently watching on the left and my next watch on the
  // right" — excludes whatever's already showing on the left so the two
  // panels can never duplicate a title. watchlistKeys (real watchlist.json
  // membership, co-watch already filtered) is the same belt-and-suspenders
  // re-check coWatchSet already gets — see pickNextWatch()'s own comment.
  //
  // airingRows/airingKeys computed here (moved ahead of the What's Airing
  // render call below) so pickNextWatch() can exclude anything already
  // covered there — reuses What's Airing's own real row set, not a second
  // copy of hasRecentOrUpcomingEpisode()'s date-window logic, so the two
  // sections can never drift out of sync about what's "airing soon."
  const watchlistKeys = new Set(soloWatchlistData.titles.map(t => t.titleKey));
  const airingRows = computeWatchStatusRows(soloLibrary, soloWatchlistData, soloWatchlist, soloCandidates, soloCurrentlyWatching, enrichedMeta, upcomingSeasons, coWatchProgress);
  const airingKeys = new Set(airingRows.map(r => r.titleKey));
  const nextWatchPicks = pickNextWatch(soloWatchlist, soloCandidates, soloLibrary, soloWatchlistData, soloCurrentlyWatching, enrichedMeta, upcomingSeasons, coWatchProgress, watchingNow?.titleKey ?? null, coWatchSet, nextWatchPins?.titleKeys || [], watchlistKeys, airingKeys);
  // ⭐ Gold star — a real Trakt favorite (library.json/watchlist.json's
  // own `favorite` flag from Bill's export), computed live off the full
  // (not co-watch-filtered) data — see computeFavoriteStars()'s own
  // comment for why this is a plain rule now, not a stored preference.
  const starredSet = computeFavoriteStars(library, watchlist);
  renderNextWatch(nextWatchPicks, enrichedMeta, starredSet);

  renderFamilyWatchList(familyWatchlist, enrichedMeta);

  // Bill: "the separate section for me to find new shows will be the
  // existing Shows You'll Love. If I show on my 'watch next' or 'shows we
  // watch together', it shouldn't show up here." Co-watch is already
  // excluded (soloWatchlist/soloCandidates, above) — this adds the same
  // exclusion for whatever My Next Watch just picked, so a title can never
  // appear in both panels at once. Movies aren't affected (My Next Watch
  // is shows-only), so movieRecList's pool is untouched.
  const nextWatchKeySet = new Set(nextWatchPicks.map(c => c.titleKey));
  const showWatchlistForRec = byType(soloWatchlist, 'show').filter(c => !nextWatchKeySet.has(c.titleKey));
  renderRecPanel('movieRecList', byType(soloWatchlist, 'movie'), byType(soloCandidates, 'movie'), enrichedMeta, omdbMeta, llmTags, reviewedTags, personMeta);
  renderRecPanel('showRecList', showWatchlistForRec, byType(soloCandidates, 'show'), enrichedMeta, omdbMeta, llmTags, reviewedTags, personMeta);

  const coWatchRows = computeCoWatchRows(coWatchKeys, library, watchlist, candidatePool, fromWatchlist, fromCandidates, currentlyWatching, enrichedMeta, upcomingSeasons, coWatchProgress);
  renderCoWatchCards('coWatchCards', coWatchRows, enrichedMeta);
  renderWatchStatusTable('coWatchTable', coWatchRows, 'Nothing tagged yet.');
  initCoWatchViewToggle();
  renderAiringCards('airingCards', airingRows, enrichedMeta);
  renderWatchStatusTable('airingStatusTable', airingRows,
    'Nothing you\'re tracking or would love is currently mid-season or airing.');
  initAiringViewToggle();

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
  renderTasteLine(genreStats, crowdCompare, castStats, tenRatedCount);

  renderBestMatches(computeBestMatches(library, enrichedMeta, omdbMeta, idx), enrichedMeta);

  renderStatTiles(d.summary, crowdCompare);

  renderAllTitlesTable(buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, llmTags, personMeta));
}

initCollapsibleCards();

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load dashboard data — see console.';
  document.getElementById('subtitleText').textContent = 'No export loaded yet.';
  console.error(err);
});
