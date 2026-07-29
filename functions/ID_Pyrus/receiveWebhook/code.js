const DB_ID = "1000299722-pyrus_bot_database-hul";
const LOCK_TTL_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 10;
// Only these hosts may be sent the Pyrus access_token. The webhook body is
// unauthenticated (the platform exposes no HMAC primitive, so X-Pyrus-Sig cannot
// be verified here) — this allowlist is what stops a forged api_url from
// exfiltrating the token to an attacker-controlled host.
const ALLOWED_API_HOSTS = ["api.pyrus.com", "api.pyrus.kz"];

function hostOf(url) {
  const m = /^https:\/\/([^/:?#]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

// Every exit returns the same shape, so downstream conditions never read undefined.
function result(id, stage, skip, lockToken, reason) {
  return { taskId: id, stage: stage, skip: skip, lockToken: lockToken, reason: reason || null };
}

function reject(reason) {
  Log.warn({ message: "receiveWebhook rejected: " + reason });
  AgentContext.putValue({ key: "dialog", value: null });
  AgentContext.putValue({ key: "outcome", value: null });
  return result(null, null, true, null, reason);
}

const raw = (Context.getMessageContent() || {}).payload || {};

if (!raw.task_id) return reject("payload has no task_id");

const taskId = String(raw.task_id);
const apiUrl = raw.api_url ? String(raw.api_url) : "https://api.pyrus.com/v4/";
const token = raw.access_token;

if (ALLOWED_API_HOSTS.indexOf(hostOf(apiUrl)) < 0) return reject("api_url host not allowed: " + apiUrl);
if (!token) return reject("payload has no access_token");

const task = raw.task || {};
const comments = task.comments || [];

// The turn outcome is a single object, reset on every webhook. Nothing can leak
// from a previous turn or from a different task through leftover keys.
AgentContext.putValue({ key: "outcome", value: null });

if (raw.event !== "comment") return result(taskId, null, true, null, "event is not a comment");

// ── Dialog history ──
// Pyrus resends the whole thread on every webhook, so notes are rebuilt from
// scratch instead of appended — that keeps them in sync with the real thread.
AgentContext.deleteNotes({});

comments
  .filter(c => c.text || c.formatted_text)
  .slice(-HISTORY_LIMIT)
  .forEach(c => {
    const isBot = c.author && c.author.type === "bot";
    AgentContext.addNote({ text: (isBot ? "Ассистент: " : "Партнёр: ") + (c.text || c.formatted_text) });
  });

const lastComment = comments[comments.length - 1];
const incomingText = lastComment ? (lastComment.text || lastComment.formatted_text || "") : "";

const lastInbound = comments.slice().reverse().find(c => c.channel && c.channel.direction === "inbound");
const lastInboundCommentId = lastInbound ? lastInbound.id : null;
const outboundChannel = lastInbound
  ? { type: lastInbound.channel.type, direction: "outbound", to: lastInbound.channel.from }
  : null;

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

// ── Idempotency lock ──
// Db.get + Db.put is not atomic, so the lock carries a unique token: only the
// invocation that owns the token may release it in finalize. Without this, a
// duplicate webhook would delete the in-flight invocation's lock.
const lockKey = "lock:" + taskId;
const now = Date.now();
const lockToken = taskId + "-" + now + "-" + Math.random().toString(36).slice(2, 10);

let heldLock = null;
try {
  heldLock = Db.get({ dbIntegration: DB_ID, documentKey: lockKey });
} catch (e) {
  Log.warn({ message: "receiveWebhook: lock read failed: " + e });
}

if (heldLock && heldLock.value && (now - heldLock.value.ts) < LOCK_TTL_MS) {
  // Another invocation is mid-flight. Skip without a token so finalize leaves its lock intact.
  return result(taskId, null, true, null, "already processing");
}

try {
  Db.put({ dbIntegration: DB_ID, documentKey: lockKey, value: { ts: now, token: lockToken } });
} catch (e) {
  Log.warn({ message: "receiveWebhook: lock write failed: " + e });
}

// ── Per-task state: the single source of truth, keyed by taskId ──
let stored = {};
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (doc && doc.value) stored = doc.value;
} catch (e) {
  Log.warn({ message: "receiveWebhook: state read failed: " + e });
}

const data = stored.data || {};

// ── Stage the graph should enter (this replaces the separate routeStage function) ──
// Only four stages are reachable. Anything else falls back to intake, which is
// always safe: intake re-gathers whatever is missing.
let stage = "intake";
if (stored.stage === "closed") stage = "reopened";               // bot had finished, partner wrote again
else if (stored.stage === "escalated") stage = "escalated";      // operator owns the thread now
else if (stored.stage === "awaiting_confirmation") stage = "awaiting_confirmation";

// Request-scoped Pyrus data lives in the task document, not in the session, so
// concurrent webhooks for different tasks cannot overwrite each other.
try {
  Db.put({
    dbIntegration: DB_ID,
    documentKey: "state:" + taskId,
    value: Object.assign({}, stored, {
      updatedAt: now,
      runtime: {
        apiUrl: apiUrl,
        token: token,
        outboundChannel: outboundChannel,
        lastInboundCommentId: lastInboundCommentId,
        formId: task.form_id ? String(task.form_id) : null,
        unitFieldId: unitFieldId,
        componentFieldId: componentFieldId
      }
    })
  });
} catch (e) {
  Log.warn({ message: "receiveWebhook: state write failed: " + e });
}

// AgentContext carries only what the LLM must see, fully rewritten every turn.
AgentContext.putValue({
  key: "dialog",
  value: {
    taskId: taskId,
    incomingText: incomingText,
    unitFullName: data.unitFullName || null,
    componentName: data.componentName || null,
    problemSummary: data.problemSummary || null,
    email: data.email || null,
    topicKey: data.topicKey || null
  }
});

if (stage === "escalated") return result(taskId, stage, true, lockToken, "operator already handles this task");

return result(taskId, stage, false, lockToken, null);
