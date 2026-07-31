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
    // that predates this convention starts being addressable after one turn.
    value.taskId = Number(taskId);
    Db.put({ dbIntegration: DB_ID, documentKey: key, value: value });
    return true;
  } catch (e) {
    Log.error({ message: who + ": state write lost for " + key + ": " + e });
    return false;
  }
}

// The whole state machine in one table. Adding a scenario means adding a row here
// plus one node in the graph, and nothing else changes.
const OUTCOMES = {
  clarify: {
    nextStage: "gathering",
    action: null,
    approvalChoice: null,
    withFieldUpdates: false,
    defaultReply: "Уточните, пожалуйста, детали вопроса."
  },
  // Asking for the email is the one clarification that must come back to where it was
  // asked from. Sent as a plain clarify, the answer "a@b.ru" landed in the intake stage
  // and travelled the whole pipeline again: intake, routing, solver — and the partner
  // got a solution he had already been given instead of the subtask he was waiting for.
  clarify_email: {
    nextStage: "awaiting_email",
    action: null,
    approvalChoice: null,
    withFieldUpdates: false,
    defaultReply: "Укажите, пожалуйста, ваш email — на него придёт ответ по обращению."
  },
  reply: {
    nextStage: "awaiting_confirmation",
    action: null,
    approvalChoice: null,
    withFieldUpdates: false,
    defaultReply: "Понадобится время на изучение вопроса, мы вернёмся с ответом."
  },
  solved: {
    nextStage: "closed",
    action: "finished",
    approvalChoice: null,
    withFieldUpdates: true,
    defaultReply: "Рад был помочь! Если появятся новые вопросы, обращайтесь."
  },
  escalated: {
    nextStage: "escalated",
    action: null,
    approvalChoice: "approved",
    withFieldUpdates: true,
    defaultReply: "Понадобится время на изучение вопроса, мы вернёмся с ответом."
  },
  subtask_created: {
    nextStage: "closed",
    action: "finished",
    approvalChoice: null,
    withFieldUpdates: true,
    defaultReply: "Обращение создано и передано специалистам. Мы вернёмся с ответом на ваш email."
  },
  // A chat the partner reopened after it was closed goes to the operator without a
  // word to the partner: the bot has nothing to add, and an automatic "we will get
  // back to you" on top of a finished conversation only reads as noise.
  handover_silent: {
    nextStage: "escalated",
    action: null,
    approvalChoice: "approved",
    withFieldUpdates: true,
    defaultReply: null,
    silent: true
  }
};

const prev = Context.getLastFunctionResult() || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = prev.taskId || dialog.taskId || null;

// An unknown outcome name would silently do nothing, so escalate instead of guessing.
let spec = OUTCOMES[String(outcome || "")] || OUTCOMES.escalated;
if (!OUTCOMES[String(outcome || "")]) {
  Log.error({ message: "applyOutcome: unknown outcome '" + outcome + "', escalating task " + taskId });
}

if (!taskId) {
  Log.error({ message: "applyOutcome: no taskId, cannot record outcome" });
  return { success: false, reason: "no taskId" };
}

let state = {};
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (doc && doc.value) state = doc.value;
} catch (e) {
  Log.warn({ message: "applyOutcome: state read failed: " + e });
}

const data = state.data || {};
const runtime = state.runtime || {};

// Insurance against the failure a partner actually lived through: asked for the unit,
// then for the problem, then for the unit again, four times over. The question is now
// composed from the task document, which removes the cause, but no future defect in an
// agent may be allowed to hold a partner in that loop — after this many questions in a
// row a human takes over, and the summary tells him what the bot could not collect.
const MAX_CLARIFY_STREAK = 3;
// A branching article legitimately asks question after question, so the streak alone
// cannot bound it. This does: a tree deeper than this is an error in the article, not a
// dialog, and the partner must not pay for it.
const MAX_TREE_QUESTIONS = 12;
const isClarify = String(outcome || "") === "clarify";
const asksSomething = isClarify || String(outcome || "") === "clarify_email";
let clarifyStreak = asksSomething ? (Number(state.clarifyStreak) || 0) + 1 : 0;
let loopBroken = false;
let overrun = false;

