const DB_ID = "1000299722-pyrus_bot_database-hul";
// Same id as in receiveWebhook, and from the same place: needed to tell the bot's own
// replies from the partner's messages when deciding whether a newer message has arrived.
// Kept in the `config` document precisely because it lives in two files — a literal here
// and a literal there is how the two would come to disagree, and disagreement means either
// the bot answering itself or the bot standing down forever.
// Список, а не одно значение, и без резервного признака по email: в этой организации Pyrus
// у каждого бота email вида `bot@<uuid>`, так что резерв признавал своим любого чужого бота —
// Supervisor, Approver, бот другого проекта. Здесь это решало, считать ли чужую реплику
// «более свежим сообщением», то есть молчать ли боту.
const BOT_AUTHOR_IDS = (function () {
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "config" });
    const cfg = (doc && doc.value) || {};
    const list = Array.isArray(cfg.botAuthorIds) && cfg.botAuthorIds.length
      ? cfg.botAuthorIds
      : [cfg.botAuthorId || 1314929];
    return list.map(Number).filter(Boolean);
  } catch (e) {
    Log.warn({ message: "finalize: config read failed, using the built-in bot id: " + e });
    return [1314929];
  }
})();

function isBot(author) {
  if (!author) return false;
  return BOT_AUTHOR_IDS.indexOf(Number(author.id)) >= 0;
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
      Log.warn({ message: who + ": point write matched no document " + key + ", falling back to a whole-document write" });
    } catch (e) {
      Log.warn({ message: who + ": point write failed on " + key + ": " + e });
    }
  }
  // Either the document is not there (the platform has no upsert) or the filter is wrong
  // again. Both would lose the write, and a lost stage costs the partner an answer.
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

const prev = Context.getLastFunctionResult() || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = prev.taskId || dialog.taskId || null;

if (!taskId) {
  Log.warn({ message: "finalize: no taskId, nothing to do" });
  return { success: false, reason: "no taskId" };
}

// Rejected payload, the bot's own comment, an already answered comment, a thread the
// operator owns. Nothing was decided and nothing may be written.
if (prev.skip === true) {
  Log.info({ message: "finalize: nothing to do for task " + taskId + " (" + (prev.reason || "skipped") + ")" });
  return { success: true, taskId: taskId, kind: "skipped" };
}

let state = {};
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (doc && doc.value) state = doc.value;
} catch (e) {
  Log.warn({ message: "finalize: state read failed: " + e });
}

const runtime = state.runtime || {};
const data = state.data || {};
// `apiUrl` deliberately still comes from the document: receiveWebhook is the one place
// that checks it against the host allowlist, and re-reading it from the payload here
// would mean either duplicating that check or losing it.
const apiUrl = runtime.apiUrl || "https://api.pyrus.com/v4/";

// ── Where the token comes from ──
// From the payload of THIS request first. Everything that talks to Pyrus runs inside the
// webhook that brought the token, so the copy in the document is never needed — and that
// copy used to live there for as long as the task did, one per task, forever. The document
// remains a fallback for a turn whose payload cannot be read, and finalize wipes it at the
// end of the turn, so the secret's lifetime is the request rather than the task's.
function ownToken() {
  try {
    const own = (Context.getMessageContent() || {}).payload || {};
    return own.access_token || null;
  } catch (e) {
    Log.warn({ message: "finalize: own payload unreadable, taking the token from the document: " + e });
    return null;
  }
}
const token = ownToken() || runtime.token;

// applyOutcome and createSubtask record the decision in the task document, so it
// is keyed by taskId and can never be crossed with another chat.
let outcome = state.pendingOutcome || null;

// Nothing decided this turn (unexpected branch, agent failure). Never leave the
// partner unanswered: reply and hand the thread to a human.
if (!outcome) {
  Log.warn({ message: "finalize: no outcome for task " + taskId + ", handing over to operator" });
  outcome = {
    kind: "fallback",
    replyText: "Понадобится время на изучение вопроса, мы вернёмся с ответом.",
    action: null,
    approvalChoice: "approved",
    withFieldUpdates: false,
    nextStage: "escalated"
  };
}

