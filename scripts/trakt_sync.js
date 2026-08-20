#!/usr/bin/env node
// Uploads data/moviesWatched.json → Trakt history and data/movieWatchlist.json
// → Trakt watchlist. Run from repo root: node scripts/trakt_sync.js [--dry-run]
//
// Auth: OAuth device-code flow (no redirect URI / web server needed — you
// authorize by visiting a short URL on any device and entering a code).
// Requires a free Trakt API app (trakt.tv/oauth/applications) — see
// CLAUDE.md's "Movie Tracking (Trakt)" section for the walkthrough.
//
// Credentials come from TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET env vars —
// never commit them. The resulting access/refresh token is cached in
// .trakt-token.json (gitignored) so you don't need to re-authorize every run.
//
// Movies are matched to Trakt via GET /search/movie?query=<title>&years=<year>
// (exact title+year match required — ambiguous or no-match titles are left
// unsynced and reported at the end, never guessed). Successfully synced
// entries get traktIds/traktSyncedAt written back into the local data files
// so re-runs are incremental and idempotent.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOKEN_PATH = path.join(ROOT, '.trakt-token.json');
const WATCHED_PATH = path.join(ROOT, 'data', 'moviesWatched.json');
const WATCHLIST_PATH = path.join(ROOT, 'data', 'movieWatchlist.json');

const DRY_RUN = process.argv.includes('--dry-run');
const API = 'https://api.trakt.tv';

const CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Missing TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET.\n' +
    'Create a free API app at https://trakt.tv/oauth/applications, then run:\n' +
    '  export TRAKT_CLIENT_ID=your_client_id\n' +
    '  export TRAKT_CLIENT_SECRET=your_client_secret\n' +
    '  node scripts/trakt_sync.js\n' +
    '(or source them from a local file outside the repo, same convention as the GitHub PAT in CLAUDE.md).'
  );
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

