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

import { rankAll, getCreator, matchScore, hydrateTitle, popularityScore, criticScore, realAudienceScore, awardsScore, mergeScrapedShowRatings, posterUrl, computeEvalMetrics, diversityRerank, resolveSimilarTitles, resolveSimilarDirectors, inferSubgenres, inferTones, inferSubjects, inferEra, inferGenre, inferSubgenreDetail, findTaxonomyCollisions } from './engine.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtNum = n => (n ?? 0).toLocaleString('en-US');

// A cached posterPath can go stale if TMDB moves/reprocesses the underlying
// image asset after enrich_tmdb.py fetched it (a real, if partial, cause of
// "the images aren't loading" bug reports — this app can't tell a genuinely
// broken URL from a network hiccup without a live browser to check against).
// The onerror handler below swaps a broken poster for the exact same
// empty-placeholder markup a title with no cached posterPath at all already
// gets, so a stale path degrades to the existing "no cover" look instead of
// a broken-image icon, at every one of the 3 places a poster renders as an
// HTML string (the 4th, the All Titles table, builds the <img> via DOM APIs
// directly and gets the same onerror behavior inline there instead).
const posterImgHtml = (url, cssClass, w, h) => url
  ? `<img class="${cssClass}" src="${esc(url)}" alt="" loading="lazy" width="${w}" height="${h}" ` +
    `onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${cssClass} ${cssClass}-empty'}))">`
  : `<div class="${cssClass} ${cssClass}-empty"></div>`;

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
  Dismissed:  { cls: 'tk-status-tag-dismissed',  label: 'Dismissed' },
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

  // viewBox scales the content; width is left as 100% and height MUST be
  // 'auto' (never a raw px number equal to the viewBox height) so the
  // rendered box always matches the viewBox's own aspect ratio exactly. A
  // fixed-px height attribute here previously fought the intrinsic
  // preserveAspectRatio="xMidYMid meet" scaling the moment the container
  // was narrower than the 700-unit viewBox (true for both the two-column
  // desktop layout and, worse, the single-column mobile one) — the chart
  // rendered shrunk-down and letterboxed inside its own box, reading as
  // "small/zoomed out" with soft-looking (actually just downscaled) text.
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', style: 'display:block; height:auto;' });

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

// "Genres You Rate Highest" used to read TMDB's own raw genre field — a
// blunt ~19/16-word taxonomy where "Drama" alone sat on 75%+ of every
// enriched title, so the chart was really just restating one mega-bucket
// in different orders rather than showing anything Bill could act on
// (Bill: "drama is way too broad, I want them much more narrow"). This
// chart deliberately still plots Subgenre, not the new clean single-valued
// Genre field the taxonomy redesign added (inferGenre(), 17 canonical
// values, wired into real scoring via genreBonus()) — Subgenre is the
// finer of the two taxonomies (a curated 65-bucket canonical vocabulary,
// keyword-matched against TMDB's overview/keywords, with a
// trakt/data/reviewedTags.json override tier and a trakt/data/llmTags.json
// LLM pass as fallbacks for titles the keyword tier can't confidently
// classify) and stays the more useful axis for a "what do you actually
// like" breakdown; Genre itself is summarized instead in the Field
// Population & Quality table and its own Improvement Opportunities finding.
function computeGenreStats(library, enrichedMeta, llmTags = {}, reviewedTags = {}) {
  const stats = new Map();
  for (const t of library.titles || []) {
    if (t.myRating == null) continue;
    const meta = enrichedMeta[t.titleKey];
    if (!meta) continue;
    for (const g of inferSubgenres(meta, llmTags[t.titleKey], undefined, reviewedTags[t.titleKey])) {
      // Refined per-title (not after aggregation) so a WWII drama and a
      // Vietnam War drama bucket separately under their real conflict
      // instead of both landing in one generic "Historical"/"War" bucket
      // - see displaySubgenre()'s own comment for why this refinement
      // exists at all.
      const label = displaySubgenre(g, meta);
      if (!stats.has(label)) stats.set(label, { sum: 0, count: 0 });
      const e = stats.get(label);
      e.sum += t.myRating; e.count++;
    }
  }
  return [...stats.entries()]
    .map(([genre, e]) => ({ genre, avg: e.sum / e.count, count: e.count }))
    .filter(g => g.count >= 3)
    .sort((a, b) => b.avg - a.avg)
    // The Subgenre canonical vocabulary grew to 65 buckets in the taxonomy
    // redesign (up from 29), so an unbounded chart got long enough to lose
    // its "what do you actually like" readability — capped to the top 20
    // by avg rating, the same cardinality this chart worked well at before
    // the vocabulary expanded.
    .slice(0, 20);
}

