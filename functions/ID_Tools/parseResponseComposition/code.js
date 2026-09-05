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
          // Keep scanning for a complete self-correction.
        }
        start = -1;
      }
    }
  }
  return objects.length ? objects[objects.length - 1] : null;
}

function urls(value) {
  return String(value || "").match(/https?:\/\/[^\s)]+/gi) || [];
}

const dialog = AgentContext.getValue({ key: "dialog" }) || {};
let plan = AgentContext.getValue({ key: "responsePlan" });
const taskId = dialog.taskId == null ? null : String(dialog.taskId);
let state = {};
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  state = (doc && doc.value) || {};
} catch (e) {
  throw new Error("parseResponseComposition: task state is unavailable: " + e);
}
const currentCommentId = state.runtime && state.runtime.incomingCommentId != null
  ? String(state.runtime.incomingCommentId) : null;
// If publication of the plan was lost, only the current question selected by the
// article can rescue the turn. Never reconstruct advice or reuse an earlier question.
let recoveredQuestion = false;
if (!plan) {
  const data = state.data || {};
  const question = data.requiredArticleQuestion || {};
  if (taskId && currentCommentId && !data.treeEnd && data.topicKey &&
      String(question.incomingCommentId || "") === currentCommentId &&
      String(question.topicKey || "") === String(data.topicKey) &&
      String(question.nodeId || "") === String(data.treeNode || "") &&
      (!data.partnerLanguage || data.partnerLanguage === "ru") &&
      typeof question.text === "string" && question.text.trim()) {
    plan = {
      id: "response:" + taskId + ":" + currentCommentId + ":questions",
      taskId: taskId, incomingCommentId: currentCommentId, kind: "questions",
      contentPlan: question.text.trim(), partnerLanguage: "ru", verbatim: true
    };
    recoveredQuestion = true;
  }
}
if (!taskId || !plan || typeof plan !== "object" || String(plan.taskId || "") !== taskId ||
    !String(plan.id || "") || ["solution", "questions"].indexOf(String(plan.kind || "")) < 0 ||
    typeof plan.contentPlan !== "string" || !plan.contentPlan.trim()) {
  throw new Error("parseResponseComposition: response plan is incomplete");
}
if (String(plan.incomingCommentId || "") !== String(currentCommentId || "")) {
  throw new Error("parseResponseComposition: response plan belongs to another partner turn");
}

const raw = Context.getLastFunctionResult();
// A protected policy question is already the final text. Calling a language model that
// is contractually required to copy it byte for byte adds latency and another failure
// surface without adding any conversational value. The graph sends that plan directly
// here; ordinary plans still arrive from Response Composer and take the validated path
// below.
const directVerbatim = recoveredQuestion || (plan.verbatim === true && raw && typeof raw === "object" &&
  raw.responsePlan && String(raw.responsePlan.id || "") === String(plan.id));
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : raw);
const parsed = directVerbatim ? null : lastJsonObject(text);
let replyText = "";
let fallback = false;
let fallbackReason = null;

if (directVerbatim) {
  replyText = String(plan.contentPlan).trim();
} else if (!parsed || String(parsed.planId || "") !== String(plan.id) ||
    !String(parsed.replyText || "").trim()) {
  fallback = true;
  fallbackReason = !parsed ? "composer did not return one JSON object"
    : (String(parsed.planId || "") !== String(plan.id)
      ? "composer returned a stale or invented planId" : "composer returned empty text");
} else {
  replyText = String(parsed.replyText).trim();
}

// A canonical protected question is policy text and cannot be paraphrased. For all other
// plans, the composer may alter wording, but it may not introduce a URL that was absent
// from the authorised content. Required KB links are appended later by applyOutcome.
if (plan.verbatim === true && !directVerbatim) {
  if (replyText !== String(plan.contentPlan).trim()) {
    fallback = true;
    fallbackReason = "composer changed a verbatim policy question";
  }
} else if (!fallback) {
  const allowedUrls = urls(plan.contentPlan);
  const introduced = urls(replyText).some(url => allowedUrls.indexOf(url) < 0);
  if (introduced) {
    fallback = true;
    fallbackReason = "composer introduced a URL outside the response plan";
  }
}

if (recoveredQuestion) {
  Log.warn({ message: "parseResponseComposition: recovered missing response plan from current article question on task " + taskId });
} else if (directVerbatim) {
  Log.info({ message: "parseResponseComposition: materialized verbatim response plan " +
    plan.id + " without an LLM call on task " + taskId });
} else if (fallback) {
  replyText = String(plan.contentPlan).trim();
  Log.warn({ message: "parseResponseComposition: safe plan fallback on task " + taskId +
    " (" + fallbackReason + ")" });
} else {
  Log.info({ message: "parseResponseComposition: accepted response plan " + plan.id +
    " on task " + taskId });
}

return {
  source: recoveredQuestion ? "response-plan-recovery" : (directVerbatim ? "response-plan-verbatim" : "response-composer"),
  responsePlanId: String(plan.id),
  replyText: replyText,
  kind: String(plan.kind),
  partnerLanguage: String(plan.partnerLanguage || (parsed && parsed.partnerLanguage) || "ru").toLowerCase(),
  taskId: taskId,
  compositionFallback: fallback || recoveredQuestion,
  reason: recoveredQuestion ? "missing response plan recovered from current article question" : fallbackReason
};
