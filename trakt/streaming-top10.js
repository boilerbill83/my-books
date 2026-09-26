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
import { esc, posterImgHtml, initCollapsibleCards, STATUS_META, statusTag, SUBJECT_LABEL, displaySubgenre, loadAllData } from './dashboardShared.js';
import { posterUrl, hydrateTitle, traktUrl, rankAll, matchScore, inferGenre, inferSubgenres, inferSubjects } from './engine.js';

const TAG_META = {
  HOT: { emoji: '🔥', cssVar: '--status-critical' },
  RISING: { emoji: '📈', cssVar: '--status-warning' },
  BUZZY: { emoji: '💬', cssVar: '--accent-warm' },
  ESTABLISHED: { emoji: '⭐', cssVar: '--status-good' },
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
  const { library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags, reviewedTags, idx, feedback } = ctx;
  const titleKey = show.titleKey;
  const meta = titleKey ? enrichedMeta[titleKey] : null;
  const type = titleKey ? titleKey.split(':')[0] : (show.type || 'show');

  let statusLabel = NOT_TRACKED_LABEL;
  let ids = null;
  let predictedScore = null;
  let genreLabel = null;
  let subgenreLabels = [];
  let subjectLabels = [];

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

  return { ...show, type, statusLabel, predictedScore, genreLabel, subgenreLabels, subjectLabels, traktLink: traktUrl(traktCandidate), poster };
}

function renderShow(show) {
  const tag = TAG_META[show.tag] || { emoji: '', cssVar: '--text' };
  const metaBits = [show.genreLabel, ...show.subgenreLabels, ...show.subjectLabels].filter(Boolean);
  const scoreHtml = show.predictedScore != null
    ? `<div class="st10-score"><div class="st10-score-num">${show.predictedScore}</div><div class="st10-score-label">predicted score</div></div>`
    : `<div class="st10-score st10-score-empty">not enough data yet</div>`;
  return `
  <article class="st10-card">
    <div class="st10-rank">#${show.rank}</div>
    <div class="st10-poster">${posterImgHtml(show.poster, 'st10-poster-img', 120, 180)}</div>
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
  const [data, { library, watchlist, candidatePool, enrichedMeta, omdbMeta, feedback, llmTags, reviewedTags, bookThemeCounts }] =
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
  const ctx = { library, watchlist, candidatePool, enrichedMeta, omdbMeta, llmTags, reviewedTags, idx, feedback };

  const shows = data.shows.map(s => enrichShow(s, ctx));

  // Status filter — per Bill's request. Options are built live from
  // whatever statuses this week's real 10 shows actually carry (never a
  // hardcoded list), so a status with zero matches this week (e.g.
  // "Dismissed") simply doesn't appear as a choice at all.
  const listEl = document.getElementById('top10List');
  const emptyEl = document.getElementById('st10EmptyMsg');
  const countEl = document.getElementById('st10FilterCount');
  const filterEl = document.getElementById('st10StatusFilter');

  const statusCounts = new Map();
  for (const s of shows) statusCounts.set(s.statusLabel, (statusCounts.get(s.statusLabel) || 0) + 1);
  // A fixed display order (rather than alphabetical or count-sorted) so
  // the dropdown reads the same way every week even as which statuses
  // are present changes.
  const STATUS_ORDER = ['Watched', 'New Episodes', 'Watchlist', 'Candidate', 'Dismissed', NOT_TRACKED_LABEL];
  const presentStatuses = STATUS_ORDER.filter(s => statusCounts.has(s));

  filterEl.innerHTML = `<option value="">All statuses (${shows.length})</option>` +
    presentStatuses.map(s => `<option value="${esc(s)}">${esc(s)} (${statusCounts.get(s)})</option>`).join('');

  function renderFiltered() {
    const chosen = filterEl.value;
    const visible = chosen ? shows.filter(s => s.statusLabel === chosen) : shows;
    listEl.innerHTML = visible.map(renderShow).join('');
    emptyEl.hidden = visible.length > 0;
    countEl.textContent = chosen ? `Showing ${visible.length} of ${shows.length}` : '';
  }

  filterEl.addEventListener('change', renderFiltered);
  renderFiltered();

  initCollapsibleCards();
}

load();
