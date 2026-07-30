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

const taskId = (AgentContext.getValue({ key: "dialog" }) || {}).taskId || null;

function loadData() {
  if (!taskId) return {};
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    return (doc && doc.value && doc.value.data) || {};
  } catch (e) {
    Log.warn({ message: "searchKnowledge: state read failed: " + e });
    return {};
  }
}

// ── How a point write addresses its document ──
// `filters` match fields **inside `value`**, and so do the paths in `operator`. Both were
// settled by experiment, and both had been wrong: a filter on `documentKey` or on `key`
// matched nothing — silently, with `count: 0` — so a whole turn of writes vanished, while
// a `value.`-prefixed `$set` path landed in a nested `value.value` subtree instead of the
// field. Hence: filter on `taskId`, and no prefix in the paths below.
function setPath(target, dotted, value) {
  const parts = String(dotted).split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

// An array cannot be the value of a $set: the adapter converts every value into a BSON
// document and answers 500 — «Failed to convert from ArrayNode to org.bson.Document».
// Such a patch skips the point write and goes whole-document, where arrays are fine.
function hasArrayValue(paths) {
  return Object.keys(paths).some(p => Array.isArray(paths[p]));
}

function writeState(taskId, paths, who) {
  const key = "state:" + taskId;
  if (!hasArrayValue(paths)) {
    try {
      const res = Db.updateByFilters({
        dbIntegration: DB_ID,
        filters: { taskId: Number(taskId) },
        operator: { $set: paths }
      });
      if (res && Number(res.count) > 0) return true;
      Log.warn({ message: who + ": point write matched no document " + key + ", falling back to a whole-document write" });
    } catch (e) {
      Log.warn({ message: who + ": point write failed on " + key + ": " + e });
    }
  }
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: key });
    const value = (doc && doc.value) || {};
    Object.keys(paths).forEach(p => setPath(value, p, paths[p]));
    // The handle every later point write aims at. Written on every rescue, so a document
    // that predates this convention becomes addressable after one turn.
    value.taskId = Number(taskId);
    Db.put({ dbIntegration: DB_ID, documentKey: key, value: value });
    return true;
  } catch (e) {
    Log.error({ message: who + ": state write lost for " + key + ": " + e });
    return false;
  }
}

// Written straight into the task document rather than returned to the agent: what the
// article has already spent on this task must not depend on the model repeating it.
// Only the keys of the patch are written. Rewriting the whole document meant this tool,
// which runs in the middle of an agent's turn, undid every fact a concurrent turn had
// collected since it read the document.
function patchData(patch) {
  if (!taskId) return;
  const paths = { "updatedAt": Date.now() };
  Object.keys(patch).forEach(k => { paths["data." + k] = patch[k]; });
  writeState(taskId, paths, "searchKnowledge");
}

// The highest step of this article the partner has already been given. Counting the
// attempts instead was what let one repeated answer shift the whole article: every
// extra delivery moved the index on, and once it ran past the end it was clamped back
// to the last step, so the same advice was sent again and again. The number of the
// step is recorded with the attempt, and that number is what decides the next one.
function stepDone(attempts, key) {
  const mine = (Array.isArray(attempts) ? attempts : []).filter(a => a && String(a.topicKey || "") === String(key));
  let max = 0;
  mine.forEach(a => { const n = Number(a.step); if (n > max) max = n; });
  // Attempts written before the step number was recorded: fall back to counting them.
  return max || mine.length;
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
    const data = loadData();

    // The article's own questions come FIRST and alone. Handing the instruction over
    // together with them let the model answer both at once: the partner got the first
    // solution attached to a question, that turn counted as "questions" and was never
    // logged, and the next turn served the very same solution again.
    const asked = Array.isArray(data.preQuestionsAsked) ? data.preQuestionsAsked : [];
    if (topic.preQuestions.length && asked.indexOf(topic.key) < 0) {
      patchData({ preQuestionsAsked: asked.concat([topic.key]) });
      Log.info({ message: "searchKnowledge: topic " + topic.key + " asks " + topic.preQuestions.length + " question(s) before any solution" });
      return {
        found: true,
        source: "pre-questions",
        key: topic.key,
        description: topic.description,
        componentName: topic.componentName,
        preQuestions: topic.preQuestions,
        onFail: topic.onFail,
        needsPreQuestions: true,
        stepCount: topic.steps.length,
        solverInstruction: null,
        followUpQuestion: null
      };
    }

    const done = stepDone(data.attempts, topic.key);
    // Every step has been tried. Repeating the last one is worse than admitting it:
    // the caller leaves the topic through onFail instead.
    if (done >= topic.steps.length) {
      Log.warn({ message: "searchKnowledge: topic " + topic.key + " is exhausted (" + done + " of " + topic.steps.length + " steps tried)" });
      return {
        found: false,
        topics: [],
        source: "steps-exhausted",
        key: topic.key,
        stepsExhausted: true,
        stepCount: topic.steps.length,
        onFail: topic.onFail
      };
    }
    const index = done;
    const step = topic.steps[index];
    patchData({ offeredStep: { topicKey: topic.key, stepNumber: index + 1, at: Date.now() } });
    Log.info({ message: "searchKnowledge: topic " + topic.key + " step " + (index + 1) + "/" + topic.steps.length + " (steps tried: " + done + ")" });
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
      stepsExhausted: false,
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
