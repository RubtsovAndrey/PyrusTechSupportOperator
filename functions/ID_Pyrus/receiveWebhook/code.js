const DB_ID = "1000299722-pyrus_bot_database-hul";

const raw = Context.getMessageContent().payload;
const taskId = String(raw.task_id);
const apiUrl = raw.api_url || "https://api.pyrus.com/v4/";
const token = raw.access_token;
const task = raw.task || {};
const comments = task.comments || [];

if (raw.event !== "comment") {
  AgentContext.putValue({ key: "skipProcessing", value: true });
  return { taskId, skipProcessing: true };
}

// ── Context Hydration: AgentContext.addNote for dialog history ──
const historyComments = comments
  .filter(c => c.text || c.formatted_text)
  .slice(-20);

let chatHistory = "";
historyComments.forEach(c => {
  const text = c.text || c.formatted_text || "";
  const isBot = c.author && c.author.type === "bot";
  const role = isBot ? "Ассистент" : "Партнёр";
  const authorName = c.author ? (c.author.first_name || "") : "";
  const noteText = role + (authorName ? " (" + authorName + ")" : "") + ": " + text;
  AgentContext.addNote({ text: noteText });
  chatHistory += role + ": " + text + "\n";
});

const lastComment = comments[comments.length - 1];
const incomingText = lastComment ? (lastComment.text || lastComment.formatted_text || "") : "";

const lastInboundComment = comments.slice().reverse().find(c => c.channel && c.channel.direction === "inbound");
const lastInboundCommentId = lastInboundComment ? lastInboundComment.id : null;

let outboundChannel = null;
if (lastComment && lastComment.channel && lastComment.channel.direction === "inbound") {
  outboundChannel = {
    type: lastComment.channel.type,
    direction: "outbound",
    to: lastComment.channel.from
  };
}

// ── Pyrus field parsing ──
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

// ── Idempotency: Db-based lock ──
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
  AgentContext.putValue({ key: "skipProcessing", value: true });
  return { taskId, skipProcessing: true };
}

try {
  Db.put({ dbIntegration: DB_ID, documentKey: lockKey, value: { ts: now } });
} catch (e) {
  Log.info({ message: "receiveWebhook: lock failed for task " + taskId + ": " + e });
}

// ── Context Hydration: AgentContext.putValue for structured data ──
AgentContext.putValue({ key: "taskId", value: taskId });
AgentContext.putValue({ key: "incomingText", value: incomingText });
AgentContext.putValue({ key: "chatHistory", value: chatHistory.trim() });
AgentContext.putValue({ key: "apiUrl", value: apiUrl });
AgentContext.putValue({ key: "token", value: token });
AgentContext.putValue({ key: "llmModelKey", value: "1000299722-yandex_aliceaillmfla-div" });
AgentContext.putValue({ key: "formId", value: String(task.form_id) });
AgentContext.putValue({ key: "unitFieldId", value: unitFieldId });
AgentContext.putValue({ key: "componentFieldId", value: componentFieldId });
AgentContext.putValue({ key: "outboundChannel", value: outboundChannel });
AgentContext.putValue({ key: "lastInboundCommentId", value: lastInboundCommentId });
AgentContext.putValue({ key: "skipProcessing", value: false });

return { taskId, incomingText, skipProcessing: false };
