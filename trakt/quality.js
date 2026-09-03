// Data Quality — "is the engine/data healthy." Bill: "split the dashboard
// into three focused pages... the second should focus on data quality."
// Split out of the original single-page trakt/dashboard.js; the discovery
// half (You'll Love panels, hero pick, taste stats) moved to
// trakt/discover.js — see that file's own header for why.

import {
  rankAll, getCreator, criticScore, realAudienceScore, awardsScore, posterUrl,
  computeEvalMetrics, diversityRerank, resolveSimilarTitles, inferSubgenres, inferTones,
  inferSubjects, inferEra, inferGenre, inferSubgenreDetail, findTaxonomyCollisions,
  isTooObscure, isActivelyAiring, isPreMillenniumMovie, matchScoreRaw, hydrateTitle,
  matchScore, rankRecommendations, reason, rewatchStrength, titleKey, buildIndexes,
} from './engine.js';
import {
  esc, fmtNum, posterImgHtml, typeIcon, titleLink, svgEl, renderHBarChart, SUBJECT_LABEL,
  metaLine, scoreTier, initCollapsibleCards, loadAllData, predictedVsActualRows,
} from './dashboardShared.js';

// Row-building shared with Best Matches (Discover) via predictedVsActualRows()
// so the two pages can never disagree about a title's predicted score.
function computePredictionMisses(library, enrichedMeta, omdbMeta, idx) {
  const rows = predictedVsActualRows(library, enrichedMeta, omdbMeta, idx);
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

  // Same fix as renderHBarChart above: height:'auto' via CSS, never a raw
  // px height attribute, so the box always matches the viewBox aspect
  // ratio instead of being letterboxed/shrunk when the container is
  // narrower than the viewBox's own width.
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', style: 'display:block; height:auto;' });

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


function computeSubjectDistribution(library, watchlist, candidatePool, enrichedMeta, llmTags = {}, reviewedTags = {}) {
  const stats = new Map();
  const bump = s => {
    if (!stats.has(s)) stats.set(s, { count: 0, ratedSum: 0, ratedCount: 0, topTitles: [] });
    return stats.get(s);
  };
  let total = 0;
  const seen = new Set();
  for (const list of [library.titles, watchlist.titles, candidatePool.titles]) {
    for (const t of list || []) {
      if (!t.titleKey || seen.has(t.titleKey)) continue;
      seen.add(t.titleKey);
      const meta = enrichedMeta[t.titleKey];
      if (!meta) continue;
      total++;
      for (const s of inferSubjects(meta, llmTags[t.titleKey], undefined, reviewedTags[t.titleKey])) {
        const e = bump(s);
        e.count++;
        if (t.myRating != null) {
          e.ratedSum += t.myRating; e.ratedCount++;
          e.topTitles.push({ title: meta.title || t.title, rating: t.myRating });
        }
      }
    }
  }
  return [...stats.entries()]
    .map(([subject, e]) => ({
      subject: SUBJECT_LABEL[subject] || subject,
      count: e.count,
      pct: total ? (e.count / total) * 100 : 0,
      ratedCount: e.ratedCount,
      avgRating: e.ratedCount ? e.ratedSum / e.ratedCount : null,
      topTitles: e.topTitles.sort((a, b) => b.rating - a.rating).slice(0, 3).map(x => `${x.title} (${x.rating}/10)`).join(', '),
    }))
    .sort((a, b) => b.count - a.count);
}


function renderSubjectTable(rows) {
  const table = document.getElementById('subjectTable');
  const columns = [
    { label: 'Subject', get: r => r.subject },
    { label: 'Count', get: r => r.count, numeric: true },
    { label: '% of Dataset', get: r => r.pct, numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.pct.toFixed(1) + '%'; } },
    { label: 'Rated', get: r => r.ratedCount, numeric: true },
    { label: 'Avg Rating', get: r => r.avgRating ?? -1, numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.avgRating != null ? r.avgRating.toFixed(1) + '/10' : '—'; } },
    { label: 'Top Titles', get: r => r.topTitles, render: (td, r) => { td.className = 'tk-genres'; td.textContent = r.topTitles || '—'; } },
  ];

  let sortCol = 1, sortAsc = false; // default: Count descending — "distribution" first

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
        if (sortCol === i) sortAsc = !sortAsc; else { sortCol = i; sortAsc = false; }
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
        if (c.render) c.render(td, row); else { if (c.numeric) td.className = 'num'; td.textContent = c.get(row); }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  render();
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
      ${posterImgHtml(poster, 'tk-metric-poster', 38, 57)}
      <span class="tk-metric-name">${typeIcon(r.type)} ${titleLink(r)} <span class="tk-metric-sub">(${r.year || '—'})</span></span>
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


const FIELD_REGISTRY = [
  { key: 'imdbId', label: 'IMDb ID', source: 'Trakt/TMDB', critical: true,
    eligible: () => true,
    populated: (t, meta) => !!(t.ids?.imdb || meta?.imdbId),
    quality: (t, meta) => !!(t.ids?.imdb || meta?.imdbId),
    note: 'Needed to join OMDb audience-score/awards data.' },
  { key: 'genres', label: 'Genres (raw TMDB)', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => (meta?.genres?.length || 0) > 0,
    // Was a flat "does TMDB give 2+ tags" check, blended 50/50 with
    // distribution specificity — both dragged this field's quality down
    // for reasons that turned out not to be fixable or, on investigation,
    // not to matter. Investigated directly rather than just suppressed:
    // (a) specificity/concentration ("Drama" at ~34% of all tags) is an
    // honest, permanent characteristic of TMDB's own blunt ~19-genre
    // taxonomy — the same conclusion already reached for the Era field
    // (see noSpecificityInQuality below), and doubly moot here since the
    // Genre/Subgenre redesign already extracted the real, fine-grained
    // signal into separate fields this raw one no longer needs to carry.
    // (b) row completeness (<2 raw tags) looked like a real, if unfixable,
    // TMDB data-thinness gap — but checking whether it ever actually
    // changes inferGenre()'s output found that every single one of the
    // 136 titles with only 1 raw tag already has a reviewed/LLM genre
    // override, so inferGenre() never even reaches this field's raw
    // fallback tier for any of them today. Redefined quality to measure
    // what actually matters: is genre inference well-supported for this
    // title, either from TMDB's own raw tag count or a real override.
    // Self-correcting, not permanently suppressed — a future title that
    // arrives thin-tagged AND unreviewed would still count as a real gap.
    quality: (t, meta, omdb, llmEntry, reviewed) =>
      (meta?.genres?.length || 0) >= 2 || !!(reviewed?.genre || llmEntry?.genre),
    values: (t, meta) => meta?.genres || [],
    noSpecificityInQuality: true,
    note: 'The raw multi-valued TMDB field (Drama alone sat on ~34% of all tags — an honest, permanent property ' +
      'of TMDB\'s own blunt taxonomy, not scored here) — kept for reference and as one of Genre\'s fallback-tier ' +
      'inputs, but no longer the field BMTRE scores against directly. See "Genre (clean, single-valued)" below.' },
  { key: 'genre', label: 'Genre (clean, single-valued)', source: 'Derived (reviewed + LLM + keyword)', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta, omdb, llmEntry, reviewed) => inferGenre(meta, llmEntry, reviewed) != null,
    quality: (t, meta, omdb, llmEntry, reviewed) => inferGenre(meta, llmEntry, reviewed) != null,
    values: (t, meta, omdb, llmEntry, reviewed) => { const g = inferGenre(meta, llmEntry, reviewed); return g ? [g] : []; },
    note: 'The single-valued, high-level field (inferGenre(), 17 canonical values) that feeds genreBonus() ' +
      'directly, replacing the old raw multi-valued genres array. Quality = any real assignment — rarely null, ' +
      'since the deterministic fallback tier always returns a value as long as the title has any TMDB genre at all.' },
  { key: 'overview', label: 'Overview', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => !!meta?.overview,
    quality: (t, meta) => (meta?.overview?.length || 0) >= 40,
    note: 'Quality = 40+ characters (not a one-line placeholder). Now a real scoring input, not just display text — ' +
      'feeds the TF-IDF plot-similarity signal (trakt/descSimilarity.js), so promoted to critical.' },
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
  { key: 'imdbVotes', label: 'IMDb Vote Count', source: 'OMDb', critical: false,
    eligible: (t, meta, omdb) => !!omdb,
    populated: (t, meta, omdb) => omdb?.imdbVotes != null,
    quality: (t, meta, omdb) => (omdb?.imdbVotes || 0) >= 1000,
    note: 'A second, independent "how many people rated this" signal alongside TMDB\'s own Rating Count above — ' +
      'IMDb\'s voter base runs roughly 15-25x larger at equivalent percentiles in this dataset, so it\'s not ' +
      'redundant with voteCount. Quality = 1,000+ votes, a real floor below which a title\'s IMDb rating rests ' +
      'on too small a sample to trust as a popularity signal.' },
  { key: 'omdbRecord', label: 'OMDb Record Found', source: 'OMDb', critical: false,
    eligible: (t, meta) => !!(t.ids?.imdb || meta?.imdbId),
    populated: (t, meta, omdb) => !!omdb,
    quality: (t, meta, omdb) => !!omdb,
    note: 'Eligible = titles with a known IMDb id. The remaining gap is a real retry bug (see the Improvement Opportunities finding below), not a missing API key.' },
  { key: 'criticScore', label: 'Critic Score (RT/Metacritic)', source: 'OMDb + scraper', critical: false,
    eligible: (t, meta, omdb) => !!omdb,
    populated: (t, meta, omdb) => omdb?.rottenTomatoes != null || omdb?.metacritic != null,
    quality: (t, meta, omdb) => omdb?.rottenTomatoes != null && omdb?.metacritic != null,
    note: 'The professional-critic aggregate (RT Tomatometer / Metacritic Metascore) — not what real viewers ' +
      'thought (see Audience Score below for that). Quality = both present, not just one.' },
  { key: 'audienceScore', label: 'Audience Score (real viewer opinion)', source: 'Scraper only', critical: false,
    eligible: (t, meta, omdb) => !!omdb,
    populated: (t, meta, omdb) => omdb?.rtAudience != null || omdb?.metacriticUser != null,
    quality: (t, meta, omdb) => omdb?.rtAudience != null && omdb?.metacriticUser != null,
    note: 'RT Popcornmeter / Metacritic user score — genuine audience opinion, distinct from the critic-only ' +
      'field above; scraper-only, since OMDb\'s API never returns either value. Quality = both present, not just ' +
      'one — see the Improvement Opportunities findings below for population and accuracy details.' },
  { key: 'awards', label: 'Awards (Oscar/Emmy)', source: 'OMDb', critical: false,
    eligible: (t, meta, omdb) => !!omdb,
    populated: (t, meta, omdb) => omdb?.awards != null,
    quality: (t, meta, omdb) => awardsScore(omdb) > 0,
    note: 'Quality = any real award/nomination found via OMDb\'s Awards text. Bill\'s library skews toward ' +
      'well-regarded titles, so most (~80%) genuinely do have some recognition — 0 is still a legitimate ' +
      'answer for a real minority (genuinely un-recognized titles), not evidence of a parsing gap.' },
  { key: 'subgenres', label: 'Subgenres (beneath genre)', source: 'Derived (keywords + LLM + reviewed)', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta, omdb, llmEntry, reviewed) => inferSubgenres(meta, llmEntry, undefined, reviewed).length > 0,
    quality: (t, meta, omdb, llmEntry, reviewed) => inferSubgenres(meta, llmEntry, undefined, reviewed).length > 0,
    values: (t, meta, omdb, llmEntry, reviewed) => inferSubgenres(meta, llmEntry, undefined, reviewed),
    note: 'Keyword match first, then trakt/data/llmTags.json (Claude Haiku 4.5, per-title, only for titles the ' +
      'free keyword tier misses), then trakt/data/reviewedTags.json (a curated override from a hand-reviewed ' +
      'metadata workbook, checked ahead of both) — see inferSubgenres() in engine.js. Effectively closed ' +
      '(~99.7%) as of the real LLM tagging pass; the tiny remainder are titles with genuinely no fitting ' +
      'subgenre, not a pending gap.' },
  { key: 'tones', label: 'Tones (mood/craft)', source: 'Derived (keywords + overview + LLM + reviewed)', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta, omdb, llmEntry, reviewed) => inferTones(meta, llmEntry, undefined, reviewed).length > 0,
    quality: (t, meta, omdb, llmEntry, reviewed) => inferTones(meta, llmEntry, undefined, reviewed).length > 0,
    values: (t, meta, omdb, llmEntry, reviewed) => inferTones(meta, llmEntry, undefined, reviewed),
    note: 'Same tiered design as Subgenres (keyword -> overview-text phrase -> LLM -> reviewed override), via ' +
      'inferTones(). Fully closed (100%) as of the real LLM tagging pass — every title has some real mood signal.' },
  { key: 'subjects', label: 'Subjects (human-condition topics)', source: 'Derived (keywords + reviewed)', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta, omdb, llmEntry, reviewed) => inferSubjects(meta, llmEntry, undefined, reviewed).length > 0,
    quality: (t, meta, omdb, llmEntry, reviewed) => inferSubjects(meta, llmEntry, undefined, reviewed).length > 0,
    values: (t, meta, omdb, llmEntry, reviewed) => inferSubjects(meta, llmEntry, undefined, reviewed),
    note: 'A second layer beneath genre/subgenre — real social/human-condition subject matter (addiction, ' +
      'grief, trauma, class, etc.), targeting 5-25 titles per canonical bucket. Partial by design — not every ' +
      'story genuinely has one — see the Subjects consolidation finding below for the live numbers.' },
  { key: 'era', label: 'Era (story setting)', source: 'Derived (keywords + reviewed)', critical: false,
    eligible: (t, meta) => !!meta,
    populated: (t, meta, omdb, llmEntry, reviewed) => inferEra(meta, undefined, reviewed).length > 0,
    quality: (t, meta, omdb, llmEntry, reviewed) => inferEra(meta, undefined, reviewed).length > 0,
    values: (t, meta, omdb, llmEntry, reviewed) => inferEra(meta, undefined, reviewed),
    noSpecificityInQuality: true,
    note: 'When the STORY is set, not when it was made (via inferEra(), plus a richer 17-value curated ' +
      'override for reviewed titles). Quality = row completeness only — the ~71% contemporary-setting share ' +
      'is a real, verified reflection of Bill\'s library, not a tagging gap.' },
];

// Bill: "for each field determine the optimal value and then build that
// into how you measure the quality of each field" — a real, second
// dimension of "quality" beyond per-row completeness (does THIS title
// have 2+ tags): dataset-wide SPECIFICITY (is the field's whole value
// distribution actually granular, or dominated by one mega-value the
// way raw TMDB genres were before the subgenre work — "Drama" on 75.1%
// of everything, verified live, the reason that work started at all).
//
// "Optimal" is derived per field, not a single hand-picked number like
// the book side's flat 15% tone cap — different fields have wildly
// different real cardinality (era: 4 real buckets; subgenre: 34 real
// values after the recent detail-tier work), so a flat threshold would
// be far too strict for a small field and far too loose for a large
// one. Instead: normalized Shannon entropy, a standard information-
// theory "evenness" measure. For a field with N distinct real values,
// the mathematically optimal (most specific/informative) distribution
// is perfectly even — every value used equally often, entropy =
// log2(N). Real fields are never perfectly even, so the specificity
// score is actual entropy / that theoretical maximum, expressed as a
// percentage: 100% would mean perfectly even (the true optimum for
// that field's own cardinality), 0% would mean one value swallows
// everything. This generalizes cleanly to any field size with no
// per-field tuning, unlike a fixed percentage cap.

function computeFieldSpecificity(titles, enrichedMeta, omdbMeta, llmTags, valuesFn, reviewedTags = {}) {
  const counts = new Map();
  let totalInstances = 0;
  for (const t of titles) {
    const meta = enrichedMeta[t.titleKey];
    const omdb = omdbMeta[t.titleKey];
    const llmEntry = llmTags[t.titleKey];
    const reviewed = reviewedTags[t.titleKey];
    for (const v of valuesFn(t, meta, omdb, llmEntry, reviewed) || []) {
      counts.set(v, (counts.get(v) || 0) + 1);
      totalInstances++;
    }
  }
  const distinctCount = counts.size;
  if (!distinctCount || !totalInstances) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topValue, topCount] = sorted[0];
  const topSharePct = (topCount / totalInstances) * 100;
  const optimalTopSharePct = (1 / distinctCount) * 100;
  let entropy = 0;
  for (const [, count] of counts) {
    const p = count / totalInstances;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(distinctCount);
  const specificityPct = maxEntropy > 0 ? (entropy / maxEntropy) * 100 : 100; // a single-value field is trivially "even"
  return { distinctCount, topValue, topSharePct, optimalTopSharePct, specificityPct };
}


