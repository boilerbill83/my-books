// Page-agnostic helpers shared by trakt/discover.js and trakt/quality.js —
// extracted from the original single-page trakt/dashboard.js (Bill: "split
// the dashboard into three focused pages... main for finding things to
// watch, second for data quality, third Deep Dive"). One shared module so
// the two pages' formatting/rendering primitives can't quietly drift apart,
// the same discipline scripts/lib/loadData.js established for the book
// project's join logic and trakt/scripts/lib/traktExport.js established for
// the Trakt side's raw-export reading.
//
// Every function/const below is verbatim from dashboard.js (same file, same
// behavior) — only the module boundary is new.

import {
  getCreator, hydrateTitle, matchScore, mergeScrapedShowRatings, criticScore,
  realAudienceScore, inferSubgenres, inferSubgenreDetail, traktUrl, computeBookThemeCounts,
  mergeManualRatings, isActivelyAiring, posterUrl,
} from './engine.js';

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
// Bill's explicit request: "make it so that all titles in the app are
// clickable and take me right to that page in Trakt." One shared helper
// so every title-rendering surface (rec cards, metric rows, the All
// Titles table) links out identically, rather than each spot
// reimplementing the same <a> markup.

const titleLink = c => `<a class="tk-trakt-link" href="${esc(traktUrl(c))}" target="_blank" rel="noopener">${esc(c.title)}</a>`;

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

// Bill's explicit request: a visible marker for a show whose current
// season is still actively airing (isActivelyAiring() in engine.js) -
// used in the All Titles table's own Airing column and the Currently
// Airing list below, wherever such a title needs to be flagged as "not
// fully watchable yet" without touching its actual predicted score.

const airingBadge = () =>
  `<span class="tk-status-tag tk-status-tag-airing" title="A new episode of this show's current season hasn't aired yet">🕐 Airing</span>`;


const NS = 'http://www.w3.org/2000/svg';

const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};


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
  const creator = getCreator(candidate.type, meta, candidate.titleKey);
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

// Both Discover and Quality fetch the identical 10 data files and do the
// identical OMDb+Metacritic merge — one shared loader so that list can't
// quietly drift between the two pages the way two independently-maintained
// copies eventually would (same discipline as loadData.js on the book side
// and traktExport.js for the Trakt side's own raw-export reading).
// currentlyWatching.json is a bare array (not {titles: [...]} like the
// other files), so it's returned as-is, not unwrapped.
async function loadAllData() {
  const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  const [dashboard, libraryRaw, watchlist, candidatePool, enrichedMeta, omdbMetaRaw, feedback,
         scrapedShowRatings, llmTags, reviewedTags, currentlyWatching, coWatchTags, upcomingSeasons, personMeta,
         currentlyWatchingFeature, familyWatchlist, releaseLog, goodreadsData, manualRatings] = await Promise.all([
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
    get('./data/currentlyWatching.json').catch(() => []),
    // Manual co-viewing tags (Bill: "I want to manually tag these so they
    // only show up here" — shows he only watches with someone else, kept
    // out of the solo-oriented rec surfaces and grouped into their own
    // section instead). { tagName: [titleKey, ...] }; starts {} so a
    // missing file just means no tags yet, not an error.
    get('./data/coWatchTags.json').catch(() => ({})),
    // Real, hand-researched renewal/premiere status for a show between
    // seasons — TMDB's nextEpisodeToAir only ever exists once a season is
    // actually scheduled, so "renewed, no date yet" or "canceled" would
    // otherwise be invisible. { titleKey: { status, season, window,
    // source, researchedAt } }; never guessed — see each entry's source.
    get('./data/upcomingSeasons.json').catch(() => ({})),
    // TMDB /person/{id} cache (enrich_person.py) — birthday/gender (Deep
    // Dive's cast-age display) and, as of the prestige-identification
    // work, each person's own real popularity score (Bill: "is there a
    // way to identify a show as prestige... a big star like JK Simmons").
    // Keyed by TMDB person id, not titleKey. {} is a safe empty default
    // (deepdive.js already establishes this pattern for the same file).
    get('./data/personMetadata.json').catch(() => ({})),
    // Bill's own stated current watch, told directly rather than derived
    // from a Trakt export — see the file's own "note" field. { titleKey,
    // facts: [{text, source, sourceLabel}] }; null is a safe empty default
    // (no manual pointer set → the hero falls back to its normal pick).
    get('./data/currentlyWatchingFeature.json').catch(() => null),
    // Bill's own curated "watch with the whole family" list — see the
    // file's own "note" field. { titles: [{titleKey, theatricalReleaseDate,
    // streaming, sources}] }; {titles:[]} is a safe empty default.
    get('./data/familyWatchlist.json').catch(() => ({ titles: [] })),
    // A human-readable release log of real BMTRE engine/data-pipeline
    // changes, each with a real before/after (eval.js numbers where the
    // harness existed at the time, a qualitative note otherwise) — see the
    // file's own "note" field. { entries: [...] }; {entries:[]} is a safe
    // empty default (never blocks the rest of the page on a missing file).
    get('./data/releaseLog.json').catch(() => ({ entries: [] })),
    // book-adaptation-cross-domain-signal-unused: BBRE's (the book
    // engine's) own committed data, read from the book side's data/ dir at
    // the repo root (a sibling of trakt/, not a subfolder — same repo, no
    // cross-repo complexity). {books:[]} is a safe empty default so a
    // missing/renamed file degrades this one signal to zero rather than
    // blocking the whole page.
    get('../data/goodreadsData.json').catch(() => ({ books: [] })),
    // Real ratings Bill gave directly to this app instead of through a
    // Trakt export (2026-09-11: "I am not going to be uploading data into
    // Trakt; you need to store that data in our app") — see the file's own
    // `note` field and mergeManualRatings()'s comment for the full design.
    // {titles:[]} is a safe empty default.
    get('./data/manualRatings.json').catch(() => ({ titles: [] })),
  ]);
  const library = mergeManualRatings(libraryRaw, manualRatings);
  const omdbMeta = mergeScrapedShowRatings(omdbMetaRaw, scrapedShowRatings);
  const bookThemeCounts = computeBookThemeCounts(goodreadsData);
  return { dashboard, library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, llmTags, reviewedTags, currentlyWatching, coWatchTags, upcomingSeasons, personMeta, currentlyWatchingFeature, familyWatchlist, releaseLog, bookThemeCounts };
}

