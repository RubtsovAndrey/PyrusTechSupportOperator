const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const MAX_HISTORY_CHARS = 4000;
let chatHistory = Context.get({ key: "chatHistory" }) || "";
if (chatHistory.length > MAX_HISTORY_CHARS) chatHistory = chatHistory.slice(-MAX_HISTORY_CHARS);

let confirmationType = "solution_check";
try {
  const rec = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + Context.get({ key: "taskId" }) });
  if (rec && rec.value) confirmationType = rec.value.confirmationType || "solution_check";
} catch (e) {}

let prompt;
if (confirmationType === "more_help") {
  prompt = `Ты — аналитик в поддержке партнёров пиццерий.
Бот спросил партнёра, нужна ли ему ещё помощь по какому-либо вопросу.
Твоя задача — проанализировать последние реплики в истории переписки и понять ответ партнёра.

История переписки:
"""
${chatHistory}
"""

Определи статус:
- "resolved" (помощь не нужна) — партнёр говорит, что больше вопросов нет (например: "нет", "спасибо", "всё хорошо", "больше ничего").
- "more_questions" (есть ещё вопросы) — партнёр хочет задать новый вопрос или описывает новую проблему.
- "failed" (проблема не решена) — партнёр говорит, что предыдущая проблема всё ещё актуальна.
- "unclear" (неясно) — ответ непонятен или не относится к делу.

Ответь СТРОГО в формате JSON, без markdown и пояснений вокруг:
{"status": "resolved" | "failed" | "more_questions" | "unclear", "reason": "краткое объяснение на русском"}`;
} else {
  prompt = `Ты — аналитик в поддержке партнёров пиццерий.
Партнёру только что выдали инструкцию по решению проблемы и спросили, помогло ли это.
Твоя задача — проанализировать последние реплики в истории переписки и понять реакцию партнёра.

История переписки:
"""
${chatHistory}
"""

Определи статус решения проблемы:
- "resolved" (решено) — партнёр подтвердил, что всё работает (например: "да", "помогло", "спасибо", "заработало").
- "failed" (не решено) — партнёр прямо говорит, что инструкция не помогла или проблема сохраняется (например: "нет", "всё равно синий экран", "не работает").
- "more_questions" (доп. вопросы) — партнёр не говорит, помогло или нет, а задаёт уточняющий вопрос по самой инструкции.
- "unclear" (неясно) — ответ не относится к делу, непонятен или это просто мусорный текст.

Ответь СТРОГО в формате JSON, без markdown и пояснений вокруг:
{"status": "resolved" | "failed" | "more_questions" | "unclear", "reason": "краткое объяснение на русском"}`;
}

const response = await Llm.sendText({
  llmModelKey: Context.get({ key: "llmModelKey" }) || "REPLACE_WITH_YOUR_LLM_KEY",
  text: prompt,
  temperature: 0.2
});

Log.info({ message: "confirmationClassifier LLM response: " + JSON.stringify(response) });

let rawText;
if (typeof response === "string") rawText = response;
else {
  const body = response.body ?? response;
  rawText = body?.choices?.[0]?.message?.content ?? response.text ?? response.content ?? "";
}

const jsonMatch = rawText.match(/\{[\s\S]*\}/);
if (jsonMatch) rawText = jsonMatch[0];
if (!rawText) rawText = '{"status":"unclear","reason":"Пустой ответ модели"}';

let parsed = { status: "unclear", reason: "" };
try { parsed = JSON.parse(rawText); }
catch (e) {
  Log.warn({ message: "confirmationClassifier parse error: " + rawText });
  parsed = { status: "unclear", reason: "Не удалось распознать ответ модели" };
}

return { status: parsed.status || "unclear", reason: parsed.reason || "" };
