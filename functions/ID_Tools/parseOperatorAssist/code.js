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
  taskId: support.taskId || dialog.taskId || null,
  reason: support.reason || "подходящей утверждённой тематики нет",
  operatorKnowledge: support.operatorKnowledge || { query: dialog.problemSummary || null, articles: [] },
  operatorDraft: draft || null
};
