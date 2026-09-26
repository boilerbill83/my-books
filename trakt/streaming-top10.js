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
//
// A second follow-up round (Bill, 2026-09-26, "any other ideas... implement
// all four") added: (1) real week-over-week rank-delta badges, sourced from
// the same streamingTop10Previous.json snapshot notify_streaming_top10.py
// diffs against; (2) a platform checkbox filter alongside the existing
// status one; (3) a one-line "N of this week's shows are already your
// favorites" summary, reusing computeFavoriteStars(); (4) a local-only
// "Not interested" quick-dismiss per card.
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

// Local-only "Not interested" dismissals (Bill, 2026-09-26). Same
// localStorage-then-copy-to-commit pattern app.js's copyFeedbackBtn already
// established on the book side (LOCAL_FEEDBACK_KEY there, 'mybooks_
// feedback_v1') — this is a STAGING layer only. Clicking the button hides
// the card immediately on this device (via dismissedTitles below) and
// queues a real feedbackData.json-shaped interaction object for Bill to
// hand to Claude and commit for real, same as the book side's flow — it
// never writes to the committed file itself (a static page can't), and it
// never marks the card's status badge "Dismissed" (that stays reserved
// for a genuine committed interaction, checked separately in enrichShow).
const LOCAL_DISMISS_KEY = 'st10_local_dismissals_v1';

function loadLocalDismissals() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_DISMISS_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveLocalDismissals(list) {
  try { localStorage.setItem(LOCAL_DISMISS_KEY, JSON.stringify(list)); }
  catch { /* private browsing / storage full — dismissals last this page load only */ }
}

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

// Real week-over-week movement, sourced from streamingTop10Previous.json
// (a snapshot refresh_streaming_top10.py writes of the prior week's list
// right before each weekly overwrite — the same file notify_streaming_
// top10.py diffs against for the Tuesday text alert, so the page and the
// text can never disagree about what changed). prevRankByTitle is null
// when no snapshot exists yet at all (the very first tracked week) —
// distinct from a title genuinely being new THIS week once history does
// exist, so those two states render differently below.
function computeRankDelta(show, prevRankByTitle) {
  if (!prevRankByTitle) return null;
  if (!prevRankByTitle.has(show.title)) return 'NEW';
  return prevRankByTitle.get(show.title) - show.rank; // positive = moved up (toward #1)
}

function rankDeltaHtml(rankDelta) {
  if (rankDelta === null || rankDelta === undefined || rankDelta === 0) return '';
  if (rankDelta === 'NEW') return `<div class="st10-rank-delta st10-rank-new" title="New to this week's researched pool">NEW</div>`;
  const up = rankDelta > 0;
  return `<div class="st10-rank-delta ${up ? 'st10-rank-up' : 'st10-rank-down'}" title="${up ? 'Moved up' : 'Moved down'} ${Math.abs(rankDelta)} spot${Math.abs(rankDelta) === 1 ? '' : 's'} since last week">${up ? '↑' : '↓'}${Math.abs(rankDelta)}</div>`;
}

function enrichShow(show, ctx) {
  const { library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags, reviewedTags, idx, feedback, starredSet, prevRankByTitle } = ctx;
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
  const rankDelta = computeRankDelta(show, prevRankByTitle);

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
  const year = meta?.year ?? null;

  return { ...show, type, statusLabel, predictedScore, genreLabel, subgenreLabels, subjectLabels, traktLink: traktUrl(traktCandidate), poster, starred, rankDelta, year };
}

