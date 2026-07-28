const DB_ID = "1000299722-pyrus_bot_database-hul";

const taskId = AgentContext.getValue({ key: "taskId" });
const apiUrl = AgentContext.getValue({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
const token = AgentContext.getValue({ key: "token" });

let replyText = AgentContext.getValue({ key: "replyText" });
const closeAction = AgentContext.getValue({ key: "closeAction" });
const escalateApproval = AgentContext.getValue({ key: "escalateApproval" });
const closeFieldUpdates = AgentContext.getValue({ key: "closeFieldUpdates" });
let newStage = AgentContext.getValue({ key: "newStage" });

// Infer newStage and replyText from last function result if not explicitly set
if (!newStage) {
  const lastResult = Context.getLastFunctionResult() || {};
  if (lastResult.action === "clarify" && lastResult.clarifyingQuestion) {
    AgentContext.putValue({ key: "replyText", value: lastResult.clarifyingQuestion });
    replyText = lastResult.clarifyingQuestion;
    newStage = "gathering";
  } else if (lastResult.replyText && !closeAction && !escalateApproval) {
    AgentContext.putValue({ key: "replyText", value: lastResult.replyText });
    replyText = lastResult.replyText;
    newStage = "awaiting_confirmation";
  } else if (lastResult.subtaskId) {
    newStage = "transferring";
    const subtaskReply = "Обращение создано и передано специалистам. Мы вернёмся с ответом на ваш email.";
    AgentContext.putValue({ key: "replyText", value: subtaskReply });
    replyText = subtaskReply;
  }
}

// ── 1. Update dialog state in DB ──
if (taskId && newStage) {
  try {
    const existing = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    const currentState = (existing && existing.value) || {};
    const updated = Object.assign({}, currentState, {
      stage: newStage,
      updatedAt: Date.now(),
      unitFullName: AgentContext.getValue({ key: "unitFullName" }) || currentState.unitFullName,
      componentName: AgentContext.getValue({ key: "componentName" }) || currentState.componentName,
      problemSummary: AgentContext.getValue({ key: "problemSummary" }) || currentState.problemSummary,
      email: AgentContext.getValue({ key: "email" }) || currentState.email
    });
    Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: updated });
  } catch (e) {
    Log.warn({ message: "finalize: state update error: " + e });
  }
}

// ── 2. Send reply to Pyrus (if replyText or action exists) ──
if (replyText || closeAction || escalateApproval) {
  const processedInboundId = AgentContext.getValue({ key: "lastInboundCommentId" });

  let taskResponse;
  try {
    taskResponse = await Http.get({
      url: apiUrl + "tasks/" + taskId,
      headers: { "Authorization": "Bearer " + token }
    });
  } catch (e) {
    Log.info({ message: "finalize: get task error: " + e });
  }

  // Debounce check
  if (taskResponse && taskResponse.body && taskResponse.body.task) {
    const currentComments = taskResponse.body.task.comments || [];
    const currentLastInbound = currentComments.slice().reverse().find(c => c.channel && c.channel.direction === "inbound");
    const currentLastInboundId = currentLastInbound ? currentLastInbound.id : null;
    if (processedInboundId && currentLastInboundId && String(currentLastInboundId) !== String(processedInboundId)) {
      Log.info({ message: "finalize: debounced — newer inbound comment" });
    } else {
      let outboundChannel = AgentContext.getValue({ key: "outboundChannel" });
      if (!outboundChannel && currentLastInbound) {
        outboundChannel = { type: currentLastInbound.channel.type, direction: "outbound", to: currentLastInbound.channel.from };
      }

      const body = { text: replyText || "Обращение обработано." };
      if (outboundChannel) body.channel = outboundChannel;
      if (closeAction) {
        body.action = closeAction;
        if (closeFieldUpdates) body.field_updates = closeFieldUpdates;
      }
      if (escalateApproval) {
        body.approval_choice = "approved";
        if (closeFieldUpdates) body.field_updates = closeFieldUpdates;
      }

      try {
        await Http.post({
          url: apiUrl + "tasks/" + taskId + "/comments",
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
          body: body
        });
      } catch (e) {
        Log.info({ message: "finalize: post comment error: " + e });
      }
    }
  }
}

// ── 3. Release lock ──
if (taskId) {
  try {
    Db.delete({ dbIntegration: DB_ID, documentKey: "lock:" + taskId });
  } catch (e) {
    Log.info({ message: "finalize: releaseLock error: " + e });
  }
}

return { success: true, released: true };
