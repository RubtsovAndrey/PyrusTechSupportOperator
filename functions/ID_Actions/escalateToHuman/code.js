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
AgentContext.putValue({ key: "dialogDone", value: true });

return { success: true, replyText: escalationReply };