// Best Matches (Discover) and Prediction Misses (Quality) are two views of
// the exact same row set — every rated, enriched library title's predicted
// vs. actual score. Computed once here so the two pages can never disagree
// about a title's predicted score the way two independent re-derivations
// eventually would.
function predictedVsActualRows(library, enrichedMeta, omdbMeta, idx) {
  return (library.titles || [])
    .filter(t => enrichedMeta[t.titleKey] && t.myRating != null)
    .map(t => {
      const h = hydrateTitle(t, enrichedMeta);
      const predicted = matchScore(h, idx, enrichedMeta, omdbMeta);
      const actual = t.myRating * 10;
      return { titleKey: t.titleKey, title: h.title, year: h.year, type: h.type, ids: t.ids, myRating: t.myRating, predicted, actual, diff: predicted - actual };
    });
}

// buildWatchRow()/computeWatchStatusRows()/computeCoWatchRows() and the
// rest of the "what is airing and when can I watch it" table-building
// logic — moved here from discover.js (Session 78-ish) so a dedicated
// standalone page (trakt/watch-together.html, a real shareable URL Bill
// asked for so he could send the co-watch table to his wife without
// exposing the rest of his personal recommendation dashboard) can share
// the exact same row-building/rendering code instead of duplicating it —
// the same drift-prevention discipline predictedVsActualRows() above
// already established between Discover and Quality.
// buildWatchRow() is shared with computeCoWatchRows() below (the "Shows
// You Watch Together" table) so both read the exact same status/airing
// logic and can never disagree about what "In Progress" or "Season
// Finale" means for a given title.
function buildWatchRow(titleKey, { inLib, inWl, inCandidate, progress, scored }, enrichedMeta, upcomingSeasons = {}) {
  const base = inLib || inWl || inCandidate || scored || { titleKey, type: titleKey.split(':')[0] };
  const h = hydrateTitle(base, enrichedMeta);

  let status, episodesReady = null;
  if (progress && progress.plays < progress.airedEpisodes) {
    status = 'In Progress'; episodesReady = progress.airedEpisodes - progress.plays;
  } else if (inLib) {
    status = 'Watched';
  } else if (inWl) {
    status = 'Watchlist';
  } else {
    status = 'New Pick';
  }

  const meta = enrichedMeta[titleKey] || {};
  const next = meta.nextEpisodeToAir;
  const finale = meta.currentSeasonFinale;
  let daysUntilFinale = null;
  if (finale?.finaleDate) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    daysUntilFinale = Math.round((new Date(finale.finaleDate + 'T00:00:00') - today) / 86400000);
  }

  return {
    titleKey, title: h.title, year: h.year, type: h.type, ids: h.ids, status,
    episodesReady,
    airedEpisodes: inLib?.airedEpisodes ?? progress?.airedEpisodes ?? null,
    plays: inLib?.plays ?? progress?.plays ?? null,
    myRating: inLib?.myRating ?? null,
    isAiring: isActivelyAiring(h, enrichedMeta),
    season: next?.seasonNumber ?? finale?.seasonNumber ?? null,
    nextEpisode: next?.episodeNumber ?? null,
    nextEpisodeDate: next?.airDate ?? null,
    finaleEpisode: finale?.finaleEpisodeNumber ?? null,
    finaleDate: finale?.finaleDate ?? null,
    daysUntilFinale,
    score: scored ? scored.bmtreScore : null,
    // Real, hand-researched renewal/premiere status for whenever TMDB
    // itself has nothing scheduled yet (see upcomingSeasons.json's own
    // header comment — never guessed, every entry cites real sources).
    upcoming: upcomingSeasons[titleKey] || null,
  };
}

