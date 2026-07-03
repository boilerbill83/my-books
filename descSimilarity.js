// descSimilarity.js — TF-IDF description similarity signal (v1 prototype)
//
// Builds vectors from data/enrichedMetadata.json descriptions and predicts
// a rating signal for a candidate as the shrunk mean rating of its k most
// description-similar RATED READ books. New information channel: content
// words, not hand tags.
//
// Coverage guard: buildDescModel returns null until at least MIN_READ_DOCS
// rated read books have descriptions, so the engine no-ops safely while the
// daily enrich-metadata workflow fills the cache (read shelf lands ~day 3-7).

const STOP = new Set(('a an the and or but of in on at to for with from by is are was were be been ' +
  'this that these those it its his her their he she they them as not no if then than so what when ' +
  'who how all one two new york times bestselling author novel book story readers edition million ' +
  'now will can just about into over after before more most other some has have had do does did').split(' '));

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

const MIN_READ_DOCS = 150;
export const K_NEIGHBORS = 12;

/**
 * @param {object} goodreads — goodreadsData.json object
 * @param {object} meta      — enrichedMetadata.json object (bookKey → {description})
 * @returns model or null if read-shelf coverage is insufficient
 */
export function buildDescModel(goodreads, meta) {
  const docs = [];   // { key, tokens, rating|null }
  const rated = new Map();
  for (const b of goodreads.books || []) {
    if (b.shelf === 'read' && b.myRating >= 1 && !b.dnf) rated.set(b.bookKey, b.myRating);
  }
  for (const [key, m] of Object.entries(meta || {})) {
    if (!m.description || m.description.length < 80) continue;
    docs.push({ key, tokens: tokenize(m.description), rating: rated.get(key) ?? null });
  }
  const ratedDocs = docs.filter(d => d.rating !== null);
  if (ratedDocs.length < MIN_READ_DOCS) return null;   // not enough signal yet

  // IDF over the whole enriched corpus
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
  for (const d of ratedDocs) d.vec = vec(d.tokens);
  return { ratedDocs, vec, idfDf: df };
}

export function cosine(a, b) {
  const [small, big] = a.v.size <= b.v.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small.v) { const w2 = big.v.get(t); if (w2) dot += w * w2; }
  return dot / (a.norm * b.norm);
}

/**
 * Rating signal for one candidate description.
 * @returns { mean, weight, neighbors } or null
 */
export function descSignal(description, model) {
  if (!model || !description || description.length < 80) return null;
  const q = model.vec(tokenize(description));
  const sims = model.ratedDocs
    .map(d => ({ key: d.key, rating: d.rating, sim: cosine(q, d.vec) }))
    .filter(x => x.sim > 0.03)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, K_NEIGHBORS);
  if (sims.length < 3) return null;
  const wSum = sims.reduce((s, x) => s + x.sim, 0);
  const mean = sims.reduce((s, x) => s + x.rating * x.sim, 0) / wSum;
  // weight grows with both neighbor count and similarity mass, capped small:
  // this is one voice among the existing signals, not a takeover.
  const weight = Math.min(6, wSum * 4);
  return { mean, weight, neighbors: sims };
}
