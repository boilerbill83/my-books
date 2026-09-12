// Shows We Watch Together — a dedicated, shareable page (Bill: "generate a
// unique URL to that table so I can send it to my wife," then "do your
// best to improve the page... make it fancy and informative... make it
// clear when a show has been completed and is ready to watch... put
// Furious at the top"). Reuses computeCoWatchRows() from dashboardShared.js
// (the exact same row data the Discover page's co-watch section uses, so
// the two can never disagree) but renders it with its own richer,
// page-specific card design instead of the compact shelf-card/table pair —
// this page's whole purpose is being the nice one to hand someone else.
import {
  loadAllData, computeCoWatchRows, esc, typeIcon, posterImgHtml, metaLine,
  renderWatchStatusTable,
} from './dashboardShared.js';
import { traktUrl, posterUrl } from './engine.js';

const PINNED_KEY = 'movie:1280738'; // "The Furious" — Bill: "put Furious at the top"

function genreChips(meta) {
  const genres = (meta?.genres || []).slice(0, 3);
  if (!genres.length) return '';
  return `<div class="wt-chips">${genres.map(g => `<span class="wt-chip">${esc(g)}</span>`).join('')}</div>`;
}

function ratingBadges(row, meta, omdbEntry) {
  const parts = [];
  if (row.myRating != null) parts.push(`<span class="wt-badge wt-badge-rating">★ ${row.myRating}/10 (us)</span>`);
  if (meta?.voteAverage != null) parts.push(`<span class="wt-badge wt-badge-tmdb">TMDB ${meta.voteAverage.toFixed(1)}</span>`);
  const rated = omdbEntry?.rated;
  if (rated && rated !== 'N/A') parts.push(`<span class="wt-badge wt-badge-rated">${esc(rated)}</span>`);
  const network = meta?.networks?.[0];
  if (network) parts.push(`<span class="wt-badge wt-badge-network">${esc(network)}</span>`);
  return parts.length ? `<div class="wt-badges">${parts.join('')}</div>` : '';
}

// The heart of Bill's ask: make it unmistakable whether a season has
// wrapped and is sitting there ready to watch, is still actively airing
// (more episodes coming), or everything aired so far has already been
// watched. isAiring (real episode-1-has-aired-this-season) and
// episodesReady (aired-minus-watched) together fully answer this — no new
// data needed, just a clearer read of what buildWatchRow() already computes.
function readiness(row) {
  if (row.type === 'movie') {
    return row.status === 'Watched'
      ? { tier: 'caughtUp', label: '✓ Watched', cls: 'wt-status-caughtup' }
      : { tier: 'notStarted', label: '🎬 Not Started Yet', cls: 'wt-status-pinned' };
  }
  const ready = row.episodesReady ?? 0;
  if (ready > 0 && !row.isAiring) {
    return { tier: 'readyToBinge', label: `✅ Season Complete — ${ready} Episode${ready === 1 ? '' : 's'} Ready`, cls: 'wt-status-ready' };
  }
  if (row.isAiring) {
    const readyPart = ready > 0 ? `, ${ready} ready` : '';
    return { tier: 'airingNow', label: `📡 Airing Now${readyPart}`, cls: 'wt-status-airing' };
  }
  if (row.status === 'In Progress' || row.status === 'Watched') {
    return { tier: 'caughtUp', label: '⏳ Caught Up', cls: 'wt-status-caughtup' };
  }
  return { tier: 'notStarted', label: '🆕 Not Started Yet', cls: 'wt-status-pinned' };
}

function upcomingText(row) {
  const u = row.upcoming;
  if (!u) return null;
  if (u.status === 'canceled') return 'Canceled — no more seasons coming';
  if (u.status === 'ended') return 'Series ended';
  if (u.status === 'uncertain') return `Season ${u.season} status uncertain`;
  if (u.status === 'unconfirmed') return 'No next season confirmed yet';
  return `Season ${u.season} — ${u.window || u.shortWindow}`;
}

function finaleText(row) {
  if (!row.isAiring) return null;
  if (row.daysUntilFinale == null) return row.nextEpisodeDate ? `Next episode: ${row.nextEpisodeDate}` : null;
  if (row.daysUntilFinale <= 0) return 'Season finale airs today';
  return `${row.daysUntilFinale} day${row.daysUntilFinale === 1 ? '' : 's'} until the season finale`;
}