function computeWatchStatusRows(library, watchlist, fromWatchlist, fromCandidates, currentlyWatching, enrichedMeta, upcomingSeasons = {}) {
  const libByKey = new Map((library.titles || []).map(t => [t.titleKey, t]));
  const wlByKey = new Map((watchlist.titles || []).map(t => [t.titleKey, t]));
  // A show can genuinely sit in BOTH currentlyWatching.json and
  // library.json/watchlist.json at once, or be actively airing while also
  // mid-season locally — real Trakt behavior, not a data bug (the same
  // overlap rankAll() already defends against for candidates, Session 48's
  // "Tom Clancy's Jack Ryan" case). Deduped by titleKey below.
  const progressByKey = new Map((currentlyWatching || []).filter(t => t.type === 'show').map(t => [t.titleKey, t]));
  const scoredByKey = new Map([...fromWatchlist, ...fromCandidates].map(c => [c.titleKey, c]));

  // Bill: "'What's Airing & When You Can Watch' should only include shows
  // on my watchlist" — this table is a "when can I actually watch what I'm
  // already planning to" utility, and candidate/library-only rows (a
  // recommendation he hasn't queued, or an airing show he's already fully
  // caught up on with no real reason to track its next episode) were
  // noise, not useful. All 4 detection criteria below still run — they
  // decide the rich status content (in-progress-ness, isAiring, finale
  // dates) — but the final row set is intersected with real watchlist
  // membership, the single source of truth for "am I actually planning to
  // watch this."
  const keys = new Set();
  for (const t of currentlyWatching || []) if (t.type === 'show' && t.plays < t.airedEpisodes) keys.add(t.titleKey);
  for (const t of library.titles || []) if (t.type === 'show' && isActivelyAiring(t, enrichedMeta)) keys.add(t.titleKey);
  for (const t of watchlist.titles || []) if (t.type === 'show' && isActivelyAiring(t, enrichedMeta)) keys.add(t.titleKey);
  for (const c of [...fromWatchlist, ...fromCandidates]) if (isActivelyAiring(c, enrichedMeta)) keys.add(c.titleKey);
  const watchlistOnlyKeys = [...keys].filter(k => wlByKey.has(k));

  return watchlistOnlyKeys.map(titleKey => buildWatchRow(titleKey, {
    inLib: libByKey.get(titleKey), inWl: wlByKey.get(titleKey),
    inCandidate: scoredByKey.get(titleKey)?.origin === 'candidate' ? scoredByKey.get(titleKey) : null,
    progress: progressByKey.get(titleKey), scored: scoredByKey.get(titleKey),
  }, enrichedMeta, upcomingSeasons));
}

