// Deep Dive — Bill's explicit request: a button on every "You'll Love"
// card that opens a dedicated page showing ALL metadata for that title
// plus a full, real breakdown of why it scored what it did (not just the
// one-line reason() summary the rec card already shows). Self-contained
// module (doesn't import discover.js/quality.js — those each run their own
// load() at the bottom and expect a completely different set of page
// elements to exist, so importing either here would throw) — same
// convention recommend.js already follows for the same reason.
import {
  rankAll, hydrateTitle, matchScorePair, confidenceScore, reason, scoreBreakdown,
  isActivelyAiring, posterUrl, criticScore, realAudienceScore, awardsScore,
  mergeScrapedShowRatings, resolveSimilarTitles, resolveSimilarDirectors,
  getCreators, inferSubgenres, inferTones, inferSubjects, inferEra, traktUrl,
  resolveCastAges,
} from './engine.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const typeIcon = t => t === 'movie' ? '🎬' : '📺';
const titleCaseTag = s => String(s ?? '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const fmtNum = n => n == null ? '—' : n.toLocaleString();
const fmtPts = n => (n > 0 ? '+' : '') + (Math.round(n * 100) / 100);
const ptsClass = n => n > 0.001 ? 'dd-pts-pos' : n < -0.001 ? 'dd-pts-neg' : 'dd-pts-zero';

function chips(values, cls = 'dd-chip') {
  if (!values || !values.length) return '<span class="dd-empty">none</span>';
  return values.map(v => `<span class="${cls}">${esc(titleCaseTag(v))}</span>`).join('');
}

async function load() {
  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  const statusEl = document.getElementById('statusText');
  const content = document.getElementById('ddContent');

  if (!key) {
    content.innerHTML = '<div class="dd-empty-page">No title specified. Go back to <a href="./index.html">Discover</a> and click "Deep Dive" on a title.</div>';
    statusEl.textContent = 'No title';
    return;
  }

  const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  const [library, watchlist, candidatePool, enrichedMeta, omdbMetaRaw, feedback, scrapedShowRatings, llmTags, reviewedTags, personMeta] = await Promise.all([
    get('./data/library.json').catch(() => ({ titles: [] })),
    get('./data/watchlist.json').catch(() => ({ titles: [] })),
    get('./data/candidatePool.json').catch(() => ({ titles: [] })),
    get('./data/enrichedMetadata.json').catch(() => ({})),
    get('./data/omdbMetadata.json').catch(() => ({})),
    get('./data/feedbackData.json').catch(() => ({ interactions: [] })),
    get('./data/scrapedShowRatings.json').catch(() => ({})),
    get('./data/llmTags.json').catch(() => ({})),
    get('./data/reviewedTags.json').catch(() => ({})),
    get('./data/personMetadata.json').catch(() => ({})),
  ]);
  const omdbMeta = mergeScrapedShowRatings(omdbMetaRaw, scrapedShowRatings);

  let raw = library.titles.find(t => t.titleKey === key);
  let status = 'Watched';
  if (!raw) { raw = watchlist.titles.find(t => t.titleKey === key); status = 'Watchlist'; }
  if (!raw) { raw = candidatePool.titles.find(t => t.titleKey === key); status = 'Candidate'; }

  if (!raw) {
    content.innerHTML = `<div class="dd-empty-page">Couldn't find <code>${esc(key)}</code> in your library, watchlist, or candidate pool.</div>`;
    statusEl.textContent = 'Not found';
    return;
  }

  const { idx } = rankAll(library, watchlist, candidatePool, enrichedMeta, feedback, omdbMeta, llmTags, reviewedTags);
  const candidate = hydrateTitle(raw, enrichedMeta);
  const meta = enrichedMeta[key] || {};
  const omdbEntry = omdbMeta[key];
  const { raw: rawScore, clamped } = matchScorePair(candidate, idx, enrichedMeta, omdbMeta);
  const conf = confidenceScore(candidate, enrichedMeta);
  const why = reason(candidate, idx, enrichedMeta, omdbMeta);
  const breakdown = scoreBreakdown(candidate, idx, enrichedMeta, omdbMeta);
  const airing = isActivelyAiring(candidate, enrichedMeta);
  const poster = posterUrl(key, enrichedMeta, 'w342');
  const crit = criticScore(omdbEntry);
  const aud = realAudienceScore(omdbEntry);
  const awd = awardsScore(omdbEntry);
  const similarTitles = resolveSimilarTitles(meta, candidate.type, enrichedMeta, 8);
  const similarDirectors = resolveSimilarDirectors(meta, candidate.type, enrichedMeta, 5);
  const creators = getCreators(candidate.type, meta);
  const subgenres = inferSubgenres(meta, llmTags[key], undefined, reviewedTags?.[key]);
  const tones = inferTones(meta, llmTags[key], undefined, reviewedTags?.[key]);
  const subjects = inferSubjects(meta, llmTags[key], undefined, reviewedTags?.[key]);
  const era = inferEra(meta, undefined, reviewedTags?.[key]);
  const myRating = status === 'Watched' ? raw.myRating : null;
  const castAges = resolveCastAges(candidate, enrichedMeta, personMeta);

  document.title = `Deep Dive — ${candidate.title || key}`;
  statusEl.textContent = `${candidate.type === 'movie' ? 'Movie' : 'TV Show'} · ${status}`;

  const statusTagCls = { Watched: 'dd-status-watched', Watchlist: 'dd-status-watchlist', Candidate: 'dd-status-candidate' }[status] || '';

  const idsRow = [`<a href="${esc(traktUrl(candidate))}" target="_blank" rel="noopener">Trakt ↗</a>`];
  if (meta.imdbId) idsRow.push(`<a href="https://www.imdb.com/title/${esc(meta.imdbId)}/" target="_blank" rel="noopener">IMDb ↗</a>`);
  if (raw.ids?.tmdb != null) {
    const tmdbKind = candidate.type === 'movie' ? 'movie' : 'tv';
    idsRow.push(`<a href="https://www.themoviedb.org/${tmdbKind}/${esc(raw.ids.tmdb)}" target="_blank" rel="noopener">TMDB ↗</a>`);
  }

  content.innerHTML = `
    <div class="dd-hero">
      ${poster ? `<img class="dd-poster" src="${esc(poster)}" alt="" loading="lazy">` : '<div class="dd-poster dd-poster-empty"></div>'}
      <div class="dd-hero-body">
        <div class="dd-hero-title">
          ${typeIcon(candidate.type)} ${esc(candidate.title)}${candidate.year ? ` <span class="dd-year">(${esc(candidate.year)})</span>` : ''}
        </div>
        <div class="dd-hero-tags">
          <span class="dd-status-tag ${statusTagCls}">${esc(status)}</span>
          ${airing ? '<span class="dd-status-tag dd-status-airing">🕐 Airing</span>' : ''}
          ${myRating != null ? `<span class="dd-status-tag dd-status-rated">Your rating: ${esc(myRating)}/10</span>` : ''}
        </div>
        <div class="dd-hero-reason">${esc(why)}</div>
        <div class="dd-hero-ids">${idsRow.join(' · ') || ''}</div>
      </div>
      <div class="dd-hero-scores">
        <div class="dd-score-big">${Math.round(clamped)}</div>
        <div class="dd-score-label">predicted score</div>
        <div class="dd-score-sub">confidence ${Math.round(conf)}</div>
        ${Math.round(rawScore) !== Math.round(clamped) ? `<div class="dd-score-sub">real (unclamped): ${Math.round(rawScore)}</div>` : ''}
      </div>
    </div>

    <div class="dd-card">
      <div class="dd-card-heading">📐 Score Breakdown</div>
      <div class="dd-card-note">Every row below calls the exact same function the real ranking engine uses — these numbers are guaranteed to sum to the real score above, not a re-derived approximation.</div>
      <div class="dd-breakdown">
        ${breakdown.rows.map(r => `
          <div class="dd-breakdown-row">
            <span class="dd-breakdown-label">${esc(r.label)}</span>
            <span class="dd-breakdown-note">${esc(r.note)}</span>
            <span class="dd-breakdown-pts ${ptsClass(r.points)}">${fmtPts(r.points)}</span>
          </div>`).join('')}
        <div class="dd-breakdown-row dd-breakdown-total">
          <span class="dd-breakdown-label">Total (raw)</span>
          <span class="dd-breakdown-note">Clamped to 0–100 for display: ${Math.round(clamped)}</span>
          <span class="dd-breakdown-pts">${Math.round(breakdown.raw * 100) / 100}</span>
        </div>
      </div>
    </div>

    <div class="dd-grid2">
      <div class="dd-card">
        <div class="dd-card-heading">🏷️ Taxonomy</div>
        <div class="dd-field"><span class="dd-field-label">TMDB Genres</span><div>${chips(meta.genres)}</div></div>
        <div class="dd-field"><span class="dd-field-label">Subgenres</span><div>${chips(subgenres)}</div></div>
        <div class="dd-field"><span class="dd-field-label">Tones</span><div>${chips(tones)}</div></div>
        <div class="dd-field"><span class="dd-field-label">Subjects</span><div>${chips(subjects)}</div></div>
        <div class="dd-field"><span class="dd-field-label">Era</span><div>${chips(era)}</div></div>
        <div class="dd-field"><span class="dd-field-label">Keywords</span><div>${chips(meta.keywords)}</div></div>
      </div>

      <div class="dd-card">
        <div class="dd-card-heading">👥 People</div>
        <div class="dd-field"><span class="dd-field-label">${candidate.type === 'movie' ? 'Director(s)' : 'Creator(s)'}</span><div>${chips(creators)}</div></div>
        <div class="dd-field">
          <span class="dd-field-label">Top Cast, by billing order — age at release</span>
          <div>${castAges.length ? castAges.map(c => `
            <span class="dd-chip" title="Billing position ${c.position + 1}">${esc(c.name)}${c.age != null ? ` (${c.age})` : ''}</span>
          `).join('') : chips(meta.topCast)}</div>
        </div>
        ${meta.belongsToCollection ? `<div class="dd-field"><span class="dd-field-label">Franchise</span><div>${esc(meta.belongsToCollection.name)}</div></div>` : ''}
      </div>
    </div>

    <div class="dd-grid2">
      <div class="dd-card">
        <div class="dd-card-heading">📊 Ratings &amp; Popularity</div>
        <div class="dd-field-row"><span class="dd-field-label">TMDB Rating</span><span>${meta.voteAverage != null ? meta.voteAverage.toFixed(1) + '/10' : '—'} (${fmtNum(meta.voteCount)} votes)</span></div>
        <div class="dd-field-row"><span class="dd-field-label">TMDB Popularity</span><span>${meta.popularity != null ? meta.popularity.toFixed(1) : '—'}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">IMDb Rating</span><span>${omdbEntry?.imdbRating != null ? omdbEntry.imdbRating + '/10' : '—'} (${fmtNum(omdbEntry?.imdbVotes)} votes)</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Rotten Tomatoes (Critic)</span><span>${omdbEntry?.rottenTomatoes != null ? omdbEntry.rottenTomatoes + '/100' : '—'}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Metacritic (Critic)</span><span>${omdbEntry?.metacritic != null ? omdbEntry.metacritic + '/100' : '—'}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">RT Audience / MC User</span><span>${omdbEntry?.rtAudience ?? '—'} / ${omdbEntry?.metacriticUser ?? '—'}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Blended Critic Score</span><span>${crit != null ? crit + '/100' : '—'}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Blended Audience Score</span><span>${aud != null ? aud + '/100' : '—'}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Awards Score</span><span>${awd != null ? awd + '/100' : '—'}</span></div>
        <div class="dd-field"><span class="dd-field-label">Awards (raw)</span><div>${esc(omdbEntry?.awards?.raw || 'No awards data.')}</div></div>
      </div>

      <div class="dd-card">
        <div class="dd-card-heading">📅 Release / Airing</div>
        <div class="dd-field-row"><span class="dd-field-label">Release / First Air Date</span><span>${esc(meta.releaseDate || meta.firstAirDate || '—')}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Runtime</span><span>${meta.runtime ? meta.runtime + ' min' : meta.episodeRunTime ? meta.episodeRunTime + ' min/episode' : '—'}</span></div>
        ${candidate.type === 'show' ? `
        <div class="dd-field-row"><span class="dd-field-label">Status</span><span>${esc(meta.status || '—')}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Seasons / Episodes</span><span>${meta.numberOfSeasons ?? '—'} / ${meta.numberOfEpisodes ?? '—'}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Next Episode</span><span>${meta.nextEpisodeToAir ? `S${meta.nextEpisodeToAir.seasonNumber}E${meta.nextEpisodeToAir.episodeNumber} — ${esc(meta.nextEpisodeToAir.airDate || '?')}` : 'None scheduled'}</span></div>
        ` : ''}
        <div class="dd-field-row"><span class="dd-field-label">Original Language</span><span>${esc(meta.originalLanguage || '—')}</span></div>
        <div class="dd-field-row"><span class="dd-field-label">Enriched</span><span>${esc(meta.fetchedAt || 'not yet')}</span></div>
      </div>
    </div>

    <div class="dd-card">
      <div class="dd-card-heading">📝 Overview</div>
      <div class="dd-overview">${esc(meta.overview) || '<span class="dd-empty">No overview available.</span>'}</div>
    </div>

    <div class="dd-grid2">
      <div class="dd-card">
        <div class="dd-card-heading">🔗 Similar Titles (TMDB)</div>
        ${similarTitles.length ? `<div class="dd-simple-list">${similarTitles.map(s => `
          <div class="dd-metric-row">
            <a href="./deepdive.html?key=${encodeURIComponent(s.titleKey)}">${esc(s.title)}${s.year ? ` (${esc(s.year)})` : ''}</a>
            ${idx.lovedTitles.has(s.titleKey) ? '<span class="dd-chip dd-chip-loved">loved</span>' : ''}
          </div>`).join('')}</div>` : '<div class="dd-empty">No similar-title data.</div>'}
      </div>
      <div class="dd-card">
        <div class="dd-card-heading">🎬 Similar ${candidate.type === 'movie' ? 'Directors' : 'Creators'}</div>
        ${similarDirectors.length ? `<div class="dd-simple-list">${similarDirectors.map(d => `
          <div class="dd-metric-row"><span>${esc(d.name)}</span><span class="dd-metric-score">${d.count} shared cite${d.count === 1 ? '' : 's'}</span></div>`).join('')}</div>`
          : '<div class="dd-empty">No corroborated similar-creator data (needs 2+ shared citations).</div>'}
      </div>
    </div>
  `;
}

load().catch(err => {
  document.getElementById('statusText').textContent = 'Failed to load — see console.';
  document.getElementById('ddContent').innerHTML = '<div class="dd-empty-page">Something went wrong loading this title. See the browser console for details.</div>';
  console.error(err);
});
