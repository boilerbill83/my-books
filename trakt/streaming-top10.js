// The Streaming Top 10 — a weekly, editorial "what matters on TV right
// now" list, per Bill's detailed brief (2026-09-25): a modern replacement
// for The Ringer's old Weekly Top 10. Explicitly NOT personalized to Bill
// or driven by BMTRE's scoring engine for RANKING purposes — a general-
// audience feature about the wider TV landscape, built from real research
// committed as data in trakt/data/streamingTop10.json.
//
// Follow-up round the same day added Bill's OWN data on top of the
// editorial content: status (Watched/Watchlist/etc., same lookup every
// other page in this app already does), a real predicted BMTRE score per
// title (rankAll()'s own idx/matchScore(), the exact mechanism the You'll
// Love panels use — just applied here for display, not for re-ranking
// this list, which stays editorially ordered), genre/subgenre/subject
// tags (inferGenre()/inferSubgenres()/inferSubjects(), same as every
// other title-metadata surface), and a real click-through to the title's
// actual Trakt page (traktUrl()) wherever Bill's own export has a real
// slug for it — a title he's never watched/watchlisted correctly falls
// back to a Trakt search instead of a guessed link, same as everywhere
// else in this app.
import { esc, posterImgHtml, initCollapsibleCards, STATUS_META, statusTag, SUBJECT_LABEL, displaySubgenre, loadAllData, computeFavoriteStars } from './dashboardShared.js';
import { posterUrl, hydrateTitle, traktUrl, rankAll, matchScore, inferGenre, inferSubgenres, inferSubjects } from './engine.js';

// ESTABLISHED deliberately does NOT use a star emoji (Bill, 2026-09-26:
// "why does dancing with the stars have a gold star?") — a real, confusing
// visual collision with the unrelated gold-star Trakt-favorite indicator
// used elsewhere in this app (computeFavoriteStars(), Discover's My Next
// Watch). That confusion resolved, Bill's very next ask ("Reacher should
// have a good star") was for the REAL thing: this page's cards now also
// carry the actual gold-star favorite badge (computeFavoriteStars() —
// real Trakt favorite flags ∪ manualStars.json) wherever a card's title
// is genuinely one of Bill's favorites, same visual language as My Next
// Watch's badge, just placed on this page's own poster shape.
const TAG_META = {
  HOT: { emoji: '🔥', cssVar: '--status-critical' },
  RISING: { emoji: '📈', cssVar: '--status-warning' },
  BUZZY: { emoji: '💬', cssVar: '--accent-warm' },
  ESTABLISHED: { emoji: '🛡️', cssVar: '--status-good' },
  'UNDER-THE-RADAR': { emoji: '🔎', cssVar: '--text-muted' },
};

const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

// Finds the real record for a titleKey across Bill's own 3 real Trakt-
// derived lists, same precedence every other page in this app already
// uses (library beats watchlist beats candidatePool — a title can
// genuinely sit in more than one, per the real Tires/Lowdown overlap
// this project has hit before).
function findOwnRecord(titleKey, library, watchlist, candidatePool) {
  let raw = (library.titles || []).find(t => t.titleKey === titleKey);
  if (raw) return { raw, status: raw.completionStatus === 'in-progress' ? 'New Episodes' : 'Watched' };
  raw = (watchlist.titles || []).find(t => t.titleKey === titleKey);
  if (raw) return { raw, status: 'Watchlist' };
  raw = (candidatePool.titles || []).find(t => t.titleKey === titleKey);
  if (raw) return { raw, status: 'Candidate' };
  return { raw: null, status: null };
}

// A titleKey Bill has never personally watched/watchlisted/discovered has
// no entry in any of the 3 lists above at all — genuinely different from
// "Dismissed" (which means he actively said no), so it gets its own
// honest, undramatic label rather than being forced into an existing
// status that doesn't fit. Used both as the plain-text status (for the
// filter dropdown) and, via statusTagHtml(), as the rendered badge.
const NOT_TRACKED_LABEL = 'Not on your Trakt';

function statusTagHtml(label) {
  return label === NOT_TRACKED_LABEL
    ? `<span class="tk-status-tag st10-status-untracked">${esc(label)}</span>`
    : statusTag(label);
}

