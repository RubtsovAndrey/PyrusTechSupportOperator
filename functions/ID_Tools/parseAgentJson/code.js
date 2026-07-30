const DB_ID = "1000299722-pyrus_bot_database-hul";

// Facts each agent is allowed to contribute to the task document.
const PERSISTED = ["unitFullName", "componentName", "problemSummary", "email", "topicKey"];

function normalize(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[.,«»'"()\[\]]/g, " ").replace(/[\s-]+/g, " ").trim();
}

// "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)" -> "Тамбов-1".
function nameOf(entry) {
  let s = String(entry || "").trim();
  const op = s.lastIndexOf("(");
  if (op >= 0) s = s.slice(0, op).trim();
  if (s.charAt(0) === "[") {
    const bc = s.indexOf("]");
    if (bc > 1) s = s.slice(bc + 1).trim();
  }
  return s;
}

function businessOf(full) {
  const m = String(full || "").match(/^\[([^\]]+)\]/);
  return m ? m[1].split(".")[0] : "";
}

// A wrong unit written into Pyrus is worse than no unit, so the value is accepted
// only if the catalog really has it. Matching used to demand the whole entry
// character for character; the agent routinely drops the business prefix or the
// address, and the value was then discarded without a trace, leaving the unit empty
// for the rest of the dialog. The unit name alone is enough as long as it is unique.
function validateUnit(candidate, business) {
  if (!candidate) return null;
  const wantedFull = normalize(candidate);
  const wantedName = normalize(nameOf(candidate));
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "unitCatalog" });
    const raw = doc && doc.value ? (Array.isArray(doc.value) ? doc.value : doc.value.items) : null;
    if (!Array.isArray(raw)) {
      Log.warn({ message: "parseAgentJson: unitCatalog missing, cannot validate unit" });
      return null;
    }
    let hit = raw.find(item => normalize(item) === wantedFull);
    if (!hit) {
      let byName = raw.filter(item => normalize(nameOf(item)) === wantedName);
      // The same point name exists in more than one business, and the agent reports which
      // one it heard. Without that hint an ambiguous name is still refused: a point of the
      // wrong network in the Pyrus field is worse than an empty field.
      if (byName.length > 1 && business) {
        const wantedBiz = normalize(business);
        const inBiz = byName.filter(item => normalize(businessOf(item)) === wantedBiz);
        if (inBiz.length === 1) byName = inBiz;
      }
      if (byName.length === 1) hit = byName[0];
      else if (byName.length > 1) {
        Log.warn({ message: "parseAgentJson: unit \"" + candidate + "\" matches " + byName.length + " catalog entries, not persisting" });
        return null;
      }
    }
    if (!hit) Log.warn({ message: "parseAgentJson: unit \"" + candidate + "\" is not in unitCatalog, not persisting" });
    return hit ? String(hit).trim() : null;
  } catch (e) {
    Log.warn({ message: "parseAgentJson: unitCatalog read failed: " + e });
    return null;
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

// The topic and the component are catalog values, not free text. An invented topicKey
// makes searchKnowledge fall back to a blind text search, and an invented component is
// written straight into the Pyrus field Компонент — the same argument that already
// guards the unit: a wrong value in a catalog field is worse than an empty one.
function loadTopics() {
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
    const list = doc && doc.value && Array.isArray(doc.value.topics) ? doc.value.topics : null;
    if (!list) Log.warn({ message: "parseAgentJson: knowledge_catalog missing, cannot validate topic" });
    return list || [];
  } catch (e) {
    Log.warn({ message: "parseAgentJson: knowledge_catalog read failed: " + e });
    return [];
  }
}

function validateTopicKey(candidate) {
  const wanted = String(candidate).trim().toLowerCase();
  const hit = loadTopics().find(t => String(t.key || "").toLowerCase() === wanted);
  if (!hit) {
    Log.warn({ message: "parseAgentJson: topic " + candidate + " is not in knowledge_catalog, not persisting" });
    return null;
  }
  return String(hit.key);
}

