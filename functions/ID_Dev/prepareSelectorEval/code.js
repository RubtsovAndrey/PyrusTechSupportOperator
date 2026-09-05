if (Context.getProjectShortName() !== expectedProject || Context.isTestChannel() !== true) {
  throw new Error("Selector evaluation is restricted to the registered dev Test menu.");
}
const caseId = String((Context.getMessageContent() || {}).text || "").trim().toLowerCase();
if (!caseId || caseId === "/start") {
  Log.info({ message: "selectorEval: send success-full, empty-full, empty-single, noise-only, client-avatar-full or client-avatar-noise; each runs five samples." });
  return { ready: false };
}
if (!/^[a-z0-9-]{1,60}$/.test(caseId)) throw new Error("Invalid evaluation case name.");
const document = Db.get({ dbIntegration: dbIntegration, documentKey: "selector_eval_cases" });
const bundle = document && document.value;
const item = bundle && bundle.version === 1 && bundle.cases && Object.prototype.hasOwnProperty.call(bundle.cases, caseId)
  ? bundle.cases[caseId] : null;
if (!item || !item.query || !Array.isArray(item.candidates) || !item.candidates.length || item.candidates.length > 6 ||
    !Array.isArray(item.requiredEvidence) || typeof item.inputSha256 !== "string") {
  throw new Error("Load the prepared selector_eval_cases document and use one of its case names.");
}
const id = Context.getRequestId();
if (!id) throw new Error("A unique platform request ID is required.");
const runId = encodeURIComponent(String(id));
const runKey = "selector_eval_run:" + runId;
const taskId = "eval:" + runId;
const stateKey = "state:" + taskId;
const existingRun = Db.get({ dbIntegration: dbIntegration, documentKey: runKey });
const existingState = Db.get({ dbIntegration: dbIntegration, documentKey: stateKey });
if ((existingRun && existingRun.value) || (existingState && existingState.value)) {
  throw new Error("This evaluation request already exists; send a new test message.");
}
const request = { id: "operator-evidence:" + taskId, taskId: taskId, incomingCommentId: "eval",
  query: item.query, candidates: item.candidates };
const run = { runId: runId, caseId: caseId, taskId: taskId, status: "running", modelKey: modelKey,
  maxCompletionTokens: maxCompletionTokens, inputSha256: item.inputSha256,
  request: request, requiredEvidence: item.requiredEvidence, rows: [] };
Db.put({ dbIntegration: dbIntegration, documentKey: runKey, value: run });
// The existing provenance parser reads state:<taskId>. This synthetic ID can never be
// a numeric Pyrus task ID; no webhook, task token, or real dialog is replayed here.
Db.put({ dbIntegration: dbIntegration, documentKey: stateKey,
  value: { taskId: taskId, runtime: { incomingCommentId: "eval" }, evaluation: true } });
AgentContext.clearContext({});
AgentContext.putValue({ key: "dialog", value: { taskId: taskId } });
AgentContext.putValue({ key: "operatorEvidenceRequest", value: request });
AgentContext.putValue({ key: "selectorEvalStartedAt", value: Date.now() });
Log.info({ message: "selectorEval: started " + runId + " case " + caseId + ", five identical requests per batch" });
return { ready: true, runId: runId };