// Counting questions was the wrong measure. Three in a row is a loop only when they
// achieve nothing: walking the tree of an article asks «что именно менять», then «на
// какое значение», then «по какой причине» — three questions that are pure progress, and
// the old counter handed such a dialog to an operator one question before the subtask it
// was about to create. What separates the two is movement: a question asked from a node
// the dialog has not stood on before advanced the article; a question asked from the same
// node again did not.
const treeNode = data.treeNode ? String(data.treeNode) : null;
const treeMoved = !!treeNode && treeNode !== String(state.treeStreakNode || "");
let treeQuestions = Number(state.treeQuestions) || 0;
if (asksSomething && treeMoved) {
  treeQuestions += 1;
  clarifyStreak = 1;
}
if (treeQuestions > MAX_TREE_QUESTIONS) {
  Log.error({ message: "applyOutcome: article " + (data.topicKey || "?") + " asked more than " + MAX_TREE_QUESTIONS + " questions on task " + taskId + ", its tree is probably looping" });
  overrun = true;
}
if (clarifyStreak > MAX_CLARIFY_STREAK || overrun) {
  if (!overrun) Log.warn({ message: "applyOutcome: " + (clarifyStreak - 1) + " clarifying questions in a row on task " + taskId + " without moving on, handing over to an operator" });
  spec = OUTCOMES.escalated;
  loopBroken = true;
  clarifyStreak = 0;
}

// Pyrus field updates are built here only, instead of being repeated in every action.
let fieldUpdates = null;
if (spec.withFieldUpdates) {
  const updates = [];
  if (runtime.unitFieldId && data.unitFullName) {
    updates.push({ id: Number(runtime.unitFieldId), value: { item_name: String(data.unitFullName) } });
  }
  if (runtime.componentFieldId && data.componentName) {
    updates.push({ id: Number(runtime.componentFieldId), value: { item_name: String(data.componentName) } });
  }
  if (updates.length) fieldUpdates = updates;
}

let text = spec.silent ? null : (replyText || prev.clarifyingQuestion || prev.replyText || spec.defaultReply);

// Left to itself the intake agent asked the partner to confirm a unit he had already
// named, offered "пиццерия или кофейня" in a city with no coffee shops, and wanted to
// know at which moment the error appears — then repeated all of it verbatim on the
// next turn. Only the unit and the essence of the problem are needed, so the wording
// of every routine question is fixed here instead of being generated.
//
// The question is also COMPOSED from what the task document is missing rather than
// picked by the agent. Letting the agent choose one of these produced the loop the
// partner saw: it asked for the unit, then for the problem, then for the unit again,
// because each turn it named a single missing fact and got a single fact back. Asking
// for everything that is still missing at once cannot loop — the question shrinks with
// every answer, and when nothing is left there is nothing to ask.
const UNIT_QUESTION = {
  need_business: "это пиццерия или кофейня",
  need_point_number: "номер точки",
  // Asked when the partner writes on behalf of a whole network: the point number is
  // deliberately not requested, any point of that network will do.
  need_city_and_business: "о каком городе идёт речь и это пиццерии или кофейни",
  need_city: "о каком городе идёт речь"
};
const UNIT_QUESTION_DEFAULT = "о какой точке идёт речь — город и номер";
const PROBLEM_QUESTION = "что именно сейчас не работает или что произошло";

if (isClarify && !loopBroken) {
  const kind = String(prev.clarifyKind || "");
  // The solver also clarifies, but about the problem itself, and its wording is the
  // only thing that can carry the article's question — leave it alone.
  const fromIntake = String(prev.agentStage || "") === "intake" || kind.indexOf("need_") === 0;
  if (fromIntake) {
    const parts = [];
    if (!data.unitFullName) parts.push(UNIT_QUESTION[kind] || UNIT_QUESTION_DEFAULT);
    if (!data.problemSummary) parts.push(PROBLEM_QUESTION);
    if (parts.length) text = "Подскажите, " + parts.join(", а также ") + "?";
    else Log.info({ message: "applyOutcome: intake asked '" + (kind || "?") + "' on task " + taskId + " while unit and problem are both known" });
  }
}

if (loopBroken) text = spec.defaultReply;

