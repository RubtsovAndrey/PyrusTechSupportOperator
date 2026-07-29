const DB_ID = "1000299722-pyrus_bot_database-hul";
const RAG_KEY = "1000299722-testovaa_baza_znanij-gsp";

const MAX_TOPICS = 3;
const MIN_SCORE = 0.34;
const STOPWORDS = ["и", "в", "на", "с", "не", "что", "как", "для", "по", "но", "или", "у", "к", "от", "до", "за", "есть", "был", "была", "было"];

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^0-9a-zа-я]+/)
    .filter(t => t.length > 2 && STOPWORDS.indexOf(t) < 0);
}

// Prefix comparison tolerates Russian inflection ("принтера" vs "принтер") without a stemmer.
function hasToken(haystack, token) {
  const stem = token.slice(0, Math.max(4, token.length - 2));
  return haystack.some(h => h === token || h.indexOf(stem) === 0 || token.indexOf(h.slice(0, Math.max(4, h.length - 2))) === 0);
}

let topics = [];
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
  if (doc && doc.value && Array.isArray(doc.value.topics)) topics = doc.value.topics;
} catch (e) {
  Log.warn({ message: "searchKnowledge: catalog read failed: " + e });
}

if (!topics.length) {
  Log.error({ message: "searchKnowledge: knowledge_catalog is empty or unavailable" });
  return { found: false, topics: [], source: "catalog-empty" };
}

// Exact lookup: the solver already knows which topic it must follow.
if (topicKey) {
  const wanted = String(topicKey).toLowerCase();
  const exact = topics.filter(t => String(t.key || "").toLowerCase() === wanted);
  if (exact.length) return { found: true, topics: exact, source: "key" };
  Log.warn({ message: "searchKnowledge: no topic with key " + topicKey });
}

const queryTokens = tokenize(query);
if (!queryTokens.length) {
  return { found: false, topics: [], source: "empty-query" };
}

const scored = topics
  .map(t => {
    const haystack = tokenize([t.key, t.description, t.componentName].filter(Boolean).join(" "));
    const hits = queryTokens.filter(q => hasToken(haystack, q)).length;
    return { topic: t, score: hits / queryTokens.length };
  })
  .filter(r => r.score >= MIN_SCORE)
  .sort((a, b) => b.score - a.score)
  .slice(0, MAX_TOPICS);

if (scored.length) {
  return {
    found: true,
    source: "catalog",
    topics: scored.map(r => Object.assign({ score: Number(r.score.toFixed(2)) }, r.topic))
  };
}

// No topic matched. Returning the whole catalog would invite the agent to guess, so
// fall back to the knowledge base and let the caller decide (usually: escalate).
let chunks = [];
try {
  const rag = await Rag.retrieveChunks({ ragIntegration: RAG_KEY, query: String(query) });
  chunks = (rag && rag.chunks ? rag.chunks : []).slice(0, 3).map(c => ({ score: c.score, content: c.content }));
} catch (e) {
  Log.warn({ message: "searchKnowledge: RAG fallback failed: " + e });
}

return { found: false, topics: [], chunks: chunks, source: "rag-fallback" };
