const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";

const raw = Context.getMessageContent().payload;
const taskId = String(raw.task_id);
const apiUrl = raw.api_url || "https://api.pyrus.com/v4/";
const token = raw.access_token;
const task = raw.task;
const comments = task.comments || [];

let chatHistory = "";
const historyComments = comments
  .filter(c => c.text || c.formatted_text)
  .slice(-20);

historyComments.forEach(c => {
  const text = c.text || c.formatted_text || "";
  const isBot = c.author && c.author.type === "bot";
  const role = isBot ? "Ассистент" : "Партнёр";
  chatHistory += role + ": " + text + "\n";
});

const lastComment = comments[comments.length - 1];
const incomingText = lastComment ? (lastComment.text || lastComment.formatted_text || "") : "";

let outboundChannel = null;
if (lastComment && lastComment.channel && lastComment.channel.direction === "inbound") {
  outboundChannel = {
    type: lastComment.channel.type,
    direction: "outbound",
    to: lastComment.channel.from
  };
}

function flattenFields(fields, out = []) {
  if (!Array.isArray(fields)) return out;
  fields.forEach(f => {
    out.push(f);
    if (f.value && Array.isArray(f.value.fields)) flattenFields(f.value.fields, out);
    else if (Array.isArray(f.fields)) flattenFields(f.fields, out);
  });
  return out;
}
const allFields = flattenFields(task.fields || []);
const unitField = allFields.find(f => f.name === "Юнит");
const componentField = allFields.find(f => f.name === "Компонент");
const unitFieldId = unitField ? Number(unitField.id) : null;
const componentFieldId = componentField ? Number(componentField.id) : null;

const lockKey = "lock:" + taskId;
const LOCK_TTL_MS = 60 * 1000;

let existingLock = null;
try {
  existingLock = Db.get({ dbIntegration: DB_ID, documentKey: lockKey });
} catch (e) {
  existingLock = null;
}

const now = Date.now();
const alreadyLocked = !!(existingLock && existingLock.value && (now - existingLock.value.ts) < LOCK_TTL_MS);

if (alreadyLocked) {
  Context.set({ key: "skipProcessing", value: true });
  return { taskId, incomingText, chatHistory: chatHistory.trim(), apiUrl, token, skipProcessing: true };
}

try {
  Db.put({ dbIntegration: DB_ID, documentKey: lockKey, value: { ts: now } });
} catch (e) {
  Log.info({ message: "receiveWebhook: lock failed for task " + taskId + ": " + e });
}

Context.set({ key: "taskId", value: taskId });
Context.set({ key: "incomingText", value: incomingText });
Context.set({ key: "chatHistory", value: chatHistory.trim() });
Context.set({ key: "apiUrl", value: apiUrl });
Context.set({ key: "token", value: token });
Context.set({ key: "llmModelKey", value: "REPLACE_WITH_YOUR_LLM_KEY" });
Context.set({ key: "formId", value: String(task.form_id) });
Context.set({ key: "unitFieldId", value: unitFieldId });
Context.set({ key: "componentFieldId", value: componentFieldId });
Context.set({ key: "outboundChannel", value: outboundChannel });
Context.set({ key: "skipProcessing", value: false });

return { taskId, incomingText, chatHistory: chatHistory.trim(), apiUrl, token, skipProcessing: false };