// inferSubgenres() returns hyphenated machine keys (engine.js reads them
// back for scoring, so they can't be prettied at the source) — a small
// display-only label map, same spirit as REASON_CODE_SHORT_LABEL below.
// Post-taxonomy-redesign canonical vocabulary (65 buckets). A handful of
// old genre-duplicative buckets (crime-drama, sci-fi-fantasy, war, sports,
// horror, biopic) were retired — that signal now lives in the separate
// Genre field — so their labels were dropped rather than left dangling.
const SUBGENRE_LABEL = {
  'procedural': 'Procedural', 'legal': 'Legal', 'heist': 'Heist', 'spy-espionage': 'Spy / Espionage',
  'psychological-thriller': 'Psychological Thriller', 'family-drama': 'Family Drama',
  'coming-of-age': 'Coming-of-Age', 'romcom': 'Rom-Com', 'workplace-comedy': 'Workplace Comedy',
  'dark-comedy': 'Dark Comedy', 'prison': 'Prison', 'neo-western': 'Neo-Western',
  'organized-crime': 'Organized Crime', 'drug-trade': 'Drug Trade', 'assassin-hitman': 'Assassin / Hitman',
  'murder-mystery': 'Murder Mystery', 'police-procedural': 'Police Procedural', 'historical': 'Historical',
  'political': 'Political', 'romance': 'Romance', 'medical': 'Medical', 'superhero': 'Superhero',
  'musical': 'Musical',
  'psychological-drama': 'Psychological Drama', 'ensemble': 'Ensemble', 'workplace-drama': 'Workplace Drama',
  'neo-noir': 'Neo-Noir', 'character-study': 'Character Study', 'crime-thriller': 'Crime Thriller',
  'biography': 'Biography', 'mystery-drama': 'Mystery Drama', 'military-drama': 'Military Drama',
  'dramedy': 'Dramedy', 'conspiracy-thriller': 'Conspiracy Thriller', 'survival-drama': 'Survival Drama',
  'sitcom': 'Sitcom', 'satire': 'Satire', 'true-crime': 'True Crime', 'anthology': 'Anthology',
  'docudrama': 'Docudrama', 'buddy-comedy': 'Buddy Comedy', 'post-apocalyptic': 'Post-Apocalyptic',
  'psychological-horror': 'Psychological Horror', 'dystopian': 'Dystopian',
  'supernatural-horror': 'Supernatural Horror', 'friendship-comedy': 'Friendship Comedy',
  'mockumentary': 'Mockumentary', 'family-comedy': 'Family Comedy', 'journalism-drama': 'Journalism Drama',
  'time-travel': 'Time Travel', 'crime-comedy': 'Crime Comedy', 'action-comedy': 'Action Comedy',
  'survival-horror': 'Survival Horror', 'financial-drama': 'Financial Drama',
  'techno-thriller': 'Techno-Thriller', 'space-opera': 'Space Opera', 'absurdist-comedy': 'Absurdist Comedy',
  'social-drama': 'Social Drama', 'creature-feature': 'Creature Feature', 'alien-invasion': 'Alien Invasion',
  'comedy-mystery': 'Comedy Mystery', 'supernatural-mystery': 'Supernatural Mystery',
  'chamber-drama': 'Chamber Drama', 'disaster-drama': 'Disaster Drama', 'horror-comedy': 'Horror Comedy',
};

// Bill: "instead of drama -> historical drama, it should be historical
// drama -> WW2" then "Historical was just an example. I want that level
// of specificity for all genres and subgenres" — when a title's subgenre
// has a real, verified detail map in GENRE_DETAIL_KEYWORDS (engine.js)
// and a specific match is found, show that instead of the generic label
// everywhere a subgenre is displayed (the genre chart, rec cards, the
// All Titles table) — refining, not duplicating, the existing tag. Falls
// back to the generic subgenre label for the majority of titles in any
// given subgenre with no specific detail keyword, or for subgenres with
// no detail map at all (a WWII drama with no 'world war ii' keyword
// still reads as "Historical", never blank).
function displaySubgenre(tag, meta) {
  if (meta) {
    const detail = inferSubgenreDetail(tag, meta)[0];
    if (detail) return detail;
  }
  return SUBGENRE_LABEL[tag] || tag;
}