function renderCard(row, enrichedMeta, omdbMeta, llmTags, reviewedTags, { big = false } = {}) {
  const meta = enrichedMeta[row.titleKey];
  const omdbEntry = omdbMeta?.[row.titleKey];
  const poster = posterUrl(row.titleKey, enrichedMeta, big ? 'w342' : 'w185');
  const r = readiness(row);
  const overview = meta?.overview ? (meta.overview.length > 220 ? meta.overview.slice(0, 219) + '…' : meta.overview) : '';
  const upcoming = upcomingText(row);
  const finale = finaleText(row);

  return `
    <a class="wt-card ${big ? 'wt-card-big' : ''}" href="${esc(traktUrl(row))}" target="_blank" rel="noopener">
      ${posterImgHtml(poster, 'wt-poster' + (big ? ' wt-poster-big' : ''), big ? 130 : 92, big ? 195 : 138)}
      <div class="wt-card-body">
        <div class="wt-status-pill ${r.cls}">${r.label}</div>
        <div class="wt-card-title">${typeIcon(row.type)} ${esc(row.title)} ${row.year ? `<span class="wt-year">(${esc(row.year)})</span>` : ''}</div>
        ${genreChips(meta)}
        ${ratingBadges(row, meta, omdbEntry)}
        <div class="wt-extra">${metaLine(row, enrichedMeta, omdbMeta, llmTags, reviewedTags)}</div>
        ${overview ? `<div class="wt-overview">${esc(overview)}</div>` : ''}
        ${finale ? `<div class="wt-note wt-note-airing">🕐 ${esc(finale)}</div>` : ''}
        ${upcoming ? `<div class="wt-note">📅 ${esc(upcoming)}</div>` : ''}
      </div>
    </a>`;
}

function renderSection(id, rows, enrichedMeta, omdbMeta, llmTags, reviewedTags) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!rows.length) { el.closest('.wt-section')?.setAttribute('hidden', ''); return; }
  el.innerHTML = rows.map(row => renderCard(row, enrichedMeta, omdbMeta, llmTags, reviewedTags)).join('');
}

async function load() {
  const statusEl = document.getElementById('statusText');
  const subtitleEl = document.getElementById('subtitleText');
  try {
    const { library, watchlist, candidatePool, enrichedMeta, omdbMeta,
            llmTags, reviewedTags, currentlyWatching, coWatchTags, upcomingSeasons } = await loadAllData();

    const coWatchKeys = [...new Set(Object.values(coWatchTags || {}).flat())];
    if (!coWatchKeys.length) {
      document.getElementById('wtRoot').innerHTML = '<div class="tk-card"><div class="tk-empty">Nothing tagged yet.</div></div>';
      statusEl.textContent = 'Ready';
      return;
    }

    const coWatchRows = computeCoWatchRows(coWatchKeys, library, watchlist, candidatePool, [], [], currentlyWatching, enrichedMeta, upcomingSeasons);
    const byKey = new Map(coWatchRows.map(r => [r.titleKey, r]));

    const pinned = byKey.get(PINNED_KEY);
    const rest = coWatchRows.filter(r => r.titleKey !== PINNED_KEY);

    const tiers = { readyToBinge: [], airingNow: [], caughtUp: [], notStarted: [] };
    for (const row of rest) tiers[readiness(row).tier].push(row);

    // Within each tier, most-actionable/soonest first.
    tiers.readyToBinge.sort((a, b) => (b.episodesReady ?? 0) - (a.episodesReady ?? 0));
    tiers.airingNow.sort((a, b) => (a.daysUntilFinale ?? Infinity) - (b.daysUntilFinale ?? Infinity));
    tiers.caughtUp.sort((a, b) => (b.myRating ?? 0) - (a.myRating ?? 0));

    if (pinned) {
      document.getElementById('wtPinnedSection').innerHTML = renderCard(pinned, enrichedMeta, omdbMeta, llmTags, reviewedTags, { big: true });
    } else {
      document.getElementById('wtPinnedSection').closest('.wt-section')?.setAttribute('hidden', '');
    }

    renderSection('wtReadySection', tiers.readyToBinge, enrichedMeta, omdbMeta, llmTags, reviewedTags);
    renderSection('wtAiringSection', tiers.airingNow, enrichedMeta, omdbMeta, llmTags, reviewedTags);
    renderSection('wtCaughtUpSection', tiers.caughtUp, enrichedMeta, omdbMeta, llmTags, reviewedTags);
    renderSection('wtNotStartedSection', tiers.notStarted, enrichedMeta, omdbMeta, llmTags, reviewedTags);

    // Stat strip.
    document.getElementById('wtStatReady').textContent = tiers.readyToBinge.length;
    document.getElementById('wtStatAiring').textContent = tiers.airingNow.length;
    document.getElementById('wtStatCaughtUp').textContent = tiers.caughtUp.length;
    document.getElementById('wtStatTotal').textContent = coWatchRows.length;

    // Full-list table stays available for anyone who wants every column.
    renderWatchStatusTable('wtFullTable', coWatchRows, 'Nothing tagged yet.');

    statusEl.textContent = 'Ready';
    const readyCount = tiers.readyToBinge.length + (pinned ? 1 : 0);
    subtitleEl.textContent = `${coWatchRows.length} shows tagged — ${readyCount} ready to watch right now.`;
  } catch (err) {
    statusEl.textContent = 'Failed to load — see console.';
    console.error(err);
  }
}

function initFullListToggle() {
  const btn = document.getElementById('wtFullListToggle');
  const wrap = document.getElementById('wtFullListWrap');
  if (!btn || !wrap) return;
  btn.addEventListener('click', () => {
    const showing = !wrap.hidden;
    wrap.hidden = showing;
    btn.textContent = showing ? 'Show full list' : 'Hide full list';
  });
}

initFullListToggle();
load();
