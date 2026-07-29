const DB_ID = "1000299722-pyrus_bot_database-hul";

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

// Mirrors normalizeTopic in searchKnowledge: an article is a list of steps, and a
// legacy article with a single solverInstruction counts as one step.
const stepCount = Array.isArray(topic.steps) && topic.steps.length
  ? topic.steps.filter(s => s && (typeof s === "string" ? s : s.instruction)).length
  : (topic.solverInstruction ? 1 : 0);

const attempts = Array.isArray(data.attempts) ? data.attempts : [];
const made = attempts.filter(a => a && String(a.topicKey || "") === String(topicKey)).length;

const onFail = String(topic.onFail || "escalate") === "subtask" ? "subtask" : "escalate";
const extra = { topicKey: topicKey, attemptsMade: made, stepCount: stepCount };

if (made < stepCount) return decide("solver", "step " + (made + 1) + " of " + stepCount + " is still untried", extra);

return decide(onFail, "all " + stepCount + " steps tried, article says " + onFail, extra);
