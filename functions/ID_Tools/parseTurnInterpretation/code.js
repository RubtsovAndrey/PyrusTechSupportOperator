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

function evidenceIsWholeMessage(evidence, currentText) {
  const quoted = normalizeEvidence(evidence);
  const current = normalizeEvidence(currentText);
  return !!quoted && quoted === current;
}

// Agent Platform structured output is still treated as an instruction at this boundary.
// Read the last complete object so a short self-correction does not turn a valid frame
// into prose. Prose has no useful fallback: it cannot safely name a finite value.
function lastJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
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
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) objects.push(parsed);
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
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : raw);
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
const currentCommentId = runtime.incomingCommentId == null ? null : String(runtime.incomingCommentId);
const activeCommentId = data.activeQuestionCommentId == null ? null : String(data.activeQuestionCommentId);

// In-progress conversations from the previous deployment do not yet carry the general
// contract in AgentContext. Synthesize only the old article-answer form; confirmation and
// post-close contracts are request-scoped and must never be guessed from stale state.
let contract = dialog.interpretationContract;
if (!contract && data.activeQuestionId && data.activeQuestionValuesJson) {
  let oldValues = [];
  try {
    const decoded = JSON.parse(String(data.activeQuestionValuesJson || "[]"));
    if (Array.isArray(decoded)) oldValues = decoded;
  } catch (e) {
    // The incomplete contract fails closed below.
  }
  contract = {
    id: String(data.activeQuestionId),
    kind: "article_answer",
    evidenceScope: "fragment",
    values: oldValues
  };
}
contract = contract && typeof contract === "object" && !Array.isArray(contract) ? contract : null;
const contractKind = contract ? String(contract.kind || "") : "";
const contractId = contract ? String(contract.id || "") : "";
const values = contract && Array.isArray(contract.values)
  ? contract.values.filter(item => item && String(item.value || "").trim() && String(item.meaning || "").trim())
  : [];
const partnerLanguage = parsed && /^[a-z]{2}$/i.test(String(parsed.partnerLanguage || ""))
  ? String(parsed.partnerLanguage).toLowerCase()
  : (data.partnerLanguage || dialog.partnerLanguage || null);

function unclear(reason) {
  Log.warn({ message: "parseTurnInterpretation: unclear " + (contractKind || "unknown") +
    " on task " + (taskId || "?") + ": " + reason });
  const result = {
    source: "turn-interpreter",
    contractKind: contractKind || null,
    contractId: contractId || null,
    interpretation: "unclear",
    topicKey: data.topicKey || dialog.topicKey || null,
    partnerLanguage: partnerLanguage,
    evidenceText: null,
    reason: reason,
    taskId: taskId
  };
  if (contractKind === "confirmation") result.status = "unclear";
  if (contractKind === "post_close") result.postCloseIntent = "unclear";
  return result;
}

if (!taskId || !contractId || !values.length ||
    ["article_answer", "confirmation", "post_close"].indexOf(contractKind) < 0) {
  return unclear("interpretation contract is incomplete");
}

const expectedStage = {
  article_answer: "awaiting_answers",
  confirmation: "awaiting_confirmation",
  post_close: "closed"
}[contractKind];
if (String(state.stage || "") !== expectedStage) {
  return unclear("task stage does not match the interpretation contract");
}

if (contractKind === "article_answer") {
  if (!data.topicKey || !data.activeQuestionId || !data.activeQuestionKey ||
      !data.activeQuestionNode || String(contractId) !== String(data.activeQuestionId)) {
    return unclear("active semantic question context is incomplete");
  }
  if (currentCommentId != null && activeCommentId != null && currentCommentId === activeCommentId) {
    return unclear("the active question and its alleged answer belong to the same turn");
  }
}

const kind = parsed ? String(parsed.kind || "") : "";
if (!parsed || (kind !== "interpretation" && kind !== "answer")) {
  return unclear(parsed && kind === "unclear"
    ? "interpreter reported ambiguity" : "interpreter did not return the interpretation contract");
}

// `answer`/activeQuestionId/answerValue is accepted only as a compatibility shape for a
// model invocation already running during deployment. New calls use the common fields.
const returnedContractId = String(parsed.contractId || parsed.activeQuestionId || "");
if (returnedContractId !== contractId) {
  return unclear("contractId does not match the current interpretation contract");
}
const selected = String(parsed.value || parsed.answerValue || "");
if (!values.some(item => String(item.value) === selected)) {
  return unclear("value is not allowed by the interpretation contract");
}

const fullMessage = String(contract.evidenceScope || "") === "full_message";
const evidenceValid = fullMessage
  ? evidenceIsWholeMessage(parsed.evidenceText, currentText)
  : evidenceIsCurrent(parsed.evidenceText, currentText);
if (!evidenceValid) {
  return unclear(fullMessage
    ? "evidenceText does not cover the whole current partner message"
    : "evidenceText is not a continuous fragment of the current partner message");
}

Log.info({ message: "parseTurnInterpretation: accepted " + selected + " for " +
  contractKind + " contract " + contractId + " on task " + taskId });

const result = {
  source: "turn-interpreter",
  contractKind: contractKind,
  contractId: contractId,
  interpretation: "value",
  interpretationValue: selected,
  topicKey: data.topicKey || dialog.topicKey || null,
  evidenceText: String(parsed.evidenceText || "").trim(),
  partnerLanguage: partnerLanguage,
  reason: null,
  taskId: taskId
};

if (contractKind === "article_answer") {
  result.interpretation = "answer";
  result.activeQuestionId = contractId;
  result.answerValue = selected;
}
if (contractKind === "confirmation") result.status = selected;
if (contractKind === "post_close") {
  result.postCloseIntent = selected;
  if (selected !== "gratitude_only") {
    result.reason = "сообщение после закрытия содержит не только благодарность; обращение передано оператору";
  }
}

return result;
