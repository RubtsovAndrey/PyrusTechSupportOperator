const replyText = arguments[0]?.replyText ?? arguments[0]?.["reply-text"];
const unitFullName = arguments[0]?.unitFullName ?? arguments[0]?.["unit-full-name"];
const componentName = arguments[0]?.componentName ?? arguments[0]?.["component-name"];

const ctxTaskId = AgentContext.getValue({ key: "taskId" });
const ufId = AgentContext.getValue({ key: "unitFieldId" });
const cfId = AgentContext.getValue({ key: "componentFieldId" });

const fieldUpdates = [];
if (ufId && (unitFullName || AgentContext.getValue({ key: "unitFullName" }))) {
  fieldUpdates.push({ id: Number(ufId), value: { item_name: String(unitFullName || AgentContext.getValue({ key: "unitFullName" })) } });
}
if (cfId && (componentName || AgentContext.getValue({ key: "componentName" }))) {
  fieldUpdates.push({ id: Number(cfId), value: { item_name: String(componentName || AgentContext.getValue({ key: "componentName" })) } });
}

const escalationReply = replyText || "Понадобится время на изучение проблемы, мы вернёмся с ответом.";

AgentContext.putValue({ key: "replyText", value: escalationReply });
AgentContext.putValue({ key: "escalateApproval", value: true });
AgentContext.putValue({ key: "closeFieldUpdates", value: fieldUpdates.length ? fieldUpdates : null });
AgentContext.putValue({ key: "newStage", value: "escalated" });

return { success: true, replyText: escalationReply };