async function traktFetch(pathname, { method = 'GET', body, token, auth = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID,
  };
  if (auth) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

// ── Auth: device code flow + refresh ────────────────────────────────────

async function deviceAuth() {
  const codeRes = await traktFetch('/oauth/device/code', {
    method: 'POST', body: { client_id: CLIENT_ID },
  });
  if (!codeRes.ok) throw new Error(`Device code request failed: ${codeRes.status}`);
  const { device_code, user_code, verification_url, interval, expires_in } = await codeRes.json();

  console.log(`\nGo to ${verification_url} and enter this code: ${user_code}\n`);
  console.log('Waiting for authorization…');

  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep((interval || 5) * 1000);
    const tokenRes = await traktFetch('/oauth/device/token', {
      method: 'POST',
      body: { code: device_code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    });
    if (tokenRes.status === 200) {
      const token = await tokenRes.json();
      console.log('Authorized!\n');
      return token;
    }
    if (tokenRes.status === 400) continue;               // still pending
    if (tokenRes.status === 429) { await sleep(2000); continue; } // slow down
    if ([404, 409, 410, 418].includes(tokenRes.status)) {
      throw new Error(`Device auth failed (${tokenRes.status}) — code invalid, already used, expired, or denied.`);
    }
    throw new Error(`Unexpected device token response: ${tokenRes.status}`);
  }
  throw new Error('Device authorization timed out — run again and re-enter the code promptly.');
}

async function refreshToken(cached) {
  const res = await traktFetch('/oauth/token', {
    method: 'POST',
    body: {
      refresh_token: cached.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getAccessToken() {
  let cached = readJSON(TOKEN_PATH, null);
  const now = Date.now();

  if (cached && cached.obtained_at + cached.expires_in * 1000 > now + 60_000) {
    return cached.access_token;
  }
  if (cached?.refresh_token) {
    const refreshed = await refreshToken(cached);
    if (refreshed) {
      refreshed.obtained_at = now;
      writeJSON(TOKEN_PATH, refreshed);
      return refreshed.access_token;
    }
    console.log('Refresh token expired/invalid — re-authorizing…');
  }

  const token = await deviceAuth();
  token.obtained_at = now;
  writeJSON(TOKEN_PATH, token);
  return token.access_token;
}

// ── Search resolution ────────────────────────────────────────────────────

async function resolveMovie(title, year) {
  const params = new URLSearchParams({ query: title });
  if (year) params.set('years', String(year));
  const res = await traktFetch(`/search/movie?${params.toString()}`);
  if (!res.ok) return { status: 'error', detail: `search ${res.status}` };
  const results = await res.json();
  if (!results.length) return { status: 'no_match' };

  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const exact = results.filter(r =>
    norm(r.movie.title) === norm(title) && (!year || r.movie.year === year)
  );
  if (exact.length === 1) return { status: 'matched', movie: exact[0].movie };
  if (results.length === 1 && !year) return { status: 'matched', movie: results[0].movie };
  return { status: 'ambiguous', count: results.length };
}

// ── Sync ─────────────────────────────────────────────────────────────────

async function resolveIds(entries, label) {
  const unresolved = [];
  for (const m of entries) {
    if (m.traktIds) continue;
    const result = await resolveMovie(m.title, m.year);
    await sleep(300); // be polite to the search endpoint
    if (result.status === 'matched') {
      m.traktIds = result.movie.ids;
      console.log(`  ✓ resolved: ${m.title}${m.year ? ` (${m.year})` : ''}`);
    } else {
      unresolved.push({ ...m, reason: result.status, detail: result.detail || result.count });
      console.log(`  ✗ ${result.status}: ${m.title}${m.year ? ` (${m.year})` : ''}`);
    }
  }
  if (unresolved.length) {
    console.log(`\n${unresolved.length} ${label} movie(s) need manual review (no confident Trakt match):`);
    unresolved.forEach(m => console.log(`  - ${m.title}${m.year ? ` (${m.year})` : ''} — ${m.reason}`));
  }
  return unresolved;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function syncHistory(token, entries) {
  const toSync = entries.filter(m => m.traktIds && !m.traktSyncedAt);
  if (!toSync.length) { console.log('Nothing new to sync to history.'); return; }

  for (const batch of chunk(toSync, 100)) {
    const body = {
      movies: batch.map(m => ({
        ids: m.traktIds,
        watched_at: m.dateWatched ? new Date(m.dateWatched).toISOString() : new Date().toISOString(),
      })),
    };
    if (DRY_RUN) {
      console.log(`[dry-run] would POST /sync/history with ${batch.length} movie(s)`);
      continue;
    }
    const res = await traktFetch('/sync/history', { method: 'POST', token, auth: true, body });
    if (!res.ok) { console.error(`  history sync failed: ${res.status}`); continue; }
    const now = new Date().toISOString();
    batch.forEach(m => { m.traktSyncedAt = now; });
    console.log(`  synced ${batch.length} movie(s) to history`);
  }
}

async function syncWatchlist(token, entries) {
  const toSync = entries.filter(m => m.traktIds && !m.traktSyncedAt);
  if (!toSync.length) { console.log('Nothing new to sync to watchlist.'); return; }

  for (const batch of chunk(toSync, 100)) {
    const body = { movies: batch.map(m => ({ ids: m.traktIds })) };
    if (DRY_RUN) {
      console.log(`[dry-run] would POST /sync/watchlist with ${batch.length} movie(s)`);
      continue;
    }
    const res = await traktFetch('/sync/watchlist', { method: 'POST', token, auth: true, body });
    if (!res.ok) { console.error(`  watchlist sync failed: ${res.status}`); continue; }
    const now = new Date().toISOString();
    batch.forEach(m => { m.traktSyncedAt = now; });
    console.log(`  synced ${batch.length} movie(s) to watchlist`);
  }
}

async function main() {
  const watchedFile = readJSON(WATCHED_PATH, { movies: [] });
  const watchlistFile = readJSON(WATCHLIST_PATH, { movies: [] });

  console.log(`Loaded ${watchedFile.movies.length} watched movie(s), ${watchlistFile.movies.length} watchlist movie(s).`);
  if (DRY_RUN) console.log('(dry run — no data will be written to Trakt or to local files)\n');

  const token = await getAccessToken();

  console.log('\nResolving watched movies against Trakt…');
  await resolveIds(watchedFile.movies, 'watched');

  console.log('\nResolving watchlist movies against Trakt…');
  await resolveIds(watchlistFile.movies, 'watchlist');

  console.log('\nSyncing history…');
  await syncHistory(token, watchedFile.movies);

  console.log('\nSyncing watchlist…');
  await syncWatchlist(token, watchlistFile.movies);

  if (!DRY_RUN) {
    writeJSON(WATCHED_PATH, watchedFile);
    writeJSON(WATCHLIST_PATH, watchlistFile);
    console.log('\nLocal data files updated with resolved Trakt ids + sync timestamps.');
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
