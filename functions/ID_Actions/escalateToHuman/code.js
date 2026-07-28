var params = arguments[0] || {};
var ctxTaskId = AgentContext.getValue({ key: "taskId" });
var ufId = AgentContext.getValue({ key: "unitFieldId" });
var cfId = AgentContext.getValue({ key: "componentFieldId" });

var unitVal = params.unitFullName || params["unit-full-name"] || AgentContext.getValue({ key: "unitFullName" });
var compVal = params.componentName || params["component-name"] || AgentContext.getValue({ key: "componentName" });

var fieldUpdates = [];
if (ufId && unitVal) {
  fieldUpdates.push({ id: Number(ufId), value: { item_name: String(unitVal) } });
}
if (cfId && compVal) {
  fieldUpdates.push({ id: Number(cfId), value: { item_name: String(compVal) } });
}

var escalationReply = params.replyText || params["reply-text"] || AgentContext.getValue({ key: "replyText" }) || "Понадобится время на изучение проблемы, мы вернёмся с ответом.";

AgentContext.putValue({ key: "replyText", value: escalationReply });
AgentContext.putValue({ key: "escalateApproval", value: true });
AgentContext.putValue({ key: "closeFieldUpdates", value: fieldUpdates.length ? fieldUpdates : null });
AgentContext.putValue({ key: "newStage", value: "escalated" });

return { success: true, replyText: escalationReply };
