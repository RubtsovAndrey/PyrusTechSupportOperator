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

// ── How the partner names his business ──
// The bot asks «это пиццерия или кофейня?» and the partner answers «кофейня». The catalog
// spells the same fact as `[drinkit.ru]`. Nothing connected the two, so the answer was
// worthless: the unit stayed ambiguous, the question was asked again, and after three
// turns the loop guard handed a perfectly answerable request to an operator. The
// question is already fixed in code (applyOutcome), so the vocabulary of its answer
// belongs in code too.
// Keys are the domains as the catalog spells them. Deliberately narrow: «кофе» would fire
// on «кофемашина» and cost a legitimate answer, so only words a partner uses to name the
// business itself are listed. A brand missing from here is not broken, it just falls back
// to needing the domain from the agent — add it when the catalog gains one.
const BUSINESS_WORDS = {
  dodopizza: ["пиццерия", "пиццерии", "пиццерию", "пиццерий", "додо", "dodo", "dodopizza"],
  drinkit: ["кофейня", "кофейни", "кофейню", "кофеен", "дринкит", "drinkit"]
};

// Which business a piece of the partner's text names, if any. Matching is anchored at a
// word start, so «кофейня» is found inside a sentence without «кофе» firing on the middle
// of another word. If the text names more than one business, it names none: guessing
// between them is exactly the error this whole validation exists to prevent.
function businessFromText(text) {
  const hay = " " + normalize(text) + " ";
  const found = Object.keys(BUSINESS_WORDS).filter(biz =>
    BUSINESS_WORDS[biz].some(w => hay.indexOf(" " + w) >= 0));
  return found.length === 1 ? found[0] : null;
}

