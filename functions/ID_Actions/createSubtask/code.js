const DB_ID = "1000299722-pyrus_bot_database-hul";

// Pyrus form and field ids live in the `config` document so they can be changed
// without touching code. The defaults keep the bot working on an empty database.
const DEFAULTS = { subtaskFormId: 1096731, unitFieldId: 97, componentFieldId: 36, emailFieldId: 5 };

function loadConfig() {
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "config" });
    if (doc && doc.value) return Object.assign({}, DEFAULTS, doc.value);
  } catch (e) {
    Log.warn({ message: "createSubtask: config read failed, using defaults: " + e });
  }
  return DEFAULTS;
}

const prev = Context.getLastFunctionResult() || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = prev.taskId || dialog.taskId || null;

if (!taskId) {
  Log.error({ message: "createSubtask: no taskId" });
  return { success: false, reason: "no taskId" };
}

let state = {};
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (doc && doc.value) state = doc.value;
} catch (e) {
  Log.warn({ message: "createSubtask: state read failed: " + e });
}

// A retried webhook must never produce a second subtask.
if (state.subtaskId) {
  Log.info({ message: "createSubtask: subtask " + state.subtaskId + " already exists for task " + taskId });
  return { success: true, subtaskId: state.subtaskId, duplicate: true, taskId: taskId };
}

const data = state.data || {};
const runtime = state.runtime || {};
const cfg = loadConfig();

if (!data.unitFullName || !data.componentName) {
  return { success: false, reason: "missing unit or component", taskId: taskId };
}

// Email is asked for only on this branch: requiring it from every partner up front
// adds friction to the scenarios that never need it.
if (!data.email) {
  return {
    success: false,
    action: "clarify",
    clarifyingQuestion: "Укажите, пожалуйста, ваш email — на него придёт ответ по обращению.",
    taskId: taskId
  };
}

const apiUrl = runtime.apiUrl || "https://api.pyrus.com/v4/";
const token = runtime.token;
if (!token) {
  return { success: false, reason: "no Pyrus token in task state", taskId: taskId };
}

const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

let subtaskId;
try {
  const resp = await Http.post({
    url: apiUrl + "tasks",
    headers: headers,
    body: {
      form_id: Number(cfg.subtaskFormId),
      parent_task_id: Number(taskId),
      fields: [
        { id: Number(cfg.unitFieldId), value: { item_name: String(data.unitFullName) } },
        { id: Number(cfg.componentFieldId), value: { item_name: String(data.componentName) } },
        { id: Number(cfg.emailFieldId), value: String(data.email) }
      ]
    }
  });
  const created = (resp && resp.body) || resp;
  subtaskId = created && created.task ? created.task.id : null;
  if (!subtaskId) throw new Error("no task.id in Pyrus response");
} catch (e) {
  Log.error({ message: "createSubtask failed for task " + taskId + ": " + e });
  return { success: false, reason: String(e), taskId: taskId };
}

// Remember it before anything else can fail, so a retry cannot duplicate the subtask.
try {
  Db.put({
    dbIntegration: DB_ID,
    documentKey: "state:" + taskId,
    value: Object.assign({}, state, { subtaskId: Number(subtaskId), updatedAt: Date.now() })
  });
} catch (e) {
  Log.error({ message: "createSubtask: could not persist subtaskId " + subtaskId + ": " + e });
}

try {
  await Http.post({
    url: apiUrl + "tasks/" + subtaskId + "/comments",
    headers: headers,
    body: {
      text: [
        "[Внутренняя переписка]",
        "Подзадача создана ботом техподдержки.",
        "Юнит: " + data.unitFullName,
        "Компонент: " + data.componentName,
        data.problemSummary ? "Проблема: " + data.problemSummary : null,
        "Email партнёра: " + data.email,
        "Родительская задача: №" + taskId
      ].filter(Boolean).join("\n")
    }
  });
} catch (e) {
  // The subtask exists; a missing summary comment is not worth failing the turn.
  Log.warn({ message: "createSubtask: summary comment failed: " + e });
}

// Parent task fields are updated by finalize together with the closing comment,
// so no extra request is made here.
return { success: true, subtaskId: Number(subtaskId), taskId: taskId };
