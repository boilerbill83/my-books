// The Streaming Top 10 — a weekly, editorial "what matters on TV right
// now" list, per Bill's detailed brief (2026-09-25): a modern replacement
// for The Ringer's old Weekly Top 10. Explicitly NOT personalized to Bill
// or driven by BMTRE's scoring engine — a general-audience feature about
// the wider TV landscape, built from real research (Nielsen, JustWatch,
// entertainment press, Emmy coverage) committed as data in
// trakt/data/streamingTop10.json. See that file's own "note" field for
// why this doesn't auto-refresh: Nielsen/JustWatch have no free public API
// a static site could call, so a fresh week means asking Claude to
// re-research and rebuild it, the same pattern upcomingSeasons.json/
// familyWatchlist.json already use for "real but not live" data.
import { esc, posterImgHtml, initCollapsibleCards } from './dashboardShared.js';
import { posterUrl } from './engine.js';

const TAG_META = {
  HOT: { emoji: '🔥', cssVar: '--status-critical' },
  RISING: { emoji: '📈', cssVar: '--status-warning' },
  BUZZY: { emoji: '💬', cssVar: '--accent-warm' },
  ESTABLISHED: { emoji: '⭐', cssVar: '--status-good' },
  'UNDER-THE-RADAR': { emoji: '🔎', cssVar: '--text-muted' },
};

function renderShow(show, enrichedMeta) {
  const poster = show.titleKey ? posterUrl(show.titleKey, enrichedMeta, 'w342') : null;
  const tag = TAG_META[show.tag] || { emoji: '', cssVar: '--text' };
  const sourcesHtml = (show.sources || [])
    .map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`)
    .join(' · ');
  return `
  <article class="st10-card">
    <div class="st10-rank">#${show.rank}</div>
    <div class="st10-poster">${posterImgHtml(poster, 'st10-poster-img', 120, 180)}</div>
    <div class="st10-body">
      <div class="st10-title-row">
        <span class="st10-title">${esc(show.title)}</span>
        <span class="st10-tag" style="color:var(${tag.cssVar})">${tag.emoji} ${esc(show.tag)}</span>
      </div>
      <div class="st10-platform">${esc(show.platform)}</div>
      <div class="st10-section"><span class="st10-label">Why it's here</span>${esc(show.whyHere)}</div>
      <div class="st10-section"><span class="st10-label">Why watch</span>${esc(show.whyWatch)}</div>
      <div class="st10-section"><span class="st10-label">Vibe</span>${esc(show.vibe)}</div>
      <div class="st10-commitment">${esc(show.commitment)}</div>
      ${sourcesHtml ? `<div class="st10-sources">Sources: ${sourcesHtml}</div>` : ''}
    </div>
  </article>`;
}

async function load() {
  const get = url => fetch(url).then(r => r.json());
  const [data, enrichedMeta] = await Promise.all([
    get('./data/streamingTop10.json'),
    get('./data/enrichedMetadata.json').catch(() => ({})),
  ]);

  const weekOf = new Date(data.weekOf + 'T00:00:00Z');
  document.getElementById('weekOfText').textContent =
    `Week of ${weekOf.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  document.getElementById('methodologyText').textContent = data.methodology;
  document.getElementById('statusText').textContent = 'Loaded';

  document.getElementById('top10List').innerHTML = data.shows.map(s => renderShow(s, enrichedMeta)).join('');

  initCollapsibleCards();
}

load();
