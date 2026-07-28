const DB_ID = "1000299722-pyrus_bot_database-hul";

const taskIdFromContext = AgentContext.getValue({ key: "taskId" });
let effectiveTaskId = (typeof taskId !== "undefined") ? taskId : undefined;
if (!effectiveTaskId || String(effectiveTaskId).includes("{{")) {
  effectiveTaskId = taskIdFromContext;
}

if (!effectiveTaskId || String(effectiveTaskId).includes("{{")) {
  Log.info({ message: "releaseLock: no taskId, skipping" });
  return { released: false, reason: "no taskId" };
}

const lockKey = "lock:" + effectiveTaskId;

try {
  Db.delete({ dbIntegration: DB_ID, documentKey: lockKey });
} catch (e) {
  Log.info({ message: "releaseLock error for task " + effectiveTaskId + ": " + e });
}

return { released: true };