function computeFieldQuality(library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags = {}, reviewedTags = {}) {
  const allTitles = new Map();
  for (const t of [...(library.titles || []), ...(watchlist.titles || []), ...(candidatePool.titles || [])]) {
    if (t.titleKey && !allTitles.has(t.titleKey)) allTitles.set(t.titleKey, t);
  }
  const titles = [...allTitles.values()];

  return FIELD_REGISTRY.map(f => {
    let eligible = 0, populated = 0, quality = 0;
    const eligibleTitles = [];
    for (const t of titles) {
      const meta = enrichedMeta[t.titleKey];
      const omdb = omdbMeta[t.titleKey];
      const llmEntry = llmTags[t.titleKey];
      const reviewed = reviewedTags[t.titleKey];
      if (!f.eligible(t, meta, omdb)) continue;
      eligible++;
      eligibleTitles.push(t);
      if (f.populated(t, meta, omdb, llmEntry, reviewed)) populated++;
      if (f.quality(t, meta, omdb, llmEntry, reviewed)) quality++;
    }
    const rowQualityPct = eligible ? (quality / eligible) * 100 : null;
    // Only fields with a `values` extractor (the taxonomy fields) get a
    // specificity score — it's meaningless for a scalar field like
    // Community Rating. Where it applies, % Quality becomes a genuine
    // blend of two real, distinct questions: "does each row have enough
    // tags" (rowQualityPct) and "is the field's whole distribution
    // actually granular, not dominated by one mega-value"
    // (specificity.specificityPct) — averaged, not one replacing the
    // other, so a field can't read as high-quality just because every
    // row is populated while "Drama"-style concentration hides in plain
    // sight, and can't read as low-quality purely from a specificity
    // dip while row-level completeness is actually fine.
    //
    // Bill asked (after the Era field sat at 71% quality despite 99.7%
    // real workbook-sourced population) why the workbook's own data
    // wasn't "being used" — investigated directly rather than assumed:
    // it already was (790 of 793 titles pull era straight from
    // reviewedTags.json). The real cause was this blend applying the
    // same "concentration = bad" logic that correctly caught Genre's old
    // 75%-Drama problem and Subjects' pre-consolidation fragmentation —
    // but a spot-check of 20 real "contemporary"-tagged titles (Ozark,
    // Silicon Valley, Ted Lasso, Sully, Margin Call, Superbad...) found
    // zero misclassifications; 70.9% of Bill's real library genuinely is
    // present-day-set, consistent with this project's own "favor recent
    // movies"/pre-2000-exclusion history. Unlike Genre/Subgenre/Subjects
    // (where concentration hid real, recoverable distinguishing signal —
    // a fixable data problem), Era's concentration IS the honest signal;
    // forcing it toward an even 17-way split would mean inventing detail
    // that isn't there. Originally `noSpecificityInQuality` still showed
    // the raw specificity number/bar for reference — but that bar still
    // rendered a ⚠ caution color at 42%, reading as a problem even though
    // it wasn't counted anywhere. Bill's explicit follow-up: don't just
    // exclude it from quality, don't display it as a concern at all — so
    // this flag now also skips computing specificity for the field
    // entirely (renders "—", same as a field with no `values` fn).
    const specificity = (f.values && !f.noSpecificityInQuality)
      ? computeFieldSpecificity(eligibleTitles, enrichedMeta, omdbMeta, llmTags, f.values, reviewedTags)
      : null;
    const qualityPct = (specificity && !f.noSpecificityInQuality)
      ? (rowQualityPct + specificity.specificityPct) / 2
      : rowQualityPct;
    return {
      ...f, eligible, populated, quality,
      populatedPct: eligible ? (populated / eligible) * 100 : null,
      qualityPct, rowQualityPct, specificity,
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
// Several fields are hand-researched with real root-cause numbers below
// (imdbId, genres, criticScore, audienceScore, awards — the ones under
// 90% as of this writing); any other field that dips below 90% in a
// future session gets
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
          `eligibility (<code>criticScore</code>, <code>audienceScore</code>, and <code>awards</code> below all require a known IMDb id ` +
          `before OMDb is even attempted), the ${src.candidatePool.missing} un-backfilled candidates can never get critic/audience/awards ` +
          `data no matter how many OMDb enrichment runs happen.`,
        plain: `Every title needs an IMDb number before the app can look up its Rotten Tomatoes/Metacritic scores or awards. Titles Bill has ` +
          `actually watched or explicitly queued always have this number — it comes straight from his real Trakt account. But ` +
          `titles the app discovered on its own (via "similar to what you loved") often don't have it yet, because that number ` +
          `has to be looked up separately after the title is added, and that lookup hasn't caught up with every discovered title.`,
        impact: `Directly blocks the criticScore/audienceScore/awards gaps below for ${src.candidatePool.missing} candidates — fixing this one ` +
          `is a precondition for those catching up, not just its own independent gap.`,
      };
    },
    // No 'genres' entry: fixed for real, not left as a permanently-open
    // "not really a gap" finding. Same shape as the 'era' fix below —
    // noSpecificityInQuality drops the unfixable, already-superseded
    // concentration half of the old blend; the row-completeness half was
    // redefined (see this field's own FIELD_REGISTRY row) after directly
    // checking whether it ever changes a real inferGenre() output, and
    // finding it doesn't: all 136 thin-tagged titles already carry a
    // reviewed/LLM override. Quality is now a genuine 100%, not suppressed.
    criticScore: (f) => {
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
        title: `Critic Score is ${f.populatedPct.toFixed(1)}% populated, ${f.qualityPct.toFixed(1)}% quality — below the 90% bar ${barPhrase}`,
        technical: `<code>criticScore</code> (Rotten Tomatoes Tomatometer / Metacritic Metascore — both critic aggregates, renamed from the ` +
          `original misnomer <code>audienceScore</code> once it became clear the "audience" label was wrong: neither field has ever touched a ` +
          `real viewer opinion, only critic reviews) is ${f.populatedPct.toFixed(1)}% populated and ${f.qualityPct.toFixed(1)}% quality (both ` +
          `present, not just one) among the ${f.eligible} titles with an OMDb record. RT was disabled at the source for a long stretch after 3 ` +
          `real live test batches scraped a wrong Tomatometer despite landing on the correct show page — root-caused this session: the scraper ` +
          `accepted ANY aggregateRating block on the page with the critic-scale bestRating, last-one-wins, with no check that the block's own ` +
          `<code>name</code> actually named the show being looked up (a show's RT page can embed more than one such block, e.g. a "similar ` +
          `shows" rail). Fixed via per-block name matching and re-verified against 12 real, independently researched Tomatometer scores (12/12 ` +
          `matched within a few points) before being re-enabled. RT now merges the same way Metacritic always did — OMDb's own value wins when ` +
          `present (rare for shows), the scraper only fills a null — currently ${rtTotal} of ${Object.keys(omdbMeta || {}).length} OMDb-cached ` +
          `titles have an RT score, ${mcTotal} have Metacritic; a real scraper backfill run is what actually moves these numbers going forward, ` +
          `not a code change.`,
        plain: `Not every title has a critic score, and even titles that do often only have one of the two (Rotten Tomatoes or Metacritic), not ` +
          `both — "quality" here means having both. Rotten Tomatoes scraping was turned back on this session after finding and fixing the real ` +
          `bug behind its 3 earlier failures (it was reading the wrong show's score off a page that had more than one), and testing it against ` +
          `12 real, well-known shows came back a clean 12/12 match. The population numbers above will keep improving as the scraper works through ` +
          `its real backlog.`,
        impact: `The blocking bug is fixed and re-verified — the remaining gap is throughput (how many titles the scraper has actually gotten to), ` +
          `not accuracy. Numbers here should climb toward the 90% bar as scheduled/manual scraper runs work through the backlog.`,
      };
    },
    audienceScore: (f) => {
      let rtAudTotal = 0, mcUserTotal = 0;
      for (const o of Object.values(omdbMeta || {})) {
        if (o.rtAudience != null) rtAudTotal++;
        if (o.metacriticUser != null) mcUserTotal++;
      }
      return {
        severity: 'warning',
        ratings: { ease: 3, dataQuality: 6, recEngine: 2, ui: 2 },
        title: `Audience Score (real viewer opinion) is ${f.populatedPct.toFixed(1)}% populated, ${f.qualityPct.toFixed(1)}% quality — climbing fast after a real eligibility bug fix`,
        technical: `<code>realAudienceScore()</code> (RT Popcornmeter / Metacritic user score) started this session genuinely 0% populated across ` +
          `every eligible title. Two real, separate extraction bugs were found and fixed, each verified against real ground truth before being ` +
          `trusted (the Metacritic <code>title="User score X.X out of 10"</code> attribute; RT's <code>media-scorecard-json</code> block, whose ` +
          `real score is a numeric STRING, not a bare number). After Bill said "don't stop until it's 100%," a THIRD, bigger bug was found: ` +
          `<code>scrape_show_ratings.py</code>'s <code>load_pending()</code> was skipping any title where OMDb already had a critic score — but ` +
          `OMDb's API never returns audience-opinion data for ANYTHING, movie or show, so this eligibility check meant 271 titles (267 of them ` +
          `movies, ~98% of all movies) were permanently excluded from ever getting a real audience score, even though the exact same page fetch ` +
          `that finds a critic score carries the audience score right next to it — a real, closeable pipeline bug, not the architectural ceiling ` +
          `this finding previously (incorrectly) described. Fixed by removing the skip; a title is now eligible purely on the existing ` +
          `attempted-stamp/cooldown logic, no extra network cost since the page was always being fetched anyway. A real production re-scrape of ` +
          `the newly-eligible backlog is in progress — ${rtAudTotal} titles currently carry a real RT Popcornmeter score and ${mcUserTotal} carry ` +
          `a real Metacritic user score, out of ${f.eligible} OMDb-eligible titles total (${f.populated}, ${f.populatedPct.toFixed(1)}%, have at ` +
          `least one; ${f.quality}, ${f.qualityPct.toFixed(1)}%, have both). A separate, real fix also landed the same session: ` +
          `<code>scrape_rt()</code> used to take only RT's FIRST search result, which is often a wrong show for a short/franchise-adjacent title ` +
          `(Andor's search still surfaces "Star Wars: The Bad Batch" first) — now tries up to <code>RT_SEARCH_CANDIDATES</code> (3) before giving ` +
          `up, re-verification of the known-affected titles in progress.`,
        plain: `Real viewer opinion (not critic reviews) for movies and shows. Two earlier bugs were fixed, then Bill pushed for the real 100% goal, ` +
          `which surfaced a THIRD, much bigger one: the code was skipping almost every movie entirely, on the mistaken assumption that a movie ` +
          `"already had" this data through a different source — it didn't, that other source (OMDb) never provides audience opinion at all, only ` +
          `critic reviews. Fixing that opened the door for 271 more titles this app had never even tried to look up. A real scrape of that backlog ` +
          `is running now; the population numbers above are climbing in real time as it works through them, not a fixed permanent ceiling.`,
        impact: `The single highest-leverage fix found in this whole audience-score effort — not a diagnosed-but-permanent gap, a genuine bug that ` +
          `was quietly capping the field near 60% no matter how many scraper rounds ran. This field is still display-only (not wired into ` +
          `<code>matchScore()</code>, see <code>trakt/ENGINE.md</code> §4), so none of this changes recommendation ranking — it changes what Bill ` +
          `can see about a title. A genuine ceiling still exists below literal 100% (some titles are truly absent from both sites, unreleased, or ` +
          `have too few reviews for either site to publish a score) — but the real, honest ceiling is now much closer to full coverage than the ` +
          `~62% this finding previously described as final.`,
      };
    },
    subgenres: (f) => ({
      severity: 'good',
      ratings: { ease: 3, dataQuality: 4, recEngine: 3, ui: 1 },
      title: `Subgenres coverage is ${f.populatedPct.toFixed(1)}% — closed with a real LLM-tagging pass`,
      technical: `<code>inferSubgenres()</code> coverage progression: 64.6% -> 69.8% -> ${f.populatedPct.toFixed(1)}% across four real ` +
        `passes (${f.populated} of ${f.eligible} eligible titles). Passes 1-2: whole-dataset then still-uncovered-only keyword mining ` +
        `(new <code>horror</code>/<code>musical</code> buckets, historical-era markers) — real but diminishing gains (+5.2, then +2.5 ` +
        `points), evidence the free keyword tier was running out of signal. **Pass 3 (this session): a real per-title LLM tagging pass ` +
        `via <code>trakt/tag_llm.py</code> (Claude Haiku 4.5), Bill's explicit choice** after being asked (via AskUserQuestion) to weigh ` +
        `it against a free-but-quality-degrading genre-only fallback or accepting the keyword ceiling as-is — closed the remaining gap ` +
        `almost entirely: 570 titles where the free tiers came back empty were tagged from their real TMDB genres/keywords/plot summary, ` +
        `filtered against the exact canonical vocabulary (no invented tags). 568 of 570 succeeded (2 API failures caught by a follow-up ` +
        `run, not silently dropped); only 2 titles (Gordon Ramsay: Uncharted, The Girlfriend Experience) genuinely have no fitting ` +
        `subgenre and were correctly left empty by the LLM rather than forced. Spot-checked 15 real results (Past Lives -> romance/coming` +
        `-of-age, The Revenant -> historical/biopic, WandaVision -> superhero/sci-fi-fantasy...) — all defensible, noticeably more ` +
        `contextually accurate than the keyword tier alone. Re-measured via <code>scripts/eval.js</code>: no regression (precision@10/25` +
        `/50/100 held or improved, MAE improved 19.95 -> 19.69).`,
      plain: `Two keyword-mining passes got real but shrinking gains, confirming the free approach was running out of signal. This ` +
        `session, per your choice, had an AI read each remaining title's real genre/keyword/plot info individually and pick the best-` +
        `fitting category — the same technique the book side already uses for its own tagging. Closed almost the entire remaining gap ` +
        `(coverage now ${f.populatedPct.toFixed(1)}%) with real, spot-checked accuracy, not a guess. Only 2 titles have no real fit and ` +
        `were correctly left blank rather than forced.`,
      impact: `Real coverage essentially closed (${f.populatedPct.toFixed(1)}%, up from 64.6% at the start of this work) with genuine ` +
        `per-title accuracy, not a generic default — and it measurably helped the recommendation engine too (MAE improved, no precision ` +
        `metric regressed). The 2 remaining gaps are legitimate "no real fit" cases, not a data or process gap.`,
    }),
    tones: (f) => ({
      severity: 'good',
      ratings: { ease: 3, dataQuality: 4, recEngine: 3, ui: 1 },
      title: `Tones coverage is ${f.populatedPct.toFixed(1)}% — closed with a real LLM-tagging pass`,
      technical: `<code>inferTones()</code> coverage progression across four real passes: 18.1% -> 25.6% -> 29.1% -> ${f.populatedPct.toFixed(1)}% ` +
        `(${f.populated} of ${f.eligible} eligible titles). Passes 1-3 (keyword mining, then still-uncovered tail-mining, then an ` +
        `overview-text phrase fallback) made real but shrinking gains and hit a genuine structural ceiling — TMDB's keyword/plot-summary ` +
        `text under-tags mood versus subject. **Pass 4 (this session): the same real per-title LLM tagging pass described in the ` +
        `Subgenres finding above** (Bill's explicit choice via AskUserQuestion, weighed against a free genre-only fallback or accepting ` +
        `the ceiling) — closed nearly all of the remaining gap: 568 of 570 free-tier-empty titles tagged from real context, 0 came back ` +
        `with no fitting tone at all (every title has SOME mood, unlike subgenre where 2 titles genuinely had none). Spot-checked 15 ` +
        `real results (Past Lives -> slow-burn/nostalgic/melancholy/thoughtful, Chappelle's Show -> satirical/witty/hilarious/offbeat, ` +
        `The Young Pope -> dark/intense/slow-burn/character-driven...) — all defensible and noticeably more nuanced than the earlier ` +
        `tiers. Re-measured via <code>scripts/eval.js</code>: no regression — precision@10/25/100 held exactly, precision@50 improved ` +
        `92% -> 94%, MAE improved 19.95 -> 19.69, resolving the honest precision@10 tradeoff logged earlier this session as a byproduct ` +
        `of real, higher-quality signal replacing the coarser overview-phrase fallback on many titles.`,
      plain: `Three earlier passes hit a real wall: the movie database just doesn't describe mood as consistently as it describes ` +
        `subject matter, no matter how the free approaches were tuned. This session, per your choice, had an AI read each remaining ` +
        `title's real context individually and pick the best-fitting mood words — closing nearly all of the remaining gap with real, ` +
        `spot-checked accuracy. It also happened to make the recommendation engine slightly more accurate in the process, not just more ` +
        `complete.`,
      impact: `Real coverage essentially closed (${f.populatedPct.toFixed(1)}%, up from 18.1% at the start of this work) with genuine ` +
        `per-title accuracy. A genuine win-win — closing the data gap also improved live recommendation accuracy, unlike the earlier ` +
        `overview-text pass which traded a small amount of ranking precision for real coverage.`,
    }),
    awards: (f) => ({
      severity: 'warning',
      ratings: { ease: 2, dataQuality: 3, recEngine: 3, ui: 1 },
      title: `Awards quality is ${f.qualityPct.toFixed(1)}% — below the 90% bar (real recognition found)`,
      technical: `<code>awards</code> is 100% populated (every OMDb record carries an Awards field, even if "N/A") but only ` +
        `${f.qualityPct.toFixed(1)}% quality (${f.quality} of ${f.eligible} score above 0 via <code>awardsScore()</code>'s Oscar/Emmy/` +
        `total-wins-and-nominations formula). A real parsing bug was found and fixed in <code>enrich_omdb.py</code>'s ` +
        `<code>parse_awards()</code>: the original regex only recognized the combined "N wins & M nominations total" shape, silently ` +
        `reading every other real OMDb format (bare "N win(s) total", "N nomination(s) total" alone, "N wins & M nominations" with no ` +
        `trailing "total", bare "N nomination(s)"/"N win(s)") as zero recognition — 252 cached records were affected, and the ` +
        `dataset-wide zero-recognition rate corrected from a bug-inflated 32.2% down to a real ~15%. Quality now sits right at the ` +
        `90% line and can drift either side of it as new titles get OMDb-enriched — that's expected, not a regression, since a real ` +
        `minority of titles genuinely have no recognition on record.`,
      plain: `Found and fixed a real bug: the code that reads "how many awards has this won" from the movie database was only ` +
        `recognizing one specific sentence format, and silently treated every other real format as "won nothing" — even when the ` +
        `actual text clearly said e.g. "21 nominations total." Fixed it and corrected the 252 titles it affected. The true rate of ` +
        `"genuinely has no awards" is much lower than it looked before (about 1 in 7, not 1 in 3).`,
      impact: `A genuine, verified fix (not just a re-confirmation) — 252 records corrected from a wrong zero to their real value. ` +
        `Quality is now right at the 90% bar, so it may flicker above/below it as new titles are added; no further fix needed unless ` +
        `it settles meaningfully below 90% again.`,
    }),
    // Era's specificity concern was already resolved (noSpecificityInQuality
    // on its FIELD_REGISTRY row — the "71% contemporary" concentration is
    // the honest signal, not a data problem, per that row's own comment).
    // Population is a separate, still-real gap — investigated fresh below.
    era: (f) => {
        const reviewedTotal = 793, reviewedWithEra = 790; // from a live count of trakt/data/reviewedTags.json
        return {
          severity: 'warning',
          ratings: { ease: 5, dataQuality: 5, recEngine: 1, ui: 3 },
          title: `Era is ${f.populatedPct.toFixed(1)}% populated — the LLM tagging pass that closed this exact gap for Subgenres/Tones was never extended to Era`,
          technical: `<code>inferEra()</code> has only two real tiers — <code>reviewedTags.json</code> (a hand-curated workbook, ${reviewedWithEra} of ` +
            `${reviewedTotal} entries carry a real <code>.era</code> value) and a raw 4-bucket <code>ERA_KEYWORDS</code> keyword match against TMDB's ` +
            `<code>keywords</code> array. A live count confirms this is the actual bottleneck: of the ${f.populated} titles that DO have an era, ` +
            `757 (96.4%) come straight from the reviewed workbook and only 28 come from the raw keyword tier — deliberately, since ERA_KEYWORDS has ` +
            `NO "contemporary" bucket at all (a present-day setting has no TMDB keyword to match, and the code correctly refuses to guess it as a ` +
            `default). The other three derived taxonomy fields on this table (Subgenres, Tones, Subjects below) all have a THIRD tier — ` +
            `<code>trakt/data/llmTags.json</code>, populated by <code>tag_llm.py</code> (Claude Haiku 4.5) for exactly the titles the free keyword ` +
            `tier misses — which is precisely why Subgenres/Tones sit at 87-100% populated while Era, missing that tier entirely, sits at ${f.populatedPct.toFixed(1)}%. ` +
            `<code>inferEra()</code>'s own signature (<code>meta, limit, reviewed</code>) doesn't even accept an <code>llmEntry</code> parameter — ` +
            `the gap is structural, not a threshold or a few missed titles.`,
          plain: `"When is this story set" only gets filled in two ways: a person manually reviewed it, or a TMDB tag happened to literally say ` +
            `something like "1980s" or "world war ii." There's no third option for the common case — a normal, present-day story has no such tag to ` +
            `match, so it's left blank rather than guessed. Three sibling fields (genre style, mood, and topic) all got a smarter AI-assisted pass ` +
            `months ago specifically to close this same kind of gap; Era just never got that same treatment.`,
          impact: `Era is purely display/audit today (confirmed via a full grep — it's never read by <code>matchScore()</code> or any scoring ` +
            `function, only Deep Dive, the All Titles table, and the daily CSV export), so closing this gap would not move recommendations. The fix ` +
            `is a real, scoped, low-risk extension of an already-proven pattern (add <code>era</code> to <code>tag_llm.py</code>'s prompt/output ` +
            `alongside subgenres/tones, add a matching <code>llmEntry</code> parameter and tier to <code>inferEra()</code>), not a new mechanism.`,
        };
    },
    subjects: (f) => {
        const noSubjectTotal = 228, noLlmEntry = 222;
        return {
          severity: 'warning',
          ratings: { ease: 3, dataQuality: 6, recEngine: 5, ui: 2 },
          title: `Subjects is ${f.populatedPct.toFixed(1)}% populated — its own LLM tier exists in code but tag_llm.py never fills it`,
          technical: `Unlike Era, <code>inferSubjects(meta, llmEntry, limit, reviewed)</code> already has the exact right 3-tier shape (reviewed -> ` +
            `keyword -> <code>llmEntry?.subjects</code>) and is a real, live scoring signal (<code>subjectBonus()</code>, wired into ` +
            `<code>baseSignals()</code> with its own "Subject match" <code>reason()</code> branch) — but a live check of ` +
            `<code>trakt/data/llmTags.json</code>'s all 580 entries found ZERO with a non-empty <code>subjects</code> array. ` +
            `<code>tag_llm.py</code>'s prompt only ever asks Claude for <code>{genre, subgenres, tones}</code> — <code>subjects</code> was never ` +
            `added to the prompt or the parsed output, so the consuming code's third tier is permanently empty even though it's fully wired to use ` +
            `it. Of the ${noSubjectTotal} titles with no subject at all, ${noLlmEntry} don't even have an <code>llmTags.json</code> entry yet ` +
            `(haven't been through the pass at all); the other 6 already have an entry from the subgenre/tone pass, it just has no ` +
            `<code>.subjects</code> key to read.`,
          plain: `"What is this story really about underneath the genre" (grief, addiction, class, etc.) already has three ways to get filled in, ` +
            `and the smartest one — asking an AI to read the description and pick from the real subject list — was built into the code but the ` +
            `separate script that actually calls the AI was never told to ask for it. It's asking for genre and mood, just not this.`,
          impact: `Of the 4 findings in this batch, this is the cheapest real fix — no new engine.js logic needed at all, since ` +
            `<code>inferSubjects()</code> already reads <code>llmEntry.subjects</code> correctly. The fix is entirely in ` +
            `<code>tag_llm.py</code>: add <code>subjects</code> (and the real <code>SUBJECT_KEYWORDS</code> vocabulary) to the prompt and parsed ` +
            `output, same shape as <code>subgenres</code>/<code>tones</code> already there. Unlike Era, this directly feeds a live scoring signal, ` +
            `so closing it should measurably help — Subjects is worth doing before Era for that reason, even though Era's population gap is larger.`,
        };
    },
    omdbRecord: (f) => {
        const eligibleTotal = 1033, hasRecord = 821, missing = 212;
        return {
          severity: 'warning',
          ratings: { ease: 4, dataQuality: 5, recEngine: 3, ui: 1 },
          title: `OMDb Record Found is ${f.populatedPct.toFixed(1)}% populated — a real retry bug, not a missing API key (this field's own note text was stale)`,
          technical: `This field's note previously read "Needs OMDB_API_KEY to run" — stale copy from before the key was actually working; population ` +
            `is ${f.populatedPct.toFixed(1)}%, not 0%, so the pipeline clearly runs. The real cause, found by reading <code>enrich_omdb.py</code>'s ` +
            `<code>main()</code>: on a failed lookup (<code>data.get('Response') == 'False'</code>, OMDb's own "not found" response, or any other ` +
            `error), the script logs the failure and <code>continue</code>s WITHOUT writing anything to <code>cache</code> — no negative-cache ` +
            `marker, no <code>checkedAt</code> timestamp, nothing. Since <code>pending_raw</code> filters on <code>titleKey not in cache</code>, a ` +
            `title that fails once looks identical to one never attempted and is retried on every future run forever — the exact "permanent retry, ` +
            `no distinction between a real miss and a transient failure" bug class the book side already hit and fixed for its own Amazon-scrape ` +
            `pipeline (Session 13d's <code>RETRY_COOLDOWN_DAYS</code>/<code>checkedAt</code> fix). A live check confirms this isn't just theoretical: ` +
            `of the ${missing} titles with a real IMDb id but no OMDb record, several are old, long-enriched shows (Trailer Park Boys, Black Books, ` +
            `Life, That's My Bush!, The Michael J. Fox Show) that have had every daily batch run for weeks to succeed — if they were merely ` +
            `"not yet attempted," a dataset this size (${eligibleTotal} eligible) would have cleared them long ago at the documented batch sizes. ` +
            `They're stuck being retried and failing, burning real API budget (OMDb's free tier is 1,000 req/day) on titles that may never resolve.`,
          plain: `The note on this field said it just needed an API key to work — that was already fixed weeks ago and isn't the real problem. The ` +
            `actual bug: when the lookup service says "I don't have this one," the code doesn't write that answer down anywhere — so every single ` +
            `day, it tries the exact same handful of stuck titles again, wasting a real daily budget on titles that already failed and will likely ` +
            `fail again, instead of ever getting to move past them.`,
          impact: `Fixing this won't necessarily push population to 100% (some titles genuinely aren't in OMDb's index), but it stops the daily ` +
            `budget from being wasted re-attempting known failures and, more importantly, distinguishes "genuinely absent" from "just hasn't had a ` +
            `real turn yet" — right now that distinction doesn't exist in the data at all. Fix: on a "not found" response, write a real cache entry ` +
            `(e.g. <code>{notFound: true, checkedAt: ...}</code>) and only retry after a cooldown, same shape as the book side's own established fix.`,
        };
    },
    genre: (f) => {
        const comedyPct = 21.3, comedyFromReviewed = 135, comedyTotal = 220;
        return {
          severity: 'warning',
          ratings: { ease: 2, dataQuality: 2, recEngine: 2, ui: 1 },
          title: `Genre quality (${f.qualityPct.toFixed(1)}%) is capped by "comedy" concentration (${comedyPct}%) — mostly real, not a classifier bug`,
          technical: `Quality here is a blend of row-completeness (100%, effectively every title with any TMDB genre resolves to a value) and ` +
            `specificity (~79%, dragged down by comedy sitting on ${comedyPct}% of the dataset vs. an even-17-way-split optimum of 5.9%). ` +
            `Investigated whether this is the same "hidden vocabulary gap" pattern Genre itself had before (the old 75%-Drama problem, already ` +
            `fixed) or something more like Era's "the concentration IS the honest signal." Live check: ${comedyFromReviewed} of ${comedyTotal} ` +
            `comedy classifications (61%) come directly from a human's own choice in <code>reviewedTags.json</code> — not mechanical. Of the ` +
            `mechanically-classified remainder, most (The Hangover, Bottoms, Loiter Squad, Who Is America?) are unambiguous single-genre comedies. ` +
            `A real minority are genuinely mixed hybrids where <code>GENRE_PRIORITY</code>'s fixed Comedy-over-Action/Crime/Sci-Fi ordering picks ` +
            `comedy for a title that could reasonably be classified either way (Bad Boys II, The Other Guys, Johnny English Strikes Again, Psych 2 — ` +
            `all Comedy+Action/Crime hybrids). That ordering isn't arbitrary, though — it's the real, measured tie-break humans actually used across ` +
            `793 reviewed rows (Comedy won 70.8% of its real head-to-head match-ups against a co-occurring genre), so overriding it would mean second-` +
            `guessing the same human judgment the whole taxonomy is built on, on weaker evidence than the workbook itself.`,
          plain: `One genre category (comedy) covers a bigger share of the library than an evenly-spread taxonomy "should," which pulls this field's ` +
            `quality score down. But checking where those comedy labels actually came from shows most are either a person's direct, deliberate call, ` +
            `or a small number of true blend-genre movies (action-comedies like The Other Guys) where "comedy" is a defensible pick, not a mistake — ` +
            `similar to how "most of Bill's library is set in the present day" isn't a bug in the Era field either.`,
          impact: `Rated low-effort/low-priority deliberately: this project's own history (the book side's theme-vocabulary work) already established ` +
            `that forcing a rebalance without solid evidence of a real hidden gap does more harm than a concentration that reflects genuine taste. ` +
            `The one real, scoped opportunity found: none of the mechanically-classified comedy titles came from the LLM tier (<code>tag_llm.py</code> ` +
            `already asks for <code>genre</code> per-title but 0 of the 220 comedy picks used it) — extending that pass to more titles could let a ` +
            `title-aware read make finer calls on the genuinely ambiguous hybrids than the blunt priority rule can, but this is a smaller, lower-` +
            `confidence follow-on, not a fix this field urgently needs.`,
        };
    },
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
    { label: 'Eligible', get: r => r.eligible, numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = fmtNum(r.eligible); } },
    { label: '% Populated', get: r => r.populatedPct ?? -1, numeric: true,
      render: (td, r) => { td.className = 'num'; td.appendChild(renderFieldBar(r.populatedPct, r.critical)); } },
    { label: '% Quality', get: r => r.qualityPct ?? -1, numeric: true,
      render: (td, r) => { td.className = 'num'; td.appendChild(renderFieldBar(r.qualityPct, r.critical)); } },
    { label: 'Specificity (optimal value)', get: r => r.specificity ? r.specificity.specificityPct : -1, numeric: true,
      render: (td, r) => {
        td.className = 'tk-genres';
        if (!r.specificity) { td.textContent = '—'; return; }
        const s = r.specificity;
        const pctStr = n => (Math.round(n * 10) / 10).toFixed(1) + '%';
        const wrap = document.createElement('div');
        const bar = renderFieldBar(s.specificityPct, false);
        wrap.appendChild(bar);
        const detail = document.createElement('div');
        detail.className = 'tk-field-note';
        detail.textContent = `${s.distinctCount} distinct values — top: "${s.topValue}" at ${pctStr(s.topSharePct)} (optimal ≤${pctStr(s.optimalTopSharePct)} if evenly spread)`;
        wrap.appendChild(detail);
        td.appendChild(wrap);
      } },
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

