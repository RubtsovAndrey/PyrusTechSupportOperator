const DB_ID = "1000299722-pyrus_bot_database-hul";

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
const plan = AgentContext.getValue({ key: "responsePlan" }) || {};
const taskId = dialog.taskId == null ? null : String(dialog.taskId);
if (!taskId || !plan || typeof plan !== "object" || String(plan.taskId || "") !== taskId ||
    !String(plan.id || "") || ["solution", "questions"].indexOf(String(plan.kind || "")) < 0 ||
    !String(plan.contentPlan || "").trim()) {
  throw new Error("parseResponseComposition: response plan is incomplete");
}

let state = {};
try {
  const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  state = (doc && doc.value) || {};
} catch (e) {
  throw new Error("parseResponseComposition: task state is unavailable: " + e);
}
const currentCommentId = state.runtime && state.runtime.incomingCommentId != null
  ? String(state.runtime.incomingCommentId) : null;
if (String(plan.incomingCommentId || "") !== String(currentCommentId || "")) {
  throw new Error("parseResponseComposition: response plan belongs to another partner turn");
}

const raw = Context.getLastFunctionResult();
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : raw);
const parsed = lastJsonObject(text);
let replyText = "";
let fallback = false;
let fallbackReason = null;

if (!parsed || String(parsed.planId || "") !== String(plan.id) ||
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
if (plan.verbatim === true) {
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

if (fallback) {
  replyText = String(plan.contentPlan).trim();
  Log.warn({ message: "parseResponseComposition: safe plan fallback on task " + taskId +
    " (" + fallbackReason + ")" });
} else {
  Log.info({ message: "parseResponseComposition: accepted response plan " + plan.id +
    " on task " + taskId });
}

return {
  source: "response-composer",
  responsePlanId: String(plan.id),
  replyText: replyText,
  kind: String(plan.kind),
  partnerLanguage: String(plan.partnerLanguage || parsed.partnerLanguage || "ru").toLowerCase(),
  taskId: taskId,
  compositionFallback: fallback,
  reason: fallbackReason
};
