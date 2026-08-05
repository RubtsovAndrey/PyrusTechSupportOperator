const DB_ID = "1000299722-pyrus_bot_database-hul";

// Pyrus form and field ids live in the `config` document so they can be changed
// without touching code. The defaults keep the bot working on an empty database.
// `parentLinkFieldId` is the field of the subtask form that holds the number of the parent
// chat — any field the register can filter on, a number field included. It is what makes
// the duplicate check below possible, and it is left unset by default: filling a field
// that the form does not have fails the whole creation.
// `subjectFieldId` and `messageFieldId` are the «Тема» and «Сообщение» fields of the section
// «Входные данные»: that is where the first line looks for the request itself.
// ── ВНИМАНИЕ: сейчас здесь ТЕСТОВАЯ форма ──
// `subtaskFormId: 2454249` — копия продовой формы 1096731, на ней же идут тесты тикетов.
// Перед выходом в прод заменить обратно на 1096731 (и форму чатов — на продовую).
//
// ── Почему номеров полей здесь больше нет ──
// Раньше здесь стояли `unitFieldId: 97, componentFieldId: 36, emailFieldId: 5,
// subjectFieldId: 1, messageFieldId: 2` — номера продовой формы. Копия формы
// ПЕРЕНУМЕРОВАЛА поля: «Юнит» стал 35, «Компонент» 28, «Эл. почта» 44, «Тема» 47,
// «Сообщение» 48, а поля 97 не существует вовсе, 1 и 2 оказались заметками, 5 — статусом
// «Открыта / Завершена». Pyrus отвечал 400 на создание подзадачи, оба раза — и с полями
// «Входных данных», и без них, потому что неверна была и обязательная тройка.
// Номер поля не может иметь значения по умолчанию: он свой у каждой формы. Поля ищутся
// ПО ИМЕНИ в описании формы — тем же способом, которым `receiveWebhook` уже находит
// «Юнит» и «Компонент» в отвечаемой задаче. Номер в `config` по-прежнему побеждает, если
// поле придётся приколотить вручную.
const DEFAULTS = {
  subtaskFormId: 2454249,
  unitFieldId: null, componentFieldId: null, emailFieldId: null,
  subjectFieldId: null, messageFieldId: null, parentLinkFieldId: null
};

