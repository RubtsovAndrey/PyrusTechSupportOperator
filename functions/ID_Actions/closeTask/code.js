var _prev = Context.getLastFunctionResult() || {};
var ctxTaskId = _prev.taskId || AgentContext.getValue({ key: "taskId" });
var ufId = AgentContext.getValue({ key: "unitFieldId" });
var cfId = AgentContext.getValue({ key: "componentFieldId" });

var unitVal = unitFullName || AgentContext.getValue({ key: "unitFullName" });
var compVal = componentName || AgentContext.getValue({ key: "componentName" });
var closeReply = replyText || AgentContext.getValue({ key: "replyText" }) || "Рад был помочь! Если появятся новые вопросы, обращайтесь.";

if (!unitVal || !compVal) {
  AgentContext.putValue({ key: "replyText", value: closeReply });
  AgentContext.putValue({ key: "closeAction", value: "finished" });
  AgentContext.putValue({ key: "closeFieldUpdates", value: null });
  AgentContext.putValue({ key: "newStage", value: "closed" });
  return { success: true, replyText: closeReply, reason: "closed without unit/component fields", taskId: ctxTaskId };
}

var fieldUpdates = [];
if (ufId) fieldUpdates.push({ id: Number(ufId), value: { item_name: String(unitVal) } });
if (cfId) fieldUpdates.push({ id: Number(cfId), value: { item_name: String(compVal) } });

AgentContext.putValue({ key: "replyText", value: closeReply });
AgentContext.putValue({ key: "closeAction", value: "finished" });
AgentContext.putValue({ key: "closeFieldUpdates", value: fieldUpdates.length ? fieldUpdates : null });
AgentContext.putValue({ key: "newStage", value: "closed" });

return { success: true, replyText: closeReply, taskId: ctxTaskId };
