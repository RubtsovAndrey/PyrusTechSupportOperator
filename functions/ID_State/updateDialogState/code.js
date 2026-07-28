const DB_ID = "1000299722-pyrus_bot_database-hul";

const effectiveTaskId = taskId || AgentContext.getValue({ key: "taskId" });

if (!effectiveTaskId || !state) {
  return { saved: false, reason: "missing taskId or state" };
}

const merged = Object.assign({}, state, { updatedAt: Date.now() });

try {
  Db.put({ dbIntegration: DB_ID, documentKey: "state:" + effectiveTaskId, value: merged });
  return { saved: true };
} catch (e) {
  Log.warn({ message: "updateDialogState error: " + e });
  return { saved: false, reason: String(e) };
}