function enrichShow(show, ctx) {
  const { library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags, reviewedTags, idx, feedback, starredSet } = ctx;
  const titleKey = show.titleKey;
  const meta = titleKey ? enrichedMeta[titleKey] : null;
  const type = titleKey ? titleKey.split(':')[0] : (show.type || 'show');

  let statusLabel = NOT_TRACKED_LABEL;
  let ids = null;
  let predictedScore = null;
  let genreLabel = null;
  let subgenreLabels = [];
  let subjectLabels = [];
  const starred = titleKey ? starredSet.has(titleKey) : false;

  if (titleKey) {
    const { raw, status } = findOwnRecord(titleKey, library, watchlist, candidatePool);
    ids = raw?.ids || null;
    // idx.excluded lumps a real taste dismissal in with a category_exclude
    // (e.g. this show's own titleKey, which this same feature adds as a
    // category_exclude so it never leaks into the solo You'll Love flow —
    // see the family-watch-list precedent). Only a genuine dismiss
    // interaction should ever read as "Dismissed" here; a category_exclude
    // just falls through to its real library/watchlist/candidatePool status.
    const isRealDismiss = (feedback?.interactions || []).some(
      e => e.titleKey === titleKey && e.interactionType === 'dismiss'
    );
    if (isRealDismiss) statusLabel = 'Dismissed';
    else if (status) statusLabel = status;

    if (meta) {
      predictedScore = Math.round(matchScore({ type, titleKey }, idx, enrichedMeta, omdbMeta));
      genreLabel = cap(inferGenre(meta, llmTags[titleKey], reviewedTags[titleKey]));
      subgenreLabels = inferSubgenres(meta, llmTags[titleKey], 2, reviewedTags[titleKey]).map(s => displaySubgenre(s, meta));
      subjectLabels = inferSubjects(meta, llmTags[titleKey], 2, reviewedTags[titleKey]).map(s => SUBJECT_LABEL[s] || s);
    }
  }

  const traktCandidate = hydrateTitle({ type, titleKey, ids, title: show.title }, enrichedMeta);
  const poster = titleKey ? posterUrl(titleKey, enrichedMeta, 'w342') : null;

  return { ...show, type, statusLabel, predictedScore, genreLabel, subgenreLabels, subjectLabels, traktLink: traktUrl(traktCandidate), poster, starred };
}

// displayRank is the show's position in the CURRENT filtered/backfilled
// view (always 1-10), which can differ from show.rank (its real position
// in this week's full researched pool) once a checkbox filter reorders
// things — shown as the "Top 10" position the page's own name promises,
// while each card's status badge still honestly reflects why a
// filtered-out-category show ended up here (backfill).
function renderShow(show, displayRank) {
  const tag = TAG_META[show.tag] || { emoji: '', cssVar: '--text' };
  const metaBits = [show.genreLabel, ...show.subgenreLabels, ...show.subjectLabels].filter(Boolean);
  const scoreHtml = show.predictedScore != null
    ? `<div class="st10-score"><div class="st10-score-num">${show.predictedScore}</div><div class="st10-score-label">predicted score</div></div>`
    : `<div class="st10-score st10-score-empty">not enough data yet</div>`;
  const starHtml = show.starred ? '<div class="tk-star-badge" title="One of your real Trakt favorites">★</div>' : '';
  return `
  <article class="st10-card">
    <div class="st10-rank">#${displayRank}</div>
    <div class="st10-poster${show.starred ? ' st10-poster-starred' : ''}">
      ${starHtml}
      ${posterImgHtml(show.poster, 'st10-poster-img', 120, 180)}
    </div>
    <div class="st10-body">
      <div class="st10-head-row">
        <div>
          <div class="st10-title-row">
            <a class="st10-title" href="${esc(show.traktLink)}" target="_blank" rel="noopener">${esc(show.title)}</a>
            <span class="st10-tag" style="color:var(${tag.cssVar})">${tag.emoji} ${esc(show.tag)}</span>
          </div>
          <div class="st10-platform-row">
            <span class="st10-platform">${esc(show.platform)}</span>
            ${statusTagHtml(show.statusLabel)}
          </div>
          ${metaBits.length ? `<div class="st10-metabits">${metaBits.map(esc).join(' · ')}</div>` : ''}
        </div>
        ${scoreHtml}
      </div>
      <div class="st10-section"><span class="st10-label">Why it's here</span>${esc(show.whyHere)}</div>
      <div class="st10-section"><span class="st10-label">Why watch</span>${esc(show.whyWatch)}</div>
      <div class="st10-section"><span class="st10-label">Vibe</span>${esc(show.vibe)}</div>
      <div class="st10-commitment">${esc(show.commitment)}</div>
    </div>
  </article>`;
}

