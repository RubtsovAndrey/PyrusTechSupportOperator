const DB_ID = "1000299722-pyrus_bot_database-hul";

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
//
// Checked at every depth, not just at the top: the conversion walks the whole value, so an
// array nested inside an object breaks it exactly the same way. While only the top level
// was checked, a patch like { pendingOutcome: { fieldUpdates: [...] } } passed the guard,
// failed on the platform and was rescued by the whole-document path — silently doing the
// read-modify-write these point writes exist to avoid.
function hasArrayValue(paths) {
  const deep = v => Array.isArray(v) ||
    (!!v && typeof v === "object" && Object.keys(v).some(k => deep(v[k])));
  return Object.keys(paths).some(p => deep(paths[p]));
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

// The partner said the advice did not help. Whether that ends the dialog or not is a
// property of the knowledge article, not of the model's mood: an article may list
// several solutions to try in order, and it declares where to go once they run out.
const prev = Context.getLastFunctionResult() || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = prev.taskId || dialog.taskId || null;

function decide(next, reason, extra) {
  const out = Object.assign({ next: next, taskId: taskId, reason: reason }, extra || {});
  Log.info({ message: "nextSolutionStep: task " + taskId + " -> " + next + " (" + reason + ")" });
  return out;
}

if (!taskId) return decide("escalate", "no taskId");

// Only a clear "it did not help" earns another variant. When the confirmation agent
// could not read the answer at all, a human should look at it.
if (String(prev.status || "") === "unclear") return decide("escalate", "confirmation status is unclear");

let data = {};
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (doc && doc.value && doc.value.data) data = doc.value.data;
} catch (e) {
  Log.warn({ message: "nextSolutionStep: state read failed: " + e });
}

const topicKey = data.topicKey || null;
if (!topicKey) return decide("escalate", "topic is unknown");

let topic = null;
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
  const topics = doc && doc.value && Array.isArray(doc.value.topics) ? doc.value.topics : [];
  topic = topics.find(t => t && String(t.key || "").toLowerCase() === String(topicKey).toLowerCase()) || null;
} catch (e) {
  Log.warn({ message: "nextSolutionStep: catalog read failed: " + e });
}

if (!topic) return decide("escalate", "topic " + topicKey + " is not in the catalog", { topicKey: topicKey });

// A branching article does not count steps: where «не помогло» goes is written on the
// node the partner is standing on, and only that node knows. `onFail` may name another
// node — a further recommendation or a question — and then the dialog stays with the bot.
const nodes = topic.nodes && typeof topic.nodes === "object" ? topic.nodes : null;
if (nodes) {
  const at = data.treeNode && nodes[String(data.treeNode)] ? nodes[String(data.treeNode)] : null;
  const failTo = String((at && at.onFail) || topic.onFail || "escalate");
  const extra = { topicKey: topicKey, treeNode: data.treeNode || null, failTo: failTo };
  // A node that only ends the dialog needs no agent to say it. Routing through the solver
  // to reach it would spend a model call — and a chance for the model to invent a farewell
  // — on a decision the article has already made.
  const fail = nodes[failTo];
  const bare = fail && fail.end && !fail.advice && !(Array.isArray(fail.ask) && fail.ask.length);
  if (bare && String(fail.end) !== "close") {
    return decide(String(fail.end) === "subtask" ? "subtask" : "escalate",
      "node " + failTo + " only ends the dialog", extra);
  }
  if (fail) {
    // Handed over by name so searchKnowledge delivers that node instead of trying to
    // advance away from it. Written straight into the document: the tool that reads it
    // runs inside the next agent's turn and has nothing else to go on.
    if (!writeState(taskId, { "data.treeNext": failTo, "updatedAt": Date.now() }, "nextSolutionStep")) {
      return decide("escalate", "could not record the next node of the article", extra);
    }
    return decide("solver", "article continues at node " + failTo, extra);
  }
  if (failTo === "subtask") return decide("subtask", "node " + (data.treeNode || "?") + " says subtask", extra);
  return decide("escalate", "node " + (data.treeNode || "?") + " says escalate", extra);
}

// Mirrors normalizeTopic in searchKnowledge: an article is a list of steps, and a
// legacy article with a single solverInstruction counts as one step.
const stepCount = Array.isArray(topic.steps) && topic.steps.length
  ? topic.steps.filter(s => s && (typeof s === "string" ? s : s.instruction)).length
  : (topic.solverInstruction ? 1 : 0);

// Which step the article has got to, not how many answers were sent: mirrors stepDone
// in searchKnowledge. Counting the answers let a single repeated reply declare a
// two-step article finished after the first step had barely been tried.
const attempts = Array.isArray(data.attempts) ? data.attempts : [];
const mine = attempts.filter(a => a && String(a.topicKey || "") === String(topicKey));
let made = 0;
mine.forEach(a => { const n = Number(a.step); if (n > made) made = n; });
if (!made) made = mine.length;

const onFail = String(topic.onFail || "escalate") === "subtask" ? "subtask" : "escalate";
const extra = { topicKey: topicKey, stepsTried: made, attemptsLogged: mine.length, stepCount: stepCount };

if (made < stepCount) return decide("solver", "step " + (made + 1) + " of " + stepCount + " is still untried", extra);

return decide(onFail, "all " + stepCount + " steps tried, article says " + onFail, extra);
