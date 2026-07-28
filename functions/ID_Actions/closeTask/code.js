var params = arguments[0] || {};
var ufId = AgentContext.getValue({ key: "unitFieldId" });
var cfId = AgentContext.getValue({ key: "componentFieldId" });

var unitVal = params.unitFullName || params["unit-full-name"] || AgentContext.getValue({ key: "unitFullName" });
var compVal = params.componentName || params["component-name"] || AgentContext.getValue({ key: "componentName" });
var closeReply = params.replyText || params["reply-text"] || AgentContext.getValue({ key: "replyText" }) || "Рад был помочь! Если появятся новые вопросы, обращайтесь.";

if (!unitVal || !compVal) {
  AgentContext.putValue({ key: "replyText", value: closeReply });
  AgentContext.putValue({ key: "closeAction", value: "finished" });
  AgentContext.putValue({ key: "closeFieldUpdates", value: null });
  AgentContext.putValue({ key: "newStage", value: "closed" });
  return { success: true, replyText: closeReply, reason: "closed without unit/component fields" };
}

var fieldUpdates = [];
if (ufId) fieldUpdates.push({ id: Number(ufId), value: { item_name: String(unitVal) } });
if (cfId) fieldUpdates.push({ id: Number(cfId), value: { item_name: String(compVal) } });

AgentContext.putValue({ key: "replyText", value: closeReply });
AgentContext.putValue({ key: "closeAction", value: "finished" });
AgentContext.putValue({ key: "closeFieldUpdates", value: fieldUpdates.length ? fieldUpdates : null });
AgentContext.putValue({ key: "newStage", value: "closed" });

return { success: true, replyText: closeReply };
