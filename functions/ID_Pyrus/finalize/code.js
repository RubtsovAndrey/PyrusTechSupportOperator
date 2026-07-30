const DB_ID = "1000299722-pyrus_bot_database-hul";
// Same id as in receiveWebhook: needed to tell the bot's own replies from the
// partner's messages when deciding whether a newer message has arrived.
const BOT_AUTHOR_ID = 1314929;

function isBot(author) {
  if (!author) return false;
  if (Number(author.id) === BOT_AUTHOR_ID) return true;
  return /^bot@/i.test(String(author.email || ""));
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
const apiUrl = runtime.apiUrl || "https://api.pyrus.com/v4/";
const token = runtime.token;

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
    fieldUpdates: null,
    nextStage: "escalated"
  };
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

const currentLast = current
  ? (current.comments || []).slice().reverse().find(c => !isBot(c.author))
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

  // A comment without `channel` stays in the internal correspondence: the partner
  // is never sent it. It goes first so the operator reads the summary above the
  // handover itself.
  if (outcome.internalNote) {
    try {
      await Http.post({
        url: apiUrl + "tasks/" + taskId + "/comments",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: { text: outcome.internalNote }
      });
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
  if (outcome.fieldUpdates && outcome.fieldUpdates.length) body.field_updates = outcome.fieldUpdates;

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

if (outcome.nextStage) {
  // Only the paths this function owns: writing the whole document would resurrect the
  // facts as they looked when this run started and undo whatever the agents of a
  // concurrent turn have collected since.
  writeState(taskId, {
    "stage": outcome.nextStage,
    "pendingOutcome": null,
    // One comment is answered once: a redelivered webhook for it is dropped by
    // receiveWebhook instead of producing a second reply.
    "lastProcessedCommentId": processedId || state.lastProcessedCommentId || null,
    "botHasReplied": state.botHasReplied === true || !!outcome.replyText,
    "updatedAt": Date.now()
  }, "finalize");
}

return { success: true, taskId: taskId, kind: outcome.kind };
