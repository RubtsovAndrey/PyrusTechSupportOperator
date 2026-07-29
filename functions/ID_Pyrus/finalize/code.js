const DB_ID = "1000299722-pyrus_bot_database-hul";

const prev = Context.getLastFunctionResult() || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = prev.taskId || dialog.taskId || null;

// A duplicate webhook turned away by the lock reaches finalize with skip=true and
// no lockToken. It must not release the in-flight run's lock nor write to the chat.
const foreignSkip = prev.skip === true && !prev.lockToken;

if (!taskId) {
  Log.warn({ message: "finalize: no taskId, nothing to do" });
  return { success: false, reason: "no taskId" };
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
if (!outcome && prev.skip !== true) {
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

// ── 1. Persist the new stage and consume the pending outcome ──
if (outcome && outcome.nextStage) {
  try {
    Db.put({
      dbIntegration: DB_ID,
      documentKey: "state:" + taskId,
      value: Object.assign({}, state, { stage: outcome.nextStage, pendingOutcome: null, updatedAt: Date.now() })
    });
  } catch (e) {
    Log.warn({ message: "finalize: state write failed: " + e });
  }
}

// ── 2. Send the comment to Pyrus ──
if (outcome && token && (outcome.replyText || outcome.action || outcome.approvalChoice)) {
  let current = null;
  try {
    const resp = await Http.get({ url: apiUrl + "tasks/" + taskId, headers: { "Authorization": "Bearer " + token } });
    current = resp && resp.body && resp.body.task ? resp.body.task : null;
  } catch (e) {
    // A failed probe must not swallow the reply — at worst we answer a stale thread.
    Log.warn({ message: "finalize: task probe failed, sending anyway: " + e });
  }

  const currentLastInbound = current
    ? (current.comments || []).slice().reverse().find(c => c.channel && c.channel.direction === "inbound")
    : null;
  const processedId = runtime.lastInboundCommentId;
  const superseded = !!(processedId && currentLastInbound && String(currentLastInbound.id) !== String(processedId));

  if (superseded) {
    // The partner wrote again while we were thinking; the newer webhook answers.
    Log.info({ message: "finalize: debounced, newer inbound comment on task " + taskId });
  } else {
    const channel = runtime.outboundChannel || (currentLastInbound
      ? { type: currentLastInbound.channel.type, direction: "outbound", to: currentLastInbound.channel.from }
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

    try {
      await Http.post({
        url: apiUrl + "tasks/" + taskId + "/comments",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: body
      });
    } catch (e) {
      Log.error({ message: "finalize: post comment failed for task " + taskId + ": " + e });
    }
  }
}

// ── 3. Release the lock, but only the one this run owns ──
if (!foreignSkip) {
  try {
    Db.delete({ dbIntegration: DB_ID, documentKey: "lock:" + taskId });
  } catch (e) {
    Log.warn({ message: "finalize: lock release failed: " + e });
  }
}

return { success: true, taskId: taskId, kind: outcome ? outcome.kind : "none" };
