const DB_ID = "1000299722-pyrus_bot_database-hul";

// One read of `config` for everything this function takes from it. Two separate reads for
// two settings would be two round trips on the hot path of every webhook.
const CONFIG = (function () {
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "config" });
    return (doc && doc.value) || {};
  } catch (e) {
    Log.warn({ message: "receiveWebhook: config read failed, falling back to built-in defaults: " + e });
    return {};
  }
})();

// Pyrus fires a webhook for every new comment INCLUDING the ones this bot posts
// itself. Without this check the bot reads its own reply as the partner's message,
// answers it, and the answer fires the next webhook: the partner receives the whole
// knowledge base article in a few seconds and the task escalates without him saying
// a word. author.type is not usable for this — for programmatic agents Pyrus often
// reports "user" — so the numeric id is the only reliable signal.
//
// Read from the `config` document, with the current account as the default. This is the
// single most expensive constant in the project to get wrong — a wrong value means the bot
// answering itself in a loop — and it used to be a literal in two files at once, so a new
// service account (a migration, a recreated integration) would be applied to one of them
// and not the other. One extra Db.get per webhook buys the ability to fix that without a
// deploy, and the default keeps the bot working on an empty database.
// ── Наши аккаунты, и только наши ──
// Раньше здесь был ещё резервный признак `/^bot@/i` по email автора — «для сервисных
// аккаунтов, чей id нам не сообщили». В этой организации Pyrus у КАЖДОГО бота email вида
// `bot@<uuid>`, поэтому резерв признавал своим любого чужого бота: `bot techSupport
// Supervisor`, `bot techSupport Approver`, `bot techSupport Chat Test`. Последствия видны в
// логах: виток был отброшен как «последний комментарий — мой собственный», хотя его написал
// Supervisor, а в истории для промпта его сообщения подписывались «Ассистент» — модель
// считала своими словами то, чего не говорила.
// Список, а не одно значение: своих аккаунтов может быть несколько (тест и прод).
const BOT_AUTHOR_IDS = (Array.isArray(CONFIG.botAuthorIds) && CONFIG.botAuthorIds.length
  ? CONFIG.botAuthorIds
  : [CONFIG.botAuthorId || 1314929]).map(Number).filter(Boolean);

// ── Which forms the bot works in, and as what ──
// Until now there was no notion of a form at all: `runtime.formId` was written and never
// read, so every webhook was treated as a chat. That is safe only while the webhook is
// registered on exactly one form. It stops being safe the moment it is registered on the
// ticket form, because THAT form is also the form the bot creates its own subtasks on
// (`config.subtaskFormId`) — so the bot would start receiving events for the escalations it
// had just handed to the first line, and answer a colleague as if he were the partner.
//
// This repository is attached to the isolated test copies of the Pyrus forms. `config.forms`
// may narrow or explicitly configure the same permission, but an absent config must never
// fall through to the production chat. Form 2454249 is a CREATE target for test subtasks,
// never an inbound work queue.
const DEFAULT_FORM_ROLES = {
  "2430464": { role: "chat", environment: "test", knowledgeExecution: "handover_only" }
};
const FORM_ROLES = (CONFIG.forms && typeof CONFIG.forms === "object")
  ? CONFIG.forms
  : DEFAULT_FORM_ROLES;

function roleOfForm(formId) {
  const entry = FORM_ROLES[String(formId || "")];
  const role = entry && entry.role ? String(entry.role) : null;
  return (role === "chat" || role === "ticket") ? role : null;
}

// Partner-facing managed knowledge is a second, independent permission. Merely being a
// chat form is not enough: otherwise adding a production chat form to the whitelist would
// silently enable every article accepted only for the test form. Missing or unknown values
// fail closed. Articles may still collect facts and prepare an operator-only answer.
function knowledgeExecutionOfForm(formId) {
  const entry = FORM_ROLES[String(formId || "")];
  return entry && entry.knowledgeExecution === "partner_answer"
    ? "partner_answer"
    : "handover_only";
}
// Ten lines used to cut the opening message, which is where the partner names the
// unit — by the end of a dialog the model no longer saw where the unit came from.
const HISTORY_LIMIT = 20;
// Only these hosts may be sent the Pyrus access_token. The webhook body cannot be
// authenticated at all: X-Pyrus-Sig is computed over the raw bytes, and the platform
// hands functions an already-parsed object, so the original byte representation is
// gone before any code runs. This allowlist is what stops a forged api_url from
// exfiltrating the token to an attacker-controlled host.
const ALLOWED_API_HOSTS = ["api.pyrus.com", "api.pyrus.kz"];