// ── The Pyrus field updates ──
// Built here rather than carried inside `pendingOutcome`: an array inside the value of a
// `$set` is what the db adapter cannot convert, so carrying it forced applyOutcome's write
// down the whole-document rescue path. Everything needed is in this document already —
// the field ids in `runtime`, the values in `data` — so `withFieldUpdates` is a boolean and
// the array is assembled at the moment of the request that uses it.
// The old shape is still honoured: at the moment of a deploy there may be documents whose
// `pendingOutcome` was written by the previous version, and losing the unit of one of them
// would leave a Pyrus field empty with nobody to notice.
function buildFieldUpdates() {
  if (Array.isArray(outcome.fieldUpdates) && outcome.fieldUpdates.length) return outcome.fieldUpdates;
  if (!outcome.withFieldUpdates) return null;
  const updates = [];
  if (runtime.unitFieldId && data.unitFullName) {
    updates.push({ id: Number(runtime.unitFieldId), value: { item_name: String(data.unitFullName) } });
  }
  if (runtime.componentFieldId && data.componentName) {
    updates.push({ id: Number(runtime.componentFieldId), value: { item_name: String(data.componentName) } });
  }
  return updates.length ? updates : null;
}

// A second guard lives at the last possible boundary. It protects documents written by an
// older deployment and any future caller that bypasses applyOutcome. A close is sent only
// when both facts and both form-field ids are present. For a valid close the updates are
// rebuilt from the current document, even if an old pendingOutcome carries a stale or
// incomplete `fieldUpdates` array.
let requiredCloseFieldUpdates = null;
if (outcome.action === "finished") {
  const missing = [];
  if (!data.unitFullName) missing.push("юнит");
  if (!data.componentName) missing.push("компонент");
  if (!runtime.unitFieldId) missing.push("поле Pyrus «Юнит»");
  if (!runtime.componentFieldId) missing.push("поле Pyrus «Компонент»");

  if (missing.length) {
    Log.warn({ message: "finalize: refusing to close task " + taskId + ": missing " + missing.join(", ") + "; handing over to an operator" });
    const oldReply = String(outcome.replyText || "");
    const safeReply = outcome.kind === "solved"
      ? (oldReply && !/закры/i.test(oldReply)
        ? oldReply
        : "Спасибо за обращение! Если появятся новые вопросы, обращайтесь.")
      : (oldReply || "Понадобится время на изучение вопроса, мы вернёмся с ответом.");
    outcome = {
      kind: "escalated",
      replyText: safeReply,
      internalNote: "[Внутренняя переписка]\nБот не закрыл задачу: перед закрытием не удалось заполнить " + missing.join(", ") + ". Передаю обращение оператору.",
      action: null,
      approvalChoice: "approved",
      withFieldUpdates: true,
      nextStage: "escalated"
    };
  } else {
    // Strip approval even from an old in-flight outcome written by the previous version.
    // `approved` advances the chat workflow and its next-step automation reopens a task
    // that the same request has just closed with `finished`.
    outcome = Object.assign({}, outcome, { approvalChoice: null, withFieldUpdates: true });
    requiredCloseFieldUpdates = [
      { id: Number(runtime.unitFieldId), value: { item_name: String(data.unitFullName) } },
      { id: Number(runtime.componentFieldId), value: { item_name: String(data.componentName) } }
    ];
  }
}

const hasSomethingToPost = !!(outcome.replyText || outcome.action || outcome.approvalChoice || outcome.internalNote);

if (!token) {
  Log.error({ message: "finalize: no token for task " + taskId + ", cannot reach Pyrus" });
  return { success: false, reason: "no token", taskId: taskId };
}