// Post-Subjects-consolidation vocabulary: the original 12 SUBJECT_KEYWORDS
// (keyword-tier) labels, plus ~39 new canonical buckets the consolidation
// pass folded reviewedTags.json's 636 free-form workbook values into
// (targeting 3-15 titles/bucket instead of hundreds of near-singleton
// values) - see engine.js's SUBJECT_CANONICAL_VOCABULARY for the full list.
const SUBJECT_LABEL = {
  'addiction-recovery': 'Addiction / Recovery (Alcohol)', 'drug-addiction': 'Addiction (Drugs)',
  'grief-loss': 'Grief / Loss', 'suicide': 'Suicide', 'terminal-illness': 'Terminal Illness',
  'trauma-abuse': 'Trauma (PTSD / War)', 'domestic-abuse': 'Domestic / Sexual Abuse',
  'racism-civil-rights': 'Racism / Civil Rights', 'historical-atrocities': 'Historical Atrocities',
  'immigration-refugee': 'Immigration / Refugee',
  'infidelity': 'Infidelity / Affairs', 'journalism-media': 'Journalism / Media',
  'cult-extremism': 'Cult / Extremism', 'mental-health': 'Mental Health', 'class-wealth-corporate': 'Class / Wealth Divide',
  'corporate-power': 'Corporate Power', 'lgbtq': 'LGBTQ+', 'survival': 'Survival',
  'ambition-reinvention': 'Ambition / Reinvention', 'artistic-creative': 'Artistic / Creative Life',
  'celebrity-fame': 'Celebrity / Fame', 'crime-consequences': 'Crime & Consequences',
  'crime-investigation': 'Crime Investigation', 'criminal-life': 'Criminal Life',
  'crime-syndicate-life': 'Crime Syndicate Life', 'deception-secrets': 'Deception / Secrets',
  'economic-hardship': 'Economic Hardship', 'espionage-national-security': 'Espionage / National Security',
  'family-dynamics': 'Family Dynamics', 'fate-and-destiny': 'Fate & Destiny', 'found-family': 'Found Family',
  'friendship-community': 'Friendship / Community', 'frontier-westward': 'Frontier / Westward Expansion',
  'healthcare-medicine': 'Healthcare / Medicine', 'identity-belonging': 'Identity / Belonging',
  'isolation-connection': 'Isolation & Connection', 'justice-legal-system': 'Justice / Legal System',
  'law-enforcement': 'Law Enforcement', 'loyalty': 'Loyalty', 'marriage-relationships': 'Marriage / Relationships',
  'parenthood': 'Parenthood', 'politics-power': 'Politics & Power', 'power-corruption': 'Power / Corruption',
  'redemption': 'Redemption', 'religion-faith': 'Religion / Faith', 'resistance-rebellion': 'Resistance / Rebellion',
  'revenge': 'Revenge', 'sacrifice-duty': 'Sacrifice / Duty', 'self-discovery': 'Self-Discovery',
  'social-inequality': 'Social Inequality', 'sports-competition': 'Sports / Competition',
  'supernatural-paranormal': 'Supernatural / Paranormal', 'technology-surveillance': 'Technology / Surveillance',
  'vigilante-justice': 'Vigilante Justice', 'war-conflict': 'War / Conflict', 'workplace-culture': 'Workplace Culture',
  'wrongful-conviction': 'Wrongful Conviction', 'youth-and-adolescence': 'Youth & Adolescence',
  'societal-collapse': 'Societal Collapse',
};

