if (Context.getProjectShortName() !== expectedProject || Context.isTestChannel() !== true) {
  throw new Error("Selector evaluation is restricted to the registered dev Test menu.");
}
const support = Context.getLastFunctionResult();
const id = Context.getRequestId();
if (!id) throw new Error("Missing evaluation request ID.");
const runId = encodeURIComponent(String(id));
const runKey = "selector_eval_run:" + runId;
const doc = Db.get({ dbIntegration: dbIntegration, documentKey: runKey });
const run = doc && doc.value;
if (!run || run.runId !== runId || run.taskId !== "eval:" + runId || run.status !== "running" ||
    !run.capture || run.capture.iteration !== run.rows.length + 1 || run.rows.length >= 5 ||
    !!lastIteration !== (run.rows.length === 4)) throw new Error("Invalid evaluation batch sequence.");
const parsed = support && support.taskId === run.taskId && support.selectionId === run.request.id &&
  ["selected", "no_evidence", "invalid"].indexOf(support.selectionStatus) >= 0;
const status = run.capture.transportError ? "transport_error" : (parsed ? support.selectionStatus : "parser_error");
const articles = parsed && status === "selected" ? support.operatorKnowledge.articles : [];
function normalize(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
const hits = run.requiredEvidence.map(expected => {
  const candidate = run.request.candidates.find(c => c.id === expected.candidateId);
  const passage = candidate && candidate.passages.find(p => p.id === expected.passageId);
  return !!(candidate && passage && articles.some(a => a.articleId === candidate.articleId && a.spaceId === candidate.spaceId &&
    a.evidence.some(e => normalize(passage.text).indexOf(normalize(e.quote)) >= 0 &&
      (expected.contains || []).every(text => normalize(e.quote).indexOf(text) >= 0))));
});
const unexpectedArticles = articles.filter(a => !run.requiredEvidence.some(expected => {
  const candidate = run.request.candidates.find(c => c.id === expected.candidateId);
  return candidate && candidate.articleId === a.articleId && candidate.spaceId === a.spaceId;
}));
const expectedMet = run.requiredEvidence.length ? status === "selected" && hits.every(Boolean) && !unexpectedArticles.length
  : status === "no_evidence";
const row = { iteration: run.capture.iteration, status: status, expectedMet: expectedMet,
  elapsedMs: run.capture.elapsedMs, articles: articles, raw: run.capture.raw };
run.rows.push(row);
delete run.capture;
if (lastIteration) run.status = "complete";
Db.put({ dbIntegration: dbIntegration, documentKey: runKey, value: run });
Log.info({ message: "selectorEval.sample: " + JSON.stringify({ runId: runId, caseId: run.caseId,
  iteration: row.iteration, status: status, expectedMet: expectedMet, elapsedMs: row.elapsedMs, articles: articles }) });
if (lastIteration) {
  // Only this request's synthetic state is removed. Reports and original cases remain.
  let cleanup = "ok";
  try { Db.delete({ dbIntegration: dbIntegration, documentKey: "state:" + run.taskId }); }
  catch (e) { cleanup = "failed"; }
  const report = { kind: "selector_eval_report", runId: runId, caseId: run.caseId,
    modelKey: run.modelKey, maxCompletionTokens: run.maxCompletionTokens, inputSha256: run.inputSha256,
    samples: run.rows.length, expectedMet: run.rows.filter(r => r.expectedMet).length,
    statuses: run.rows.map(r => r.status), cleanup: cleanup,
    note: "Source/quote checks are automatic; semantic correctness still requires review. Usage is in Llm.sendRequest trace spans." };
  AgentContext.clearContext({});
  Log.info({ message: "selectorEval.report: " + JSON.stringify(report) });
  return report;
}
// Parser clears AgentContext. Restore only the same request and a synthetic task ID.
AgentContext.clearContext({});
AgentContext.putValue({ key: "dialog", value: { taskId: run.taskId } });
AgentContext.putValue({ key: "operatorEvidenceRequest", value: run.request });
AgentContext.putValue({ key: "selectorEvalStartedAt", value: Date.now() });
return { runId: runId, completed: run.rows.length };
