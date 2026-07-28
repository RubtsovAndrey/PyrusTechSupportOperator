const taskId = Context.get({ key: "taskId" });
const apiUrl = Context.get({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
const token = Context.get({ key: "token" });

const lastResult = Context.getLastFunctionResult() || {};
const replyText = lastResult.replyText;

if (!replyText) return { success: false, reason: "empty text", newStage: lastResult.newStage };

let outboundChannel = Context.get({ key: "outboundChannel" });

if (outboundChannel === undefined) {
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

const body = { text: replyText };
if (outboundChannel) body.channel = outboundChannel;

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
  return { success: false, newStage: "escalating", reason: String(e) };
}

return { success: true, newStage: lastResult.newStage };
