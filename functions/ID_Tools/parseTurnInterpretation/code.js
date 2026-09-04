const DB_ID = "1000299722-pyrus_bot_database-hul";

function normalizeEvidence(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^0-9a-zа-я]+/g, " ").replace(/\s+/g, " ").trim();
}

function evidenceIsCurrent(evidence, currentText) {
  const needle = normalizeEvidence(evidence);
  const haystack = normalizeEvidence(currentText);
  if (!needle || !haystack) return false;
  return (" " + haystack + " ").indexOf(" " + needle + " ") >= 0;
}

// Agent Platform calls structured output an instruction, not a grammar. Read the last
// complete object so a short self-correction does not turn an otherwise valid semantic
// answer into prose. Unlike Solver output, prose has no useful fallback here: it cannot
// safely name a finite fact and therefore means `unclear`.
function lastJsonObject(value) {
  const source = String(value || "").replace(/```json/gi, "").replace(/```/g, "");
  const objects = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(source.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            objects.push(parsed);
          }
        } catch (e) {
          // A later complete object may still be the model's correction.
        }
        start = -1;
      }
    }
  }
  if (objects.length) return objects[objects.length - 1];
  try {
    const parsed = JSON.parse(source.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = dialog.taskId == null ? null : String(dialog.taskId);
const raw = Context.getLastFunctionResult();
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : String(raw || ""));
const parsed = lastJsonObject(text);

let state = {};
if (taskId) {
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    state = (doc && doc.value) || {};
  } catch (e) {
    Log.warn({ message: "parseTurnInterpretation: task state is unavailable: " + e });
  }
}
const data = state.data || {};
const runtime = state.runtime || {};
const currentText = String(dialog.incomingText || "").trim();
const currentCommentId = runtime.incomingCommentId == null
  ? null : String(runtime.incomingCommentId);
const activeCommentId = data.activeQuestionCommentId == null
  ? null : String(data.activeQuestionCommentId);

let values = [];
try {
  const decoded = JSON.parse(String(data.activeQuestionValuesJson || "[]"));
  if (Array.isArray(decoded)) values = decoded.filter(item => item && item.value && item.meaning);
} catch (e) {
  Log.warn({ message: "parseTurnInterpretation: active answer values are invalid JSON on task " +
    (taskId || "?") });
}

function unclear(reason) {
  Log.warn({ message: "parseTurnInterpretation: unclear on task " + (taskId || "?") +
    ": " + reason });
  return {
    source: "turn-interpreter",
    interpretation: "unclear",
    topicKey: data.topicKey || dialog.topicKey || null,
    reason: reason,
    taskId: taskId
  };
}

if (!taskId || !data.topicKey || !data.activeQuestionId || !data.activeQuestionKey ||
    !data.activeQuestionNode || !values.length) {
  return unclear("active semantic question context is incomplete");
}
if (String(state.stage || "") !== "awaiting_answers") {
  return unclear("task is not waiting for an article answer");
}
if (currentCommentId != null && activeCommentId != null && currentCommentId === activeCommentId) {
  return unclear("the active question and its alleged answer belong to the same turn");
}
if (!parsed || String(parsed.kind || "") !== "answer") {
  return unclear(parsed && String(parsed.kind || "") === "unclear"
    ? "interpreter reported ambiguity" : "interpreter did not return the answer contract");
}
if (String(parsed.activeQuestionId || "") !== String(data.activeQuestionId)) {
  return unclear("activeQuestionId does not match the delivered question");
}
const selected = String(parsed.answerValue || "");
if (!values.some(item => String(item.value) === selected)) {
  return unclear("answerValue is not allowed by the active question");
}
if (!evidenceIsCurrent(parsed.evidenceText, currentText)) {
  return unclear("evidenceText is not a continuous fragment of the current partner message");
}

Log.info({ message: "parseTurnInterpretation: accepted " + selected + " for " +
  data.activeQuestionId + " on task " + taskId });
return {
  source: "turn-interpreter",
  interpretation: "answer",
  topicKey: String(data.topicKey),
  activeQuestionId: String(data.activeQuestionId),
  answerValue: selected,
  evidenceText: String(parsed.evidenceText || "").trim(),
  reason: null,
  taskId: taskId
};