// "Shows You Watch Together" — Bill: "I want to manually tag these so
// they only show up here. I still want to see them..." Unlike
// computeWatchStatusRows() above (only rows for something airing/mid-
// season), every tagged title gets a row regardless of status — Bill said
// he still wants to see them, so a tagged show that's fully caught up or
// not yet started still needs to appear, not just the currently-active ones.
function computeCoWatchRows(tagKeys, library, watchlist, candidatePool, fromWatchlist, fromCandidates, currentlyWatching, enrichedMeta, upcomingSeasons = {}) {
  const libByKey = new Map((library.titles || []).map(t => [t.titleKey, t]));
  const wlByKey = new Map((watchlist.titles || []).map(t => [t.titleKey, t]));
  const cpByKey = new Map((candidatePool.titles || []).map(t => [t.titleKey, t]));
  const progressByKey = new Map((currentlyWatching || []).map(t => [t.titleKey, t]));
  const scoredByKey = new Map([...fromWatchlist, ...fromCandidates].map(c => [c.titleKey, c]));
  return tagKeys.map(titleKey => buildWatchRow(titleKey, {
    inLib: libByKey.get(titleKey), inWl: wlByKey.get(titleKey), inCandidate: cpByKey.get(titleKey),
    progress: progressByKey.get(titleKey), scored: scoredByKey.get(titleKey),
  }, enrichedMeta, upcomingSeasons));
}

// Bill: "I still don't love the way this works; make the initial view
// prettier with the cover image; let there be a button to toggle to the
// table view. The pretty view should only show those that are currently
// airing or have completed a season but I haven't watched it yet." Two
// concrete signals from the same row shape buildWatchRow() already
// produces: isAiring (a real episode 1 has aired this season, per Session
// 59's strict definition) OR episodesReady > 0 (aired episodes sitting
// unwatched — the closest available proxy for "a season's out and I
// haven't watched it," since this pipeline only tracks an aggregate
// aired-vs-watched episode count, not per-season completion). A fully
// caught-up ("Watched") or not-yet-started ("Watchlist"/"New Pick") show
// with nothing airing and nothing ready stays out of the pretty view —
// it's still in the table view, unchanged, since Bill's original ask
// ("I still want to see them") for the full list stands.
function isCoWatchReady(row) {
  return row.isAiring || (row.episodesReady ?? 0) > 0;
}

// Airing-and-mid-season rows first (soonest finale first, same priority
// as the table's own default sort), then ready-but-not-airing rows by how
// much is stacked up.
function sortCoWatchReady(rows) {
  return [...rows].sort((a, b) => {
    if (a.isAiring !== b.isAiring) return a.isAiring ? -1 : 1;
    if (a.isAiring) {
      const da = a.daysUntilFinale ?? Infinity, db = b.daysUntilFinale ?? Infinity;
      if (da !== db) return da - db;
    }
    return (b.episodesReady ?? 0) - (a.episodesReady ?? 0);
  });
}

function coWatchCardSubtitle(row) {
  if (row.isAiring && row.episodesReady) {
    return `Airing now · ${row.episodesReady} episode${row.episodesReady === 1 ? '' : 's'} ready`;
  }
  if (row.isAiring) {
    return row.nextEpisodeDate ? `Airing now · next S${row.season}E${row.nextEpisode} on ${row.nextEpisodeDate}` : 'Airing now';
  }
  if (row.episodesReady) {
    return `${row.episodesReady} episode${row.episodesReady === 1 ? '' : 's'} ready to watch`;
  }
  return row.status;
}

function renderCoWatchCards(elementId, rows, enrichedMeta) {
  const el = document.getElementById(elementId);
  const ready = sortCoWatchReady(rows.filter(isCoWatchReady));
  if (!ready.length) {
    el.innerHTML = '<div class="tk-empty">Nothing ready to watch together right now — switch to the table view for the full tagged list.</div>';
    return;
  }
  el.innerHTML = ready.map(r => {
    const poster = posterUrl(r.titleKey, enrichedMeta, 'w154');
    return `
    <a class="tk-shelf-card" href="${esc(traktUrl(r))}" target="_blank" rel="noopener">
      ${posterImgHtml(poster, 'tk-shelf-poster', 92, 138)}
      ${r.score != null ? `<div class="tk-shelf-score">${Math.round(r.score)}</div>` : ''}
      <div class="tk-shelf-title">${esc(r.title)}</div>
      <div class="tk-shelf-runtime">${esc(coWatchCardSubtitle(r))}</div>
    </a>`;
  }).join('');
}

