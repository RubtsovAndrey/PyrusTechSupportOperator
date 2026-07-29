const DB_ID = "1000299722-pyrus_bot_database-hul";
const RAG_KEY = "1000299722-testovaa_baza_znanij-gsp";

const MAX_TOPICS = 3;
const MIN_SCORE = 0.34;
const DEFAULT_FOLLOW_UP = "Получилось решить вопрос?";
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

// An article may offer several solutions to try in order. Older articles carry a
// single solverInstruction; they are read as a one-step article so the catalog can
// be migrated topic by topic.
function normalizeTopic(t) {
  const steps = [];
  const list = Array.isArray(t.steps) ? t.steps : [];
  list.forEach(s => {
    const instruction = typeof s === "string" ? s : (s && s.instruction);
    if (!instruction) return;
    const own = typeof s === "object" && s ? s.followUpQuestion : null;
    steps.push({
      instruction: String(instruction),
      followUpQuestion: String(own || t.followUpQuestion || DEFAULT_FOLLOW_UP)
    });
  });
  if (!steps.length && t.solverInstruction) {
    steps.push({
      instruction: String(t.solverInstruction),
      followUpQuestion: String(t.followUpQuestion || DEFAULT_FOLLOW_UP)
    });
  }
  return {
    key: String(t.key || ""),
    description: t.description ? String(t.description) : null,
    route: t.route ? String(t.route) : "solver",
    componentName: t.componentName ? String(t.componentName) : null,
    preQuestions: Array.isArray(t.preQuestions) ? t.preQuestions.filter(Boolean).map(String) : [],
    // Where the dialog goes when every step has been tried and nothing helped.
    onFail: String(t.onFail || "escalate") === "subtask" ? "subtask" : "escalate",
    steps: steps
  };
}

// How many solutions this task has already been given for the topic. Written by
// parseAgentJson after every solver turn, so a repeated step cannot be sent twice.
function attemptsMade(key) {
  try {
    const dialog = AgentContext.getValue({ key: "dialog" }) || {};
    if (!dialog.taskId) return 0;
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + dialog.taskId });
    const attempts = doc && doc.value && doc.value.data ? doc.value.data.attempts : null;
    if (!Array.isArray(attempts)) return 0;
    return attempts.filter(a => a && String(a.topicKey || "") === String(key)).length;
  } catch (e) {
    Log.warn({ message: "searchKnowledge: attempts read failed: " + e });
    return 0;
  }
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

// Exact lookup: the solver already knows which topic it must follow, and gets one
// step at a time. Handing over the whole article invited the model to dump every
// variant in a single reply, which left nothing to try when the partner said the
// first one had not helped.
if (topicKey) {
  const wanted = String(topicKey).toLowerCase();
  const exact = topics.filter(t => String(t.key || "").toLowerCase() === wanted);
  if (exact.length) {
    const topic = normalizeTopic(exact[0]);
    if (!topic.steps.length) {
      Log.warn({ message: "searchKnowledge: topic " + topic.key + " has no solution steps" });
      return { found: false, topics: [], source: "no-steps", onFail: topic.onFail };
    }
    const done = attemptsMade(topic.key);
    const index = Math.min(done, topic.steps.length - 1);
    const step = topic.steps[index];
    Log.info({ message: "searchKnowledge: topic " + topic.key + " step " + (index + 1) + "/" + topic.steps.length + " (attempts made: " + done + ")" });
    return {
      found: true,
      source: "key",
      key: topic.key,
      description: topic.description,
      componentName: topic.componentName,
      preQuestions: topic.preQuestions,
      onFail: topic.onFail,
      stepNumber: index + 1,
      stepCount: topic.steps.length,
      isLastStep: index >= topic.steps.length - 1,
      stepsExhausted: done >= topic.steps.length,
      solverInstruction: step.instruction,
      followUpQuestion: step.followUpQuestion
    };
  }
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

// Only the fields the router decides on. Shipping whole articles here used to put
// every solution text into the routing prompt, which both bloated it and tempted the
// router to answer instead of routing.
if (scored.length) {
  return {
    found: true,
    source: "catalog",
    topics: scored.map(r => ({
      score: Number(r.score.toFixed(2)),
      key: String(r.topic.key || ""),
      description: r.topic.description ? String(r.topic.description) : null,
      route: r.topic.route ? String(r.topic.route) : "solver",
      componentName: r.topic.componentName ? String(r.topic.componentName) : null
    }))
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
