// Shows We Watch Together — a dedicated, minimal, shareable page (Bill:
// "generate a unique URL to that table so I can send it to my wife").
// The co-watch table already lives on the main Discover page, but that
// page also shows Bill's personal ratings/stats/recommendations — not
// something to hand someone else a link to. This page renders ONLY the
// co-watch section, reusing the exact same row-building/rendering
// functions dashboardShared.js exports (moved there from discover.js for
// exactly this reason) so the two views of the same data can never
// disagree.
import {
  loadAllData, computeCoWatchRows, renderCoWatchCards, initCoWatchViewToggle,
  renderWatchStatusTable,
} from './dashboardShared.js';

async function load() {
  const statusEl = document.getElementById('statusText');
  const subtitleEl = document.getElementById('subtitleText');
  try {
    const { library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta,
            llmTags, reviewedTags, currentlyWatching, coWatchTags, upcomingSeasons,
            bookThemeCounts } = await loadAllData();

    const coWatchKeys = [...new Set(Object.values(coWatchTags || {}).flat())];
    if (!coWatchKeys.length) {
      document.querySelector('.tk-card').innerHTML = '<div class="tk-empty">Nothing tagged yet.</div>';
      statusEl.textContent = 'Ready';
      return;
    }

    // fromWatchlist/fromCandidates (real predicted scores) aren't needed
    // for this page's own purpose — scores would just be noise on a page
    // meant for "what's ready, what's next," not "should we watch this
    // one." Passing empty arrays is a safe, real no-op: buildWatchRow()
    // already falls back cleanly to library/watchlist/candidatePool data
    // when `scored` is undefined.
    const coWatchRows = computeCoWatchRows(coWatchKeys, library, watchlist, candidatePool, [], [], currentlyWatching, enrichedMeta, upcomingSeasons);

    renderCoWatchCards('coWatchCards', coWatchRows, enrichedMeta);
    renderWatchStatusTable('coWatchTable', coWatchRows, 'Nothing tagged yet.');
    initCoWatchViewToggle();

    statusEl.textContent = 'Ready';
    subtitleEl.textContent = `${coWatchKeys.length} show${coWatchKeys.length === 1 ? '' : 's'} tagged — what's ready to watch right now, and what's coming up next.`;
  } catch (err) {
    statusEl.textContent = 'Failed to load — see console.';
    console.error(err);
  }
}

load();