// ── 1. Is this run still the one that should speak? ──
// Both racing runs ask Pyrus the same question and the thread only ever grows, so
// exactly one of them — the one holding the newest message — gets "yes". This is the
// whole concurrency control of the bot; see the comment in receiveWebhook.
let current = null;
try {
  const resp = await Http.get({ url: apiUrl + "tasks/" + taskId, headers: { "Authorization": "Bearer " + token } });
  current = resp && resp.body && resp.body.task ? resp.body.task : null;
} catch (e) {
  // A failed probe must not swallow the reply — at worst we answer a stale thread.
  Log.warn({ message: "finalize: task probe failed, sending anyway: " + e });
}

// ── What counts as «a newer message» ──
// Only an inbound comment of the partner. It used to be any comment that was not the
// bot's, and an operator's internal note is one: a note typed while the bot was thinking
// made this run stand down — and nobody answered the partner, because a comment with no
// channel produces no run that holds a `pendingOutcome` to speak with. The rule «of two
// racing runs the one holding the newest message speaks» needs that message to have an
// owner, and an internal note has none. A thread that genuinely belongs to a human is
// already silenced a step earlier, by `stage === "escalated"` in receiveWebhook.
const isPartnerMessage = c => !isBot(c.author) && !!(c.channel && c.channel.direction === "inbound");

const currentLast = current
  ? (current.comments || []).slice().reverse().find(isPartnerMessage)
  : null;

// Which comment THIS run is answering. It has to come from the request's own payload:
// the task document is shared, so a webhook that arrived a moment later has already
// overwritten runtime.incomingCommentId, and a stale run comparing itself against the
// newer run's id would conclude it is current and answer anyway — both runs would then
// write to the chat. The document is only a fallback.
let processedId = null;
try {
  const own = (Context.getMessageContent() || {}).payload || {};
  const ownComments = (own.task && own.task.comments) || [];
  const ownLast = ownComments[ownComments.length - 1];
  if (ownLast && ownLast.id) processedId = String(ownLast.id);
} catch (e) {
  Log.warn({ message: "finalize: own payload unreadable, falling back to the document: " + e });
}
if (!processedId && runtime.incomingCommentId) processedId = String(runtime.incomingCommentId);
const superseded = !!(processedId && currentLast && String(currentLast.id) !== String(processedId));

if (superseded) {
  // The partner wrote again (or an operator stepped in) while we were thinking. Leave
  // the state exactly as it was: the run that owns the newer message answers, and it
  // overwrites pendingOutcome with a decision made on the newer message. Advancing the
  // stage here used to move the dialog on while the partner had heard nothing.
  Log.info({ message: "finalize: superseded on task " + taskId + ", newer message " + (currentLast.id) + " wins" });
  return { success: true, taskId: taskId, kind: "superseded" };
}

