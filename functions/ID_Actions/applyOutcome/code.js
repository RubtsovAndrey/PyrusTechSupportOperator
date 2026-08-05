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
    // that predates this convention starts being addressable after one turn.
    value.taskId = Number(taskId);
    Db.put({ dbIntegration: DB_ID, documentKey: key, value: value });
    return true;
  } catch (e) {
    Log.error({ message: who + ": state write lost for " + key + ": " + e });
    return false;
  }
}

// ── Одна форма на подзадачу и на внутреннюю переписку ──
// Читает их один и тот же человек, поэтому и скелет один: кто и где → что случилось →
// что собрали → что пробовали → куда это идёт. Раньше форм было две, с разными
// названиями одних и тех же блоков, и в подзадаче не было сказано даже, кто обращается.
//
// Что печатается всегда, а что только при наличии, решено так: обязательное печатается
// даже пустым, потому что пустота здесь — тоже факт («email не указан» говорит, что
// спросить его не удалось, а «тематика не определена» отличает «статья велела передать»
// от «статьи никто не написал»). Необязательное — собранные ответы и предложенные
// советы — печатается только когда есть: блок «Уже пробовали: ничего» занимает две
// строки и не сообщает ничего.
//
// Один и тот же текст собирается в двух функциях, потому что функции платформы не
// импортируют друг друга. Правку нужно вносить в обе — иначе оператор снова начнёт
// получать два разных документа об одном и том же.
function topicForm(topicKey, nodeId, who) {
  const out = { labels: {}, description: null };
  if (!topicKey) return out;
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "knowledge_catalog" });
    const topics = (doc && doc.value && Array.isArray(doc.value.topics)) ? doc.value.topics : [];
    const topic = topics.filter(t => t && String(t.key || "") === String(topicKey))[0];
    if (!topic) return out;
    out.description = topic.description ? String(topic.description) : null;
    // `label` — как поле называется для человека. Без него печатается сам ключ: он
    // придуман для кода, и «newValue: +79001234567» первой линии ничего не говорит.
    //
    // Один ключ живёт в нескольких ветках, и подпись у него в каждой своя: `newValue` —
    // это «Новый номер телефона» в одной и «Куда перевести» в другой. Слово последней
    // ветки в файле не имеет никакого отношения к тому, о чём был разговор, поэтому
    // побеждает подпись того узла, на котором диалог и закончился.
    const take = force => q => {
      if (!q || !q.key || !q.label) return;
      const key = String(q.key);
      if (force || !out.labels[key]) out.labels[key] = String(q.label);
    };
    Object.keys(topic.nodes || {}).forEach(id => {
      const node = topic.nodes[id] || {};
      (Array.isArray(node.ask) ? node.ask : []).forEach(take(false));
    });
    (Array.isArray(topic.askBeforeHandover) ? topic.askBeforeHandover : []).forEach(take(false));
    // У линейной статьи узлов нет вовсе, и все её подписи — здесь. Строковые
    // вопросы проходят мимо: без ключа их ответа в сводке и не будет.
    (Array.isArray(topic.preQuestions) ? topic.preQuestions : []).forEach(take(false));
    const at = nodeId && topic.nodes ? topic.nodes[String(nodeId)] : null;
    if (at && Array.isArray(at.ask)) at.ask.forEach(take(true));
  } catch (e) {
    Log.warn({ message: who + ": catalog read failed, the summary falls back to raw keys: " + e });
  }
  return out;
}