function componentOfTopic(key) {
  const hit = loadTopics().find(t => String(t.key || "") === String(key));
  return hit && hit.componentName ? String(hit.componentName) : null;
}

function validateComponent(candidate) {
  const wanted = normalize(candidate);
  const hit = loadTopics().find(t => t.componentName && normalize(t.componentName) === wanted);
  if (!hit) {
    Log.warn({ message: "parseAgentJson: component " + candidate + " is not in knowledge_catalog, not persisting" });
    return null;
  }
  return String(hit.componentName);
}

const raw = Context.getLastFunctionResult();
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : String(raw || ""));
const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

let parsed = null;
try {
  parsed = JSON.parse(cleaned);
} catch (e) {
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      parsed = JSON.parse(match[0]);
    } catch (e2) {
      parsed = null;
    }
  }
}

// Models drop the JSON wrapper from time to time and answer in plain prose. Whether
// that is recoverable depends on what the stage produces:
//   intake / solver     -> the payload IS text for the partner, so the prose is usable
//                          and sending it beats escalating a healthy dialog.
//   routing / confirmation -> the payload is a control decision (route, status) that
//                          prose cannot supply; guessing it would send the dialog down
//                          an arbitrary branch, so fail and let a human take over.
const PROSE_FALLBACK = {
  intake: text => ({ action: "clarify", clarifyingQuestion: text }),
  solver: text => ({ replyText: text })
};

if (!parsed || typeof parsed !== "object") {
  const recover = PROSE_FALLBACK[String(stage || "")];
  if (recover && cleaned) {
    Log.warn({ message: "parseAgentJson(" + stage + "): answer was not JSON, using it as plain text" });
    parsed = recover(cleaned);
  } else {
    throw new Error("parseAgentJson(" + stage + "): agent answer is not JSON: " + cleaned.slice(0, 300));
  }
}

const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = dialog.taskId || null;

// The unit must not depend on the model choosing to call a tool. The agent reports what
// it heard in `unit` and the catalog value in `unitFullName`, and it is told to leave the
// latter empty unless matchUnit filled it — which a flash model skips most turns. The
// partner was then asked for the point three times, answered three times, and the dialog
// escalated with nothing collected. The catalog stays the only arbiter: a name it does
// not contain resolves to nothing and is not persisted.
const unitCandidate = parsed.unitFullName || parsed.unit || null;
if (unitCandidate) parsed.unitFullName = validateUnit(unitCandidate, parsed.business);
if (parsed.topicKey) parsed.topicKey = validateTopicKey(parsed.topicKey);
if (parsed.componentName) parsed.componentName = validateComponent(parsed.componentName);

// The component of a known topic belongs to the catalog, not to the model's guess:
// once the topic is resolved, the catalog value wins outright.
if (parsed.topicKey) {
  const fromCatalog = componentOfTopic(parsed.topicKey);
  if (fromCatalog) parsed.componentName = fromCatalog;
}

// The confirmation answer that means решилось, но есть другой вопрос.
const moreQuestions = String(stage || "") === "confirmation" &&
  String(parsed.status || "") === "more_questions";

