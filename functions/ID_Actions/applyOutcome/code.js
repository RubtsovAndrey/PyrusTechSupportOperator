const DB_ID = "1000299722-pyrus_bot_database-hul";

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
  }
};

const prev = Context.getLastFunctionResult() || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = prev.taskId || dialog.taskId || null;

// An unknown outcome name would silently do nothing, so escalate instead of guessing.
const spec = OUTCOMES[String(outcome || "")] || OUTCOMES.escalated;
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

let text = replyText || prev.clarifyingQuestion || prev.replyText || spec.defaultReply;

// Left to itself the intake agent asked the partner to confirm a unit he had already
// named, offered "пиццерия или кофейня" in a city with no coffee shops, and wanted to
// know at which moment the error appears — then repeated all of it verbatim on the
// next turn. Only the unit and the essence of the problem are needed, so the wording
// of every routine question is fixed here instead of being generated.
const CLARIFY_TEXT = {
  need_unit_and_problem: "Подскажите, о какой точке идёт речь (город и номер) и что именно сейчас не работает?",
  need_unit: "Подскажите, о какой точке идёт речь — город и номер?",
  need_problem: "Подскажите, что именно сейчас не работает или что произошло?",
  need_business: "Подскажите, это пиццерия или кофейня?",
  need_point_number: "Подскажите, пожалуйста, номер точки."
};

if (String(outcome || "") === "clarify") {
  const kind = String(prev.clarifyKind || "");
  if (CLARIFY_TEXT[kind]) {
    text = CLARIFY_TEXT[kind];
  } else if (String(prev.agentStage || "") === "intake") {
    // No usable kind from the agent: fall back to the facts the task document is
    // still missing. parseAgentJson has already stored this turn's findings.
    const needUnit = !data.unitFullName;
    const needProblem = !data.problemSummary;
    if (needUnit && needProblem) text = CLARIFY_TEXT.need_unit_and_problem;
    else if (needUnit) text = CLARIFY_TEXT.need_unit;
    else if (needProblem) text = CLARIFY_TEXT.need_problem;
  }
}

// Greeting is decided by the real Pyrus thread, not by the model, which got it wrong
// in both directions: it skipped the greeting on the first reply and repeated it later.
const GREETED = /^\s*(добрый|доброе|доброго|здравствуй|приветствую|привет)/i;
if (runtime.isFirstBotReply === true) {
  if (!GREETED.test(String(text))) text = "Добрый день! " + text;
} else if (runtime.isFirstBotReply === false) {
  const stripped = String(text).replace(/^\s*(добрый день|добрый вечер|доброе утро|доброго дня|здравствуйте|здравствуй|приветствую|привет)[\s!,.—–-]*/i, "");
  if (stripped && stripped !== text) {
    text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    Log.info({ message: "applyOutcome: stripped repeated greeting on task " + taskId });
  }
}

const pendingOutcome = {
  kind: String(outcome || "escalated"),
  replyText: text,
  action: spec.action,
  approvalChoice: spec.approvalChoice,
  fieldUpdates: fieldUpdates,
  nextStage: spec.nextStage
};

try {
  Db.put({
    dbIntegration: DB_ID,
    documentKey: "state:" + taskId,
    value: Object.assign({}, state, { pendingOutcome: pendingOutcome, updatedAt: Date.now() })
  });
} catch (e) {
  Log.error({ message: "applyOutcome: state write failed for task " + taskId + ": " + e });
  return { success: false, reason: String(e), taskId: taskId };
}

return { success: true, taskId: taskId, kind: pendingOutcome.kind, nextStage: spec.nextStage };