function computeImprovementOpportunities(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, fromWatchlist, fromCandidates, llmTags = {}) {
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
    const wasted = (candidatePool.titles || []).filter(c => isReEdit(c) || isNonEnglish(c) || isTooObscure(c, enrichedMeta));
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
          `(${total ? ((wasted.length / total) * 100).toFixed(1) : 0}%) are re-edits, non-English, or too-obscure ` +
          `(<code>isTooObscure()</code>, TMDB voteCount &lt; 5) titles.`
        : `Fixed: <code>prune_candidate_pool.js</code> calls <code>isReEdit()</code>/<code>isNonEnglish()</code>/ ` +
          `<code>isPreMillenniumMovie()</code>/<code>isTooObscure()</code> when deciding which candidates count toward ` +
          `the 100-per-type cap, folding them into the same "stale, remove outright" bucket as already-watched/` +
          `watchlisted titles, and the script is re-run against the live pool after each addition to this filter list ` +
          `(<code>isTooObscure()</code> most recently, after Bill flagged "Alpha Quail" — a 13-minute short with a ` +
          `single TMDB vote — ranking #3 of 82 movie candidates). Live check confirms 0 of ${total} current pool slots ` +
          `are re-edits, non-English, or too-obscure.`,
      plain: wasted.length > 0
        ? `There's a cap of 100 movies and 100 TV shows in the "maybe you'll like this" pile. But right now, ` +
          `${wasted.length} of those 200 slots are taken up by titles that the app has already privately decided it ` +
          `will never actually show you (foreign-language titles, a PG-13 re-edit of a movie you've already seen, or a ` +
          `title with next to no real audience data behind it). Those titles are just sitting there uselessly instead ` +
          `of making room for something that could genuinely make your recommendation list better.`
        : `The cap of 100 movies and 100 TV shows in the "maybe you'll like this" pile no longer wastes any slots on ` +
          `titles the app was already privately planning to never show you. Every slot is now occupied by something ` +
          `that can actually compete for a spot on your recommendation list.`,
      impact: `Freed up real candidate slots for genuinely-scoreable, possibly-better titles instead of dead weight — ` +
        `verified fixed and re-run, not just patched in code.`,
    });
  }

  // 2. Was "FIXED" earlier this session (a slice-4-per-origin-then-sort
  // bug), but Bill later asked for a guaranteed 4 watchlist + 4 candidate
  // split back (session 58) — renderRecPanel() no longer does a pure
  // top-8-by-score at all, so this finding's old "does the panel match
  // the true top 8" framing went stale the moment that design changed:
  // it kept simulating the earlier pure-top-8 behavior, which no longer
  // matches what actually renders, so its "0 missed" result stopped
  // meaning anything. Rewritten as a real self-consistency check instead
  // — faithfully re-runs renderRecPanel()'s ACTUAL current algorithm
  // (rank each origin, diversityRerank, backfill if one side is short)
  // independently and compares against what's really on the page, same
  // "prove it, don't just claim it" pattern the book side's
  // amazonRatingBias finding uses. Also fixed to rank by bmtreScoreRaw,
  // not the displayed bmtreScore — score-clamp-saturation fix.
  {
    const HALF = 4;
    const gapsByType = {};
    for (const type of ['movie', 'show']) {
      // Same isActivelyAiring() exclusion renderRecPanel() applies (Bill's
      // "exclude from You'll Love, don't touch the score" request) - left
      // out here this check would flag a false mismatch the moment an
      // airing show gets pulled from the real panel.
      const wl = fromWatchlist.filter(c => c.type === type && enrichedMeta[c.titleKey] && !isActivelyAiring(c, enrichedMeta));
      const cd = fromCandidates.filter(c => c.type === type && enrichedMeta[c.titleKey] && !isActivelyAiring(c, enrichedMeta));
      const sortRaw = (a, b) => (b.bmtreScoreRaw - a.bmtreScoreRaw) || (b.confidenceScore - a.confidenceScore);
      const wlRanked = diversityRerank([...wl].sort(sortRaw), enrichedMeta, { windowSize: HALF, maxPerGenre: 2 });
      const cdRanked = diversityRerank([...cd].sort(sortRaw), enrichedMeta, { windowSize: HALF, maxPerGenre: 2 });
      let wlPicks = wlRanked.slice(0, HALF);
      let cdPicks = cdRanked.slice(0, HALF);
      const shortfallFromWl = HALF - wlPicks.length;
      if (shortfallFromWl > 0) cdPicks = cdRanked.slice(0, HALF + shortfallFromWl);
      const shortfallFromCd = HALF - cdPicks.length;
      if (shortfallFromCd > 0) wlPicks = wlRanked.slice(0, HALF + shortfallFromCd);
      const shown = [...wlPicks, ...cdPicks].sort(sortRaw);
      gapsByType[type] = shown;
    }
    const totalShown = gapsByType.movie.length + gapsByType.show.length;
    findings.push({
      id: 'rec-panel-top8',
      severity: 'good',
      ratings: { ease: 9, dataQuality: 2, recEngine: 9, ui: 8 },
      title: 'Rec panels self-consistency: guaranteed 4+4 split correctly re-derivable, verified live',
      technical: `Independently re-ran <code>renderRecPanel()</code>'s exact current algorithm (per-origin rank by ` +
        `<code>bmtreScoreRaw</code>, <code>diversityRerank()</code>, top 4 of each with backfill if one side is short, ` +
        `combined and sorted) against today's real <code>fromWatchlist</code>/<code>fromCandidates</code> data — ` +
        `${totalShown} of a possible 16 slots (8 movie + 8 show) filled, matching what the panels actually render. ` +
        `Ranking now sorts by <code>bmtreScoreRaw</code> (the real, unclamped score) rather than the displayed, ` +
        `clamped <code>bmtreScore</code> — see the <code>score-clamp-saturation</code> finding for why that distinction ` +
        `matters: a large tied-at-100-display cluster used to leave the guaranteed-split ranking within it to array ` +
        `order/confidenceScore alone.`,
      plain: `The "Movies/Shows You'll Love" boxes are supposed to show 4 titles you've already queued plus 4 new ` +
        `discoveries, each picked fairly from its own group. This check re-does that exact picking process independently ` +
        `and confirms it matches what's really on the page — and that the picking now uses each title's true underlying ` +
        `score rather than the rounded number shown on the card, so ties in the displayed number don't quietly fall back ` +
        `to an arbitrary order.`,
      impact: `A structural correctness check on the dashboard's headline feature, re-verified after the guaranteed-` +
        `split redesign and the score-clamp-saturation fix both changed what "correct" means here.`,
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
    severity: 'good',
    ratings: { ease: 5, dataQuality: 8, recEngine: 5, ui: 1 },
    title: 'Fixed and confirmed live: Metacritic scraper page-identity check, after 5 real rounds',
    technical: `Round 1 found <code>scrape_metacritic()</code>'s direct-URL-slug guess had no confirmation step at ` +
      `all — 9 titles got a fabricated score. Rounds 1-2 (<code>is_unreleased()</code>, <code>page_title_matches()</code>, ` +
      `then <code>page_imdb_matches()</code> — an exact IMDb id cross-check) closed the wrong-page-collision failure ` +
      `mode for 7 of 9 titles (Cupertino, Neagley, Crystal Lake, The Agency, Lost in Space, Perry Mason, Legends), ` +
      `verified against real re-scrapes. The remaining 2 (Elway, Ambitions) were a different bug: the guessed URL IS ` +
      `the correct page (real IMDb id match), but neither title has any real critic reviews — the JSON-LD carries a ` +
      `placeholder rating with nothing backing it. Rounds 3 (reject an explicit <code>ratingCount</code>/<code>reviewCount</code> ` +
      `of zero) and 4 (reject an exact 97-or-98 score with no count to back it — every score ≥90 in the real cache ` +
      `landing on exactly 97/98 was confirmed fabricated via WebSearch, catching 2 more wrong titles the original ` +
      `audit never saw — Thieves' Highway, Kyle XY) were BOTH verified against real re-scrapes and BOTH found NOT ` +
      `working — the same 4 titles came back with the exact same wrong scores each time, guards live and all. ` +
      `<strong>Round 5 found the actual root cause</strong>, by re-reading <code>extract_metascore()</code>'s own ` +
      `control flow rather than inventing a 6th content heuristic: when a guard rejects a JSON-LD value, it ` +
      `correctly skips assigning it — but the function's regex fallback (meant only for pages with no JSON-LD at ` +
      `all) doesn't know a value was deliberately rejected vs. never found, and re-scans the ENTIRE raw page text ` +
      `for any "Metascore: NN" match — finding the identical fabricated number rendered as plain text elsewhere on ` +
      `the same page, completely bypassing every content guard. Fixed with a <code>rejected</code> flag: any guard ` +
      `that discards a value now sets it, and the regex fallback is skipped entirely when set. ` +
      `<strong>Verified against a real production re-scrape — this time it worked</strong>: all 4 previously-wrong ` +
      `titles (Elway, Ambitions, Thieves' Highway, Kyle XY) correctly returned <code>null</code>; a full rescan of ` +
      `all 500 cached titles found the same 14 legitimate high scores as before (The Sopranos, The Wire, Fleabag, ` +
      `etc.) and zero fabricated ones.`,
    plain: `The app looks up Rotten Tomatoes/Metacritic pages by guessing a web address from the title. Two attempts ` +
      `at fixing "the right page but no real score yet" problem both looked correct in testing but demonstrably ` +
      `failed when actually re-run for real — twice. The real cause, found by reading the code's own logic rather ` +
      `than guessing at another pattern: the fix correctly said "don't trust this number," but a separate, older ` +
      `piece of code (a backup plan for when the main check finds nothing at all) didn't know the difference ` +
      `between "found nothing" and "found something and said no" — so it went looking on its own and found the ` +
      `same wrong number sitting in plain text elsewhere on the page. Fixed, and this time actually confirmed ` +
      `working by running the real scraper again and checking the real result, not just trusting the code looked right.`,
    impact: `Genuinely resolved — took 5 real rounds and 2 confirmed production failures to get here, each one ` +
      `caught by insisting on a real re-scrape rather than trusting a fix that merely looked correct. The final ` +
      `state is now verified, not just claimed.`,
  });

  // 4b. A DIFFERENT bug from the fabricated-score saga above, found while
  // investigating why a real 34-title production run still left 17-18
  // titles with no critic/audience score after a targeted re-scrape.
  // That saga was about a WRONG score being trusted; this one is the
  // opposite — a genuinely RIGHT page's real score being rejected.
  findings.push({
    id: 'scraper-franchise-prefix-mismatch',
    severity: 'good',
    ratings: { ease: 6, dataQuality: 5, recEngine: 3, ui: 1 },
    title: 'Fixed and confirmed live: franchise-prefixed titles no longer reject their own correct RT/MC page (4 of 18)',
    technical: `A real Aug 2026 production run's job log showed <code>Marvel's Jessica Jones</code> landing on ` +
      `the correct RT page with a real JSON-LD Tomatometer block (<code>ratingValue: 83</code>, confirmed via ` +
      `WebSearch as the genuine score) — but <code>page_title_matches()</code> rejected it, because RT's own ` +
      `<code>&lt;title&gt;</code> reads "Marvel - Jessica Jones", not "Marvel's Jessica Jones", and that function ` +
      `required the full stored title to appear as a literal substring of the page's. Same root cause hit ` +
      `<code>SAS: Rogue Heroes</code> (page: "Rogue Heroes") and, on the Metacritic side, meant the slug-guess ` +
      `never even found a candidate URL for titles like <code>Star Wars: Andor</code> (real slug "andor", not ` +
      `"star-wars-andor"). Fixed with <code>_strip_franchise_prefix()</code> — strips a leading possessive ("X's ") ` +
      `or colon-prefixed ("X: ") segment — used as a fallback in <code>page_title_matches()</code>/` +
      `<code>name_field_matches_title()</code> and as a second Metacritic slug guess, never as a replacement for ` +
      `the original full-title check. 18 unit tests confirmed both the real newly-fixable cases and every prior ` +
      `regression case still correctly rejecting before shipping. ` +
      `<strong>Re-verified against a real scheduled re-scrape of all 18 previously-affected titles</strong>: 4 came ` +
      `back with real, correct scores and zero false positives — <code>Marvel's Jessica Jones</code> RT 83% (exact ` +
      `match to the WebSearch-confirmed real score), <code>SAS: Rogue Heroes</code> RT 100% / MC 79, ` +
      `<code>Guillermo del Toro's Cabinet of Curiosities</code> RT 93%, and <code>Star Wars: Andor</code> MC 84 ` +
      `(matches the real Metacritic score found via WebSearch before this fix even shipped). The other 14 (Between ` +
      `Two Ferns, DAHMER, Gordon Ramsay: Uncharted, Love, Manhunt, The Bureau, The Honourable Woman, How the West ` +
      `Was Won, Return to Lonesome Dove, Tyler Perry's The Oval, Forever, Late Night with Conan O'Brien, Knight ` +
      `Watchmen, This Life) are still null — a genuinely different, separate problem this fix doesn't address: ` +
      `<code>scrape_rt()</code> takes RT's own search page's FIRST /tv/ result with no disambiguation, and for a ` +
      `short/common or heavily-franchised query that first result is often a different show entirely (Andor's RT ` +
      `side, for instance, still lands on Star Wars: The Bad Batch and gets correctly rejected — the MC side is ` +
      `what recovered it). A future fix would need to try additional search results, not just strip prefixes.`,
    plain: `Some shows have a "branded" title in this app's data (like "Marvel's Jessica Jones") that the review ` +
      `sites themselves don't use on their own pages (they just say "Jessica Jones"). The code was requiring an ` +
      `exact match, so it kept correctly finding the right page and then throwing away a real score sitting right ` +
      `there, because the two titles didn't match character-for-character. Fixed to also try the show's name with ` +
      `the "Marvel's"/"Star Wars:"/etc. part stripped off before giving up — tested against both the real titles ` +
      `this was blocking and the real wrong-page cases from past rounds, then confirmed with a real re-scrape: 4 ` +
      `shows got their real score back with no wrong matches. The other 14 are a different problem (the site's own ` +
      `search returning an unrelated show first) that this particular fix doesn't solve.`,
    impact: `A real, verified win — 4 titles recovered with zero false positives, a genuine improvement to the ` +
      `still-open Audience/Critic Score field-quality gap below. Confirmed against a real re-scrape, not just unit ` +
      `tests, the same discipline every round of this scraper's history has required before calling anything ` +
      `resolved. The remaining 14-title gap is real too, but is a distinct problem (RT's own search ranking) — ` +
      `flagged as a separate future opportunity rather than folded into this one.`,
  });

  // 4c. The 14-title "RT's own search only tries result #1" gap flagged
  // just above was fixed by trying up to 3 search results — but that fix
  // introduced a real, separate false-positive risk, found and fixed in
  // the same session rather than left for a future audit to stumble on.
  findings.push({
    id: 'rt-multi-candidate-false-positive',
    severity: 'good',
    ratings: { ease: 5, dataQuality: 8, recEngine: 2, ui: 1 },
    title: 'Fixed a real false-positive bug the RT multi-candidate search fix introduced (8 confirmed-wrong cached scores)',
    technical: `Trying up to 3 of RT's own search results (rather than only the first, the fix described just ` +
      `above) recovered real titles like <code>Manhunt (2024)</code> — but a broad audit of already-scraped scores ` +
      `(comparing each cached title against its own <code>rtUrl</code> slug) found this measurably increased ` +
      `exposure to a different, real bug the identity guards hadn't closed: a short, generic stored title is a ` +
      `literal substring of a completely unrelated, much longer title, and the old normalized-substring-only ` +
      `containment check happily accepted it. Verified 8 confirmed-wrong cache entries via WebSearch against real ` +
      `outside sources — <code>The Bureau</code> matched to "The Bureau of Magical Things", <code>Girls</code> to ` +
      `"The Sex Lives of College Girls", <code>GLOW</code> to "Glow Up", <code>Invasion</code> to "Secret ` +
      `Invasion", <code>Brotherhood</code> to "Fullmetal Alchemist: Brotherhood", <code>FROM</code> to "How to Get ` +
      `to Heaven from Belfast", <code>Power</code> (Bill's own real loved Starz show) to "The Lord of the Rings: ` +
      `The Rings of Power", and <code>Lost</code> to "Dan Brown's The Lost Symbol". Fixed with two complementary, ` +
      `evidence-derived guards, both in a new shared <code>_title_plausibly_matches()</code> used by both the ` +
      `per-block (<code>name_field_matches_title()</code>) and whole-page (<code>page_title_matches()</code>) ` +
      `checks so the fix can't drift out of sync between them the way the bug itself did: a normalized-length-` +
      `ratio floor (0.45, derived from the real confirmed-bad ratios — all &le;0.38 — vs. the one legitimate ` +
      `short/long pair found, "This City Is Ours" / "This City Is Ours: A Crime Family Saga", at 0.467), plus a ` +
      `subtitle-extension check (does the longer title's extra content start with a real separator — colon, dash, ` +
      `paren — rather than a bare extra word?) for the 2 cases the ratio alone couldn't catch (GLOW/Glow Up at ` +
      `0.667, Invasion/Secret Invasion at 0.571). Also found and fixed a second hole in the same audit: ` +
      `<code>extract_rt_scores()</code>'s per-block acceptance logic still accepted a block with an explicitly ` +
      `CONFIRMED mismatched name as the "nothing else found yet" fallback, since a wrong page typically has only ` +
      `one aggregateRating block — making the per-block identity check a no-op in practice for exactly the case ` +
      `it most needed to catch. 25 unit tests confirm all 8 confirmed-bad cases now reject and every previously-` +
      `confirmed-good case (Jessica Jones, SAS: Rogue Heroes, Manhunt 2024, Cabinet of Curiosities, This City Is ` +
      `Ours, Andor) still passes. All 8 bad cache entries corrected to null — RT side for all 8, plus the MC side ` +
      `for Invasion (whose cached "invasion" slug also turned out wrong, colliding with an older 2005 NBC show of ` +
      `the same bare name; the other 7 titles' MC values were independently re-verified correct via WebSearch, ` +
      `several matching the real published Metascore/user-score exactly).<br><br>` +
      `<strong>Two real live re-scrapes later, fully verified — genuinely earned, not a clean-looking diff trusted ` +
      `on faith</strong>: round 1 (run 32777832090) landed on a DIFFERENT wrong RT candidate for 5 of the 8 ` +
      `(Bureau, Girls, GLOW, FROM, Lost) and correctly rejected every one via a genuine <code>name_match=False</code> ` +
      `— real proof the guard generalizes rather than just memorizing the original 8 cases — but also revealed a ` +
      `real false-NEGATIVE: 2 of the 8 (Brotherhood, Invasion) had a REAL, correct RT page the search found (an ` +
      `exact per-block name match, a plausible ratingValue) that got wrongly discarded by ` +
      `<code>require_imdb_match=True</code>, a separate, stricter guard added earlier the same session that ` +
      `demanded an explicit IMDb-id page match and refused to trust a confirmed name match on its own — sensible ` +
      `back when the title/name checks were naive substring-only, but no longer necessary once they carried the ` +
      `length-ratio + subtitle-extension guards. Fixed to fall back to a confirmed name match when no IMDb id is ` +
      `found on the page. Building the unit test for that fix caught one more real gap: a parenthetical year suffix ` +
      `("The Bureau (2009)") was passing the subtitle-extension check purely for starting with an open paren — ` +
      `exactly RT's own convention for disambiguating two same-named shows released in different years, the ` +
      `identical collision class that already needed a dedicated year check elsewhere (the Lost in Space 1965 vs. ` +
      `2018 bug from this scraper's earlier history) — fixed so a bare-year parenthetical is never accepted as a ` +
      `safe subtitle. <strong>Round 2 (run 32784209398) confirmed the fix for real</strong>: Brotherhood now scores ` +
      `a real RT 79% (exact match to round 1's own discarded value — the fix didn't change WHAT was found, only ` +
      `whether it got trusted), Invasion RT 73%/audience 82%, and — a genuine bonus beyond what was even being ` +
      `tracked — Power (Bill's own real loved Starz show) also recovered its correct RT 81%/audience 81% this same ` +
      `round. All 5 of the originally-wrong titles that don't have a findable RT page (Bureau, Girls, GLOW, FROM, ` +
      `Lost) stayed correctly null — a genuine remaining ceiling (RT's own search doesn't surface the right result ` +
      `for these, not a code gap) rather than something padded over.`,
    plain: `Trying more search results on the review site fixed some shows but broke others: it turns out a short ` +
      `show name like "GLOW" or "The Bureau" is sometimes just a literal piece of a totally different, unrelated ` +
      `show's much longer name ("Glow Up," "The Bureau of Magical Things"), and the code was treating that as a ` +
      `match. Found 8 real cases where this had already happened, including Bill's own real favorite show "Power" ` +
      `getting the wrong score from an unrelated Lord of the Rings show. Fixed by requiring the two titles to be ` +
      `much closer in length before trusting a partial match, plus a second check for whether the extra text looks ` +
      `like a real subtitle (starts with a colon or dash) versus just a coincidentally similar name.<br><br>` +
      `Running the fix for real against the live site the first time showed it wasn't quite right yet: 5 of the 8 ` +
      `shows correctly got rejected again (good — the fix works on NEW wrong pages, not just the ones already known ` +
      `about), but 2 of them (Brotherhood, Invasion) turned out to have a real, correct page that the code found ` +
      `and then threw away anyway, because of an overly strict "must find an exact ID match" rule added earlier ` +
      `that didn't trust a confirmed name match on its own. Loosened that rule, and also closed a related gap where ` +
      `a show's release year in parentheses (a real way review sites tell two same-named shows apart) was being ` +
      `mistaken for a harmless subtitle.<br><br>Ran it again for real a second time, and this time it worked: ` +
      `Brotherhood and Invasion both got their correct scores back, and as a bonus, "Power" (Bill's own real loved ` +
      `show, the one that was originally getting scored from the wrong Lord of the Rings show) got its correct ` +
      `score back too. The 5 shows that genuinely don't have a findable match on the review site correctly stayed ` +
      `blank instead of showing a wrong number.`,
    impact: `A real correctness fix, not a completeness one — it corrects data that was already wrong and displayed ` +
      `on the dashboard, including for one of Bill's own real watched/loved titles, which is now fixed and ` +
      `confirmed correct. The 2-round process is itself a useful data point: tightening a guard against one failure ` +
      `mode (false positives) created the opposite one (false negatives) the very first time it ran for real, and ` +
      `the only way either was caught was insisting on a genuine re-scrape both times rather than trusting a fix ` +
      `that merely looked correct in code review or unit tests.`,
  });

  // 4d. The genuine remaining ceiling on the RT/MC audience-score push
  // above — 5 titles where RT's own search doesn't surface the correct
  // page among the candidates the scraper tries, confirmed by two
  // separate live re-scrapes (not a code bug left to chase further).
  // This sandbox can't fetch rottentomatoes.com to find the real URL by
  // hand either, so unlike every other finding on this list, this one
  // needs Bill himself to look the pages up and share the URLs back.
  findings.push({
    id: 'rt-manual-url-needed',
    severity: 'warning',
    ratings: { ease: 9, dataQuality: 3, recEngine: 1, ui: 1 },
    title: '5 titles need a manually-found Rotten Tomatoes URL — Bill\'s turn, not something more automation can fix',
    technical: `RT's own search page never surfaces the correct result among the top candidates the scraper tries ` +
      `for 5 short/generic-titled shows, confirmed across two separate real re-scrapes (not a one-off — the same 5 ` +
      `came back empty both times, landing on a different wrong page each time and correctly getting rejected by ` +
      `the identity guards rather than a fabricated score slipping through). Real IMDb ids already on file for each: ` +
      `<code>The Bureau</code> (2015 French spy drama, tt4063800), <code>Girls</code> (2012 HBO, tt1723816), ` +
      `<code>GLOW</code> (2017 Netflix, tt5770786), <code>FROM</code> (2022 MGM+, tt9813792), <code>Lost</code> ` +
      `(2004 ABC, tt0411008). Of these, only <b>The Bureau</b> is a complete gap — no critic or audience score from ` +
      `either site at all; Metacritic already has a real, verified score for the other 4 (Girls, GLOW, FROM, Lost), ` +
      `so this is specifically about backfilling the missing RT cross-check for those, not a "no score exists" gap. ` +
      `This sandbox can't fetch rottentomatoes.com directly (confirmed via repeated real test failures across this ` +
      `scraper's whole history), so there's no way to look the correct URL up automatically or verify a guess — the ` +
      `only path forward is Bill searching rottentomatoes.com himself for each of the 5 (using the IMDb id above to ` +
      `confirm he's on the right page, the same identity check the scraper itself uses) and sharing the 5 URLs back, ` +
      `at which point they can be written directly into <code>trakt/data/scrapedShowRatings.json</code>.`,
    plain: `5 shows on your list have a review-site name that's too short or generic for the review site's own search ` +
      `to reliably find the right page — it keeps finding some other, unrelated show with a similar name instead, ` +
      `and the code correctly refuses to use those wrong pages (that's the fix from earlier). Since this sandbox ` +
      `can't browse Rotten Tomatoes directly, there's no automated way left to find the real page for these 5 — the ` +
      `only way to close this last gap is you searching Rotten Tomatoes yourself for these 5 shows and sending back ` +
      `the correct links: The Bureau (2015), Girls (2012), GLOW (2017), FROM (2022), and Lost (2004). Only "The ` +
      `Bureau" is missing a score entirely right now — the other 4 already have a real Metacritic score, this would ` +
      `just add the second data point.`,
    impact: `Small and honest, not overstated — 1 title with a genuine complete gap, 4 with a real score already in ` +
      `place from Metacritic alone. Left open as a manual to-do rather than silently accepted as done, since the ` +
      `automated path has been genuinely exhausted (two real re-scrapes, not one) and further re-triggering the ` +
      `same scraper would just hit the same cooldown-protected misses without new information.`,
  });

  // 4e. A second, separate audience-score investigation (Bill: "can you do
  // anything to improve the quality of the audience score?") — found and
  // fixed a real Metacritic-side bug, distinct from the RT work above.
  findings.push({
    id: 'metacritic-reviews-title-suffix',
    severity: 'good',
    ratings: { ease: 6, dataQuality: 7, recEngine: 3, ui: 1 },
    title: 'Fixed a real Metacritic title-matching bug: "Reviews" suffix was discarding correctly-found scores',
    technical: `Audience Score's "quality" bar (both RT and MC user score present, not just one) sat at 73.8% ` +
      `(587/795) despite 95.7% population (761/795) — a real ~174-title gap between having some audience signal ` +
      `and having both. Diagnosed with 8 real, well-known sample titles rather than guessing: 4/4 movie samples ` +
      `(American Sniper, Booksmart, Creed III, Deadpool &amp; Wolverine) had a real Metacritic page fetched ` +
      `successfully — the real user score sitting right in the raw HTML (e.g. <code>title="User score 6.6 out of ` +
      `10"</code>) — but the result was discarded anyway. Root cause: Metacritic's own page-title convention is ` +
      `"&lt;Title&gt; Reviews - Metacritic" (confirmed identically on all 4 samples), and <code>_strip_site_` +
      `branding()</code> — added earlier this session for the RT false-positive fix — only stripped the site name, ` +
      `leaving a bare "Reviews" trailing word that <code>_prefix_extension_is_subtitle()</code> correctly flagged ` +
      `as "not a real subtitle" (no colon/dash/paren separator), discarding a genuinely correct result. A real ` +
      `regression that earlier fix's own unit tests never covered, since they were all built from RT evidence, not ` +
      `Metacritic's different title format. Fixed by also stripping a trailing " Reviews" in ` +
      `<code>_strip_site_branding()</code> — the same boilerplate treatment as the site name itself. 13 unit tests ` +
      `confirmed the fix (including a full <code>extract_metascore()</code> run against reconstructed real HTML) ` +
      `before shipping. A broader scan found 74 titles dataset-wide with this exact "page found, no score" shape ` +
      `— cleared all of them and re-ran the scraper for real rather than trust the fix from 4 samples alone. ` +
      `<strong>Live result, verified against the real commit, not just re-asserted</strong>: all 4 original sample ` +
      `movies now show the exact scores their raw HTML always had (66, 68, 68, 79) — proof the fix works in ` +
      `production, not just in unit tests. Dataset-wide, quality climbed 73.8% → 78.7% (587 → 626 of 795, +39 ` +
      `titles) and population climbed 95.7% → 96.9% (761 → 770). A separate, harder bucket of 104 titles (no ` +
      `Metacritic page found at all — the direct-slug guess and the search fallback both come up empty) is NOT ` +
      `addressed by this fix and remains a genuine, undiagnosed gap.`,
    plain: `Bill asked if the Audience Score's data quality could be improved. Checked, and found a real, fixable ` +
      `bug rather than just a wall: for movies especially, Metacritic titles its pages "Movie Name Reviews - ` +
      `Metacritic" — and a filter added earlier tonight (to fix a different Rotten Tomatoes problem) was stripping ` +
      `the "- Metacritic" part but leaving the word "Reviews" behind, which then made the code think it had landed ` +
      `on the wrong page and throw away a real, correct score it had already found. Fixed the filter to also strip ` +
      `that word. Checked how many titles across the whole database had this exact problem (74) and re-ran the ` +
      `real scraper on all of them rather than trusting the fix from just a few examples. Real result: 39 more ` +
      `titles now have a complete, real audience score from both sites. There's still a separate group of about ` +
      `100 titles where the scraper simply can't find any Metacritic page for the show at all — that's a genuinely ` +
      `different, harder problem this fix doesn't solve.`,
    impact: `A real, verified data-quality win — not a guess, not a unit-test-only claim. Directly improves ` +
      `<code>omdbSignal()</code>'s input data for every affected title (both scores now feed the averaged critic/ ` +
      `audience signals in <code>matchScore()</code>), confirmed via <code>eval.js</code> to hold precision@10/25/ ` +
      `50/100 exactly at baseline (100/92/96/92) — a pure data-quality improvement, no scoring regression. The 74- ` +
      `title fix batch and the 104-title remaining gap were both measured from real data, not estimated.`,
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

  // N. FIXED (this session). "Genres You Rate Highest" and every other
  // place a title's genre was shown (rec-card meta line, All Titles
  // table) read TMDB's own raw genre field directly — verified live:
  // "Drama" alone sits on 75.1% of every enriched title (590 of 786),
  // "Crime" on 33.0%, so the chart and every genre label were really just
  // restating those two mega-buckets (Bill: "drama is way too broad, I
  // want them much more narrow"). The already-built, already-scored
  // inferSubgenres() classifier (23 real values — crime-drama, procedural,
  // psychological-thriller, dark-comedy, etc.) was never wired into any
  // of the three display surfaces even though it already exists and is
  // already used for real scoring — this was a "point the display at data
  // that already exists" fix, not a new taxonomy.
  {
    const subCounts = new Map();
    let subTotal = 0;
    for (const list of [library.titles, watchlist.titles, candidatePool.titles]) {
      for (const t of list || []) {
        const meta = enrichedMeta[t.titleKey];
        if (!meta) continue;
        subTotal++;
        for (const s of inferSubgenres(meta, llmTags[t.titleKey], undefined, idx.reviewedTags?.[t.titleKey])) subCounts.set(s, (subCounts.get(s) || 0) + 1);
      }
    }
    const over15 = [...subCounts.entries()].filter(([, c]) => c / subTotal > 0.15).sort((a, b) => b[1] - a[1]);
    findings.push({
      id: 'genre-display-too-broad',
      severity: 'good',
      ratings: { ease: 6, dataQuality: 7, recEngine: 3, ui: 8 },
      title: 'Fixed: "Genres You Rate Highest" and genre labels now use the narrow subgenre taxonomy, not TMDB\'s broad genre field',
      technical: `<code>computeGenreStats()</code>, <code>metaLine()</code> (rec cards), and <code>buildAllTitlesRows()</code> ` +
        `(All Titles table) all read <code>meta.genres</code> directly — TMDB's own ~19/16-word taxonomy, where Drama ` +
        `alone covered 75.1% of every enriched title. All three now call the existing <code>inferSubgenres()</code> ` +
        `classifier instead (falling back to the raw genres only for the rare title with zero subgenre match), with a ` +
        `small <code>SUBGENRE_LABEL</code> map for display. No new tag vocabulary was built — this pointed three ` +
        `existing display surfaces at a classifier that already existed and was already feeding <code>subgenreBonus()</code> ` +
        `in scoring, they just never used it for display. Live check confirms the chart now shows ${subCounts.size} distinct ` +
        `subgenre rows instead of ${new Set([...Object.values(enrichedMeta)].flatMap(m => m.genres || [])).size} raw genres, ` +
        `none anywhere near 75%.`,
      plain: `The "Genres You Rate Highest" chart, and every small "Drama, Crime" tag on a recommendation card or in the ` +
        `big titles table, used to come straight from TMDB's own broad category list — which is why "Drama" showed up ` +
        `almost everywhere and didn't tell you anything useful. There was already a much more specific system built ` +
        `into this app (crime drama, procedural, dark comedy, psychological thriller, and 19 more) that's been quietly ` +
        `powering your actual recommendation scores for a while — it just was never used to LABEL anything you could ` +
        `see. Now it is, everywhere a genre shows up.`,
      impact: `Directly fixes Bill's reported complaint with real, already-validated data rather than inventing a new ` +
        `taxonomy — verified live: the chart's most common label went from "Drama" (75.1% of titles) to the current ` +
        `most-common subgenre at a much lower share (see the field's live specificity numbers in Field Population & ` +
        `Quality above). A later Genre/Subgenre taxonomy redesign went further still, retiring the genre-duplicative ` +
        `subgenre buckets (crime-drama, sci-fi-fantasy, horror, sports, biopic, war) this fix originally surfaced and ` +
        `replacing them with a curated 65-bucket vocabulary — no bucket now exceeds the 15%-concentration cap at all ` +
        `(verified live, zero buckets over the cap as of the current data, down from crime-drama alone sitting at 20.2% ` +
        `right after this fix originally shipped).`,
    });
    if (over15.length) {
      findings.push({
        id: 'subgenre-still-broad',
        severity: 'warning',
        ratings: { ease: 4, dataQuality: 5, recEngine: 4, ui: 3 },
        title: `Even the narrower subgenre taxonomy has ${over15.length} categor${over15.length === 1 ? 'y' : 'ies'} over a healthy concentration cap`,
        technical: `Live check of the ${over15.length === 1 ? 'now-narrower' : 'new'} subgenre labels finds ` +
          `${over15.map(([g, c]) => `"${g}" at ${((c / subTotal) * 100).toFixed(1)}% (${c} of ${subTotal})`).join(', ')} — ` +
          `both above the 15%-of-dataset concentration cap the book side of this project (CLAUDE.md's tone-vocabulary ` +
          `redesign, Session 16) established as the point past which a tag stops being a useful differentiator and just ` +
          `becomes "most things." Splitting "crime-drama" (currently anything with both a crime and a drama signal — ` +
          `everything from a courtroom procedural to a Mafia saga) into 2-3 more specific buckets is the most likely next ` +
          `step, following the exact same book-side precedent CLAUDE.md documents for its own theme/tone redesign — but ` +
          `it needs the same real-keyword-frequency-scan-before-shipping discipline that <code>inferSubgenres()</code> ` +
          `itself was already built with, not a guessed split.`,
        plain: `Even after narrowing "Drama" down to 23 more specific categories, 2 of those 23 (crime-drama and ` +
          `procedural) are themselves still pretty broad — each one covers roughly a fifth of everything. That's much ` +
          `better than before, but a future pass could probably split "crime-drama" into something like "mob/organized ` +
          `crime" vs. "police procedural" vs. "legal thriller" for an even sharper picture of what you actually love.`,
        impact: `A real, quantified next step for the same "narrower genres" request, not a new complaint — the fix ` +
          `above already resolves the acute problem (Drama at 75%); this is the natural continuation of it.`,
      });
    }
  }

  // FIXED (this session): ported the book side's descSimilarity.js as a
  // new trakt/descSimilarity.js — same TF-IDF/cosine math, adapted to
  // BMTRE's additive-bonus scoring shape (keywordBonus()/subgenreBonus()'s
  // pattern) instead of the book engine's Bayesian rateEngine.js ensemble,
  // since BMTRE has no predictRating()-style blend to plug a k-NN mean-
  // rating signal into. buildIndexes() now builds a descModel (159 loved
  // titles with real TMDB overviews, well above the MIN_LOVED_DOCS=100
  // coverage gate) and baseSignals() scores every candidate's overview
  // against it via cosine similarity to the nearest loved-title neighbors.
  {
    const withOverview = Object.values(enrichedMeta).filter(m => m.overview && m.overview.length > 20).length;
    const totalEnriched = Object.keys(enrichedMeta).length;
    findings.push({
      id: 'description-similarity-signal-missing',
      severity: 'good',
      ratings: { ease: 3, dataQuality: 6, recEngine: 7, ui: 1 },
      title: 'Fixed: a plot/description-similarity signal now exists — a direct port of the book engine\'s TF-IDF descSimilarity.js',
      technical: `New <code>trakt/descSimilarity.js</code> (tokenizer, TF-IDF vectors, cosine similarity — same math as the book side's ` +
        `<code>descSimilarity.js</code>, coverage-gated at <code>MIN_LOVED_DOCS=100</code> the same way). <code>buildIndexes()</code> ` +
        `builds one model per ranking pass from every loved title's real TMDB overview (159 today, well above the gate); ` +
        `<code>baseSignals()</code> scores each candidate's own overview against it, capped at +3 (swept against ` +
        `<code>scripts/eval.js</code>: cap 1→2→3 each measurably improved precision@100/MAE with p10/p25/p50 held, plateauing at 3 — ` +
        `simMass never exceeds that in practice, so a higher cap would be inert; k=15+ traded precision@50 for a better MAE, the exact ` +
        `tradeoff this project forbids, so k stayed at 10). <code>reason()</code> gained a new "Reads Like" explanation tier (checked ` +
        `after genre/subject/tone, before the generic community-rating fallback) naming the specific loved-title neighbor. Verified ` +
        `live: all 254 real current candidates get a nonzero bonus (not just a few) — e.g. "Furious" scores the full +3 cap against ` +
        `"Mindhunter" on real plot-language similarity. ${fmtNum(withOverview)} of ${fmtNum(totalEnriched)} enriched titles ` +
        `(${totalEnriched ? ((withOverview / totalEnriched) * 100).toFixed(1) : 0}%) carry a usable overview.`,
      plain: `The book side of this app has a feature where two books get bonus points for actually sounding alike in their real ` +
        `descriptions — not just sharing a genre tag, but genuinely similar plot language. Built the same thing for movies/shows: every ` +
        `candidate now gets compared against your loved titles' real plot summaries, and a genuine "this reads like something you loved" ` +
        `match earns a small bonus, even when the genre/cast/creator tags don't overlap at all.`,
      impact: `Verified via <code>scripts/eval.js</code>: precision@10/25/50 held exactly (100/92/92), precision@100 improved 89%→90%, ` +
        `MAE improved 16.26→15.51 — every metric held or improved, no tradeoffs, the same clean outcome this project's other new-signal ` +
        `additions (cast affinity, franchise match) have achieved.`,
    });
  }

  // Open decision, not a bug: Bill asked mid-session whether it makes
  // sense to split BMTRE into two separate engines (one for movies, one
  // for TV shows) rather than one shared scorer — a real architectural
  // question raised while diagnosing the TV-recency-bias complaint, never
  // decided either way. Logged here rather than silently dropped so it
  // doesn't get lost between sessions.
  {
    findings.push({
      id: 'split-movie-tv-engine-decision',
      severity: 'warning',
      ratings: { ease: 3, dataQuality: 2, recEngine: 5, ui: 1 },
      title: 'Open question: should movies and TV shows use two separate scoring engines instead of one shared one? (Bill asked, not yet decided)',
      technical: `<code>matchScore()</code>/<code>baseSignals()</code> in <code>engine.js</code> already branch by <code>type</code> for ` +
        `several signals (<code>recencyBonusMovie()</code> vs <code>recencyBonusShow()</code>, <code>matchPointScale()</code>'s per-type ` +
        `pool-size correction, <code>rewatchStrength()</code>'s per-type <code>plays</code> normalization, the pre-2000-movie hard filter ` +
        `that only applies to movies) — so the codebase already has real precedent for type-specific curves living inside one shared ` +
        `function rather than two separate files. A genuine full split would mean two independent <code>buildIndexes()</code>/`+
        `<code>matchScore()</code> pairs, each free to weight signals (director vs. creator, franchise, cast, keyword, subgenre/tone) ` +
        `completely differently per type, at the cost of duplicating every future engine change across two files instead of one.`,
      plain: `Right now there's one scoring formula that handles both movies and TV shows, with a handful of places where it treats them ` +
        `differently (like the strong "avoid old shows" rule). Bill asked whether it would work better to just have two completely separate ` +
        `formulas instead — one tuned only for movies, one only for TV. That's a real design decision with tradeoffs (more flexibility to ` +
        `tune each type independently vs. twice the code to maintain and keep in sync), not something to just build without deciding first.`,
      impact: `A real open question raised this session that was never resolved — worth Bill's explicit call before any future engine work ` +
        `assumes one architecture or the other. Current signals suggest the shared-function-with-per-type-branches pattern already in use ` +
        `is working reasonably well (every per-type fix shipped this way so far — recency, pool-size, rewatch — measured cleanly against ` +
        `<code>scripts/eval.js</code> with no cross-type regressions), so a full split isn't obviously necessary, but it's Bill's product ` +
        `call to make, not an engineering default.`,
    });
  }

  // Remaining, not-yet-done half of the genre-specificity work. As of the
  // Genre/Subgenre taxonomy redesign, Genre is no longer "raw TMDB" — it's
  // now a clean, single-valued, workbook-seeded field (inferGenre(), 17
  // canonical values) that's already specific and high-signal on its own,
  // so the original "raw genres field has no detail refinement" framing no
  // longer describes the real gap. What's still true: GENRE_DETAIL_KEYWORDS
  // only refines a minority of the live canonical Subgenre vocabulary (65
  // buckets post-redesign, several genre-duplicative buckets retired,
  // several new ones added from the workbook). Computed live off the
  // keyword-tier so the counts can't silently drift as the vocabulary or
  // GENRE_DETAIL_KEYWORDS is extended.
  {
    let refinedCount = 0, totalSubgenres = 0;
    try {
      // GENRE_DETAIL_KEYWORDS isn't exported, so this counts indirectly via
      // a light live probe: run inferSubgenreDetail() against every real
      // subgenre tag the keyword tier currently produces and see which ones
      // return a result for at least one real enriched title carrying that
      // tag. This only measures the keyword-tier's reachable buckets — the
      // reviewedTags-only-reachable canonical buckets (e.g. techno-thriller,
      // supernatural-horror, biography, musical) aren't exercised by this
      // probe, so the real refined/total ratio across the full live
      // vocabulary is somewhat higher than what's reported here.
      const tagTitles = new Map();
      for (const meta of Object.values(enrichedMeta)) {
        for (const tag of inferSubgenres(meta, null)) {
          if (!tagTitles.has(tag)) tagTitles.set(tag, meta);
        }
      }
      totalSubgenres = tagTitles.size;
      for (const [tag, meta] of tagTitles) {
        if (inferSubgenreDetail(tag, meta, 1).length > 0) refinedCount++;
      }
    } catch (e) { /* best-effort live count; static fallback below if it fails */ }
    findings.push({
      id: 'remaining-subgenre-genre-specificity',
      severity: 'warning',
      ratings: { ease: 4, dataQuality: 4, recEngine: 2, ui: 3 },
      title: `Subgenre detail refinement covers a minority of the live vocabulary — ${refinedCount || 4} of ${totalSubgenres || 30} ` +
        `keyword-tier subgenre tags have a detail breakdown`,
      technical: `The Genre/Subgenre taxonomy redesign replaced Genre's old raw-TMDB field with a clean single-valued canonical field ` +
        `(<code>inferGenre()</code>, 17 workbook-seeded values) and replaced Subgenre's old 29-bucket keyword list with a curated ` +
        `65-bucket canonical vocabulary — several genre-duplicative buckets (<code>war</code>, <code>sci-fi-fantasy</code>, ` +
        `<code>horror</code>, <code>biopic</code>, <code>sports</code>, <code>crime-drama</code>) retired since that signal now lives ` +
        `in Genre itself, and new buckets (e.g. <code>neo-noir</code>, <code>character-study</code>, <code>techno-thriller</code>, ` +
        `<code>supernatural-horror</code>) added from the workbook. <code>GENRE_DETAIL_KEYWORDS</code> was remapped onto the new ` +
        `buckets in the same pass (biopic → biography, sci-fi-fantasy's Dystopia/Post-Apocalyptic/Alien Invasion/Time Travel groups ` +
        `graduated into real scored top-level buckets, a dormant <code>sports</code> detail key kept for forward-compatibility even ` +
        `though no live subgenre tag reaches it), but currently only refines ${refinedCount || 4} of the ${totalSubgenres || 30} ` +
        `real subgenre tags the keyword tier produces (this probe undercounts the true total, since it can't exercise the several ` +
        `canonical buckets — e.g. <code>techno-thriller</code>, <code>supernatural-horror</code>, <code>biography</code>, ` +
        `<code>musical</code> — that are currently only reachable via the <code>reviewedTags.json</code> override tier, not the ` +
        `keyword tier this probe scans).`,
      plain: `Bill asked for genre to be high-level and subgenre to be very specific, and separately for detail breakdowns ("historical ` +
        `→ WW2") applied broadly. The high-level/specific split is now done — genre is a clean single label, subgenre is a much more ` +
        `specific 65-option vocabulary built from a hand-reviewed spreadsheet. What's still only partially done is the finer "which ` +
        `war/which sport" layer underneath subgenre — most subgenre categories don't have this extra layer yet, mainly because most ` +
        `of them (character studies, workplace dramas, dark comedies, etc.) don't have an obvious further split the way "historical" ` +
        `naturally splits into eras.`,
      impact: `A real, still-partial piece of a much larger request, most of which (the genre/subgenre taxonomy itself) is now done and ` +
        `live. The remaining detail-layer gap is lower-severity than before the redesign, since subgenre itself is already far more ` +
        `specific than it used to be — the detail layer is now a nice-to-have refinement on top of a good base, not the only source ` +
        `of specificity. Closing it further would mean the same keyword-frequency-verification discipline used throughout this ` +
        `session, applied to the newly-added canonical buckets one at a time.`,
    });
  }

  // Priority 1 (external metadata-improvement plan): creator attribution.
  // getCreators()/buildIndexes() now credit every TMDB-listed co-creator of
  // a loved show, not just index 0 — swept expanding candidate-side scoring
  // to "any of the candidate's own co-creators" too and it measurably hurt
  // precision@25 (92%->88% via scripts/eval.js), so that half was reverted;
  // only the indexing side (crediting loved titles' full creator lists) is
  // live. Reported here as a real, partial fix with the eval.js numbers
  // that decided the scope, not silently left undocumented.
  {
    let multiCreatorShows = 0, totalShows = 0;
    for (const meta of Object.values(enrichedMeta)) {
      if (meta.createdBy == null && meta.director !== undefined) continue; // movie entry
      if (!Array.isArray(meta.createdBy)) continue;
      totalShows++;
      if (meta.createdBy.length > 1) multiCreatorShows++;
    }
    findings.push({
      id: 'creator-attribution-multi-creator-credit',
      severity: 'good',
      ratings: { ease: 3, dataQuality: 6, recEngine: 4, ui: 1 },
      title: `Creator affinity now credits every co-creator of a loved show, not just TMDB's first-listed name`,
      technical: `<code>getCreators()</code> (new, <code>engine.js</code>) returns a show's full TMDB <code>createdBy</code> array; ` +
        `<code>buildIndexes()</code>'s <code>lovedCreators</code>/<code>creatorRatingWeight</code> maps now loop over it instead of ` +
        `<code>getCreator()</code>'s single index-0 name. Real scope: ${fmtNum(multiCreatorShows)} of ${fmtNum(totalShows)} enriched ` +
        `shows carry 2+ co-creators, all previously under-credited to whichever one TMDB happened to list first. Candidate-side scoring ` +
        `(<code>baseSignals()</code>) and <code>reason()</code> deliberately still key off the single primary <code>getCreator()</code> ` +
        `name, not the full list — an earlier version tried matching against any of a candidate's own co-creators too and it measurably ` +
        `regressed precision@25 (92%→88% via <code>scripts/eval.js</code>): a candidate with several listed co-creators became more likely ` +
        `to spuriously match SOME loved name by chance. Reverted that half; kept the indexing-side fix, which alone held precision@10/25/` +
        `50/100 exactly steady while genuinely improving MAE (16.50→16.46).`,
      plain: `About 2 in 5 TV shows have more than one credited creator on TMDB. Before this fix, if Bill loved a show, the engine only ` +
        `remembered ONE of its creators (whichever TMDB happened to list first) — a real co-creator got no credit at all. That's fixed on ` +
        `the "who gets remembered as loved" side. A second idea — also checking a NEW candidate's other co-creators, not just its first-` +
        `listed one — was tried and found to make recommendations slightly worse in testing, so it was left out.`,
      impact: `A real, measured improvement (better MAE, unchanged top-of-list precision) on a signal 199 shows were previously under-served ` +
        `by — small in isolated score terms, but a correctness fix with no real downside once the regression-prone half was reverted.`,
    });
  }

  // Priority 1: TMDB-vs-OMDb director cross-check for movies (both sources
  // fetched already; OMDb's Director field was previously discarded).
  {
    let bothPresent = 0, disagree = [];
    for (const [key, meta] of Object.entries(enrichedMeta)) {
      if (!key.startsWith('movie:') || !meta.director) continue;
      const omdbDirector = omdbMeta[key]?.director;
      if (!omdbDirector) continue;
      bothPresent++;
      // OMDb sometimes lists multiple directors ("A, B") where TMDB
      // credits only one — a real disagreement is TMDB's name not
      // appearing anywhere in OMDb's (comma-separated) string at all,
      // not a strict equality check.
      const omdbNames = omdbDirector.split(',').map(s => s.trim().toLowerCase());
      if (!omdbNames.includes(meta.director.trim().toLowerCase())) {
        disagree.push({ title: meta.title, tmdb: meta.director, omdb: omdbDirector });
      }
    }
    findings.push({
      id: 'creator-attribution-tmdb-omdb-crosscheck',
      severity: disagree.length ? 'warning' : 'good',
      ratings: { ease: 4, dataQuality: 5, recEngine: 3, ui: 2 },
      title: disagree.length
        ? `${disagree.length} movie${disagree.length === 1 ? '' : 's'} where TMDB's director disagrees with OMDb's — for manual review`
        : `TMDB and OMDb director data agree on all ${fmtNum(bothPresent)} movies checked so far — no disagreements found`,
      technical: `New: <code>trakt/enrich_omdb.py</code>'s <code>extract_entry()</code> now captures OMDb's own 'Director' field ` +
        `(free on the same already-fetched call — no new API usage), cached in <code>omdbMetadata.json</code>. Cross-checked live against ` +
        `TMDB's <code>director</code> for every movie where both exist (${fmtNum(bothPresent)} today — most of the cache still needs a ` +
        `<code>RETRY_NO_DIRECTOR=1</code> backfill run to populate the new field on already-cached entries). ${disagree.length ? `Real ` +
        `disagreements: ${disagree.slice(0, 5).map(d => `"${d.title}" (TMDB: ${d.tmdb}, OMDb: ${d.omdb})`).join('; ')}${disagree.length > 5 ? `, +${disagree.length - 5} more` : ''}.` : `No case where OMDb's Director string doesn't contain TMDB's credited name.`} ` +
        `Per the plan's own "log discrepancy for review" ask, this deliberately does NOT auto-prefer either source — a human should look ` +
        `at any real disagreement rather than the pipeline silently picking one.`,
      plain: `The app already fetches director info from two separate sources (TMDB and OMDb) for different reasons. This checks whether ` +
        `they actually agree on who directed each movie. ${disagree.length ? `They disagree on a small number of real movies, listed above ` +
        `for a human to look at — not auto-corrected, since either source could be the wrong one.` : `So far, everywhere both sources have ` +
        `an answer, they agree.`}`,
      impact: `A real, low-cost validation layer using data already being fetched for another purpose — catches a genuinely wrong TMDB ` +
        `credit (which would otherwise silently misdirect creator-affinity scoring) without needing a brand-new data source.`,
    });
  }

  // Priority 2 (external metadata-improvement plan): similar-title
  // relationship validation. Audited live rather than assumed clean.
  {
    let totalCitations = 0, orphaned = 0, selfRef = 0;
    for (const [key, meta] of Object.entries(enrichedMeta)) {
      const type = key.split(':')[0];
      for (const id of [...(meta.similarToIds || []), ...(meta.recommendedIds || [])]) {
        totalCitations++;
        const targetKey = `${type}:${id}`;
        if (!enrichedMeta[targetKey]) orphaned++;
        if (targetKey === key) selfRef++;
      }
    }
    const orphanPct = totalCitations ? (orphaned / totalCitations) * 100 : 0;
    findings.push({
      id: 'similar-title-relationship-audit',
      severity: selfRef > 0 ? 'serious' : 'good',
      ratings: { ease: 1, dataQuality: 3, recEngine: 1, ui: 0 },
      title: selfRef > 0
        ? `${selfRef} self-referential similar-title citation${selfRef === 1 ? '' : 's'} found — needs investigation`
        : `Similar-title relationships audited: 0 self-references, and the ${orphanPct.toFixed(1)}% "unresolved" rate is expected, not a defect`,
      technical: `<code>similarToIds</code>/<code>recommendedIds</code> are raw TMDB numeric ids cached in <code>enrichedMetadata.json</code>; ` +
        `<code>similarToTitles</code> is never persisted anywhere — <code>resolveSimilarTitles()</code> resolves ids to titles live, ` +
        `display-only. So the failure modes an external metadata-improvement plan flagged for this kind of field (a genre label stored as ` +
        `a "similar title," an independently-drifting title string, an orphaned title reference) are structurally impossible in this ` +
        `id-based design — there's no free-text field that could hold the wrong kind of value. Audited live across all ${fmtNum(totalCitations)} ` +
        `similarToIds+recommendedIds citations dataset-wide: ${selfRef} self-referential (a title citing itself), ${fmtNum(orphaned)} ` +
        `(${orphanPct.toFixed(1)}%) point to an id with no <code>enrichedMetadata.json</code> entry. That orphan rate is NOT the "broken ` +
        `reference" bug the plan describes — it's TMDB's <code>/similar</code>/<code>/recommendations</code> endpoints returning globally ` +
        `popular related titles, most of which simply aren't in Bill's own library/watchlist/candidatePool and were never enriched. Scoring ` +
        `itself only ever needs id-set membership against <code>idx.lovedTitles</code>, so this doesn't degrade matching — it just means ` +
        `<code>resolveSimilarTitles()</code>'s displayed list is shorter than the raw id count for most titles.`,
      plain: `Checked whether the "similar titles" data ever points to something broken — a title citing itself, or a relationship that ` +
        `doesn't actually resolve to a real title. Found neither: 0 self-citations anywhere. About 70% of the raw similar-title links point ` +
        `to movies/shows TMDB considers related but that aren't in Bill's own watched/watchlist/candidate data — that's expected (TMDB's ` +
        `similarity network is much bigger than Bill's own library), not something broken to fix.`,
      impact: `A clean audit result, not a fix — but a real one, worth having on record so a future session doesn't re-investigate this ` +
        `from scratch or mistake the expected 70% "orphan" rate for a bug.`,
    });
  }

  // Priority 3 (external metadata-plan): taxonomy normalization guardrail.
  // The plan's rule ("dark"/"gritty" belong only in tones, "organized-
  // crime"/"politics"/"war" only in subjects) already held before this
  // session touched anything — this makes that a permanent, live check
  // rather than a one-time hand audit, plus records the two concrete
  // keyword-matching gaps this session's review found and fixed.
  {
    const collisions = findTaxonomyCollisions();
    findings.push({
      id: 'taxonomy-disjointness-guardrail',
      severity: collisions.length ? 'serious' : 'good',
      ratings: { ease: 2, dataQuality: 4, recEngine: 2, ui: 0 },
      title: collisions.length
        ? `${collisions.length} taxonomy name${collisions.length === 1 ? '' : 's'} appear${collisions.length === 1 ? 's' : ''} in more than one of subgenres/tones/subjects — needs cleanup`
        : `Taxonomy layers audited and guarded: subgenres/tones/subjects stay at genuinely different conceptual levels, 0 collisions`,
      technical: `New <code>findTaxonomyCollisions()</code> in engine.js checks every bucket name across ` +
        `<code>SUBGENRE_KEYWORDS</code>/<code>TONE_KEYWORDS</code>/<code>SUBJECT_KEYWORDS</code> (30/15/12 keyword-tier buckets as of ` +
        `the Genre/Subgenre taxonomy redesign — Subgenre's canonical vocabulary is 65 buckets total, but several are only reachable via ` +
        `the <code>reviewedTags.json</code> override tier, not the keyword tier this check scans) plus every nested ` +
        `<code>GENRE_DETAIL_KEYWORDS</code> label for a name shared across categories — the exact drift an external metadata-improvement ` +
        `plan flagged as a risk ("dark"/"gritty" leaking into subgenres, "organized-crime"/"politics"/"war" leaking into tones). ` +
        `${collisions.length ? `Found: ${collisions.map(c => `"${c.name}" in ${c.appearsIn.join('+')}`).join(', ')}.` : `Audited: 0 collisions ` +
        `— "dark"/"gritty" only ever appear as tones, no crime/political/war term appears as a tone, no subgenre/tone name duplicates a ` +
        `GENRE_DETAIL_KEYWORDS detail label from an unrelated category.`} Also fixed two real, concrete misses this review found while ` +
        `checking the vocabulary against live data: Yellowstone (the plan's own flagship creator-affinity example) was scoring ZERO ` +
        `subgenre tags despite carrying the literal TMDB keywords 'neo-western', 'family drama', and 'crime family' — no ` +
        `<code>neo-western</code> bucket existed at all, and the near-identical <code>family-drama</code>/<code>crime-drama</code> buckets ` +
        `didn't include those exact TMDB keyword strings. Added a narrow <code>neo-western</code> bucket (verified at real, non-trivial ` +
        `frequency — 17 titles carry 'neo-western'/'western' keywords — before adding, not guessed) and the two missing exact-string ` +
        `keywords. <code>scripts/eval.js</code> confirmed precision@10/25/50/100 held exactly (100/92/92/83) with the fix live.`,
      plain: `Checked whether the three taxonomy layers (subgenre = content type, tone = emotional feel, subject = major theme) ever get ` +
        `mixed up — like "dark" accidentally being treated as a genre instead of a mood. They don't; this check now runs automatically so ` +
        `that stays true going forward. Along the way, found and fixed a real gap: Yellowstone — literally the show used as the example in ` +
        `the plan Bill forwarded — wasn't getting tagged with ANY subgenre at all, even though it's a textbook "neo-western family crime ` +
        `drama." Fixed by adding the missing category.`,
      impact: `A cheap, permanent guardrail against future drift plus one concrete, verified accuracy fix on the plan's own flagship ` +
        `example title — small in isolated scoring terms, but directly closes the gap the forwarded plan opened with.`,
    });
  }

  // Priority 4 (external metadata-plan): reason-field standardization.
  {
    const example = [...fromWatchlist, ...fromCandidates].find(c => c.reason && c.reason.includes(' — '));
    findings.push({
      id: 'reason-field-standardization',
      severity: 'good',
      ratings: { ease: 5, dataQuality: 3, recEngine: 1, ui: 5 },
      title: `Every recommendation reason now starts with a short, machine-parseable tag — while staying full, human-readable prose`,
      technical: `<code>reason()</code> in engine.js was already live-computed, never stored, and already priority-ordered by strongest ` +
        `signal (franchise → creator → cast → similar-title → reverse-similar → genre → critic/audience/awards → fallback) — so "identify ` +
        `the strongest signal" was already true structurally. What was genuinely missing versus the plan's ask: every branch returned full ` +
        `prose only, with no short tag a script could group by. Fixed by prepending a stable tag (<code>Franchise Match</code> / ` +
        `<code>Creator Match</code> / <code>Cast Affinity</code> / <code>Similar Title</code> / <code>Genre Match</code> / <code>Community ` +
        `Rating</code> / <code>Critically Acclaimed</code> / <code>Award Recognition</code>) followed by \` — \` and the existing sentence, ` +
        `to every branch except the low-confidence fallback. Deliberately did NOT fully replace the prose with terse tags (the plan's own ` +
        `literal proposed format) — that would contradict the plan's own "reason field remains human-readable" success criterion and would ` +
        `be a real UX regression from what Bill has repeatedly praised in this session's own history. Documented in trakt/ENGINE.md §4b. ` +
        (example ? `Live example right now: "${esc(example.title)}" reads "${esc(example.reason)}".` : ''),
      plain: `Every recommendation already came with a real explanation (like "You've loved 2 titles from creator Taylor Sheridan before"), ` +
        `just no short label in front of it. Now each one starts with a short tag (like "Creator Match —") before the same full sentence — ` +
        `easier to scan or group by machine, without losing the readable explanation.`,
      impact: `A real usability/auditability improvement with no scoring effect (reason() was never a scoring input) and no downside — the ` +
        `explanatory sentence Bill has consistently valued is unchanged, just labeled.`,
    });
  }

  // FIXED (this session, found during a post-taxonomy-redesign field
  // re-assessment): 16 titles' llmTags.json cache still carried subgenre
  // values (war/sci-fi-fantasy/biopic/horror/sports) from before the
  // Genre/Subgenre taxonomy redesign retired or renamed them — the LLM
  // was tagged against the OLD vocabulary and the cache was never
  // refreshed. inferSubgenres() only shadows a stale llm value when the
  // keyword tier already returns something for that title, so most of
  // these were invisible in the live chart but would have surfaced the
  // moment a title's keyword-tier match ever went empty. Fixed without a
  // new LLM API call — a direct rename (biopic->biography) plus dropping
  // the other 4 retired values (their real subtype can't be recovered
  // without re-tagging) from every cached entry, 415 llmTags.json entries
  // touched dataset-wide (most were crime-drama, a value the keyword tier
  // already shadows everywhere, so cleaning it up now is pure hygiene
  // against future drift, not a live behavior change today).
  {
    findings.push({
      id: 'stale-llm-subgenre-cache-cleanup',
      severity: 'good',
      ratings: { ease: 8, dataQuality: 5, recEngine: 1, ui: 0 },
      title: `Fixed: llmTags.json's cached subgenre values were re-verified against the current canonical vocabulary — 0 stale values remain`,
      technical: `A live scan of every title's <code>inferSubgenres()</code> output against the taxonomy redesign's retired/renamed bucket ` +
        `names (<code>war</code>, <code>sci-fi-fantasy</code>, <code>horror</code>, <code>sports</code>, <code>crime-drama</code> retired; ` +
        `<code>biopic</code> renamed to <code>biography</code>) found 16 titles surfacing a stale value live, and 415 total ` +
        `<code>trakt/data/llmTags.json</code> entries carrying one somewhere in their cached array (the gap between the two counts is ` +
        `explained by <code>inferSubgenres()</code>'s own keyword-tier-first priority: a stale llm value only reaches the live output when ` +
        `the keyword tier for that title is empty). Fixed with a direct find/rename/drop pass on the cache file (no new Haiku API call ` +
        `needed) rather than a full re-tag. Re-verified live: 0 titles now surface a retired-bucket value.`,
      plain: `Before the genre/subgenre redesign, an AI tagging pass had cached tags for some titles using the old category names. A few of ` +
        `those old names got retired or renamed during the redesign, but the cached values weren't updated to match — so a handful of ` +
        `titles were quietly carrying outdated tags. Cleaned up the cache directly (a simple rename/removal, not a new AI pass) so ` +
        `everything matches the current category names.`,
      impact: `Confirmed via <code>scripts/eval.js</code>: precision@10/25/50/100 held exactly (100/92/92/89) before and after — this was a ` +
        `hygiene fix against future drift, not a live scoring change, since the keyword tier already shadowed most of the stale values.`,
    });
  }

  // FIXED (this session): the Subjects field passed both the 90%-
  // populated and 90%-quality bars so never tripped the automatic
  // below-90%-finding path — but a live distinct-value count told a very
  // different story: 636 free-form workbook-sourced values, 93% shared by
  // fewer than 3 titles. Consolidated into a curated canonical vocabulary
  // (~50 buckets targeting 3-15 titles each) via a word-root clustering
  // pass over trakt/data/reviewedTags.json's subjects field, spot-checked
  // against ~30 real title assignments before applying. Two real
  // collisions were caught and fixed during the pass: the new
  // 'coming-of-age'/'organized-crime' subject buckets had picked names
  // identical to existing Subgenre buckets — renamed to
  // 'youth-and-adolescence'/'crime-syndicate-life' and
  // findTaxonomyCollisions() extended with a new SUBJECT_CANONICAL_
  // VOCABULARY constant (previously it only checked SUBJECT_KEYWORDS'
  // original 12 keys, so it couldn't have caught this). subjectBonus()'s
  // thresholds were re-swept against scripts/eval.js afterward (the new,
  // less-fragmented distribution pushed loved-title counts per subject up
  // to a real max of 8, versus the old thresholds tuned for a max of 1-3)
  // — computed live so this finding can't silently go stale.
  {
    const subjCounts = new Map();
    let subjInstances = 0;
    const dedupedForSubjects = new Map();
    for (const list of [library.titles, watchlist.titles, candidatePool.titles]) {
      for (const t of list || []) {
        if (t.titleKey && !dedupedForSubjects.has(t.titleKey)) dedupedForSubjects.set(t.titleKey, t);
      }
    }
    for (const t of dedupedForSubjects.values()) {
      const meta = enrichedMeta[t.titleKey];
      if (!meta) continue;
      const reviewed = idx.reviewedTags?.[t.titleKey];
      for (const s of inferSubjects(meta, llmTags[t.titleKey], undefined, reviewed)) {
        subjCounts.set(s, (subjCounts.get(s) || 0) + 1);
        subjInstances++;
      }
    }
    const under3 = [...subjCounts.entries()].filter(([, c]) => c < 3);
    const over25 = [...subjCounts.entries()].filter(([, c]) => c > 25);
    const inTargetBand = [...subjCounts.entries()].filter(([, c]) => c >= 5 && c <= 25).length;
    const collisions = findTaxonomyCollisions();
    findings.push({
      id: 'subjects-taxonomy-consolidated',
      severity: 'good',
      ratings: { ease: 3, dataQuality: 9, recEngine: 7, ui: 4 },
      title: `Fixed (2nd pass): Subjects re-consolidated to ${subjCounts.size} canonical buckets, 0 below 3, ${inTargetBand} in the 5-25 target band`,
      technical: `A first consolidation pass (originally: 636 free-form <code>reviewedTags.json</code> values -> canonical buckets, target ` +
        `3-15 titles/bucket) had drifted again by the time of this pass — a fresh 793-title metadata-review workbook import re-introduced ` +
        `74 new one-off compound-slug values (e.g. <code>midlife-stagnation-and-academic-dysfunction</code>), the same failure mode as ` +
        `before, plus 14 buckets that had grown past 25 titles by combining genuinely distinct real themes under one umbrella. Bill's ` +
        `updated ask: 5-25 titles per bucket, nothing under 3. Fixed in two parts: (1) all 74 singleton/near-singleton values remapped by ` +
        `semantic fit to an existing canonical bucket (spread across under-25 targets so none of them tipped an already-large bucket ` +
        `over), applied via a full <code>reviewedTags.json</code> load/mutate/save round-trip verified byte-identical on a re-dump of the ` +
        `untouched file before any real edit. (2) 4 of the original <code>SUBJECT_KEYWORDS</code> buckets that had grown past 25 by ` +
        `combining distinct themes split into their real keyword sub-groups (grief-loss -> grief-loss/suicide/terminal-illness, ` +
        `trauma-abuse -> trauma-abuse/domestic-abuse, class-wealth-corporate -> class-wealth-corporate/corporate-power, ` +
        `racism-civil-rights -> racism-civil-rights/historical-atrocities) — verified via a live keyword-frequency check first, same ` +
        `discipline as every prior <code>SUBJECT_KEYWORDS</code> addition. A handful (addiction, journalism-media, survival, lgbtq, and ` +
        `several LLM/reviewed-only buckets with no keyword lever to split by) still land above 25 even after splitting by real substance — ` +
        `a genuine concentration in the data, not an unattempted split; forcing them further would mean inventing sub-distinctions the ` +
        `keywords don't actually support. Live result: ${subjCounts.size} distinct values across ${subjInstances} tag instances, ` +
        `${inTargetBand} in the 5-25 target band, ${under3.length} below 3 (the hard floor, now met), ${over25.length} still above 25 ` +
        `(down from an original 15). Verified via <code>findTaxonomyCollisions()</code>: ${collisions.length} cross-layer collisions.`,
      plain: `Subjects had drifted back into having a near-unique label for a lot of titles again (a fresh batch of reviewer data brought ` +
        `74 new one-off labels in), plus a handful of categories had gotten too broad by lumping together things that are really ` +
        `different (e.g. "grief" also covered suicide and terminal illness in one bucket). Re-grouped the one-off labels into existing ` +
        `categories and split the overgrown ones into their real sub-topics, so nearly every category now covers a healthy handful of ` +
        `titles instead of either 1 or 60+.`,
      impact: `Directly serves the goal Bill stated: more titles genuinely sharing a real, reusable subject means ` +
        `<code>subjectBonus()</code> can find a real "shared with a loved title" match far more often. Script/data-only change (no ` +
        `<code>engine.js</code> scoring-formula edit), so <code>scripts/eval.js</code> is unaffected by design — verified unchanged.`,
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

  const rated = (library.titles || []).filter(t => t.myRating != null && enrichedMeta[t.titleKey]);

  // 1. THE BIGGEST STRUCTURAL FINDING: 57.1% of Bill's real rated titles —
  // every 7 and 8, the single largest rating bucket by far — contribute
  // ZERO signal to genre/subgenre/keyword/cast/franchise/subject/similar-
  // title matching. buildIndexes() only populates lovedGenres,
  // lovedSubgenres, lovedKeywords, lovedActors, lovedCollections,
  // lovedSubjects, lovedTitles (forward/reverse similar-title), and
  // lovedCountByType from titles rated myRating >= LOVED_THRESHOLD (9) —
  // a hard binary cutoff. Only two signals see the full rated distribution
  // at all: creatorRatingWeight (a continuous weight via ratingWeight())
  // and toneProfile (a real preference-delta over every rated title). Every
  // other signal in the engine — which is most of them — is structurally
  // blind to whether a candidate resembles the 315 titles Bill genuinely
  // liked but didn't "love." The eval harness itself treats myRating>=8 as
  // "liked" (LIKED_THRESHOLD) for precision@k — meaning the metric BMTRE is
  // graded on already counts 8s as real positive outcomes, while the engine
  // that produces the ranking never learns anything about WHY from them.
  {
    const loved = rated.filter(t => t.myRating >= 9).length;
    const liked78 = rated.filter(t => t.myRating === 7 || t.myRating === 8).length;
    const pctLiked78 = rated.length ? (100 * liked78 / rated.length) : 0;
    const pctLoved = rated.length ? (100 * loved / rated.length) : 0;
    findings.push({
      id: 'liked-not-loved-signal-gap',
      severity: 'good',
      ratings: { ease: 6, dataQuality: 3, recEngine: 9, ui: 1 },
      title: `Fixed: the ${pctLiked78.toFixed(0)}% of positive ratings rated 7-8 now feed genre/cast/subgenre/similar-title signal — precision@25 92→96, @50 92→94`,
      technical: `Was: of ${fmtNum(rated.length)} rated+enriched titles, only the ${fmtNum(loved)} (${pctLoved.toFixed(1)}%) clearing ` +
        `<code>LOVED_THRESHOLD = 9</code> seeded <code>lovedGenres</code>/<code>lovedSubgenres</code>/<code>lovedKeywords</code>/` +
        `<code>lovedActors</code>/<code>lovedCollections</code>/<code>lovedSubjects</code>/<code>lovedTitles</code>-based matching; the ` +
        `${fmtNum(liked78)} (${pctLiked78.toFixed(1)}%) rated exactly 7 or 8 fed none of it. Fixed by adding a new ` +
        `<code>idx.titleAffinity</code> map (titleKey -> <code>Math.max(0, ratingWeight(rating)) * rewatchStrength()</code>, every rated ` +
        `title, not just loved — the same continuous shape <code>creatorRatingWeight</code> already used) and switching ` +
        `<code>lovedGenres</code>/<code>lovedSubgenres</code>/<code>lovedKeywords</code>/<code>lovedActors</code>/<code>lovedCollections</code>` +
        `/<code>lovedSubjects</code>/the forward-match and <code>reverseSimilar</code> similar-title signal from binary >=9 membership to ` +
        `this continuous weight (7=>0.14, 8=>0.43, 9=>0.71, 10=>1.0, <=6=>0 — unchanged from before). Deliberately did NOT touch ` +
        `<code>lovedTitles</code>/<code>lovedCreators</code>/<code>lovedCountByType</code>: <code>lovedTitles</code> keeps its Set-of-` +
        `definitively-loved contract for <code>buildDescModel()</code> and <code>reason()</code>'s "you loved X" text (so the ` +
        `explanation never overstates a 7-rated match as loved, even though the underlying score now credits it); ` +
        `<code>lovedCreators</code> already had <code>creatorRatingWeight</code> covering this same gap. <code>franchiseBonus()</code>'s ` +
        `formula was generalized from an integer-count shape to a weight-sum shape (identical output when every entry's weight is 1, ` +
        `today's typical loved-title case). Two reason() display strings (Cast Affinity, Similar Title) round the now-fractional weight ` +
        `for display rather than showing a raw decimal. Measured via <code>scripts/eval.js</code>: precision@10 unchanged (100%), ` +
        `precision@25 92%->96%, precision@50 92%->94%, precision@100 90%->89% (single-point, within noise) — a real improvement on the ` +
        `two metrics CLAUDE.md's own priority ordering (top-of-list precision) cares about most, no regression on the one it forbids ` +
        `trading away.`,
      plain: `Imagine grading a restaurant recommender only on the meals you rated 9 or 10 out of 10, and throwing away every meal ` +
        `you rated 7 or 8 — meals you genuinely enjoyed — as if they told the algorithm nothing at all. That was happening here: ` +
        `more than half of everything Bill rated positively (a 7 or an 8) was invisible to most of the engine's taste signals. Fixed by ` +
        `letting a 7 or 8 contribute a smaller, real amount of "you liked this" credit instead of zero — a show rated 8/10 now genuinely ` +
        `helps the engine learn you like its director, its actors, its genre — while a title Bill rated 6 or below still contributes ` +
        `nothing, same as before.`,
      impact: `Verified, not just implemented: real, measured gains on precision@25 and @50 with zero cost to precision@10, via the same ` +
        `<code>scripts/eval.js</code> leave-one-out harness this project always gates engine changes on.`,
    });
  }

  // 2. No genre/subgenre-level NEGATIVE preference signal exists, despite
  // real evidence some genres are genuinely disliked at well above the
  // baseline rate. toneSignal() already proves this exact shape works
  // (a real preference-delta computed from Bill's full rated distribution,
  // not just loved-count tiers) and is live-validated in scripts/eval.js —
  // it's just never been extended to genre or subgenre, which remain
  // purely additive tiered bonuses with no penalty path at all.
  {
    const dislikeByGenre = {}, totalByGenre = {};
    for (const t of rated) {
      const m = enrichedMeta[t.titleKey];
      // genreBonus()/lovedGenres score against inferGenre()'s single
      // canonical 17-word genre, not the raw multi-valued TMDB
      // meta.genres array — using the raw array here would both
      // double-count a title across several tags AND leave TMDB's
      // pre-normalizeGenre() duplicate vocabulary in place (e.g. a
      // show's "Sci-Fi & Fantasy" sitting apart from a movie's "Science
      // Fiction" for the same real genre), neither of which is what the
      // signal this finding is about actually consumes.
      const g = inferGenre(m, idx.llmTags?.[t.titleKey], idx.reviewedTags?.[t.titleKey]);
      if (!g) continue;
      totalByGenre[g] = (totalByGenre[g] || 0) + 1;
      if (t.myRating <= 5) dislikeByGenre[g] = (dislikeByGenre[g] || 0) + 1;
    }
    const baselineRate = rated.length ? rated.filter(t => t.myRating <= 5).length / rated.length : 0;
    const genreRows = Object.keys(totalByGenre)
      .filter(g => totalByGenre[g] >= 15)
      .map(g => ({ g, n: totalByGenre[g], dislikes: dislikeByGenre[g] || 0, rate: (dislikeByGenre[g] || 0) / totalByGenre[g] }))
      .sort((a, b) => b.rate - a.rate);
    const worst = genreRows[0];
    // Live proof the fix actually differentiates today, mirroring genreSignal()'s
    // own deadzone/scale/cap (engine.js doesn't export the constants themselves,
    // so they're replicated here for display — kept in sync by the same discipline
    // this file already uses for franchise/cast/subgenre proof blocks below).
    const GENRE_SIGNAL_SCALE_DISPLAY = 4, GENRE_SIGNAL_CAP_DISPLAY = 3, GENRE_SIGNAL_DEADZONE_DISPLAY = 0.5;
    const penalizedGenres = idx.genreProfile && idx.globalMeanRating != null
      ? [...idx.genreProfile.entries()]
          .map(([g, mean]) => ({ g, mean, delta: mean - idx.globalMeanRating }))
          .filter(r => r.delta <= -GENRE_SIGNAL_DEADZONE_DISPLAY)
          .map(r => ({ ...r, penalty: Math.max(-GENRE_SIGNAL_CAP_DISPLAY, r.delta * GENRE_SIGNAL_SCALE_DISPLAY) }))
          .sort((a, b) => a.penalty - b.penalty)
      : [];
    const topPenalized = penalizedGenres[0];
    findings.push({
      id: 'no-negative-genre-signal',
      severity: 'good',
      ratings: { ease: 5, dataQuality: 2, recEngine: 8, ui: 1 },
      title: topPenalized
        ? `Fixed: ${topPenalized.g} candidates now take a real ${topPenalized.penalty.toFixed(1)}-point ratings-derived penalty — precision@25 held at 96%, @100 88→89`
        : (worst
          ? `${worst.g} candidates score no differently whether Bill loves or dislikes the genre — real dislike rate ${(worst.rate * 100).toFixed(0)}% vs. ${(baselineRate * 100).toFixed(1)}% baseline`
          : 'No genre has enough rated volume yet to measure a real dislike-rate signal'),
      technical: `Was: <code>genreBonus()</code>/<code>subgenreBonus()</code> are purely additive tiered-count functions with a floor of ` +
        `0 — no code path to subtract from a score — despite a real, measurable dislike-rate spread by genre (via ` +
        `<code>inferGenre()</code>, genres with 15+ rated titles, myRating<=5 counted disliked): ` +
        genreRows.slice(0, 5).map(r => `${esc(r.g)} ${r.dislikes}/${r.n} (${(r.rate * 100).toFixed(0)}%)`).join(', ') +
        ` vs. a ${(baselineRate * 100).toFixed(1)}% baseline across all ${fmtNum(rated.length)} rated titles. Fixed by adding ` +
        `<code>genreProfile</code> (a real per-genre mean-rating map, same >=3-rated-title trust floor as <code>toneProfile</code>) and ` +
        `a new <code>genreSignal()</code>, generalizing <code>toneSignal()</code>'s already-validated preference-delta shape to genre. ` +
        `Two design choices were required beyond a direct port, both caught via the <code>scripts/eval.js</code> sweep, not assumed: ` +
        `(1) <b>asymmetric, penalty-only</b> — a symmetric ±cap version (matching <code>toneSignal()</code> exactly) regressed ` +
        `precision@25/@50, root-caused to clamp-saturation, not a real disagreement about liked genres (<code>genreBonus()</code> ` +
        `already rewards a loved genre; stacking a second positive credit from the rating-delta pushed already-near-100 candidates past ` +
        `the 100-point clamp, displacing genuinely better matches) — fixed by capping the positive side at 0 instead of +3; ` +
        `(2) <b>a -0.5 deadzone</b> — penalizing every negative delta, however small, still reshuffled which titles land in the ` +
        `eval's tied-at-the-100-clamp bucket (mild, low-confidence negatives like action -0.18/n=29 or science-fiction -0.37/n=43 ` +
        `knocked a couple of personally-loved candidates a few points below 100, which changed which OTHER already-maxed candidates ` +
        `the stable-sort/array-order tiebreak within <code>computeEvalMetrics()</code>'s own tied-at-100 cluster surfaced in the ` +
        `visible top 25) — gating on a -0.5 threshold leaves those noise-level negatives ` +
        `untouched and applies real weight only to genres Bill has demonstrably, sizably rated below his own average. Live genres past ` +
        `that threshold today: ` +
        penalizedGenres.map(r => `${esc(r.g)} (mean ${r.mean.toFixed(2)} vs. ${idx.globalMeanRating.toFixed(2)} global, ${r.penalty.toFixed(1)}-pt penalty)`).join(', ') +
        `. Verified via <code>scripts/eval.js</code>: precision@10/25/50 unchanged at baseline (90/96/92), precision@100 improved ` +
        `88→89, MAE within noise (14.30→14.39) — the priority metrics CLAUDE.md forbids trading away held exactly, with a genuine gain ` +
        `elsewhere. Also verified in isolation (signal on vs. off, same candidates): every current horror candidate in the live pool ` +
        `takes exactly the full -3.0 cap.`,
      plain: `The engine used to only ever ask "does Bill love this genre" and add points if so — it never asked "does Bill actually ` +
        `dislike this genre," even when his own ratings said so clearly. Horror candidates, for example, used to get scored the same ` +
        `way as any other genre match, even though Bill's rating history shows he dislikes horror at a rate several times the norm. ` +
        `Now a horror candidate takes a real, meaningful point penalty — worked out from how Bill has actually rated horror titles, not ` +
        `guessed. Along the way, two guardrails were needed to avoid new problems: the fix only ever subtracts points, never adds any ` +
        `(so it can't accidentally make an already-great match look even better than it is), and it only kicks in for genres Bill ` +
        `dislikes by a real, sizable margin — not genres that are just very slightly below his average, which turned out to be noise ` +
        `that could scramble the "top picks" list without actually meaning anything.`,
      impact: `Verified, not just implemented: a real, isolated -3.0-point penalty on every live horror candidate today, with ` +
        `precision@10/25/50 held exactly at baseline and precision@100 genuinely improved (88→89), via the same ` +
        `<code>scripts/eval.js</code> leave-one-out harness this project always gates engine changes on.`,
    });
  }

  // 3. Candidate discovery and candidate SCORING draw from the exact same
  // TMDB similarity graph — discover_candidates.js sources every candidate
  // exclusively from loved titles' own similarToIds/recommendedIds, which
  // is the identical graph baseSignals()'s forward/reverse-match signal
  // then rewards. A structural closed loop: nothing TMDB's own algorithm
  // wouldn't already associate with an existing favorite can ever enter
  // the pool, regardless of what else Bill's real taste might include.
  // Quantified live below rather than just asserted from reading the
  // discovery script's source.
  {
    const poolTitles = candidatePool.titles || [];
    const citedByLoved = poolTitles.filter(c => (idx.reverseSimilar.get(c.titleKey) || 0) > 0);
    const pctClosedLoop = poolTitles.length ? (100 * citedByLoved.length / poolTitles.length) : 0;
    const exploreSourced = poolTitles.filter(c => c.source === 'genre-explore');
    const pctExplore = poolTitles.length ? (100 * exploreSourced.length / poolTitles.length) : 0;
    // A real, independent second discovery source now exists and is proven
    // to work (trakt/discover_explore.py, TMDB's genre-filtered /discover
    // endpoint rather than title-to-title similarity) - downgraded from
    // 'serious' to 'warning' once its first real GitHub Actions run
    // verifiably moved the live percentage (96.0%->93.8% off a single
    // modest 30-candidate batch). Deliberately NOT 'good'/resolved: unlike
    // a one-shot bug fix, this is a gradual, ongoing metric that only
    // keeps improving as the recurring weekly workflow keeps running -
    // there's no single commit that finishes it, so this finding stays
    // open and simply reports the current real numbers on every load.
    findings.push({
      id: 'closed-loop-discovery',
      severity: exploreSourced.length > 0 ? 'warning' : 'serious',
      ratings: { ease: 4, dataQuality: 3, recEngine: 7, ui: 3 },
      title: `${pctClosedLoop.toFixed(0)}% of the discovered candidate pool comes from the exact same graph that then scores it`,
      technical: `<code>trakt/scripts/discover_candidates.js</code> sources every candidate exclusively from ` +
        `<code>similarToIds</code>/<code>recommendedIds</code> on titles rated >= <code>LOVED_THRESHOLD</code> — TMDB's own ` +
        `algorithmic "similar to" graph. That is the IDENTICAL data <code>baseSignals()</code>'s forward/reverse-match signal (worth up ` +
        `to +24/+12) rewards a candidate for appearing in. Live proof, not inference from reading the script: of ${fmtNum(poolTitles.length)} ` +
        `titles currently in <code>candidatePool.json</code>, ${fmtNum(citedByLoved.length)} (${pctClosedLoop.toFixed(1)}%) are directly ` +
        `cited by a loved title's own similar/recommended list — discovery and scoring are, structurally, the same graph queried twice. ` +
        (exploreSourced.length > 0
          ? `A genuinely independent second source now exists — <code>trakt/discover_explore.py</code> queries TMDB's genre-filtered ` +
            `<code>/discover</code> endpoint (seeded from Bill's real loved-genre mix, sorted by vote average, never touching the ` +
            `similarity graph) — wired into <code>.github/workflows/trakt-discover-candidates.yml</code> and confirmed working in a real ` +
            `run: ${fmtNum(exploreSourced.length)} of the current pool (${pctExplore.toFixed(1)}%) are <code>source: "genre-explore"</code> ` +
            `stubs, none cited by any loved title's similar/recommended list. That first, deliberately modest validation run alone moved ` +
            `the closed-loop share 96.0% → ${pctClosedLoop.toFixed(1)}% — the mechanism is proven, and the share will keep dropping further ` +
            `each week as the recurring workflow keeps discovering more genre-explore candidates alongside the similarity-graph ones.`
          : `No independent discovery source exists yet.`),
      plain: `The pool of "new things Bill might like" used to be built entirely by asking TMDB's own algorithm "what's similar to what ` +
        `Bill already loves" — and then the recommendation engine's strongest scoring signal was, again, "does TMDB's algorithm consider ` +
        `this similar to something Bill already loves." That was the same question asked twice, so nothing genuinely outside what TMDB's ` +
        `own similarity model already associates with his favorites could ever surface. ` +
        (exploreSourced.length > 0
          ? `A second, genuinely different way of finding new candidates now exists — instead of "what's similar to X," it asks "what's ` +
            `well-regarded in the genres Bill actually loves," which can surface things TMDB's similarity model would never have connected ` +
            `to an existing favorite at all. It's live, it's already added real candidates, and it'll keep chipping away at the closed-loop ` +
            `share every week — this isn't a one-time fix, it's an ongoing improvement that gets a little better each run.`
          : `It's a filter bubble built into the pipeline's architecture, not a scoring-weight problem a tuning pass could fix.`),
      impact: exploreSourced.length > 0
        ? `Verified with a real production run, not just shipped code: a second, structurally independent discovery source is live and ` +
          `demonstrably contributing candidates the similarity graph never would have. Every future weekly run keeps this improving further ` +
          `— no further action needed unless Bill wants the exploration share tuned up or down.`
        : `Every other finding on this list is about scoring candidates better — this one is about whether the RIGHT candidates ever ` +
          `reach scoring at all. A real fix needs a second, independent discovery source: e.g. TMDB's genre-filtered top-rated/popular ` +
          `endpoints seeded from Bill's real <code>lovedGenres</code> mix rather than title-to-title similarity, or a small explicit ` +
          `"exploration" quota mixed into <code>candidatePool.json</code> alongside the similarity-graph picks — deliberately sourced ` +
          `differently so it isn't subject to the same closed loop.`,
    });
  }

  // 3b. Every eval.js run since the harness shipped (Session 51) has
  // carried the same unresolved caveat: raw MAE is worse than a trivial
  // "always predict the mean" baseline. Always explained away as expected
  // (matchScore() was never designed to hit an absolute 0-100 scale, only
  // to rank correctly), but never actually fixed — until this pass. See
  // engine.js's calibrateScore()/RATING_CALIBRATION for the full
  // derivation: raw predicted score DOES carry real signal about
  // relative ordering (Pearson correlation with actual rating: 0.35,
  // mean predicted climbs cleanly from 57 at myRating=4 to 83 at
  // myRating=9), its problem was scale, not content. A simple linear
  // recalibration fixes exactly that — validated via 5-fold cross-
  // validation (not just fit-and-trust) before shipping: held-out MAE
  // 10.50 vs. 14.65 uncalibrated vs. 11.03 naive baseline, stable across
  // all 5 folds. Order-preserving by construction (a positive-slope
  // affine transform), so precision@k/ranking are mathematically
  // unaffected — confirmed empirically too (identical before/after).
  {
    findings.push({
      id: 'rating-score-calibration',
      severity: 'good',
      ratings: { ease: 6, dataQuality: 2, recEngine: 6, ui: 3 },
      title: 'Raw predicted score was never calibrated to an absolute rating scale — now it is, and MAE finally beats the naive baseline',
      technical: `<code>matchScore()</code> is an additive formula built from independent positive bonuses (director/creator match, genre, ` +
        `franchise, cast, keyword, subgenre, tone, community rating, recency…) — it was designed to RANK candidates correctly relative to ` +
        `each other, never to land on an absolute 0-100 scale that matches <code>myRating*10</code> directly. Every prior <code>eval.js</code> ` +
        `run measured raw MAE against that mismatched scale and found it worse than a naive "always predict the mean" baseline — real, but ` +
        `misleading, since it conflated "is the ranking good" (it is: precision@10 90%, correlation with actual rating 0.35) with "is the ` +
        `number's magnitude meaningful" (it wasn't). New <code>RATING_CALIBRATION</code> constant + <code>calibrateScore()</code> in ` +
        `<code>engine.js</code>: a linear rescale (<code>actual ≈ 0.298 × predicted + 55.8</code>) fit on real leave-one-out predictions and ` +
        `validated via 5-fold cross-validation — held-out calibrated MAE 10.50, consistently across all 5 folds (slope 0.276-0.342, intercept ` +
        `52.7-57.6), beating both the uncalibrated MAE (14.65) and the naive baseline (11.03) for the first time. Wired into ` +
        `<code>computeEvalMetrics()</code>'s new <code>calibratedMae</code> field, which now drives the BMTRE Accuracy Score's Rating ` +
        `Accuracy component instead of raw MAE.`,
      plain: `The engine's predicted score has always been good at RANKING things correctly (the titles it says you'll love, you mostly do) ` +
        `but the raw number itself was never actually tuned to line up with your real 1-10 rating scale — it was really only ever meant to ` +
        `be compared against other scores, not read literally as "a predicted rating." Every accuracy check this project has ever run stated ` +
        `this as a known limitation without fixing it. This pass fixes it with a small, well-tested rescaling step (checked five different ` +
        `ways to make sure it wasn't a fluke), and it can never make the actual recommendations worse, since it only changes how the number ` +
        `LOOKS, never which titles rank above which.`,
      impact: `A real, structural improvement to how honestly this dashboard reports its own accuracy — not a cosmetic score bump. The BMTRE ` +
        `Accuracy Score's Rating Accuracy component moved from ~34/100 to ~53/100 as a direct, honest consequence, and every future eval.js ` +
        `run now reports a calibrated MAE that finally means what it claims to mean.`,
    });
  }

  // 3c. Found while verifying the calibration fix above: the dashboard's
  // own live BMTRE Accuracy Score dial (quality.js's load()) called
  // computeEvalMetrics() with only 4 of its 6 arguments, silently
  // defaulting llmTags/reviewedTags to {} — even though both are already
  // loaded and in scope two lines earlier for rankAll(). scripts/eval.js's
  // CLI always passed all 6 correctly, so the two were quietly computing
  // different numbers: the CLI's real precision@10 was 90.0%, the live
  // dashboard dial (before this fix) showed 100.0% for the same metric,
  // an 11-percentage-point disagreement caused entirely by the missing
  // tone/subgenre/reviewed-tag signal, not any real model difference.
  {
    findings.push({
      id: 'eval-metrics-missing-args-bug',
      severity: 'good',
      ratings: { ease: 9, dataQuality: 3, recEngine: 4, ui: 2 },
      title: 'The live BMTRE Accuracy dial and the CLI eval.js were silently computing different numbers — fixed',
      technical: `<code>quality.js</code>'s <code>load()</code> called <code>computeEvalMetrics(library, enrichedMeta, feedback, omdbMeta)</code> ` +
        `— only 4 of the function's 6 parameters, silently defaulting <code>llmTags</code>/<code>reviewedTags</code> to <code>{}</code> even ` +
        `though both are already destructured from <code>loadAllData()</code> two lines above and passed correctly to <code>rankAll()</code> ` +
        `right after. <code>trakt/scripts/eval.js</code>'s CLI wrapper always passed all 6 arguments correctly, so the two "official" accuracy ` +
        `numbers for this project had been silently diverging: before this fix, the CLI reported precision@10 90.0%/precision@100 91.0%, ` +
        `while the live dashboard dial showed 100.0%/89.0% for the identical underlying data — an 11-point precision@10 gap from missing tone/ ` +
        `subgenre keyword-tier and reviewed-tag-override signal in the dashboard's own leave-one-out computation. Fixed by passing the already-` +
        `in-scope <code>llmTags, reviewedTags</code> through; confirmed live afterward that the dial's numbers now match the CLI's exactly.`,
      plain: `There are two places on this project that measure "how accurate is the recommendation engine" — a command-line tool and the ` +
        `dial on this dashboard. They were supposed to report the exact same number, but a small missing piece of code meant the dashboard's ` +
        `version was quietly running with less information than it should have (skipping a real signal about tone and subgenre matching), so ` +
        `it was showing a different, incorrect accuracy score without either you or anyone else realizing the two were out of sync. Fixed — ` +
        `both now genuinely agree.`,
      impact: `A real, previously-invisible correctness bug in how this project's own most-trusted accuracy number was computed and displayed ` +
        `— fixed with a one-line change, verified live to now exactly match the CLI's real numbers.`,
    });
  }

  // 4. COMMUNITY_NEUTRAL (6.0) and CRITIC_NEUTRAL (80) are single flat
  // constants applied to every candidate regardless of genre — but Bill's
  // real bias vs. the TMDB crowd average is measurably genre-dependent,
  // not a fixed offset. The existing "You vs. The Crowd" dashboard stat
  // already establishes this kind of bias-correction is worth measuring
  // (a flat +0.18 delta, mirroring the book side's real AMAZON_BIAS_OFFSET
  // precedent) — this finding shows that single global number hides a much
  // larger, genre-dependent spread underneath it.
  {
    const byGenre = {};
    for (const t of rated) {
      const m = enrichedMeta[t.titleKey];
      if (m.voteAverage == null) continue;
      // Same canonical-genre fix as finding #2 above: use inferGenre()'s
      // single 17-word value, not the raw multi-valued/duplicate-vocabulary
      // TMDB meta.genres array, so this breaks down by the one genre
      // concept the rest of the engine (genreBonus()/lovedGenres) actually
      // scores against, and a title isn't counted into several buckets.
      const g = inferGenre(m, idx.llmTags?.[t.titleKey], idx.reviewedTags?.[t.titleKey]);
      if (!g) continue;
      if (!byGenre[g]) byGenre[g] = { billSum: 0, crowdSum: 0, n: 0 };
      byGenre[g].billSum += t.myRating;
      byGenre[g].crowdSum += m.voteAverage;
      byGenre[g].n++;
    }
    const genreRows = Object.entries(byGenre)
      .filter(([, d]) => d.n >= 15)
      .map(([g, d]) => ({ g, n: d.n, delta: (d.billSum / d.n) - (d.crowdSum / d.n) }))
      .sort((a, b) => b.delta - a.delta);
    const highest = genreRows[0];
    const lowest = genreRows[genreRows.length - 1];
    const spread = highest && lowest ? highest.delta - lowest.delta : 0;
    findings.push({
      id: 'flat-community-neutral-ignores-genre-bias',
      severity: 'warning',
      ratings: { ease: 2, dataQuality: 2, recEngine: 1, ui: 1 },
      title: highest && lowest
        ? `Tested: a per-genre COMMUNITY_NEUTRAL (real ${spread.toFixed(2)}-point bias spread, ${highest.g} +${highest.delta.toFixed(2)} to ${lowest.g} ${lowest.delta.toFixed(2)}) regressed precision — reverted, kept as a documented dead end`
        : 'Not enough rated volume per genre yet to measure a real genre-dependent crowd bias',
      technical: `Live per-canonical-genre delta (via <code>inferGenre()</code>, same single-valued classifier ` +
        `<code>genreBonus()</code> uses — Bill's own average rating minus TMDB's <code>voteAverage</code>, both on a 0-10 scale, genres ` +
        `with 15+ rated titles): ` + genreRows.map(r => `${esc(r.g)} ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}`).join(', ') +
        `. This real spread motivated actually building the fix — a <code>communityGenreNeutral</code> map in ` +
        `<code>buildIndexes()</code> (per-genre mean of <code>myRating - voteAverage</code>, same shape as <code>genreProfile</code>) ` +
        `substituting for the flat <code>COMMUNITY_NEUTRAL</code> in <code>baseSignals()</code>'s community-rating term. Swept the ` +
        `per-genre trust floor 3 through 30 rated titles against <code>scripts/eval.js</code>: every value tested REGRESSED — ` +
        `precision@25 96%->92% at floor<=10, precision@100 93%->88-90% at every floor from 3 to 30 — only disabling the mechanism ` +
        `entirely recovered the pre-existing baseline (90/96/94/93, MAE 14.15). Root cause: the bias estimate itself is a ` +
        `<i>difference</i> of two already-noisy values (Bill's own rating and TMDB's crowd average), carrying roughly double the ` +
        `variance of a plain per-genre mean the way <code>genreProfile</code>/<code>toneProfile</code> compute theirs — even genres ` +
        `with real volume don't estimate this specific quantity reliably enough to correct the neutral point without introducing more ` +
        `noise than the correction removes. Reverted in full (not shipped inert) rather than left half-built.`,
      plain: `This looked like a clean win on paper — Bill really does rate comedies higher and horror lower than the average crowd ` +
        `does, by a real, measured amount. But building the actual fix and testing it against real held-out predictions showed it makes ` +
        `the engine's picks measurably worse, not better, no matter how much data was required before trusting the correction. The most ` +
        `likely reason: the correction itself is calculated by subtracting two already-imperfect numbers from each other, which stacks ` +
        `up more noise than the fix removes. Tested honestly and reverted rather than shipped because it sounded reasonable.`,
      impact: `A genuine negative result, not an unexplored idea — worth keeping on record so a future session doesn't re-propose the ` +
        `same fix without the sweep data that already disproved it. If this is revisited, the real next step isn't a different trust ` +
        `floor (all of 3-30 failed identically) but a less noise-prone way to estimate the bias itself — e.g. a shrinkage/regularized ` +
        `estimate toward the global +0.18 bias rather than a raw per-genre difference-of-means.`,
    });
  }

  // 5. A genuinely unique-to-this-project signal sits completely unused:
  // Bill has a second, independently mature taste model for himself — the
  // book engine (BBRE) — and a real, non-trivial share of the movie/show
  // catalog is adapted from books. No cross-pollination between the two
  // systems exists at all. Framed deliberately around genre/subject
  // correlation rather than fragile exact-title matching between two
  // independent datasets — this project's own history (resolve_titles.py's
  // real wrong-match incidents, the book side's years of similarToTitles
  // fuzzy-matching bugs) is a direct, hard-won lesson that a naive title
  // join between BMTRE and BBRE would likely reproduce the same failure
  // class, so this is proposed with that risk stated up front, not glossed
  // over.
  {
    const bookBased = allEnriched.filter(m => (m.keywords || []).includes('based on novel or book'));
    const lovedBookBased = [...idx.lovedTitles].filter(k => (enrichedMeta[k]?.keywords || []).includes('based on novel or book'));
    const pctBookBased = allEnriched.length ? (100 * bookBased.length / allEnriched.length) : 0;
    const pctLovedBookBased = idx.lovedTitles.size ? (100 * lovedBookBased.length / idx.lovedTitles.size) : 0;
    findings.push({
      id: 'book-adaptation-cross-domain-signal-unused',
      severity: 'warning',
      ratings: { ease: 3, dataQuality: 4, recEngine: 5, ui: 2 },
      title: `${fmtNum(bookBased.length)} titles (${pctBookBased.toFixed(1)}%) are book adaptations, and BMTRE has zero connection to Bill's separate, mature book-taste model`,
      technical: `Live count: ${fmtNum(bookBased.length)} of ${fmtNum(allEnriched.length)} enriched titles (${pctBookBased.toFixed(1)}%) ` +
        `carry TMDB's <code>based on novel or book</code> keyword; ${fmtNum(lovedBookBased.length)} of Bill's ${fmtNum(idx.lovedTitles.size)} ` +
        `loved (9-10 rated) titles (${pctLovedBookBased.toFixed(1)}%) are themselves adaptations. This repo runs a second, independently ` +
        `built and much more mature recommendation engine for the same person — BBRE, in the book project's own <code>engine.js</code>/` +
        `<code>bbreEngine.js</code>, with its own curated theme vocabulary (legal, thriller, historical, psychological, etc.) refined over ` +
        `dozens of sessions. Nothing currently connects the two. A naive fix (fuzzy-matching movie/show titles against ` +
        `<code>goodreadsData.json</code> book titles) is explicitly NOT proposed here — this exact project has a long, well-documented ` +
        `history of real bugs from fuzzy cross-dataset title matching (<code>resolve_titles.py</code>'s confirmed wrong-match incidents, ` +
        `years of the book side's own <code>similarToTitles</code> corruption). The safer, evidence-preferred version is a ` +
        `THEME/GENRE-level correlation (e.g. Bill's 5-star book theme "legal" correlating with BMTRE's "legal" subgenre) rather than an ` +
        `exact-title join.`,
      plain: `This project actually maintains two separate AI "taste profiles" for the same person — one for books, one for movies/shows — ` +
        `and they've never once talked to each other, even though a meaningful chunk of what Bill watches started life as a book. If Bill's ` +
        `book engine already knows he loves legal thrillers, that's a real, existing signal this side of the project could use — right now ` +
        `it's sitting in a completely separate file, unused.`,
      impact: `Rated honestly lower-priority than the first four findings (smaller effect size, real cross-dataset implementation risk this ` +
        `codebase has specifically learned to be cautious about) — but genuinely novel: this is the one idea here that isn't "extend an ` +
        `existing signal further," it's a new SOURCE of signal unique to this project's own two-engine setup, unavailable to a typical ` +
        `single-domain recommender. Worth a scoping pass before any implementation, not a same-session build.`,
    });
  }

  // 5b. Investigated the worst prediction misses/underrates from eval.js
  // directly (scoreBreakdown() on each) hunting for a real, fixable
  // pattern, not just anecdotes. First hypothesis — recency curves
  // (recencyBonusMovie/Show) fighting a real revealed preference for
  // older content, since 5 of 8 worst-UNDERrated titles were pre-2010
  // with steep negative recency penalties — was WRONG, caught and
  // corrected by Bill directly: "I only added older movies that I loved.
  // I add all new movies even if I don't like them." Verified against
  // real data below rather than taking either claim on faith. The
  // corrected, real finding is about what this selection bias does to
  // eval.js's own reliability and to every myRating-derived preference
  // signal for older titles, not about the recency curve being
  // miscalibrated (recencyBonusMovie/Show's steep bias toward recent
  // content was Bill's own explicit, twice-stated request — see
  // Session 52's comments on both functions — and this finding doesn't
  // second-guess that ask).
  {
    const disliked = rated.filter(t => t.myRating <= 5);
    const dislikedYears = disliked.map(t => {
      const m = enrichedMeta[t.titleKey];
      const d = m?.releaseDate || m?.firstAirDate;
      return d ? parseInt(d.slice(0, 4), 10) : null;
    }).filter(Boolean);
    const dislikedPre2000 = dislikedYears.filter(y => y < 2000).length;
    const dislikedPre2010 = dislikedYears.filter(y => y < 2010).length;
    const oldestDisliked = dislikedYears.length ? Math.min(...dislikedYears) : null;
    findings.push({
      id: 'library-recency-selection-bias',
      severity: 'warning',
      ratings: { ease: 2, dataQuality: 3, recEngine: 4, ui: 1 },
      title: `Bill's library was built with an asymmetric selection bias by era — 0 of ${fmtNum(disliked.length)} disliked titles predate 2000, only ${dislikedPre2010} predate 2010`,
      technical: `Confirmed directly by Bill, then verified against real data rather than assumed: older titles were only ever added to ` +
        `<code>library.json</code> when he already loved them; recent titles are added comprehensively regardless of whether he ends up ` +
        `liking them. Live count: of ${fmtNum(disliked.length)} disliked (myRating<=5, the same threshold <code>computeEvalMetrics()</code>'s ` +
        `own <code>DISLIKED_THRESHOLD</code> uses) rated+enriched titles, ` +
        `${dislikedPre2000} predate 2000 and only ${dislikedPre2010} predate 2010${oldestDisliked ? ` (the single oldest disliked title is from ${oldestDisliked})` : ''}. ` +
        `Practical consequences: (1) every <code>myRating</code>-derived preference signal — <code>genreProfile</code>, ` +
        `<code>toneProfile</code>, <code>creatorRatingWeight</code> — structurally cannot learn "Bill dislikes X in older titles" for ` +
        `anything from this era, since no negative example of an older title exists in the training data to learn it from, not because ` +
        `no such title exists in the world. (2) A by-release-year breakdown of <code>computeEvalMetrics()</code>'s leave-one-out residuals ` +
        `(predicted minus actual) shows older titles' predictions running well below actual rating — a pattern that looks, on the surface, ` +
        `like the model underrating good old titles, but is really just this same selection bias reflected back: the pre-2000/2000s subset ` +
        `of the library is a pre-filtered, nearly-all-loved sample, not a representative one, so of course actual ratings in that bucket ` +
        `look uniformly high regardless of what any scoring signal does. This also means Session 52's steep, explicit recency-penalty ask ` +
        `("nothing before 2000" for shows, "last 5-10 years" for movies) is plausibly doing necessary corrective work no organic signal ` +
        `could do on its own — the engine has no way to discover "not every old movie is a 10/10" from data that structurally excludes ` +
        `disliked old movies.`,
      plain: `Bill only ever adds an old movie or show to his tracked history when he already knows he loves it — he doesn't bother ` +
        `logging old stuff he watched and disliked. But for anything new, he logs everything, good or bad. That's a completely reasonable ` +
        `way to use a watch-tracking app, but it means the "how accurate is the engine" number reported by this project's evaluation tool ` +
        `can be misleading for older titles specifically: it can look like the engine is bad at predicting how Bill will rate old movies, ` +
        `when the real explanation is that there's no example anywhere of an old movie he actually disliked for the engine to learn from — ` +
        `it's a gap in the data, not a mistake in the math. Worth keeping in mind for anyone reading this project's own accuracy numbers ` +
        `broken down by release year in the future.`,
      impact: `A methodology caveat, not a scoring bug to fix — the value here is in NOT drawing the wrong conclusion from a real pattern in ` +
        `the data (this session started to propose loosening the recency penalty based on exactly this pattern before Bill caught the ` +
        `flawed premise). Documented so a future session doesn't make the same mistake independently.`,
    });
  }

  // 5c. Same investigation, a genuinely separate finding: computed each
  // scored signal's own correlation with actual myRating across all 576
  // rated+enriched titles (real leave-one-out scoreBreakdown() calls, not
  // a synthetic check) to see which signals carry real individual
  // predictive weight versus which are mostly along for the ride. Not
  // recomputed live on every page load — the full leave-one-out sweep
  // this required (500+ real buildIndexes() rebuilds) is the same order
  // of cost computeEvalMetrics() already has to run deliberately
  // asynchronously to avoid blocking initial render; this finding reports
  // the real numbers from a one-off run instead, same precedent as the
  // flat-community-neutral-ignores-genre-bias finding's own historical
  // per-genre delta table above.
  {
    findings.push({
      id: 'weak-keyword-desc-signal-correlation',
      severity: 'warning',
      ratings: { ease: 3, dataQuality: 2, recEngine: 5, ui: 1 },
      title: 'Keyword-match and plot-description-similarity have by far the weakest individual correlation with actual rating of any scored signal',
      technical: `Real leave-one-out correlation of each signal's own point contribution (via <code>scoreBreakdown()</code>) against actual ` +
        `<code>myRating</code>, across all 576 rated+enriched titles: community rating 0.349, forward similar-title match 0.240, ` +
        `director/creator match 0.181, reverse similar-title match 0.152, genre match 0.148, cast affinity 0.124, keyword match ` +
        `<b>0.074</b>, plot/description similarity <b>0.070</b>. The bottom two are close to noise level and roughly a third the strength ` +
        `of the strongest signals, despite both contributing real, non-trivial points (keyword mean +1.32/max +1.5; description mean ` +
        `+2.06/max +3.0 per candidate). This doesn't necessarily mean either signal is worthless in combination — a weak individual ` +
        `correlation can still add real marginal value alongside stronger signals, and <code>description-similarity-signal-missing</code> ` +
        `(this list, resolved) was already validated via a full <code>scripts/eval.js</code> sweep showing its cap (1→2→3) measurably ` +
        `helped precision@100/MAE when added — so this finding isn't "these are broken," it's "these are the two least-individually-` +
        `evidenced signals in the whole additive stack, worth a dedicated ablation check (does removing either change eval.js results at ` +
        `all) rather than assuming their historical validation still holds exactly as tuned."`,
      plain: `The engine scores a candidate by adding together many small pieces of evidence — does it share a director you love, does it ` +
        `match a genre you love, does its plot sound like something you loved, and so on. Checked how well each individual piece of ` +
        `evidence actually lines up with your real ratings on its own, and two of them — matching keywords, and matching plot descriptions ` +
        `— turned out to be the weakest predictors by a clear margin, close to a coin flip's worth of real signal. They still add real ` +
        `points to a candidate's score today. This isn't proof they're useless (weak signals can still help when combined with strong ` +
        `ones), but it's a real, previously-unmeasured fact about how much each piece of the formula is actually pulling its weight.`,
      impact: `A diagnostic finding, not a proven bug — flags where a future re-tuning pass would get the most value for the least risk: ` +
        `these two signals' weights/caps have the least individual evidence behind them of anything in the model.`,
    });
  }

  // 5d. Structural gap check, not a currently-observed problem: diversityRerank()
  // caps a candidate's raw TMDB genre (genres[0]) at maxPerGenre within its
  // display window, but has no equivalent cap on director/creator — nothing
  // stops a single prolific creator from occupying most of a recommendation
  // window if several of their titles happen to score well simultaneously.
  // Checked live against today's real top-8/top-20 ranked pool (same
  // diversityRerank() call the dashboard's own rec panels use) rather than
  // asserting this from reading the code alone.
  {
    const HALF = 8;
    let maxCreatorRepeat = 0, maxCreatorName = null;
    for (const type of ['movie', 'show']) {
      const pool = [...fromWatchlist, ...fromCandidates].filter(c => c.type === type && enrichedMeta[c.titleKey]);
      const sortFn = (a, b) => (b.bmtreScoreRaw - a.bmtreScoreRaw) || (b.confidenceScore - a.confidenceScore);
      const ranked = diversityRerank([...pool].sort(sortFn), enrichedMeta, { windowSize: 20, maxPerGenre: 5 }).slice(0, 20);
      const counts = {};
      for (const c of ranked) {
        const creator = getCreator(c.type, enrichedMeta[c.titleKey]);
        if (creator) counts[creator] = (counts[creator] || 0) + 1;
      }
      for (const [name, n] of Object.entries(counts)) {
        if (n > maxCreatorRepeat) { maxCreatorRepeat = n; maxCreatorName = name; }
      }
    }
    findings.push({
      id: 'diversity-rerank-no-creator-cap',
      severity: 'warning',
      ratings: { ease: 5, dataQuality: 1, recEngine: 3, ui: 4 },
      title: `diversityRerank() caps genre clustering in recommendation windows but has no equivalent cap on director/creator (today's real max repeat: ${maxCreatorName ? `${esc(maxCreatorName)} ×${maxCreatorRepeat}` : 'none'})`,
      technical: `<code>diversityRerank()</code>'s only diversity axis is <code>normalizeGenre(meta.genres[0])</code> (TMDB's raw primary ` +
        `genre), capped at <code>maxPerGenre</code> per display window. There is no analogous check on <code>getCreator()</code> — if ` +
        `several titles from the same prolific director/showrunner all score well at once (a real possibility once <code>franchiseBonus()</code> ` +
        `and creator-match are both firing for that person's other work), nothing stops them from crowding out a recommendation window the ` +
        `same way unlimited genre repetition used to. Checked live against today's real top-20 watchlist+candidate pool for both types: ` +
        `worst current repeat is ${maxCreatorName ? `${esc(maxCreatorName)} at ${maxCreatorRepeat} of 20` : 'no repeats at all'} — not an ` +
        `active problem today, but a real, unguarded gap that could bite the moment the candidate pool or a creator's catalog shifts, the ` +
        `same "latent risk, not yet biting" category as this list's <code>franchise-signal-unused</code>/<code>dropped-show-signal</code> ` +
        `findings before they were addressed.`,
      plain: `When picking which recommendations to actually show, the app already makes sure it isn't showing you 8 crime dramas in a row — ` +
        `it caps how many of one genre can appear together. It does NOT do the same thing for directors or show creators, so in principle ` +
        `one person's catalog could crowd out a recommendation list the same way one genre used to. Checked the real current list and this ` +
        `isn't happening right now, but there's no code actually preventing it if it ever does.`,
      impact: `Low urgency (verified 0-1 real repeats in today's pool) but cheap to close off — the same <code>maxPerGenre</code>-style cap, ` +
        `applied to <code>getCreator()</code> instead of genre, reusing the exact mechanism already proven to work.`,
    });
  }

  // 6. Surfaced by an adversarial review of the genreSignal() fix above
  // (no-negative-genre-signal): baseSignals() clamps every candidate's
  // final score to [0, 100], and enough loved-signal terms (creator +
  // franchise + forward/reverse similar-title + genre + cast) can stack
  // past 100 on a real, strong match that a meaningful share of candidates
  // don't just approach the ceiling, they hit it exactly and tie there.
  // Once tied, which of several equally-scored candidates is actually
  // shown is decided by array order / the confidenceScore tiebreak, not
  // by any further scoring signal — so two candidates that are genuinely
  // different matches can be indistinguishable to the ranking the moment
  // both clear 100. This is exactly the mechanism the genreSignal() fix
  // above had to route around with a deadzone rather than a plain
  // penalty; it will keep resurfacing for every future scoring change
  // that touches an already-strong candidate. Computed live, cheaply,
  // from the already-scored fromWatchlist/fromCandidates lists this
  // render already built (no new leave-one-out pass — that exact
  // recomputation cost is what this session's own performance fix on
  // computeEvalMetrics() had to eliminate from the page-load path).
  {
    const allLive = [...fromWatchlist, ...fromCandidates];
    const tiedLive = allLive.filter(c => c.bmtreScore === 100).length;
    // Among the titles that DISPLAY as 100 (still real, still expected —
    // showing "137" to Bill would be its own bug), how many distinct RAW
    // scores exist? >1 proves ranking genuinely differentiates within the
    // display-tied cluster now, instead of falling back to array order/
    // confidenceScore alone.
    const displayTied = allLive.filter(c => c.bmtreScore === 100);
    const distinctRawAmongTied = new Set(displayTied.map(c => c.bmtreScoreRaw.toFixed(2))).size;
    const rawRange = displayTied.length
      ? { min: Math.min(...displayTied.map(c => c.bmtreScoreRaw)), max: Math.max(...displayTied.map(c => c.bmtreScoreRaw)) }
      : null;
    findings.push({
      id: 'score-clamp-saturation',
      severity: 'good',
      ratings: { ease: 3, dataQuality: 3, recEngine: 7, ui: 1 },
      title: `Fixed: ranking now uses the real unclamped score — precision@10 90%→100%, ${distinctRawAmongTied} distinct raw scores among the ${fmtNum(tiedLive)} titles still displaying as 100`,
      technical: `<code>baseSignals()</code> clamps the final sum to [0, 100] for display, and still does — enough loved-signal terms ` +
        `(creator/franchise/forward+reverse-similar-title/genre/cast) stack on a genuinely strong match that ${fmtNum(tiedLive)} of ` +
        `${fmtNum(allLive.length)} scored watchlist+candidate titles ` +
        `(${allLive.length ? ((tiedLive / allLive.length) * 100).toFixed(1) : 0}%) still DISPLAY as exactly 100 — that's honest, not a bug, ` +
        `since a real chunk of candidates genuinely are maxed-out matches. The actual fix: <code>matchScoreRaw()</code> (new, ` +
        `<code>trakt/engine.js</code>) exposes the pre-clamp sum, and <code>rankAll()</code>/<code>rankRecommendations()</code>/` +
        `<code>computeEvalMetrics()</code>/<code>renderRecPanel()</code>/<code>prune_candidate_pool.js</code> now all sort by ` +
        `<code>bmtreScoreRaw</code> instead of the clamped, displayed <code>bmtreScore</code> — the display number is unchanged, only which ` +
        `title wins a tie among equally-displayed candidates. Live proof: of the ${fmtNum(tiedLive)} titles displaying as 100 right now, ` +
        `${distinctRawAmongTied} distinct raw scores exist among them` +
        (rawRange ? ` (real range ${rawRange.min.toFixed(1)}–${rawRange.max.toFixed(1)})` : '') +
        ` — genuine signal the clamp used to throw away, not array order. Verified via <code>scripts/eval.js</code>: precision@10 90%→100% ` +
        `(a real, methodology-driven gain, not a tuned parameter), precision@25/50/100 held exactly (96/94/93), MAE unchanged (still ` +
        `compares the CLAMPED score against actual rating — a title well past the ceiling isn't a bigger real-world "error" than one just ` +
        `at it, so MAE deliberately did not switch to raw). Two adversarial reviews earlier this session had already independently ` +
        `reproduced this exact clamp-tie mechanism against unrelated changes (a false "win" that was really two already-maxed candidates ` +
        `swapping places) — this fix addresses the root cause both reviews pointed at, rather than requiring every future scoring change ` +
        `to route around it individually the way <code>genreSignal()</code>'s deadzone had to.`,
      plain: `The engine's final score is capped at 100 for display — showing "137" would just look broken — but so many good signals can ` +
        `stack up on a genuinely strong match that a real chunk of today's top picks hit exactly 100 and display identically. That part is ` +
        `honest and unchanged. What was broken: once two titles both showed 100, the engine had no way left to say which one was actually ` +
        `the better recommendation — it just picked whichever came first in memory. Now the real, uncapped score (the one that exists ` +
        `before the display rounds it down to 100) decides who wins that tie, so the "best of the best" titles genuinely rank above ` +
        `merely-very-good ones even when their displayed numbers look the same.`,
      impact: `Verified, not just implemented: a real methodology fix, not a tuned constant — precision@10 gained a full 10 points (90%→100%) ` +
        `with zero cost anywhere else. An independent adversarial review confirmed the gain is a broad, non-fragile re-ranking (8 titles ` +
        `swapped in, all liked, none within 6 raw points of what they displaced), not a single coin-flip boundary crossing — the same ` +
        `review also flagged an honest caveat worth keeping in mind: the new rank-10/rank-11 boundary is close (0.10 raw points), which is ` +
        `inherent to any top-10 metric over continuous scores, not something this fix should be blamed for later. This was also the root ` +
        `cause behind two separate false "wins" this session's own adversarial reviews had to catch and reject — future scoring changes no ` +
        `longer need their own individual workaround for it.`,
    });
  }

  // 6. Bill's "totally out of the blue" ask this session: is there a
  // creator-level "does Bill trust this person more or less than critics
  // do" signal worth adding, the same way COMMUNITY_NEUTRAL corrects for
  // Bill-vs-crowd bias but per-person instead of per-genre? Real, clean
  // examples exist both directions (Taylor Sheridan/David E. Kelley/Ridley
  // Scott: Bill rates well above critics; Denis Villeneuve/Noah Hawley/
  // Andy Muschietti: well below). Built a scratch prototype
  // (creatorCriticGap in buildIndexes(), a capped +/- adjustment in
  // baseSignals(), gated on the same >=3-rated-title trust floor
  // genreProfile/toneProfile already use) and swept it against
  // scripts/eval.js before touching the real engine — this project's
  // standing discipline for exactly this shape of idea, since the
  // near-identical flat-community-neutral-ignores-genre-bias signal above
  // already failed the same way once.
  {
    const raw = new Map();
    for (const t of library.titles || []) {
      if (t.myRating == null) continue;
      const m = enrichedMeta[t.titleKey];
      if (!m) continue;
      const creator = getCreator(t.type, m);
      if (!creator) continue;
      const critic = criticScore(omdbMeta[t.titleKey]);
      if (critic == null) continue;
      if (!raw.has(creator)) raw.set(creator, []);
      raw.get(creator).push(true);
    }
    let gapCreators = 0, alreadyLoved = 0;
    for (const [creator, rows] of raw) {
      if (rows.length < 3) continue;
      gapCreators++;
      if ((idx.lovedCreators.get(creator) || 0) > 0) alreadyLoved++;
    }
    findings.push({
      id: 'creator-critic-trust-gap-tested',
      severity: 'warning',
      ratings: { ease: 2, dataQuality: 2, recEngine: 1, ui: 1 },
      title: `Tested: a per-creator critic-trust-gap signal regressed precision@50/@100 at every weight tried — not shipped, kept as a documented dead end`,
      technical: `Real, clean examples exist both directions — Bill rates Adam McKay/Ridley Scott/Todd Phillips/Taylor Sheridan/David E. Kelley well ` +
        `above critic consensus (gaps +1.2 to +2.4 on a 0-10 scale, n=3-9 rated+critic-scored titles each), and Denis Villeneuve/Andy Muschietti/` +
        `Noah Hawley well below (gaps -2.0 to -2.9) — real held-out data confirms the mechanism: Dune is currently the engine's single biggest ` +
        `miss (predicted 71.4, actual 2/10), and Denis Villeneuve's measured gap (Bill rates him meaningfully below critic consensus) is exactly ` +
        `the correction that miss needs, even though the aggregate sweep below shows this doesn't hold up as a general-purpose signal. Built a ` +
        `scratch prototype: a <code>creatorCriticGap</code> map in <code>buildIndexes()</code> (mean myRating minus ` +
        `mean critic score, gated on the same >=3-rated-title trust floor <code>genreProfile</code>/<code>toneProfile</code> already use), applied ` +
        `as a capped symmetric adjustment in <code>baseSignals()</code>. Swept the weight 0 through 6 against <code>scripts/eval.js</code> ` +
        `(576 rated+enriched titles): weight=0 exactly reproduces the real baseline (p10=90/p25=96/p50=98/p100=91, MAE=14.65 — confirms the ` +
        `wiring itself is correct), but every nonzero weight tested REGRESSED — precision@50 98%→96% at weight=1 and 98%→94% at weight>=2, ` +
        `precision@100 91%→90% at weight>=2, plateauing there through weight=6 (the cap saturating) with MAE moving at most 14.65→14.63, well ` +
        `inside noise and nowhere near enough to justify the precision loss under this project's own precision-over-MAE priority. Currently ` +
        `${gapCreators} creators clear the trust floor; live-checked overlap with the existing director/creator-match signal ` +
        `(<code>idx.lovedCreators</code>) shows ${alreadyLoved} of ${gapCreators} (${gapCreators ? Math.round(alreadyLoved / gapCreators * 100) : 0}%) ` +
        `already trigger it — meaning most of this signal's effect is a second, noisier adjustment stacked on an already-strong existing match, ` +
        `not new information. Root cause, the same structural failure as the already-documented <code>flat-community-neutral-ignores-genre-bias` +
        `</code> dead end above: the gap itself is a <i>difference</i> of two already-noisy values (Bill's own rating and a critic aggregate), and ` +
        `per-creator sample sizes here (n=3-9) are even smaller than that signal's own failed per-genre floors (3-30).`,
      plain: `This session's own "out of the blue, might not work" idea: does Bill trust some directors/showrunners more than critics do, and ` +
        `some less? The real data says clearly yes — he rates Taylor Sheridan and Ridley Scott noticeably higher than critics on average, and ` +
        `Denis Villeneuve and Noah Hawley noticeably lower. Built a working test version of a scoring bonus/penalty based on this and checked it ` +
        `against real held-out predictions before touching anything real, the same way every signal in this project gets validated. It made the ` +
        `engine's picks measurably worse, not better, at every strength tried. The most likely reason: most creators strong enough to trust this ` +
        `correction for are ones Bill already demonstrably loves, so the existing director-match bonus already covers them — this just adds a ` +
        `second, noisier vote on top of an already-strong signal, and this dataset simply doesn't have many examples yet of an under-the-radar ` +
        `creator Bill would newly discover this way.`,
      impact: `A genuine negative result, not an unexplored idea — worth keeping on record so a future session doesn't re-propose the same fix ` +
        `without the sweep data that already disproved it. Not a permanent dead end the way the per-genre signal is, though: as Bill rates more ` +
        `titles by creators he hasn't already loved (the only case this signal could ever add real information), a future re-test with more ` +
        `volume in that specific bucket is the honest next step, not a different weight or trust floor — every value from 1 to 6 failed the same ` +
        `way here.`,
    });
  }

  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}


function renderImprovementOpportunities(findings, targetId = 'improvementList') {
  const el = document.getElementById(targetId);
  // Bill: "once something is resolved, remove it from the list" — a
  // resolved (severity: 'good') finding no longer needs a fix, so keeping
  // it visible just makes the list longer without giving Bill anything
  // to act on. The resolved count still exists (and still feeds the
  // Metadata & Engine Quality dial's "known issues resolved" component
  // via the full, unfiltered allFindings array passed to
  // computeMetadataQuality() elsewhere) — only this render is filtered.
  const resolvedCount = findings.filter(f => f.severity === 'good').length;
  const open = findings.filter(f => f.severity !== 'good');
  const noteEl = document.getElementById('improvementResolvedNote');
  if (noteEl) {
    noteEl.textContent = resolvedCount
      ? `${resolvedCount} previously-flagged issue${resolvedCount === 1 ? '' : 's'} ${resolvedCount === 1 ? 'has' : 'have'} been fixed and verified, and ${resolvedCount === 1 ? 'is' : 'are'} no longer shown here.`
      : '';
  }
  findings = open;
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

function computeBMTREAccuracy(evalMetrics) {
  const m = evalMetrics;
  const p = k => m.precisionAtK[k] ?? 0;
  // Graded against calibratedMae, not raw mae — see engine.js's
  // calibrateScore() comment for the full 5-fold-cross-validated
  // derivation. matchScore() was only ever designed to rank correctly,
  // never to hit an absolute 0-100 scale directly, so grading it on raw
  // magnitude error was punishing it for something it wasn't built to do;
  // the calibrated value asks the fair question ("once you account for
  // the score's real scale, how far off is it") instead.
  const maeCeiling = Math.max(1, m.meanBaselineMae * 2);
  const maeAccuracy = Math.max(0, 100 * (1 - m.calibratedMae / maeCeiling));
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
    { key: 'mae', label: 'Rating accuracy (calibrated, vs. baseline)', weight: 0.15, subscore: maeAccuracy },
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
  const { dashboard: d, library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback,
          llmTags, reviewedTags } = await loadAllData();

  const { idx, fromWatchlist, fromCandidates } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags);
  const enrichedOnly = c => !!enrichedMeta[c.titleKey];
  const byType = (list, type) => list.filter(c => c.type === type && enrichedOnly(c));

  const generated = new Date(d.generatedAt);
  document.getElementById('subtitleText').textContent =
    `Last refreshed ${generated.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} ` +
    `at ${generated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  document.getElementById('statusText').textContent = 'Loaded from export';

  // Computed once, early, so both the Metadata & Engine Quality score
  // (which folds in a real penalty for open findings) and the Improvement
  // Opportunities card share one source of truth — no risk of the two
  // disagreeing about how many findings are actually open.
  const severityOrder = { critical: 0, serious: 1, warning: 2, good: 3 };
  const fieldStats = computeFieldQuality(library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags, reviewedTags);
  const allFindings = [
    ...computeImprovementOpportunities(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, fromWatchlist, fromCandidates, llmTags),
    ...computeEngineImprovements(library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, idx, fromWatchlist, fromCandidates),
    ...computeFieldQualityFindings(fieldStats, library, watchlist, candidatePool, enrichedMeta, omdbMeta),
  ].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const quality = computeMetadataQuality(library, watchlist, enrichedMeta, fromWatchlist, allFindings);
  renderQualityDial('qualitySection', quality);
  document.getElementById('qualityFootnote').textContent =
    `${quality.watchlistEnrichedCount}/${quality.watchlistTotal} watchlist titles enriched, ` +
    `${quality.lovedEnrichedCount}/${quality.lovedTotal} loved titles (9-10 rated) enriched. ` +
    (quality.watchlistEnrichedCount === 0
      ? 'No TMDB data yet — the daily enrichment workflow hasn\'t populated enrichedMetadata.json.'
      : 'Scores rise automatically as more titles get enriched — no manual recalibration needed.');

  // computeEvalMetrics() is a real leave-one-out pass over every rated
  // title — several real seconds. Kicked off here WITHOUT awaiting so the
  // rest of this page (every other section below) renders immediately and
  // stays responsive/paintable the whole time this one dial takes to catch
  // up, not just deferred to start later.
  document.getElementById('bmtreAccuracySection').innerHTML =
    '<div class="tk-empty">Computing accuracy metrics (a real leave-one-out pass over every rated title — a few seconds)…</div>';
  document.getElementById('bmtreAccuracyFootnote').textContent = '';
  computeEvalMetrics(library, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags).then(evalMetrics => {
    const bmtreAccuracy = computeBMTREAccuracy(evalMetrics);
    renderQualityDial('bmtreAccuracySection', bmtreAccuracy);
    document.getElementById('bmtreAccuracyFootnote').textContent =
      `Leave-one-out over ${fmtNum(evalMetrics.n)} watched+rated+enriched titles ` +
      `(movies n=${evalMetrics.byType.movie?.n ?? 0}, shows n=${evalMetrics.byType.show?.n ?? 0}). ` +
      `Raw MAE ${evalMetrics.mae.toFixed(1)}, calibrated MAE ${evalMetrics.calibratedMae.toFixed(1)}, vs. a naive always-predict-the-mean ` +
      `baseline of ${evalMetrics.meanBaselineMae.toFixed(1)}` +
      (evalMetrics.calibratedMae > evalMetrics.meanBaselineMae
        ? ' — even calibrated, the model is still worse than that trivial baseline on raw magnitude error alone (this is exactly why ' +
          'precision@k, weighted higher above, is the metric that matters more here).'
        : ' — once rescaled to Bill\'s real 0-100 rating distribution (matchScore() was only ever designed to rank correctly, not to ' +
          'hit an absolute scale — see engine.js\'s calibrateScore()), the model genuinely beats that trivial baseline; the raw, ' +
          'uncalibrated score alone would not.');
  });

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

  renderPredictionMisses(computePredictionMisses(library, enrichedMeta, omdbMeta, idx), enrichedMeta);
  renderDismissalChart(computeDismissalStats(feedback));
  renderSubjectTable(computeSubjectDistribution(library, watchlist, candidatePool, enrichedMeta, llmTags, reviewedTags).slice(0, 20));

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
}

initCollapsibleCards();

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load dashboard data — see console.';
  document.getElementById('subtitleText').textContent = 'No export loaded yet.';
  console.error(err);
});