const ERA_LABEL = {
  // inferEra()'s own coarse 4-bucket keyword scheme.
  'ancient-to-1900': 'Pre-1900', 'early-1900s': 'Early 1900s (1900-1945)', 'mid-late-1900s': 'Mid/Late 1900s (1946-1999)',
  'future-setting': 'Future',
  // trakt/data/reviewedTags.json's richer 17-value era vocabulary (from the
  // reviewed metadata workbook) - a real vocabulary swap, not a subset of
  // the keys above, since the override tier replaces inferEra()'s output
  // entirely rather than refining it.
  'classical-antiquity': 'Classical Antiquity', 'medieval': 'Medieval', 'early-modern': 'Early Modern',
  '18th-century': '18th Century', '19th-century': '19th Century', 'late-19th-century': 'Late 19th Century',
  'early-20th-century': 'Early 20th Century', 'world-war-i': 'World War I', 'interwar': 'Interwar',
  'world-war-ii': 'World War II', 'cold-war': 'Cold War', 'late-20th-century': 'Late 20th Century',
  'contemporary': 'Contemporary', 'near-future': 'Near Future', 'far-future': 'Far Future',
  'multi-era': 'Multiple Eras', 'timeless': 'Timeless / Fantastical',
};

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
      ${posterImgHtml(poster, 'tk-metric-poster', 38, 57)}
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
  { key: 'genres', label: 'Genres (raw TMDB)', source: 'TMDB', critical: true,
    eligible: (t, meta) => !!meta,
    populated: (t, meta) => (meta?.genres?.length || 0) > 0,
    quality: (t, meta) => (meta?.genres?.length || 0) >= 2,
    values: (t, meta) => meta?.genres || [],
    note: 'The raw multi-valued TMDB field (Drama alone sat on 75%+ of everything) — kept here for reference and ' +
      'still feeds the keyword-tier fallback in Genre below, but is no longer the field BMTRE scores against ' +
      'directly. See "Genre (clean, single-valued)" below for the field the taxonomy redesign replaced it with.' },
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
    note: 'Eligible = titles with a known IMDb id. Needs OMDB_API_KEY to run.' },
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
    genres: (f) => {
      const g = genreCounts();
      const s = f.specificity;
      return {
        severity: 'warning',
        ratings: { ease: 2, dataQuality: 4, recEngine: 3, ui: 2 },
        title: `Genres quality is ${f.qualityPct.toFixed(1)}% — below the 90% bar (row completeness + distribution specificity, blended)`,
        technical: `<code>genres</code> is 100% populated. % Quality is now a 50/50 blend of two separate checks (added this session): ` +
          `(a) row completeness — ${f.rowQualityPct.toFixed(1)}% of titles (${f.quality} of ${f.eligible}) carry 2+ genre tags so ` +
          `<code>genreBonus()</code> has more than one to match (${g.single} single-tag, ${g.multi} multi-tag; spot-checked and re-verified ` +
          `against fresh <code>fetchedAt</code> timestamps as real current TMDB tagging, not stale cache); and (b) specificity — ` +
          `${s ? s.specificityPct.toFixed(1) : '?'}% (normalized Shannon entropy across ${s ? s.distinctCount : '?'} distinct genre values), ` +
          `dragged down because <code>"${s ? s.topValue : '?'}"</code> alone accounts for ${s ? s.topSharePct.toFixed(1) : '?'}% of all genre ` +
          `tags versus an optimal ≤${s ? s.optimalTopSharePct.toFixed(1) : '?'}% if evenly spread across ${s ? s.distinctCount : '?'} values. ` +
          `Both halves trace to the same root cause: TMDB's top-level genre taxonomy is real but blunt (~19 fixed categories), not a pipeline bug.`,
        plain: `Two separate problems get combined into this one number now: some titles only have one genre tag (like just "Comedy"), and ` +
          `on top of that, "${s ? s.topValue : 'Drama'}" is used so often (about a third of all genre tags) that it doesn't tell the engine ` +
          `much — a truly specific field would spread its tags more evenly across the ~24 real genre values in use. Both are checked directly ` +
          `against TMDB's own data, not a bug in how this app reads it.`,
        impact: `Below the bar Bill set, so it's listed here, but a low-effort fix doesn't really exist for this specific raw TMDB field — ` +
          `TMDB itself is the source of both gaps, and this field is no longer what BMTRE scores against directly. The Genre/Subgenre ` +
          `taxonomy redesign already addressed the real underlying concern (a blunt, over-concentrated genre signal) by adding a separate, ` +
          `clean single-valued "Genre" field (<code>inferGenre()</code>, see its own row below) that <code>genreBonus()</code> now scores ` +
          `against instead of this raw field — that field doesn't inherit this row's specificity problem. This raw field is kept for ` +
          `reference and as one of Genre's own fallback-tier inputs, not because closing this specific gap still matters much on its own.`,
      };
    },
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
    // No 'era' entry: fixed for real (noSpecificityInQuality on its
    // FIELD_REGISTRY row, see that row's own comment) rather than left as
    // a permanently-open "not really a gap" finding — two independent
    // spot-checks (this one, and the fix itself) confirmed the same
    // conclusion, so the fix acts on it instead of just re-documenting it.
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
    findings.push({
      id: 'closed-loop-discovery',
      severity: 'serious',
      ratings: { ease: 4, dataQuality: 3, recEngine: 7, ui: 3 },
      title: `${pctClosedLoop.toFixed(0)}% of the discovered candidate pool comes from the exact same graph that then scores it`,
      technical: `<code>trakt/scripts/discover_candidates.js</code> sources every candidate exclusively from ` +
        `<code>similarToIds</code>/<code>recommendedIds</code> on titles rated >= <code>LOVED_THRESHOLD</code> — TMDB's own ` +
        `algorithmic "similar to" graph. That is the IDENTICAL data <code>baseSignals()</code>'s forward/reverse-match signal (worth up ` +
        `to +24/+12) rewards a candidate for appearing in. Live proof, not inference from reading the script: of ${fmtNum(poolTitles.length)} ` +
        `titles currently in <code>candidatePool.json</code>, ${fmtNum(citedByLoved.length)} (${pctClosedLoop.toFixed(1)}%) are directly ` +
        `cited by a loved title's own similar/recommended list — discovery and scoring are, structurally, the same graph queried twice.`,
      plain: `The pool of "new things Bill might like" is built entirely by asking TMDB's own algorithm "what's similar to what Bill ` +
        `already loves" — and then the recommendation engine's strongest scoring signal is, again, "does TMDB's algorithm consider this ` +
        `similar to something Bill already loves." It's the same question asked twice, so nothing genuinely outside what TMDB's own ` +
        `similarity model already associates with his favorites can ever surface, no matter how good a match it might actually be. It's a ` +
        `filter bubble built into the pipeline's architecture, not a scoring-weight problem a tuning pass could fix.`,
      impact: `Every other finding on this list is about scoring candidates better — this one is about whether the RIGHT candidates ever ` +
        `reach scoring at all. A real fix needs a second, independent discovery source: e.g. TMDB's genre-filtered top-rated/popular ` +
        `endpoints seeded from Bill's real <code>lovedGenres</code> mix rather than title-to-title similarity, or a small explicit ` +
        `"exploration" quota mixed into <code>candidatePool.json</code> alongside the similarity-graph picks — deliberately sourced ` +
        `differently so it isn't subject to the same closed loop.`,
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
      severity: 'serious',
      ratings: { ease: 6, dataQuality: 2, recEngine: 6, ui: 1 },
      title: highest && lowest
        ? `Bill's rating bias vs. TMDB's crowd swings ${spread.toFixed(2)} points by genre (${highest.g} +${highest.delta.toFixed(2)} to ${lowest.g} ${lowest.delta.toFixed(2)}) — but one flat neutral point is used for every candidate`
        : 'Not enough rated volume per genre yet to measure a real genre-dependent crowd bias',
      technical: `Live per-canonical-genre delta (via <code>inferGenre()</code>, same single-valued classifier ` +
        `<code>genreBonus()</code> uses — Bill's own average rating minus TMDB's <code>voteAverage</code>, both on a 0-10 scale, genres ` +
        `with 15+ rated titles): ` + genreRows.map(r => `${esc(r.g)} ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}`).join(', ') +
        `. <code>COMMUNITY_NEUTRAL = 6.0</code> and <code>CRITIC_NEUTRAL = 80</code> are each one flat constant applied identically to ` +
        `every candidate in <code>baseSignals()</code>/<code>omdbSignal()</code> regardless of genre — the same crowd rating is credited ` +
        `identically whether it's a Comedy (where Bill runs well above the crowd) or a Horror title (where he runs below it).`,
      plain: `The engine already knows, in aggregate, that Bill tends to rate things a bit higher than the average TMDB voter — that's ` +
        `the "You vs. The Crowd" number on this dashboard. What it doesn't know is that this isn't one flat gap — Bill rates comedies and ` +
        `war movies well above what the crowd gives them, but rates horror titles BELOW what the crowd gives them. A crowd rating of 7.2 ` +
        `means something different depending on the genre, and the engine currently treats it as meaning the same thing every time.`,
      impact: `A refinement of a signal that already exists and is already trusted, not a new one — replacing the single ` +
        `<code>COMMUNITY_NEUTRAL</code>/<code>CRITIC_NEUTRAL</code> constants with a per-genre neutral point (computed live from ` +
        `<code>idx.lovedGenres</code>'s own rated population, the same "measure it, don't guess it" discipline this file already used for ` +
        `<code>matchPointScale</code> and <code>AMAZON_BIAS_OFFSET</code> on the book side) would make the community/critic rating signal ` +
        `meaningfully more accurate for every candidate, in both directions.`,
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
    const byTypeTop8 = {};
    for (const type of ['movie', 'show']) {
      const scored = allLive.filter(c => c.type === type).map(c => c.bmtreScore).sort((a, b) => b - a);
      const top8 = scored.slice(0, 8);
      byTypeTop8[type] = { tied: top8.filter(s => s === 100).length, of: top8.length };
    }
    findings.push({
      id: 'score-clamp-saturation',
      severity: 'serious',
      ratings: { ease: 3, dataQuality: 3, recEngine: 7, ui: 1 },
      title: `${byTypeTop8.show.tied} of the current top ${byTypeTop8.show.of} TV picks are tied at exactly 100 — the tie, not the ranking, decides what's shown`,
      technical: `Live count, this render: ${fmtNum(tiedLive)} of ${fmtNum(allLive.length)} scored watchlist+candidate titles ` +
        `(${allLive.length ? ((tiedLive / allLive.length) * 100).toFixed(1) : 0}%) sit at the exact 100.0 clamp ceiling. Of the true ` +
        `top ${byTypeTop8.movie.of} movies by score, ${byTypeTop8.movie.tied} are tied at 100; of the true top ${byTypeTop8.show.of} ` +
        `shows, ${byTypeTop8.show.tied} are. This isn't a near-tie — <code>baseSignals()</code> clamps the final sum to [0, 100], and ` +
        `enough loved-signal terms (creator/franchise/forward+reverse-similar-title/genre/cast) stack on a genuinely strong match that ` +
        `the raw pre-clamp score routinely exceeds 100 well before any of the smaller signals (community rating, keyword match, ` +
        `description similarity) get a chance to differentiate between two candidates that both clamp to the ceiling. Once tied, which ` +
        `one is actually shown is decided by <code>confidenceScore</code> (a real but much coarser "how much data do we have" tiebreak, ` +
        `never meant to carry ranking weight on its own) or plain array order, not by anything about which title is the better match. ` +
        `An adversarial review of the <code>genreSignal()</code> fix above independently confirmed the same pattern in ` +
        `<code>computeEvalMetrics()</code>'s leave-one-out harness: 55 of 560 rated titles (9.8%) score exactly 100.0 there too — and ` +
        `100% of the titles precision@25 grades (the top 25 by score) are tied at 100.000, meaning that metric currently measures which ` +
        `arbitrary slice of a same-score cluster lands in the first 25 array positions, not real ranking quality. (Not re-run live here — ` +
        `that specific recomputation is the same expensive leave-one-out pass this session's own performance fix had to stop running on ` +
        `every page load.) This predates the genreSignal() change; it's inherited scoring-architecture debt the fix had to work around ` +
        `(the asymmetric clamp + deadzone), not something it introduced.`,
      plain: `The engine's final score is capped at 100 — but so many good signals can stack up on a genuinely strong match (the right ` +
        `director, a franchise you love, a similar title, the right genre) that a real chunk of today's top picks don't just get close to ` +
        `100, they hit exactly 100 and tie there. Once two titles are both sitting at the maximum possible score, the engine has no more ` +
        `room left to say which one is actually the better recommendation — it just falls back to a much weaker tiebreaker. This matters ` +
        `right now, not hypothetically: several of the current top TV picks are tied at the ceiling.`,
      impact: `A structural measurement problem, not a display glitch: it silently limits how well any future scoring improvement can be ` +
        `verified (a change that only affects already-maxed candidates can't move the ranking at all) and makes the engine's own ` +
        `precision@25 metric less trustworthy than it looks. The <code>genreSignal()</code> fix above had to design around this exact ` +
        `issue with a deadzone rather than a plain penalty; a real fix (widening the achievable score range before the display clamp, or ` +
        `making the clamp cosmetic-only while ranking uses the unclamped sum) would remove the need for that kind of workaround on every ` +
        `future scoring change, not just this one.`,
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
      titleKey: h.titleKey, posterUrl: posterUrl(h.titleKey, enrichedMeta),
      title: h.title || '(untitled — not yet enriched)', year: h.year, type: h.type, status,
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
          img.onerror = () => { img.remove(); };
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
    return allRows.filter(r => {
      if (type && r.type !== type) return false;
      if (status && r.status !== status) return false;
      if (year && String(r.year) !== year) return false;
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
  showAllBtn.addEventListener('click', () => { showAll = !showAll; render(); });
  document.getElementById('titleCsvBtn').addEventListener('click', () => downloadCSV(table, 'trakt-all-titles.csv'));
}

// ── Recommendations preview ─────────────────────────────────────────────

// One line of real metadata under the title: genres, director/creator,
// TMDB community rating — whatever's actually present, since candidate
// stubs may still be mid-enrichment.
const fmtCompact = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

function metaLine(candidate, enrichedMeta, omdbMeta, llmTags = {}, reviewedTags = {}) {
  const meta = enrichedMeta[candidate.titleKey];
  if (!meta) return 'Not enriched yet.';
  const parts = [];
  // Narrower subgenres (e.g. "Crime Drama, Procedural"), not TMDB's own
  // broad genre list (e.g. "Drama, Crime" on 75%/33% of everything) — see
  // computeGenreStats()'s comment above for why the raw field alone isn't
  // useful. Falls back to the raw genres if a title has no subgenre match
  // at all (3 of 786 today) so a card never shows blank genre info.
  const subs = inferSubgenres(meta, llmTags[candidate.titleKey], undefined, reviewedTags[candidate.titleKey]).slice(0, 2).map(s => displaySubgenre(s, meta));
  if (subs.length) parts.push(subs.join(', '));
  else if (meta.genres?.length) parts.push(meta.genres.slice(0, 2).join(', '));
  const creator = getCreator(candidate.type, meta);
  if (creator) parts.push(candidate.type === 'movie' ? `dir. ${creator}` : `by ${creator}`);
  if (meta.voteAverage != null) {
    const ratings = meta.voteCount != null ? ` (${fmtCompact(meta.voteCount)} ratings)` : '';
    parts.push(`${meta.voteAverage.toFixed(1)}/10 on TMDB${ratings}`);
  }
  const omdbEntry = omdbMeta?.[candidate.titleKey];
  if (omdbEntry?.imdbVotes != null) parts.push(`${fmtCompact(omdbEntry.imdbVotes)} IMDb votes`);
  const critic = criticScore(omdbEntry);
  if (critic != null) parts.push(`${critic}/100 critics`);
  const audience = realAudienceScore(omdbEntry);
  if (audience != null) parts.push(`${audience}/100 audience`);
  const awardsText = omdbEntry?.awards?.raw;
  if (awardsText && awardsText !== 'N/A') {
    parts.push(awardsText.length > 40 ? awardsText.slice(0, 40) + '…' : awardsText);
  }
  return parts.join(' · ') || 'No genre/creator data yet.';
}

// A guaranteed 4 watchlist + 4 discovered-candidate split, each half its
// own top-scored + diversity-reranked picks, then the combined 8 sorted
// by score for DISPLAY order only. History: this used to be a straight
// top-4-per-origin block (watchlist block, then candidate block) — Bill
// flagged a panel "starting with a 44" (a weak watchlist pick sitting
// above a stronger candidate purely because of block order), so a prior
// session replaced the split with a pure top-8-by-score-across-both-
// origins pick. That fixed the ordering complaint but meant a panel could
// legitimately show 6-8 watchlist picks and 0-2 new ones whenever
// watchlist scores ran high — which Bill then flagged as losing the
// discovery half of the panel's whole point. Restored the guaranteed
// split (his explicit call) but kept the score-sorted DISPLAY order from
// the fix in between: origin composition is fixed at 4/4, but a strong
// candidate can still display above a weaker watchlist pick, and vice
// versa — the "44 at the top" complaint doesn't reproduce, since within
// each half the top-scored one is picked, and the two halves interleave
// by score for display. If one origin has fewer than 4 real candidates,
// the other origin backfills the remainder rather than showing short.
// diversityRerank() only reorders for display within each half — it
// never touches an individual title's bmtreScore, so none of this
// affects computeEvalMetrics()'s precision@k.
function renderRecPanel(sectionId, watchlistItems, candidateItems, enrichedMeta, omdbMeta, llmTags = {}, reviewedTags = {}) {
  const el = document.getElementById(sectionId);
  const sortFn = (a, b) => (b.bmtreScore - a.bmtreScore) || (b.confidenceScore - a.confidenceScore);
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
          ${typeIcon(c.type)} ${esc(c.title)}${c.year ? ` <span class="tk-year">(${esc(c.year)})</span>` : ''}
          <span class="tk-rec-badge">${c.origin === 'watchlist' ? 'Watchlist' : 'New pick'}</span>
        </div>
        <div class="tk-rec-meta">${esc(metaLine(c, enrichedMeta, omdbMeta, llmTags, reviewedTags))}</div>
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

  const [d, library, watchlist, candidatePool, enrichedMeta, omdbMetaRaw, feedback, scrapedShowRatings, llmTags, reviewedTags] = await Promise.all([
    get('./data/dashboard.json'),
    get('./data/library.json').catch(() => ({ titles: [] })),
    get('./data/watchlist.json').catch(() => ({ titles: [] })),
    get('./data/candidatePool.json').catch(() => ({ titles: [] })),
    get('./data/enrichedMetadata.json').catch(() => ({})),
    get('./data/omdbMetadata.json').catch(() => ({})),
    get('./data/feedbackData.json').catch(() => ({ interactions: [] })),
    get('./data/scrapedShowRatings.json').catch(() => ({})),
    get('./data/llmTags.json').catch(() => ({})),
    get('./data/reviewedTags.json').catch(() => ({})),
  ]);
  const omdbMeta = mergeScrapedShowRatings(omdbMetaRaw, scrapedShowRatings);

  const { idx, fromWatchlist, fromCandidates } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags);
  const enrichedOnly = c => !!enrichedMeta[c.titleKey];
  const byType = (list, type) => list.filter(c => c.type === type && enrichedOnly(c));

  // Computed once, early, so both the Metadata & Engine Quality score
  // (which now folds in a real penalty for open findings, per Bill's
  // explicit "97 is too generous given all the improvement ideas we
  // have" pushback) and the Improvement Opportunities card itself
  // (rendered later) share one source of truth — no risk of the two
  // disagreeing about how many findings are actually open.
  const severityOrder = { critical: 0, serious: 1, warning: 2, good: 3 };
  const fieldStats = computeFieldQuality(library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags, reviewedTags);
  const allFindings = [
    ...computeImprovementOpportunities(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, fromWatchlist, fromCandidates, llmTags),
    ...computeEngineImprovements(library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, idx, fromWatchlist, fromCandidates),
    ...computeFieldQualityFindings(fieldStats, library, watchlist, candidatePool, enrichedMeta, omdbMeta),
  ].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  renderRecPanel('movieRecList', byType(fromWatchlist, 'movie'), byType(fromCandidates, 'movie'), enrichedMeta, omdbMeta, llmTags, reviewedTags);
  renderRecPanel('showRecList', byType(fromWatchlist, 'show'), byType(fromCandidates, 'show'), enrichedMeta, omdbMeta, llmTags, reviewedTags);

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

  // computeEvalMetrics() is a real leave-one-out pass over every rated
  // title — still several real seconds even after optimizing
  // buildIndexes()'s dominant cost (see that function's own comment) — a
  // genuine page-load performance bug Bill reported ("takes a very long
  // time"). It's now an async function that yields to the event loop
  // every 40 titles (see its own comment), so calling it here WITHOUT
  // awaiting lets the rest of load() below (every other section) render
  // immediately, and the browser stays responsive/paintable throughout
  // the several seconds this one diagnostic dial takes to catch up — not
  // just deferred to start later, genuinely non-blocking the whole way.
  document.getElementById('bmtreAccuracySection').innerHTML =
    '<div class="tk-empty">Computing accuracy metrics (a real leave-one-out pass over every rated title — a few seconds)…</div>';
  document.getElementById('bmtreAccuracyFootnote').textContent = '';
  computeEvalMetrics(library, enrichedMeta, feedback, omdbMeta).then(evalMetrics => {
    const bmtreAccuracy = computeBMTREAccuracy(evalMetrics);
    renderQualityDial('bmtreAccuracySection', bmtreAccuracy);
    document.getElementById('bmtreAccuracyFootnote').textContent =
      `Leave-one-out over ${fmtNum(evalMetrics.n)} watched+rated+enriched titles ` +
      `(movies n=${evalMetrics.byType.movie?.n ?? 0}, shows n=${evalMetrics.byType.show?.n ?? 0}). ` +
      `MAE ${evalMetrics.mae.toFixed(1)} vs. a naive always-predict-the-mean baseline of ${evalMetrics.meanBaselineMae.toFixed(1)}` +
      (evalMetrics.mae > evalMetrics.meanBaselineMae
        ? ' — the model is currently worse than that trivial baseline on raw magnitude error alone (Bill\'s ratings skew high, so guessing the mean scores well on MAE without ranking anything correctly; this is exactly why precision@k, weighted higher above, is the metric that matters more here).'
        : ' — the model beats that trivial baseline.');
  });

  const generated = new Date(d.generatedAt);
  document.getElementById('subtitleText').textContent =
    `Last refreshed ${generated.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} ` +
    `at ${generated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  document.getElementById('statusText').textContent = 'Loaded from export';

  renderStatTiles(d.summary);

  const enrichedCount = Object.keys(enrichedMeta).length;
  document.getElementById('genreSectionScopeNote').textContent =
    `Based on the ${fmtNum(enrichedCount)} titles enriched with TMDB data so far (of ${fmtNum((library.titles?.length || 0) + (watchlist.titles?.length || 0))} total) — ` +
    `these sections fill in automatically as the daily enrichment job covers more of your library.`;

  renderGenreChart(computeGenreStats(library, enrichedMeta, llmTags, reviewedTags));
  renderSubjectTable(computeSubjectDistribution(library, watchlist, candidatePool, enrichedMeta, llmTags, reviewedTags).slice(0, 20));
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

  renderAllTitlesTable(buildAllTitlesRows(library, watchlist, candidatePool, enrichedMeta, omdbMeta, idx, llmTags));
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