function hostOf(url) {
  const m = /^https:\/\/([^/:?#]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

function isBot(author) {
  if (!author) return false;
  return BOT_AUTHOR_IDS.indexOf(Number(author.id)) >= 0;
}

// Чужой бот — не мы и не партнёр. Признаётся только для того, чтобы сказать о нём в лог:
// если в треде появился сервисный аккаунт, о котором мы не знаем, это стоит увидеть до
// того, как кто-то начнёт разбираться, почему бот повёл себя странно.
function looksLikeForeignBot(author) {
  return !!author && !isBot(author) &&
    (String(author.type || "") === "bot" || /^bot@/i.test(String(author.email || "")));
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
      // Not an anomaly here: the very first turn of a chat has no document yet.
      Log.info({ message: who + ": no document " + key + " yet, writing it whole" });
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

// Every exit returns the same shape, so downstream conditions never read undefined.
function result(id, stage, skip, reason) {
  return { taskId: id, stage: stage, skip: skip, reason: reason || null };
}

function reject(reason) {
  Log.warn({ message: "receiveWebhook rejected: " + reason });
  return result(null, null, true, reason);
}

// Wipe the session context before anything else. It is scoped to the session, not to
// the task, so it outlives both the turn and the task — and with enable-context on,
// the platform serialises every key of it into the LLM prompt. A pre-refactor build
// had left apiUrl, chatHistory and the Pyrus access_token in there, which meant the
// token was shipped to the model on every single call. Everything the agents need is
// rewritten below from the webhook payload and the task document.
AgentContext.clearContext({});

const raw = (Context.getMessageContent() || {}).payload || {};

if (!raw.task_id) return reject("payload has no task_id");

const taskId = String(raw.task_id);
const apiUrl = raw.api_url ? String(raw.api_url) : "https://api.pyrus.com/v4/";
const token = raw.access_token;

if (ALLOWED_API_HOSTS.indexOf(hostOf(apiUrl)) < 0) return reject("api_url host not allowed: " + apiUrl);
if (!token) return reject("payload has no access_token");

const task = raw.task || {};
const comments = task.comments || [];

if (raw.event !== "comment") return result(taskId, null, true, "event is not a comment");

const lastComment = comments[comments.length - 1];
if (!lastComment) return result(taskId, null, true, "comment event without comments");

// The recursion breaker. Must come before anything that costs money or writes state.
if (isBot(lastComment.author)) {
  return result(taskId, null, true, "last comment is the bot's own");
}

// ── Отвечаем только на то, что пришло СНАРУЖИ ──
// Комментарий без входящего канала — внутренняя переписка: заметка оператора или сообщение
// служебного бота. Отвечать на него нечем и незачем, а стоит это витка из трёх вызовов
// модели и реплики партнёру, которой он не ждал.
// Раньше такие комментарии отбрасывались случайно — резервным признаком `bot@` в isBot,
// который заодно признавал своим любого чужого бота. Признак убран, и теперь фильтр нужен
// по-настоящему: в логах видно, что `bot techSupport Supervisor` пишет в тред сам, на каждый
// вебхук, и без этой проверки бот принялся бы отвечать на его сообщения об ошибках.
// Для чатов это безопасно: в живом треде КАЖДЫЙ комментарий партнёра приходит с
// `channel.direction: "inbound"`.
// Исключение — САМОЕ первое сообщение задачи: Pyrus отдаёт тело задачи без канала, и оно
// всегда принадлежит партнёру. Ровно то же исключение уже сделано в `speaker()`, и по той же
// причине; распространять его на переоткрытый тред нельзя — там первым идёт как раз
// комментарий человека.
const isOpeningMessage = comments.length === 1;
if (!isOpeningMessage && !(lastComment.channel && lastComment.channel.direction === "inbound")) {
  if (looksLikeForeignBot(lastComment.author)) {
    Log.info({ message: "receiveWebhook: task " + taskId + " — внутреннее сообщение служебного аккаунта " + (lastComment.author && lastComment.author.id) + ", бот не вмешивается" });
  }
  return result(taskId, null, true, "last comment is internal, not a message from the partner");
}

// ── Pyrus field parsing ──
// Разбирается до решения о том, работать ли: поля задачи — часть этого решения, «Id задачи
// из КЦ» опознаёт заявку колл-центра. Поля вложены в разделы, поэтому обход рекурсивный.
function flattenFields(fields, out = []) {
  if (!Array.isArray(fields)) return out;
  fields.forEach(f => {
    out.push(f);
    if (f.value && Array.isArray(f.value.fields)) flattenFields(f.value.fields, out);
    else if (Array.isArray(f.fields)) flattenFields(f.fields, out);
  });
  return out;
}
const allFields = flattenFields(task.fields || []);

// ── Which form this is, and whether the bot has any business here ──
const formId = task.form_id ? String(task.form_id) : null;
const role = roleOfForm(formId);
if (!role) {
  return result(taskId, null, true, "form " + formId + " is not one the bot works in");
}
if (role === "ticket") {
  return result(taskId, null, true,
    "form " + formId + " is a subtask/ticket form; MVP processes chats only");
}

// Pyrus records a change of the base status on the comment that caused it: the
// comment that closed the task carries action "finished", and the partner's reply
// into a closed task carries action "reopened".
const commentAction = String(lastComment.action || "");

// Everything up to and including the comment that closed the task belongs to an
// истекшее обращение. The task is reused for the next one, so without this cut the
// prompt opens with a solved problem and the model answers that instead of the new one.
let closedAt = -1;
comments.forEach((c, i) => { if (String(c.action || "") === "finished") closedAt = i; });
const threadComments = closedAt >= 0 ? comments.slice(closedAt + 1) : comments;

// ── Dialog history ──
// Pyrus resends the whole thread on every webhook, so notes are rebuilt from
// scratch instead of appended — that keeps them in sync with the real thread.
// Pyrus emits the opening message both as the task body and as the first comment,
// which used to show the partner's greeting twice and made the model think it was
// repeated. Collapse identical neighbours.
// Who said it. An operator's internal note has no `channel` and is not the bot's —
// labelling it «Партнёр» told the model the partner had said things he never said,
// including the summaries the bot itself wrote for the operator. The opening message is
// the exception: Pyrus reports the task body without a channel, and it is always the
// partner's, so only later channel-less comments are read as internal.
// The «index === 0» exception holds only for an UNCUT thread. After a close the slice starts
// at the comment that reopened the task, and a reopen the bot acts on always carries the
// partner's channel — so a channel-less comment first in a cut slice is an operator's note,
// and calling it «Партнёр» is the very mislabelling this function was written to stop.
function speaker(c, index, threadWasCut) {
  if (isBot(c.author)) return "Ассистент";
  if (c.channel || (index === 0 && !threadWasCut)) return "Партнёр";
  return "Оператор";
}

// ── Why the length is capped and not only the count ──
// The limit used to be twenty comments of whatever length Pyrus sent. A partner pasting the
// log of a till or a stack trace put the whole thing into the prompt — and, because notes
// are rebuilt from the thread on every webhook, it stayed there for the next twenty turns,
// paid for on every model call and crowding out the instructions that tell the bot what to
// do. The substance of a support message is at its beginning; the tail of a log is not
// something a flash model is going to use.
// Only the copy that goes into the prompt is shortened. The full text still reaches the code
// that has a use for it — the business words, the tokens searchKnowledge scores on.
const MAX_HISTORY_LINE = 1200;

function forPrompt(text, limit) {
  const s = String(text || "");
  return s.length > limit ? s.slice(0, limit) + " …[сообщение обрезано]" : s;
}

const history = [];
threadComments
  .filter(c => c.text || c.formatted_text)
  .forEach((c, i) => {
    const line = speaker(c, i, closedAt >= 0) + ": " + forPrompt(c.text || c.formatted_text, MAX_HISTORY_LINE);
    if (history[history.length - 1] !== line) history.push(line);
  });

history.slice(-HISTORY_LIMIT).forEach(line => AgentContext.addNote({ text: line }));

const incomingText = lastComment.text || lastComment.formatted_text || "";
// A screenshot with no caption is an ordinary support message, not a malformed one.
const attachmentCount = Array.isArray(lastComment.attachments) ? lastComment.attachments.length : 0;

const lastInbound = comments.slice().reverse().find(c => c.channel && c.channel.direction === "inbound");
const outboundChannel = lastInbound
  ? { type: lastInbound.channel.type, direction: "outbound", to: lastInbound.channel.from }
  : null;

// ── Имя партнёра: почему его больше нет в сводке оператору ──
// Оно бралось из `author` комментария, и для почты это работало. Для веб-виджета — нет:
// автором там числится служебный аккаунт Pyrus, и оператор читал «Партнёр: Pyrus.com»,
// что похоже на название организации-контрагента. Настоящего имени у веб-виджета нет
// вовсе: и `channel.from.name`, и поле комментария «Имя» содержат `Anonymous user`
// (проверено по выгрузке живого чата). Отвечают партнёру по каналу задачи, а не по имени,
// так что строка не помогала никому — и убрана из сводки.
//
// Само значение по-прежнему пишется в документ: оно ничего не стоит, а знать, кто в треде,
// иногда нужно при разборе. Порядок источников теперь верный — канал вперёд автора, — и
// служебные имена за имя не считаются.
const NOT_A_NAME = /^(pyrus\.com|anonymous user|аноним)$/i;
function personName(v) {
  if (!v) return null;
  if (typeof v === "string") return NOT_A_NAME.test(v.trim()) ? null : (v.trim() || null);
  const named = String(v.name || [v.first_name, v.last_name].filter(Boolean).join(" ")).trim();
  const clean = named && !NOT_A_NAME.test(named) ? named : null;
  return clean || (typeof v.email === "string" ? v.email : null) || null;
}

const partnerName = lastInbound
  ? (personName(lastInbound.channel && lastInbound.channel.from) || personName(lastInbound.author))
  : null;

// ── Языковой предохранитель ──
// Точный ISO-код определяет intake-модель. Код независимо узнаёт сигналы, которые нельзя
// безопасно принять за русский: латиницу, арабскую письменность и характерные буквы ряда
// соседних языков. Это не классификатор языка, а fail-closed граница: при таком сигнале
// российские инструкции не исполняются, даже если модель забудет вернуть код языка.
function languageSampleOf(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ");
}
function scriptOf(text) {
  const source = languageSampleOf(text);
  if (/[\u0600-\u06ff]/.test(source)) return "other";
  const letters = source.match(/[a-zа-яёіїєґўәғқңөұүһҳӣӯҷ]/gi) || [];
  if (letters.length < 8) return null;
  const cyrillic = letters.filter(c => /[а-яёіїєґўәғқңөұүһҳӣӯҷ]/i.test(c)).length;
  return cyrillic * 2 >= letters.length ? "cyrillic" : "latin";
}
const lang = scriptOf(incomingText);
const distinctiveNonRussian = /[іїєґўәғқңөұүһҳӣӯҷ]/i.test(languageSampleOf(incomingText));
const languageGuard = (lang === "latin" || lang === "other" || distinctiveNonRussian)
  ? "non_ru"
  : "possibly_ru";
if (languageGuard === "non_ru") {
  Log.info({ message: "receiveWebhook: task " + taskId + " — обнаружен нерусский языковой сигнал; российский self-service будет заблокирован" });
}

const unitField = allFields.find(f => f.name === "Юнит");
const componentField = allFields.find(f => f.name === "Компонент");
const unitFieldId = unitField ? Number(unitField.id) : null;
const componentFieldId = componentField ? Number(componentField.id) : null;

// ── Per-task state: the single source of truth, keyed by taskId ──
const now = Date.now();
const STATE_KEY = "state:" + taskId;
let stored = {};
let documentExists = false;
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: STATE_KEY });
  if (doc && doc.value) { stored = doc.value; documentExists = true; }
} catch (e) {
  Log.warn({ message: "receiveWebhook: state read failed: " + e });
}

// ── Idempotency ──
// There is no lock here on purpose. The platform runs webhooks concurrently and
// offers nothing to serialise them: Db.get + Db.put is not atomic, and
// Db.updateByFilters returns no modifiedCount, so a compare-and-set cannot be told
// apart from a no-op. A lock built on it would hand the same lock to both runs.
//
// What the previous lock did instead was drop the second webhook — and then finalize,
// seeing a newer message, sent nothing at all, so a partner who wrote two lines in a
// row got no answer whatsoever. The arbiter has to be the one thing both runs see
// identically: the Pyrus thread itself.
//   • one comment is answered once  — this check;
//   • the bot never answers itself   — the isBot guard above;
//   • of two racing runs only the one holding the newest comment speaks — finalize.
const incomingCommentId = lastComment.id ? String(lastComment.id) : null;
if (incomingCommentId && String(stored.lastProcessedCommentId || "") === incomingCommentId) {
  return result(taskId, null, true, "comment " + incomingCommentId + " already answered");
}

let storedStage = stored.stage || null;
let data = Object.assign({}, stored.data);

// ── A reopen after the operator closed the task is a NEW обращение ──
// Otherwise `escalated` is a trap: it exists to keep the bot quiet while a human owns
// the thread, tasks are reused for months, and nothing ever cleared it — the bot went
// silent in that chat forever. This is the one signal that says the human is done.
// The reopen must come from the partner through his external channel. An operator can
// reopen a task himself, and on that comment the bot would otherwise wake up and start
// answering a colleague in the middle of his work. If a partner ever arrives without a
// channel the bot stays quiet instead — the failure that leaves a human in charge.
const reopenedByPartner = !!(lastComment.channel && lastComment.channel.direction === "inbound");
const newRequest = commentAction === "reopened" && storedStage === "escalated" && reopenedByPartner;
if (newRequest) {
  // The unit and the address belong to the partner, not to the problem he had last
  // time, so they are carried over — asking for them again would be the very loop that
  // was removed everywhere else. Everything about the previous problem goes.
  data = {};
  if (stored.data && stored.data.unitFullName) data.unitFullName = stored.data.unitFullName;
  if (stored.data && stored.data.email) data.email = stored.data.email;
  storedStage = null;
  Log.info({ message: "receiveWebhook: task " + taskId + " reopened after handover, starting a new request" });
}

// ── Stage the graph should enter (this replaces the separate routeStage function) ──
// Only these stages are reachable. Anything else falls back to intake, which is
// always safe: intake re-gathers whatever is missing.
// ── «Спасибо» — это не переоткрытие обращения ──
// Ветка `end: close` закрывает чат сразу после совета, и следующая реплика партнёра
// приходит уже в закрытый чат. Молчаливая передача человеку тут не случайна: тредом
// владеет Pyrus, задача переиспользуется месяцами, и два разных обращения в одной задаче —
// то, в чём бот путается. Защита остаётся; снимается ровно один случай, когда в сообщении
// нет НИЧЕГО, кроме благодарности. Партнёры благодарят постоянно, и каждое такое «спасибо»
// стоило первой линии разбора уже решённого вопроса.
//
// Признак нарочно узкий и проверяет сообщение ЦЕЛИКОМ. Цена ошибок несимметрична: не
// узнать благодарность — это сегодняшнее поведение, то есть ничего не потеряно, а принять
// за благодарность новый вопрос — значит закрыть его и не ответить. Поэтому «спасибо, а
// теперь другое дело» под это правило не подпадает, и так и задумано.
// Сообщение разбирается на части по знакам и союзам, и благодарностью считается только
// такое, где благодарность — КАЖДАЯ часть. «Да, получилось, спасибо» подходит; «Спасибо, а
// теперь другое дело» — нет, потому что вторая часть не про это. Так правило остаётся
// узким, не перечисляя всех возможных комбинаций вежливости.
const THANKS_PART = [
  /^(большое\s+|огромное\s+)?(спасибо|спс|пасибо|благодарю|благодарствую|thanks|thank\s+you|thx)(\s+(большое|огромное|вам|тебе|за\s+помощь|ребята|ребят|друг))?$/i,
  /^(да|ага|угу|отлично|супер|класс|понятно|ясно|хорошо|ок|окей|ok|okay)$/i,
  /^(вс[её]\s+)?(получилось|заработало|работает|помогло|решилось|решили|понятно|ясно|хорошо)$/i,
  /^(вопросов\s+больше\s+нет|больше\s+вопросов\s+нет|это\s+вс[её]|вс[её])$/i
];
function isJustThanks(text) {
  // Знаки и эмодзи к смыслу отношения не имеют, а сравнению целиком мешают.
  // Agent Platform runs an older JavaScript regexp engine: Unicode property escapes
  // compile in Node.js but fail there before the function can start.
  // The phrases recognised below are Russian and English, so explicit ranges are both
  // sufficient for this narrow classifier and compatible with the platform runtime.
  const bare = String(text || "").replace(/[^A-Za-zА-Яа-яЁё0-9\s,;.!?]+/g, " ").replace(/\s+/g, " ").trim();
  if (!bare || bare.length > 80) return false;
  const parts = bare.split(/[,;.!?]+|\s+и\s+/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every(p => THANKS_PART.some(re => re.test(p)));
}

let stage = "intake";
if (storedStage === "closed") {
  stage = isJustThanks(incomingText) ? "gratitude" : "reopened";
  if (stage === "gratitude") {
    Log.info({ message: "receiveWebhook: task " + taskId + " — в закрытый чат пришла только благодарность, отвечаем и закрываем снова, оператора не беспокоим" });
  }
}
else if (storedStage === "escalated") stage = "escalated";      // operator owns the thread now
else if (storedStage === "awaiting_confirmation") stage = "awaiting_confirmation";
else if (storedStage === "awaiting_email") stage = "awaiting_email";
// The article asked a question of its own and this is the answer to it. Straight back to
// the solver, the way `awaiting_email` goes straight back to createSubtask: routed through
// intake it cost two extra model calls per answer and let routing rewrite `topicKey` in the
// middle of a tree walk. Needs a topic to return to — without one there is no article to
// continue, and intake is always the safe fallback.
else if (storedStage === "awaiting_answers") stage = data.topicKey ? "awaiting_answers" : "intake";

// ── «Закройте чат» — это завершение, а не передача человеку ──
// На `awaiting_answers` сообщение идёт прямо в solver, минуя confirmation. Живой прогон
// показал опасное расхождение: модель написала «обращение закрываю», но вернула управляющий
// `kind: handover`, и система передала уже решённый вопрос оператору. Явная просьба закрыть
// ТЕКУЩИЙ чат или обращение однозначна и не должна стоить вызова модели.
//
// Признак намеренно требует одновременно действие и объект. Одного «закрыть» недостаточно:
// партнёр может просить закрыть крышку кассы или кассовую смену. Инфинитив принимается
// только рядом с «можете/можно»; «нужно закрыть заявку провайдеру» остаётся содержанием
// обращения. Явное отрицание тоже исключается.
const CLOSE_REQUEST = [
  /(?:закройте|закрой|закрывайте|завершите|заверши)(?:\s+\S+){0,3}\s+(?:чат|обращени\S*|заявк\S*|задач\S*|тикет\S*)/i,
  /(?:чат|обращени\S*|заявк\S*|задач\S*|тикет\S*)(?:\s+\S+){0,3}\s+(?:закройте|закрой|закрывайте|завершите|заверши)/i,
  /(?:можете|можно)(?:\s+\S+){0,2}\s+(?:закрыть|закрывать|завершить)(?:\s+\S+){0,2}\s+(?:чат|обращени\S*|заявк\S*|задач\S*|тикет\S*)/i,
  /(?:чат|обращени\S*|заявк\S*|задач\S*|тикет\S*)(?:\s+\S+){0,3}\s+(?:можете|можно)(?:\s+\S+){0,2}\s+(?:закрыть|закрывать|завершить)/i,
  /(?:please\s+)?(?:close|finish|end)(?:\s+\S+){0,2}\s+(?:chat|ticket|request|case)/i,
  /(?:chat|ticket|request|case)(?:\s+\S+){0,3}\s+(?:can|may)\s+(?:be\s+)?(?:closed|finished|ended)/i
];
function asksToClose(text) {
  const s = String(text || "").replace(/[.,;:!?]+/g, " ").replace(/\s+/g, " ").trim();
  // JavaScript's `\b` is ASCII-only even with `i`, so a boundary before Cyrillic «не»
  // is not a boundary at all. Use the start/whitespace boundary explicitly.
  if (/(?:^|\s)не\s+(?:закры|заверш)\S*/i.test(s) ||
      /(?:^|\s)не\s+можете\s+(?:закры|заверш)\S*/i.test(s)) return false;
  return CLOSE_REQUEST.some(re => re.test(s));
}

if (incomingText && asksToClose(incomingText) && stage !== "escalated") {
  stage = "close_request";
  Log.info({ message: "receiveWebhook: task " + taskId + " — партнёр явно попросил закрыть чат со стадии " + (storedStage || "начало диалога") });
}

// ── «Позовите человека» слышно на любой стадии ──
// Эта проверка жила в промпте intake, а intake работает только на приёме обращения: стадии
// `awaiting_answers`, `awaiting_email` и `awaiting_confirmation` уходят в solver,
// createSubtask и confirmation напрямую, минуя его. То есть просьбу человека бот не слышал
// ровно там, где ветвящаяся статья проводит большинство витков и где партнёр чаще всего
// устаёт. В лучшем случае его выпускал общий предохранитель — через два-три витка и с
// причиной «бот задал 3 уточняющих вопроса», которая оператору говорит неправду.
//
// Кодом, а не моделью: витка стоить не должно, а сам признак узкий и проверяемый.
//
// ⚠️ Голое существительное брать НЕЛЬЗЯ, и это главное в списке ниже. «Переведите
// сотрудника в другую пиццерию» — законная ветка статьи про карточку, «менеджер офиса
// меняет аватарку сам» — цитата из самой базы знаний, «оператор кассы сказал» — рассказ о
// проблеме. Поэтому ищется просьба: повелительный глагол рядом со словом о человеке, либо
// прямо названное «живой человек» / «не бот». Между глаголом и человеком допускается до
// трёх слов — «дайте мне, пожалуйста, живого человека».
//
// Список составлен без живых логов и заведомо неполон: в тестовом чате партнёром был
// автор бота, и ни одной такой реплики там нет. Дополнять его следует по выгрузкам
// реальных переписок, а не по воображению — это единственное место, которое для этого
// нужно править.
const ASKS_FOR_HUMAN = [
  /(позов|позвать|дайте|дай\b|соедин|переключ|свяж|подключ|переад)\S*(\s+\S+){0,3}\s+(человек|оператор|специалист|поддержк|менеджер|руководител)/i,
  /жив(ой|ого|ым|ому)\s+(человек|оператор|сотрудник|специалист)/i,
  /(хочу|хотел бы|хотела бы|можно|нужно|надо)(\s+\S+){0,2}\s+(поговорить|пообщаться|связаться|общаться)\s+с\s+(человек|оператор|специалист|руководител|менеджер)/i,
  /не\s+хочу\s+(общаться\s+|разговаривать\s+)?с\s+ботом/i,
  // Всё сообщение целиком — одно слово: «Оператора!»
  /^\s*(оператор|человек)\S{0,2}\s*[!.?]*\s*$/i
];
function asksForHuman(text) {
  const s = String(text || "");
  return ASKS_FOR_HUMAN.some(re => re.test(s));
}

let handoverReason = null;
if (incomingText && asksForHuman(incomingText) && stage !== "escalated" && stage !== "reopened") {
  stage = "handover_request";
  handoverReason = "партнёр попросил связать его с человеком";
  Log.info({ message: "receiveWebhook: task " + taskId + " — партнёр просит человека, обращение уходит оператору со стадии " + (storedStage || "начало диалога") });
}

// MVP does not analyse attachments. A caption may be retained in the internal history,
// but must not turn an unreadable screenshot into permission to diagnose the case.
if (attachmentCount && stage !== "escalated" && stage !== "reopened") {
  stage = "attachment";
  handoverReason = "партнёр прислал вложение; MVP не анализирует вложения";
  Log.info({ message: "receiveWebhook: " + attachmentCount + " attachment(s) on task " + taskId + ", handing over without analysing them" });
}

// An address is recognisable without a model, and the one stage that waits for it must
// not depend on an agent noticing it: the subtask branch asks for the email and the
// answer goes straight back to creating the subtask, with no intake in between.
// Only read on that stage — picked up anywhere, the regex also captures addresses the
// partner merely quotes ("письмо от noreply@… не пришло") and puts them in the subtask.
let emailHarvested = false;
if (stage === "awaiting_email" && !data.email) {
  const emailMatch = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(incomingText || "");
  if (emailMatch) {
    data.email = emailMatch[0];
    emailHarvested = true;
    Log.info({ message: "receiveWebhook: picked up email " + data.email + " from the message on task " + taskId });
  }
}

// Whether the bot has spoken in this thread yet. Decided here, not by the model,
// which got the greeting wrong in both directions during testing. Pyrus may truncate
// task.comments from the tail, so a scan of the thread alone would start greeting the
// partner again in the middle of a long dialog: once true, the flag stays true.
// A new обращение weeks later does deserve a greeting, though.
const isFirstBotReply = newRequest || !(stored.botHasReplied === true || comments.some(c => isBot(c.author)));

const runtimeValue = {
  apiUrl: apiUrl,
  token: token,
  // An address once known for a task does not stop being valid. Overwritten with null it
  // could be lost mid-dialog: Pyrus may truncate `comments` from the tail, and if the
  // truncation takes away every inbound comment there is nothing left to derive it from.
  // With finalize now refusing to talk into a channel-less void, that loss would turn a
  // healthy conversation into a handover.
  outboundChannel: outboundChannel || (stored.runtime && stored.runtime.outboundChannel) || null,
  incomingCommentId: incomingCommentId,
  formId: formId,
  // What the rest of the graph is dealing with. `createSubtask` reads it to refuse creating
  // a subtask of a ticket — a ticket already IS the subtask — and it belongs in the document
  // rather than being re-derived, because only this function sees the webhook payload.
  role: role,
  knowledgeExecution: knowledgeExecutionOfForm(formId),
  unitFieldId: unitFieldId,
  componentFieldId: componentFieldId,
  isFirstBotReply: isFirstBotReply,
  partnerName: partnerName,
  // Письменность последнего сообщения партнёра, `null` — если сообщение слишком короткое,
  // чтобы о ней судить. Прежнее значение при этом сохраняется: разговор не меняет язык
  // оттого, что партнёр ответил «ок».
  lang: lang || (stored.runtime && stored.runtime.lang) || null,
  languageGuard: languageGuard === "non_ru"
    ? "non_ru"
    : (lang ? "possibly_ru" : ((stored.runtime && stored.runtime.languageGuard) || "possibly_ru"))
};

// Request-scoped Pyrus data lives in the task document, not in the session, so
// concurrent webhooks for different tasks cannot overwrite each other.
//
// Only the paths this function actually owns are written. Rewriting the whole document
// meant a run that had read it a second earlier resurrected everything it had missed
// since: a concurrent turn's freshly collected unit, or the `lastProcessedCommentId`
// that finalize had just recorded — which would let an answered comment be answered
// again. `upsert` is not supported, so a document that does not exist yet is created
// outright; from then on every other function only patches it.
// `taskId` duplicates what the document key already says, and it has to: filters address
// fields inside `value`, and the key is not one of them, so this is the only handle a
// point write can aim at.
const patch = {
  "taskId": Number(taskId),
  "updatedAt": now,
  "botHasReplied": !isFirstBotReply,
  "runtime": runtimeValue,
  // ── The decision of a turn belongs to that turn ──
  // finalize consumes `pendingOutcome` only when it manages to post; a run that died on a
  // missing token, on a Pyrus outage or on being superseded leaves it in the document. The
  // next turn then has a decision in there that was made about a DIFFERENT message — and
  // finalize is the `next-error-step` of nearly every node, so the path «this turn throws
  // → finalize» is the most likely failure of all. It would post that stale text as the
  // answer to the new message and act on its `action`, closing or escalating the task.
  // Cleared here because this is the only function that knows a new turn has begun; the
  // invariant becomes checkable in one line: pendingOutcome is non-empty ⇒ this turn set it.
  "pendingOutcome": null
};
if (newRequest || !documentExists) {
  // The leftovers of the finished обращение must go, so here the whole subtree is
  // replaced by the carried-over facts on purpose. A document being created needs the
  // subtree too, or the facts of the very first turn would have nowhere to land.
  // `data.handoverReason` must be folded into that subtree rather than added as a second
  // dotted path: MongoDB rejects one $set that updates both `data` and its child.
  data.handoverReason = handoverReason;
  patch["data"] = data;
  patch["stage"] = null;
  patch["clarifyStreak"] = 0;
  patch["clarifyQuestions"] = 0;
  patch["clarifyProgressKey"] = null;
  patch["subtaskId"] = null;
  // One stable idempotency scope per problem. It is copied into the subtask's mandatory
  // «Сообщение» field, so an accepted request can be recovered through Pyrus' native
  // linked_task_ids even when the POST /tasks response was lost.
  patch["subtaskRequestKey"] = String(taskId) + ":" + String(incomingCommentId || now);
  patch["subtaskClaim"] = null;
  patch["subtaskClaimAt"] = null;
  patch["subtaskIntegrity"] = null;
} else {
  // Почему обращение уходит человеку — словами того, кто это решил. Обнуляется здесь по
  // той же причине, что и `pendingOutcome`: причина, записанная об одной передаче, не
  // должна быть зачитана оператору о другой. Кроме этой функции его пишет searchKnowledge,
  // когда статья дважды не получила ответа, — и всегда позже, уже внутри витка.
  patch["data.handoverReason"] = handoverReason;
  if (emailHarvested) patch["data.email"] = data.email;
}

// A missing document is handled by writeState itself: the point write matches nothing,
// which it reports as count 0, and the fallback creates the document from the same patch.
writeState(taskId, patch, "receiveWebhook");

// ── What the model actually sees ──
// The context is serialised into the prompt as {"notes": [...], "data": {...}}, so
// both notes and putValue keys are visible to the model. Notes are used for anything
// the agents must reason about, because a labelled line is far easier for a small
// model to follow than a nested JSON field.
// The list of missing fields is computed here instead of being left to the model.
const missing = [];
if (!data.unitFullName) missing.push("юнит (город и номер точки)");
if (!data.problemSummary) missing.push("описание проблемы");

const attemptsMade = Array.isArray(data.attempts) ? data.attempts.length : 0;

const lines = [
  "Известные данные по обращению:",
  "- Юнит: " + (data.unitFullName || "не определён"),
  "- Проблема: " + (data.problemSummary || "не описана"),
  "- Язык: " + (data.partnerLanguage || "пока предполагается русский"),
  "- Email: " + (data.email || "не указан"),
  "- Тематика: " + (data.topicKey || "не определена"),
  "- Уже предложено решений: " + attemptsMade,
  "- Это первый ответ бота в диалоге: " + (isFirstBotReply ? "да" : "нет"),
  "- Не хватает для продолжения: " + (missing.length ? missing.join(", ") : "ничего, данных достаточно")
];

// What the article still wants to know, as parseAgentJson worked it out on the previous
// turn. Carried in the document rather than recomputed here: reading it out of the catalog
// would mean a fourth copy of the topic-walking helpers in this project, and the value is a
// snapshot of exactly the right moment anyway — what is open BEFORE the tool is called.
// It matters most on the `awaiting_answers` stage, where the turn goes straight to the
// solver and no earlier stage has published this line into the prompt.
const collected = data.treeAnswers && typeof data.treeAnswers === "object" ? data.treeAnswers : {};
const collectedLine = Object.keys(collected).map(k => k + ": " + collected[k]).join("; ");
if (collectedLine) lines.push("- Уже собрано по тематике: " + collectedLine);
if (data.openAnswerPrompts) lines.push("- Ещё не отвечено (ключ — вопрос): " + data.openAnswerPrompts);

AgentContext.addNote({ text: lines.join("\n") });

if (incomingText) {
  AgentContext.addNote({
    text: "Текущее сообщение партнёра (отвечать нужно на него): " + forPrompt(incomingText, MAX_HISTORY_LINE)
  });
}

// Snapshot for the functions further down the graph (taskId lookup). Keep it free of
// secrets: the platform copies these keys into the prompt.
//
// `incomingText` is capped far more generously than the history lines, because here the cap
// is not only about the prompt: matchUnit, searchKnowledge and parseAgentJson read this
// value to find the unit, the business and the branch in the partner's own words, and
// cutting it at 1200 could cut off the very word being looked for. Four thousand characters
// bound the worst case — one pasted log, not twenty — and no real support message that
// names a point reaches them.
const MAX_INCOMING_IN_CONTEXT = 4000;

AgentContext.putValue({
  key: "dialog",
  value: {
    taskId: taskId,
    incomingText: forPrompt(incomingText, MAX_INCOMING_IN_CONTEXT),
    unitFullName: data.unitFullName || null,
    componentName: data.componentName || null,
    problemSummary: data.problemSummary || null,
    email: data.email || null,
    topicKey: data.topicKey || null,
    partnerLanguage: data.partnerLanguage || null
  }
});

if (stage === "escalated") return result(taskId, stage, true, "operator already handles this task");

return result(taskId, stage, false, stage === "attachment" ? "партнёр прислал вложение" : null);
