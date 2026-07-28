const DB_ID = "1000299722-pyrus_bot_database-hul";

const taskId = arguments[0]?.taskId ?? arguments[0]?.["task-id"];

const effectiveTaskId = taskId || AgentContext.getValue({ key: "taskId" });

if (!effectiveTaskId) {
  return { stage: "intake" };
}

try {
  const r = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + effectiveTaskId });
  if (r && r.value && r.value.stage) {
    const stage = r.value.stage;
    if (stage === "face_control" || stage === "gathering") return { stage: "intake" };
    return { stage: stage };
  }
} catch (e) {
  Log.warn({ message: "routeStage error: " + e });
}

return { stage: "intake" };
