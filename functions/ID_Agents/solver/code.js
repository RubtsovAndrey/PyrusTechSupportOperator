const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const CATALOG_CACHE_KEY = "knowledge_catalog";
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_HISTORY_CHARS = 4000;

let chatHistory = Context.get({ key: "chatHistory" }) || "";
if (chatHistory.length > MAX_HISTORY_CHARS) chatHistory = chatHistory.slice(-MAX_HISTORY_CHARS);

const lastResult = Context.getLastFunctionResult() || {};
const solverKey = lastResult.solverKey;

let dialogState = {};
try {
  const rec = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + Context.get({ key: "taskId" }) });
  if (rec && rec.value) dialogState = rec.value;
} catch (e) {
  Log.warn({ message: "solver: error reading dialogState: " + e });
}
const problemSummary = dialogState.problemSummary || lastResult.problemSummary || "неизвестная проблема";

function loadKnowledgeTopic(key) {
  try {
    const rec = Db.get({ dbIntegration: DB_ID, documentKey: CATALOG_CACHE_KEY });
    if (rec && rec.value && Array.isArray(rec.value.topics)) {
      const age = Date.now() - (rec.value.ts || 0);
      if (age < CATALOG_TTL_MS) {
        const topic = rec.value.topics.find(t => t.key === key);
        if (topic) return topic;
      }
    }
    return null;
  } catch (e) {
    Log.warn({ message: "solver: knowledge catalog error: " + e });
    return null;
  }
}

const topic = loadKnowledgeTopic(solverKey);
const instruction = topic ? (topic.solverInstruction || null) : null;
const followUpQuestion = topic ? (topic.followUpQuestion || "Помогли ли эти действия решить проблему?") : "Помогли ли эти действия решить проблему?";

if (!instruction) {
  Log.warn({ message: "solver: instruction not found for solverKey=" + solverKey + ", escalating" });
  dialogState.stage = "escalating";
  dialogState.updatedAt = Date.now();
  try { Db.put({ dbIntegration: DB_ID, documentKey: "state:" + Context.get({ key: "taskId" }), value: dialogState }); } catch (e) {}
  return {
    replyText: "К сожалению, у меня нет готовой инструкции для этой проблемы. Перевожу диалог на специалиста технической поддержки.",
    newStage: "escalating",
    fallback: true
  };
}

const prompt = `Ты — дружелюбный и компетентный ассистент технической поддержки пиццерий и кофеен.
Партнёр столкнулся с проблемой: "${problemSummary}".

Твоя задача — предложить партнёру шаги по решению проблемы, опираясь СТРОГО на следующую инструкцию:
"""
${instruction}
"""

История переписки:
"""
${chatHistory}
"""

Правила:
- Напиши пошаговое, понятное и вежливое руководство.
- Не придумывай шаги от себя, используй только то, что есть в инструкции.
- Обязательно закончи сообщение вопросом: "${followUpQuestion}".

Ответь СТРОГО в формате JSON, без markdown и пояснений вокруг:
{"replyText": "твой ответ партнёру"}`;

const response = await Llm.sendText({
  llmModelKey: Context.get({ key: "llmModelKey" }) || "REPLACE_WITH_YOUR_LLM_KEY",
  text: prompt,
  temperature: 0.5
});

Log.info({ message: "solver LLM response: " + JSON.stringify(response) });

let rawText;
if (typeof response === "string") rawText = response;
else {
  const body = response.body ?? response;
  rawText = body?.choices?.[0]?.message?.content ?? response.text ?? response.content ?? "";
}

const jsonMatch = rawText.match(/\{[\s\S]*\}/);
if (jsonMatch) rawText = jsonMatch[0];
if (!rawText) rawText = '{"replyText":"","fallback":true}';

let parsed = { replyText: "", fallback: true };
try { parsed = JSON.parse(rawText); }
catch (e) {
  Log.warn({ message: "solver parse error: " + rawText });
  parsed = { replyText: "К сожалению, не удалось подготовить решение. Перевожу диалог на специалиста.", fallback: true };
}

const fallback = parsed.fallback || !parsed.replyText;
const newStage = fallback ? "escalating" : "awaiting_confirmation";

dialogState.stage = newStage;
dialogState.updatedAt = Date.now();
try { Db.put({ dbIntegration: DB_ID, documentKey: "state:" + Context.get({ key: "taskId" }), value: dialogState }); } catch (e) {}

return {
  replyText: parsed.replyText || ("Пожалуйста, выполните следующие шаги: " + instruction + " " + followUpQuestion),
  newStage: newStage,
  fallback: fallback
};