// Button toggles which of the two pre-rendered views (cards / table) is
// visible — both are always rendered by load() above regardless of which
// is showing, so switching is instant with no re-fetch or re-render.
// Wired once per page load, guarded so a stale click handler can't stack
// up if this were ever called twice.
let coWatchToggleWired = false;
function initCoWatchViewToggle() {
  if (coWatchToggleWired) return;
  coWatchToggleWired = true;
  const btn = document.getElementById('coWatchViewToggle');
  const cardsEl = document.getElementById('coWatchCards');
  const tableWrap = document.getElementById('coWatchTableWrap');
  if (!btn || !cardsEl || !tableWrap) return;
  btn.addEventListener('click', () => {
    const switchingToTable = tableWrap.hidden; // currently showing cards
    tableWrap.hidden = !switchingToTable;
    cardsEl.hidden = switchingToTable;
    btn.textContent = switchingToTable ? 'Show card view' : 'Show table view';
  });
}

// Short table-cell label for an upcomingSeasons.json entry — reads the
// entry's own hand-written shortWindow field directly rather than trying
// to pattern-match a date out of the full researched sentence (window):
// a first version did that with a regex and it was a real, live bug — the
// full sentence often mentions OTHER dates in passing (when filming
// started, when filming wrapped) that aren't the premiere date at all,
// or explicitly says a date is a guess, not a confirmed one; the regex
// couldn't tell the difference and surfaced wrong or misleadingly
// confident dates (e.g. reading Ginny & Georgia's "filming wrapped March
// 2026" as if that were the Season 4 premiere, when the real, sourced
// fact is the season was delayed OUT of 2026 entirely). shortWindow is
// hand-picked with full context instead, so this can't happen again.
function summarizeUpcoming(u) {
  if (!u) return '';
  if (u.status === 'canceled') return 'Canceled';
  if (u.status === 'ended') return 'Series ended';
  if (u.status === 'uncertain') return `S${u.season} uncertain`;
  if (u.status === 'unconfirmed') return 'No next season yet';
  return `S${u.season} · ${u.shortWindow}`; // 'renewed'
}
function upcomingSortKey(u) {
  if (!u) return 9;
  return { renewed: 0, uncertain: 1, unconfirmed: 2, canceled: 3, ended: 4 }[u.status] ?? 5;
}