// Greeting is decided by the real Pyrus thread, not by the model, which got it wrong
// in both directions: it skipped the greeting on the first reply and repeated it later.
const GREETED = /^\s*(добрый|доброе|доброго|здравствуй|приветствую|привет)/i;
if (!text) {
  // Nothing to say: leave it that way.
} else if (runtime.isFirstBotReply === true) {
  if (!GREETED.test(String(text))) text = "Добрый день! " + text;
} else if (runtime.isFirstBotReply === false) {
  const stripped = String(text).replace(/^\s*(добрый день|добрый вечер|доброе утро|доброго дня|здравствуйте|здравствуй|приветствую|привет)[\s!,.—–-]*/i, "");
  if (stripped && stripped !== text) {
    text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    Log.info({ message: "applyOutcome: stripped repeated greeting on task " + taskId });
  }
}

// An operator picking up the thread should not have to read the whole chat. The
// summary goes to the internal correspondence, so the partner never sees it.
let internalNote = null;
if (spec.nextStage === "escalated") {
  const attempts = Array.isArray(data.attempts) ? data.attempts : [];
  const tried = attempts.length
    ? attempts.map((a, i) => "  " + (a.step || i + 1) + ") " + (a.advice || "—")).join("\n")
    : "  ничего не предлагалось";
  const who = [runtime.partnerName, data.unitFullName ? "юнит " + data.unitFullName : null, data.email]
    .filter(Boolean).join(", ");
  // Everything the article managed to ask before giving up. For the long guided cases
  // this is the whole value of the handover: the operator continues from where the bot
  // stopped instead of asking the partner the same five questions again.
  const answers = data.treeAnswers && typeof data.treeAnswers === "object" ? data.treeAnswers : {};
  const answerKeys = Object.keys(answers);
  internalNote = [
    "[Внутренняя переписка]",
    "Бот передаёт обращение оператору.",
    "Кто обращается: " + (who || "не определено"),
    "Суть проблемы: " + (data.problemSummary || "не описана"),
    (answerKeys.length
      ? "Собрано по тематике:\n" + answerKeys.map(k => "  " + k + ": " + answers[k]).join("\n")
      : null),
    // For the bot both cases end in a handover, for the operator they are different
    // jobs: an article that routes to a human is a known procedure, no article at all
    // means nobody has written one yet.
    (data.topicKey
      ? "Тематика БЗ: " + data.topicKey +
        (data.topicRoute === "escalate" ? " (статья предписывает передать обращение человеку)" : "")
      : "Тематика БЗ: не определена — подходящей статьи в базе нет"),
    "Уже пробовали:",
    tried,
    "Причина передачи: " + (loopBroken
      ? (overrun
        ? "статья задала больше " + MAX_TREE_QUESTIONS + " вопросов и не пришла ни к решению, ни к подзадаче — похоже на ошибку в самой статье"
        : "бот задал подряд " + MAX_CLARIFY_STREAK + " уточняющих вопроса и не продвинулся")
      : (spec.silent ? "партнёр написал в закрытый чат" : (prev.reason || "не указана")))
    // A null line means there was nothing to put on it; it must not print as "null".
  ].filter(Boolean).join("\n");
}

const pendingOutcome = {
  kind: loopBroken ? "escalated" : String(outcome || "escalated"),
  replyText: text,
  internalNote: internalNote,
  action: spec.action,
  approvalChoice: spec.approvalChoice,
  fieldUpdates: fieldUpdates,
  nextStage: spec.nextStage
};

// Only the two paths this function owns. Writing the whole document put back the facts
// as they were when this run read it, undoing anything the agents of a concurrent turn
// had collected in between.
// This write is the one the partner depends on: without pendingOutcome finalize has
// nothing to say and hands the chat to an operator.
if (!writeState(taskId, {
  "pendingOutcome": pendingOutcome,
  "clarifyStreak": clarifyStreak,
  // Which node the streak was last counted at, so the next turn can tell a question that
  // moved the article on from one that asked the same thing again.
  "treeStreakNode": treeNode,
  "treeQuestions": treeQuestions,
  "updatedAt": Date.now()
}, "applyOutcome")) {
  return { success: false, reason: "state write lost", taskId: taskId };
}

return { success: true, taskId: taskId, kind: pendingOutcome.kind, nextStage: spec.nextStage };
