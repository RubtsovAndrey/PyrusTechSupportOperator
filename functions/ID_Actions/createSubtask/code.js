const DB_ID = "1000299722-pyrus_bot_database-hul";

// Pyrus form and field ids live in the `config` document so they can be changed
// without touching code. The defaults keep the bot working on an empty database.
// `parentLinkFieldId` is the form_link field of the subtask form that holds the number of
// the parent chat. It is what makes the duplicate check below possible, and it is left
// unset by default: without it the form has no such field, and filling a field that does
// not exist fails the whole creation.
const DEFAULTS = {
  subtaskFormId: 1096731, unitFieldId: 97, componentFieldId: 36, emailFieldId: 5,
  parentLinkFieldId: null
};

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
const linkFieldId = Number(cfg.parentLinkFieldId || 0) || null;

// ── Ask Pyrus, not the database ──
// `state.subtaskId` above only catches a retry that runs after the first one finished.
// Two concurrent webhooks both read it as empty and both create a subtask, and the
// database cannot arbitrate: it has no atomic operation, and updateByFilters reports
// neither matchedCount nor modifiedCount, so a claim cannot be told from a no-op.
// The register is the only shared source that already knows whether the subtask exists.
// `eq.` forces exact matching instead of a loose contains.
async function findExistingSubtask() {
  if (!linkFieldId) return null;
  try {
    const url = apiUrl + "forms/" + Number(cfg.subtaskFormId) + "/register" +
      "?fld" + linkFieldId + "=eq." + Number(taskId);
    const resp = await Http.get({ url: url, headers: headers });
    const body = (resp && resp.body) || resp || {};
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const found = tasks.find(t => t && t.id);
    return found ? Number(found.id) : null;
  } catch (e) {
    // A failed lookup must not block the branch: at worst we are back to the old
    // behaviour and may create a second subtask.
    Log.warn({ message: "createSubtask: register lookup failed for task " + taskId + ", creating anyway: " + e });
    return null;
  }
}

const existing = await findExistingSubtask();
if (existing) {
  Log.info({ message: "createSubtask: Pyrus register already has subtask " + existing + " for task " + taskId + ", not creating a second one" });
  try {
    Db.updateByFilters({
      dbIntegration: DB_ID,
      filters: { documentKey: "state:" + taskId },
      operator: { $set: { "value.subtaskId": existing, "value.updatedAt": Date.now() } }
    });
  } catch (e) {
    Log.warn({ message: "createSubtask: could not adopt subtask " + existing + ": " + e });
  }
  return { success: true, subtaskId: existing, duplicate: true, taskId: taskId };
}

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
// Only the subtaskId path: the facts in this document may have moved on since the read
// above, and a full rewrite would put the stale ones back.
try {
  Db.updateByFilters({
    dbIntegration: DB_ID,
    filters: { documentKey: "state:" + taskId },
    operator: { $set: { "value.subtaskId": Number(subtaskId), "value.updatedAt": Date.now() } }
  });
} catch (e) {
  Log.error({ message: "createSubtask: could not persist subtaskId " + subtaskId + ": " + e });
}

// Two requests where there used to be one. A single comment carrying both the summary
// and `action: "finished"` failed as a whole — Pyrus answered 400 — and the subtask was
// left without the summary AND standing on its first step, so nobody picked it up.
// Split, one failure can no longer cost both.
function describe(e) {
  const body = e && (e.body || (e.response && e.response.body));
  return String(e) + (body ? " | Pyrus: " + (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 500) : "");
}

async function comment(body, what) {
  try {
    await Http.post({ url: apiUrl + "tasks/" + subtaskId + "/comments", headers: headers, body: body });
    return true;
  } catch (e) {
    Log.warn({ message: "createSubtask: " + what + " failed on subtask " + subtaskId + ": " + describe(e) });
    return false;
  }
}

// The link back to the parent chat is written as its own request, after the subtask
// exists. Sent inside the creation body, a wrong value shape would fail the creation
// itself; here the worst case is that the next run cannot find this subtask in the
// register — which is exactly where we were before. The shape of a form_link value is
// not documented among what we have, so both plausible forms are tried once.
async function linkToParent() {
  if (!linkFieldId) return;
  const shapes = [{ task_id: Number(taskId) }, Number(taskId)];
  for (let i = 0; i < shapes.length; i++) {
    try {
      await Http.post({
        url: apiUrl + "tasks/" + subtaskId + "/comments",
        headers: headers,
        body: { field_updates: [{ id: linkFieldId, value: shapes[i] }] }
      });
      Log.info({ message: "createSubtask: linked subtask " + subtaskId + " to parent " + taskId + " (field " + linkFieldId + ")" });
      return;
    } catch (e) {
      Log.warn({ message: "createSubtask: link shape " + (i + 1) + " rejected for field " + linkFieldId + ": " + describe(e) });
    }
  }
  Log.error({ message: "createSubtask: subtask " + subtaskId + " left unlinked to parent " + taskId + "; the duplicate check cannot see it" });
}

await linkToParent();

// The summary goes into the internal correspondence: no `channel`, so nothing of it
// reaches the partner.
const attempts = Array.isArray(data.attempts) ? data.attempts : [];
await comment({
  text: [
    "[Внутренняя переписка]",
    "Подзадача создана ботом техподдержки.",
    "Юнит: " + data.unitFullName,
    "Компонент: " + data.componentName,
    data.problemSummary ? "Проблема: " + data.problemSummary : null,
    data.topicKey ? "Тематика БЗ: " + data.topicKey : null,
    attempts.length
      ? "Уже пробовали:\n" + attempts.map(a => "  " + (a.step || "?") + ") " + (a.advice || "—")).join("\n")
      : null,
    "Email партнёра: " + data.email,
    "Родительская задача: №" + taskId
  ].filter(Boolean).join("\n")
}, "summary comment");

// Completing the current workflow step is what moves the subtask on to the people who
// have to work it, so it is worth its own request even if the summary did not go in.
await comment({ action: "finished" }, "step advance");

// Parent task fields are updated by finalize together with the closing comment,
// so no extra request is made here.
return { success: true, subtaskId: Number(subtaskId), taskId: taskId };