// A wrong unit written into Pyrus is worse than no unit, so the value is accepted
// only if the catalog really has it. Matching used to demand the whole entry
// character for character; the agent routinely drops the business prefix or the
// address, and the value was then discarded without a trace, leaving the unit empty
// for the rest of the dialog. The unit name alone is enough as long as it is unique.
// `ambiguity` is an out-parameter: the caller needs to know that the unit was refused
// ONLY because the business is missing, because that changes the question the partner is
// asked next. Refused as «not in the catalog» it asked for the point all over again.
function validateUnit(candidate, business, ambiguity) {
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
        // The hint may arrive as a catalog domain (`drinkit`, what the agent is asked for)
        // or as the word the partner actually used (`кофейня`). Both are accepted: the
        // agent reports the domain when it can, and the partner never does.
        const wantedBiz = businessFromText(business) || normalize(business);
        const inBiz = byName.filter(item => normalize(businessOf(item)) === wantedBiz);
        if (inBiz.length === 1) byName = inBiz;
      }
      if (byName.length === 1) hit = byName[0];
      else if (byName.length > 1) {
        Log.warn({ message: "parseAgentJson: unit \"" + candidate + "\" matches " + byName.length + " catalog entries" + (business ? " even with business \"" + business + "\"" : " and no business was named") + ", not persisting" });
        // Ambiguous only across businesses is a question worth asking; ambiguous within
        // one business means the point number is missing and asking about the brand
        // would be nonsense.
        if (ambiguity) {
          const businesses = byName.map(businessOf).filter((b, i, a) => b && a.indexOf(b) === i);
          ambiguity.kind = businesses.length > 1 ? "need_business" : "need_point_number";
          ambiguity.name = String(candidate);
        }
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

function topicByKey(key) {
  return loadTopics().find(t => String(t.key || "") === String(key)) || null;
}

function componentOfTopic(key) {
  const hit = topicByKey(key);
  return hit && hit.componentName ? String(hit.componentName) : null;
}

// Which answers a branching article is allowed to collect. The model reports what the
// partner said, but the NAMES of the fields come from the article — otherwise a model
// having a bad day invents keys and the task document fills up with junk nobody reads.
// A key with a dot or a $ in it would address a different part of the document than it
// looks like, so those are refused outright.
function answerKeysOfTopic(key) {
  const topic = topicByKey(key);
  const nodes = topic && topic.nodes && typeof topic.nodes === "object" ? topic.nodes : null;
  const keys = [];
  const add = list => (Array.isArray(list) ? list : []).forEach(q => {
    if (q && q.key && !/[.$]/.test(String(q.key))) keys.push(String(q.key));
  });
  if (nodes) Object.keys(nodes).forEach(id => add(nodes[id] && nodes[id].ask));
  if (topic) add(topic.askBeforeHandover);
  return keys;
}

function validateComponent(candidate) {
  const wanted = normalize(candidate);
  // Components live on topics and, in a branching article, on the branches themselves:
  // one article covers both rating kinds and their subtasks go to different components.
  const known = [];
  loadTopics().forEach(t => {
    if (t.componentName) known.push(String(t.componentName));
    const nodes = t.nodes && typeof t.nodes === "object" ? t.nodes : null;
    if (nodes) Object.keys(nodes).forEach(id => {
      if (nodes[id] && nodes[id].componentName) known.push(String(nodes[id].componentName));
    });
  });
  const hit = known.find(name => normalize(name) === wanted);
  if (!hit) {
    Log.warn({ message: "parseAgentJson: component " + candidate + " is not in knowledge_catalog, not persisting" });
    return null;
  }
  return hit;
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
const ambiguity = {};
if (unitCandidate) {
  // The business is taken from the agent OR from the partner's own message. The agent is
  // asked to report a catalog domain and, in the dialog this fixes, reported null while
  // the partner had just said «кофейня» out loud — twice. The partner's words are the
  // more reliable of the two sources and cost nothing to read.
  const business = parsed.business || businessFromText(dialog.incomingText);
  parsed.unitFullName = validateUnit(unitCandidate, business, ambiguity);
  if (!parsed.unitFullName && ambiguity.kind) {
    // The next question is decided here, not by the agent: it is a fact about the catalog,
    // and the agent had to call a tool to learn it — which a flash model mostly skips.
    parsed.clarifyKind = ambiguity.kind;
    if (String(parsed.action || "") === "route") parsed.action = "clarify";
    Log.info({ message: "parseAgentJson: unit \"" + ambiguity.name + "\" needs " + ambiguity.kind + " on task " + taskId });
  }
}
if (parsed.topicKey) parsed.topicKey = validateTopicKey(parsed.topicKey);
if (parsed.componentName) parsed.componentName = validateComponent(parsed.componentName);

// The component of a known topic belongs to the catalog, not to the model's guess:
// once the topic is resolved, the catalog value wins outright. A branching article is
// the exception — there the component belongs to the branch, and searchKnowledge has
// already written the right one while walking the tree. Overriding it from the topic
// here would send every branch of one article to the same component.
if (parsed.topicKey) {
  const known = topicByKey(parsed.topicKey);
  const isTree = !!(known && known.nodes && typeof known.nodes === "object");
  const fromCatalog = isTree ? null : componentOfTopic(parsed.topicKey);
  if (fromCatalog) parsed.componentName = fromCatalog;
  else if (isTree) delete parsed.componentName;
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

    // What the partner answered to the questions of a branching article. The names of
    // the fields come from the article and the values from the model, written one path
    // at a time: a whole-subtree write would undo the answers a concurrent turn had
    // just collected, and the answers are the entire point of the tree.
    if (parsed.answers && typeof parsed.answers === "object" && !Array.isArray(parsed.answers)) {
      const allowed = answerKeysOfTopic(data.topicKey || parsed.topicKey);
      const stored = Object.assign({}, data.treeAnswers);
      const refused = [];
      Object.keys(parsed.answers).forEach(k => {
        const value = parsed.answers[k];
        if (allowed.indexOf(k) < 0) { refused.push(k); return; }
        // Objects and arrays are not answers to a question, and an array would break the
        // point write outright. Only what a partner can actually say is kept.
        if (value === null || value === undefined || value === "") return;
        if (typeof value === "object") { refused.push(k); return; }
        stored[k] = String(value);
        patch["data.treeAnswers." + k] = String(value);
      });
      data.treeAnswers = stored;
      if (refused.length) {
        Log.warn({ message: "parseAgentJson: answers " + refused.join(", ") + " are not declared by article " + (data.topicKey || parsed.topicKey) + ", not persisting" });
      }
    }

    // Where the tree ended, if it did. Written by searchKnowledge earlier in this same
    // turn and handed to the graph here: the conditions after the solver can only read
    // the previous function's result, not the task document.
    // Only the solver walks the tree, so only its stage may hand a terminal to the graph.
    // Surfacing it from every stage meant a terminal left over from an earlier turn could
    // still be read by a condition that had no business seeing it.
    if (String(stage || "") === "solver") {
      if (data.treeEnd) parsed.treeEnd = String(data.treeEnd);
      if (data.treeNode) parsed.treeNode = String(data.treeNode);
    }

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
       "attempts", "offeredStep", "preQuestionsAsked",
       // The tree has to start from its root for the new question, and the answers to
       // the old one must not end up in the subtask of the new one.
       "treeNode", "treeAnswers", "treeEnd", "treeHandoverAsked", "treeNext",
       "treeAskedNode"].forEach(k => {
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
      // The tree walk starts over too, so the new question gets its full budget of
      // questions instead of inheriting the score of the one just solved.
      patch["treeStreakNode"] = null;
      patch["treeQuestions"] = 0;
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
    ["attempts", "offeredStep", "preQuestionsAsked", "topicRoute",
     // Bookkeeping of the tree walk: the node ids and the terminal are for the code and
     // the graph. Naming them in the prompt only invites the model to reason about the
     // article's internals instead of answering the partner.
     "treeNode", "treeEnd", "treeHandoverAsked", "treeNext", "treeAskedNode",
     "treeAnswers"].forEach(k => { delete published[k]; });
    AgentContext.putValue({ key: "dialog", value: published });
    // The answers already collected are named explicitly: without them the model asked
    // again for what the partner had told it one turn earlier.
    const collected = Object.keys(data.treeAnswers || {})
      .map(k => k + ": " + data.treeAnswers[k])
      .join("; ");
    const lines = [
      "Уточнённые данные по обращению:",
      "- Юнит: " + (data.unitFullName || "не определён"),
      "- Проблема: " + (data.problemSummary || "не описана"),
      "- Email: " + (data.email || "не указан"),
      "- Тематика: " + (data.topicKey || "не определена"),
      "- Уже собрано по тематике: " + (collected || "ничего")
    ];
    // The keys the article can store, named BEFORE the solver calls the tool: the facts
    // the partner volunteered in his first message are worth most on the very first turn,
    // and until the tool answers there is nothing to read them into.
    const keys = answerKeysOfTopic(data.topicKey).filter(k => !(data.treeAnswers || {})[k]);
    if (keys.length) lines.push("- Ключи ответов статьи: " + keys.join(", "));
    AgentContext.addNote({ text: lines.join("\n") });
  } catch (e) {
    Log.warn({ message: "parseAgentJson: state write failed: " + e });
  }
}

parsed.taskId = taskId;
parsed.agentStage = String(stage || "");
return parsed;
