const DB_ID = "1000299722-pyrus_bot_database-hul";

// Pyrus form and field ids live in the `config` document so they can be changed
// without touching code. The defaults keep the bot working on an empty database.
// `subjectFieldId` and `messageFieldId` are the «Тема» and «Сообщение» fields of the section
// «Входные данные»: that is where the first line looks for the request itself.
// Этот репозиторий целиком тестовый, поэтому безопасный default — копия формы тикетов
// 2454249. Продовая форма 1096731 может быть включена только отдельной конфигурацией
// другого, продуктивного проекта; этот тестовый проект не должен писать в неё при пустой БД.
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
  subjectFieldId: null, messageFieldId: null,
  // A claim is kept briefly when Pyrus may have accepted a request whose HTTP response
  // was lost. A later webhook first looks through the native linked tasks and only then
  // may take the claim over. This is a safety delay, not a business timeout.
  subtaskClaimTtlMs: 120000
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

// ── Текст саммари лежит ШАБЛОНОМ, и шаблон правится без деплоя ──
// `config.summary.operator` и `config.summary.subtask` в документе БД перекрывают то, что
// ниже. Смысл в том, что формулировки и порядок строк меняются чаще всего, а раньше за
// каждую запятую приходилось платить деплоем — и правкой в двух файлах сразу.
// Плейсхолдеры в фигурных скобках перечислены в `summaryFields`. Неизвестный плейсхолдер
// остаётся в тексте как есть: опечатку в `config` лучше увидеть, чем съесть.
//
// Имени партнёра здесь больше нет, и это не упрощение. Оно бралось из `author`
// комментария, а у обращения из веб-виджета автор — служебный аккаунт Pyrus: оператор
// читал «Партнёр: Pyrus.com» и мог принять это за название организации (видно в выгрузке
// живого чата). Настоящего имени у веб-виджета нет вовсе — `Anonymous user`, — а отвечают
// партнёру по каналу задачи, а не по имени, так что строка не помогала никому.
const SUMMARY = {
  operator: [
    "[Внутренняя переписка]",
    "Бот передаёт обращение оператору.",
    "",
    "Юнит: {unit}",
    "Язык: {language}",
    "Домен юнита: {unitDomain}",
    "Email: {email}",
    "Тематика: {topic}",
    "Суть: {problem}",
    "{collected}{tried}",
    "Причина передачи: {reason}"
  ].join("\n"),
  subtask: [
    "Обращение передано ботом техподдержки.",
    "",
    "Юнит: {unit}",
    "Email: {email}",
    "Тематика: {topic}",
    "Суть: {problem}",
    "{collected}{tried}",
    "Компонент: {component}",
    "Родительская задача: №{parent}"
  ].join("\n")
};

// Описание тематики — это список формулировок партнёра для поиска, а не название для
// человека: оператору уезжало полторы строки синонимов вроде «нет интернета в пиццерии,
// нет связи в кофейне, не открывается Додо ИС, пропал интернет, не грузятся сайты».
const TOPIC_DESCRIPTION_LIMIT = 70;

function summaryFields(o) {
  const data = o.data || {};
  const labels = o.labels || {};
  const answers = data.treeAnswers && typeof data.treeAnswers === "object" ? data.treeAnswers : {};
  const attempts = Array.isArray(data.attempts) ? data.attempts : [];
  // Блок печатается только когда в нём что-то есть: «Уже пробовали: ничего» занимает две
  // строки и не сообщает ничего.
  const block = (title, rows) => (rows.length ? "\n" + title + ":\n" + rows.join("\n") + "\n" : "");
  const short = s => {
    const one = String(s || "").replace(/\s+/g, " ").trim();
    return one.length > TOPIC_DESCRIPTION_LIMIT ? one.slice(0, TOPIC_DESCRIPTION_LIMIT) + "…" : one;
  };
  return {
    // Обязательное печатается даже пустым: пустота здесь тоже факт. «Email: не указан»
    // говорит, что спросить его не удалось, а «тематика не определена» отличает «статья
    // велела передать» от «статьи никто не написал».
    unit: data.unitFullName || "не определён",
    language: data.partnerLanguage || "русский (рабочее предположение)",
    unitDomain: businessDomainOf(data.unitFullName) || "не определён (рабочее предположение РФ)",
    email: data.email || "не указан",
    topic: data.topicKey
      ? data.topicKey + (o.description ? " — " + short(o.description) : "") + (o.topicNote || "")
      : "не определена — подходящей статьи в базе нет",
    problem: data.problemSummary || "не описана",
    // Порядок — тот, в котором статья спрашивала: в нём ответы и читаются.
    collected: block("Собрано у партнёра",
      Object.keys(answers).map(k => "  " + (labels[k] || k) + ": " + answers[k])),
    // Без вердикта: совет записывается в момент выдачи, а помог ли он — ровно то, чего мы
    // в момент передачи не знаем.
    tried: block("Что уже пробовали",
      attempts.map((a, i) => "  " + (a.step || i + 1) + ") " + (a.advice || "—"))),
    reason: o.reason || "не указана",
    component: data.componentName || "не определён",
    parent: o.parent || "—"
  };
}

