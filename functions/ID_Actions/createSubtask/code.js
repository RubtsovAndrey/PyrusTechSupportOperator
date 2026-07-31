const DB_ID = "1000299722-pyrus_bot_database-hul";

// Pyrus form and field ids live in the `config` document so they can be changed
// without touching code. The defaults keep the bot working on an empty database.
// `parentLinkFieldId` is the field of the subtask form that holds the number of the parent
// chat — any field the register can filter on, a number field included. It is what makes
// the duplicate check below possible, and it is left unset by default: filling a field
// that the form does not have fails the whole creation.
// `subjectFieldId` and `messageFieldId` are the «Тема» and «Сообщение» fields of the section
// «Входные данные»: that is where the first line looks for the request itself.
const DEFAULTS = {
  subtaskFormId: 1096731, unitFieldId: 97, componentFieldId: 36, emailFieldId: 5,
  subjectFieldId: 1, messageFieldId: 2, parentLinkFieldId: null
};

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
const subjectFieldId = Number(cfg.subjectFieldId || 0) || null;
const messageFieldId = Number(cfg.messageFieldId || 0) || null;

// ── Ask Pyrus, not the database ──
// `state.subtaskId` above only catches a retry that runs after the first one finished.
// Two concurrent webhooks both read it as empty and both create a subtask, and the
// database cannot arbitrate: it has no atomic operation at all — no putIfAbsent, no TTL,
// no upsert. The register is the only shared source that already knows whether the
// subtask exists.
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
  writeState(taskId, { "subtaskId": existing, "updatedAt": Date.now() }, "createSubtask");
  return { success: true, subtaskId: existing, duplicate: true, taskId: taskId };
}

function describe(e) {
  const body = e && (e.body || (e.response && e.response.body));
  return String(e) + (body ? " | Pyrus: " + (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 500) : "");
}

// Everything the person who picks this up has to know. Written into the form rather than
// into a comment: a comment is correspondence, and the request itself belongs in
// «Входные данные», where the first line reads it.
const attempts = Array.isArray(data.attempts) ? data.attempts : [];
// What the article asked the partner, line by line. This is the reason a branching
// article exists: without these lines the first line reads «просят поменять карточку
// сотрудника» and has to start the conversation over.
const answers = data.treeAnswers && typeof data.treeAnswers === "object" ? data.treeAnswers : {};
const answerKeys = Object.keys(answers);
const summaryText = [
  "Обращение передано ботом техподдержки.",
  data.problemSummary ? "Проблема: " + data.problemSummary : null,
  answerKeys.length
    ? "Данные, собранные у партнёра:\n" + answerKeys.map(k => "  " + k + ": " + answers[k]).join("\n")
    : null,
  "Юнит: " + data.unitFullName,
  "Компонент: " + data.componentName,
  data.topicKey ? "Тематика БЗ: " + data.topicKey : null,
  attempts.length
    ? "Уже пробовали:\n" + attempts.map(a => "  " + (a.step || "?") + ") " + (a.advice || "—")).join("\n")
    : "Советы из БЗ не предлагались.",
  "Email партнёра: " + data.email,
  "Родительская задача: №" + taskId
].filter(Boolean).join("\n");

const requiredFields = [
  { id: Number(cfg.unitFieldId), value: { item_name: String(data.unitFullName) } },
  { id: Number(cfg.componentFieldId), value: { item_name: String(data.componentName) } },
  { id: Number(cfg.emailFieldId), value: String(data.email) }
];
const inputFields = [];
if (subjectFieldId) inputFields.push({ id: subjectFieldId, value: String(data.problemSummary || data.componentName) });
if (messageFieldId) inputFields.push({ id: messageFieldId, value: summaryText });

async function create(fields) {
  const resp = await Http.post({
    url: apiUrl + "tasks",
    headers: headers,
    body: {
      form_id: Number(cfg.subtaskFormId),
      parent_task_id: Number(taskId),
      fields: fields
    }
  });
  const created = (resp && resp.body) || resp;
  const id = created && created.task ? created.task.id : null;
  if (!id) throw new Error("no task.id in Pyrus response");
  return id;
}

// A rejected optional field must not cost the subtask: the branch has no other way
// forward, and a ticket without its description still beats no ticket at all. The
// summary then falls back to a comment, which is where it used to live.
let subtaskId = null;
let summaryInForm = inputFields.length > 0;
try {
  subtaskId = await create(requiredFields.concat(inputFields));
} catch (e) {
  if (!inputFields.length) {
    Log.error({ message: "createSubtask failed for task " + taskId + ": " + describe(e) });
    return { success: false, reason: String(e), taskId: taskId };
  }
  Log.warn({ message: "createSubtask: creation with the «Входные данные» fields was rejected for task " + taskId + ", retrying without them: " + describe(e) });
  summaryInForm = false;
  try {
    subtaskId = await create(requiredFields);
  } catch (e2) {
    Log.error({ message: "createSubtask failed for task " + taskId + ": " + describe(e2) });
    return { success: false, reason: String(e2), taskId: taskId };
  }
}

// Remember it before anything else can fail, so a retry cannot duplicate the subtask.
// Only the subtaskId path: the facts in this document may have moved on since the read
// above, and a full rewrite would put the stale ones back.
writeState(taskId, { "subtaskId": Number(subtaskId), "updatedAt": Date.now() }, "createSubtask");

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

// Only when the form could not carry it. No `channel`, so nothing reaches the partner.
if (!summaryInForm) {
  await comment({ text: "[Внутренняя переписка]\n" + summaryText }, "summary comment");
}

// The bot does NOT complete the first workflow step. It used to post `action: "finished"`
// on the fresh subtask and Pyrus answered 400 every time: the created task stands on
// step 1, whose approver is another account («бот Approver», then the role
// «[support] Первая линия»), while our bot is merely the author. The step is not ours
// to finish, and nothing needs finishing: the route already carries the subtask to the
// people who work it.

// Parent task fields are updated by finalize together with the closing comment,
// so no extra request is made here.
return { success: true, subtaskId: Number(subtaskId), taskId: taskId };