if (taskId) {
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    const state = (doc && doc.value) || {};
    const documentExists = !!(doc && doc.value);
    const data = Object.assign({}, state.data);
    // Paths this call is going to write. Rewriting the whole document instead meant the
    // agents of a concurrent turn lost every fact they had collected since this run read
    // it — the defect this replaces.
    const patch = { "updatedAt": Date.now() };
    PERSISTED.forEach(key => {
      if (parsed[key]) {
        data[key] = parsed[key];
        patch["data." + key] = parsed[key];
      }
    });

    // Which way the article itself says this topic must go. Kept so the operator's
    // summary can tell статьи нет вовсе apart from статья есть, и она велит передать
    // человеку: для бота оба пути заканчиваются эскалацией, для оператора это совсем
    // разные ситуации.
    if (String(stage || "") === "routing") {
      const route = String(parsed.route || "");
      if (route === "solver" || route === "subtask" || route === "escalate") {
        data.topicRoute = route;
        patch["data.topicRoute"] = route;
      }
    }

    // The partner confirms the old problem is gone and asks about something else. Left
    // in place, the facts of the solved problem sent the next turn back into the old
    // article: the solver read topicKey and served the next step of an article that no
    // longer applies, while the attempts log kept growing under the wrong topic.
    if (moreQuestions) {
      // Cleared by writing null rather than by removing the key: only $set is available,
      // and every reader treats null as «not collected» anyway.
      ["problemSummary", "topicKey", "componentName", "topicRoute",
       "attempts", "offeredStep", "preQuestionsAsked"].forEach(k => {
        delete data[k];
        patch["data." + k] = null;
      });
      Log.info({ message: "parseAgentJson: task " + taskId + " moved on to a new question, previous problem facts cleared" });
    }

    // Every solution handed to the partner is logged: searchKnowledge reads this to
    // pick the next step of the article instead of repeating the first one, and the
    // escalation summary reads it to tell the operator what has been tried already.
    //
    // The step number comes from searchKnowledge, which wrote down what it handed out,
    // and a step already logged is never logged twice. Numbering the attempts by their
    // own count instead made the log lie about the article: one repeated answer became
    // a third "attempt" on a two-step article, and the counter ran past the end.
    if (String(stage || "") === "solver" && parsed.replyText && String(parsed.kind || "solution") !== "questions") {
      const attempts = Array.isArray(data.attempts) ? data.attempts.slice() : [];
      const topicKey = data.topicKey || null;
      const mine = attempts.filter(a => a && String(a.topicKey || "") === String(topicKey));
      const offered = data.offeredStep && String(data.offeredStep.topicKey || "") === String(topicKey)
        ? Number(data.offeredStep.stepNumber) || 0
        : 0;
      const step = offered || mine.length + 1;
      if (mine.some(a => Number(a.step) === step)) {
        Log.warn({ message: "parseAgentJson: step " + step + " of topic " + topicKey + " was already delivered, not counting it again" });
      } else {
        attempts.push({
          topicKey: topicKey,
          step: step,
          at: Date.now(),
          advice: String(parsed.replyText).replace(/\s+/g, " ").trim().slice(0, 200)
        });
        data.attempts = attempts;
        patch["data.attempts"] = attempts;
      }
    }
    // `subtaskId` guards against creating the subtask twice for ONE problem. A new
    // question in the same task is a different problem and may need its own subtask,
    // and the streak counter must not carry a stale score into it either.
    if (moreQuestions) {
      patch["subtaskId"] = null;
      patch["clarifyStreak"] = 0;
    }

    // No document means receiveWebhook could not create one; writeState notices that the
    // point write matched nothing and creates it, so the facts are not lost either way.
    // A document being created gets the whole facts subtree, so every reader can rely on
    // it being there even when this turn collected nothing.
    if (!documentExists) patch["data"] = data;
    writeState(taskId, patch, "parseAgentJson");
    // The facts this stage just resolved are republished as a note so the agents that
    // run later in the same pass (routing, solver) can see the unit and the topic.
    // A labelled note is followed far more reliably by a small model than the nested
    // JSON the platform builds out of the putValue keys.
    // The attempts log is for the code, not for the prompt: the platform serialises
    // every key of the dialog value into the system message.
    const published = Object.assign({}, dialog, data);
    ["attempts", "offeredStep", "preQuestionsAsked", "topicRoute"].forEach(k => { delete published[k]; });
    AgentContext.putValue({ key: "dialog", value: published });
    AgentContext.addNote({
      text: [
        "Уточнённые данные по обращению:",
        "- Юнит: " + (data.unitFullName || "не определён"),
        "- Проблема: " + (data.problemSummary || "не описана"),
        "- Email: " + (data.email || "не указан"),
        "- Тематика: " + (data.topicKey || "не определена")
      ].join("\n")
    });
  } catch (e) {
    Log.warn({ message: "parseAgentJson: state write failed: " + e });
  }
}

parsed.taskId = taskId;
parsed.agentStage = String(stage || "");
return parsed;
