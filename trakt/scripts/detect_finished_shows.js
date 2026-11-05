#!/usr/bin/env node
// Detects shows Bill has just finished, from the Trakt-derived library.
//
// A show counts as "finished" when it flips from not-caught-up to caught-up
// between two library builds: plays >= aired episodes (aired count taken
// from TMDB when it is higher than the Trakt export, same rule as the
// dashboard) and TMDB has no further episode scheduled for the season.
// The season reported is TMDB's last aired season.
//
// State lives in trakt/data/finishedShowsState.json (titleKey -> caughtUp).
// The first run only seeds that state and sends nothing, so the existing
// library is never announced. New finishes are queued in
// trakt/data/finishedShowAlerts.json with empty `facts`; three facts about
// the season are written by a Claude Code session using WebSearch (never the
// billed API, per CLAUDE.md's no-API-credits policy), and
// trakt/notify_finished_shows.py texts once the facts are in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const write = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 1) + '\n');

const library = read('library.json', { titles: [] }).titles;
const meta = read('enrichedMetadata.json', {});
const hadState = fs.existsSync(path.join(DATA, 'finishedShowsState.json'));
const state = read('finishedShowsState.json', {});
const alerts = read('finishedShowAlerts.json', { alerts: [] });
const known = new Set(alerts.alerts.map(a => `${a.titleKey}#${a.season}`));

function airedFromTmdb(m) {
  const last = m?.lastEpisodeToAir, counts = m?.seasonEpisodeCounts;
  if (!last?.seasonNumber || !counts) return 0;
  let n = last.episodeNumber || 0;
  for (const [sn, c] of Object.entries(counts)) if (Number(sn) < last.seasonNumber) n += c || 0;
  return n;
}

let added = 0;
const next = {};
for (const t of library) {
  if (t.type !== 'show') continue;
  const m = meta[t.titleKey];
  const aired = Math.max(t.airedEpisodes || 0, airedFromTmdb(m));
  const caughtUp = aired > 0 && (t.plays || 0) >= aired && !m?.nextEpisodeToAir;
  next[t.titleKey] = caughtUp;
  if (hadState && caughtUp && state[t.titleKey] === false) {
    const season = m?.lastEpisodeToAir?.seasonNumber || null;
    if (!known.has(`${t.titleKey}#${season}`)) {
      alerts.alerts.push({
        titleKey: t.titleKey, title: t.title, year: t.year, season,
        detectedAt: new Date().toISOString().slice(0, 10), facts: [], sentAt: null,
      });
      added++;
    }
  }
}
write('finishedShowsState.json', next);
if (added) write('finishedShowAlerts.json', alerts);
else if (!fs.existsSync(path.join(DATA, 'finishedShowAlerts.json'))) write('finishedShowAlerts.json', alerts);
console.log(hadState ? `Finished-show check: ${added} new finish(es) queued.` : 'Finished-show check: baseline state seeded, nothing queued.');
