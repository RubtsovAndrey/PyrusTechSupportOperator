const DB_ID = "1000299722-pyrus_bot_database-hul";

function normalize(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^0-9a-zа-я]+/g, " ").replace(/\s+/g, " ").trim();
}

function isFragment(fragment, text) {
  const needle = normalize(fragment);
  const haystack = normalize(text);
  return !!needle && !!haystack && (" " + haystack + " ").indexOf(" " + needle + " ") >= 0;
}

function isContextualShortReply(text) {
  const tokens = normalize(text).split(" ").filter(Boolean);
  if (!tokens.length || tokens.length > 6) return false;
  return ["да", "нет", "ага", "неа", "вроде", "скорее", "кажется", "наверное"]
    .indexOf(tokens[0]) >= 0 || (tokens[0] === "не" && tokens[1] === "знаю");
}

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
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(source.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) objects.push(parsed);
        } catch (e) {
          // A later complete object may still be the correction.
        }
        start = -1;
      }
    }
  }
  return objects.length ? objects[objects.length - 1] : null;
}

function setPath(target, dotted, value) {
  const parts = String(dotted).split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function writePaths(taskId, state, paths) {
  try {
    const result = Db.updateByFilters({
      dbIntegration: DB_ID,
      filters: { taskId: Number(taskId) },
      operator: { $set: paths }
    });
    if (result && Number(result.count) > 0) return true;
  } catch (e) {
    Log.warn({ message: "parseOpenAnswers: point write failed: " + e });
  }
  try {
    Object.keys(paths).forEach(path => setPath(state, path, paths[path]));
    state.taskId = Number(taskId);
    Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: state });
    return true;
  } catch (e) {
    Log.error({ message: "parseOpenAnswers: state write lost: " + e });
    return false;
  }
}

const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const contract = dialog.openAnswerContract && typeof dialog.openAnswerContract === "object"
  ? dialog.openAnswerContract : null;
const taskId = dialog.taskId == null ? null : String(dialog.taskId);
const currentText = String(dialog.incomingText || "").trim();
const raw = Context.getLastFunctionResult();
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : raw);
const parsed = lastJsonObject(text);

let state = {};
if (taskId) {
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    state = (doc && doc.value) || {};
  } catch (e) {
    Log.warn({ message: "parseOpenAnswers: task state is unavailable: " + e });
  }
}
const data = state.data || {};
const declared = String(data.openAnswerKeys || "").split(",").map(key => key.trim()).filter(Boolean);
const requested = contract && Array.isArray(contract.keys) ? contract.keys.map(String) : [];
const allowed = requested.filter(key => declared.indexOf(key) >= 0 && !/[.$]/.test(key));
const direct = contract && Array.isArray(contract.directKeys)
  ? contract.directKeys.map(String).filter(key => allowed.indexOf(key) >= 0) : [];
const returnedId = parsed ? String(parsed.contractId || "") : "";

if (!taskId || !contract || String(contract.kind || "") !== "open_answers" ||
    returnedId !== String(contract.id || "") || !allowed.length ||
    !parsed || String(parsed.kind || "") !== "open_answers") {
  Log.warn({ message: "parseOpenAnswers: invalid or incomplete extraction contract on task " + (taskId || "?") });
  return { taskId: taskId, kind: "open_answers", answersAccepted: 0, needsClarification: false };
}

const patch = { updatedAt: Date.now() };
// searchKnowledge runs later in the same graph pass. By then these answers are already
// "stored", so it needs a bounded marker to distinguish facts accepted on this partner
// turn from old facts; otherwise a partial answer looks like an ignored question.
patch["data.openAnswersAcceptedCommentId"] = null;
patch["data.openAnswersAcceptedKeys"] = null;
const accepted = {};
const answerPayload = parsed.answers && typeof parsed.answers === "object" && !Array.isArray(parsed.answers)
  ? parsed.answers : {};
allowed.forEach(key => {
  const item = answerPayload[key];
  if (!item || typeof item !== "object" || Array.isArray(item)) return;
  const value = String(item.value || "").replace(/\s+/g, " ").trim();
  const evidence = String(item.evidenceText || "").trim();
  if (isContextualShortReply(currentText) && direct.indexOf(key) < 0) return;
  if (!value || !isFragment(evidence, currentText)) return;
  const safeValue = value.slice(0, 700);
  const safeEvidence = evidence.slice(0, 900);
  patch["data.treeAnswers." + key] = safeValue;
  patch["data.treeAnswerEvidence." + key] = safeEvidence;
  accepted[key] = safeValue;
});

let notes = "";
try { notes = String(AgentContext.getNotes({}) || ""); } catch (e) {}
const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
let conflictQuestion = null;
for (let i = 0; i < conflicts.length && !conflictQuestion; i++) {
  const conflict = conflicts[i] || {};
  const key = String(conflict.key || "");
  const evidence = Array.isArray(conflict.evidence) ? conflict.evidence.map(String) : [];
  const unique = [];
  evidence.forEach(item => {
    const normalized = normalize(item);
    if (normalized && unique.indexOf(normalized) < 0 && isFragment(item, notes)) unique.push(normalized);
  });
  let question = String(conflict.clarifyingQuestion || "").replace(/\s+/g, " ").trim();
  question = question.replace(/https?:\/\/\S+/gi, "").trim();
  if (allowed.indexOf(key) >= 0 && unique.length >= 2 && question) {
    conflictQuestion = question.slice(0, 500);
    patch["data.openAnswerConflict"] = key + ": " + evidence.slice(0, 2).join(" <> ");
    patch["data.openAnswerConflictQuestion"] = conflictQuestion;
  }
}

if (!conflictQuestion) {
  patch["data.openAnswerConflict"] = null;
  patch["data.openAnswerConflictQuestion"] = null;
}
if (Object.keys(accepted).length) {
  const incomingCommentId = state.runtime && state.runtime.incomingCommentId != null
    ? String(state.runtime.incomingCommentId) : null;
  patch["data.latestPartnerEvidence"] = currentText.slice(0, 900);
  patch["data.openAnswersAcceptedCommentId"] = incomingCommentId;
  patch["data.openAnswersAcceptedKeys"] = Object.keys(accepted).join(",");
}
writePaths(taskId, state, patch);

const published = Object.assign({}, dialog, data, {
  treeAnswers: Object.assign({}, data.treeAnswers || {}, accepted),
  openAnswerContract: null
});
AgentContext.putValue({ key: "dialog", value: published });
AgentContext.addNote({ text: "Проверенные открытые ответы текущей реплики: " +
  (Object.keys(accepted).length ? Object.keys(accepted).map(key => key + ": " + accepted[key]).join("; ") : "не извлечены") });

if (conflictQuestion) {
  Log.warn({ message: "parseOpenAnswers: material contradiction requires clarification on task " + taskId });
}
return {
  taskId: taskId,
  kind: "open_answers",
  answersAccepted: Object.keys(accepted).length,
  answers: accepted,
  needsClarification: !!conflictQuestion,
  clarifyingQuestion: conflictQuestion,
  partnerLanguage: /^[a-z]{2}$/i.test(String(parsed.partnerLanguage || ""))
    ? String(parsed.partnerLanguage).toLowerCase() : (data.partnerLanguage || null)
};
