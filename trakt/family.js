// Family Watch List — a dedicated URL (Bill: "build a new URL for this
// too and make that clickable when I click the section title, do the
// same thing for shows we watch together since we already have a URL for
// that"). Reuses renderFamilyWatchList()/renderLovedMovies() from
// dashboardShared.js verbatim — the exact same want-to-watch data and
// card rendering the Discover page's own Family Watch List card already
// uses, so the two pages can never disagree about what's on the list,
// the same drift-prevention discipline every other shared render
// function in this project follows.
import { loadAllData, renderFamilyWatchList, renderLovedMovies } from './dashboardShared.js';

async function load() {
  const { enrichedMeta, familyWatchlist } = await loadAllData();

  document.getElementById('statusText').textContent = 'Loaded from export';

  renderFamilyWatchList(familyWatchlist, enrichedMeta, 'familyWatchList');

  // Bill: "you can hide these from the UI unless I press a button to show
  // them." Rendered immediately (not deferred to first click) so the
  // toggle is instant — same "always render, just toggle `hidden`"
  // pattern watch-together.js's own full-list toggle already uses.
  renderLovedMovies(familyWatchlist, enrichedMeta, 'lovedMovies');
  const lovedSection = document.getElementById('lovedMovies');
  const lovedToggle = document.getElementById('lovedToggle');
  lovedToggle.addEventListener('click', () => {
    const nowHidden = !lovedSection.hidden;
    lovedSection.hidden = nowHidden;
    lovedToggle.textContent = nowHidden ? "Show movies we've loved" : "Hide movies we've loved";
  });
}

load();