async function load() {
  const [data, { library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, llmTags, reviewedTags, bookThemeCounts, manualStars }] =
    await Promise.all([
      fetch('./data/streamingTop10.json').then(r => r.json()),
      loadAllData(),
    ]);

  const weekOf = new Date(data.weekOf + 'T00:00:00Z');
  document.getElementById('weekOfText').textContent =
    `Week of ${weekOf.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  document.getElementById('methodologyText').textContent = data.methodology;
  document.getElementById('statusText').textContent = 'Loaded';

  const { idx } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags, bookThemeCounts);
  const starredSet = computeFavoriteStars(library, watchlist, manualStars);
  const ctx = { library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags, reviewedTags, idx, feedback, starredSet };

  const shows = data.shows.map(s => enrichShow(s, ctx)).sort((a, b) => a.rank - b.rank);
  const TARGET_COUNT = 10;

  // Status checkboxes — per Bill's request (2026-09-26: "make the filter
  // a checkbox so I can choose what to include; it should always show 10
  // shows"). This week's real researched pool is intentionally larger
  // than 10 (see refresh_streaming_top10.py) specifically so a narrowed
  // checkbox selection has real material to backfill from — the display
  // is always exactly 10 real, already-researched shows, never fewer,
  // never a placeholder. Options are built live from whatever statuses
  // this week's real pool actually carries (never hardcoded), so a status
  // with zero matches this week just doesn't appear as a choice.
  const listEl = document.getElementById('top10List');
  const emptyEl = document.getElementById('st10EmptyMsg');
  const countEl = document.getElementById('st10FilterCount');
  const filterEl = document.getElementById('st10StatusFilter');

  const statusCounts = new Map();
  for (const s of shows) statusCounts.set(s.statusLabel, (statusCounts.get(s.statusLabel) || 0) + 1);
  // A fixed display order (rather than alphabetical or count-sorted) so
  // the checkboxes read the same way every week even as which statuses
  // are present changes.
  const STATUS_ORDER = ['Watched', 'New Episodes', 'Watchlist', 'Candidate', 'Dismissed', NOT_TRACKED_LABEL];
  const presentStatuses = STATUS_ORDER.filter(s => statusCounts.has(s));

  filterEl.innerHTML = presentStatuses.map(s => `
    <label class="st10-checkbox-label">
      <input type="checkbox" value="${esc(s)}" checked>
      ${esc(s)} (${statusCounts.get(s)})
    </label>`).join('');

  function renderFiltered() {
    const checked = new Set([...filterEl.querySelectorAll('input:checked')].map(cb => cb.value));
    const matching = shows.filter(s => checked.has(s.statusLabel));
    // Bill (2026-09-26): unchecking a status must actually remove those
    // shows — a real bug found live: unchecking "Candidate" still left
    // one Candidate-status show on screen, silently pulled back in as a
    // "backfill" from the very category being excluded. Fixed: an
    // unchecked category is never shown, full stop, no exceptions. The
    // only backfill that still happens is pulling in MORE real matches
    // from further down this week's ranked list (already-checked
    // categories only) when the top 10 alone doesn't fill 10 slots —
    // e.g. unchecking "Watched" still shows up to 10 real non-Watched
    // shows, reaching past the original top-10 cutoff if needed.
    //
    // The one deliberate exception: if EVERY box is unchecked, that's a
    // meaningless filter state (not "exclude everything"), so it falls
    // back to the unfiltered full list rather than showing a blank page.
    const allUnchecked = checked.size === 0;
    const visible = allUnchecked ? shows.slice(0, TARGET_COUNT) : matching.slice(0, TARGET_COUNT);
    listEl.innerHTML = visible.map((s, i) => renderShow(s, i + 1)).join('');
    emptyEl.hidden = visible.length > 0;
    if (allUnchecked) {
      countEl.textContent = `No filter selected — showing the full top ${TARGET_COUNT} instead.`;
    } else if (checked.size === presentStatuses.length) {
      countEl.textContent = '';
    } else if (matching.length >= TARGET_COUNT) {
      countEl.textContent = '';
    } else if (matching.length === 0) {
      countEl.textContent = `Nothing this week matches your filter.`;
    } else {
      countEl.textContent = `Only ${matching.length} show${matching.length === 1 ? '' : 's'} this week match${matching.length === 1 ? 'es' : ''} your filter.`;
    }
  }

  filterEl.addEventListener('change', renderFiltered);
  renderFiltered();

  initCollapsibleCards();
}

load();
