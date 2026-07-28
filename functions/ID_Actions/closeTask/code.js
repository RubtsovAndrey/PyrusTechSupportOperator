const ufId = AgentContext.getValue({ key: "unitFieldId" });
const cfId = AgentContext.getValue({ key: "componentFieldId" });

const unitVal = unitFullName || AgentContext.getValue({ key: "unitFullName" });
const compVal = componentName || AgentContext.getValue({ key: "componentName" });

if (!unitVal || !compVal) {
  AgentContext.putValue({ key: "replyText", value: "Понадобится время на изучение проблемы, мы вернёмся с ответом." });
  AgentContext.putValue({ key: "escalateApproval", value: true });
  AgentContext.putValue({ key: "dialogDone", value: true });
  return { success: false, reason: "missing unit/component", replyText: "Понадобится время на изучение проблемы, мы вернёмся с ответом." };
}

const fieldUpdates = [];
if (ufId) fieldUpdates.push({ id: Number(ufId), value: { item_name: String(unitVal) } });
if (cfId) fieldUpdates.push({ id: Number(cfId), value: { item_name: String(compVal) } });

const closeReply = replyText || "Рад был помочь! Если появятся новые вопросы, обращайтесь.";

AgentContext.putValue({ key: "replyText", value: closeReply });
AgentContext.putValue({ key: "closeAction", value: "finished" });
AgentContext.putValue({ key: "closeFieldUpdates", value: fieldUpdates.length ? fieldUpdates : null });
AgentContext.putValue({ key: "dialogDone", value: true });

return { success: true, replyText: closeReply };
