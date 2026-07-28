const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const MAX_HISTORY_CHARS = 4000;
let chatHistory = Context.get({ key: "chatHistory" }) || "";
if (chatHistory.length > MAX_HISTORY_CHARS) chatHistory = chatHistory.slice(-MAX_HISTORY_CHARS);

const prompt = `Ты — фильтр эскалации в поддержке партнёров пиццерий.
Тебе дана история переписки партнёра с ботом в чате поддержки.
Определи по последним репликам партнёра, нужно ли немедленно передать диалог человеку-оператору.

Передавай оператору немедленно, если:
- партнёр явно просит человека/оператора/менеджера
- партнёр агрессивен, угрожает, использует оскорбления
- ситуация критическая (пожар, травма, утечка газа, серьёзная авария)

Не передавай оператору, если партнёр просто описывает техническую проблему
(касса, принтер, интернет, доставка, сайт и т.п.) без явной просьбы об операторе.

История переписки:
"""
${chatHistory}
"""

Ответь СТРОГО в формате JSON, без markdown и пояснений вокруг:
{"escalate": true|false, "reason": "краткое объяснение на русском"}`;

const response = await Llm.sendText({
  llmModelKey: Context.get({ key: "llmModelKey" }) || "REPLACE_WITH_YOUR_LLM_KEY",
  text: prompt,
  temperature: 0.2
});

Log.info({ message: "faceControl LLM response: " + JSON.stringify(response) });

let rawText;
if (typeof response === "string") rawText = response;
else {
  const body = response.body ?? response;
  rawText = body?.choices?.[0]?.message?.content ?? response.text ?? response.content ?? "";
}

const jsonMatch = rawText.match(/\{[\s\S]*\}/);
if (jsonMatch) rawText = jsonMatch[0];
if (!rawText) {
  Log.warn({ message: "faceControl empty LLM response" });
  rawText = '{"escalate":true,"reason":"Пустой ответ модели"}';
}

let parsed;
try { parsed = JSON.parse(rawText); }
catch (e) {
  Log.warn({ message: "faceControl parse error: " + rawText });
  parsed = { escalate: true, reason: "Не удалось распознать ответ модели — эскалация для проверки" };
}

const shouldEscalate = !!parsed.escalate;

if (!shouldEscalate) {
  const taskId = Context.get({ key: "taskId" });
  let dialogState = {};
  try {
    const rec = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    if (rec && rec.value) dialogState = rec.value;
  } catch (e) {
    Log.warn({ message: "faceControl: error reading dialogState: " + e });
  }
  dialogState.stage = "gathering";
  dialogState.updatedAt = Date.now();
  try {
    Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: dialogState });
  } catch (e) {
    Log.warn({ message: "faceControl: error saving dialogState: " + e });
  }
}

return { escalate: shouldEscalate, reason: parsed.reason || "" };
