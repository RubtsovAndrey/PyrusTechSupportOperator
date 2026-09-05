if (Context.getProjectShortName() !== expectedProject || Context.isTestChannel() !== true) {
  throw new Error("Selector evaluation is restricted to the registered dev Test menu.");
}
const raw = transportError ? null : Context.getLastFunctionResult();
const elapsedMs = Date.now() - Number(AgentContext.getValue({ key: "selectorEvalStartedAt" }) || Date.now());
const id = Context.getRequestId();
if (!id) throw new Error("Missing evaluation request ID.");
const runId = encodeURIComponent(String(id));
const runKey = "selector_eval_run:" + runId;
const doc = Db.get({ dbIntegration: dbIntegration, documentKey: runKey });
const run = doc && doc.value;
if (!run || run.runId !== runId || run.taskId !== "eval:" + runId || run.status !== "running" || run.rows.length >= 5) {
  throw new Error("No active evaluation batch for this request.");
}
run.capture = { iteration: run.rows.length + 1, transportError: !!transportError,
  raw: typeof raw === "string" ? raw : null, elapsedMs: Math.max(0, elapsedMs) };
Db.put({ dbIntegration: dbIntegration, documentKey: runKey, value: run });
// Feed the real parser exactly the selector result, not the evaluation metadata.
return raw;
