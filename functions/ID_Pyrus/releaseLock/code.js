const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";

const taskIdFromContext = Context.get({ key: "taskId" });
let effectiveTaskId = taskId;
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
