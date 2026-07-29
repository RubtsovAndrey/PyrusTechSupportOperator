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

// The model is told to greet only in its first reply and ignores that regularly, so
// a repeated greeting is cut here. runtime.isFirstBotReply is computed from the real
// Pyrus thread, which makes this decision independent of the model.
if (runtime.isFirstBotReply === false) {
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
