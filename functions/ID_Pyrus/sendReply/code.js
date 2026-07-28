const taskId = AgentContext.getValue({ key: "taskId" });
const apiUrl = AgentContext.getValue({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
const token = AgentContext.getValue({ key: "token" });

const replyText = AgentContext.getValue({ key: "replyText" });
const closeAction = AgentContext.getValue({ key: "closeAction" });
const escalateApproval = AgentContext.getValue({ key: "escalateApproval" });
const closeFieldUpdates = AgentContext.getValue({ key: "closeFieldUpdates" });

if (!replyText && !closeAction && !escalateApproval) {
  return { success: true, skipped: true };
}

// Debounce check: fetch current task state and verify no newer inbound comments exist
const processedInboundId = AgentContext.getValue({ key: "lastInboundCommentId" });
let taskResponse;
try {
  taskResponse = await Http.get({
    url: apiUrl + "tasks/" + taskId,
    headers: { "Authorization": "Bearer " + token }
  });
} catch (e) {
  Log.info({ message: "sendReply get task error: " + e });
  return { success: false, newStage: "escalating", reason: String(e) };
}

if (taskResponse && taskResponse.body && taskResponse.body.task) {
  const currentComments = taskResponse.body.task.comments || [];
  const currentLastInbound = currentComments.slice().reverse().find(c => c.channel && c.channel.direction === "inbound");
  const currentLastInboundId = currentLastInbound ? currentLastInbound.id : null;

  if (processedInboundId && currentLastInboundId && String(currentLastInboundId) !== String(processedInboundId)) {
    Log.info({ message: "sendReply: debounced — newer inbound comment " + currentLastInboundId + " vs processed " + processedInboundId });
    return { success: true, skipped: true, debounced: true };
  }
}

let outboundChannel = AgentContext.getValue({ key: "outboundChannel" });

if (outboundChannel === undefined) {
  if (taskResponse && taskResponse.body && taskResponse.body.task) {
    const comments = taskResponse.body.task.comments || [];
    const lastInbound = comments.slice().reverse().find(c => c.channel && c.channel.direction === "inbound");
    if (lastInbound) {
      outboundChannel = {
        type: lastInbound.channel.type,
        direction: "outbound",
        to: lastInbound.channel.from
      };
    }
  }
}

const body = { text: replyText || "Обращение обработано." };
if (outboundChannel) body.channel = outboundChannel;

// Include close action and field_updates in the same comment
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
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: body
  });
} catch (e) {
  Log.info({ message: "sendReply post comment error: " + e });
  return { success: false, reason: String(e) };
}

return { success: true };
