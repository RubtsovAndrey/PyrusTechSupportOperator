// Validates the tool-less Operator Assist Agent and reunites its advisory draft with the
// deterministic MCP search result. Neither field is ever partner-facing; applyOutcome
// labels both explicitly inside the internal Pyrus correspondence.

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
          // A later complete object may still be valid.
        }
        start = -1;
      }
    }
  }
  return objects.length ? objects[objects.length - 1] : null;
}

const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const support = AgentContext.getValue({ key: "operatorSupport" }) || {};
const raw = Context.getLastFunctionResult();
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : raw);
const parsed = lastJsonObject(text);
let draft = parsed && typeof parsed.operatorDraft === "string"
  ? parsed.operatorDraft.replace(/\s+/g, " ").trim() : "";
const supportArticles = support.operatorKnowledge && Array.isArray(support.operatorKnowledge.articles)
  ? support.operatorKnowledge.articles : [];
let currentCommentId = null;
try {
  const doc = Db.get({ dbIntegration: "1000299722-pyrus_bot_database-lwi",
    documentKey: "state:" + dialog.taskId });
  const runtime = doc && doc.value && doc.value.runtime || {};
  currentCommentId = runtime.incomingCommentId == null ? null : String(runtime.incomingCommentId);
} catch (e) {
  Log.warn({ message: "parseOperatorAssist: current task unavailable; draft discarded" });
}
const currentSupport = support.selectionId && currentCommentId &&
  String(support.taskId || "") === String(dialog.taskId || "") &&
  String(support.incomingCommentId || "") === currentCommentId;
const evidenceIds = [].concat.apply([], supportArticles.map(article =>
  (article.evidence || []).map(evidence => evidence.id)));
const citations = parsed && Array.isArray(parsed.evidenceIds) ? parsed.evidenceIds : [];
if (!currentSupport || !parsed || parsed.selectionId !== support.selectionId ||
    !citations.length || citations.length > 3 ||
    citations.some(id => typeof id !== "string" || evidenceIds.indexOf(id) < 0)) {
  draft = "";
}

// With no retrieved evidence the drafting model has no legitimate source for a product,
// system or diagnostic question. A neutral draft sounds harmless but the live avatar trace
// showed that it can still invent a false distinction. Silence is the safe bounded result.
if (!supportArticles.length && draft) {
  Log.warn({ message: "parseOperatorAssist: discarded an ungrounded draft because no knowledge article was found" });
  draft = "";
}

// URLs already have their own labelled, deterministic block. Repeating a model-written
// link inside a draft makes it look as though the link itself was verified as an answer.
draft = draft.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
if (draft.length > 700) draft = draft.slice(0, 699).trim() + "…";
if (!draft) {
  Log.warn({ message: "parseOperatorAssist: agent produced no usable draft; handover continues with links and summary only" });
} else {
  Log.info({ message: "parseOperatorAssist: prepared an internal operator draft for task " +
    String(support.taskId || dialog.taskId || "?") });
}

return {
  taskId: dialog.taskId || null,
  reason: currentSupport ? support.reason : "подходящего подготовленного сценария нет; обращение требует оператора",
  operatorKnowledge: currentSupport ? support.operatorKnowledge : { query: null, articles: [] },
  operatorDraft: draft || null
};