// ── 2. Send the comment to Pyrus ──
let posted = true;
if (hasSomethingToPost) {
  const channel = runtime.outboundChannel || (currentLast && currentLast.channel
    ? { type: currentLast.channel.type, direction: "outbound", to: currentLast.channel.from }
    : null);

  // ── A reply the partner cannot receive must not look like a delivered one ──
  // `body.channel` is what carries a comment out of Pyrus. Without it the comment stays in
  // the internal correspondence — and Pyrus answers 200, so `posted` stayed true, the stage
  // advanced, and the bot went on believing it had asked a question the partner never saw.
  // The next message was then read as the answer to it. This is the one silent failure left
  // in the project, and the forms without a channel (the call-center tickets) are exactly
  // where it would have surfaced.
  // The turn becomes a handover: the operator gets the text the bot meant to send, so
  // nothing is lost, and a human owns a conversation the bot has no way to continue.
  if (outcome.replyText && !channel) {
    Log.error({ message: "finalize: task " + taskId + " has no outbound channel, the partner cannot be reached — handing over to an operator" });
    outcome = {
      kind: "escalated",
      replyText: null,
      internalNote: "[Внутренняя переписка]\nБот не смог ответить партнёру: во входящих комментариях задачи нет канала связи, отправить сообщение наружу невозможно. Передаю обращение оператору.\n\nТекст, который бот собирался отправить:\n" + outcome.replyText,
      action: null,
      approvalChoice: "approved",
      withFieldUpdates: true,
      nextStage: "escalated"
    };
  }

  // A comment without `channel` stays in the internal correspondence: the partner
  // is never sent it. It goes first so the operator reads the summary above the
  // handover itself.
  //
  // Sent once per answered comment. The summary used to go out before the reply and the
  // reply could then fail, which keeps `pendingOutcome` so the turn is repeated — and the
  // repeat posted the summary a second time. The operator got two copies of one document,
  // the very defect the single summary form was introduced to end. There is no atomic
  // operation to lean on here (the same reason there is no lock), so this only closes the
  // repeat of a turn, which is the case that actually happened.
  if (outcome.internalNote && String(state.internalNotePostedFor || "") !== String(processedId || "")) {
    try {
      await Http.post({
        url: apiUrl + "tasks/" + taskId + "/comments",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: { text: outcome.internalNote }
      });
      writeState(taskId, { "internalNotePostedFor": processedId || null }, "finalize");
    } catch (e) {
      Log.warn({ message: "finalize: internal summary failed for task " + taskId + ": " + e });
    }
  }

  const body = {};
  if (outcome.replyText) {
    body.text = outcome.replyText;
    if (channel) body.channel = channel;
  }
  if (outcome.action) body.action = outcome.action;
  if (outcome.approvalChoice) body.approval_choice = outcome.approvalChoice;
  const fieldUpdates = requiredCloseFieldUpdates || buildFieldUpdates();
  if (fieldUpdates) body.field_updates = fieldUpdates;

  if (body.text || body.action || body.approval_choice) {
    try {
      await Http.post({
        url: apiUrl + "tasks/" + taskId + "/comments",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: body
      });
    } catch (e) {
      posted = false;
      Log.error({ message: "finalize: post comment failed for task " + taskId + ": " + e });
    }
  }
}

// ── 3. Persist the new stage ── only now that the partner has actually been told.
// Written before the post, a five-second Pyrus outage left the bot convinced it had
// asked a question the partner never saw, and the next message was read as an answer
// to it. On failure the stage stays put and the dialog simply repeats the turn.
if (!posted) {
  return { success: false, reason: "post failed", taskId: taskId, kind: outcome.kind };
}

// Only the paths this function owns: writing the whole document would resurrect the
// facts as they looked when this run started and undo whatever the agents of a
// concurrent turn have collected since.
//
// Written whatever the outcome says about the stage. It used to be wrapped in
// `if (outcome.nextStage)`, which tied idempotency — «one comment is answered once» — to a
// field that has nothing to do with it: an outcome without a next stage would have been
// posted and then answered again on the next delivery of the same webhook.
const done = {
  "pendingOutcome": null,
  // The question belongs only to the solution delivered by this turn. Leaving it in the
  // document could append an old question to a later, unrelated `reply` outcome.
  "data.requiredFollowUpQuestion": null,
  // A solution is authorised only for the comment this turn has just answered. Clearing
  // it is defence in depth; the comment-id check already makes it unusable next turn.
  "data.solutionAuthorization": null,
  // One comment is answered once: a redelivered webhook for it is dropped by
  // receiveWebhook instead of producing a second reply.
  "lastProcessedCommentId": processedId || state.lastProcessedCommentId || null,
  "botHasReplied": state.botHasReplied === true || !!outcome.replyText,
  // The turn is over and so is the need for the token. Kept out of the document from here
  // on, the secret lives as long as the request instead of as long as the task.
  "runtime.token": null,
  "updatedAt": Date.now()
};
if (outcome.nextStage) done["stage"] = outcome.nextStage;
writeState(taskId, done, "finalize");

return { success: true, taskId: taskId, kind: outcome.kind };
