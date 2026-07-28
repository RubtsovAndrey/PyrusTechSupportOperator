const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const CATALOG_CACHE_KEY = "knowledge_catalog";
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

function loadKnowledgeCatalog() {
  try {
    const rec = Db.get({ dbIntegration: DB_ID, documentKey: CATALOG_CACHE_KEY });
    if (rec && rec.value && Array.isArray(rec.value.topics) && rec.value.topics.length > 0) {
      const age = Date.now() - (rec.value.ts || 0);
      if (age < CATALOG_TTL_MS) return rec.value.topics;
    }
    return null;
  } catch (e) {
    Log.warn({ message: "routingClassifier: catalog load error: " + e });
    return null;
  }
}

const topics = loadKnowledgeCatalog();

if (!topics) {
  Log.warn({ message: "routingClassifier: knowledge catalog unavailable, escalating" });
  return { route: "escalate", topicKey: null, solverKey: null, componentName: null, reason: "Каталог знаний недоступен", stage: "escalating" };
}

let dialogState = {};
try {
  const record = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (record && record.value) dialogState = record.value;
} catch (e) {
  Log.warn({ message: "routingClassifier: error reading dialogState: " + e });
}
dialogState = dialogState || {};

const unit = dialogState.unit || null;
const problemSummary = dialogState.problemSummary || "";

const topicsListText = topics.map(t => "- " + t.key + ": " + t.description).join("\n");
const unitText = unit ? JSON.stringify(unit) : "не указан";

const prompt = `Ты — маршрутизатор в поддержке партнёров пиццерий и кофеен.
Тебе даны юнит и формулировка проблемы партнёра. Нужно определить, подходит ли
проблема под одну из известных тематик, для которых у нас есть готовый автоматический
решатель.

Юнит: ${unitText}
Формулировка проблемы: "${problemSummary}"

Известные тематики:
${topicsListText}

Правила:
- Если проблема явно соответствует одной из тематик — верни её key.
- Если проблема не соответствует ни одной тематике достаточно уверенно — верни null.
- Не пытайся угадывать тематику "примерно похоже", лучше вернуть null, если не уверен.

Ответь СТРОГО в формате JSON, без markdown и пояснений вокруг:
{"topicKey": "ключ_тематики" | null, "reason": "краткое объяснение на русском"}`;

const response = await Llm.sendText({
  llmModelKey: Context.get({ key: "llmModelKey" }) || "REPLACE_WITH_YOUR_LLM_KEY",
  text: prompt,
  temperature: 0.2
});

Log.info({ message: "routingClassifier LLM response: " + JSON.stringify(response) });

let rawText;
if (typeof response === "string") rawText = response;
else {
  const body = response.body ?? response;
  rawText = body?.choices?.[0]?.message?.content ?? response.text ?? response.content ?? "";
}

const jsonMatch = rawText.match(/\{[\s\S]*\}/);
if (jsonMatch) rawText = jsonMatch[0];
if (!rawText) rawText = '{"topicKey":null,"reason":"Пустой ответ модели"}';

let parsed = { topicKey: null, reason: "" };
try { parsed = JSON.parse(rawText); }
catch (e) {
  Log.warn({ message: "routingClassifier parse error: " + rawText });
  parsed = { topicKey: null, reason: "Не удалось распознать ответ модели" };
}

const matchedTopic = topics.find(t => t.key === parsed.topicKey) || null;

let route, solverKey = null, componentName = null, subtaskFormId = null, nextStage;

if (matchedTopic) {
  route = matchedTopic.route;
  solverKey = matchedTopic.route === "solver" ? (matchedTopic.solverKey || matchedTopic.key) : null;
  componentName = matchedTopic.componentName || null;
  subtaskFormId = matchedTopic.subtaskFormId || null;
  nextStage = matchedTopic.route === "solver" ? "solving" : "transferring";
} else {
  route = "escalate";
  nextStage = "escalating";
}

const updated = Object.assign({}, dialogState, {
  stage: nextStage,
  solverKey: solverKey,
  routingTopicKey: parsed.topicKey || null,
  componentName: componentName,
  subtaskFormId: subtaskFormId || dialogState.subtaskFormId || null,
  updatedAt: Date.now()
});

try {
  Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: updated });
} catch (e) {
  Log.warn({ message: "routingClassifier: error saving dialogState: " + e });
}

return {
  route: route,
  topicKey: parsed.topicKey || null,
  solverKey: solverKey,
  componentName: componentName,
  subtaskFormId: subtaskFormId,
  reason: parsed.reason || "",
  stage: nextStage
};
