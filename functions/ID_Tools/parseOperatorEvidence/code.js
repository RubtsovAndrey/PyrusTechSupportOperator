// Provenance boundary for a tool-less semantic selector. Exact source quotes establish
// origin, not semantic entailment; relevance is evaluated separately with live cases.
const DB_ID = "1000299722-pyrus_bot_database-lwi";

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

function normalized(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const request = AgentContext.getValue({ key: "operatorEvidenceRequest" }) || {};
const taskId = dialog.taskId == null ? null : String(dialog.taskId);
const raw = Context.getLastFunctionResult();
const frame = lastJsonObject(typeof raw === "string" ? raw : (raw && raw.content ? raw.content : raw));
let currentCommentId = null;
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  const runtime = doc && doc.value && doc.value.runtime || {};
  currentCommentId = runtime.incomingCommentId == null ? null : String(runtime.incomingCommentId);
} catch (e) {
  Log.warn({ message: "parseOperatorEvidence: task state unavailable; selection discarded" });
}
const bound = typeof request.id === "string" && request.id.length > 0 &&
  taskId && String(request.taskId || "") === taskId && currentCommentId &&
  String(request.incomingCommentId || "") === currentCommentId;
const candidates = bound && Array.isArray(request.candidates) ? request.candidates.slice(0, 6) : [];
let valid = !!(bound && frame && frame.kind === "operator_evidence" &&
  frame.requestId === request.id && Array.isArray(frame.selected) && frame.selected.length <= 3);
let selected = [];
if (valid) {
  frame.selected.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") { valid = false; return; }
    const candidate = candidates.find(item => item.id === entry.candidateId);
    const passage = candidate && Array.isArray(candidate.passages)
      ? candidate.passages.find(item => item.id === entry.passageId) : null;
    const quote = normalized(entry.quote);
    if (!passage || quote.length < 30 || quote.length > 900 ||
        normalized(passage.text).indexOf(quote) < 0 ||
        selected.some(item => item.candidate.id === candidate.id && item.quote === quote)) {
      valid = false;
      return;
    }
    selected.push({ id: "e" + (index + 1), candidate: candidate, quote: quote });
  });
}
// Do not silently accept the valid half of a corrupted model response.
if (!valid) selected = [];
const articles = [];
selected.forEach(item => {
  let article = articles.find(a => a.articleId === item.candidate.articleId && a.spaceId === item.candidate.spaceId);
  if (!article) {
    article = { articleId: item.candidate.articleId, title: item.candidate.title,
      spaceId: item.candidate.spaceId, spaceTitle: item.candidate.spaceTitle,
      url: item.candidate.url || null, evidence: [] };
    articles.push(article);
  }
  article.evidence.push({ id: item.id, quote: item.quote });
});
const support = {
  taskId: taskId, incomingCommentId: currentCommentId,
  selectionId: bound ? String(request.id) : null,
  reason: "подходящего подготовленного сценария нет; обращение требует оператора",
  operatorKnowledge: { query: bound ? request.query : null, articles: articles },
  selectionStatus: valid ? (selected.length ? "selected" : "no_evidence") : "invalid"
};
// The complete retrieval context is removed. Composer sees only the selected quotes,
// verified source metadata and original question, never discarded articles or policy.
AgentContext.clearContext({});
AgentContext.putValue({ key: "dialog", value: { taskId: taskId } });
AgentContext.putValue({ key: "operatorSupport", value: support });
Log.info({ message: "parseOperatorEvidence: " + support.selectionStatus + ", кандидатов " +
  candidates.length + ", подсказок " + articles.length + ", фрагментов " + selected.length });
return support;
