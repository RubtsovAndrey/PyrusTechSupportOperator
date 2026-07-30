const DB_ID = "1000299722-pyrus_bot_database-hul";
// Pyrus fires a webhook for every new comment INCLUDING the ones this bot posts
// itself. Without this check the bot reads its own reply as the partner's message,
// answers it, and the answer fires the next webhook: the partner receives the whole
// knowledge base article in a few seconds and the task escalates without him saying
// a word. author.type is not usable for this — for programmatic agents Pyrus often
// reports "user" — so the numeric id is the only reliable signal.
const BOT_AUTHOR_ID = 1314929;
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
  if (Number(author.id) === BOT_AUTHOR_ID) return true;
  // Fallback for service accounts whose id we have not been told about.
  return /^bot@/i.test(String(author.email || ""));
}

// A point write filters on the stored key field, which is `key`. `documentKey` is only the
// argument name of Db.get/Db.put; as a filter it matched nothing, threw nothing and
// returned count 0, so a whole turn of writes vanished without a trace. The count is
// returned, so a miss is visible — and must never pass quietly again.
function setPath(target, dotted, value) {
  const parts = String(dotted).replace(/^value\./, "").split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function writeState(key, paths, who) {
  try {
    const res = Db.updateByFilters({ dbIntegration: DB_ID, filters: { key: key }, operator: { $set: paths } });
    if (res && Number(res.count) > 0) return true;
    Log.info({ message: who + ": no document " + key + " yet, writing it whole" });
  } catch (e) {
    Log.warn({ message: who + ": point write failed on " + key + ": " + e });
  }
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: key });
    const value = (doc && doc.value) || {};
    Object.keys(paths).forEach(p => setPath(value, p, paths[p]));
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
function speaker(c, index) {
  if (isBot(c.author)) return "Ассистент";
  if (c.channel || index === 0) return "Партнёр";
  return "Оператор";
}

const history = [];
threadComments
  .filter(c => c.text || c.formatted_text)
  .forEach((c, i) => {
    const line = speaker(c, i) + ": " + (c.text || c.formatted_text);
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

// Who the operator will be talking to. Taken from the thread rather than asked for,
// and kept out of the prompt: it is only used in the internal summary.
const partnerName = lastInbound
  ? ((lastInbound.author && lastInbound.author.name) || lastInbound.channel.from || null)
  : null;

// ── Pyrus field parsing ──
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
let stage = "intake";
if (storedStage === "closed") stage = "reopened";               // bot had finished, partner wrote again
else if (storedStage === "escalated") stage = "escalated";      // operator owns the thread now
else if (storedStage === "awaiting_confirmation") stage = "awaiting_confirmation";
else if (storedStage === "awaiting_email") stage = "awaiting_email";
// A message the bot cannot read at all goes to a human immediately: guessing what is
// on a screenshot from an empty text is exactly the improvisation this bot must not do.
// True on every working stage — a screenshot answering "Получилось?" is just as
// unreadable as one opening the dialog. The two stages that already belong to a human
// (escalated, reopened) are left alone.
if (!incomingText && attachmentCount && stage !== "escalated" && stage !== "reopened") {
  stage = "attachment";
  Log.info({ message: "receiveWebhook: " + attachmentCount + " attachment(s) and no text on task " + taskId + ", handing over" });
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
  outboundChannel: outboundChannel,
  incomingCommentId: incomingCommentId,
  formId: task.form_id ? String(task.form_id) : null,
  unitFieldId: unitFieldId,
  componentFieldId: componentFieldId,
  isFirstBotReply: isFirstBotReply,
  partnerName: partnerName
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
const patch = {
  "value.updatedAt": now,
  "value.botHasReplied": !isFirstBotReply,
  "value.runtime": runtimeValue
};
if (newRequest || !documentExists) {
  // The leftovers of the finished обращение must go, so here the whole subtree is
  // replaced by the carried-over facts on purpose. A document being created needs the
  // subtree too, or the facts of the very first turn would have nowhere to land.
  patch["value.data"] = data;
  patch["value.stage"] = null;
  patch["value.clarifyStreak"] = 0;
  patch["value.subtaskId"] = null;
  patch["value.pendingOutcome"] = null;
} else if (emailHarvested) {
  patch["value.data.email"] = data.email;
}

// A missing document is handled by writeState itself: the point write matches nothing,
// which it reports as count 0, and the fallback creates the document from the same patch.
writeState(STATE_KEY, patch, "receiveWebhook");

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

AgentContext.addNote({
  text: [
    "Известные данные по обращению:",
    "- Юнит: " + (data.unitFullName || "не определён"),
    "- Проблема: " + (data.problemSummary || "не описана"),
    "- Email: " + (data.email || "не указан"),
    "- Тематика: " + (data.topicKey || "не определена"),
    "- Уже предложено решений: " + attemptsMade,
    "- Это первый ответ бота в диалоге: " + (isFirstBotReply ? "да" : "нет"),
    "- Не хватает для продолжения: " + (missing.length ? missing.join(", ") : "ничего, данных достаточно")
  ].join("\n")
});

if (incomingText) {
  AgentContext.addNote({ text: "Текущее сообщение партнёра (отвечать нужно на него): " + incomingText });
}

// Snapshot for the functions further down the graph (taskId lookup). Keep it free of
// secrets: the platform copies these keys into the prompt.
AgentContext.putValue({
  key: "dialog",
  value: {
    taskId: taskId,
    incomingText: incomingText,
    unitFullName: data.unitFullName || null,
    componentName: data.componentName || null,
    problemSummary: data.problemSummary || null,
    email: data.email || null,
    topicKey: data.topicKey || null
  }
});

if (stage === "escalated") return result(taskId, stage, true, "operator already handles this task");

return result(taskId, stage, false, stage === "attachment" ? "партнёр прислал вложение без текста" : null);
