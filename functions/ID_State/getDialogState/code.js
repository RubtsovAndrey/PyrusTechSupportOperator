const DB_ID = "1000299722-pyrus_bot_database-hul";

const effectiveTaskId = taskId || AgentContext.getValue({ key: "taskId" });

if (!effectiveTaskId) {
  return { stage: "face_control", unit: null, problemSummary: null, solverKey: null, email: null, gatherAttempts: 0, confirmationAttempts: 0, error: null, closeComment: null };
}

try {
  const r = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + effectiveTaskId });
  if (r && r.value) return r.value;
} catch (e) {
  Log.warn({ message: "getDialogState error: " + e });
}

return { stage: "face_control", unit: null, problemSummary: null, solverKey: null, email: null, gatherAttempts: 0, confirmationAttempts: 0, error: null, closeComment: null };