// displayRank is the show's position in the CURRENT filtered/backfilled
// view (always 1-10), which can differ from show.rank (its real position
// in this week's full researched pool) once a checkbox filter reorders
// things — shown as the "Top 10" position the page's own name promises,
// while each card's status badge still honestly reflects why a
// filtered-out-category show ended up here (backfill). The rank-delta
// badge next to it, by contrast, always reflects the show's real editorial
// rank movement (show.rank, not displayRank) — the same number the
// Tuesday text alert's "MOVED" line would report, regardless of how the
// page happens to be filtered right now.
function renderShow(show, displayRank) {
  const tag = TAG_META[show.tag] || { emoji: '', cssVar: '--text' };
  const metaBits = [show.genreLabel, ...show.subgenreLabels, ...show.subjectLabels].filter(Boolean);
  const scoreHtml = show.predictedScore != null
    ? `<div class="st10-score"><div class="st10-score-num">${show.predictedScore}</div><div class="st10-score-label">predicted score</div></div>`
    : `<div class="st10-score st10-score-empty">not enough data yet</div>`;
  const starHtml = show.starred ? '<div class="tk-star-badge" title="One of your real Trakt favorites">★</div>' : '';
  return `
  <article class="st10-card">
    <button class="st10-dismiss-btn" data-title="${esc(show.title)}" title="Not interested — hide this from your view">✕</button>
    <div class="st10-rank">#${displayRank}${rankDeltaHtml(show.rankDelta)}</div>
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

// Builds one checkbox-filter group (status or platform) — shared so the
// two groups can't drift into two subtly different implementations.
function buildCheckboxGroup(el, counts, order) {
  const keys = order ? order.filter(k => counts.has(k)) : [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  el.innerHTML = keys.map(k => `
    <label class="st10-checkbox-label">
      <input type="checkbox" value="${esc(k)}" checked>
      ${esc(k)} (${counts.get(k)})
    </label>`).join('');
  return keys;
}

async function load() {
  const [data, prevData, { library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, llmTags, reviewedTags, bookThemeCounts, manualStars }] =
    await Promise.all([
      fetch('./data/streamingTop10.json').then(r => r.json()),
      fetch('./data/streamingTop10Previous.json').then(r => r.ok ? r.json() : null).catch(() => null),
      loadAllData(),
    ]);

  const weekOf = new Date(data.weekOf + 'T00:00:00Z');
  document.getElementById('weekOfText').textContent =
    `Week of ${weekOf.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  document.getElementById('methodologyText').textContent = data.methodology;
  document.getElementById('statusText').textContent = 'Loaded';

  const { idx } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags, bookThemeCounts);
  const starredSet = computeFavoriteStars(library, watchlist, manualStars);
  const prevRankByTitle = prevData ? new Map(prevData.shows.map(s => [s.title, s.rank])) : null;
  const ctx = { library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags, reviewedTags, idx, feedback, starredSet, prevRankByTitle };

  const shows = data.shows.map(s => enrichShow(s, ctx)).sort((a, b) => a.rank - b.rank);
  const TARGET_COUNT = 10;

  // "N of this week's shows are already your favorites" (Bill, 2026-09-26,
  // the direct follow-up to the earlier real-star-badge fix) — a one-line
  // summary over the FULL real researched pool (not just what's currently
  // visible under a filter), since this is a fact about this week's
  // editorial slate as a whole, the same "whole-week overview" scope the
  // checkbox counts below already use.
  const favoritesEl = document.getElementById('st10FavoritesSummary');
  const starredThisWeek = shows.filter(s => s.starred);
  if (starredThisWeek.length) {
    favoritesEl.hidden = false;
    favoritesEl.innerHTML = `★ ${starredThisWeek.length} of this week's ${shows.length} shows ${starredThisWeek.length === 1 ? 'is' : 'are'} already among your favorites: ${starredThisWeek.map(s => esc(s.title)).join(', ')}.`;
  } else {
    favoritesEl.hidden = true;
  }

  // Status + platform checkboxes — per Bill's requests (2026-09-26: "make
  // the filter a checkbox so I can choose what to include; it should
  // always show 10 shows", then "any other ideas... implement all four"
  // → a platform filter, since this week's real pool already spans 8
  // distinct services). This week's real researched pool is intentionally
  // larger than 10 (see refresh_streaming_top10.py) specifically so a
  // narrowed selection has real material to backfill from — the display
  // is always exactly 10 real, already-researched shows, never fewer,
  // never a placeholder. Options are built live from whatever statuses/
  // platforms this week's real pool actually carries (never hardcoded),
  // so a value with zero matches this week just doesn't appear as a
  // choice.
  const listEl = document.getElementById('top10List');
  const emptyEl = document.getElementById('st10EmptyMsg');
  const countEl = document.getElementById('st10FilterCount');
  const statusFilterEl = document.getElementById('st10StatusFilter');
  const platformFilterEl = document.getElementById('st10PlatformFilter');
  const dismissStatusEl = document.getElementById('st10DismissStatus');
  const dismissCountEl = document.getElementById('st10DismissCount');

  const statusCounts = new Map();
  const platformCounts = new Map();
  for (const s of shows) {
    statusCounts.set(s.statusLabel, (statusCounts.get(s.statusLabel) || 0) + 1);
    platformCounts.set(s.platform, (platformCounts.get(s.platform) || 0) + 1);
  }
  // A fixed display order for status (rather than alphabetical or
  // count-sorted) so the checkboxes read the same way every week even as
  // which statuses are present changes; platform has no such natural
  // order, so buildCheckboxGroup falls back to count-desc there.
  const STATUS_ORDER = ['Watched', 'New Episodes', 'Watchlist', 'Candidate', 'Dismissed', NOT_TRACKED_LABEL];
  buildCheckboxGroup(statusFilterEl, statusCounts, STATUS_ORDER);
  buildCheckboxGroup(platformFilterEl, platformCounts, null);

  // Local "Not interested" dismissals (Bill, 2026-09-26). dismissedTitles
  // is the live, in-memory source of truth for what's hidden this session
  // — seeded from localStorage on load, added to on every dismiss click,
  // and reset by "Clear". Kept as a Set of titles (this page's own
  // established identity key throughout, e.g. the rank-delta lookup
  // above) rather than titleKey, since a not-yet-resolved stub has none.
  let localDismissals = loadLocalDismissals();
  const dismissedTitles = new Set(localDismissals.map(d => d.title));

  function refreshDismissStatus() {
    if (!localDismissals.length) {
      dismissStatusEl.hidden = true;
      return;
    }
    dismissStatusEl.hidden = false;
    dismissCountEl.textContent = `✕ ${localDismissals.length} dismissed locally this session (not yet committed) — `;
  }

  function dismissShow(title) {
    if (dismissedTitles.has(title)) return;
    const show = shows.find(s => s.title === title);
    if (!show) return;
    dismissedTitles.add(title);
    localDismissals.push({
      titleKey: show.titleKey || null,
      title: show.title,
      year: show.year ?? null,
      type: show.type,
      interactionType: 'dismiss',
      reasonCode: 'not_interested',
      reasonLabel: 'Not interested (dismissed from The Streaming Top 10 page)',
      timestamp: new Date().toISOString(),
      excludeFromRecommendations: true,
    });
    saveLocalDismissals(localDismissals);
    refreshDismissStatus();
    renderFiltered();
  }

  function clearLocalDismissals() {
    localDismissals = [];
    dismissedTitles.clear();
    saveLocalDismissals(localDismissals);
    refreshDismissStatus();
    renderFiltered();
  }

  document.getElementById('st10CopyDismissedBtn').addEventListener('click', async () => {
    const json = JSON.stringify({ interactions: localDismissals }, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      document.getElementById('statusText').textContent = 'Dismissals copied — paste into a chat with Claude to commit them to feedbackData.json.';
    } catch {
      document.getElementById('statusText').textContent = 'Clipboard unavailable — check browser permissions.';
    }
  });
  document.getElementById('st10ClearDismissedBtn').addEventListener('click', clearLocalDismissals);
  listEl.addEventListener('click', e => {
    const btn = e.target.closest('.st10-dismiss-btn');
    if (btn) dismissShow(btn.dataset.title);
  });

  function renderFiltered() {
    const checkedStatuses = new Set([...statusFilterEl.querySelectorAll('input:checked')].map(cb => cb.value));
    const checkedPlatforms = new Set([...platformFilterEl.querySelectorAll('input:checked')].map(cb => cb.value));
    // Bill (2026-09-26): unchecking a status must actually remove those
    // shows — a real bug found live: unchecking "Candidate" still left
    // one Candidate-status show on screen, silently pulled back in as a
    // "backfill" from the very category being excluded. Fixed: an
    // unchecked category is never shown, full stop, no exceptions. The
    // only backfill that still happens is pulling in MORE real matches
    // from further down this week's ranked list (already-checked
    // categories/platforms only, and never a locally-dismissed title)
    // when the top 10 alone doesn't fill 10 slots.
    //
    // Each filter GROUP independently treats "every box in this group
    // unchecked" as "no restriction from this group" (matches
    // everything) rather than "exclude everything" — the same degenerate-
    // state handling the original single-filter version had, now applied
    // per group so status and platform can't interfere with each other.
    const matching = shows.filter(s =>
      !dismissedTitles.has(s.title) &&
      (checkedStatuses.size === 0 || checkedStatuses.has(s.statusLabel)) &&
      (checkedPlatforms.size === 0 || checkedPlatforms.has(s.platform))
    );
    const visible = matching.slice(0, TARGET_COUNT);
    listEl.innerHTML = visible.map((s, i) => renderShow(s, i + 1)).join('');
    emptyEl.hidden = visible.length > 0;
    if (matching.length >= TARGET_COUNT || matching.length === shows.length - dismissedTitles.size) {
      countEl.textContent = '';
    } else if (matching.length === 0) {
      countEl.textContent = `Nothing this week matches your filters.`;
    } else {
      countEl.textContent = `Only ${matching.length} show${matching.length === 1 ? '' : 's'} this week match${matching.length === 1 ? 'es' : ''} your filters.`;
    }
  }

  statusFilterEl.addEventListener('change', renderFiltered);
  platformFilterEl.addEventListener('change', renderFiltered);
  refreshDismissStatus();
  renderFiltered();

  initCollapsibleCards();
}

load();