function businessDomainOf(unitFullName) {
  const match = /^\s*\[([^\]]+)\]/.exec(String(unitFullName || ""));
  return match ? String(match[1]).trim().toLowerCase() : null;
}

function render(tpl, fields) {
  return String(tpl)
    .replace(/\{(\w+)\}/g, (m, k) => (fields[k] === undefined ? m : String(fields[k])))
    // Пустой блок не должен оставлять после себя дыру в две пустые строки.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summaryTemplate(cfg, which) {
  const custom = cfg && cfg.summary && typeof cfg.summary === "object" ? cfg.summary[which] : null;
  return typeof custom === "string" && custom.trim() ? custom : SUMMARY[which];
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

// Unlike writeState, this helper deliberately has no whole-document fallback. It is used
// for ownership transitions: if compare-and-set did not match exactly one document, this
// run did not acquire the right to create or finish anything.
function pointUpdate(filters, paths) {
  try {
    const res = Db.updateByFilters({
      dbIntegration: DB_ID,
      filters: filters,
      operator: { $set: paths }
    });
    return !!(res && Number(res.count) === 1);
  } catch (e) {
    Log.error({ message: "createSubtask: atomic state update failed: " + e });
    return false;
  }
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

const data = state.data || {};
const runtime = state.runtime || {};
const cfg = loadConfig();
const configuredClaimTtl = Number(cfg.subtaskClaimTtlMs);
// A typo or an aggressive zero must not silently remove the safety window.
const claimTtlMs = isFinite(configuredClaimTtl) && configuredClaimTtl >= 30000
  ? configuredClaimTtl : DEFAULTS.subtaskClaimTtlMs;
const requestKey = state.subtaskRequestKey ? String(state.subtaskRequestKey) : null;
const runToken = String(taskId) + "|" + String(runtime.incomingCommentId || "turn") +
  "|" + Date.now() + "|" + Math.random();

// The creation owner keeps the claim until finalize has successfully closed the parent.
// A run arriving in the small gap between those two operations therefore cannot post the
// same closing message. If finalize failed, a later retry may take the claim over after
// the safety window and finish the already-created subtask path without creating again.
if (state.subtaskId && state.subtaskIntegrity === "complete") {
  const old = state.subtaskClaim ? String(state.subtaskClaim) : null;
  const claimAt = Number(state.subtaskClaimAt || state.updatedAt || Date.now());
  const fresh = !!old && Date.now() - claimAt < claimTtlMs;
  if (fresh) {
    return { success: false, skip: true, deferred: true,
      reason: "the completed subtask is still being finalized by another run", taskId: taskId };
  }
  const filters = {
    taskId: Number(taskId),
    subtaskId: state.subtaskId,
    subtaskIntegrity: "complete",
    subtaskClaim: old
  };
  if (requestKey) filters.subtaskRequestKey = requestKey;
  if (!pointUpdate(filters, {
    subtaskClaim: runToken, subtaskClaimAt: Date.now(), updatedAt: Date.now()
  })) {
    return { success: false, skip: true, deferred: true,
      reason: "another run is finalizing the completed subtask", taskId: taskId };
  }
  Log.info({ message: "createSubtask: complete subtask " + state.subtaskId + " already exists for task " + taskId });
  return { success: true, subtaskId: state.subtaskId, duplicate: true, taskId: taskId };
}

// ── A ticket has no subtask to create: the ticket IS the subtask ──
// The article may still route here — `route: "subtask"`, `treeEnd: "subtask"`, an `onFail`
// that says subtask — because the catalog describes the problem, not the form the dialog
// happens to live on. Refusing with a plain failure is all that is needed: the graph already
// carries an ordinary `success: false` through `cond_subtask_deferred` and
// `cond_subtask_needs_email` to the escalation. Only an atomic-claim loser has `skip: true`.
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
// The key is assigned when receiveWebhook starts a problem. It makes the native linked
// task recoverable after the classic distributed-systems failure: Pyrus accepted POST
// /tasks, but its HTTP response did not reach us. Without a per-problem key, an old appeal
// from the same reopened chat is indistinguishable from the current one.
if (!requestKey) {
  return { success: false,
    reason: "subtaskRequestKey is missing; refusing non-idempotent subtask creation",
    taskId: taskId };
}
const requestMarker = "Идентификатор обращения ИИ: " + requestKey;
const form = topicForm(data.topicKey, data.treeNode, "createSubtask");
const summaryText = render(summaryTemplate(cfg, "subtask"), summaryFields({
  data: data,
  labels: form.labels,
  description: form.description,
  parent: taskId
})) + "\n\n" + requestMarker;

const fieldIds = await resolveFieldIds();

// Без обязательной тройки подзадачу создавать нечем: неверный номер поля Pyrus отвергает
// целиком, а не частично, так что попытка «отправим что есть» стоила бы обращения. Ошибка
// уходит в граф, и он существующей цепочкой условий передаёт обращение оператору — а лог
// выше уже перечислил все поля формы, так что чинится это одной правкой `config`.
if (!fieldIds.unitFieldId || !fieldIds.componentFieldId || !fieldIds.emailFieldId || !fieldIds.messageFieldId) {
  return {
    success: false,
    reason: "на форме " + cfg.subtaskFormId + " не найдены обязательные поля подзадачи (Юнит / Компонент / Эл. почта / Сообщение)",
    taskId: taskId
  };
}

const requiredFields = [
  { id: fieldIds.unitFieldId, value: { item_name: String(data.unitFullName) } },
  { id: fieldIds.componentFieldId, value: { item_name: String(data.componentName) } },
  { id: fieldIds.emailFieldId, value: String(data.email) },
  { id: fieldIds.messageFieldId, value: summaryText }
];
const inputFields = [];
if (fieldIds.subjectFieldId) inputFields.push({ id: fieldIds.subjectFieldId, value: String(data.problemSummary || data.componentName) });

function taskFromResponse(resp) {
  const body = (resp && resp.body) || resp || {};
  return body.task || body;
}

function taskFieldText(task, fieldId) {
  const all = flattenFormFields((task && task.fields) || [], []);
  const hit = all.find(f => Number(f && f.id) === Number(fieldId));
  if (!hit) return "";
  if (typeof hit.value === "string") return hit.value;
  try { return JSON.stringify(hit.value); } catch (e) { return String(hit.value || ""); }
}

function nativeChildMatches(task, requireMarker) {
  if (!task || !task.id) return false;
  if (Number(task.parent_task_id) !== Number(taskId)) return false;
  if (task.form_id != null && Number(task.form_id) !== Number(cfg.subtaskFormId)) return false;
  return !requireMarker || taskFieldText(task, fieldIds.messageFieldId).indexOf(requestMarker) >= 0;
}

async function readTask(id) {
  const resp = await Http.get({ url: apiUrl + "tasks/" + Number(id), headers: headers });
  return taskFromResponse(resp);
}

async function verifyChild(id, requireMarker) {
  try {
    const task = await readTask(id);
    return { ok: true, task: task, matches: nativeChildMatches(task, requireMarker) };
  } catch (e) {
    Log.warn({ message: "createSubtask: could not verify child " + id + ": " + describe(e) });
    return { ok: false, matches: false, error: e };
  }
}

function persistRecovered(id, expectedClaim, expectedSubtaskId) {
  return pointUpdate(
    { taskId: Number(taskId), subtaskRequestKey: requestKey,
      subtaskId: expectedSubtaskId, subtaskClaim: expectedClaim },
    { subtaskId: Number(id), subtaskIntegrity: "complete", subtaskClaim: runToken,
      subtaskClaimAt: Date.now(), updatedAt: Date.now() }
  );
}

async function findLinkedByMarker() {
  try {
    const parent = await readTask(taskId);
    const ids = Array.isArray(parent.linked_task_ids) ? parent.linked_task_ids : [];
    // A chat may be reused and therefore have several old children. The marker, not the
    // mere existence of a child, decides which one belongs to this problem.
    for (let i = 0; i < ids.length && i < 50; i++) {
      const linked = ids[i];
      const id = linked && typeof linked === "object" ? linked.id : linked;
      if (!id) continue;
      const child = await readTask(id);
      if (nativeChildMatches(child, true)) return { ok: true, id: Number(child.id) };
    }
    return { ok: true, id: null };
  } catch (e) {
    Log.error({ message: "createSubtask: native linked-task recovery failed: " + describe(e) });
    return { ok: false, id: null, error: e };
  }
}

// An id written by an older/incomplete run is never duplicated. It may, however, be
// promoted to complete when Pyrus confirms the native parent relation. The marker is not
// required here because pre-migration subtasks did not have one; the stored id already
// identifies the candidate exactly.
if (state.subtaskId) {
  const incompleteClaim = state.subtaskClaim ? String(state.subtaskClaim) : null;
  const incompleteAt = Number(state.subtaskClaimAt || state.updatedAt || Date.now());
  const incompleteFresh = !!incompleteClaim &&
    Date.now() - incompleteAt < claimTtlMs;
  if (incompleteFresh) {
    return { success: false, skip: true, deferred: true, subtaskId: Number(state.subtaskId),
      reason: "another run is verifying the created subtask", taskId: taskId };
  }
  const known = await verifyChild(state.subtaskId, false);
  if (known.ok && known.matches && persistRecovered(
    state.subtaskId, incompleteClaim, state.subtaskId
  )) {
    return { success: true, subtaskId: Number(state.subtaskId), duplicate: true,
      recovered: true, taskId: taskId };
  }
  Log.error({ message: "createSubtask: subtask " + state.subtaskId + " exists for task " + taskId +
    " but its native parent relation was not confirmed; refusing to duplicate or close" });
  return { success: false, subtaskId: state.subtaskId, duplicateBlocked: true,
    reason: "existing subtask has no confirmed native parent relation", taskId: taskId };
}

// A claim is a compare-and-set on the task document. Unlike the former register lookup,
// it does not need a custom form field and two concurrent runs cannot both win it.
// A fresh loser does nothing: the winning run owns creation and the partner reply.
let oldClaim = state.subtaskClaim ? String(state.subtaskClaim) : null;
if (oldClaim) {
  const claimAt = Number(state.subtaskClaimAt || state.updatedAt || Date.now());
  const stale = Date.now() - claimAt >= claimTtlMs;
  if (!stale) {
    return { success: false, skip: true, deferred: true,
      reason: "another run is creating this subtask", taskId: taskId };
  }
  const recovered = await findLinkedByMarker();
  if (recovered.id) {
    if (persistRecovered(recovered.id, oldClaim, null)) {
      return { success: true, subtaskId: recovered.id, duplicate: true,
        recovered: true, taskId: taskId };
    }
    // Pyrus has proved that the task exists. Losing the database write is never a reason
    // to create another one, even after the claim TTL expires.
    return { success: false, subtaskId: recovered.id, duplicateBlocked: true,
      reason: "recovered subtask exists but its state could not be persisted", taskId: taskId };
  }
  // If Pyrus itself could not be checked, taking over a stale claim could duplicate a
  // task whose successful HTTP response was lost. Fail closed and let an operator see it.
  if (!recovered.ok) {
    return { success: false, reason: "could not recover an uncertain subtask from Pyrus",
      taskId: taskId };
  }
  // An empty linked list is not proof that the old creator is dead: its POST may still be
  // in flight or Pyrus may not have exposed the new link yet. Reusing the expired claim to
  // create again would turn a timeout into two business tasks. For the MVP this is a
  // deliberate availability trade-off: hand the chat to an operator, never guess.
  return { success: false, duplicateBlocked: true,
    reason: "stale subtask claim has no recoverable native child; manual verification required",
    taskId: taskId };
}

const claim = runToken;
const claimFilters = {
  taskId: Number(taskId),
  subtaskRequestKey: requestKey,
  subtaskId: null,
  subtaskClaim: oldClaim
};
const claimed = pointUpdate(claimFilters, {
  subtaskClaim: claim,
  subtaskClaimAt: Date.now(),
  subtaskIntegrity: "creating",
  updatedAt: Date.now()
});
if (!claimed) {
  Log.info({ message: "createSubtask: another run won the atomic claim for task " + taskId });
  return { success: false, skip: true, deferred: true,
    reason: "another run won subtask creation", taskId: taskId };
}

function releaseClaim() {
  return pointUpdate(
    { taskId: Number(taskId), subtaskRequestKey: requestKey, subtaskId: null, subtaskClaim: claim },
    { subtaskClaim: null, subtaskClaimAt: null, subtaskIntegrity: null, updatedAt: Date.now() }
  );
}

function markUncertain(id) {
  const paths = { subtaskIntegrity: id ? "unconfirmed_parent" : "uncertain_response", updatedAt: Date.now() };
  if (id) paths.subtaskId = Number(id);
  return pointUpdate(
    { taskId: Number(taskId), subtaskRequestKey: requestKey, subtaskId: null, subtaskClaim: claim },
    paths
  );
}

function completeClaim(id) {
  return pointUpdate(
    { taskId: Number(taskId), subtaskRequestKey: requestKey, subtaskId: null, subtaskClaim: claim },
    { subtaskId: Number(id), subtaskIntegrity: "complete",
      subtaskClaimAt: Date.now(), updatedAt: Date.now() }
  );
}

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
  const created = taskFromResponse(resp);
  if (!created || !created.id) throw new Error("no task.id in Pyrus response");
  return created;
}

function statusOf(e) {
  const raw = e && (e.status || e.statusCode ||
    (e.response && (e.response.status || e.response.statusCode)));
  if (Number(raw)) return Number(raw);
  const match = /\b([45]\d\d)\b/.exec(String(e || ""));
  return match ? Number(match[1]) : null;
}

function definitelyRejected(e) {
  const status = statusOf(e);
  return status >= 400 && status < 500 && [408, 409, 425, 429].indexOf(status) < 0;
}

// Only an explicit non-retryable 4xx proves that Pyrus did not create a task. Therefore
// only that class may be retried without the optional subject. A timeout or 5xx can hide
// a successful creation; retrying it immediately is how duplicate appeals are born.
let createdTask = null;
let creationError = null;
try {
  createdTask = await create(requiredFields.concat(inputFields));
} catch (e) {
  if (inputFields.length && definitelyRejected(e)) {
    Log.warn({ message: "createSubtask: creation with optional subject was rejected for task " + taskId +
      ", retrying with all mandatory fields including «Сообщение»: " + describe(e) });
    try {
      createdTask = await create(requiredFields);
    } catch (e2) {
      creationError = e2;
    }
  } else {
    creationError = e;
  }
}

if (creationError) {
  Log.error({ message: "createSubtask failed for task " + taskId + ": " + describe(creationError) });
  const recovered = await findLinkedByMarker();
  if (recovered.id && persistRecovered(recovered.id, claim, null)) {
    return { success: true, subtaskId: recovered.id, recovered: true, taskId: taskId };
  }
  if (definitelyRejected(creationError)) {
    releaseClaim();
  } else {
    markUncertain(null);
  }
  return { success: false, uncertain: !definitelyRejected(creationError),
    reason: String(creationError), taskId: taskId };
}

const subtaskId = Number(createdTask.id);
let parentConfirmed = nativeChildMatches(createdTask, false);
if (!parentConfirmed) {
  // Some Pyrus responses omit fields from the returned task. Read it once before deciding
  // that the native relation is absent; the parent chat must never close on an assumption.
  const verified = await verifyChild(subtaskId, true);
  parentConfirmed = verified.ok && verified.matches;
}
if (!parentConfirmed) {
  markUncertain(subtaskId);
  Log.error({ message: "createSubtask: task " + subtaskId + " was created, but Pyrus did not confirm parent_task_id=" + taskId });
  return { success: false, subtaskId: subtaskId, duplicateBlocked: true,
    reason: "subtask was created but its native parent relation was not confirmed", taskId: taskId };
}

if (!completeClaim(subtaskId)) {
  try {
    const current = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    const value = (current && current.value) || {};
    if (Number(value.subtaskId) === subtaskId && value.subtaskIntegrity === "complete") {
      return { success: false, skip: true, deferred: true, subtaskId: subtaskId,
        reason: "another run completed this subtask", taskId: taskId };
    }
  } catch (e) {
    Log.warn({ message: "createSubtask: could not re-read state after completion race: " + e });
  }
  return { success: false, subtaskId: subtaskId,
    reason: "subtask was created but its ownership state changed before completion", taskId: taskId };
}

// The bot does NOT complete the first workflow step. It used to post `action: "finished"`
// on the fresh subtask and Pyrus answered 400 every time: the created task stands on
// step 1, whose approver is another account («бот Approver», then the role
// «[support] Первая линия»), while our bot is merely the author. The step is not ours
// to finish, and nothing needs finishing: the route already carries the subtask to the
// people who work it.

// Parent task fields are updated by finalize together with the closing comment,
// so no extra request is made here.
return { success: true, subtaskId: subtaskId, taskId: taskId };
