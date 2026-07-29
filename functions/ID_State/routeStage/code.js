const DB_ID = "1000299722-pyrus_bot_database-hul";

var _prev = Context.getLastFunctionResult() || {};
var effectiveTaskId = _prev.taskId || taskId || AgentContext.getValue({ key: "taskId" });

if (!effectiveTaskId) {
  return { stage: "intake", taskId: null };
}

try {
  const r = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + effectiveTaskId });
  if (r && r.value && r.value.stage) {
    const stage = r.value.stage;
    if (stage === "face_control" || stage === "gathering") return { stage: "intake", taskId: effectiveTaskId };
    return { stage: stage, taskId: effectiveTaskId };
  }
} catch (e) {
  Log.warn({ message: "routeStage error: " + e });
}

return { stage: "intake", taskId: effectiveTaskId };