function renderWatchStatusTable(elementId, rows, emptyText) {
  const table = document.getElementById(elementId);
  if (!rows.length) {
    table.parentElement.innerHTML = `<div class="tk-empty">${esc(emptyText)}</div>`;
    return;
  }
  // Bill: "So many of these columns are blank. If the show isn't airing,
  // hide them by default." A row is either mid-season (the 4 airing-
  // schedule columns) or between seasons (the Next Season column) —
  // rarely both — so showing all of them at once left most cells empty.
  // Hidden by default, toggle to reveal; keyed by string id rather than
  // array index so hiding/showing columns can't desync sort tracking
  // from a click on a column that's since moved or disappeared.
  const columns = [
    { key: 'show', label: 'Show', get: r => r.title,
      render: (td, r) => { td.innerHTML = `${typeIcon(r.type)} ${titleLink(r)}${r.year ? ` <span class="tk-metric-sub">(${esc(r.year)})</span>` : ''}`; } },
    { key: 'status', label: 'Status', get: r => r.status,
      render: (td, r) => { td.textContent = r.status + (r.myRating != null ? ` · ${r.myRating}/10` : ''); } },
    { key: 'readyNow', label: 'Ready Now', get: r => r.episodesReady ?? -1, numeric: true,
      render: (td, r) => { td.textContent = r.episodesReady ? `${r.episodesReady} episode${r.episodesReady === 1 ? '' : 's'}` : '—'; } },
    { key: 'nowAiring', label: 'Now Airing', airingCol: true, get: r => (r.season ?? 0) * 1000 + (r.nextEpisode ?? 0), numeric: true,
      render: (td, r) => { td.textContent = r.season != null && r.nextEpisode != null ? `S${r.season}E${r.nextEpisode}` : '—'; } },
    { key: 'nextEpisode', label: 'Next Episode', airingCol: true, get: r => r.nextEpisodeDate || '',
      // Gated on the season actually having a scheduled next episode at
      // all, not on isAiring — isAiring (Session 59's episode-1 fix)
      // deliberately stays false until an episode 1 has actually aired,
      // but a season's premiere/finale dates are often already scheduled
      // before that, and "how soon can I watch it" wants that shown, not
      // hidden behind the stricter airing-badge definition.
      render: (td, r) => { td.textContent = r.season != null ? (r.nextEpisodeDate || 'TBD') : '—'; } },
    { key: 'seasonFinale', label: 'Season Finale', airingCol: true, get: r => r.finaleDate || (r.finaleEpisode ? '9999-99-99' : ''),
      render: (td, r) => {
        if (r.finaleDate) td.textContent = `${r.finaleDate} (S${r.season}E${r.finaleEpisode})`;
        else if (r.finaleEpisode) td.textContent = `TBD (S${r.season}E${r.finaleEpisode})`;
        else td.textContent = r.season != null ? 'Unknown' : '—';
      } },
    { key: 'daysUntilFinale', label: 'Days Until Finale', airingCol: true, get: r => r.daysUntilFinale ?? Infinity, numeric: true,
      render: (td, r) => {
        td.className = 'num';
        td.textContent = r.daysUntilFinale == null ? '—' : (r.daysUntilFinale <= 0 ? 'Airs today' : `${r.daysUntilFinale}d`);
      } },
    // Bill: "Shows You Watch Together data is incomplete. Do online
    // research and see which ones have a new season coming." TMDB's
    // nextEpisodeToAir/currentSeasonFinale (the columns above) only ever
    // exist once a season is actually scheduled — a show that's renewed
    // but not yet dated, or canceled, is otherwise invisible. Reads
    // upcomingSeasons.json (real, hand-researched, sourced — see that
    // file's own header comment), never guessed.
    { key: 'nextSeason', label: 'Next Season', get: r => upcomingSortKey(r.upcoming),
      render: (td, r) => {
        const label = summarizeUpcoming(r.upcoming);
        if (!label) { td.textContent = '—'; return; }
        td.textContent = label;
        if (r.upcoming?.window) td.title = `${r.upcoming.window}\n\nSource: ${r.upcoming.source}`;
      } },
    { key: 'score', label: 'Score', get: r => r.score ?? -1, numeric: true,
      render: (td, r) => { td.className = 'num'; td.textContent = r.score != null ? Math.round(r.score) : '—'; } },
  ];

  let sortKey = 'daysUntilFinale', sortAsc = true; // default: soonest finale first, even while that column is hidden
  let showAiringCols = false; // hidden by default per Bill's ask

  // The toggle is a real DOM sibling inserted once, not rebuilt on every
  // render() (unlike thead/tbody below) — rebuilding it would drop the
  // checkbox's own state/focus on every sort click.
  let toolbar = table.parentElement.querySelector('.tk-watch-toolbar');
  if (!toolbar) {
    toolbar = document.createElement('label');
    toolbar.className = 'tk-watch-toolbar';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => { showAiringCols = cb.checked; render(); });
    toolbar.appendChild(cb);
    toolbar.appendChild(document.createTextNode(' Show airing-schedule columns (Now Airing, Next Episode, Season Finale, Days Until Finale)'));
    table.parentElement.insertBefore(toolbar, table);
  }

  function render() {
    const visibleColumns = columns.filter(c => showAiringCols || !c.airingCol);

    const sorted = [...rows].sort((a, b) => {
      const col = columns.find(c => c.key === sortKey);
      const va = col.get(a), vb = col.get(b);
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortAsc ? cmp : -cmp;
    });

    table.innerHTML = '';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    visibleColumns.forEach(c => {
      const th = document.createElement('th');
      th.textContent = c.label;
      if (c.key === sortKey) th.className = 'sorted' + (sortAsc ? ' asc' : '');
      th.addEventListener('click', () => {
        if (sortKey === c.key) sortAsc = !sortAsc; else { sortKey = c.key; sortAsc = true; }
        render();
      });
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of sorted) {
      const tr = document.createElement('tr');
      visibleColumns.forEach(c => {
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


export {
  esc, fmtNum, posterImgHtml, typeIcon, typeLabel, titleLink, STATUS_META, statusTag,
  airingBadge, svgEl, renderHBarChart, LOVED_THRESHOLD, computeGenreStats, SUBGENRE_LABEL,
  displaySubgenre, SUBJECT_LABEL, ERA_LABEL, tableToCSV, downloadCSV, fmtCompact, metaLine,
  scoreTier, initCollapsibleCards, loadAllData, predictedVsActualRows,
  buildWatchRow, computeWatchStatusRows, computeCoWatchRows, isCoWatchReady, sortCoWatchReady,
  coWatchCardSubtitle, renderCoWatchCards, initCoWatchViewToggle, summarizeUpcoming,
  upcomingSortKey, renderWatchStatusTable,
};