function requestSummary(o) {
  const data = o.data || {};
  const runtime = o.runtime || {};
  const labels = o.labels || {};
  const answers = data.treeAnswers && typeof data.treeAnswers === "object" ? data.treeAnswers : {};
  // The order the article asked them in — that is also the order they make sense in.
  const keys = Object.keys(answers);
  const attempts = Array.isArray(data.attempts) ? data.attempts : [];
  // A name that is not a string has already reached an operator once, as
  // «Кто обращается: [object Object]».
  const name = typeof runtime.partnerName === "string" && runtime.partnerName ? runtime.partnerName : null;
  const lines = [o.header, ""];
  lines.push("Партнёр: " + [name || "имя не определено", data.email || "email не указан"].join(", "));
  lines.push("Юнит: " + (data.unitFullName || "не определён"));
  lines.push("Тематика: " + (data.topicKey
    ? data.topicKey + (o.description ? " — " + o.description : "") + (o.topicNote || "")
    : "не определена — подходящей статьи в базе нет"));
  lines.push("", "Суть обращения: " + (data.problemSummary || "не описана"));
  if (keys.length) {
    lines.push("", "Собрано у партнёра:");
    keys.forEach(k => lines.push("  " + (labels[k] || k) + ": " + answers[k]));
  }
  // Listed without a verdict: the last advice is written down when it is offered, and
  // whether it helped is exactly what we do not know at the moment of a handover.
  if (attempts.length) {
    lines.push("", "Что уже пробовали:");
    attempts.forEach((a, i) => lines.push("  " + (a.step || i + 1) + ") " + (a.advice || "—")));
  }
  (o.tail || []).filter(Boolean).forEach((t, i) => {
    if (i === 0) lines.push("");
    lines.push(t);
  });
  return lines.join("\n");
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
  // A question asked by the ARTICLE, not by intake. Same reason `clarify_email` exists: the
  // answer has to come back to where the question was asked from. Sent as a plain `clarify`
  // it landed in the `gathering` stage, and the partner's «фамилию» then travelled intake →
  // routing → solver again — two extra model calls per answer on an article that legitimately
  // asks up to a dozen questions, and, far worse, routing was free to overwrite `topicKey`
  // in the middle of a tree walk: `treeNode` then names a node the new article does not have,
  // the walk silently restarts from the root, and the answers already collected stay behind
  // under the keys of the article that is no longer in play.
  clarify_answers: {
    nextStage: "awaiting_answers",
    action: null,
    approvalChoice: null,
    withFieldUpdates: false,
    defaultReply: "Уточните, пожалуйста, детали вопроса."
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
// Every outcome that ends the turn waiting for the partner to say something. All of them
// have to count towards the loop guards, or an article asking its questions through its own
// stage would be exempt from the very limits that exist to stop it looping.
const ASKING = ["clarify", "clarify_email", "clarify_answers"];
const asksSomething = ASKING.indexOf(String(outcome || "")) >= 0;
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
    // Nothing missing and still a question: the partner then got «Уточните, пожалуйста,
    // детали вопроса» three turns running and a handover, while the note in front of the
    // model read «Не хватает для продолжения: ничего, данных достаточно». That decision is
    // now taken away from the model in parseAgentJson, which turns such a turn into a
    // route, so reaching this line means the guard upstream has a hole — hence a warning.
    else Log.warn({ message: "applyOutcome: intake asked '" + (kind || "?") + "' on task " + taskId + " while unit and problem are both known, nothing to ask" });
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
  const form = topicForm(data.topicKey, data.treeNode, "applyOutcome");
  internalNote = requestSummary({
    header: "[Внутренняя переписка]\nБот передаёт обращение оператору.",
    data: data,
    runtime: runtime,
    labels: form.labels,
    description: form.description,
    // For the bot both cases end in a handover, for the operator they are different
    // jobs: an article that routes to a human is a known procedure, no article at all
    // means nobody has written one yet.
    topicNote: data.topicRoute === "escalate" ? " (статья предписывает передать обращение человеку)" : "",
    tail: ["Причина передачи: " + (loopBroken
      ? (overrun
        ? "статья задала больше " + MAX_TREE_QUESTIONS + " вопросов и не пришла ни к решению, ни к подзадаче — похоже на ошибку в самой статье"
        : "бот задал подряд " + MAX_CLARIFY_STREAK + " уточняющих вопроса и не продвинулся")
      : (spec.silent ? "партнёр написал в закрытый чат" : (prev.reason || "не указана")))]
  });
}

// ── Why the Pyrus field updates are NOT built here ──
// They used to be, as a ready `fieldUpdates` array inside `pendingOutcome` — and that put
// an array INSIDE the value of a `$set`, which is the one thing the db adapter cannot
// convert («Failed to convert from ArrayNode to org.bson.Document»). The guard below only
// looked at the top level, so this write passed the guard, failed on the platform and was
// rescued by the whole-document path — the exact read-modify-write every point write here
// exists to avoid, on the busiest branch of all (any escalation with a known unit).
// The array is not needed: it is derived from facts that are already in this document, so
// finalize rebuilds it from them. `withFieldUpdates` is a boolean, and a boolean fits in a
// point write. It also puts the construction of a Pyrus payload in the only function that
// talks to Pyrus, which is where the rest of it already lives.
const pendingOutcome = {
  kind: loopBroken ? "escalated" : String(outcome || "escalated"),
  replyText: text,
  internalNote: internalNote,
  action: spec.action,
  approvalChoice: spec.approvalChoice,
  withFieldUpdates: !!spec.withFieldUpdates,
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
