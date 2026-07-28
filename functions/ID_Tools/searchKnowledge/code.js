const DB_ID = "1000299722-pyrus_bot_database-hul";
const RAG_KEY = "1000299722-testovaa_baza_znanij-gsp";

function loadKnowledge() {
  try {
    const r = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
    if (r && r.value && Array.isArray(r.value.topics)) return r.value.topics;
  } catch (e) {}
  return null;
}

const topics = loadKnowledge();
if (!topics) {
  return { topics: [], source: "db-empty" };
}

const queryLower = String(query || "").toLowerCase();
const matches = topics.filter(t => {
  const desc = String(t.description || "").toLowerCase();
  const key = String(t.key || "").toLowerCase();
  return desc.includes(queryLower) || queryLower.includes(desc) || key.includes(queryLower);
});

if (matches.length > 0) {
  return { topics: matches, source: "db" };
}

return { topics: topics, source: "db-all" };