// Имена полей формы подзадачи. Переопределяются через `config.fieldNames`, если на другой
// форме они называются иначе. Сравнение ТОЧНОЕ: на форме есть и «Тема» (47), и «Тема
// обращения» (25), и «Тема обращения (вручную)» (26) — поиск по вхождению взял бы не то.
const FIELD_NAMES = {
  unitFieldId: ["Юнит"],
  componentFieldId: ["Компонент"],
  emailFieldId: ["Эл. почта", "Электронная почта", "Email", "E-mail", "Почта"],
  subjectFieldId: ["Тема"],
  messageFieldId: ["Сообщение"]
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

// ── A ticket has no subtask to create: the ticket IS the subtask ──
// The article may still route here — `route: "subtask"`, `treeEnd: "subtask"`, an `onFail`
// that says subtask — because the catalog describes the problem, not the form the dialog
// happens to live on. Refusing with a plain failure is all that is needed: the graph already
// carries `success: false` without `action: "clarify"` through `cond_subtask_created` and
// `cond_subtask_needs_email` to the escalation. No new node, no change to the OUTCOMES table.
if (String(runtime.role || "") === "ticket") {
  Log.info({ message: "createSubtask: task " + taskId + " is a ticket, which already is the subtask — handing over to an operator instead" });
  return { success: false, reason: "the task is a ticket: it already is the subtask", taskId: taskId };
}

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

// `apiUrl` comes from the document on purpose: receiveWebhook is the one place that checks
// it against the host allowlist, and re-reading it from the payload here would mean either
// duplicating that check or dropping it.
const apiUrl = runtime.apiUrl || "https://api.pyrus.com/v4/";
// The token comes from the payload of THIS request first: everything that talks to Pyrus
// runs inside the webhook that brought it, so the copy in the document — one per task, for
// as long as the task lives — is never actually needed. It stays as a fallback for a turn
// whose payload cannot be read, and finalize wipes it at the end of the turn.
const token = (function () {
  try {
    const own = (Context.getMessageContent() || {}).payload || {};
    if (own.access_token) return own.access_token;
  } catch (e) {
    Log.warn({ message: "createSubtask: own payload unreadable, taking the token from the document: " + e });
  }
  return runtime.token;
})();
if (!token) {
  return { success: false, reason: "no Pyrus token in task state", taskId: taskId };
}

const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

// ── Номера полей целевой формы, по именам ──
// Описание формы — единственный источник, который знает их для ЭТОЙ формы. Один лишний GET
// на создание подзадачи, а подзадача создаётся раз на обращение.
// Вложенность в описании формы задокументирована у нас хуже, чем в задаче (там это
// `f.value.fields`), поэтому принимаются все правдоподобные варианты, а если ничего не
// нашлось — печатается то, что нашлось, чтобы один прогон закрыл вопрос.
function flattenFormFields(fields, out) {
  (Array.isArray(fields) ? fields : []).forEach(f => {
    if (!f || typeof f !== "object") return;
    out.push(f);
    const nested = (f.value && f.value.fields) || f.fields || (f.info && f.info.fields);
    if (Array.isArray(nested)) flattenFormFields(nested, out);
  });
  return out;
}

async function resolveFieldIds() {
  const wanted = Object.keys(FIELD_NAMES);
  const names = Object.assign({}, FIELD_NAMES, (cfg.fieldNames && typeof cfg.fieldNames === "object") ? cfg.fieldNames : {});
  const ids = {};
  // A number pinned in `config` wins: it is the escape hatch for a form whose field is
  // named unexpectedly, and asking Pyrus about it would be pointless work.
  wanted.forEach(k => { const v = Number(cfg[k] || 0) || null; if (v) ids[k] = v; });
  if (wanted.every(k => ids[k])) return ids;

  let formFields = [];
  try {
    const resp = await Http.get({ url: apiUrl + "forms/" + Number(cfg.subtaskFormId), headers: headers });
    const body = (resp && resp.body) || resp || {};
    const raw = body.fields || (body.form && body.form.fields) || [];
    formFields = flattenFormFields(raw, []);
  } catch (e) {
    Log.error({ message: "createSubtask: could not read form " + cfg.subtaskFormId + ": " + describe(e) });
    return ids;
  }

  wanted.forEach(k => {
    if (ids[k]) return;
    const candidates = Array.isArray(names[k]) ? names[k] : [names[k]];
    const hit = formFields.find(f => candidates.some(n => String(f.name || "").trim() === String(n)));
    if (hit) ids[k] = Number(hit.id);
  });

  const missing = wanted.filter(k => !ids[k]);
  if (missing.length) {
    Log.error({
      message: "createSubtask: на форме " + cfg.subtaskFormId + " не нашлись поля " + missing.join(", ") +
        ". Поля формы: " + formFields.map(f => (f.name || "?") + ":" + (f.id || "?") + ":" + (f.type || "?")).join(", ")
    });
  }
  return ids;
}
const linkFieldId = Number(cfg.parentLinkFieldId || 0) || null;

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
// What the article asked the partner, line by line. This is the reason a branching
// article exists: without these lines the first line reads «просят поменять карточку
// сотрудника» and has to start the conversation over.
const form = topicForm(data.topicKey, data.treeNode, "createSubtask");
const summaryText = requestSummary({
  header: "Обращение передано ботом техподдержки.",
  data: data,
  runtime: runtime,
  labels: form.labels,
  description: form.description,
  tail: ["Компонент: " + data.componentName, "Родительская задача: №" + taskId]
});

const fieldIds = await resolveFieldIds();

// Без обязательной тройки подзадачу создавать нечем: неверный номер поля Pyrus отвергает
// целиком, а не частично, так что попытка «отправим что есть» стоила бы обращения. Ошибка
// уходит в граф, и он существующей цепочкой условий передаёт обращение оператору — а лог
// выше уже перечислил все поля формы, так что чинится это одной правкой `config`.
if (!fieldIds.unitFieldId || !fieldIds.componentFieldId || !fieldIds.emailFieldId) {
  return {
    success: false,
    reason: "на форме " + cfg.subtaskFormId + " не найдены обязательные поля подзадачи (Юнит / Компонент / Эл. почта)",
    taskId: taskId
  };
}

const requiredFields = [
  { id: fieldIds.unitFieldId, value: { item_name: String(data.unitFullName) } },
  { id: fieldIds.componentFieldId, value: { item_name: String(data.componentName) } },
  { id: fieldIds.emailFieldId, value: String(data.email) }
];
const inputFields = [];
if (fieldIds.subjectFieldId) inputFields.push({ id: fieldIds.subjectFieldId, value: String(data.problemSummary || data.componentName) });
if (fieldIds.messageFieldId) inputFields.push({ id: fieldIds.messageFieldId, value: summaryText });

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
