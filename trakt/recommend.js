import { rankRecommendations, mergeScrapedShowRatings, traktUrl } from './engine.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

async function load() {
  const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  const [library, watchlist, enrichedMeta, feedback, omdbMetaRaw, scrapedShowRatings, llmTags] = await Promise.all([
    get('./data/library.json').catch(() => ({ titles: [] })),
    get('./data/watchlist.json').catch(() => ({ titles: [] })),
    get('./data/enrichedMetadata.json').catch(() => ({})),
    get('./data/feedbackData.json').catch(() => ({ interactions: [] })),
    get('./data/omdbMetadata.json').catch(() => ({})),
    get('./data/scrapedShowRatings.json').catch(() => ({})),
    get('./data/llmTags.json').catch(() => ({})),
  ]);
  const omdbMeta = mergeScrapedShowRatings(omdbMetaRaw, scrapedShowRatings);

  const enrichedCount = Object.keys(enrichedMeta).length;
  document.getElementById('subtitleText').textContent =
    `${watchlist.titles?.length || 0} watchlist titles · ${enrichedCount} enriched with TMDB data`;
  document.getElementById('statusText').textContent = 'Scored';

  const { selected } = rankRecommendations(library, watchlist, enrichedMeta, feedback, omdbMeta, llmTags);

  const el = document.getElementById('recList');
  if (!selected.length) {
    el.innerHTML = '<div class="rc-empty">Nothing on the watchlist yet.</div>';
    return;
  }

  el.innerHTML = selected.map((c, i) => `
    <div class="rc-card">
      <div class="rc-rank">${i + 1}</div>
      <div class="rc-body">
        <div class="rc-row-title">
          <a class="rc-trakt-link" href="${esc(traktUrl(c))}" target="_blank" rel="noopener">${esc(c.title)}</a>${c.year ? ` <span class="rc-year">(${esc(c.year)})</span>` : ''}
          <span class="rc-badge">${c.type === 'movie' ? 'Movie' : 'Show'}</span>
        </div>
        <div class="rc-reason">${esc(c.reason)}</div>
      </div>
      <div class="rc-scores">
        <div class="rc-score">${Math.round(c.bmtreScore)}</div>
        <div class="rc-conf">confidence ${Math.round(c.confidenceScore)}</div>
      </div>
    </div>
  `).join('');
}

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load — see console.';
  document.getElementById('subtitleText').textContent = '';
  console.error(err);
});
