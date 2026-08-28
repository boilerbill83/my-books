// descSimilarity.js — TF-IDF plot/description similarity signal for BMTRE
//
// Direct port of the book side's descSimilarity.js (same tokenizer, same
// TF-IDF/cosine math), adapted to BMTRE's additive-bonus scoring shape
// instead of the book engine's Bayesian rateEngine.js ensemble — BMTRE has
// no equivalent predictRating() blend to plug a k-NN mean-rating signal
// into (that's an explicitly-deferred Phase 2+ item per CLAUDE.md's BMTRE
// port table), so this returns a capped additive bonus instead, the same
// shape as keywordBonus()/subgenreBonus() rather than a rating prediction.
//
// Coverage guard: buildDescModel returns null until at least MIN_LOVED_DOCS
// loved titles have a real TMDB overview — a true no-op until there's
// enough signal, mirroring the book side's own MIN_READ_DOCS gate.

const STOP = new Set(('a an the and or but of in on at to for with from by is are was were be been ' +
  'this that these those it its his her their he she they them as not no if then than so what when ' +
  'who how all one two new his her season series show film movie now will can just about into over ' +
  'after before more most other some has have had do does did after when where while').split(' '));

export function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

function tfVector(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

const MIN_LOVED_DOCS = 100; // real loved-title-with-overview coverage today: 159
// tunable at runtime for eval sweeps; defaults are production values
export const CFG = { k: 10, minSim: 0.03, cap: 3 };

/**
 * @param {object} enrichedMeta — titleKey -> {overview, ...}
 * @param {Set<string>} lovedTitleKeys — idx.lovedTitles
 * @returns model or null if loved-title overview coverage is insufficient
 */
export function buildDescModel(enrichedMeta, lovedTitleKeys) {
  const docs = [];
  for (const [key, m] of Object.entries(enrichedMeta || {})) {
    if (!m.overview || m.overview.length < 40) continue;
    docs.push({ key, tokens: tokenize(m.overview), loved: lovedTitleKeys.has(key) });
  }
  const lovedDocs = docs.filter(d => d.loved);
  if (lovedDocs.length < MIN_LOVED_DOCS) return null;

  // IDF over the whole enriched corpus (not just loved titles), same as
  // the book side — a candidate's own vector needs the full corpus's IDF
  // weights to be comparable to the loved-titles' vectors.
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const idf = t => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  function vec(tokens) {
    const v = new Map();
    let norm = 0;
    for (const [t, n] of tfVector(tokens)) {
      const w = (1 + Math.log(n)) * idf(t);
      v.set(t, w); norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  }
  for (const d of lovedDocs) d.vec = vec(d.tokens);
  return { lovedDocs, vec };
}

export function cosine(a, b) {
  const [small, big] = a.v.size <= b.v.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small.v) { const w2 = big.v.get(t); if (w2) dot += w * w2; }
  return dot / (a.norm * b.norm);
}

/**
 * Additive scoring bonus for one candidate's overview text, based on
 * TF-IDF cosine similarity to Bill's loved titles' overviews — a genuine
 * "this reads like something you loved" signal, distinct from every other
 * BMTRE signal (all of which key off structured metadata: genre, cast,
 * keywords, similar-title ids) since this reads the actual plot language.
 * @returns { bonus, neighbors } or null if below threshold
 */
export function descSimilarityBonus(overview, model, excludeKey) {
  if (!model || !overview || overview.length < 40) return null;
  const q = model.vec(tokenize(overview));
  const sims = model.lovedDocs
    .filter(d => d.key !== excludeKey) // a candidate can't match itself (matters for eval.js's leave-one-out sweep)
    .map(d => ({ key: d.key, sim: cosine(q, d.vec) }))
    .filter(x => x.sim > CFG.minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, CFG.k);
  if (!sims.length) return null;
  const simMass = sims.reduce((s, x) => s + x.sim, 0);
  // Scaled the same way keywordBonus() scales its own match count into a
  // small capped bonus — one voice among many additive signals, not a
  // takeover; swept against scripts/eval.js before trusting the constant.
  const bonus = Math.min(CFG.cap, simMass * 4);
  return { bonus, neighbors: sims };
}
