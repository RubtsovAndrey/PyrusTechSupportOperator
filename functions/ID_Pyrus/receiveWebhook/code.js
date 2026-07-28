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
// Only add the last inbound comment to avoid duplicates across webhook calls
const lastInbound = comments.slice().reverse().find(c => c.channel && c.channel.direction === "inbound" && (c.text || c.formatted_text));

let chatHistory = "";
if (lastInbound) {
  const text = lastInbound.text || lastInbound.formatted_text || "";
  AgentContext.addNote({ text: "Партнёр: " + text });
  chatHistory = "Партнёр: " + text + "\n";
}

// Also add last bot reply if present (for context)
const lastOutbound = comments.slice().reverse().find(c => c.channel && c.channel.direction === "outbound" && (c.text || c.formatted_text));
if (lastOutbound) {
  const outText = lastOutbound.text || lastOutbound.formatted_text || "";
  AgentContext.addNote({ text: "Ассистент: " + outText });
  chatHistory = "Ассистент: " + outText + "\n" + chatHistory;
}

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

// ── Clear stale per-request values from previous webhook in same session ──
AgentContext.putValue({ key: "replyText", value: null });
AgentContext.putValue({ key: "closeAction", value: null });
AgentContext.putValue({ key: "escalateApproval", value: null });
AgentContext.putValue({ key: "closeFieldUpdates", value: null });
AgentContext.putValue({ key: "newStage", value: null });

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
